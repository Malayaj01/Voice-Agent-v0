/**
 * The turn loop — ARCHITECTURE.md §3.3, §6.
 *
 *   caller audio -> VAD/endpoint -> STT -> intent -> FSM -> TTS -> audio out
 *
 * All of it in one process. The rule from §3 is that no service boundary goes inside this
 * loop; the only awaits below are vendor calls and the audio sink.
 *
 * ---------------------------------------------------------------------------------------
 * Barge-in
 * ---------------------------------------------------------------------------------------
 * Four things have to hold, and three of them are easy to get wrong:
 *
 * 1. Cancellation cannot wait on the provider. `tts.cancel()` stops the producer, but a
 *    consumer parked in `await iterator.next()` learns nothing until the next chunk arrives
 *    — over a real network that is unbounded. So the pump races `iterator.next()` against an
 *    abort promise and abandons the stream the moment barge-in wins. That is the difference
 *    between a barge-in latency we control and one the vendor controls.
 *
 * 2. Generator cleanup is fired, not awaited, for the same reason. Awaiting
 *    `iterator.return()` would hand the timing back to the provider we just walked away from.
 *
 * 3. The trigger is the first `partial`, not `final`. Waiting for a settled transcript is
 *    several hundred ms too late — the bot would still be talking over the caller.
 *
 * 4. Audio already handed to the transport keeps playing, so the sink is flushed too.
 *
 * The interrupted utterance is NOT discarded: it becomes the next caller turn and drives the
 * FSM normally. Interrupting is how a caller says "stop talking and listen", not a fault.
 *
 * Not solved here: acoustic echo. On a real call the bot's own audio reaches the STT and
 * self-triggers barge-in on every line. That needs echo cancellation at the media layer;
 * `holdOffMs` below is a crude floor, not a substitute.
 *
 * ---------------------------------------------------------------------------------------
 * Endpointing
 * ---------------------------------------------------------------------------------------
 * `endpoint` fires when the caller STOPS speaking and is what starts the turn clock (§6);
 * `final` settles afterwards. `t_endpoint_ms` is measured from the last partial, which is a
 * proxy for the last speech activity the recogniser saw — see the note at the measurement.
 */

import { performance } from 'node:perf_hooks'

import type {
  Fsm,
  IntentClassifier,
  Lang,
  STTProvider,
  STTStream,
  TTSProvider,
  TurnSink,
  TurnTimings,
  Voice,
} from '@voice-agent/shared'

import type { AudioSink } from './audio.js'

const ABORT = Symbol('barge-in')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export interface CallSessionInit {
  callId: string
  lang: Lang
  voice: Voice
  fsm: Fsm
  /** Ignore barge-in for this long after a line starts. A floor against echo, not a fix. */
  holdOffMs?: number
  /** Monotonic clock in ms. Injectable so tests can run on virtual time. */
  now?: () => number
}

export interface CallSessionDeps {
  stt: STTProvider
  tts: TTSProvider
  intent: IntentClassifier
  sink: AudioSink
  turns: TurnSink
}


export interface SpokenTurn {
  seq: number
  text: string
  state: string
  bargedIn: boolean
  bytes: number
  timings: TurnTimings
}

type Phase = 'idle' | 'listening' | 'resolving' | 'speaking' | 'ended'

export class CallSession {
  readonly callId: string
  readonly lang: Lang

  private readonly voice: Voice
  private readonly fsm: Fsm
  private readonly deps: CallSessionDeps
  private readonly holdOffMs: number
  private readonly now: () => number

  private stream: STTStream | undefined
  private phase: Phase = 'idle'
  private seq = 0

  /** Timing anchors for the turn in flight. */
  private lastPartialAt: number | undefined
  private endpointAt: number | undefined

  private speakStartedAt = 0
  private abort: Deferred<typeof ABORT> | undefined
  private barged = false
  /** Barge-in that arrived while resolving, before there was audio to cancel. */
  private pendingBargeIn = false

  /** Serialises utterances so two cannot interleave their turns. */
  private work: Promise<void> = Promise.resolve()
  private readonly finished = deferred<void>()

