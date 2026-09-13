/**
 * Mock TTS — silent PCM, streamed in chunks, cancellable mid-utterance.
 *
 * The mock is streaming and cancellable because the INTERFACE is, not because silent audio
 * needs to be. §5: the free provider returns a complete file and still gets wrapped as an
 * async iterable. A mock that resolved a whole Buffer would let a barge-in bug sit
 * undetected until the first paid provider landed.
 *
 * MockFileTTSProvider is the other half of that contract — a provider with no streaming of
 * its own, wrapped as a single chunk. Both are cancellable.
 */

import type { TTSProvider, Voice } from '../providers.js'
import { bytesForMs, DEFAULT_PCM, type PcmFormat } from './audio.js'
import { realSleep, type SleepFn } from './sleep.js'

export interface MockTTSConfig {
  format?: PcmFormat
  /** Speech rate. 70ms/char is roughly 150 wpm. */
  msPerChar?: number
  /** Audio carried by each chunk. Default 20ms, the usual RTP frame. */
  chunkMs?: number
  /** Time to first audio byte — §6 budget is 250ms, and 0 when the line is cached. */
  firstByteMs?: number
  /** Delay between chunks. 0 emits as fast as the consumer iterates. */
  chunkIntervalMs?: number
  sleep?: SleepFn
}

/** Latency matching the §6 budget for an uncached line. */
export const MOCK_TTS_REALISTIC = { firstByteMs: 200, chunkIntervalMs: 0 } as const

interface Resolved {
  format: PcmFormat
  msPerChar: number
  chunkMs: number
  firstByteMs: number
  chunkIntervalMs: number
  sleep: SleepFn
}

function resolve(cfg: MockTTSConfig): Resolved {
  return {
    format: cfg.format ?? DEFAULT_PCM,
    msPerChar: cfg.msPerChar ?? 70,
    chunkMs: cfg.chunkMs ?? 20,
    firstByteMs: cfg.firstByteMs ?? 0,
    chunkIntervalMs: cfg.chunkIntervalMs ?? 0,
    sleep: cfg.sleep ?? realSleep,
  }
}

export interface SynthesisRecord {
  text: string
  voice: Voice
  /** Chunks actually yielded — short of the full count when cancelled. */
  chunksEmitted: number
  bytesEmitted: number
  cancelled: boolean
}

/** Shared cancellation + bookkeeping. */
abstract class BaseMockTTS implements TTSProvider {
  abstract readonly name: string

  abstract synthesize(text: string, voice: Voice): AsyncIterable<Buffer>

  /** One record per synthesize() call, in order. */
  readonly synthesized: SynthesisRecord[] = []

  protected readonly cfg: Resolved

  /**
   * Bumped by cancel(). Every in-flight synthesis compares against the value it started
   * with, so cancel() stops all of them.
   *
   * A call worker holds its own provider instance and speaks one line at a time, so in
   * practice there is a single synthesis in flight; concurrent calls sharing one instance
   * would cancel each other, which is why they must not share one.
   */
  private epoch = 0
  private cancels = 0

  constructor(cfg: MockTTSConfig = {}) {
    this.cfg = resolve(cfg)
  }

  get cancelCount(): number {
    return this.cancels
  }

  cancel(): void {
    this.cancels++
    this.epoch++
    const current = this.synthesized.at(-1)
    if (current !== undefined) current.cancelled = true
  }

  protected durationMs(text: string): number {
    return Math.max(this.cfg.chunkMs, Math.round(text.length * this.cfg.msPerChar))
  }

  /**
   * Starts a synthesis and returns its stream.
   *
   * Both the epoch capture and the record push happen HERE, eagerly, rather than inside the
   * generator body. An async generator does not execute until it is first iterated, so a
   * lazy capture would read the epoch after a cancel() that arrived in between — and the
   * barge-in would be ignored. That is the case the "cancelled before the first byte" test
   * pins.
   */
  protected start(text: string, voice: Voice, chunks: readonly Buffer[]): AsyncIterable<Buffer> {
    const startedAt = this.epoch
    const record: SynthesisRecord = {
      text,
      voice,
      chunksEmitted: 0,
      bytesEmitted: 0,
      cancelled: false,
    }
    this.synthesized.push(record)
    return this.drive(startedAt, record, chunks)
  }

  private async *drive(
    startedAt: number,
    record: SynthesisRecord,
    chunks: readonly Buffer[],
  ): AsyncIterable<Buffer> {
    const cancelled = (): boolean => this.epoch !== startedAt

    if (cancelled()) {
      record.cancelled = true
      return
    }

    await this.cfg.sleep(this.cfg.firstByteMs)
    if (cancelled()) {
      record.cancelled = true
      return
    }

    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) await this.cfg.sleep(this.cfg.chunkIntervalMs)
      if (cancelled()) {
        record.cancelled = true
        return
      }
      record.chunksEmitted++
      record.bytesEmitted += chunk.byteLength
      yield chunk
    }
  }
}

/** Streams silent PCM in chunkMs frames. */
export class MockTTSProvider extends BaseMockTTS {
  readonly name = 'mock-tts'

  override synthesize(text: string, voice: Voice): AsyncIterable<Buffer> {
    const total = this.durationMs(text)
    const chunkBytes = bytesForMs(this.cfg.format, this.cfg.chunkMs)
    const count = Math.max(1, Math.ceil(total / this.cfg.chunkMs))
    const chunks = Array.from({ length: count }, () => Buffer.alloc(chunkBytes))
    return this.start(text, voice, chunks)
  }
}

/**
 * A provider that has no streaming of its own — the shape of the free file-returning TTS —
 * wrapped as a single-chunk async iterable. Still cancellable before the first byte.
 */
export class MockFileTTSProvider extends BaseMockTTS {
  readonly name = 'mock-file-tts'

  override synthesize(text: string, voice: Voice): AsyncIterable<Buffer> {
    const whole = Buffer.alloc(bytesForMs(this.cfg.format, this.durationMs(text)))
    return this.start(text, voice, [whole])
  }
}

/** Collects a synthesis to a single Buffer. Convenience for tests and cache pre-warming. */
export async function collectAudio(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const chunk of chunks) out.push(chunk)
  return Buffer.concat(out)
}
