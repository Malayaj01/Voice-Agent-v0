/**
 * Event ordering for the faster-whisper adapter, driven through a fake transcriber.
 *
 * No Python, no model download: what is under test is WHEN events fire relative to the VAD,
 * which is what decides whether the §6 numbers mean anything. Whether Whisper returns good
 * text is a WER question for the corpus (§10.5), not a unit test.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { noiseFloor, type Lang } from '@voice-agent/shared'

import { FasterWhisperSTTStream, type SttHost } from './faster-whisper-stt.js'

const RATE = 16_000
const FRAME_BYTES = (RATE * 2 * 20) / 1000

function tone(ms: number, db = -20): Buffer {
  const samples = Math.round((RATE * ms) / 1000)
  const amplitude = Math.pow(10, db / 20) * 32768 * Math.SQRT2
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2)
  }
  return out
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2)
}

class FakeHost implements SttHost {
  readonly calls: Array<{ partial: boolean; bytes: number }> = []
  /** Resolves pending transcriptions manually, to test what happens while one is in flight. */
  private readonly gates: Array<() => void> = []

  constructor(
    readonly opts: SttHost['opts'] = { emitPartials: true, partialIntervalMs: 400, vad: {} },
    private readonly text = 'hello there',
    private readonly manual = false,
  ) {}

  transcribe(pcm: Buffer, _rate: number, _lang: Lang, partial: boolean): Promise<{ text: string; ms: number }> {
    this.calls.push({ partial, bytes: pcm.byteLength })
    if (!this.manual) return Promise.resolve({ text: this.text, ms: 1 })
    return new Promise((resolve) => {
      this.gates.push(() => resolve({ text: this.text, ms: 1 }))
    })
  }

  releaseAll(): void {
    while (this.gates.length > 0) this.gates.shift()?.()
  }
}

function feed(stream: FasterWhisperSTTStream, pcm: Buffer): void {
  for (let at = 0; at < pcm.byteLength; at += FRAME_BYTES) {
    stream.push(pcm.subarray(at, at + FRAME_BYTES))
  }
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('faster-whisper stream ordering', () => {
  /**
   * The load-bearing test. `endpoint` starts the §6 turn clock, so it must fire the moment the
   * VAD concludes — not after the ASR comes back. Emitting it after `final` would be the
   * tempting simplification (Whisper hands you text and silence together) and would fold
   * seconds of transcription into a stage budgeted at 300ms.
   */
  it('emits endpoint before final, and before any transcription is requested', async () => {
    const host = new FakeHost({ emitPartials: false, partialIntervalMs: 400, vad: { hangoverMs: 200 } })
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const order: string[] = []
    stream.on('endpoint', () => order.push(`endpoint:${host.calls.length} transcriptions so far`))
    stream.on('final', (t) => order.push(`final:${t}`))

    feed(stream, Buffer.concat([tone(600), silence(600)]))

    assert.deepEqual(
      order,
      ['endpoint:0 transcriptions so far'],
      'endpoint must fire synchronously from push(), before the ASR round trip',
    )

    await settle()
    assert.deepEqual(order, ['endpoint:0 transcriptions so far', 'final:hello there'])
  })

  it('reports when speech actually stopped, not when it was noticed', async () => {
    const host = new FakeHost({ emitPartials: false, partialIntervalMs: 400, vad: { hangoverMs: 300 } })
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    let seen = false
    stream.on('endpoint', () => {
      seen = true
    })

    feed(stream, Buffer.concat([tone(500), silence(800)]))
    await settle()

    assert.ok(seen)
    assert.equal(stream.lastSpeechEndedAtMs, 500, 'the zero for t_endpoint_ms')
    assert.equal(
      stream.endpointDetectedAtMs - stream.lastSpeechEndedAtMs,
      300,
      'and the detection delay is the hangover',
    )
  })

  it('emits partials while the caller is still speaking', async () => {
    const host = new FakeHost(
      { emitPartials: true, partialIntervalMs: 200, vad: { hangoverMs: 300 } },
      'partial text',
    )
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const partials: string[] = []
    stream.on('partial', (t) => partials.push(t))

    feed(stream, tone(1000))
    for (let i = 0; i < 10; i++) await settle()

    assert.ok(partials.length > 0, 'a long utterance should produce interim transcripts')
    assert.ok(host.calls.some((c) => c.partial))
  })

  it('does not emit partials when they are switched off', async () => {
    const host = new FakeHost({ emitPartials: false, partialIntervalMs: 100, vad: {} })
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const partials: string[] = []
    stream.on('partial', (t) => partials.push(t))

    feed(stream, tone(1200))
    for (let i = 0; i < 10; i++) await settle()

    assert.deepEqual(partials, [])
    assert.deepEqual(host.calls.filter((c) => c.partial), [])
  })

  /** A partial landing after the endpoint would walk the transcript backwards. */
  it('suppresses a partial that resolves after the endpoint has fired', async () => {
    const host = new FakeHost(
      { emitPartials: true, partialIntervalMs: 100, vad: { hangoverMs: 200 } },
      'stale partial',
      true,
    )
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const events: string[] = []
    stream.on('partial', (t) => events.push(`partial:${t}`))
    stream.on('endpoint', () => events.push('endpoint'))
    stream.on('final', () => events.push('final'))

    feed(stream, Buffer.concat([tone(800), silence(600)]))
    host.releaseAll()
    for (let i = 0; i < 10; i++) await settle()

    assert.ok(!events.some((e) => e.startsWith('partial')), `got ${JSON.stringify(events)}`)
    assert.ok(events.includes('endpoint'))
  })

  it('does not run two transcriptions of the same buffer at once', async () => {
    const host = new FakeHost(
      { emitPartials: true, partialIntervalMs: 20, vad: { hangoverMs: 400 } },
      'x',
      true,
    )
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    feed(stream, tone(1000))
    await settle()

    assert.equal(
      host.calls.filter((c) => c.partial).length,
      1,
      'partials must not pile up while one is in flight — each costs a full transcription',
    )
    host.releaseAll()
  })

  it('treats line noise as silence and never opens a turn', async () => {
    const host = new FakeHost({ emitPartials: true, partialIntervalMs: 100, vad: {} })
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const events: string[] = []
    stream.on('endpoint', () => events.push('endpoint'))
    stream.on('final', () => events.push('final'))

    feed(stream, noiseFloor(RATE * 2, -55))
    for (let i = 0; i < 5; i++) await settle()

    assert.deepEqual(events, [], '-55dBFS noise must not start or end a turn')
    assert.deepEqual(host.calls, [], 'and must not cost a transcription')
  })

  it('stops emitting once closed', async () => {
    const host = new FakeHost({ emitPartials: false, partialIntervalMs: 400, vad: { hangoverMs: 200 } })
    const stream = new FasterWhisperSTTStream(host, 'en-IN', { sampleRate: RATE })

    const events: string[] = []
    stream.on('final', () => events.push('final'))

    stream.close()
    feed(stream, Buffer.concat([tone(600), silence(600)]))
    await settle()

    assert.deepEqual(events, [])
  })
})
