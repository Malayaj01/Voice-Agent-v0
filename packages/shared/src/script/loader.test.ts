import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { FlowParseError, safeParseFlow } from './flow.js'
import { FileFlowSource, FlowLoader, type FlowSource, type LoadedFlowSource } from './loader.js'

const GOOD = (version: number, greeting: string): string => `
version: ${version}
initial: A
lines:
  hi: { en-IN: "${greeting}" }
objections: { intents: [], rules: [] }
states:
  A: { say: hi }
`

const BROKEN_YAML = 'version: 1\n  bad indent: ['
const INVALID_REFERENCE = `
version: 9
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi, default: { goto: NOWHERE } }
`

/** In-memory source, so reload semantics are tested without filesystem timing. */
class FakeSource implements FlowSource {
  readonly name = 'fake'
  loads = 0

  constructor(
    private yaml: string,
    private token = 'v1',
  ) {}

  set(yaml: string, token: string): void {
    this.yaml = yaml
    this.token = token
  }

  fingerprint(): Promise<string> {
    return Promise.resolve(this.token)
  }

  load(): Promise<LoadedFlowSource> {
    this.loads++
    return Promise.resolve({ scriptVersionId: this.token, yaml: this.yaml })
  }
}

describe('FlowLoader', () => {
  it('refuses to start on an invalid flow', async () => {
    await assert.rejects(
      () => FlowLoader.create(new FakeSource(INVALID_REFERENCE)),
      FlowParseError,
      'starting on a broken script is a failure to start, not a degraded mode',
    )
  })

  it('swaps in a new version and reports the change', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const changes: Array<{ from: number; to: number }> = []
    const loader = await FlowLoader.create(source, {
      onChange: (doc, previous) => changes.push({ from: previous.version, to: doc.version }),
    })

    assert.equal(loader.current.version, 1)

    source.set(GOOD(2, 'second'), 'v2')
    assert.equal(await loader.reload(), true)

    assert.equal(loader.current.version, 2)
    assert.equal(loader.current.scriptVersionId, 'v2')
    assert.deepEqual(changes, [{ from: 1, to: 2 }])
  })

  it('does not re-read when the fingerprint is unchanged', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const loader = await FlowLoader.create(source)
    const loadsAfterCreate = source.loads

    assert.equal(await loader.reload(), false)
    assert.equal(source.loads, loadsAfterCreate, 'an unchanged flow costs a fingerprint, not a parse')
  })

  /**
   * The rule the loader exists to enforce. A typo in a flow must not take a campaign down:
   * the worker keeps serving the last good script and something gets paged.
   */
  it('keeps serving the last good flow when a new one is invalid', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const errors: string[] = []
    const loader = await FlowLoader.create(source, {
      onError: (issues) => errors.push(issues.map((i) => i.path).join(',')),
    })

    source.set(INVALID_REFERENCE, 'v2-broken')
    assert.equal(await loader.reload(), false)

    assert.equal(loader.current.version, 1, 'the good flow is still live')
    assert.equal(loader.current.scriptVersionId, 'v1')
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /goto/)
  })

  it('recovers on the next poll once the flow is fixed, without a restart', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const loader = await FlowLoader.create(source, { onError: () => undefined })

    source.set(INVALID_REFERENCE, 'v2-broken')
    await loader.reload()
    assert.equal(loader.current.version, 1)

    source.set(GOOD(3, 'fixed'), 'v3')
    assert.equal(await loader.reload(), true)
    assert.equal(loader.current.version, 3)
  })

  it('reports unparseable YAML rather than throwing out of reload', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const errors: string[] = []
    const loader = await FlowLoader.create(source, {
      onError: (issues) => errors.push(issues[0]?.message ?? ''),
    })

    source.set(BROKEN_YAML, 'v2-yaml')
    assert.equal(await loader.reload(), false)

    assert.equal(loader.current.version, 1)
    assert.match(errors[0] ?? '', /not parseable/i)
  })

  it('survives a source that throws', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    const errors: string[] = []
    const loader = await FlowLoader.create(source, {
      onError: (issues) => errors.push(issues[0]?.message ?? ''),
    })

    source.fingerprint = () => Promise.reject(new Error('connection refused'))
    assert.equal(await loader.reload(), false)

    assert.equal(loader.current.version, 1)
    assert.match(errors[0] ?? '', /connection refused/)
  })

  it('polls on an interval when asked, and stops cleanly', async () => {
    const source = new FakeSource(GOOD(1, 'first'))
    let tick: (() => void) | undefined
    let cleared = false

    const loader = await FlowLoader.create(source, {
      pollMs: 1000,
      setInterval: ((fn: () => void) => {
        tick = fn
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        cleared = true
      }) as unknown as typeof clearInterval,
    })

    assert.ok(tick !== undefined, 'polling was scheduled')
    source.set(GOOD(2, 'second'), 'v2')
    tick()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(loader.current.version, 2)
    loader.stop()
    assert.ok(cleared)
  })
})

describe('FileFlowSource', () => {
  it('loads from disk and notices an edit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-'))
    const path = join(dir, 'flow.yaml')
    await writeFile(path, GOOD(1, 'first'), 'utf8')

    const loader = await FlowLoader.create(new FileFlowSource(path))
    assert.equal(loader.current.version, 1)
    assert.equal(loader.current.scriptVersionId, null, 'a file has no script_versions row')

    // The fingerprint is mtime plus size, and both strings differ in length here.
    await writeFile(path, GOOD(2, 'a longer greeting'), 'utf8')
    assert.equal(await loader.reload(), true)
    assert.equal(loader.current.version, 2)
  })
})

describe('validation messages', () => {
  it('names the path of the offending key', () => {
    const result = safeParseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A:
    say: hi
    on:
      acknowledge: { goto: 42 }
`)
    assert.ok(!result.ok)
    assert.ok(
      result.issues.some((i) => i.path.includes('states.A.on.acknowledge')),
      `expected a path naming the key, got ${JSON.stringify(result.issues)}`,
    )
  })

  it('rejects an unknown key rather than ignoring it', () => {
    const result = safeParseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi, tremninal: true }
`)
    assert.ok(!result.ok, 'a typo’d key must not be silently dropped')
  })

  it('rejects an unknown language in a line body', () => {
    const result = safeParseFlow(`
version: 1
initial: A
lines: { hi: { fr-FR: "bonjour" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi }
`)
    assert.ok(!result.ok)
  })
})
