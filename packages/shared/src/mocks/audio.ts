/** PCM helpers shared by the mock providers. */

export interface PcmFormat {
  /** Hz. 16k is the usual telephony-side rate for STT; carriers hand over 8k narrowband. */
  sampleRate: number
  /** 2 = signed 16-bit little-endian. */
  bytesPerSample: number
}

export const DEFAULT_PCM: PcmFormat = { sampleRate: 16_000, bytesPerSample: 2 }

export function bytesForMs(format: PcmFormat, ms: number): number {
  const frames = Math.round((format.sampleRate * ms) / 1000)
  return frames * format.bytesPerSample
}

export function msForBytes(format: PcmFormat, bytes: number): number {
  return (bytes / format.bytesPerSample / format.sampleRate) * 1000
}

/** Zero-filled is silence for signed PCM — no tone generation needed to exercise the path. */
export function silence(format: PcmFormat, ms: number): Buffer {
  return Buffer.alloc(bytesForMs(format, ms))
}
