/**
 * These tests pin the contract, not an implementation. The TTS interface being streaming
 * and cancellable is the decision most likely to get "simplified" away later — see §5 and
 * the note in providers.ts.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { providerKey, type TTSProvider, type Voice } from './providers.js'
import { breachedStages, totalMs, TURN_BUDGET_P95_MS } from './latency.js'
import { isE164, toE164 } from './ids.js'

const VOICE: Voice = { id: 'test-voice', lang: 'en-IN' }

/** Stands in for a file-returning free provider wrapped as a single-chunk iterable. */
class SingleChunkTTS implements TTSProvider {
  readonly name = 'fake-file-tts'
  private cancelled = false

  async *synthesize(text: string): AsyncIterable<Buffer> {
    if (this.cancelled) return
    yield Buffer.from(text)
  }

  cancel(): void {
    this.cancelled = true
  }
}

/** Stands in for a genuinely streaming provider; cancel must stop mid-utterance. */
class ChunkedTTS implements TTSProvider {
  readonly name = 'fake-streaming-tts'
  private cancelled = false

  async *synthesize(text: string): AsyncIterable<Buffer> {
    for (const ch of text) {
      if (this.cancelled) return
      yield Buffer.from(ch)
    }
  }

  cancel(): void {
    this.cancelled = true
  }
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<string> {
  const out: Buffer[] = []
  for await (const chunk of chunks) out.push(chunk)
  return Buffer.concat(out).toString()
}

describe('TTS contract', () => {
  it('a non-streaming provider still satisfies the streaming interface', async () => {
    const tts: TTSProvider = new SingleChunkTTS()
    assert.equal(await collect(tts.synthesize('hello', VOICE)), 'hello')
  })

  it('barge-in stops a streaming provider mid-utterance', async () => {
    const tts: TTSProvider = new ChunkedTTS()
    const out: Buffer[] = []
    for await (const chunk of tts.synthesize('hello there', VOICE)) {
      out.push(chunk)
      if (out.length === 3) tts.cancel()
    }
    assert.equal(Buffer.concat(out).toString(), 'hel')
  })
})

describe('provider registry key', () => {
  it('is keyed on stage and language, so a swap is config', () => {
    assert.equal(providerKey('tts', 'hi-IN-hinglish'), 'tts:hi-IN-hinglish')
    assert.notEqual(providerKey('stt', 'en-IN'), providerKey('tts', 'en-IN'))
  })
})

describe('latency budget', () => {
  it('a cached-TTS turn fits well inside the p95 budget', () => {
    const timings = { endpoint: 180, stt: 120, intent: 0, fsm: 1, tts_first_byte: 0, egress: 60 }
    assert.ok(totalMs(timings) < TURN_BUDGET_P95_MS)
    assert.deepEqual(breachedStages(timings), [])
  })

  it('names the offending stage rather than just the total', () => {
    assert.deepEqual(breachedStages({ endpoint: 450, stt: 120 }), ['endpoint'])
  })
})

describe('E.164', () => {
  it('accepts an Indian mobile in E.164 and rejects a bare 10-digit number', () => {
    assert.ok(isE164('+919876543210'))
    assert.ok(!isE164('9876543210'))
    assert.throws(() => toE164('9876543210'), TypeError)
  })
})
