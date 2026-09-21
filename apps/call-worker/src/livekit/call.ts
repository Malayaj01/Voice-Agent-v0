/**
 * One call: room, caller, turn loop — ARCHITECTURE.md §4.
 *
 * NOTHING IN THIS FILE KNOWS WHAT A PHONE IS. The caller arrives through a CallerSource, and
 * whether that placed a SIP leg or waited for a browser tab is not visible here. That is the
 * §4 claim — telephony is a transport — held to literally: when the trunk arrives, the only
 * change is which CallerSource is constructed.
 *
 * Sequence, and why it is this order:
 *
 *   1. connect to the room and publish the bot's audio track
 *   2. admit the caller (dial, or wait for them to join)
 *   3. when their track arrives, start the turn loop
 *
 * The track is published BEFORE the caller is admitted because the flow speaks first. If the
 * caller arrived while the track was still being set up, the opening line would race it and
 * they would hear silence, then a fragment.
 */

import {
  LocalAudioTrack,
  RoomEvent,
  Room,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from '@livekit/rtc-node'
import { AccessToken, type SIPParticipantInfo } from 'livekit-server-sdk'

import type {
  Fsm,
  IntentClassifier,
  Lang,
  STTProvider,
  TTSProvider,
  TurnSink,
  Voice,
} from '@voice-agent/shared'

import { CallSession } from '../session.js'
import {
  SipCallerSource,
  type CallerSource,
  type LiveKitConfig,
  type SipCallerOptions,
} from './caller-source.js'
import { LiveKitAudioSink, pumpTrack } from './media.js'

export type { LiveKitConfig } from './caller-source.js'

export interface CallOptions {
  callId: string
  roomName: string
  /** The only transport-aware object in the call. */
  caller: CallerSource
  lang: Lang
  voice: Voice
  fsm: Fsm
  /** Rate the TTS provider emits — Kokoro is 24k. */
  ttsSampleRate?: number
  /** Rate to feed the STT — faster-whisper wants 16k. */
  sttSampleRate?: number
  /** How long to wait for the caller's audio track after they are admitted. */
  audioTimeoutMs?: number
  /**
   * Ignore barge-in for this long after a line starts.
   *
   * Not a browser concession — it is the echo floor. On a SIP leg the bot's own audio comes
   * back through the caller's microphone path; in a browser it comes back through a speaker
   * unless headphones are used. Same failure, same mitigation, same value.
   */
  holdOffMs?: number
}

export interface CallDeps {
  livekit: LiveKitConfig
  stt: STTProvider
  tts: TTSProvider
  intent: IntentClassifier
  turns: TurnSink
  log?: (line: string) => void
}

export interface CallResult {
  connected: boolean
  sipParticipant: SIPParticipantInfo | undefined
  session: CallSession | undefined
  failure?: string
}

export async function agentToken(
  cfg: LiveKitConfig,
  room: string,
  identity: string,
): Promise<string> {
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '2h' })
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })
  return token.toJwt()
}

function findExistingAudio(
  room: Room,
): { track: RemoteAudioTrack; participant: RemoteParticipant } | undefined {
  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      const track = pub.track
      if (track !== undefined && track.kind === TrackKind.KIND_AUDIO) {
        return { track: track as RemoteAudioTrack, participant }
      }
    }
  }
  return undefined
}

/** Resolves with the caller's audio track. Identical for every caller source. */
function waitForCallerAudio(
  room: Room,
  timeoutMs: number,
): Promise<{ track: RemoteAudioTrack; participant: RemoteParticipant }> {
  return new Promise((resolve, reject) => {
    const existing = findExistingAudio(room)
    if (existing !== undefined) {
      resolve(existing)
      return
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`no caller audio within ${timeoutMs}ms`))
    }, timeoutMs)

    const onSubscribed = (
      track: RemoteAudioTrack | unknown,
      _pub: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => {
      const audio = track as RemoteAudioTrack
      if (audio.kind !== TrackKind.KIND_AUDIO) return
      cleanup()
      resolve({ track: audio, participant })
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      room.off(RoomEvent.TrackSubscribed, onSubscribed)
    }

    room.on(RoomEvent.TrackSubscribed, onSubscribed)
  })
}

