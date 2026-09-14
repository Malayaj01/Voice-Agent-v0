/**
 * Integration test for script_versions. Skipped unless DATABASE_URL is set; CI provides a
 * Postgres service and runs the migrations first.
 *
 * What only a real database can check: the `script_versions_one_active` partial unique index
 * actually holds, and the deactivate-then-insert pair is atomic under it.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { FlowLoader } from '@voice-agent/shared'
import pg from 'pg'

import { FlowPublishError, PgFlowSource, publishFlow } from './flow-store.js'

const DATABASE_URL = process.env['DATABASE_URL']

/** Same guard as the call worker's: skipping locally is fine, skipping in CI is not. */
if (process.env['CI'] === 'true' && DATABASE_URL === undefined) {
  throw new Error(
    'DATABASE_URL is not set in CI. These tests are the only thing that exercises the ' +
      'script_versions writes against a real schema; they must never silently skip here.',
  )
}

const flowYaml = (version: number, greeting: string): string => `
version: ${version}
initial: OPENING
lines:
  opening: { en-IN: "${greeting}" }
objections: { intents: [], rules: [] }
states:
  OPENING: { say: opening }
`

describe(
  'script_versions',
  { skip: DATABASE_URL === undefined ? 'DATABASE_URL not set' : false },
  () => {
    let pool: pg.Pool
    /** Version numbers are globally unique in the table, so keep runs from colliding. */
    let base: number

    before(() => {
      pool = new pg.Pool({ connectionString: DATABASE_URL })
      base = Math.floor(Date.now() / 1000) % 1_000_000
    })

    after(async () => {
      await pool?.end()
    })

    it('publishes a version and reads it back through the loader', async () => {
      const version = base + 1
      const published = await publishFlow(pool, {
        yaml: flowYaml(version, 'hello from the database'),
        createdBy: 'flow-store.test',
        activate: true,
      })

      assert.equal(published.version, version)
      assert.equal(published.active, true)

      const loader = await FlowLoader.create(new PgFlowSource(pool))
      assert.equal(loader.current.version, version)
      assert.equal(loader.current.scriptVersionId, published.scriptVersionId)
      assert.equal(loader.current.flow.lines['opening']?.['en-IN'], 'hello from the database')
    })

    it('refuses to write a flow that does not validate', async () => {
      const before = await pool.query<{ n: string }>('SELECT count(*) AS n FROM script_versions')

      await assert.rejects(
        () =>
          publishFlow(pool, {
            yaml: `
version: ${base + 2}
initial: OPENING
lines: { opening: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  OPENING: { say: opening, default: { goto: NOWHERE } }
`,
            createdBy: 'flow-store.test',
          }),
        FlowPublishError,
      )

      const after = await pool.query<{ n: string }>('SELECT count(*) AS n FROM script_versions')
      assert.equal(after.rows[0]?.n, before.rows[0]?.n, 'nothing was written')
    })

    it('rejects a duplicate version rather than shadowing the old one', async () => {
      const version = base + 3
      await publishFlow(pool, {
        yaml: flowYaml(version, 'first'),
        createdBy: 'flow-store.test',
      })

      await assert.rejects(
        () => publishFlow(pool, { yaml: flowYaml(version, 'second'), createdBy: 'x' }),
        /already exists/,
      )
    })

    it('activating leaves exactly one active row', async () => {
      await publishFlow(pool, {
        yaml: flowYaml(base + 4, 'four'),
        createdBy: 'flow-store.test',
        activate: true,
      })
      await publishFlow(pool, {
        yaml: flowYaml(base + 5, 'five'),
        createdBy: 'flow-store.test',
        activate: true,
      })

      const { rows } = await pool.query<{ version: number }>(
        'SELECT version FROM script_versions WHERE active',
      )
      assert.equal(rows.length, 1, 'script_versions_one_active must hold')
      assert.equal(rows[0]?.version, base + 5)
    })

    it('publishing without activating does not disturb the live script', async () => {
      const liveBefore = await pool.query<{ version: number }>(
        'SELECT version FROM script_versions WHERE active',
      )

      await publishFlow(pool, {
        yaml: flowYaml(base + 6, 'staged, not live'),
        createdBy: 'flow-store.test',
        activate: false,
      })

      const liveAfter = await pool.query<{ version: number }>(
        'SELECT version FROM script_versions WHERE active',
      )
      assert.equal(liveAfter.rows[0]?.version, liveBefore.rows[0]?.version)
    })
  },
)
