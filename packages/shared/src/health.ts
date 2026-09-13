/**
 * Health check shared by all three deployables. node:http rather than a framework — a
 * health endpoint does not justify a dependency.
 */

import { createServer, type Server } from 'node:http'

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthReport {
  status: HealthStatus
  service: string
  version: string
  uptimeS: number
  /** Per-dependency results, e.g. { postgres: 'ok' }. Empty until dependencies exist. */
  checks: Record<string, HealthStatus>
}

export interface HealthServerOpts {
  service: string
  version: string
  port: number
  /** Dependency probes. Phase 1 has none; Postgres and the carrier land later. */
  checks?: Record<string, () => Promise<HealthStatus>>
}

function worst(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes('down')) return 'down'
  if (statuses.includes('degraded')) return 'degraded'
  return 'ok'
}

export async function buildReport(opts: HealthServerOpts, startedAt: number): Promise<HealthReport> {
  const checks: Record<string, HealthStatus> = {}
  for (const [name, probe] of Object.entries(opts.checks ?? {})) {
    try {
      checks[name] = await probe()
    } catch {
      checks[name] = 'down'
    }
  }
  return {
    status: worst(Object.values(checks)),
    service: opts.service,
    version: opts.version,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    checks,
  }
}

/** Starts a health server on GET /health. Resolves once it is listening. */
export function createHealthServer(opts: HealthServerOpts): Promise<Server> {
  const startedAt = Date.now()

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    buildReport(opts, startedAt)
      .then((report) => {
        res.writeHead(report.status === 'down' ? 503 : 200, {
          'content-type': 'application/json',
        })
        res.end(JSON.stringify(report))
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'down', error: String(err) }))
      })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, () => resolve(server))
  })
}

/** Wires SIGINT/SIGTERM to a graceful close. Every app entrypoint calls this. */
export function onShutdown(close: () => Promise<void> | void): void {
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return
      closing = true
      void (async () => {
        try {
          await close()
          process.exit(0)
        } catch {
          process.exit(1)
        }
      })()
    })
  }
}
