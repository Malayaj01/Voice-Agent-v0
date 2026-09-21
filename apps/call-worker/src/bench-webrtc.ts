#!/usr/bin/env node
/**
 * End-to-end verification over real WebRTC — ARCHITECTURE.md §4, §6.
 *
 *   node dist/bench-webrtc.js            (needs a LiveKit server at LIVEKIT_URL)
 *
 * A synthetic caller joins the room and publishes Kokoro-rendered speech; the agent joins the
 * same room and runs the turn loop. Nothing here is special-cased: the caller is a
 * participant, exactly as a browser tab or a SIP leg is, and the agent side is the same
 * runCall() the harness and dial.ts use.
 *
 * The caller LISTENS, rather than working to a script of timings. It subscribes to the agent's
 * track and measures its energy, so it speaks when the bot has finished — or deliberately
 * over the top of it, to test barge-in. Fixed sleeps would have measured the sleeps.
 *
 * Reported: per-stage p50/p95 against the §6 budget, and whether barge-in actually cut the
 * agent off over real media rather than in a unit test.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  dispose,
  type RemoteAudioTrack,
} from '@livekit/rtc-node'

import {
  Fsm,
  InMemoryTurnSink,
  MemoryAudioCache,
  CachingTTSProvider,
  STAGE_BUDGET_MS,
  TURN_BUDGET_P95_MS,
  optionalEnv,
  parseFlow,
  rmsDb,
  totalMs,
  type TurnSink,
  type TurnWrite,
} from '@voice-agent/shared'
import { MockIntentClassifier } from '@voice-agent/shared/mocks'

import { FasterWhisperSTTProvider } from './faster-whisper-stt.js'
import { KOKORO_SAMPLE_RATE, KokoroTTSProvider } from './kokoro-tts.js'
import { agentToken, runCall } from './livekit/call.js'
import { linesFromFlow } from './precache.js'
import { JoiningCallerSource } from './livekit/caller-source.js'
import { pcmToInt16 } from './livekit/media.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** What the synthetic caller says, in order. Chosen to walk the flow to a booking. */
const CALLER_SCRIPT = [
  'Yes, go ahead.',
  'How much does it cost?',
  'Okay, book Monday eleven.',
]

/** Said deliberately over the top of the agent, to prove barge-in cuts the line. */
const BARGE_IN_LINE = 'Wait, stop, I am not interested.'

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Tracks whether the agent is currently speaking, by listening to its track. */
class AgentVoiceMonitor {
  speaking = false
  lastVoiceAt = 0
  private stopped = false

  constructor(track: RemoteAudioTrack) {
    const stream = new AudioStream(track, 16_000)
    const reader = stream.getReader()
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done || this.stopped) break
          if (value === undefined) continue
          const pcm = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength)
          if (rmsDb(pcm) > -45) {
            this.speaking = true
            this.lastVoiceAt = Date.now()
          } else if (Date.now() - this.lastVoiceAt > 250) {
            this.speaking = false
          }
        }
      } finally {
        reader.releaseLock()
      }
    })()
  }

  stop(): void {
    this.stopped = true
  }

  /** Waits until the agent has been quiet for `quietMs`. */
  async waitUntilQuiet(quietMs = 400, timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.speaking && this.lastVoiceAt > 0 && Date.now() - this.lastVoiceAt > quietMs) {
        return true
      }
      await sleep(50)
    }
    return false
  }

  async waitUntilSpeaking(timeoutMs = 25_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.speaking) return true
      await sleep(25)
    }
    return false
  }
}

/** A participant that publishes rendered speech. The browser's stand-in. */
class SyntheticCaller {
  readonly room = new Room()
  private source: AudioSource | undefined
  monitor: AgentVoiceMonitor | undefined