/**
 * Runs one call to completion.
 *
 * COMPLIANCE IS NOT CHECKED HERE. This connects media. Whether a call may legally be placed
 * is decided by assertDialAllowed() before anything constructs a SipCallerSource — see
 * dial.ts. Keeping them apart means the gate cannot be satisfied by an argument passed to the
 * thing it restrains. A browser caller has no number and no carrier, so no gate applies.
 */
export async function runCall(opts: CallOptions, deps: CallDeps): Promise<CallResult> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const ttsRate = opts.ttsSampleRate ?? 24_000
  const sttRate = opts.sttSampleRate ?? 16_000

  const room = new Room()
  const sink = new LiveKitAudioSink({ sampleRate: ttsRate })
  let pump: { stop: () => void } | undefined
  let session: CallSession | undefined

  try {
    const token = await agentToken(deps.livekit, opts.roomName, `agent-${opts.callId}`)
    await room.connect(deps.livekit.url, token, { autoSubscribe: true, dynacast: false })
    log(`[call] agent joined room ${opts.roomName}`)

    const agentTrack = LocalAudioTrack.createAudioTrack('agent-voice', sink.source)
    const publishOptions = new TrackPublishOptions()
    publishOptions.source = TrackSource.SOURCE_MICROPHONE
    await room.localParticipant?.publishTrack(agentTrack, publishOptions)
    log('[call] published agent audio track')

    const admitted = await opts.caller.admit({
      room,
      roomName: opts.roomName,
      callId: opts.callId,
      log,
    })

    const { track: callerTrack } = await waitForCallerAudio(room, opts.audioTimeoutMs ?? 60_000)
    log(`[call] caller audio subscribed (${opts.caller.name})`)

    session = new CallSession(
      {
        callId: opts.callId,
        lang: opts.lang,
        voice: opts.voice,
        fsm: opts.fsm,
        holdOffMs: opts.holdOffMs ?? 400,
      },
      { stt: deps.stt, tts: deps.tts, intent: deps.intent, sink, turns: deps.turns },
    )

    pump = pumpTrack(callerTrack, {
      sampleRate: sttRate,
      onAudio: (pcm) => session?.pushAudio(pcm),
      onError: (err) => log(`[call] inbound audio error: ${String(err)}`),
    })

    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (p.identity === admitted.identity) {
        log('[call] caller left')
        void session?.close()
      }
    })

    await session.start()
    await session.waitForEnd()

    // Let the closing line finish before tearing down, or the caller hears a click
    // mid-sentence.
    await sink.waitForPlayout()
    log('[call] flow ended')

    return {
      connected: true,
      sipParticipant: admitted.sipParticipant,
      session,
    }
  } catch (err: unknown) {
    const failure = err instanceof Error ? err.message : String(err)
    log(`[call] failed: ${failure}`)
    return { connected: false, sipParticipant: undefined, session, failure }
  } finally {
    pump?.stop()
    await session?.close().catch(() => undefined)
    await sink.close().catch(() => undefined)
    await room.disconnect().catch(() => undefined)
  }
}

/**
 * Places a real outbound telephone call.
 *
 * A thin wrapper that picks the SIP caller source. Everything it does beyond that is shared
 * with the browser harness, which is the whole point.
 */
export function placeOutboundCall(
  opts: Omit<CallOptions, 'caller'> & SipCallerOptions,
  deps: CallDeps,
): Promise<CallResult> {
  const { trunkId, to, fromNumber, ringingTimeoutS, maxCallDurationS, ...rest } = opts
  return runCall(
    {
      ...rest,
      caller: new SipCallerSource(deps.livekit, {
        trunkId,
        to,
        ...(fromNumber === undefined ? {} : { fromNumber }),
        ...(ringingTimeoutS === undefined ? {} : { ringingTimeoutS }),
        ...(maxCallDurationS === undefined ? {} : { maxCallDurationS }),
      }),
    },
    deps,
  )
}
