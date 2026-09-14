/**
 * Drives whole calls through the mock providers.
 *
 * Timing runs on a VIRTUAL clock: the mocks' injectable `sleep` advances a counter and
 * resolves immediately, and the session reads the same counter. Every latency assertion below
 * is therefore an exact number rather than a tolerance, and the suite costs no wall-clock
 * time. A test that slept for its own fixtures would be slow enough that someone eventually
 * deletes it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { Fsm, InMemoryTurnSink, parseFlow, TURN_BUDGET_P95_MS, totalMs } from '@voice-agent/shared'
import {
  MockIntentClassifier,
  MockSTTProvider,
  MockTTSProvider,
  type MockSTTStream,
} from '@voice-agent/shared/mocks'

import { BufferingAudioSink } from './audio.js'
import { CallSession, createCallSession } from './session.js'

/** dist/ -> apps/call-worker -> repo root */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FLOW = parseFlow(readFileSync(join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml'), 'utf8'))

const VOICE = { id: 'mock-voice', lang: 'en-IN' } as const

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

/** Stage latencies, chosen to sit inside the §6 budget so a healthy call is the baseline. */
const STAGE = {
  partial: 120,
  endpoint: 220,
  stt: 150,
  intent: 140,
  ttsFirstByte: 200,
  egress: 60,
} as const

function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
  }
}

interface Rig {
  session: CallSession
  stream: MockSTTStream
  sink: BufferingAudioSink
  turns: InMemoryTurnSink
  tts: MockTTSProvider
  say: () => Promise<void>
}

function rig(transcripts: readonly string[], opts: { sinkFactory?: (clock: ReturnType<typeof virtualClock>) => BufferingAudioSink } = {}): Rig {
  const clock = virtualClock()

  const stt = new MockSTTProvider({
    transcripts,
    partialIntervalMs: STAGE.partial,
    endpointMs: STAGE.endpoint,
    finalMs: STAGE.stt,
    sleep: clock.sleep,
  })
  const tts = new MockTTSProvider({
    firstByteMs: STAGE.ttsFirstByte,
    msPerChar: 20,
    chunkMs: 20,
    sleep: clock.sleep,
  })
  const intent = new MockIntentClassifier({ latencyMs: STAGE.intent, sleep: clock.sleep })
  const sink =
    opts.sinkFactory?.(clock) ??
    new BufferingAudioSink({ writeDelayMs: STAGE.egress, sleep: clock.sleep })
  const turns = new InMemoryTurnSink()

  const session = createCallSession(
    {
      callId: 'call-1',
      lang: 'en-IN',
      voice: VOICE,
      fsm: new Fsm({ flow: FLOW, lang: 'en-IN', vars: VARS }),
      now: clock.now,
    },
    { stt, tts, intent, sink, turns },
  )

  const stream = stt.streams[0] ?? (undefined as unknown as MockSTTStream)
  return {
    session,
    sink,
    turns,
    tts,
    get stream() {
      const s = stt.streams[0]
      assert.ok(s !== undefined, 'session.start() opens the stream')
      return s
    },
    say: async () => {
      const s = stt.streams[0]
      assert.ok(s !== undefined)
      await s.emitNext()
      await session.settle()
    },
  } as Rig & { stream: MockSTTStream }
}

