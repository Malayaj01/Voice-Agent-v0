/**
 * Audio egress. The last hop in the §6 budget, and the thing barge-in has to stop.
 *
 * Phase 1 writes to a buffer; the LiveKit track publisher implements the same interface.
 */

export interface AudioSink {
  write(chunk: Buffer): Promise<void> | void
  /**
   * Drop anything queued but not yet on the wire. Called on barge-in: cancelling TTS stops
   * the producer, but audio already handed to the transport would keep playing, and the bot
   * talking over the caller for another 200ms is exactly the artefact barge-in exists to
   * prevent.
   */
  flush(): Promise<void> | void
}

export interface BufferingAudioSinkOpts {
  /** Simulated egress delay per chunk — the last hop in the §6 budget. */
  writeDelayMs?: number
  /** Injectable so a test can run the delay on virtual time. */
  sleep?: (ms: number) => Promise<void>
}

/** Collects everything written. What the tests assert against. */
export class BufferingAudioSink implements AudioSink {
  readonly chunks: Buffer[] = []
  flushes = 0

  private readonly writeDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: BufferingAudioSinkOpts = {}) {
    this.writeDelayMs = opts.writeDelayMs ?? 0
    this.sleep = opts.sleep ?? (() => Promise.resolve())
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.writeDelayMs > 0) await this.sleep(this.writeDelayMs)
    this.chunks.push(chunk)
  }

  flush(): void {
    this.flushes++
  }

  get byteLength(): number {
    return this.chunks.reduce((n, c) => n + c.byteLength, 0)
  }

  clear(): void {
    this.chunks.length = 0
  }
}
