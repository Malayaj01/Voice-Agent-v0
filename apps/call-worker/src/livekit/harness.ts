/**
 * Browser test harness — talk to the bot without a carrier.
 *
 *   node dist/livekit/harness.js     then open http://localhost:8090
 *
 * A browser tab joins a LiveKit room and publishes its microphone; the agent joins the same
 * room and runs the turn loop. LiveKit does not distinguish that from a SIP leg, so the path
 * under test is the real one.
 *
 * THE INVARIANT: nothing here is browser-aware. This module mints a token, serves a static
 * page, and calls runCall() with a JoiningCallerSource. runCall, CallSession, the FSM, the
 * providers and the turns rows are byte-identical to what a phone call will exercise. When
 * the trunk arrives, dial.ts constructs a SipCallerSource instead and this file simply stops
 * being the way in.
 *
 * It is a test harness: single-tenant, no auth, bound to localhost. It is not a product
 * surface and must not become one.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AccessToken } from 'livekit-server-sdk'

import {
  Fsm,
  InMemoryTurnSink,
  breachedStages,
  optionalEnv,
  parseFlow,
  totalMs,
  type Flow,
  type Lang,
  type TurnSink,
  type TurnWrite,
  type Voice,
} from '@voice-agent/shared'
import { MockIntentClassifier } from '@voice-agent/shared/mocks'

import { FasterWhisperSTTProvider } from '../faster-whisper-stt.js'
import { envToTtsRuntimeEnv, startTtsRuntime } from '../tts-runtime.js'
import { runCall, type LiveKitConfig } from './call.js'
import { JoiningCallerSource } from './caller-source.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PUBLIC_DIR = join(HERE, '..', '..', 'public')
/** Served from node_modules so the page needs no CDN and works offline. */
const CLIENT_SDK = join(
  REPO_ROOT,
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.umd.js',
)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

/** Records turns in memory as well as forwarding them, so the page can show the breakdown. */
class TeeTurnSink implements TurnSink {
  readonly rows: TurnWrite[] = []

  constructor(private readonly inner: TurnSink) {}

  async record(turn: TurnWrite): Promise<void> {
    this.rows.push({ ...turn, timings: { ...turn.timings } })
    await this.inner.record(turn)
  }
}

interface ActiveCall {
  callId: string
  roomName: string
  sink: TeeTurnSink
  startedAt: number
  done: boolean
}

const calls = new Map<string, ActiveCall>()

async function browserToken(cfg: LiveKitConfig, room: string, identity: string): Promise<string> {
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '1h' })
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })
  return token.toJwt()
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Per-stage summary of one call, in the shape the page renders. */
function summarise(rows: readonly TurnWrite[]): {
  turns: Array<{ seq: number; role: string; text: string; timings: Record<string, number> }>
  agentTurns: number
  breaches: string[]
} {
  const breaches = new Set<string>()
  for (const row of rows) {
    if (row.role !== 'agent') continue
    for (const stage of breachedStages(row.timings)) breaches.add(stage)
  }
  return {
    turns: rows.map((r) => ({
      seq: r.seq,
      role: r.role,
      text: r.text,
      timings: { ...r.timings, total: totalMs(r.timings) } as Record<string, number>,
    })),
    agentTurns: rows.filter((r) => r.role === 'agent').length,
    breaches: [...breaches],
  }
}

export interface HarnessOptions {
  port: number
  livekit: LiveKitConfig
  flow: Flow
  lang: Lang
  voice: Voice
  vars: Record<string, string>
  turnSinkFor: (callId: string) => TurnSink
  stt: FasterWhisperSTTProvider
  tts: Parameters<typeof runCall>[1]['tts']
  log?: (line: string) => void
}

