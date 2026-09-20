/**
 * PCM utilities shared by the media path and the benchmarks.
 *
 * Sample rates in play: a carrier hands over 8k narrowband, Whisper wants 16k, Kokoro emits
 * 24k. Something has to convert, and doing it badly shows up as a worse word error rate that
 * gets blamed on the model.
 */

/**
 * Linear-interpolating resampler for signed 16-bit PCM.
 *
 * Linear interpolation, not a windowed-sinc filter, so downsampling aliases anything above
 * the new Nyquist. For 24k -> 16k on speech that is audibly and measurably fine; for 16k -> 8k
 * it is not, and a proper low-pass belongs there before anyone measures WER on carrier audio.
 * Written down because it is the kind of shortcut that silently becomes a vendor comparison.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm

  const inSamples = pcm.byteLength >> 1
  if (inSamples === 0) return Buffer.alloc(0)

  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate))
  const out = Buffer.alloc(outSamples * 2)
  const ratio = (inSamples - 1) / Math.max(1, outSamples - 1)

  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(inSamples - 1, left + 1)
    const frac = pos - left
    const a = pcm.readInt16LE(left * 2)
    const b = pcm.readInt16LE(right * 2)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))), i * 2)
  }
  return out
}

/** Signed 16-bit PCM to Float32 in [-1, 1) — what most ASR front-ends want. */
export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const samples = pcm.byteLength >> 1
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

export function durationMs(pcm: Buffer, sampleRate: number): number {
  return ((pcm.byteLength >> 1) / sampleRate) * 1000
}

/**
 * Audio position of the last sample above `floorDb`.
 *
 * Ground truth for the endpoint benchmark. Deliberately a much lower threshold than the VAD
 * uses: "the audio stopped" has to be defined independently of the detector being measured,
 * or the benchmark just reports its own configuration back.
 */
export function lastAudibleMs(pcm: Buffer, sampleRate: number, floorDb = -60): number {
  const threshold = Math.pow(10, floorDb / 20) * 32768
  for (let i = (pcm.byteLength >> 1) - 1; i >= 0; i--) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) return ((i + 1) / sampleRate) * 1000
  }
  return 0
}

/** Deterministic low-level noise. Real line silence is never digital zero. */
export function noiseFloor(samples: number, db: number, seed = 1): Buffer {
  const amplitude = Math.pow(10, db / 20) * 32768
  const out = Buffer.alloc(samples * 2)
  let s = seed >>> 0
  for (let i = 0; i < samples; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const uniform = s / 0x100000000 - 0.5
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(uniform * 2 * amplitude))), i * 2)
  }
  return out
}

/**
 * Strips leading and trailing near-silence.
 *
 * Needed when concatenating per-segment TTS renders: each render carries its own padding, so
 * joining them end to end inserts a pause that nobody asked for. Measured on Kokoro output,
 * that padding put 760-900ms between sentences — long enough that a VAD endpoints mid-line
 * and the bot sounds like it lost its train of thought.
 */
export function trimSilence(pcm: Buffer, sampleRate: number, floorDb = -50): Buffer {
  const threshold = Math.pow(10, floorDb / 20) * 32768
  const samples = pcm.byteLength >> 1
  if (samples === 0) return pcm

  let first = 0
  while (first < samples && Math.abs(pcm.readInt16LE(first * 2)) <= threshold) first++
  if (first === samples) return Buffer.alloc(0)

  let last = samples - 1
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) <= threshold) last--

  return pcm.subarray(first * 2, (last + 1) * 2)
}
