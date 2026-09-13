/**
 * Call worker — ARCHITECTURE.md §3.3.
 *
 * The ONLY latency-critical process. N concurrent calls per worker; scale by N, not by
 * splitting the pipeline. Design target is 25 concurrent (2,000 calls/day is ~2.5 average).
 *
 * The turn-loop contract lives in turn-loop.ts.
 */

import { createHealthServer, numberEnv, onShutdown } from '@voice-agent/shared'

const SERVICE = 'call-worker'
const VERSION = '0.1.0'

async function main(): Promise<void> {
  const port = numberEnv('CALL_WORKER_PORT', 8082)
  const maxConcurrent = numberEnv('MAX_CONCURRENT_CALLS', 25)

  // TODO(phase-1): LiveKit Agents session, free STT/TTS stack, one call end-to-end.
  const health = await createHealthServer({ service: SERVICE, version: VERSION, port })
  console.log(`[${SERVICE}] listening on :${port} (max ${maxConcurrent} concurrent)`)

  onShutdown(async () => {
    await new Promise<void>((resolve) => health.close(() => resolve()))
    console.log(`[${SERVICE}] stopped`)
  })
}

main().catch((err: unknown) => {
  console.error(`[${SERVICE}] failed to start:`, err)
  process.exitCode = 1
})
