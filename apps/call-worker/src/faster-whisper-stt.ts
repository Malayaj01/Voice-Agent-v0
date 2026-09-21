/**
 * faster-whisper behind STTProvider — the free tier of the §5 stack (MIT).
 *
 * Two facts shape this adapter:
 *
 * 1. WHISPER DOES NOT STREAM. It transcribes a window, not a sample at a time. So "streaming
 *    partials" here means re-transcribing the speech buffer so far on an interval and
 *    emitting the result. Each partial supersedes the last. That is what every Whisper
 *    streaming implementation does; the honest cost is that partials get more expensive as
 *    the utterance grows, which is why partialIntervalMs is a knob and not a constant.
 *
 * 2. ENDPOINTING IS NOT WHISPER'S JOB. It is the VAD's, and the VAD runs in this process.
 *    `endpoint` is emitted SYNCHRONOUSLY from push(), before any IPC — see the note on
 *    ordering below. Transcription crosses a pipe to Python; the endpoint never does.
 *
 * Event ordering matches §6 and the mock: partials during speech, then `endpoint` the moment
 * the VAD concludes the caller stopped, then `final` once the transcript settles. Anything
 * measuring turn latency keys off `endpoint`, so emitting it after the final transcript —
 * the tempting simplification, since Whisper gives you text and silence at the same moment —
 * would fold seconds of ASR into a stage budgeted at 300ms and make the numbers a fiction.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  EnergyVad,
  durationMs,
  type Lang,
  type STTEvents,
  type STTOpts,
  type STTProvider,
  type STTStream,
  type VadConfig,
} from '@voice-agent/shared'

interface SidecarResponse {
  id: number
  ok: boolean
  event?: string
  text?: string
  ms?: number
  model?: string
  error?: string
}

export interface FasterWhisperOptions {
  /** Whisper model. §5's pick is distil-small.en; multilingual needs `small` for Hinglish. */
  model?: string
  device?: string
  computeType?: string
  pythonBin?: string
  /** Path to stt_worker.py. Defaults to the copy beside this package. */
  scriptPath?: string
  /** How often to re-transcribe the buffer while the caller is still speaking. */
  partialIntervalMs?: number
  /** Emitting partials costs a transcription each; off is a valid production choice. */
  emitPartials?: boolean
  vad?: Omit<VadConfig, 'sampleRate'>
}

/**
 * What the stream needs from its provider.
 *
 * Extracted so the stream's event ordering — the part that decides whether §6 measurements
 * mean anything — can be tested without spawning Python or downloading a model. The ordering
 * is the contract; which ASR produces the text is not.
 */
export interface SttHost {
  readonly opts: { emitPartials: boolean; partialIntervalMs: number; vad: Omit<VadConfig, 'sampleRate'> }
  transcribe(pcm: Buffer, rate: number, lang: Lang, partial: boolean): Promise<{ text: string; ms: number }>
}

/** Owns the Python process. One per worker, shared by every concurrent call. */
export class FasterWhisperSTTProvider implements STTProvider, SttHost {
  readonly name = 'faster-whisper'