  async join(url: string, token: string): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      this.room.on(RoomEvent.TrackSubscribed, (track: unknown) => {
        const audio = track as RemoteAudioTrack
        if (audio.kind !== TrackKind.KIND_AUDIO || this.monitor !== undefined) return
        this.monitor = new AgentVoiceMonitor(audio)
        resolve()
      })
    })

    await this.room.connect(url, token, { autoSubscribe: true, dynacast: false })
    this.source = new AudioSource(KOKORO_SAMPLE_RATE, 1)
    const track = LocalAudioTrack.createAudioTrack('caller-voice', this.source)
    const opts = new TrackPublishOptions()
    opts.source = TrackSource.SOURCE_MICROPHONE
    await this.room.localParticipant?.publishTrack(track, opts)

    await Promise.race([ready, sleep(20_000)])
  }

  /** Publishes PCM in 20ms frames, in real time — the media layer is not a fast path. */
  async say(pcm: Buffer): Promise<void> {
    const source = this.source
    if (source === undefined) throw new Error('caller not joined')
    const frameBytes = Math.round((KOKORO_SAMPLE_RATE * 20) / 1000) * 2

    for (let at = 0; at < pcm.byteLength; at += frameBytes) {
      const slice = pcm.subarray(at, Math.min(at + frameBytes, pcm.byteLength))
      const data = pcmToInt16(slice)
      await source.captureFrame(new AudioFrame(data, KOKORO_SAMPLE_RATE, 1, data.length))
    }
  }

  /** Trailing silence, so the agent's VAD sees the turn end. */
  async silence(ms: number): Promise<void> {
    await this.say(Buffer.alloc(Math.round((KOKORO_SAMPLE_RATE * ms) / 1000) * 2))
  }

  async leave(): Promise<void> {
    this.monitor?.stop()
    await this.source?.close().catch(() => undefined)
    await this.room.disconnect().catch(() => undefined)
  }
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
}

function reportStages(rows: readonly TurnWrite[]): void {
  const agent = rows.filter((r) => r.role === 'agent' && totalMs(r.timings) > 0)
  const stages = ['endpoint', 'stt', 'intent', 'fsm', 'tts_first_byte', 'egress'] as const

  process.stdout.write(`\nper-stage latency over real WebRTC (${agent.length} agent turns)\n\n`)
  process.stdout.write(`  stage             p50        p95        budget     verdict\n`)

  for (const stage of stages) {
    const values = agent
      .map((r) => r.timings[stage])
      .filter((v): v is number => v !== undefined)
    if (values.length === 0) continue

    const budget = STAGE_BUDGET_MS[stage]
    const p95 = pct(values, 95)
    process.stdout.write(
      `  ${stage.padEnd(17)} ${`${pct(values, 50).toFixed(0)}ms`.padEnd(10)} ` +
        `${`${p95.toFixed(0)}ms`.padEnd(10)} ${`${budget}ms`.padEnd(10)} ` +
        `${p95 <= budget ? 'within' : `${(p95 - budget).toFixed(0)}ms over`}\n`,
    )
  }

  const totals = agent.map((r) => totalMs(r.timings))
  process.stdout.write(
    `  ${'TOTAL'.padEnd(17)} ${`${pct(totals, 50).toFixed(0)}ms`.padEnd(10)} ` +
      `${`${pct(totals, 95).toFixed(0)}ms`.padEnd(10)} ${`${TURN_BUDGET_P95_MS}ms`.padEnd(10)} ` +
      `${pct(totals, 95) <= TURN_BUDGET_P95_MS ? 'within budget' : 'OVER BUDGET'}\n`,
  )
}

/** Mirrors rows to memory and to Postgres, so the report and the table see the same turns. */
class TeeSink implements TurnSink {
  constructor(
    private readonly a: TurnSink,
    private readonly b: TurnSink,
  ) {}

  async record(turn: TurnWrite): Promise<void> {
    await this.a.record(turn)
    await this.b.record(turn)
  }
}

/**
 * `turns.call_id` is a foreign key, so a real row has to exist before any turn can be
 * written. Creating the campaign, lead and call here is what makes the persistence path the
 * real one rather than an insert into an unconstrained table.
 */
