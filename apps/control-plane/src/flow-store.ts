/**
 * `script_versions` — the flow's home in Postgres (§7.1).
 *
 * The control plane owns script versions (§3.1), so the driver lives here rather than in
 * shared, mirroring PgTurnSink in the call worker.
 *
 * Publishing validates before it writes. A document that cannot be parsed must never reach
 * the table, because the loader's safety net (keep the last good flow) only protects running
 * workers — a fresh worker starting up would read the broken row and fail to boot.
 */

import type { Pool } from 'pg'

import {
  safeParseFlow,
  type FlowIssue,
  type FlowSource,
  type LoadedFlowSource,
} from '@voice-agent/shared'

/** Reads the active flow. Used by workers at startup and on every reload poll. */
export class PgFlowSource implements FlowSource {
  readonly name = 'postgres:script_versions'

  constructor(private readonly pool: Pool) {}

  /**
   * The active row's id. Activation inserts a new row rather than editing one, so the id
   * changing is exactly what "the script changed" means — no timestamp comparison needed.
   */
  async fingerprint(): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM script_versions WHERE active LIMIT 1`,
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('no active script_version')
    return id
  }

  async load(): Promise<LoadedFlowSource> {
    const { rows } = await this.pool.query<{ id: string; yaml: string }>(
      `SELECT id, yaml FROM script_versions WHERE active LIMIT 1`,
    )
    const row = rows[0]
    if (row === undefined) throw new Error('no active script_version')
    return { scriptVersionId: row.id, yaml: row.yaml }
  }
}

export interface PublishResult {
  scriptVersionId: string
  version: number
  active: boolean
}

export class FlowPublishError extends Error {
  override readonly name = 'FlowPublishError'
  constructor(
    message: string,
    readonly issues: readonly FlowIssue[] = [],
  ) {
    super(message)
  }
}

export interface PublishOptions {
  yaml: string
  createdBy: string
  /** Make this the version new calls use. */
  activate?: boolean
}

/**
 * Validates, inserts, and optionally activates — all in one transaction.
 *
 * The activation is a deactivate-then-insert pair because `script_versions_one_active` is a
 * unique partial index: two active rows is not a state the table can hold, and doing it
 * outside a transaction would leave a window with none.
 */
export async function publishFlow(pool: Pool, opts: PublishOptions): Promise<PublishResult> {
  const parsed = safeParseFlow(opts.yaml)
  if (!parsed.ok) {
    throw new FlowPublishError('flow is not valid, refusing to publish', parsed.issues)
  }
  const version = parsed.flow.version
  const activate = opts.activate ?? false

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM script_versions WHERE version = $1`,
      [version],
    )
    if (existing.rows.length > 0) {
      throw new FlowPublishError(
        `version ${version} already exists — bump \`version:\` in the flow document`,
      )
    }

    if (activate) {
      await client.query(`UPDATE script_versions SET active = false WHERE active`)
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO script_versions (version, yaml, created_by, active)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [version, opts.yaml, opts.createdBy, activate],
    )
    await client.query('COMMIT')

    const id = inserted.rows[0]?.id
    if (id === undefined) throw new FlowPublishError('insert returned no id')
    return { scriptVersionId: id, version, active: activate }
  } catch (err: unknown) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
