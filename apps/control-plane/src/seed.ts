#!/usr/bin/env node
/**
 * Seeds a demo campaign, leads and the flow — enough that a clean clone has something to
 * look at rather than an empty schema.
 *
 * Idempotent: running it twice changes nothing. The compose stack runs it on every `up`, and
 * a seed that duplicated its rows each time would be worse than no seed.
 *
 * ON THE DEMO PHONE NUMBERS. They are +999, which ITU reserves for trials and which no
 * carrier will route. That is deliberate: a demo database seeded with plausible Indian
 * mobiles is one misconfiguration away from an AI sales bot calling a stranger, and §2 prices
 * that at Rs 1,000-10,000 a call. The compliance gates already block it, but the numbers
 * themselves should not be dialable either — two independent reasons nothing happens beats
 * one.
 *
 * The leads are shaped so the gates are demonstrable rather than theoretical: one passes
 * everything, one is on the DNC list, one has no consent record.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { publishFlow } from './flow-store.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULT_FLOW_PATH =
  process.env['SEED_FLOW'] ?? join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml')

export const DEMO_CAMPAIGN_NAME = 'Demo - Acme Clinics outreach'

interface DemoLead {
  name: string
  phone: string
  language: 'en-IN' | 'hi-IN' | 'hi-IN-hinglish'
  tier: 1 | 2 | 3
  /** Seeded so the DNC gate has something to refuse. */
  onDnc?: boolean
  /** Seeded so the consent gate has something to pass. */
  consent?: boolean
  meta: Record<string, string>
}

export const DEMO_LEADS: readonly DemoLead[] = [
  {
    name: 'Rahul Verma',
    phone: '+9991000001',
    language: 'en-IN',
    tier: 1,
    consent: true,
    meta: {
      company_name: 'Acme Clinics',
      industry: 'healthcare',
      contact_first_name: 'Rahul',
      note: 'fully compliant - every gate passes',
    },
  },
  {
    name: 'Priya Nair',
    phone: '+9991000002',
    language: 'hi-IN-hinglish',
    tier: 2,
    consent: true,
    meta: {
      company_name: 'Sunrise Diagnostics',
      industry: 'diagnostics',
      contact_first_name: 'Priya',
      note: 'Hinglish flow',
    },
  },
  {
    name: 'Imran Shaikh',
    phone: '+9991000003',
    language: 'en-IN',
    tier: 3,
    onDnc: true,
    consent: true,
    meta: {
      company_name: 'Metro Dental',
      industry: 'dental',
      contact_first_name: 'Imran',
      note: 'on DNC - the dialer must refuse this one',
    },
  },
  {
    name: 'Sneha Rao',
    phone: '+9991000004',
    language: 'en-IN',
    tier: 3,
    meta: {
      company_name: 'Lotus Physio',
      industry: 'physiotherapy',
      contact_first_name: 'Sneha',
      note: 'no consent record - the consent gate must refuse this one',
    },
  },
]

export interface SeedResult {
  /** False when the campaign already existed and nothing was written. */
  seeded: boolean
  campaignId: string
  scriptVersionId: string
  leads: number
}

/**
 * Seeds one demo campaign. Safe to call repeatedly — the campaign name is the marker.
 *
 * Exported separately from the CLI so it can run against a real database in CI. The schema
 * and its constraints are the part most likely to be wrong here, and neither is visible from
 * a unit test.
 */
export async function seedDemo(
  pool: pg.Pool,
  flowPath: string = DEFAULT_FLOW_PATH,
  log: (line: string) => void = (line) => process.stdout.write(line),
): Promise<SeedResult> {
  const existing = await pool.query<{ id: string; script_version_id: string }>(
    `SELECT id, script_version_id FROM campaigns WHERE name = $1`,
    [DEMO_CAMPAIGN_NAME],
  )
  const already = existing.rows[0]
  if (already !== undefined) {
    log(`seed: already present (campaign ${already.id})\n`)
    return {
      seeded: false,
      campaignId: already.id,
      scriptVersionId: already.script_version_id,
      leads: 0,
    }
  }

  // Published through the same path an operator would use, so the seed exercises validation
  // rather than writing a row the CLI would have rejected.
  const active = await pool.query<{ id: string }>(
    `SELECT id FROM script_versions WHERE active LIMIT 1`,
  )
  const scriptVersionId =
    active.rows[0]?.id ??
    (
      await publishFlow(pool, {
        yaml: await readFile(flowPath, 'utf8'),
        createdBy: 'seed',
        activate: true,
      })
    ).scriptVersionId
  log(`seed: flow active as ${scriptVersionId}\n`)

  const campaign = await pool.query<{ id: string }>(
    `INSERT INTO campaigns (name, script_version_id, pacing, active_hours)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      DEMO_CAMPAIGN_NAME,
      scriptVersionId,
      JSON.stringify({ maxConcurrent: 25, callsPerMinute: 4 }),
      JSON.stringify({ startHour: 9, endHour: 21, timeZone: 'Asia/Kolkata' }),
    ],
  )
  const campaignId = campaign.rows[0]?.id
  if (campaignId === undefined) throw new Error('campaign insert returned no id')
  log(`seed: campaign ${campaignId}\n`)

  for (const lead of DEMO_LEADS) {
    await pool.query(
      `INSERT INTO leads (campaign_id, name, phone_e164, language, priority_tier, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [campaignId, lead.name, lead.phone, lead.language, lead.tier, JSON.stringify(lead.meta)],
    )

    if (lead.consent === true) {
      await pool.query(
        `INSERT INTO consent_records (phone_e164, dlt_consent_id, source, granted_at)
         VALUES ($1, $2, 'seed', now())`,
        [lead.phone, `DLT-DEMO-${lead.phone.slice(-4)}`],
      )
    }
    if (lead.onDnc === true) {
      await pool.query(
        `INSERT INTO dnc (phone_e164, reason, source) VALUES ($1, $2, 'own')
         ON CONFLICT (phone_e164) DO NOTHING`,
        [lead.phone, 'demo: requested no further calls'],
      )
    }
  }

  log(
    `seed: ${DEMO_LEADS.length} leads` +
      ` (${DEMO_LEADS.filter((l) => l.consent === true).length} with consent,` +
      ` ${DEMO_LEADS.filter((l) => l.onDnc === true).length} on DNC)\n`,
  )
  log('seed: done\n')

  return { seeded: true, campaignId, scriptVersionId, leads: DEMO_LEADS.length }
}

async function main(): Promise<number> {
  const connectionString = process.env['DATABASE_URL']
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL is not set\n')
    return 1
  }

  const pool = new pg.Pool({ connectionString })
  try {
    await seedDemo(pool)
    return 0
  } finally {
    await pool.end()
  }
}

// Only when run as a script, so importing seedDemo in a test does not seed anything.
if (process.argv[1] !== undefined && process.argv[1].endsWith('seed.js')) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
      process.exitCode = 1
    })
}