describe('full call through the mocks', () => {
  it('books a meeting and records a turn row for every beat', async () => {
    const r = rig(['haan boliye', 'kitna price hai', 'theek hai Monday 11 book kar do'])

    await r.session.start()
    await r.say()
    await r.say()
    await r.say()
    await r.session.waitForEnd()

    const spokenText = r.turns.byRole('agent').map((t) => t.text)
    assert.match(spokenText[0] ?? '', /Hi Rahul/, 'opening')
    assert.match(spokenText[1] ?? '', /You run Acme Clinics/, 'context bridge')
    assert.match(spokenText[2] ?? '', /don't want to give you a random number/, 'price rebuttal')
    assert.match(spokenText[3] ?? '', /Monday 11 it is/, 'booked')

    // caller and agent rows interleave: agent(open), caller, agent, caller, agent, caller, agent
    assert.deepEqual(
      r.turns.rows.map((t) => t.role),
      ['agent', 'caller', 'agent', 'caller', 'agent', 'caller', 'agent'],
    )
    assert.deepEqual(
      r.turns.rows.map((t) => t.seq),
      [1, 2, 3, 4, 5, 6, 7],
      'seq is monotonic within the call — turns has UNIQUE (call_id, seq)',
    )
    assert.ok(r.sink.byteLength > 0, 'audio reached the sink')
  })

  it('records the complete per-stage latency breakdown on each agent row', async () => {
    const r = rig(['haan boliye'])

    await r.session.start()
    await r.say()

    // The reply to the caller's first utterance.
    const reply = r.turns.byRole('agent')[1]
    assert.ok(reply !== undefined)

    assert.deepEqual(
      reply.timings,
      {
        endpoint: STAGE.endpoint,
        stt: STAGE.stt,
        intent: STAGE.intent,
        fsm: 0,
        tts_first_byte: STAGE.ttsFirstByte,
        egress: STAGE.egress,
      },
      'every §6 stage is measured separately, not just the total',
    )

    assert.equal(totalMs(reply.timings), 770)
    assert.ok(totalMs(reply.timings) < TURN_BUDGET_P95_MS, 'a healthy turn is inside the budget')
  })

  it('the opening line has no caller-side stages, because nobody spoke first', async () => {
    const r = rig(['haan boliye'])
    await r.session.start()

    const opening = r.turns.byRole('agent')[0]
    assert.deepEqual(opening?.timings, {
      tts_first_byte: STAGE.ttsFirstByte,
      egress: STAGE.egress,
    })
  })

  it('caller rows carry the intent; agent rows carry the state moved to', async () => {
    const r = rig(['kitna price hai'])
    await r.session.start()
    await r.say()

    const caller = r.turns.byRole('caller')[0]
    assert.equal(caller?.intent, 'how_much')
    assert.equal(caller?.state, 'OPENING', 'the state the caller spoke in')
    assert.deepEqual(caller?.timings, {})

    const agent = r.turns.byRole('agent')[1]
    assert.equal(agent?.intent, null)
    assert.equal(agent?.state, 'CLOSE', 'the objection routine rebuts and moves to CLOSE')
  })

  it('a dnc request ends the call immediately, from any state', async () => {
    const r = rig(['please stop calling me'])

    await r.session.start()
    await r.say()
    await r.session.waitForEnd()

    const last = r.turns.byRole('agent').at(-1)
    assert.match(last?.text ?? '', /removing this number/i)
    assert.equal(r.session.currentPhase, 'ended')
  })

  it('pushing audio drives the loop without the test poking the stream', async () => {
    const r = rig(['haan boliye'])
    await r.session.start()

    // One second of silence is the mock's default utterance threshold.
    r.session.pushAudio(Buffer.alloc(16_000 * 2))
    await new Promise((resolve) => setImmediate(resolve))
    await r.session.settle()

    assert.equal(r.turns.byRole('caller')[0]?.text, 'haan boliye')
  })
})

describe('barge-in', () => {
  /** Fires barge-in from inside the egress path, the way a VAD would mid-playback. */
  class InterruptingSink extends BufferingAudioSink {
    session: CallSession | undefined

    constructor(
      private readonly afterChunks: number,
      opts: { writeDelayMs: number; sleep: (ms: number) => Promise<void> },
    ) {
      super(opts)
    }

    override async write(chunk: Buffer): Promise<void> {
      await super.write(chunk)
      if (this.chunks.length === this.afterChunks) this.session?.bargeIn()
    }
  }

  it('cancels TTS mid-utterance and stops writing audio', async () => {
    let sink!: InterruptingSink
    const r = rig(['haan boliye'], {
      sinkFactory: (clock) => {
        sink = new InterruptingSink(3, { writeDelayMs: STAGE.egress, sleep: clock.sleep })
        return sink
      },
    })
    sink.session = r.session

    await r.session.start()

    assert.equal(sink.chunks.length, 3, 'stops at the interruption, not at the end of the line')
    assert.equal(r.tts.cancelCount, 1, 'the provider was cancelled')
    assert.equal(r.tts.synthesized[0]?.cancelled, true)
    assert.ok(sink.flushes > 0, 'queued audio is dropped, or the bot talks over the caller')
  })

  it('marks the interrupted line on its turn row', async () => {
    let sink!: InterruptingSink
    const r = rig(['haan boliye'], {
      sinkFactory: (clock) => {
        sink = new InterruptingSink(2, { writeDelayMs: STAGE.egress, sleep: clock.sleep })
        return sink
      },
    })
    sink.session = r.session

    await r.session.start()

    const opening = r.turns.byRole('agent')[0]
    assert.equal(opening?.bargedIn, true, 'which lines get talked over is the point of the column')
    assert.ok((opening?.timings.tts_first_byte ?? 0) > 0, 'it did start speaking before the cut')
  })

  it('the interrupted utterance still drives the FSM — interrupting is not an error', async () => {
    let sink!: InterruptingSink
    const r = rig(['haan boliye', 'kitna price hai'], {
      sinkFactory: (clock) => {
        sink = new InterruptingSink(2, { writeDelayMs: STAGE.egress, sleep: clock.sleep })
        return sink
      },
    })
    sink.session = r.session

    await r.session.start()
    await r.say()

    assert.equal(r.turns.byRole('caller')[0]?.text, 'haan boliye')
    assert.equal(r.turns.byRole('agent')[1]?.state, 'CONTEXT_BRIDGE', 'the flow advanced normally')
  })

  it('a caller partial while the bot is speaking triggers barge-in on its own', async () => {
    const clock = virtualClock()
    const stt = new MockSTTProvider({
      // Multi-word, so the recogniser emits partials — a one-word utterance has none, and
      // partials are what the barge-in trigger listens to.
      transcripts: ['first utterance here', 'interrupting now'],
      partialIntervalMs: STAGE.partial,
      endpointMs: STAGE.endpoint,
      finalMs: STAGE.stt,
      sleep: clock.sleep,
    })
    const tts = new MockTTSProvider({
      firstByteMs: STAGE.ttsFirstByte,
      // A long line, so there is plenty of audio left to interrupt.
      msPerChar: 200,
      chunkMs: 20,
      sleep: clock.sleep,
    })

    class PartialTriggeringSink extends BufferingAudioSink {
      stream: MockSTTStream | undefined
      override async write(chunk: Buffer): Promise<void> {
        await super.write(chunk)
        // The caller starts talking; the recogniser emits a partial, and nothing else in the
        // test touches the session.
        if (this.chunks.length === 2) void this.stream?.emitNext()
      }
    }

    const sink = new PartialTriggeringSink()
    const turns = new InMemoryTurnSink()
    const session = createCallSession(
      {
        callId: 'call-barge',
        lang: 'en-IN',
        voice: VOICE,
        fsm: new Fsm({ flow: FLOW, lang: 'en-IN', vars: VARS }),
        now: clock.now,
      },
      { stt, tts, intent: new MockIntentClassifier({ sleep: clock.sleep }), sink, turns },
    )

    await session.start()
    sink.stream = stt.streams[0]
    assert.ok(sink.stream !== undefined)

    const openingChunks = sink.chunks.length
    sink.clear()

    // Speak again; the caller talks over it.
    await session.notifySilence()

    assert.ok(sink.chunks.length < openingChunks, 'the second line was cut short by a partial')
    assert.ok(tts.cancelCount > 0, 'the partial reached bargeIn() through the session wiring')
  })
})
