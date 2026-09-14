import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { audioCacheKey, MemoryAudioCache, parseFlow, type Voice } from '@voice-agent/shared'
import { MockTTSProvider } from '@voice-agent/shared/mocks'

import { floatToPcm16, splitForStreaming } from './kokoro-tts.js'
import { linesFromFlow, loadRenderFile, precache } from './precache.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FLOW = parseFlow(readFileSync(join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml'), 'utf8'))

const VOICE: Voice = { id: 'af_heart', lang: 'en-IN' }
const VARS = {
  contact_first_name: 'Rahul',
  company: 'Lipi',
  company_name: 'Acme Clinics',
  industry: 'healthcare',
  slot_pair: 'Monday 11 or Tuesday 3',
  slot_first: 'Monday 11',
  slot_booked: 'Monday 11',
  anchor_question: 'Got a minute?',
}

const PCM = { sampleRate: 24_000, bytesPerSample: 2 }

describe('precache', () => {
  it('renders the whole reachable set and stores it under the runtime key', async () => {
    const lines = linesFromFlow(FLOW, 'en-IN', VARS, VOICE.id)
    const cache = new MemoryAudioCache()
    const tts = new MockTTSProvider({ msPerChar: 1, chunkMs: 20 })

    const result = await precache({ tts, cache, voice: VOICE, lines, ...PCM })

    assert.equal(result.failed, 0)
    assert.equal(result.synthesised, lines.length)
    assert.ok(lines.length >= 20, `expected the full closed set, got ${lines.length}`)

    // Every line is retrievable by the key the worker computes at call time.
    for (const line of lines) {
      const key = audioCacheKey(line.text, VOICE.id, VOICE.lang)
      assert.ok((await cache.get(key)) !== undefined, `missing: ${line.id}`)
    }
  })

  it('skips lines already cached, so a restart costs nothing', async () => {
    const lines = linesFromFlow(FLOW, 'en-IN', VARS, VOICE.id).slice(0, 5)
    const cache = new MemoryAudioCache()
    const tts = new MockTTSProvider({ msPerChar: 1 })

    await precache({ tts, cache, voice: VOICE, lines, ...PCM })
    const synthesisedFirstPass = tts.synthesized.length

    const second = await precache({ tts, cache, voice: VOICE, lines, ...PCM })

    assert.equal(second.alreadyCached, lines.length)
    assert.equal(second.synthesised, 0)
    assert.equal(tts.synthesized.length, synthesisedFirstPass, 'no re-synthesis')
  })

  /**
   * A stale render file is the realistic failure: someone edits the flow, redeploys, and the
   * artefact still holds yesterday's keys. Trusting the file's key would fill the cache with
   * entries the worker never looks up — a 0% hit rate that looks like a working pre-warm.
   */
  it('keys on the text it actually rendered, not the key in the file', async () => {
    const cache = new MemoryAudioCache()
    const tts = new MockTTSProvider({ msPerChar: 1 })

    await precache({
      tts,
      cache,
      voice: VOICE,
      lines: [{ id: 'opening', text: 'Hi Rahul, got a minute?', cacheKey: 'stale-key-from-an-old-build' }],
      ...PCM,
    })

    assert.equal(await cache.get('stale-key-from-an-old-build'), undefined)
    assert.ok(
      (await cache.get(audioCacheKey('Hi Rahul, got a minute?', VOICE.id, VOICE.lang))) !==
        undefined,
    )
  })

  it('records a failure without aborting the rest of the warm-up', async () => {
    const cache = new MemoryAudioCache()
    const failing = {
      name: 'exploding-tts',
      cancel: () => undefined,
      synthesize: (text: string): AsyncIterable<Buffer> => {
        if (text.includes('boom')) throw new Error('synthesis failed')
        return (async function* () {
          yield Buffer.alloc(32)
        })()
      },
    }

    const result = await precache({
      tts: failing,
      cache,
      voice: VOICE,
      lines: [
        { id: 'ok_one', text: 'fine', cacheKey: '' },
        { id: 'bad', text: 'boom', cacheKey: '' },
        { id: 'ok_two', text: 'also fine', cacheKey: '' },
      ],
      ...PCM,
    })

    assert.equal(result.synthesised, 2, 'the good lines still got rendered')
    assert.equal(result.failed, 1)
    assert.deepEqual(
      result.failures.map((f) => f.id),
      ['bad'],
    )
  })

  it('treats a provider that returns no audio as a failure, not a cached silence', async () => {
    const cache = new MemoryAudioCache()
    const silent = {
      name: 'silent',
      cancel: () => undefined,
      synthesize: (): AsyncIterable<Buffer> => (async function* () {})(),
    }

    const result = await precache({
      tts: silent,
      cache,
      voice: VOICE,
      lines: [{ id: 'x', text: 'anything', cacheKey: '' }],
      ...PCM,
    })

    assert.equal(result.failed, 1)
    assert.equal(cache.stats().entries, 0)
  })
})

describe('render file', () => {
  it('reads what the CLI writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-'))
    const path = join(dir, 'precache.json')
    await writeFile(
      path,
      JSON.stringify({
        flowVersion: 1,
        lang: 'en-IN',
        voiceId: 'af_heart',
        lines: [{ id: 'opening', text: 'Hi', cacheKey: 'abc' }],
      }),
      'utf8',
    )

    const file = await loadRenderFile(path)
    assert.equal(file.flowVersion, 1)
    assert.equal(file.lines[0]?.id, 'opening')
  })

  it('rejects a file that is not a render output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-'))
    const path = join(dir, 'nope.json')
    await writeFile(path, JSON.stringify({ something: 'else' }), 'utf8')

    await assert.rejects(() => loadRenderFile(path), /not a voice-flow render file/)
  })
})

describe('kokoro audio conversion', () => {
  it('converts float samples to signed 16-bit PCM', () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5]))

    assert.equal(pcm.byteLength, 8)
    assert.equal(pcm.readInt16LE(0), 0)
    assert.equal(pcm.readInt16LE(2), 32767)
    assert.equal(pcm.readInt16LE(4), -32768, 'full-scale negative must not wrap to positive')
    assert.equal(pcm.readInt16LE(6), Math.round(0.5 * 32767))
  })

  it('clamps out-of-range samples instead of wrapping', () => {
    const pcm = floatToPcm16(new Float32Array([2, -2]))

    assert.equal(pcm.readInt16LE(0), 32767)
    assert.equal(pcm.readInt16LE(2), -32768)
  })

  it('splits on sentence boundaries so the first frame does not wait on the paragraph', () => {
    assert.deepEqual(splitForStreaming('One. Two! Three?'), ['One.', 'Two!', 'Three?'])
    assert.deepEqual(splitForStreaming('No punctuation here'), ['No punctuation here'])
    assert.deepEqual(splitForStreaming(''), [''])
  })
})
