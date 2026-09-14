/**
 * Flow wiring for the call worker.
 *
 * Source is chosen by environment: FLOW_FILE for local development, otherwise the active row
 * in script_versions. Production reads from Postgres so a script edit reaches every worker
 * without a deploy (§7.1).
 *
 * Health semantics worth being deliberate about: a failed reload leaves the worker running on
 * the last good flow and reports `degraded`, not `down`. Calls in progress are unaffected and
 * new calls still work — someone needs to be paged, but nothing should be drained.
 */

import {
  FileFlowSource,
  FlowLoader,
  numberEnv,
  type FlowSource,
  type HealthStatus,
} from '@voice-agent/shared'

export interface FlowRuntime {
  loader: FlowLoader
  /** Health probe reflecting whether the last reload attempt succeeded. */
  check: () => Promise<HealthStatus>
  stop: () => void
}

export interface FlowRuntimeEnv {
  flowFile?: string | undefined
  databaseUrl?: string | undefined
}

/** Builds the source without importing a driver unless a database is actually configured. */
async function sourceFor(env: FlowRuntimeEnv): Promise<FlowSource> {
  if (env.flowFile !== undefined && env.flowFile !== '') {
    return new FileFlowSource(env.flowFile)
  }
  if (env.databaseUrl === undefined || env.databaseUrl === '') {
    throw new Error('set FLOW_FILE or DATABASE_URL so the worker knows where to read the flow')
  }

  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: env.databaseUrl })

  return {
    name: 'postgres:script_versions',
    async fingerprint() {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM script_versions WHERE active LIMIT 1`,
      )
      const id = rows[0]?.id
      if (id === undefined) throw new Error('no active script_version')
      return id
    },
    async load() {
      const { rows } = await pool.query<{ id: string; yaml: string }>(
        `SELECT id, yaml FROM script_versions WHERE active LIMIT 1`,
      )
      const row = rows[0]
      if (row === undefined) throw new Error('no active script_version')
      return { scriptVersionId: row.id, yaml: row.yaml }
    },
  }
}

export async function startFlowRuntime(
  env: FlowRuntimeEnv,
  log: (line: string) => void = (line) => console.log(line),
): Promise<FlowRuntime> {
  const source = await sourceFor(env)
  let lastReloadFailed = false

  const loader = await FlowLoader.create(source, {
    pollMs: numberEnv('FLOW_POLL_MS', 30_000),
    onChange: (doc, previous) => {
      lastReloadFailed = false
      log(
        `[flow] version ${previous.version} -> ${doc.version} (${doc.scriptVersionId ?? 'file'}); ` +
          `calls already in progress keep version ${previous.version}`,
      )
    },
    onError: (issues, name) => {
      lastReloadFailed = true
      log(`[flow] reload from ${name} FAILED, still serving version ${loader.current.version}`)
      for (const issue of issues) log(`[flow]   ${issue.path}: ${issue.message}`)
    },
  })

  log(`[flow] serving version ${loader.current.version} from ${source.name}`)

  return {
    loader,
    check: () => Promise.resolve(lastReloadFailed ? 'degraded' : 'ok'),
    stop: () => loader.stop(),
  }
}
