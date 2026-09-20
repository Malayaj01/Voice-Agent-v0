import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { durationMs, lastAudibleMs, noiseFloor, resamplePcm16, trimSilence } from './pcm.js'
import { EnergyVad, rmsDb, type VadEvent } from './vad.js'

const RATE = 16_000

/** A tone at a given level, as a stand-in for speech energy. */
function tone(ms: number, db: number, rate = RATE): Buffer {
  const samples = Math.round((rate * ms) / 1000)
  const amplitude = Math.pow(10, db / 20) * 32768 * Math.SQRT2
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / rate) * amplitude
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2)
  }
  return out
}

function silence(ms: number, rate = RATE): Buffer {
  return Buffer.alloc(Math.round((rate * ms) / 1000) * 2)
}

/** Feeds audio one 20ms frame at a time, the way the media layer would. */
function feed(vad: EnergyVad, pcm: Buffer): VadEvent[] {
  const frameBytes = (RATE * 2 * 20) / 1000
  const events: VadEvent[] = []
  for (let at = 0; at < pcm.byteLength; at += frameBytes) {
    events.push(...vad.push(pcm.subarray(at, at + frameBytes)))
  }
  return events
}

describe('rmsDb', () => {
  it('reports silence as -Infinity and a tone near its nominal level', () => {
    assert.equal(rmsDb(silence(20)), Number.NEGATIVE_INFINITY)
    assert.ok(Math.abs(rmsDb(tone(20, -20)) - -20) < 1.5)
  })
})

describe('EnergyVad', () => {
  it('detects speech start and backdates it past the debounce', () => {
    const vad = new EnergyVad({ sampleRate: RATE, speechFrames: 3 })
    const events = feed(vad, Buffer.concat([silence(200), tone(400, -20)]))

    const start = events.find((e) => e.type === 'speech_start')
    assert.ok(start !== undefined)
    // Confirmed on the third loud frame at 260ms, backdated to the first at 220ms.
    assert.equal(start.atMs, 220, 'the debounce is a confidence delay, not a later start')
  })

  /**
   * The §6 lever: endpoint latency IS the hangover, rounded up to a frame boundary.
   *
   * The quantisation is worth pinning rather than tolerating — a 150ms hangover costs 160ms
   * because it takes 8 whole 20ms frames to accumulate 150ms of silence. Anyone tuning to a
   * target should know the reachable values are multiples of frameMs.
   */
  it('declares the endpoint one hangover after speech stops, quantised to a frame', () => {
    const frameMs = 20
    for (const hangoverMs of [150, 200, 250, 400]) {
      const vad = new EnergyVad({ sampleRate: RATE, hangoverMs, frameMs })
      const events = feed(vad, Buffer.concat([tone(600, -20), silence(1000)]))

      const end = events.find((e) => e.type === 'speech_end')
      assert.ok(end !== undefined, `no endpoint at hangover ${hangoverMs}`)
      assert.equal(end.speechEndedAtMs, 600, 'speech genuinely stopped at 600ms')
      assert.equal(
        end.atMs - end.speechEndedAtMs,
        Math.ceil(hangoverMs / frameMs) * frameMs,
        `hangover ${hangoverMs} should round up to a whole number of frames`,
      )
    }
  })

  it('reports when speech stopped, not merely when it noticed', () => {
    const vad = new EnergyVad({ sampleRate: RATE, hangoverMs: 300 })
    const [end] = feed(vad, Buffer.concat([tone(500, -20), silence(800)])).filter(
      (e) => e.type === 'speech_end',
    )

    assert.ok(end !== undefined && end.type === 'speech_end')
    assert.ok(
      end.speechEndedAtMs < end.atMs,
      'the turn loop measures t_endpoint_ms from the former, not the latter',
    )
  })

  it('does not endpoint on a pause shorter than the hangover', () => {
    const vad = new EnergyVad({ sampleRate: RATE, hangoverMs: 400 })
    const events = feed(
      vad,
      Buffer.concat([tone(400, -20), silence(200), tone(400, -20), silence(800)]),
    )

    const ends = events.filter((e) => e.type === 'speech_end')
    assert.equal(ends.length, 1, 'a 200ms breath is not the end of a turn')
  })

  /** The cost of a short hangover, stated as a test so the trade is not a surprise. */
  it('cuts the turn in two when the pause exceeds the hangover', () => {
    const vad = new EnergyVad({ sampleRate: RATE, hangoverMs: 150 })
    const events = feed(
      vad,
      Buffer.concat([tone(400, -20), silence(300), tone(400, -20), silence(600)]),
    )

    assert.equal(events.filter((e) => e.type === 'speech_end').length, 2)
  })

  it('ignores line noise below the threshold', () => {
    const vad = new EnergyVad({ sampleRate: RATE, thresholdDb: -45 })
    const events = feed(vad, noiseFloor(RATE, -55))

    assert.deepEqual(events, [], '-55dBFS line noise must not read as speech')
    assert.equal(vad.isSpeaking, false)
  })

  it('handles frames split across pushes', () => {
    const vad = new EnergyVad({ sampleRate: RATE, hangoverMs: 200 })
    const pcm = Buffer.concat([tone(400, -20), silence(600)])

    // Deliberately not frame-aligned: the media layer hands over whatever arrives.
    const events: VadEvent[] = []
    for (let at = 0; at < pcm.byteLength; at += 313) {
      events.push(...vad.push(pcm.subarray(at, Math.min(at + 313, pcm.byteLength))))
    }

    const end = events.find((e) => e.type === 'speech_end')
    assert.ok(end !== undefined, 'ragged buffer sizes must not lose the endpoint')
  })

  it('reset returns it to a clean state', () => {
    const vad = new EnergyVad({ sampleRate: RATE })
    feed(vad, tone(400, -20))
    assert.ok(vad.isSpeaking)

    vad.reset()
    assert.equal(vad.isSpeaking, false)
    assert.equal(vad.positionMs, 0)
  })
})

describe('pcm helpers', () => {
  it('resamples 24k to 16k, preserving duration', () => {
    const at24 = tone(500, -20, 24_000)
    const at16 = resamplePcm16(at24, 24_000, 16_000)

    assert.equal(Math.round(durationMs(at16, 16_000)), 500)
    assert.ok(Math.abs(rmsDb(at16) - rmsDb(at24)) < 1, 'level survives the conversion')
  })

  it('is a no-op when the rate already matches', () => {
    const pcm = tone(50, -20)
    assert.equal(resamplePcm16(pcm, RATE, RATE), pcm)
  })

  it('finds the last audible sample, ignoring a noise tail', () => {
    const pcm = Buffer.concat([tone(500, -20), noiseFloor(RATE, -70)])
    const truth = lastAudibleMs(pcm, RATE, -60)

    assert.ok(Math.abs(truth - 500) < 25, `expected ~500ms, got ${truth}`)
  })

  /** The fix for the 760-900ms gaps that concatenated Kokoro renders were inserting. */
  it('trims leading and trailing padding without touching the body', () => {
    const body = tone(300, -20)
    const padded = Buffer.concat([silence(400), body, silence(500)])
    const trimmed = trimSilence(padded, RATE)

    assert.ok(Math.abs(durationMs(trimmed, RATE) - 300) < 25)
  })

  it('returns empty for audio that is entirely silence', () => {
    assert.equal(trimSilence(silence(200), RATE).byteLength, 0)
  })
})
