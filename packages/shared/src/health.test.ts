import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { Server } from 'node:http'

import { buildReport, createHealthServer, type HealthStatus } from './health.js'

const servers: Server[] = []

after(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
})

async function start(port: number, checks?: Record<string, () => Promise<HealthStatus>>) {
  const server = await createHealthServer(
    checks === undefined
      ? { service: 'test', version: '0.0.0', port }
      : { service: 'test', version: '0.0.0', port, checks },
  )
  servers.push(server)
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

describe('health report', () => {
  it('is ok with no dependency probes registered', async () => {
    const report = await buildReport({ service: 'dialer', version: '1.2.3', port: 0 }, Date.now())
    assert.equal(report.status, 'ok')
    assert.equal(report.service, 'dialer')
    assert.deepEqual(report.checks, {})
  })

  it('takes the worst status across probes', async () => {
    const report = await buildReport(
      {
        service: 'call-worker',
        version: '0.1.0',
        port: 0,
        checks: {
          postgres: async () => 'ok',
          carrier: async () => 'degraded',
        },
      },
      Date.now(),
    )
    assert.equal(report.status, 'degraded')
    assert.deepEqual(report.checks, { postgres: 'ok', carrier: 'degraded' })
  })

  it('treats a throwing probe as down rather than failing the endpoint', async () => {
    const report = await buildReport(
      {
        service: 'control-plane',
        version: '0.1.0',
        port: 0,
        checks: {
          postgres: async () => {
            throw new Error('connection refused')
          },
        },
      },
      Date.now(),
    )
    assert.equal(report.status, 'down')
    assert.equal(report.checks['postgres'], 'down')
  })
})

describe('health server', () => {
  it('serves GET /health', async () => {
    const base = await start(0)
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; service: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'test')
  })

  it('returns 503 when a dependency is down', async () => {
    const base = await start(0, { postgres: async () => 'down' })
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 503)
  })

  it('404s anything that is not /health', async () => {
    const base = await start(0)
    const res = await fetch(`${base}/nope`)
    assert.equal(res.status, 404)
  })
})
