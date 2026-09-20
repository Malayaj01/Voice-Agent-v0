/**
 * The LiveKit media adapters, exercised against the real FFI.
 *
 * No room and no server are needed to construct an AudioSource and capture into it, so the
 * queue behaviour that barge-in depends on is tested for real rather than against a mock of
 * LiveKit's own queue — which would be a mock of exactly the thing that could be wrong.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { dispose } from '@livekit/rtc-node'

import { LiveKitAudioSink, int16ToPcm, pcmToInt16 } from './media.js'

const RATE = 24_000

function pcmOf(values: readonly number[]): Buffer {
  const out = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => out.writeInt16LE(v, i * 2))
  return out
}

/** 20ms of silence at the sink's rate. */
function frame(ms = 20): Buffer {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2)
}

const sinks: LiveKitAudioSink[] = []
function makeSink(): LiveKitAudioSink {
  const sink = new LiveKitAudioSink({ sampleRate: RATE })
  sinks.push(sink)
  return sink
}

after(async () => {
  await Promise.all(sinks.map((s) => s.close().catch(() => undefined)))
  // Closing each source is not enough: the FFI keeps its own handles and the process never
  // exits, so `node --test` reports the whole file as failed after the timeout even though
  // every assertion passed. rtc-node exports dispose() for exactly this.
  await dispose()
})

describe('PCM <-> Int16Array', () => {
  it('round-trips exactly, including the rails', () => {
    const pcm = pcmOf([0, 1234, -1234, 32767, -32768])
    assert.deepEqual(int16ToPcm(pcmToInt16(pcm)), pcm)
  })

  /**
   * The reason this copies instead of viewing the ArrayBuffer: a Buffer from subarray can sit
   * at an odd byteOffset, and an Int16Array view requires 2-byte alignment. A view would
   * throw on some frames and not others — the worst way to meet a bug on a live call.
   */
  it('handles a buffer at an odd byteOffset', () => {
    const backing = Buffer.concat([Buffer.alloc(1), pcmOf([4321, -4321])])
    const misaligned = backing.subarray(1)

    assert.equal(misaligned.byteOffset % 2, 1, 'precondition: genuinely misaligned')
    assert.deepEqual([...pcmToInt16(misaligned)], [4321, -4321])
  })

  it('handles an empty buffer', () => {
    assert.equal(pcmToInt16(Buffer.alloc(0)).length, 0)
  })
})

describe('LiveKitAudioSink', () => {
  it('declares the rate the TTS provider emits, so nothing resamples in our code', () => {
    const sink = makeSink()
    assert.equal(sink.source.sampleRate, RATE)
    assert.equal(sink.source.numChannels, 1)
  })

  it('captures audio into LiveKit and reports it queued', async () => {
    const sink = makeSink()
    await sink.write(frame())
    await sink.write(frame())

    assert.equal(sink.framesWritten, 2)
    assert.ok(sink.source.queuedDuration > 0, 'audio is queued inside LiveKit, not yet played')
  })

  /**
   * The load-bearing one. cancel() stops the TTS producer, but audio already handed to
   * LiveKit keeps playing — the bot talking over the caller for as long as the queue is deep.
   * clearQueue() is what makes barge-in audible, and this asserts it against the real queue.
   */
  it('flush drops queued audio, which is what makes barge-in audible', async () => {
    const sink = makeSink()
    for (let i = 0; i < 5; i++) await sink.write(frame())

    const queuedBefore = sink.source.queuedDuration
    assert.ok(queuedBefore > 0, `expected queued audio, got ${queuedBefore}`)

    sink.flush()

    assert.equal(sink.source.queuedDuration, 0, 'the caller must not hear the rest of the line')
    assert.equal(sink.flushes, 1)
  })

  it('ignores an empty chunk rather than capturing a zero-length frame', async () => {
    const sink = makeSink()
    await sink.write(Buffer.alloc(0))
    assert.equal(sink.framesWritten, 0)
  })

  it('satisfies the AudioSink contract the turn loop is written against', () => {
    const sink = makeSink()
    // Structural, not nominal: the point of §4 is that telephony plugs in behind the same
    // interface the tests and the mocks already use.
    assert.equal(typeof sink.write, 'function')
    assert.equal(typeof sink.flush, 'function')
  })
})
