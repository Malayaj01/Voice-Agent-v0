import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { MockTTSProvider } from '../mocks/index.js'
import type { Voice } from '../providers.js'
import {
  audioCacheKey,
  CachingTTSProvider,
  FileAudioCache,
  MemoryAudioCache,
} from './cache.js'

const VOICE: Voice = { id: 'af_heart', lang: 'en-IN' }

async function drain(chunks: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('audio cache key', () => {
  it('folds in voice and language, so renders never collide', () => {
    const base = audioCacheKey('Got a minute?', 'af_heart', 'en-IN')

    assert.equal(base, audioCacheKey('Got a minute?', 'af_heart', 'en-IN'), 'stable')
    assert.notEqual(base, audioCacheKey('Got a minute?', 'bf_emma', 'en-IN'))
    assert.notEqual(base, audioCacheKey('Got a minute?', 'af_heart', 'hi-IN-hinglish'))
    assert.notEqual(base, audioCacheKey('Got a moment?', 'af_heart', 'en-IN'))
  })
})

describe('CachingTTSProvider', () => {
  it('synthesises on a miss and serves the second call from cache', async () => {
    const inner = new MockTTSProvider({ msPerChar: 20, chunkMs: 20 })
    const cache = new MemoryAudioCache()
    const tts = new CachingTTSProvider(inner, cache, { sampleRate: 16_000 })

    const first = Buffer.concat(await drain(tts.synthesize('hello there', VOICE)))
    assert.equal(inner.synthesized.length, 1)

    const second = Buffer.concat(await drain(tts.synthesize('hello there', VOICE)))
    assert.equal(inner.synthesized.length, 1, 'a hit must not reach the provider')
    assert.deepEqual(second, first, 'and must return identical audio')
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1, entries: 1 })
  })

  it('treats a different voice as a different entry', async () => {
    const inner = new MockTTSProvider()
    const tts = new CachingTTSProvider(inner, new MemoryAudioCache())

    await drain(tts.synthesize('same words', VOICE))
    await drain(tts.synthesize('same words', { id: 'bf_emma', lang: 'en-IN' }))

    assert.equal(inner.synthesized.length, 2)
  })

  /**
   * The property that makes caching safe. A hit that resolved one big buffer would make the
   * bot un-interruptible on exactly the lines it says most often — caching would silently
   * disable barge-in.
   */
  it('a cache hit still streams in frames', async () => {
    const inner = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const tts = new CachingTTSProvider(inner, new MemoryAudioCache(), {
      sampleRate: 16_000,
      chunkMs: 20,
    })

    await drain(tts.synthesize('a long enough line', VOICE))
    const hitChunks = await drain(tts.synthesize('a long enough line', VOICE))

    assert.ok(hitChunks.length > 5, `expected many frames, got ${hitChunks.length}`)
    assert.ok(
      hitChunks.slice(0, -1).every((c) => c.byteLength === hitChunks[0]?.byteLength),
      'frames are evenly sized',
    )
  })

  it('a cache hit is cancellable mid-utterance', async () => {
    const inner = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const tts = new CachingTTSProvider(inner, new MemoryAudioCache(), { sampleRate: 16_000 })

    const full = await drain(tts.synthesize('interrupt me halfway through', VOICE))

    const got: Buffer[] = []
    for await (const chunk of tts.synthesize('interrupt me halfway through', VOICE)) {
      got.push(chunk)
      if (got.length === 3) tts.cancel()
    }

    assert.equal(got.length, 3)
    assert.ok(got.length < full.length, 'barge-in works the same on a cached line')
  })

  /**
   * The eager-capture trap: an async generator does not run until first iterated, so reading
   * the cancellation epoch inside the body would miss a barge-in that arrived before the first
   * pull. Same bug class as the one found in the mock provider.
   */
  it('yields nothing when cancelled before the first byte of a cached line', async () => {
    const tts = new CachingTTSProvider(new MockTTSProvider(), new MemoryAudioCache())

    await drain(tts.synthesize('pre-rendered', VOICE))

    const pending = tts.synthesize('pre-rendered', VOICE)
    tts.cancel()
    assert.equal((await drain(pending)).length, 0)
  })

  it('never caches a cancelled synthesis', async () => {
    const inner = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const cache = new MemoryAudioCache()
    const tts = new CachingTTSProvider(inner, cache, { sampleRate: 16_000 })

    const partial: Buffer[] = []
    for await (const chunk of tts.synthesize('cut this short', VOICE)) {
      partial.push(chunk)
      if (partial.length === 2) tts.cancel()
    }

    assert.equal(cache.stats().entries, 0, 'a truncated line must not be served to everyone else')

    const full = await drain(tts.synthesize('cut this short', VOICE))
    assert.ok(full.length > partial.length, 'the next call re-synthesises in full')
  })

  it('cancels the wrapped provider too, so compute stops on a miss', async () => {
    const inner = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const tts = new CachingTTSProvider(inner, new MemoryAudioCache())

    const got: Buffer[] = []
    for await (const chunk of tts.synthesize('stop generating', VOICE)) {
      got.push(chunk)
      if (got.length === 2) tts.cancel()
    }

    assert.equal(inner.cancelCount, 1)
  })
})

describe('FileAudioCache', () => {
  it('round-trips audio and its format through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'))
    const cache = new FileAudioCache(dir)
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])

    await cache.set('abc123', { pcm, sampleRate: 24_000, bytesPerSample: 2 })

    const fresh = new FileAudioCache(dir)
    const got = await fresh.get('abc123')

    assert.deepEqual(got?.pcm, pcm)
    assert.equal(got?.sampleRate, 24_000)
    assert.equal(got?.bytesPerSample, 2)
  })

  it('survives a restart, so a pre-warm is paid for once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'))
    const first = new FileAudioCache(dir)
    await first.set('k1', { pcm: Buffer.alloc(64), sampleRate: 24_000, bytesPerSample: 2 })
    await first.set('k2', { pcm: Buffer.alloc(64), sampleRate: 24_000, bytesPerSample: 2 })

    const restarted = new FileAudioCache(dir)
    assert.equal(await restarted.preload(), 2)
    assert.equal(restarted.stats().entries, 2)
  })

  /** A half-written entry from a killed pre-warm should cost one synthesis, not a crash. */
  it('reads a truncated entry as a miss rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'))
    await writeFile(join(dir, 'broken.pcm'), Buffer.from([0x00, 0x01]))

    const cache = new FileAudioCache(dir)
    assert.equal(await cache.get('broken'), undefined)
    assert.equal(await cache.preload(), 0, 'and is skipped by preload')
  })

  it('reads a missing directory as a cold start', async () => {
    const cache = new FileAudioCache(join(tmpdir(), 'definitely-not-created-yet-xyz'))
    assert.equal(await cache.preload(), 0)
    assert.equal(await cache.get('anything'), undefined)
  })
})