  /** Every agent turn, in order. Mirrors what was written to the turns sink. */
  readonly spoken: SpokenTurn[] = []

  constructor(init: CallSessionInit, deps: CallSessionDeps) {
    this.callId = init.callId
    this.lang = init.lang
    this.voice = init.voice
    this.fsm = init.fsm
    this.holdOffMs = init.holdOffMs ?? 0
    this.now = init.now ?? (() => performance.now())
    this.deps = deps
  }

  get currentPhase(): Phase {
    return this.phase
  }

  /** Opens the recogniser and speaks the opening line. */
  async start(): Promise<void> {
    const stream = this.deps.stt.open(this.lang, { sampleRate: 16_000 })
    this.stream = stream

    stream.on('partial', () => {
      this.lastPartialAt = this.now()
      this.maybeBargeIn()
    })
    stream.on('endpoint', () => {
      this.endpointAt = this.now()
      if (this.phase === 'listening') this.phase = 'resolving'
    })
    stream.on('final', (text) => {
      this.enqueue(() => this.handleUtterance(text))
    })

    const opening = this.fsm.start()
    this.phase = 'speaking'
    if (opening.line !== null) {
      await this.emit(opening.line.text, opening.nextState, { fsmDoneAt: this.now() })
    }
    this.phase = 'listening'
  }

  /** Caller audio in. */
  pushAudio(pcm: Buffer): void {
    this.stream?.push(pcm)
  }

  /**
   * Interrupt the current line. Called from the VAD layer, or internally on the first
   * partial of caller speech.
   */
  bargeIn(): void {
    if (this.phase === 'speaking') {
      this.barged = true
      this.deps.tts.cancel()
      this.abort?.resolve(ABORT)
      void this.deps.sink.flush()
      return
    }
    if (this.phase === 'resolving') {
      // Nothing is playing yet. Suppress the line we are about to produce instead.
      this.pendingBargeIn = true
    }
  }

  /** The caller said nothing. Nudges, then hangs up. */
  notifySilence(): Promise<void> {
    return this.enqueue(async () => {
      const decision = this.fsm.onSilence()
      if (decision.line !== null) {
        this.phase = 'speaking'
        await this.emit(decision.line.text, decision.nextState, { fsmDoneAt: this.now() })
        this.phase = 'listening'
      }
      if (decision.ended) this.end()
    })
  }

  /** Resolves once every utterance received so far has been fully handled. */
  async settle(): Promise<void> {
    await this.work
  }

  /** Resolves once the flow reaches a terminal state or close() is called. */
  waitForEnd(): Promise<void> {
    return this.finished.promise
  }

  async close(): Promise<void> {
    await this.work
    this.stream?.close()
    this.end()
  }

  private end(): void {
    if (this.phase === 'ended') return
    this.phase = 'ended'
    this.stream?.close()
    this.finished.resolve()
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.work = this.work.then(fn)
    return this.work
  }

  private maybeBargeIn(): void {
    if (this.phase !== 'speaking') return
    if (this.now() - this.speakStartedAt < this.holdOffMs) return
    this.bargeIn()
  }

  /** One exchange: transcript in, line out, both rows written. */
  private async handleUtterance(text: string): Promise<void> {
    if (this.phase === 'ended') return

    const finalAt = this.now()
    const timings: TurnTimings = {}

    // Endpoint detection delay. Measured from the last partial, which is the recogniser's
    // most recent evidence of speech. A real VAD reports the true speech-stop instant and an
    // adapter that has it should supply it directly rather than inheriting this proxy.
    if (this.endpointAt !== undefined && this.lastPartialAt !== undefined) {
      timings.endpoint = Math.max(0, this.endpointAt - this.lastPartialAt)
    }
    if (this.endpointAt !== undefined) {
      timings.stt = Math.max(0, finalAt - this.endpointAt)
    }

    const intent = await this.deps.intent.classify(
      { lang: this.lang, state: this.fsm.currentState, history: [] },
      text,
    )
    const intentDoneAt = this.now()
    timings.intent = intentDoneAt - finalAt

    const decision = this.fsm.advance(intent.label)
    const fsmDoneAt = this.now()
    timings.fsm = fsmDoneAt - intentDoneAt

    await this.deps.turns.record({
      callId: this.callId,
      seq: ++this.seq,
      role: 'caller',
      text,
      intent: intent.label,
      state: decision.fromState,
      timings: {},
      bargedIn: false,
    })

    if (decision.line !== null) {
      this.phase = 'speaking'
      await this.emit(decision.line.text, decision.nextState, { fsmDoneAt, timings })
    }

    this.endpointAt = undefined
    this.lastPartialAt = undefined

    if (decision.ended) this.end()
    else this.phase = 'listening'
  }

