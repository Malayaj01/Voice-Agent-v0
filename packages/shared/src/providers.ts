/**
 * Provider interfaces — ARCHITECTURE.md §5.
 *
 * The rule these exist to enforce: a registry returns an IMPLEMENTATION, never metadata
 * about a vendor. The predecessor repo's routing returned `{provider, voiceId}` and every
 * call site ignored it. If you find yourself returning a descriptor, you have reintroduced
 * that bug.
 */

import type { Lang } from './lang.js'

export interface STTOpts {
  /** Audio sample rate in Hz. */
  sampleRate: number
  /** Hints that bias recognition — contact name, company, product terms. */
  phraseHints?: readonly string[]
}

export interface STTEvents {
  /**
   * Caller STARTED speaking, from the VAD — not the recogniser.
   *
   * This is the barge-in trigger, and it has to be this rather than `partial`. Measured over
   * real WebRTC with faster-whisper, a first partial costs the partial interval (600ms) plus
   * a transcription round trip (~300ms), so barge-in keyed off it arrives about a second late
   * and misses short lines entirely. The VAD knows in ~40ms. A provider whose VAD cannot
   * report speech onset should emit this on its first partial and accept the latency.
   */
  speech_start: (text: string) => void
  /** Interim hypothesis; may be revised. */
  partial: (text: string) => void
  /** Stable transcript for the utterance. */
  final: (text: string) => void
  /** Caller stopped speaking. Starts the turn-latency clock. */
  endpoint: (text: string) => void
}

export interface STTStream {
  push(pcm: Buffer): void
  on<E extends keyof STTEvents>(event: E, cb: STTEvents[E]): void
  close(): void
}

export interface STTProvider {
  readonly name: string
  open(lang: Lang, opts: STTOpts): STTStream
}

/**
 * A stream whose VAD can say when speech actually stopped.
 *
 * §6 budgets endpoint detection at 150-300ms, which is too tight to measure by proxy. Without
 * this, the turn loop has to time from the last partial transcript — and a recogniser that
 * emits partials on an interval makes that reading drift by hundreds of milliseconds, which
 * is the whole budget. A provider that knows should say so; one that does not is measured the
 * old way and the number is softer.
 */
export interface VadTimedSTTStream {
  /** Audio position of the last frame that contained speech. */
  readonly lastSpeechEndedAtMs: number
  /** Audio position at which the endpoint was declared. */
  readonly endpointDetectedAtMs: number
}

export function hasVadTiming(stream: STTStream): stream is STTStream & VadTimedSTTStream {
  const candidate = stream as Partial<VadTimedSTTStream>
  return (
    typeof candidate.lastSpeechEndedAtMs === 'number' &&
    typeof candidate.endpointDetectedAtMs === 'number'
  )
}

export interface Voice {
  readonly id: string
  readonly lang: Lang
}

/**
 * TTS is streaming and cancellable from day one — even where the underlying provider
 * returns a complete file, in which case wrap it as a single-chunk async iterable.
 *
 * Do not "simplify" this to `Promise<Buffer>`. Doing so bakes in a permanent latency floor
 * and makes barge-in impossible to retrofit. §5
 */
export interface TTSProvider {
  readonly name: string
  synthesize(text: string, voice: Voice): AsyncIterable<Buffer>
  /** Called on barge-in, mid-utterance. Must stop audio already in flight. */
  cancel(): void
}

export interface CallCtx {
  readonly lang: Lang
  /** Current FSM state name. */
  readonly state: string
  /** Prior turns, most recent last. */
  readonly history: readonly { role: 'caller' | 'agent'; text: string }[]
}

export interface Intent {
  readonly label: string
  readonly confidence: number
}

/**
 * The model's ONLY job inside the turn loop: utterance -> intent. The FSM picks what is
 * said. A classifier that returns a line to speak is out of contract. §7.2
 */
export interface IntentClassifier {
  readonly name: string
  classify(ctx: CallCtx, utterance: string): Promise<Intent>
}

export type ProviderStage = 'stt' | 'tts' | 'intent'

/** Registry key. Provider choice is config-driven per (stage, language) — an env var swap. */
export type ProviderKey = `${ProviderStage}:${Lang}`

export function providerKey(stage: ProviderStage, lang: Lang): ProviderKey {
  return `${stage}:${lang}`
}
