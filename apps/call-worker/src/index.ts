/**
 * Call worker — ARCHITECTURE.md §3.3.
 *
 * The ONLY latency-critical process. N concurrent calls per worker; scale by N, not by
 * splitting the pipeline. Design target is 25 concurrent (2,000 calls/day is ~2.5 average).
 *
 * The turn-loop implementation lives in session.ts; flow loading and hot reload in flow.ts.
 */

import { createHealthServer, numberEnv, onShutdown, optionalEnv } from '@voice-agent/shared'

import { startFlowRuntime } from './flow.js'

const SERVICE = 'call-worker'
const VERSION = '0.1.0'

async function main(): Promise<void> {
  const port = numberEnv('CALL_WORKER_PORT', 8082)
  const maxConcurrent = numberEnv('MAX_CONCURRENT_CALLS', 25)

  const flow = await startFlowRuntime({
    flowFile: optionalEnv('FLOW_FILE', ''),
    databaseUrl: optionalEnv('DATABASE_URL', ''),
  })

  // TODO(phase-1): LiveKit Agents session wiring — replace the mock providers with a real
  // SIP-terminated media loop. createCallSession() is already the shape it plugs into.
  const health = await createHealthServer({
    service: SERVICE,
    version: VERSION,
    port,
    checks: { flow: flow.check },
  })
  console.log(`[${SERVICE}] listening on :${port} (max ${maxConcurrent} concurrent)`)

  onShutdown(async () => {
    flow.stop()
    await new Promise<void>((resolve) => health.close(() => resolve()))
    console.log(`[${SERVICE}] stopped`)
  })
}

main().catch((err: unknown) => {
  console.error(`[${SERVICE}] failed to start:`, err)
  // exit(), not exitCode: a worker that cannot bind its port or read its flow must die so the
  // supervisor restarts it. Setting exitCode leaves it alive and half-initialised for as long
  // as any handle remains, which looks like a running worker to everything except traffic.
  process.exit(1)
})
