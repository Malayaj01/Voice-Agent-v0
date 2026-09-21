/**
 * Runs the seed against a real database. Skipped without DATABASE_URL; CI provides Postgres
 * with the migrations applied, so this is what actually proves `docker compose up` will have
 * something to boot on.
 *
 * The schema is the risk here — check constraints on language and phone format, the foreign
 * keys, the partial unique index on the active script version. None of that is visible from a
 * unit test, and all of it fails at container start rather than in review.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { evaluateGates, toE164, type DialFacts } from '@voice-agent/shared'
import pg from 'pg'

import { DEMO_CAMPAIGN_NAME, DEMO_LEADS, seedDemo } from './seed.js'

const DATABASE_URL = process.env['DATABASE_URL']

/** Same guard as everywhere else: skipping locally is fine, skipping in CI is not. */
if (process.env['CI'] === 'true' && DATABASE_URL === undefined) {
  throw new Error(
    'DATABASE_URL is not set in CI. The seed test is the only thing that runs the demo ' +
      'inserts against a real schema; it must never silently skip here.',
  )
}

describe(
  'demo seed',
  { skip: DATABASE_URL === undefined ? 'DATABASE_URL not set' : false },
  () => {
    let pool: pg.Pool
    const quiet = (): void => undefined

    before(() => {
      pool = new pg.Pool({ connectionString: DATABASE_URL })
    })

    after(async () => {
      await pool?.end()
    })

    it('seeds a campaign, leads, consent and DNC rows', async () => {
      const result = await seedDemo(pool, undefined, quiet)
      assert.ok(result.seeded || result.campaignId.length > 0)

      const campaign = await pool.query<{ name: string }>(
        `SELECT name FROM campaigns WHERE id = $1`,
        [result.campaignId],
      )
      assert.equal(campaign.rows[0]?.name, DEMO_CAMPAIGN_NAME)

      const leads = await pool.query<{ phone_e164: string; language: string }>(
        `SELECT phone_e164, language FROM leads WHERE campaign_id = $1 ORDER BY phone_e164`,
        [result.campaignId],
      )
      assert.equal(leads.rows.length, DEMO_LEADS.length)
      assert.deepEqual(
        leads.rows.map((r) => r.phone_e164),
        [...DEMO_LEADS].map((l) => l.phone).sort(),
      )
    })

    /** The compose stack runs this on every `up`. */
    it('is idempotent', async () => {
      const first = await seedDemo(pool, undefined, quiet)
      const second = await seedDemo(pool, undefined, quiet)

      assert.equal(second.seeded, false, 'a second run must write nothing')
      assert.equal(second.campaignId, first.campaignId)

      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM leads WHERE campaign_id = $1`,
        [first.campaignId],
      )
      assert.equal(Number(rows[0]?.n), DEMO_LEADS.length, 'leads must not accumulate')
    })

    it('leaves exactly one active script version for the worker to boot on', async () => {
      await seedDemo(pool, undefined, quiet)
      const { rows } = await pool.query(`SELECT id FROM script_versions WHERE active`)
      assert.equal(rows.length, 1)
    })

    /**
     * The seeded data has to make the gates demonstrable, not just present. A demo where
     * every lead passes teaches nothing about the thing most likely to stop a campaign.
     */
    it('seeds leads that exercise both sides of the compliance gates', async () => {
      await seedDemo(pool, undefined, quiet)

      const dnc = await pool.query<{ phone_e164: string }>(`SELECT phone_e164 FROM dnc`)
      const consent = await pool.query<{ phone_e164: string }>(
        `SELECT phone_e164 FROM consent_records WHERE revoked_at IS NULL`,
      )

      const dncNumbers = new Set(dnc.rows.map((r) => r.phone_e164))
      const consented = new Set(consent.rows.map((r) => r.phone_e164))

      const facts = (phone: string): DialFacts => ({
        phoneE164: toE164(phone),
        promotional: true,
        registration: {
          peRegistered: true,
          tmRegistered: true,
          linkageActive: true,
          numberSeries: '140x',
        },
        onDnc: dncNumbers.has(phone),
        consent: {
          dltConsentId: consented.has(phone) ? 'DLT-DEMO' : null,
          grantedAt: consented.has(phone) ? new Date('2026-01-01') : null,
          expiresAt: null,
          revokedAt: null,
        },
        activeHours: { startHour: 0, endHour: 24, timeZone: 'Asia/Kolkata' },
        callsInWindow: 0,
        frequencyCap: 3,
        now: new Date('2026-09-21T06:30:00Z'),
      })

      const blocked = (phone: string): string[] =>
        evaluateGates(facts(phone))
          .filter((r) => !r.passed)
          .map((r) => r.gate)

      assert.deepEqual(blocked('+9991000001'), [], 'the clean lead must be dialable')
      assert.deepEqual(blocked('+9991000003'), ['not_on_dnc'], 'the DNC lead must be refused')
      assert.deepEqual(
        blocked('+9991000004'),
        ['has_valid_consent'],
        'the lead without consent must be refused',
      )
    })

    /**
     * Not routable by any carrier, by design. A demo database is exactly where a plausible
     * real number would sit unnoticed until something dialled it.
     */
    it('uses ITU trial numbers that no carrier will route', () => {
      for (const lead of DEMO_LEADS) {
        assert.match(lead.phone, /^\+999/, `${lead.name} must not have a routable number`)
      }
    })
  },
)
