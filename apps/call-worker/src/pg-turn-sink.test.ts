/**
 * Integration test for the `turns` write. Skipped unless DATABASE_URL is set; CI provides a
 * Postgres service and runs the migrations first, so this executes there.
 *
 * It exists because the thing most likely to be wrong about persistence is the SQL — a
 * column renamed in a migration, or a float handed to an integer column — and none of that
 * is visible to the in-memory adapter the turn-loop tests use.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { Fsm, parseFlow } from '@voice-agent/shared'
import { MockIntentClassifier, MockSTTProvider, MockTTSProvider } from '@voice-agent/shared/mocks'
import pg from 'pg'

import { BufferingAudioSink } from './audio.js'
import { PgTurnSink } from './pg-turn-sink.js'
import { createCallSession } from './session.js'

const DATABASE_URL = process.env['DATABASE_URL']

/**
 * Skipping locally is intended. Skipping in CI is not: it would leave the SQL permanently
 * unexecuted while the build stayed green, which is the same false-green trap as pointing
 * `node --test` at a directory. Fail loudly instead.
 */
if (process.env['CI'] === 'true' && DATABASE_URL === undefined) {
  throw new Error(
    'DATABASE_URL is not set in CI. These tests are the only thing that executes the turns ' +
      'INSERT against a real schema; they must never silently skip here.',
  )
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FLOW = parseFlow(readFileSync(join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml'), 'utf8'))

describe(
  'PgTurnSink',
  { skip: DATABASE_URL === undefined ? 'DATABASE_URL not set' : false },
  () => {
    let pool: pg.Pool
    let callId: string

    before(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL })

      const script = await pool.query<{ id: string }>(
        `INSERT INTO script_versions (version, yaml, created_by, active)
         VALUES ($1, $2, 'test', false) RETURNING id`,
        [Date.now() % 100000, 'version: 1'],
      )
      const scriptId = script.rows[0]?.id
      assert.ok(scriptId !== undefined)

      const campaign = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (name, script_version_id) VALUES ('test', $1) RETURNING id`,
        [scriptId],
      )
      const campaignId = campaign.rows[0]?.id
      assert.ok(campaignId !== undefined)

      const lead = await pool.query<{ id: string }>(
        `INSERT INTO leads (campaign_id, name, phone_e164, language)
         VALUES ($1, 'Rahul', '+919876543210', 'en-IN') RETURNING id`,
        [campaignId],
      )
      const leadId = lead.rows[0]?.id
      assert.ok(leadId !== undefined)

      const call = await pool.query<{ id: string }>(
        `INSERT INTO calls (campaign_id, lead_id, script_version_id, connected)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [campaignId, leadId, scriptId],
      )
      const id = call.rows[0]?.id
      assert.ok(id !== undefined)
      callId = id
    })

    after(async () => {
      await pool?.end()
    })

    it('writes a real call’s turns, timings included', async () => {
      const stt = new MockSTTProvider({ transcripts: ['haan boliye'] })
      const tts = new MockTTSProvider({ firstByteMs: 12, msPerChar: 5, chunkMs: 20 })
      const session = createCallSession(
        {
          callId,
          lang: 'en-IN',
          voice: { id: 'mock-voice', lang: 'en-IN' },
          fsm: new Fsm({
            flow: FLOW,
            lang: 'en-IN',
            vars: { contact_first_name: 'Rahul', company: 'Lipi' },
          }),
        },
        {
          stt,
          tts,
          intent: new MockIntentClassifier(),
          sink: new BufferingAudioSink(),
          turns: new PgTurnSink(pool),
        },
      )

      await session.start()
      const stream = stt.streams[0]
      assert.ok(stream !== undefined)
      await stream.emitNext()
      await session.settle()

      const rows = await pool.query<{
        seq: number
        role: string
        intent: string | null
        t_tts_first_byte_ms: number | null
        t_intent_ms: number | null
        barged_in: boolean
      }>(
        `SELECT seq, role, intent, t_tts_first_byte_ms, t_intent_ms, barged_in
         FROM turns WHERE call_id = $1 ORDER BY seq`,
        [callId],
      )

      assert.deepEqual(
        rows.rows.map((r) => r.role),
        ['agent', 'caller', 'agent'],
      )
      assert.equal(rows.rows[1]?.intent, 'acknowledge')
      assert.equal(rows.rows[1]?.barged_in, false)

      const reply = rows.rows[2]
      assert.ok(reply !== undefined)
      assert.ok(
        reply.t_tts_first_byte_ms !== null && Number.isInteger(reply.t_tts_first_byte_ms),
        'fractional milliseconds are quantised at the storage boundary',
      )
      assert.ok(reply.t_intent_ms !== null)
    })

    it('rejects a duplicate seq, so a retry cannot double-write a turn', async () => {
      const sink = new PgTurnSink(pool)
      const row = {
        callId,
        seq: 9001,
        role: 'agent' as const,
        text: 'once',
        intent: null,
        state: 'OPENING',
        timings: { fsm: 1.4 },
        bargedIn: false,
      }

      await sink.record(row)
      await assert.rejects(() => sink.record(row), /duplicate key|unique/i)
    })
  },
)
