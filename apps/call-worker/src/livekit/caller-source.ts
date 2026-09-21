/**
 * How the caller gets onto the room — the ONLY part of a call that knows about telephony.
 *
 * LiveKit does not distinguish a SIP leg from a browser tab: both are participants publishing
 * an audio track. So the difference between "a phone rang" and "someone clicked Call" is
 * entirely contained in this one interface, and everything downstream — the turn loop, the
 * FSM, the providers, the §6 instrumentation, the turns rows — is identical.
 *
 * That is the property to protect. When the SIP trunk arrives, the change is one line:
 * construct a SipCallerSource instead of a JoiningCallerSource. If anything else has to
 * change, this seam has leaked and the browser harness has stopped being a faithful rehearsal
 * of the real thing.
 */

import type { Room } from '@livekit/rtc-node'
import { SipClient, type SIPParticipantInfo } from 'livekit-server-sdk'

import type { E164 } from '@voice-agent/shared'

export interface AdmitContext {
  room: Room
  roomName: string
  callId: string
  log: (line: string) => void
}

export interface AdmittedCaller {
  /** Participant identity to expect on the room. */
  identity: string
  /** Present only when a telephony leg was actually placed. */
  sipParticipant?: SIPParticipantInfo
}

export interface CallerSource {
  readonly name: string
  /**
   * Brings the caller onto the room, or waits for one that is arriving under its own power.
   * Resolves once the caller is expected to be present; the caller's audio track is awaited
   * separately, identically for every source.
   */
  admit(ctx: AdmitContext): Promise<AdmittedCaller>
}

export interface LiveKitConfig {
  url: string
  apiKey: string
  apiSecret: string
}

export interface SipCallerOptions {
  /** LiveKit SIP outbound trunk. Its number must be the registered 140x line (§2). */
  trunkId: string
  to: E164
  /** Overrides the trunk's from-number when a campaign uses a different registered line. */
  fromNumber?: string
  ringingTimeoutS?: number
  maxCallDurationS?: number
}

/** Places a real outbound telephone call. Requires a carrier trunk. */
export class SipCallerSource implements CallerSource {
  readonly name = 'sip'

  constructor(
    private readonly livekit: LiveKitConfig,
    private readonly opts: SipCallerOptions,
  ) {}

  async admit(ctx: AdmitContext): Promise<AdmittedCaller> {
    const sip = new SipClient(this.livekit.url, this.livekit.apiKey, this.livekit.apiSecret)
    const identity = `caller-${ctx.callId}`

    ctx.log(`[call] dialling ${this.opts.to} via trunk ${this.opts.trunkId}`)
    const sipParticipant = await sip.createSipParticipant(
      this.opts.trunkId,
      this.opts.to,
      ctx.roomName,
      {
        participantIdentity: identity,
        participantName: 'caller',
        // Without this the dial resolves on INVITE acceptance and the bot talks into a
        // ringing handset.
        waitUntilAnswered: true,
        ringingTimeout: this.opts.ringingTimeoutS ?? 30,
        maxCallDuration: this.opts.maxCallDurationS ?? 300,
        ...(this.opts.fromNumber === undefined ? {} : { fromNumber: this.opts.fromNumber }),
      },
    )
    ctx.log(`[call] answered: sip participant ${sipParticipant.participantId}`)

    return { identity, sipParticipant }
  }
}

/**
 * The caller joins on their own — a browser tab with a token, a synthetic participant in a
 * benchmark, anything that can reach the room.
 *
 * There is nothing to do here, and that is the point: the agent does not act differently, it
 * simply has no leg to place. Waiting for the audio track is common to every source.
 */
export class JoiningCallerSource implements CallerSource {
  readonly name = 'joining'

  constructor(private readonly identity: string) {}

  admit(ctx: AdmitContext): Promise<AdmittedCaller> {
    ctx.log(`[call] waiting for ${this.identity} to join ${ctx.roomName}`)
    return Promise.resolve({ identity: this.identity })
  }
}
