/**
 * Mock STT — canned transcripts, no vendor account.
 *
 * Event ordering follows §6, which is the part worth getting right: `endpoint` fires when
 * the caller STOPS speaking (VAD, 150-300ms) and starts the turn clock; `final` settles
 * afterwards (100-200ms). Anything measuring turn latency keys off `endpoint`, so a mock
 * that emitted them the other way round would quietly invalidate every latency test.
 *
 * The mock does not simulate a transcript being revised between `endpoint` and `final` —
 * both carry the same text. Partials are progressive word prefixes.
 */

import type { Lang } from '../lang.js'
import type { STTEvents, STTOpts, STTProvider, STTStream } from '../providers.js'
import { bytesForMs, DEFAULT_PCM, type PcmFormat } from './audio.js'
import { realSleep, type SleepFn } from './sleep.js'

export interface MockSTTConfig {
  /** Canned transcripts, consumed in order — one per utterance. */
  transcripts: readonly string[]
  /** Audio pushed before an utterance fires. Defaults to 1s at the stream's format. */
  bytesPerUtterance?: number
  /** Restart the script once exhausted. Default false: the stream then goes quiet. */
  loop?: boolean
  /** Emit progressive word-prefix partials during "speech". Default true. */
  emitPartials?: boolean
  /** Gap between partials. Default 0. */
  partialIntervalMs?: number
  /** VAD endpoint detection delay — §6 budget is 150-300ms. Default 0. */
  endpointMs?: number
  /** Time from endpoint to a settled transcript — §6 budget is 100-200ms. Default 0. */
  finalMs?: number
  format?: PcmFormat
  sleep?: SleepFn
}

/** Latency matching the §6 budget, for exercising the pipeline at realistic timing. */
export const MOCK_STT_REALISTIC = {
  partialIntervalMs: 120,
  endpointMs: 220,
  finalMs: 150,
} as const satisfies Partial<MockSTTConfig>

interface Resolved {
  transcripts: readonly string[]
  bytesPerUtterance: number
  loop: boolean
  emitPartials: boolean
  partialIntervalMs: number
  endpointMs: number
  finalMs: number
  format: PcmFormat
  sleep: SleepFn
}

function resolve(cfg: MockSTTConfig): Resolved {
  const format = cfg.format ?? DEFAULT_PCM
  return {
    transcripts: cfg.transcripts,
    bytesPerUtterance: cfg.bytesPerUtterance ?? bytesForMs(format, 1000),
    loop: cfg.loop ?? false,
    emitPartials: cfg.emitPartials ?? true,
    partialIntervalMs: cfg.partialIntervalMs ?? 0,
    endpointMs: cfg.endpointMs ?? 0,
    finalMs: cfg.finalMs ?? 0,
    format,
    sleep: cfg.sleep ?? realSleep,
  }
}

/** Progressive word prefixes, excluding the complete utterance. "a b c" -> ["a", "a b"]. */
function partialsOf(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const out: string[] = []
  for (let i = 1; i < words.length; i++) out.push(words.slice(0, i).join(' '))
  return out
}

export class MockSTTStream implements STTStream {
  readonly lang: Lang
  readonly opts: STTOpts

  /** Every buffer handed to push(), for assertions about what reached the provider. */
  readonly pushed: Buffer[] = []

  private readonly cfg: Resolved
  private readonly listeners: { [E in keyof STTEvents]: STTEvents[E][] } = {
    speech_start: [],
    partial: [],
    final: [],
    endpoint: [],
  }

  private buffered = 0
  private index = 0
  private closed = false
  /** Serialises utterances so two pushes cannot interleave their events. */
  private queue: Promise<void> = Promise.resolve()

  constructor(lang: Lang, opts: STTOpts, cfg: MockSTTConfig) {
    this.lang = lang
    this.opts = opts
    this.cfg = resolve(cfg)
  }

  push(pcm: Buffer): void {
    if (this.closed) return
    this.pushed.push(pcm)
    this.buffered += pcm.byteLength
    while (this.buffered >= this.cfg.bytesPerUtterance) {
      this.buffered -= this.cfg.bytesPerUtterance
      void this.emitNext()
    }
  }

  on<E extends keyof STTEvents>(event: E, cb: STTEvents[E]): void {
    this.listeners[event].push(cb)
  }

  close(): void {
    this.closed = true
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Transcripts not yet emitted. */
  get remaining(): number {
    return Math.max(0, this.cfg.transcripts.length - this.index)
  }

  /**
   * Emit the next canned utterance without pushing audio. The deterministic hook to drive
   * a mock call from a test; returns once the utterance's events have all fired.
   */
  emitNext(): Promise<void> {
    this.queue = this.queue.then(() => this.runUtterance())
    return this.queue
  }

  /** Convenience: push exactly enough silence to trigger one utterance. */
  pushUtteranceAudio(): void {
    this.push(Buffer.alloc(this.cfg.bytesPerUtterance))
  }

  private nextTranscript(): string | undefined {
    const { transcripts, loop } = this.cfg
    if (transcripts.length === 0) return undefined
    if (this.index >= transcripts.length) {
      if (!loop) return undefined
      this.index = 0
    }
    return transcripts[this.index++]
  }

  private async runUtterance(): Promise<void> {
    if (this.closed) return
    const text = this.nextTranscript()
    if (text === undefined) return

    // Speech onset, before any transcription — the barge-in trigger.
    this.emit('speech_start', '')

    if (this.cfg.emitPartials) {
      for (const partial of partialsOf(text)) {
        await this.cfg.sleep(this.cfg.partialIntervalMs)
        if (this.closed) return
        this.emit('partial', partial)
      }
    }

    // Caller stopped speaking. This is what starts the turn-latency clock.
    await this.cfg.sleep(this.cfg.endpointMs)
    if (this.closed) return
    this.emit('endpoint', text)

    await this.cfg.sleep(this.cfg.finalMs)
    if (this.closed) return
    this.emit('final', text)
  }

  private emit<E extends keyof STTEvents>(event: E, text: string): void {
    for (const cb of this.listeners[event]) cb(text)
  }
}

export class MockSTTProvider implements STTProvider {
  readonly name = 'mock-stt'

  /** Streams handed out by open(), in order. */
  readonly streams: MockSTTStream[] = []

  private readonly cfg: MockSTTConfig

  constructor(cfg: MockSTTConfig) {
    this.cfg = cfg
  }

  open(lang: Lang, opts: STTOpts): MockSTTStream {
    const stream = new MockSTTStream(lang, opts, this.cfg)
    this.streams.push(stream)
    return stream
  }
}
