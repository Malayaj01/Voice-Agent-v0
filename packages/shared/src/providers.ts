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
