/**
 * The hot path — ARCHITECTURE.md §3.3 and the one rule in §3:
 *
 *   NEVER put a service boundary inside the turn loop.
 *
 * Everything between "caller stopped speaking" and "bot starts speaking" runs in this
 * process: VAD -> STT -> intent -> FSM -> TTS -> audio out. Vendor API calls are hops you
 * cannot avoid; do not stack your own on top. If an implementation of this contract ever
 * needs an HTTP client to reach our own code, the design has gone wrong.
 *
 * Types only. Phase 1 implements this against LiveKit Agents.
 */

import type {
  CallCtx,
  CallId,
  Intent,
  IntentClassifier,
  Lang,
  ScriptVersionId,
  STTProvider,
  TTSProvider,
  TurnTimings,
} from '@voice-agent/shared'

export interface SessionDeps {
  readonly stt: STTProvider
  readonly tts: TTSProvider
  readonly intent: IntentClassifier
}

export interface SessionInit {
  readonly callId: CallId
  readonly lang: Lang
  readonly scriptVersionId: ScriptVersionId
}

/** What the FSM returns for a turn: the next state and the approved line to speak. */
export interface FsmDecision {
  readonly nextState: string
  /** Selected from a closed, approved set — never generated. §7.2 */
  readonly line: string
  /** True when the line's audio was pre-cached, making TTS 0ms. §6 */
  readonly cached: boolean
}

export interface Fsm {
  readonly scriptVersionId: ScriptVersionId
  advance(ctx: CallCtx, intent: Intent): FsmDecision
}

/** One completed turn, with the per-stage timings that get written to `turns`. */
export interface TurnResult {
  readonly seq: number
  readonly utterance: string
  readonly intent: Intent
  readonly decision: FsmDecision
  readonly timings: TurnTimings
}

/**
 * A live call. In-process and checkpointed to Postgres, so a worker restart mid-call is
 * recoverable — that is what Phase 5 chaos-tests.
 */
export interface CallSession {
  readonly callId: CallId
  readonly state: string
  /** Barge-in: cancels TTS mid-utterance and returns the loop to listening. */
  bargeIn(): void
  onTurn(cb: (turn: TurnResult) => void): void
  close(): Promise<void>
}

export type CreateSession = (init: SessionInit, deps: SessionDeps) => Promise<CallSession>
