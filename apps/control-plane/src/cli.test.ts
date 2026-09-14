/**
 * Runs the built CLI as a subprocess. Exit codes are the contract here — a pre-cache job or a
 * CI step decides what to do based on them, so asserting them directly is the point.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'cli.js')
const REPO_ROOT = join(HERE, '..', '..', '..')
const FLOW = join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml')

const LEAD_VARS = [
  '--var',
  'contact_first_name=Rahul',
  '--var',
  'company=Lipi',
  '--var',
  'company_name=Acme Clinics',
  '--var',
  'industry=healthcare',
  '--var',
  'slot_pair=Monday 11 or Tuesday 3',
  '--var',
  'slot_first=Monday 11',
  '--var',
  'slot_booked=Monday 11',
  '--var',
  'anchor_question=Got a minute?',
]

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function cli(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

async function tempFlow(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flow-cli-'))
  const path = join(dir, 'flow.yaml')
  await writeFile(path, body, 'utf8')
  return path
}

describe('voice-flow validate', () => {
  it('accepts the shipped flow, strictly', async () => {
    const r = await cli('validate', FLOW, '--strict')
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /valid:/)
  })

  it('rejects a dangling goto and names the path', async () => {
    const path = await tempFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi, default: { goto: NOWHERE } }
`)
    const r = await cli('validate', path)

    assert.equal(r.code, 1)
    assert.match(r.stderr, /states\.A\.default\.goto/)
    assert.match(r.stderr, /unknown state "NOWHERE"/)
  })

  it('fails on a say naming a line that does not exist', async () => {
    const path = await tempFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A: { say: typo_line }
`)
    const r = await cli('validate', path)

    assert.equal(r.code, 1)
    assert.match(r.stderr, /unknown line "typo_line"/)
  })

  it('warns about a dead line but passes without --strict', async () => {
    const path = await tempFlow(`
version: 1
initial: A
lines:
  hi: { en-IN: "hi" }
  orphan: { en-IN: "never said" }
objections: { intents: [], rules: [] }
states:
  A: { say: hi }
`)
    const lenient = await cli('validate', path)
    assert.equal(lenient.code, 0)
    assert.match(lenient.stderr, /unreachable lines\s+orphan/)

    const strict = await cli('validate', path, '--strict')
    assert.equal(strict.code, 1, 'strict turns the warning into a failure')
  })
})

describe('voice-flow render', () => {
  it('emits the reachable lines with cache keys as JSON', async () => {
    const r = await cli('render', FLOW, '--lang', 'en-IN', '--voice', 'bulbul-v3', ...LEAD_VARS)
    assert.equal(r.code, 0, r.stderr)

    const out = JSON.parse(r.stdout) as {
      flowVersion: number
      lang: string
      voiceId: string
      lines: Array<{ id: string | null; text: string; cacheKey: string }>
    }

    assert.equal(out.lang, 'en-IN')
    assert.equal(out.voiceId, 'bulbul-v3')
    assert.ok(out.lines.length >= 20, `expected the full closed set, got ${out.lines.length}`)

    const opening = out.lines.find((l) => l.id === 'opening')
    assert.equal(opening?.text, "Hi Rahul, this is Lipi's AI assistant. Got a minute?")
    assert.match(opening?.cacheKey ?? '', /^[0-9a-f]{64}$/)

    // Keys must be unique per line, or the cache collides and the bot says the wrong thing.
    const keys = new Set(out.lines.map((l) => l.cacheKey))
    assert.equal(keys.size, out.lines.length)
  })

  it('renders Hinglish when asked', async () => {
    const r = await cli('render', FLOW, '--lang', 'hi-IN-hinglish', ...LEAD_VARS)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Namaste Rahul/)
  })

  /**
   * The failure that would otherwise be invisible: a line still holding {{placeholder}} gets
   * a cache key nothing ever looks up, so the pre-cache silently achieves a 0% hit rate on it.
   */
  it('fails when a variable is missing, rather than caching an unrenderable line', async () => {
    const r = await cli('render', FLOW, '--lang', 'en-IN', '--var', 'contact_first_name=Rahul')

    assert.equal(r.code, 1)
    assert.match(r.stderr, /unrendered placeholders/)
    assert.match(r.stderr, /cannot be pre-cached/)
  })

  it('accepts a lead file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lead-'))
    const leadPath = join(dir, 'lead.json')
    await writeFile(
      leadPath,
      JSON.stringify({
        contact_first_name: 'Priya',
        company: 'Lipi',
        company_name: 'Acme Clinics',
        industry: 'healthcare',
        slot_pair: 'Monday 11 or Tuesday 3',
        slot_first: 'Monday 11',
        slot_booked: 'Monday 11',
        anchor_question: 'Got a minute?',
      }),
      'utf8',
    )

    const r = await cli('render', FLOW, '--lead', leadPath)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Hi Priya/)
  })
})

describe('voice-flow usage', () => {
  it('prints usage and fails when given no command', async () => {
    const r = await cli()
    assert.equal(r.code, 1)
    assert.match(r.stdout, /voice-flow validate/)
  })

  it('rejects an unknown language', async () => {
    const r = await cli('render', FLOW, '--lang', 'fr-FR')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /unknown language/)
  })
})