  private child: ChildProcessWithoutNullStreams | undefined
  private lines: Interface | undefined
  private ready: Promise<void> | undefined
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (r: SidecarResponse) => void; reject: (e: Error) => void }
  >()

  readonly opts: Required<Omit<FasterWhisperOptions, 'vad' | 'scriptPath'>> & {
    scriptPath: string
    vad: Omit<VadConfig, 'sampleRate'>
  }

  constructor(opts: FasterWhisperOptions = {}) {
    this.opts = {
      model: opts.model ?? 'distil-small.en',
      device: opts.device ?? 'cpu',
      computeType: opts.computeType ?? 'int8',
      pythonBin: opts.pythonBin ?? process.env['PYTHON_BIN'] ?? 'python',
      scriptPath: opts.scriptPath ?? defaultScriptPath(),
      partialIntervalMs: opts.partialIntervalMs ?? 600,
      emitPartials: opts.emitPartials ?? true,
      vad: opts.vad ?? {},
    }
  }

  /** Starts Python and loads the model. Call at boot — a first call must not pay for it. */
  warmup(): Promise<void> {
    this.ready ??= this.start()
    return this.ready
  }

  private async start(): Promise<void> {
    const child = spawn(this.opts.pythonBin, ['-u', this.opts.scriptPath], {
      env: {
        ...process.env,
        STT_MODEL: this.opts.model,
        STT_DEVICE: this.opts.device,
        STT_COMPUTE_TYPE: this.opts.computeType,
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    // Kept so an exit can explain itself. Without this, a sidecar that dies before writing a
    // line fails as a bare exit code and the actual cause never reaches anyone.
    const stderrTail: string[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text.length === 0) return
      stderrTail.push(text)
      if (stderrTail.length > 10) stderrTail.shift()
      // faster-whisper logs model download progress here; only surface real trouble live.
      if (/error|traceback/i.test(text)) console.error(`[stt] ${text}`)
    })

    child.on('exit', (code) => {
      const detail = stderrTail.length > 0 ? `: ${stderrTail.join(' | ')}` : ''
      for (const { reject } of this.pending.values()) {
        reject(new Error(`stt sidecar exited with code ${String(code)}${detail}`))
      }
      this.pending.clear()
      this.child = undefined
    })

    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line: string) => {
      let msg: SidecarResponse
      try {
        msg = JSON.parse(line) as SidecarResponse
      } catch {
        return
      }
      const waiter = this.pending.get(msg.id)
      if (waiter === undefined) return
      this.pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg)
      else waiter.reject(new Error(msg.error ?? 'stt sidecar error'))
    })

    await this.request({ op: 'load' })
  }

  private request(payload: Record<string, unknown>): Promise<SidecarResponse> {
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('stt sidecar is not running'))

    const id = this.nextId++
    return new Promise<SidecarResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (err) => {
        if (err != null) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  async transcribe(
    pcm: Buffer,
    rate: number,
    lang: Lang,
    partial: boolean,
  ): Promise<{ text: string; ms: number }> {
    await this.warmup()
    const res = await this.request({
      op: 'transcribe',
      pcm: pcm.toString('base64'),
      rate,
      lang: whisperLang(lang),
      partial,
    })
    return { text: res.text ?? '', ms: res.ms ?? 0 }
  }

  open(lang: Lang, opts: STTOpts): FasterWhisperSTTStream {
    return new FasterWhisperSTTStream(this, lang, opts)
  }

  async close(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.ready = undefined

    // `shutdown` deliberately has no reply — the sidecar exits on it. So write it and wait
    // for the exit rather than awaiting a response that can never arrive: doing the latter
    // lands in the exit handler's rejection path and then dereferences a child this method
    // has already cleared.
    try {
      child.stdin.write(`${JSON.stringify({ op: 'shutdown', id: 0 })}\n`)
    } catch {
      // Already gone; the wait below settles immediately.
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.lines?.close()
  }
}

/** Whisper takes ISO-639-1. Hinglish is transcribed as Hindi; code-switching is §10's problem. */
function whisperLang(lang: Lang): string {
  return lang.startsWith('hi') ? 'hi' : 'en'
}

function defaultScriptPath(): string {
  // dist/ -> apps/call-worker/python/stt_worker.py
  //
  // fileURLToPath, not URL.pathname: pathname keeps percent-encoding, so any space in the
  // checkout path arrives as %20 and Python exits 2 without a usable message.
  return fileURLToPath(new URL('../python/stt_worker.py', import.meta.url))
}

export class FasterWhisperSTTStream implements STTStream {
  private readonly vad: EnergyVad
  private readonly listeners: { [E in keyof STTEvents]: STTEvents[E][] } = {
    speech_start: [],
    partial: [],
    final: [],
    endpoint: [],
  }

  private speech: Buffer[] = []
  private speechBytes = 0
  private lastPartialAtMs = 0
  private partialInFlight = false
  private closed = false

  /**
   * Audio position of the last frame the VAD counted as speech.
   *
   * Exposed so the turn loop can measure `t_endpoint_ms` from when the caller actually
   * stopped, rather than from the last partial transcript. The mock could only offer the
   * proxy; a real VAD knows, and §6 budgets this stage tightly enough that the difference
   * matters.
   */
  lastSpeechEndedAtMs = 0
  /** Audio position at which the endpoint was declared. */
  endpointDetectedAtMs = 0

  constructor(
    private readonly provider: SttHost,
    readonly lang: Lang,
    readonly opts: STTOpts,
  ) {
    this.vad = new EnergyVad({ sampleRate: opts.sampleRate, ...provider.opts.vad })
  }

  get vadConfig(): EnergyVad['config'] {
    return this.vad.config
  }

  on<E extends keyof STTEvents>(event: E, cb: STTEvents[E]): void {
    this.listeners[event].push(cb)
  }

  close(): void {
    this.closed = true
  }

  push(pcm: Buffer): void {
    if (this.closed) return

    const events = this.vad.push(pcm)
    if (this.vad.isSpeaking || events.length > 0) {
      this.speech.push(pcm)
      this.speechBytes += pcm.byteLength
    }

    for (const event of events) {
      if (event.type === 'speech_start') {
        this.lastPartialAtMs = event.atMs
        // Straight from the VAD, synchronously, before any transcription. This is what
        // barge-in listens to: waiting for a partial costs the partial interval plus an ASR
        // round trip, which is about a second too late.
        this.emit('speech_start', '')
        continue
      }

      // ORDER MATTERS. `endpoint` fires here, synchronously, before any transcription is
      // requested — it is the start of the turn clock, and the ASR round trip that follows is
      // t_stt_ms, a different stage with a different budget.
      this.lastSpeechEndedAtMs = event.speechEndedAtMs
      this.endpointDetectedAtMs = event.atMs
      this.emit('endpoint', '')

      void this.finalise()
    }

    if (this.provider.opts.emitPartials) void this.maybePartial()
  }

  /** Feeds silence to flush the VAD's hangover — for tests and end-of-call draining. */
  flushSilence(ms = 0): void {
    const bytes = Math.round((this.opts.sampleRate * ms) / 1000) * 2
    if (bytes > 0) this.push(Buffer.alloc(bytes))
  }

  private async maybePartial(): Promise<void> {
    if (this.partialInFlight || !this.vad.isSpeaking || this.closed) return
    if (this.vad.positionMs - this.lastPartialAtMs < this.provider.opts.partialIntervalMs) return

    this.partialInFlight = true
    this.lastPartialAtMs = this.vad.positionMs
    const audio = Buffer.concat(this.speech)
    try {
      const { text } = await this.provider.transcribe(audio, this.opts.sampleRate, this.lang, true)
      // A partial that lands after the endpoint is stale: `final` already superseded it, and
      // emitting it would walk the transcript backwards.
      if (!this.closed && this.vad.isSpeaking && text.length > 0) this.emit('partial', text)
    } catch {
      // A failed partial is not worth surfacing — the final transcript is what the FSM uses.
    } finally {
      this.partialInFlight = false
    }
  }

  private async finalise(): Promise<void> {
    const audio = Buffer.concat(this.speech)
    this.speech = []
    this.speechBytes = 0
    if (audio.byteLength === 0) {
      this.emit('final', '')
      return
    }

    try {
      const { text } = await this.provider.transcribe(audio, this.opts.sampleRate, this.lang, false)
      if (!this.closed) this.emit('final', text)
    } catch (err: unknown) {
      console.error(`[stt] final transcription failed: ${String(err)}`)
      if (!this.closed) this.emit('final', '')
    }
  }

  get bufferedMs(): number {
    return durationMs(Buffer.concat(this.speech), this.opts.sampleRate)
  }

  private emit<E extends keyof STTEvents>(event: E, text: string): void {
    for (const cb of this.listeners[event]) cb(text)
  }
}