  /** Speaks a line and writes the agent row carrying the turn's complete breakdown. */
  private async emit(
    text: string,
    state: string,
    ctx: { fsmDoneAt: number; timings?: TurnTimings },
  ): Promise<void> {
    const timings: TurnTimings = { ...ctx.timings }
    const outcome = await this.pump(text, ctx.fsmDoneAt)

    if (outcome.firstByteMs !== undefined) timings.tts_first_byte = outcome.firstByteMs
    if (outcome.egressMs !== undefined) timings.egress = outcome.egressMs

    const turn: SpokenTurn = {
      seq: ++this.seq,
      text,
      state,
      bargedIn: outcome.bargedIn,
      bytes: outcome.bytes,
      timings,
    }
    this.spoken.push(turn)

    await this.deps.turns.record({
      callId: this.callId,
      seq: turn.seq,
      role: 'agent',
      text,
      intent: null,
      state,
      timings,
      bargedIn: outcome.bargedIn,
    })
  }

  /**
   * Streams one line to the sink, abandoning it the instant barge-in fires.
   *
   * The race is the whole point — see the header. Without it, cancellation latency is
   * whatever the TTS provider's next chunk boundary happens to be.
   */
  private async pump(
    text: string,
    fsmDoneAt: number,
  ): Promise<{
    bargedIn: boolean
    bytes: number
    firstByteMs: number | undefined
    egressMs: number | undefined
  }> {
    this.barged = false
    this.speakStartedAt = this.now()

    // Barge-in that arrived while we were still resolving: the line is due but the caller is
    // already talking, so it is never spoken.
    if (this.pendingBargeIn) {
      this.pendingBargeIn = false
      return { bargedIn: true, bytes: 0, firstByteMs: undefined, egressMs: undefined }
    }

    const iterator = this.deps.tts.synthesize(text, this.voice)[Symbol.asyncIterator]()
    const abort = deferred<typeof ABORT>()
    this.abort = abort

    let bytes = 0
    let firstByteMs: number | undefined
    let egressMs: number | undefined
    let bargedIn = false

    try {
      for (;;) {
        const step = await Promise.race([iterator.next(), abort.promise])
        if (step === ABORT || this.barged) {
          bargedIn = true
          break
        }
        if (step.done === true) break

        const arrivedAt = this.now()
        if (firstByteMs === undefined) firstByteMs = Math.max(0, arrivedAt - fsmDoneAt)

        await this.deps.sink.write(step.value)
        if (egressMs === undefined) egressMs = Math.max(0, this.now() - arrivedAt)
        bytes += step.value.byteLength
      }
    } finally {
      this.abort = undefined
      if (bargedIn) {
        // tts.cancel() and the sink flush already happened in bargeIn(), which runs the
        // instant the caller is detected rather than whenever this loop unwinds. Repeating
        // them here would double-count every interruption.
        //
        // Fired, not awaited: waiting on the provider's cleanup would hand the barge-in
        // latency straight back to the vendor we just walked away from.
        const ret = iterator.return?.(undefined)
        if (ret !== undefined) void ret.catch(() => undefined)
      }
    }

    return { bargedIn, bytes, firstByteMs, egressMs }
  }
}

export function createCallSession(init: CallSessionInit, deps: CallSessionDeps): CallSession {
  return new CallSession(init, deps)
}
