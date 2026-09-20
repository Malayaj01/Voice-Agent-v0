/**
 * Voice activity detection and endpointing — ARCHITECTURE.md §6.
 *
 * "VAD endpoint detect 150-300ms — tune FIRST, biggest single lever."
 *
 * The lever is `hangoverMs`: how long the detector waits after the audio goes quiet before
 * concluding the caller has stopped. That wait is, almost entirely, the endpoint latency.
 * Detection compute is microseconds; the hangover is hundreds of milliseconds. Any tuning
 * that is not tuning the hangover is rounding error.
 *
 * And it is a genuine trade, not a free win. Shorten it and the bot interrupts people who
 * were mid-sentence, pausing for breath. Lengthen it and every turn pays. The benchmark
 * (bench-endpoint.ts) reports both sides so the choice is made on numbers.
 *
 * WHY THIS IS IN-PROCESS. faster-whisper is Python and transcription crosses a pipe, but
 * endpointing never does: it is the event that starts the turn clock, so putting IPC in front
 * of it would spend the budget it exists to measure. VAD is an RMS comparison over 20ms
 * frames — it costs nothing to keep here.
 *
 * ON THIS IMPLEMENTATION. Energy thresholding is the honest floor, not the ceiling. It is
 * accurate on clean or lightly noisy audio and cheap enough to be free, but it will trigger
 * on a barking dog and miss a quiet talker. Silero VAD is the production answer and slots in
 * behind the same `Vad` interface. What it changes is ROBUSTNESS, not latency: the hangover
 * still dominates, so the numbers this produces remain the right basis for tuning.
 */

export interface VadConfig {
  sampleRate: number
  /** Analysis frame. 20ms matches the usual RTP frame, so frames arrive already aligned. */
  frameMs?: number
  /** Speech threshold in dBFS. -45 separates speech from typical line noise. */
  thresholdDb?: number
  /** Consecutive loud frames before declaring speech. Debounces clicks and line pops. */
  speechFrames?: number
  /** Silence before declaring the end of the turn. THE lever — see the header. */
  hangoverMs?: number
}

export type VadEvent =
  | { type: 'speech_start'; atMs: number }
  | {
      type: 'speech_end'
      /** Audio position at which the detector concluded speech had stopped. */
      atMs: number
      /**
       * Audio position of the last frame that actually contained speech.
       *
       * This is the honest zero for the §6 endpoint stage: `atMs - speechEndedAtMs` is the
       * detection delay, and it is what the turn loop should measure from rather than
       * inferring the moment from the last partial transcript.
       */
      speechEndedAtMs: number
    }

export interface Vad {
  /** Feeds audio and returns whatever it concluded. Cheap enough to call per frame. */
  push(pcm: Buffer): VadEvent[]
  /** Audio consumed so far, in milliseconds. */
  readonly positionMs: number
  readonly isSpeaking: boolean
  reset(): void
}

export interface ResolvedVadConfig {
  sampleRate: number
  frameMs: number
  thresholdDb: number
  speechFrames: number
  hangoverMs: number
}

export const VAD_DEFAULTS = {
  frameMs: 20,
  thresholdDb: -45,
  speechFrames: 2,
  /** Middle of the §6 range. The benchmark exists to replace this with a measured choice. */
  hangoverMs: 250,
} as const

export function resolveVadConfig(cfg: VadConfig): ResolvedVadConfig {
  return {
    sampleRate: cfg.sampleRate,
    frameMs: cfg.frameMs ?? VAD_DEFAULTS.frameMs,
    thresholdDb: cfg.thresholdDb ?? VAD_DEFAULTS.thresholdDb,
    speechFrames: cfg.speechFrames ?? VAD_DEFAULTS.speechFrames,
    hangoverMs: cfg.hangoverMs ?? VAD_DEFAULTS.hangoverMs,
  }
}

/** Root-mean-square level of signed 16-bit PCM, in dBFS. Silence returns -Infinity. */
export function rmsDb(frame: Buffer): number {
  const samples = frame.byteLength >> 1
  if (samples === 0) return Number.NEGATIVE_INFINITY

  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  const rms = Math.sqrt(sum / samples)
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms)
}

export class EnergyVad implements Vad {
  readonly config: ResolvedVadConfig

  private readonly frameBytes: number
  private leftover: Buffer = Buffer.alloc(0)
  private consumedSamples = 0

  private speaking = false
  private loudRun = 0
  private quietRun = 0
  private lastSpeechEndMs = 0

  constructor(cfg: VadConfig) {
    this.config = resolveVadConfig(cfg)
    this.frameBytes = Math.round((this.config.sampleRate * this.config.frameMs) / 1000) * 2
  }

  get positionMs(): number {
    return (this.consumedSamples / this.config.sampleRate) * 1000
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  reset(): void {
    this.leftover = Buffer.alloc(0)
    this.consumedSamples = 0
    this.speaking = false
    this.loudRun = 0
    this.quietRun = 0
    this.lastSpeechEndMs = 0
  }

  push(pcm: Buffer): VadEvent[] {
    const events: VadEvent[] = []
    let buf = this.leftover.byteLength === 0 ? pcm : Buffer.concat([this.leftover, pcm])

    let offset = 0
    while (buf.byteLength - offset >= this.frameBytes) {
      const frame = buf.subarray(offset, offset + this.frameBytes)
      offset += this.frameBytes
      this.consumedSamples += this.frameBytes >> 1

      const frameEndMs = this.positionMs
      const loud = rmsDb(frame) > this.config.thresholdDb

      if (loud) {
        this.loudRun++
        this.quietRun = 0
        if (this.speaking) {
          this.lastSpeechEndMs = frameEndMs
        } else if (this.loudRun >= this.config.speechFrames) {
          this.speaking = true
          this.lastSpeechEndMs = frameEndMs
          // Backdated to the first loud frame: the debounce is a confidence delay, not part
          // of when the caller actually started talking.
          events.push({
            type: 'speech_start',
            atMs: frameEndMs - (this.config.speechFrames - 1) * this.config.frameMs,
          })
        }
        continue
      }

      this.loudRun = 0
      if (!this.speaking) continue

      this.quietRun++
      if (this.quietRun * this.config.frameMs >= this.config.hangoverMs) {
        this.speaking = false
        this.quietRun = 0
        events.push({
          type: 'speech_end',
          atMs: frameEndMs,
          speechEndedAtMs: this.lastSpeechEndMs,
        })
      }
    }

    this.leftover = offset === 0 ? buf : buf.subarray(offset)
    buf = Buffer.alloc(0)
    return events
  }
}