export function startHarness(opts: HarnessOptions): Promise<{ close: () => Promise<void> }> {
  const log = opts.log ?? ((line: string) => console.log(line))

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      json(res, 500, { error: String(err) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const callId = randomUUID()
      const roomName = `harness-${callId.slice(0, 8)}`
      const identity = `caller-${callId}`

      const sink = new TeeTurnSink(opts.turnSinkFor(callId))
      const active: ActiveCall = { callId, roomName, sink, startedAt: Date.now(), done: false }
      calls.set(callId, active)

      // The agent joins and waits. The browser connects with the token below and becomes the
      // caller — exactly what a SIP participant would be.
      void runCall(
        {
          callId,
          roomName,
          caller: new JoiningCallerSource(identity),
          lang: opts.lang,
          voice: opts.voice,
          fsm: new Fsm({ flow: opts.flow, lang: opts.lang, vars: opts.vars }),
          audioTimeoutMs: 60_000,
        },
        {
          livekit: opts.livekit,
          stt: opts.stt,
          tts: opts.tts,
          intent: new MockIntentClassifier(),
          turns: sink,
          log,
        },
      )
        .catch((err: unknown) => log(`[harness] call failed: ${String(err)}`))
        .finally(() => {
          active.done = true
        })

      json(res, 200, {
        callId,
        roomName,
        identity,
        url: opts.livekit.url,
        token: await browserToken(opts.livekit, roomName, identity),
      })
      return
    }

    if (url.pathname.startsWith('/api/calls/')) {
      const callId = url.pathname.slice('/api/calls/'.length)
      const active = calls.get(callId)
      if (active === undefined) {
        json(res, 404, { error: 'unknown call' })
        return
      }
      json(res, 200, { callId, done: active.done, ...summarise(active.sink.rows) })
      return
    }

    if (url.pathname === '/livekit-client.umd.js') {
      await serveFile(res, CLIENT_SDK)
      return
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
    // The harness serves two files. Anything else is a mistake, not a path to resolve.
    if (file !== 'index.html') {
      json(res, 404, { error: 'not found' })
      return
    }
    await serveFile(res, join(PUBLIC_DIR, 'index.html'))
  }

  async function serveFile(res: ServerResponse, path: string): Promise<void> {
    try {
      await stat(path)
    } catch {
      json(res, 404, { error: `missing ${path}` })
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    createReadStream(path).pipe(res)
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      log(`[harness] http://localhost:${opts.port}`)
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

async function main(): Promise<void> {
  const flowPath = optionalEnv('FLOW_FILE', join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml'))
  const flow = parseFlow(await readFile(flowPath, 'utf8'))
  const lang = optionalEnv('HARNESS_LANG', 'en-IN') as Lang

  const tts = await startTtsRuntime(envToTtsRuntimeEnv(), flow)
  const stt = new FasterWhisperSTTProvider({
    model: optionalEnv('STT_MODEL', 'distil-small.en'),
    partialIntervalMs: 600,
  })
  await stt.warmup()

  const databaseUrl = optionalEnv('DATABASE_URL', '')
  let turnSink: TurnSink = new InMemoryTurnSink()
  if (databaseUrl !== '') {
    const { default: pg } = await import('pg')
    const { PgTurnSink } = await import('../pg-turn-sink.js')
    turnSink = new PgTurnSink(new pg.Pool({ connectionString: databaseUrl }))
    console.log('[harness] turns -> postgres')
  } else {
    console.log('[harness] turns -> memory (set DATABASE_URL to persist)')
  }

  const vars = {
    contact_first_name: optionalEnv('HARNESS_NAME', 'Rahul'),
    company: 'Lipi',
    company_name: 'Acme Clinics',
    industry: 'healthcare',
    slot_pair: 'Monday 11 or Tuesday 3',
    slot_first: 'Monday 11',
    slot_booked: 'Monday 11',
    anchor_question: 'Got a minute?',
  }

  await startHarness({
    port: Number(optionalEnv('HARNESS_PORT', '8090')),
    livekit: {
      url: optionalEnv('LIVEKIT_URL', 'ws://127.0.0.1:7880'),
      apiKey: optionalEnv('LIVEKIT_API_KEY', 'devkey'),
      apiSecret: optionalEnv('LIVEKIT_API_SECRET', 'devsecret_local_only_not_for_any_deployment'),
    },
    flow,
    lang,
    voice: tts.voice,
    vars,
    // Writes to Postgres when DATABASE_URL is set, so the §6 timings land in `turns` exactly
    // as they will on a real call. Falls back to memory so the harness runs without a
    // database, but then the turns rows exist only for the page.
    turnSinkFor: () => turnSink,
    stt,
    tts: tts.tts,
  })
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('harness.js')) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
