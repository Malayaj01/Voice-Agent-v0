/**
 * Kokoro-82M behind TTSProvider — the free tier of the §5 stack (Apache 2.0, CPU-capable).
 *
 * MEASURED BEHAVIOUR, because it determines how this can be used at all. On a 12-core laptop,
 * q8 on CPU:
 *
 *   model load            ~14 s   (once, at boot)
 *   synthesis             ~2x slower than realtime
 *   time to first byte    seconds, against a 250ms budget (§6)
 *
 * So an uncached Kokoro line is not merely slow, it is unusable on a live call. This provider
 * is therefore only viable behind CachingTTSProvider with the flow's closed set pre-warmed —
 * which is exactly what §6 predicts, and why "pre-cache the scripted audio" is described there
 * as the free win rather than an optimisation. Anything reaching a live synthesis is either a
 * cache miss worth alerting on, or a reason to move to a paid provider for that stage.
 *
 * Streaming: Kokoro generates a whole utterance, so "streaming" here is real but coarse —
 * kokoro-js splits on sentence boundaries and this yields each sentence's audio as 20ms
 * frames. Time-to-first-byte is therefore the time to synthesise the FIRST SENTENCE, not the
 * first sample. That is an honest limit of the model, not of the wrapper, and it is another
 * reason the cache carries this stack.
 *
 * Cancellation is checked between frames and before the first byte, so barge-in behaves the
 * same as any other provider even though the underlying model cannot be interrupted mid-
 * sentence. Work already in flight inside the model is abandoned, not awaited.
 *
 * DEPENDENCY RISK, recorded rather than buried: kokoro-js pulls @huggingface/transformers,
 * which depends on `sharp`, which carries three high-severity libvips/libheif advisories with
 * no fix available. Those are image-decoding paths that a TTS-only use never touches, but they
 * are in the tree and `npm audit` will keep reporting them. If that is unacceptable, the fix is
 * to run Kokoro out of process — a self-hosted HTTP endpoint behind this same interface — which
 * keeps the whole transformers stack out of the worker's dependencies. §5's point is that this
 * swap is an implementation detail behind TTSProvider, and it is.
 */

import { trimSilence, type TTSProvider, type Voice } from '@voice-agent/shared'

/** Minimal surface of kokoro-js that we depend on. */
interface KokoroAudio {
  audio: Float32Array
  sampling_rate: number
}
interface KokoroModel {
  generate(text: string, opts: { voice: string }): Promise<KokoroAudio>
  voices: Record<string, unknown>
}

export interface KokoroOptions {
  /** HuggingFace repo. The ONNX community build is the one with CPU-usable quantisations. */
  model?: string
  /** q8 keeps the download ~80MB and the memory footprint small; fp32 is ~310MB. */
  dtype?: 'q8' | 'q4' | 'fp16' | 'fp32'
  device?: 'cpu' | 'wasm'
  /** Frame size handed to the audio sink. 20ms is the usual RTP frame. */
  chunkMs?: number
  /** Maps our Voice.id to a Kokoro voice name when they differ. */
  voiceMap?: Readonly<Record<string, string>>
  defaultVoice?: string
  /**
   * Pause inserted between sentences, after each render's own padding is trimmed.
   *
   * Kokoro pads every generate() call, so concatenating per-sentence renders untouched puts
   * 760-900ms of silence between sentences (measured across the flow's 22 lines). That is
   * long enough for the VAD to endpoint mid-line and for the bot to sound like it forgot what
   * it was saying. 120ms is an ordinary sentence break.
   */
  interSegmentGapMs?: number
}

export const KOKORO_SAMPLE_RATE = 24_000
export const KOKORO_BYTES_PER_SAMPLE = 2

/** Float32 [-1,1] to signed 16-bit little-endian PCM, which is what the sink and cache use. */
export function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    // Asymmetric scaling: 32767 positive, 32768 negative, so full-scale does not wrap.
    out.writeInt16LE(Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), i * 2)
  }
  return out
}

/** Sentence-ish split, so the first frame does not wait on the whole paragraph. */
export function splitForStreaming(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : [text]
}

export class KokoroTTSProvider implements TTSProvider {
  readonly name = 'kokoro-82m'

  private model: KokoroModel | undefined
  private loading: Promise<KokoroModel> | undefined
  private epoch = 0

  private readonly opts: Required<Omit<KokoroOptions, 'voiceMap'>> & {
    voiceMap: Readonly<Record<string, string>>
  }

  constructor(opts: KokoroOptions = {}) {
    this.opts = {
      model: opts.model ?? 'onnx-community/Kokoro-82M-v1.0-ONNX',
      dtype: opts.dtype ?? 'q8',
      device: opts.device ?? 'cpu',
      chunkMs: opts.chunkMs ?? 20,
      defaultVoice: opts.defaultVoice ?? 'af_heart',
      voiceMap: opts.voiceMap ?? {},
      interSegmentGapMs: opts.interSegmentGapMs ?? 120,
    }
  }

  /**
   * Loads the model. Call at boot: a first synthesis that also pays ~14s of model load would
   * otherwise land on a real caller.
   */
  async warmup(): Promise<void> {
    await this.load()
  }

  private load(): Promise<KokoroModel> {
    if (this.model !== undefined) return Promise.resolve(this.model)
    this.loading ??= import('kokoro-js').then(async ({ KokoroTTS }) => {
      const model = (await KokoroTTS.from_pretrained(this.opts.model, {
        dtype: this.opts.dtype,
        device: this.opts.device,
      })) as unknown as KokoroModel
      this.model = model
      return model
    })
    return this.loading
  }

  private voiceName(voice: Voice): string {
    return this.opts.voiceMap[voice.id] ?? voice.id ?? this.opts.defaultVoice
  }

  cancel(): void {
    this.epoch++
  }

  synthesize(text: string, voice: Voice): AsyncIterable<Buffer> {
    // Captured eagerly: an async generator does not run until first iterated, so reading the
    // epoch inside the body would miss a barge-in that arrived before the first pull.
    return this.run(text, this.voiceName(voice), this.epoch)
  }

  private async *run(text: string, voiceName: string, startedAt: number): AsyncIterable<Buffer> {
    const cancelled = (): boolean => this.epoch !== startedAt
    if (cancelled()) return

    const model = await this.load()
    if (cancelled()) return

    const chunkBytes = Math.round((KOKORO_SAMPLE_RATE * this.opts.chunkMs) / 1000) * 2

    const gap = Buffer.alloc(
      Math.round((KOKORO_SAMPLE_RATE * this.opts.interSegmentGapMs) / 1000) * 2,
    )

    for (const [i, segment] of splitForStreaming(text).entries()) {
      if (cancelled()) return

      // The model cannot be interrupted mid-segment. The result of an in-flight generate is
      // discarded rather than awaited-then-played, which is what makes barge-in feel immediate
      // even though the compute is not actually stopped.
      const result = await model.generate(segment, { voice: voiceName })
      if (cancelled()) return

      // Trim the render's own padding and impose a deliberate gap, rather than inheriting
      // whatever silence the model happened to emit at each end.
      const body = trimSilence(floatToPcm16(result.audio), KOKORO_SAMPLE_RATE)
      const pcm = i === 0 || gap.byteLength === 0 ? body : Buffer.concat([gap, body])

      for (let at = 0; at < pcm.byteLength; at += chunkBytes) {
        if (cancelled()) return
        yield pcm.subarray(at, Math.min(at + chunkBytes, pcm.byteLength))
      }
    }
  }
}
