/**
 * Creating the `calls` row a turn can hang off.
 *
 * `turns.call_id` is a foreign key, so a call must exist in the database before its first
 * turn is written. Skipping this is how the browser harness ended up violating
 * turns_call_id_fkey on the opening line of every call.
 *
 * This is a stop-gap for the paths that place a call directly — the harness and the
 * benchmarks. In production the dialer creates the `calls` row when it claims the lead
 * (§3.2), and the call worker is handed an id that already exists.
 */

import type { Pool } from 'pg'

export interface CallRecordOptions {
  /** Reuses an existing campaign when given one; otherwise creates a scratch campaign. */
  campaignId?: string
  leadId?: string
  scriptVersionId?: string
  label?: string
}

export interface CallRecord {
  callId: string
  campaignId: string
  leadId: string
  scriptVersionId: string
}

/**
 * Ensures there is a campaign, lead, script version and call to write turns against.
 *
 * Prefers whatever the database already has — the demo seed's campaign and leads — so a
 * harness call shows up attached to real data rather than a pile of throwaway rows.
 */
export async function ensureCallRecord(
  pool: Pool,
  opts: CallRecordOptions = {},
): Promise<CallRecord> {
  const label = opts.label ?? `harness-${Date.now()}`

  const scriptVersionId =
    opts.scriptVersionId ??
    (await pool.query<{ id: string }>(`SELECT id FROM script_versions WHERE active LIMIT 1`)).rows[0]
      ?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO script_versions (version, yaml, created_by, active)
         VALUES ($1, 'version: 1', $2, false) RETURNING id`,
        [Date.now() % 1_000_000, label],
      )
    ).rows[0]?.id

  if (scriptVersionId === undefined) throw new Error('could not resolve a script version')

  const campaignId =
    opts.campaignId ??
    (await pool.query<{ id: string }>(`SELECT id FROM campaigns ORDER BY created_at LIMIT 1`))
      .rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO campaigns (name, script_version_id) VALUES ($1, $2) RETURNING id`,
        [label, scriptVersionId],
      )
    ).rows[0]?.id

  if (campaignId === undefined) throw new Error('could not resolve a campaign')

  const leadId =
    opts.leadId ??
    (
      await pool.query<{ id: string }>(`SELECT id FROM leads WHERE campaign_id = $1 LIMIT 1`, [
        campaignId,
      ])
    ).rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO leads (campaign_id, name, phone_e164, language)
         VALUES ($1, $2, '+9991000001', 'en-IN') RETURNING id`,
        [campaignId, label],
      )
    ).rows[0]?.id

  if (leadId === undefined) throw new Error('could not resolve a lead')

  const call = await pool.query<{ id: string }>(
    `INSERT INTO calls (campaign_id, lead_id, script_version_id, connected)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [campaignId, leadId, scriptVersionId],
  )
  const callId = call.rows[0]?.id
  if (callId === undefined) throw new Error('call insert returned no id')

  return { callId, campaignId, leadId, scriptVersionId }
}
