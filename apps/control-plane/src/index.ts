/**
 * Control plane — ARCHITECTURE.md §3.1.
 *
 * Owns campaigns, leads, DNC, consent, script versions, the dashboard and the REST API.
 * Stateless: scale it trivially. Nothing latency-critical lives here.
 */

import { createHealthServer, numberEnv, onShutdown } from '@voice-agent/shared'

const SERVICE = 'control-plane'
const VERSION = '0.1.0'

async function main(): Promise<void> {
  const port = numberEnv('CONTROL_PLANE_PORT', 8080)

  // TODO(phase-3): REST API, script-version CRUD, dashboard.
  const health = await createHealthServer({ service: SERVICE, version: VERSION, port })
  console.log(`[${SERVICE}] listening on :${port}`)

  onShutdown(async () => {
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