async function ensureCallRow(pool: import('pg').Pool): Promise<string> {
  const script = await pool.query<{ id: string }>(
    `INSERT INTO script_versions (version, yaml, created_by, active)
     VALUES ($1, 'version: 1', 'bench', false) RETURNING id`,
    [Date.now() % 1_000_000],
  )
  const scriptId = script.rows[0]?.id
  const campaign = await pool.query<{ id: string }>(
    `INSERT INTO campaigns (name, script_version_id) VALUES ($1, $2) RETURNING id`,
    [`bench-${Date.now()}`, scriptId],
  )
  const campaignId = campaign.rows[0]?.id
  const lead = await pool.query<{ id: string }>(
    `INSERT INTO leads (campaign_id, name, phone_e164, language)
     VALUES ($1, 'Bench caller', '+9991000001', 'en-IN') RETURNING id`,
    [campaignId],
  )
  const call = await pool.query<{ id: string }>(
    `INSERT INTO calls (campaign_id, lead_id, script_version_id, connected)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [campaignId, lead.rows[0]?.id, scriptId],
  )
  const id = call.rows[0]?.id
  if (id === undefined) throw new Error('could not create a call row')
  return id
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'skip-barge-in': { type: 'boolean', default: false } },
  })

  const livekit = {
    url: optionalEnv('LIVEKIT_URL', 'ws://127.0.0.1:7880'),
    apiKey: optionalEnv('LIVEKIT_API_KEY', 'devkey'),
    apiSecret: optionalEnv('LIVEKIT_API_SECRET', 'devsecret_local_only_not_for_any_deployment'),
  }

  const flow = parseFlow(
    await readFile(optionalEnv('FLOW_FILE', join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml')), 'utf8'),
  )

  // The caller's voice. A second Kokoro instance so caller and agent audio are independent.
  const callerTts = new KokoroTTSProvider({ dtype: 'q8', device: 'cpu' })
  await callerTts.warmup()

  const renderLine = async (text: string): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of callerTts.synthesize(text, { id: 'am_michael', lang: 'en-IN' })) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  process.stdout.write('rendering caller utterances...\n')
  const script = await Promise.all(CALLER_SCRIPT.map(renderLine))
  const bargeInAudio = values['skip-barge-in'] === true ? Buffer.alloc(0) : await renderLine(BARGE_IN_LINE)

  // The agent's own stack, unchanged from what the harness and dial.ts construct.
  const agentTts = new CachingTTSProvider(
    new KokoroTTSProvider({ dtype: 'q8', device: 'cpu' }),
    new MemoryAudioCache(),
    { sampleRate: KOKORO_SAMPLE_RATE },
  )
  const stt = new FasterWhisperSTTProvider({ model: optionalEnv('STT_MODEL', 'tiny.en') })
  await stt.warmup()

  // Pre-warm exactly as the worker does at boot. Without it every line is a live Kokoro
  // synthesis at seconds per line, and the benchmark would be measuring a cold cache rather
  // than the system — §6's whole point is that scripted lines are rendered in advance.
  process.stdout.write('pre-warming the agent audio cache...\n')
  const warmVoice = { id: 'af_heart', lang: 'en-IN' as const }
  for (const line of linesFromFlow(flow, 'en-IN', VARS, warmVoice.id)) {
    for await (const _ of agentTts.synthesize(line.text, warmVoice)) {
      // Drained for its side effect: the caching provider stores the finished render.
    }
  }

  const callId = randomUUID()
  const roomName = `bench-${callId.slice(0, 8)}`
  const identity = `caller-${callId}`
  // Writes to the real turns table when a database is available, so the §6 breakdown is
  // verified where it will actually live rather than only in memory.
  const databaseUrl = optionalEnv('DATABASE_URL', '')
  const memory = new InMemoryTurnSink()
  let turns: TurnSink = memory
  let callRowId: string | undefined
  if (databaseUrl !== '') {
    const { default: pg } = await import('pg')
    const { PgTurnSink } = await import('./pg-turn-sink.js')
    const pool = new pg.Pool({ connectionString: databaseUrl })
    callRowId = await ensureCallRow(pool)
    turns = new TeeSink(memory, new PgTurnSink(pool))
    process.stdout.write(`turns -> postgres (call ${callRowId})
`)
  }

  process.stdout.write(`room ${roomName}\n`)

  const agentDone = runCall(
    {
      callId: callRowId ?? callId,
      roomName,
      caller: new JoiningCallerSource(identity),
      lang: 'en-IN',
      voice: { id: 'af_heart', lang: 'en-IN' },
      fsm: new Fsm({ flow, lang: 'en-IN', vars: VARS }),
      audioTimeoutMs: 45_000,
      // The synthetic caller is not acoustically coupled to the agent, so there is no echo to
      // guard against and barge-in can be tested without a hold-off masking it.
      holdOffMs: 0,
    },
    {
      livekit,
      stt,
      tts: agentTts,
      intent: new MockIntentClassifier(),
      turns,
      log: (line) => process.stdout.write(`${line}\n`),
    },
  )

  const caller = new SyntheticCaller()
  await caller.join(livekit.url, await agentToken(livekit, roomName, identity))
  process.stdout.write('[caller] joined and published\n')

  const monitor = caller.monitor
  if (monitor === undefined) {
    process.stderr.write('never received the agent audio track\n')
    return 1
  }

  let bargeInVerified = false

  for (const [i, utterance] of script.entries()) {
    // Wait for the agent to START replying before waiting for it to finish. "Quiet for 900ms"
    // alone is not turn-taking: after the previous line the monitor's last-voice timestamp is
    // already old, so the condition is trivially true and the caller talks straight over the
    // reply it just prompted. That produced three accidental barge-ins and contaminated the
    // deliberate one.
    //
    // 900ms rather than 500 for the quiet threshold, because our own TTS leaves in-line
    // pauses of up to ~540ms (measured in bench-endpoint) and a shorter one interrupts
    // mid-line. Real callers do exactly that; it just cannot be the baseline here.
    if (i > 0) await monitor.waitUntilSpeaking(20_000)
    const quiet = await monitor.waitUntilQuiet(900)
    if (!quiet) {
      process.stdout.write(`[caller] agent never went quiet before utterance ${i + 1}\n`)
      break
    }
    process.stdout.write(`[caller] "${CALLER_SCRIPT[i] ?? ''}"\n`)
    await caller.say(utterance)
    // Past the VAD hangover, so the turn actually ends.
    await caller.silence(700)
    await sleep(500)
  }

  if (bargeInAudio.byteLength > 0) {
    process.stdout.write('\n[caller] barge-in: waiting for the agent to start speaking\n')
    if (await monitor.waitUntilSpeaking(15_000)) {
      // Far enough in that audio is genuinely playing, early enough that plenty remains.
      await sleep(600)
      process.stdout.write(`[caller] talking over it: "${BARGE_IN_LINE}"\n`)
      await caller.say(bargeInAudio)
      await caller.silence(700)
      await sleep(1500)
      bargeInVerified = true
    } else {
      process.stdout.write('[caller] agent never spoke again; barge-in not exercised\n')
    }
  }

  await caller.leave()
  const finished = await agentDone.catch(() => undefined)
  await stt.close()

  // Bytes, not just the flag: a line marked CUT with a full byte count was interrupted at the
  // very end and barely matters, while one with zero bytes was never spoken at all. The two
  // are very different bugs and the flag alone cannot tell them apart.
  process.stdout.write('\naudio emitted per agent line\n')
  for (const t of finished?.session?.spoken ?? []) {
    process.stdout.write(
      `  seq ${String(t.seq).padStart(2)}  ${String(t.bytes).padStart(8)} bytes  ` +
        `${t.bargedIn ? 'CUT' : '   '}  ${t.text.slice(0, 44)}\n`,
    )
  }

  process.stdout.write('\ntranscript\n')
  for (const row of memory.rows) {
    process.stdout.write(
      `  ${String(row.seq).padStart(2)} ${row.role.padEnd(6)} ` +
        `${row.bargedIn ? '[CUT] ' : ''}${row.text}\n`,
    )
  }

  reportStages(memory.rows)

  const bargedRows = memory.rows.filter((r: TurnWrite) => r.bargedIn)
  process.stdout.write(
    `\nbarge-in: ${
      bargedRows.length > 0
        ? `${bargedRows.length} agent line(s) cut off mid-utterance over real WebRTC`
        : bargeInVerified
          ? 'exercised but no line was cut — INVESTIGATE'
          : 'not exercised'
    }\n`,
  )

  await dispose()
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exitCode = 1
  })
