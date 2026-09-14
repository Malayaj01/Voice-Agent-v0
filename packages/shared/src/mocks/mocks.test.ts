import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CallCtx, Voice } from '../providers.js'
import { bytesForMs, DEFAULT_PCM, msForBytes } from './audio.js'
import { FixedIntentClassifier, MockIntentClassifier } from './intent.js'
import { recordingSleep } from './sleep.js'
import { MOCK_STT_REALISTIC, MockSTTProvider } from './stt.js'
import { collectAudio, MOCK_TTS_REALISTIC, MockFileTTSProvider, MockTTSProvider } from './tts.js'

const VOICE: Voice = { id: 'mock-voice', lang: 'en-IN' }
const CTX: CallCtx = { lang: 'en-IN', state: 'OPENING', history: [] }

/** Lets pending microtasks and setImmediate callbacks drain. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('mock STT', () => {
  it('emits endpoint before final, because endpoint starts the turn clock', async () => {
    const provider = new MockSTTProvider({ transcripts: ['yes go ahead'] })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })

    const order: string[] = []
    stream.on('partial', (t) => order.push(`partial:${t}`))
    stream.on('endpoint', (t) => order.push(`endpoint:${t}`))
    stream.on('final', (t) => order.push(`final:${t}`))

    await stream.emitNext()

    assert.deepEqual(order, [
      'partial:yes',
      'partial:yes go',
      'endpoint:yes go ahead',
      'final:yes go ahead',
    ])
  })

  it('consumes canned transcripts in order and then goes quiet', async () => {
    const provider = new MockSTTProvider({ transcripts: ['one', 'two'], emitPartials: false })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })

    const finals: string[] = []
    stream.on('final', (t) => finals.push(t))

    await stream.emitNext()
    await stream.emitNext()
    await stream.emitNext() // script exhausted, loop off

    assert.deepEqual(finals, ['one', 'two'])
    assert.equal(stream.remaining, 0)
  })

  it('loops the script when asked', async () => {
    const provider = new MockSTTProvider({
      transcripts: ['again'],
      emitPartials: false,
      loop: true,
    })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })
    const finals: string[] = []
    stream.on('final', (t) => finals.push(t))

    await stream.emitNext()
    await stream.emitNext()

    assert.deepEqual(finals, ['again', 'again'])
  })

  it('fires an utterance only once enough audio has been pushed', async () => {
    const provider = new MockSTTProvider({
      transcripts: ['triggered by audio'],
      emitPartials: false,
      bytesPerUtterance: bytesForMs(DEFAULT_PCM, 100),
    })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })
    const finals: string[] = []
    stream.on('final', (t) => finals.push(t))

    stream.push(Buffer.alloc(bytesForMs(DEFAULT_PCM, 40)))
    await tick()
    assert.deepEqual(finals, [], 'below the threshold, nothing fires')

    stream.push(Buffer.alloc(bytesForMs(DEFAULT_PCM, 60)))
    await tick()
    assert.deepEqual(finals, ['triggered by audio'])
  })

  it('applies the configured artificial latency', async () => {
    const { sleep, calls } = recordingSleep()
    const provider = new MockSTTProvider({
      transcripts: ['a b'],
      ...MOCK_STT_REALISTIC,
      sleep,
    })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })
    await stream.emitNext()

    // one partial, then endpoint detection, then the settled transcript
    assert.deepEqual(calls, [120, 220, 150])
  })

  it('stops emitting once closed', async () => {
    const provider = new MockSTTProvider({ transcripts: ['x'], emitPartials: false })
    const stream = provider.open('en-IN', { sampleRate: 16_000 })
    const finals: string[] = []
    stream.on('final', (t) => finals.push(t))

    stream.close()
    await stream.emitNext()

    assert.deepEqual(finals, [])
    assert.ok(stream.isClosed)
  })
})

describe('mock TTS', () => {
  it('streams silent PCM of the expected duration', async () => {
    const tts = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const audio = await collectAudio(tts.synthesize('abcde', VOICE))

    assert.equal(Math.round(msForBytes(DEFAULT_PCM, audio.byteLength)), 500)
    assert.ok(
      audio.every((byte) => byte === 0),
      'silence is zero-filled PCM',
    )
  })

  it('cancels mid-utterance and stops yielding', async () => {
    const tts = new MockTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const chunks: Buffer[] = []

    for await (const chunk of tts.synthesize('abcdefghij', VOICE)) {
      chunks.push(chunk)
      if (chunks.length === 3) tts.cancel() // barge-in
    }

    assert.equal(chunks.length, 3, 'stops at the barge-in, not at the end of the utterance')
    assert.equal(tts.cancelCount, 1)
    assert.equal(tts.synthesized.at(-1)?.cancelled, true)
  })

  it('yields nothing when cancelled before the first byte', async () => {
    const { sleep } = recordingSleep()
    const tts = new MockTTSProvider({ firstByteMs: 200, sleep })
    const iterable = tts.synthesize('hello', VOICE)
    tts.cancel()

    assert.equal((await collectAudio(iterable)).byteLength, 0)
  })

  it('a file-returning provider satisfies the contract and is still cancellable', async () => {
    const tts = new MockFileTTSProvider({ msPerChar: 100, chunkMs: 20 })
    const audio = await collectAudio(tts.synthesize('abc', VOICE))
    assert.equal(tts.synthesized[0]?.chunksEmitted, 1, 'whole file arrives as one chunk')
    assert.ok(audio.byteLength > 0)

    const cancelled = new MockFileTTSProvider()
    const pending = cancelled.synthesize('abc', VOICE)
    cancelled.cancel()
    assert.equal((await collectAudio(pending)).byteLength, 0)
  })

  it('applies the configured time to first byte', async () => {
    const { sleep, calls } = recordingSleep()
    const tts = new MockTTSProvider({ ...MOCK_TTS_REALISTIC, msPerChar: 20, chunkMs: 20, sleep })
    await collectAudio(tts.synthesize('ab', VOICE))

    assert.equal(calls[0], 200, 'the first sleep is time-to-first-byte')
  })

  it('records what was synthesised, so a cache test can assert zero synthesis', async () => {
    const tts = new MockTTSProvider()
    await collectAudio(tts.synthesize('Namaste', VOICE))

    assert.equal(tts.synthesized.length, 1)
    assert.equal(tts.synthesized[0]?.text, 'Namaste')
    assert.equal(tts.synthesized[0]?.voice.id, 'mock-voice')
  })
})

describe('mock intent classifier', () => {
  it('maps canned utterances to the flow labels', async () => {
    const clf = new MockIntentClassifier()
    assert.equal((await clf.classify(CTX, 'haan theek hai')).label, 'acknowledge')
    assert.equal((await clf.classify(CTX, 'I am busy right now')).label, 'no_time')
    assert.equal((await clf.classify(CTX, 'theek hai Monday 11 book kar do')).label, 'accept_slot')
    assert.equal((await clf.classify(CTX, 'kitna price hai')).label, 'how_much')
  })

  it('ranks dnc above a co-occurring acknowledgement', async () => {
    const clf = new MockIntentClassifier()
    const intent = await clf.classify(CTX, 'yes but please stop calling me')
    assert.equal(intent.label, 'dnc')
  })

  it('falls back to unclear with low confidence rather than guessing', async () => {
    const clf = new MockIntentClassifier()
    const intent = await clf.classify(CTX, 'sorry the line broke up')

    assert.equal(intent.label, 'unclear')
    assert.ok(intent.confidence < 0.5)
  })

  it('a filler noise still reads as acknowledgement, as in the original rules', async () => {
    const clf = new MockIntentClassifier()
    assert.equal((await clf.classify(CTX, 'mmm hmm')).label, 'acknowledge')
  })

  it('applies the configured artificial latency', async () => {
    const { sleep, calls } = recordingSleep()
    const clf = new MockIntentClassifier({ latencyMs: 140, sleep })
    await clf.classify(CTX, 'yes')

    assert.deepEqual(calls, [140])
  })

  it('records classifications with the state they were made in', async () => {
    const clf = new MockIntentClassifier()
    await clf.classify({ ...CTX, state: 'CLOSE' }, 'call me back later')

    assert.equal(clf.classified[0]?.state, 'CLOSE')
    assert.equal(clf.classified[0]?.intent.label, 'call_later')
  })

  it('FixedIntentClassifier drives an FSM down one branch', async () => {
    const clf = new FixedIntentClassifier('dnc')
    assert.equal((await clf.classify()).label, 'dnc')
  })
})
