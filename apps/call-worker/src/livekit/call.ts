/**
 * One outbound call: room, SIP leg, turn loop — ARCHITECTURE.md §4.
 *
 * The sequence, and why it is this order:
 *
 *   1. connect to a room and publish the bot's audio track
 *   2. dial the caller onto that room over SIP
 *   3. when their track arrives, start the turn loop
 *
 * The track is published BEFORE dialling because the first thing the flow does is speak. If
 * the SIP leg connected first, the opening line would race the track becoming live and the
 * caller would hear silence, then a fragment.
 *
 * `waitUntilAnswered` matters for the same reason: without it the dial returns as soon as the
 * INVITE is accepted and the bot starts talking into a ringing phone.
 *
 * Nothing below reaches into CallSession. It gets an AudioSink and is fed PCM; whether that
 * came from a SIP trunk or a unit test is not its concern, which is the §4 claim that
 * telephony is a transport.
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
import { AccessToken, SipClient, type SIPParticipantInfo } from 'livekit-server-sdk'

import type { E164, Fsm, IntentClassifier, STTProvider, TTSProvider, TurnSink, Voice } from '@voice-agent/shared'

import { CallSession } from '../session.js'
import { LiveKitAudioSink, pumpTrack } from './media.js'

export interface LiveKitConfig {
  url: string
  apiKey: string
  apiSecret: string
}

export interface OutboundCallOptions {
  callId: string
  roomName: string
  /** The number being called. */
  to: E164
  /** LiveKit SIP outbound trunk id. Its number must be the registered 140x line. */
  trunkId: string
  /** Overrides the trunk's own from-number when a campaign uses a different registered line. */
  fromNumber?: string
  lang: Voice['lang']
  voice: Voice
  fsm: Fsm
  /** Seconds to let it ring before giving up. */
  ringingTimeoutS?: number
  maxCallDurationS?: number
  /** Rate the TTS provider emits — Kokoro is 24k. */
  ttsSampleRate?: number
  /** Rate to feed the STT — faster-whisper wants 16k. */
  sttSampleRate?: number
}

export interface OutboundCallDeps {
  livekit: LiveKitConfig
  stt: STTProvider
  tts: TTSProvider
  intent: IntentClassifier
  turns: TurnSink
  log?: (line: string) => void
}

export interface OutboundCallResult {
  connected: boolean
  sipParticipant: SIPParticipantInfo | undefined
  session: CallSession | undefined
  /** Why it did not connect, when it did not. */
  failure?: string
}

async function workerToken(cfg: LiveKitConfig, room: string, identity: string): Promise<string> {
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '2h' })
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })
  return token.toJwt()
}

/** Resolves with the caller's audio track once they are on the room. */
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

/**
 * Places one outbound call and runs the turn loop on it.
 *
 * COMPLIANCE IS NOT CHECKED HERE. This function dials. Whether dialling is legal is decided
 * by assertDialAllowed() before anything calls it — see dial.ts. Keeping the two apart means
 * the gate cannot be satisfied by an argument passed to the thing it is meant to restrain.
 */
export async function placeOutboundCall(
  opts: OutboundCallOptions,
  deps: OutboundCallDeps,
): Promise<OutboundCallResult> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const ttsRate = opts.ttsSampleRate ?? 24_000
  const sttRate = opts.sttSampleRate ?? 16_000

  const room = new Room()
  const sink = new LiveKitAudioSink({ sampleRate: ttsRate })
  let pump: { stop: () => void } | undefined
  let session: CallSession | undefined

  try {
    const token = await workerToken(deps.livekit, opts.roomName, `agent-${opts.callId}`)
    await room.connect(deps.livekit.url, token, { autoSubscribe: true, dynacast: false })
    log(`[call] joined room ${opts.roomName}`)

    // Published before the dial: the flow speaks first, and a track that goes live after the
    // callee answers loses the opening line.
    const agentTrack = LocalAudioTrack.createAudioTrack('agent-voice', sink.source)
    const publishOptions = new TrackPublishOptions()
    publishOptions.source = TrackSource.SOURCE_MICROPHONE
    await room.localParticipant?.publishTrack(agentTrack, publishOptions)
    log('[call] published agent audio track')

    const sip = new SipClient(deps.livekit.url, deps.livekit.apiKey, deps.livekit.apiSecret)
    log(`[call] dialling ${opts.to} via trunk ${opts.trunkId}`)

    const sipParticipant = await sip.createSipParticipant(
      opts.trunkId,
      opts.to,
      opts.roomName,
      {
        participantIdentity: `caller-${opts.callId}`,
        participantName: 'caller',
        // Without this the dial resolves on INVITE acceptance and the bot talks into a
        // ringing handset.
        waitUntilAnswered: true,
        ringingTimeout: opts.ringingTimeoutS ?? 30,
        maxCallDuration: opts.maxCallDurationS ?? 300,
        ...(opts.fromNumber === undefined ? {} : { fromNumber: opts.fromNumber }),
      },
    )
    log(`[call] answered: sip participant ${sipParticipant.participantId}`)

    const { track: callerTrack } = await waitForCallerAudio(room, 15_000)
    log('[call] caller audio subscribed')

    session = new CallSession(
      {
        callId: opts.callId,
        lang: opts.lang,
        voice: opts.voice,
        fsm: opts.fsm,
        // The caller's own audio reaches the STT over the SIP leg, so without echo
        // cancellation the bot barges in on itself. Documented in session.ts; this is the
        // floor until AEC is real.
        holdOffMs: 400,
      },
      { stt: deps.stt, tts: deps.tts, intent: deps.intent, sink, turns: deps.turns },
    )

    pump = pumpTrack(callerTrack, {
      sampleRate: sttRate,
      onAudio: (pcm) => session?.pushAudio(pcm),
      onError: (err) => log(`[call] inbound audio error: ${String(err)}`),
    })

    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (p.identity === `caller-${opts.callId}`) {
        log('[call] caller hung up')
        void session?.close()
      }
    })

    await session.start()
    await session.waitForEnd()

    // Let the closing line finish before tearing the leg down, or the caller hears a click
    // mid-sentence.
    await sink.waitForPlayout()
    log('[call] flow ended')

    return { connected: true, sipParticipant, session }
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
