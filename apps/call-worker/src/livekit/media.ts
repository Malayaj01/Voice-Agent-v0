/**
 * LiveKit media adapters — ARCHITECTURE.md §4.
 *
 * This is the whole point of the provider interfaces: telephony is a transport, so it plugs
 * in at the edges and NOTHING in the turn loop changes. CallSession, the FSM, the STT and TTS
 * providers and the §6 instrumentation are all untouched by this file. What it does is
 * convert between LiveKit's AudioFrame and the PCM buffers everything else already speaks.
 *
 * NO RESAMPLING HAPPENS HERE, on purpose. LiveKit resamples at both edges — AudioStream takes
 * the rate you want frames in, AudioSource the rate you are producing — and it does a better
 * job of it than the linear interpolator in pcm.ts, which aliases on downsample. So the
 * inbound stream is asked for 16k (what Whisper wants) and the outbound source is declared at
 * 24k (what Kokoro emits), and the SIP leg's own 8k narrowband conversion stays LiveKit's
 * problem. pcm.ts's resampler remains for offline work where there is no LiveKit.
 */

import { AudioFrame, AudioSource, AudioStream, type RemoteAudioTrack } from '@livekit/rtc-node'

import type { AudioSink } from '../audio.js'

/**
 * Buffer of signed 16-bit LE PCM to Int16Array.
 *
 * Copies rather than viewing the underlying ArrayBuffer: a Buffer from `subarray` can sit at
 * an odd byteOffset, and Int16Array requires 2-byte alignment. The view would throw on some
 * frames and not others, which is the worst kind of bug to meet on a live call.
 */
export function pcmToInt16(pcm: Buffer): Int16Array {
  const samples = pcm.byteLength >> 1
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) out[i] = pcm.readInt16LE(i * 2)
  return out
}

export function int16ToPcm(data: Int16Array): Buffer {
  const out = Buffer.alloc(data.length * 2)
  for (let i = 0; i < data.length; i++) out.writeInt16LE(data[i] ?? 0, i * 2)
  return out
}

export interface LiveKitAudioSinkOptions {
  /** Rate the TTS provider emits. Kokoro is 24k. */
  sampleRate: number
  channels?: number
}

/**
 * Publishes the bot's audio into the room.
 *
 * The barge-in contract is why flush() matters here. `captureFrame` queues audio inside
 * LiveKit, so cancelling TTS stops the producer but leaves whatever is already queued to keep
 * playing — the bot talking over the caller for as long as the queue is deep. `clearQueue()`
 * is what actually makes barge-in audible, and it is the reason AudioSink has a flush() at all.
 */
export class LiveKitAudioSink implements AudioSink {
  readonly source: AudioSource
  private readonly channels: number
  private readonly sampleRate: number

  /** Frames captured and queue drops, for the health endpoint and post-call diagnostics. */
  framesWritten = 0
  flushes = 0

  constructor(opts: LiveKitAudioSinkOptions) {
    this.sampleRate = opts.sampleRate
    this.channels = opts.channels ?? 1
    this.source = new AudioSource(this.sampleRate, this.channels)
  }

  async write(chunk: Buffer): Promise<void> {
    if (chunk.byteLength === 0) return
    const data = pcmToInt16(chunk)
    const frame = new AudioFrame(
      data,
      this.sampleRate,
      this.channels,
      data.length / this.channels,
    )
    await this.source.captureFrame(frame)
    this.framesWritten++
  }

  flush(): void {
    this.flushes++
    this.source.clearQueue()
  }

  /** Resolves once queued audio has actually played out. For a clean hangup. */
  waitForPlayout(): Promise<void> {
    return this.source.waitForPlayout()
  }

  async close(): Promise<void> {
    await this.source.close()
  }
}

export interface InboundPumpOptions {
  /** Rate to receive frames at. 16k is what faster-whisper wants. */
  sampleRate: number
  /** Called with each PCM frame — CallSession.pushAudio. */
  onAudio: (pcm: Buffer) => void
  onError?: (err: unknown) => void
}

/**
 * Pumps the caller's audio track into the turn loop.
 *
 * Runs until the track ends or stop() is called. Frames arrive at the requested rate, so the
 * VAD and STT see exactly the format they were built and benchmarked against.
 */
export function pumpTrack(track: RemoteAudioTrack, opts: InboundPumpOptions): { stop: () => void } {
  const stream = new AudioStream(track, opts.sampleRate)
  const reader = stream.getReader()
  let stopped = false

  const run = async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) break
        if (value !== undefined) opts.onAudio(int16ToPcm(value.data))
      }
    } catch (err: unknown) {
      if (!stopped) opts.onError?.(err)
    } finally {
      reader.releaseLock()
    }
  }

  void run()

  return {
    stop: () => {
      stopped = true
      void reader.cancel().catch(() => undefined)
    },
  }
}
