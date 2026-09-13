/**
 * Dialer / pacer — ARCHITECTURE.md §3.2.
 *
 * EVERY compliance gate lives here, in code: calling hours, DNC, consent, frequency caps,
 * retry policy, pacing. Not in config, not assumed handled upstream. Non-compliant calls
 * are Rs 1,000-10,000 each.
 *
 * Claims work from Postgres with SKIP LOCKED. Warm path — queued, not latency-critical.
 */

import { createHealthServer, numberEnv, onShutdown } from '@voice-agent/shared'

const SERVICE = 'dialer'
const VERSION = '0.1.0'

/**
 * The gates a lead must clear before it can be dialled. Phase 4 implements these; the list
 * is here so it cannot quietly shrink.
 */
export const COMPLIANCE_GATES = [
  'within_active_hours',
  'not_on_dnc',
  'has_valid_consent',
  'under_frequency_cap',
] as const

export type ComplianceGate = (typeof COMPLIANCE_GATES)[number]

async function main(): Promise<void> {
  const port = numberEnv('DIALER_PORT', 8081)

  // TODO(phase-4): claim leads (SKIP LOCKED), run COMPLIANCE_GATES, pace, place via SIP.
  const health = await createHealthServer({ service: SERVICE, version: VERSION, port })
  console.log(`[${SERVICE}] listening on :${port}`)

  onShutdown(async () => {
    await new Promise<void>((resolve) => health.close(() => resolve()))
    console.log(`[${SERVICE}] stopped`)
  })
}

main().catch((err: unknown) => {
  console.error(`[${SERVICE}] failed to start:`, err)
  process.exitCode = 1
})
