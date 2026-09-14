import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { parseFlow } from './flow.js'
import { Fsm } from './fsm.js'
import { analyseReachability } from './reachability.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const FLOW = parseFlow(readFileSync(join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml'), 'utf8'))

const VARS = {
  contact_first_name: 'Rahul',
  company: 'Lipi',
  company_name: 'Acme Clinics',
  industry: 'healthcare',
  slot_pair: 'Monday 11 or Tuesday 3',
  slot_first: 'Monday 11',
  slot_booked: 'Monday 11',
  anchor_question: 'Got a minute?',
}

/** The 19 labels the flow branches on, plus one the classifier can emit but no rule names. */
const INTENTS = [
  'acknowledge',
  'interested',
  'not_interested',
  'already_use_competitor',
  'send_email',
  'how_much',
  'is_this_ai',
  'no_time',
  'who_gave_number',
  'call_later',
  'hostile',
  'wrong_person',
  'voicemail',
  'gatekeeper',
  'accept_slot',
  'decline_slots',
  'give_availability',
  'dnc',
  'unclear',
]

/** Deterministic PRNG, so a failure reproduces exactly. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('reachability agrees with the FSM', () => {
  /**
   * The property the pre-cache depends on: everything the machine can ever say must be in the
   * reachable set. A line spoken but not analysed is a cache miss at call time — 0ms TTS
   * silently becoming 250ms, with no error anywhere to notice it by.
   *
   * Walking the machine randomly is the check that the analysis was not merely written to
   * look like Fsm.advance(), but actually behaves like it.
   */
  it('every line the machine speaks across 400 random calls is analysed as reachable', () => {
    const reachable = new Set(
      analyseReachability(FLOW, 'en-IN', VARS)
        .lines.map((l) => l.id)
        .filter((id): id is string => id !== null),
    )

    const spoken = new Set<string>()
    const rand = lcg(20260914)

    for (let call = 0; call < 400; call++) {
      const fsm = new Fsm({ flow: FLOW, lang: 'en-IN', vars: VARS })

      const opening = fsm.start()
      if (opening.line?.id != null) spoken.add(opening.line.id)

      for (let turn = 0; turn < 12 && !fsm.isEnded; turn++) {
        // Occasionally the caller says nothing at all.
        const decision =
          rand() < 0.15
            ? fsm.onSilence()
            : fsm.advance(INTENTS[Math.floor(rand() * INTENTS.length)] ?? 'unclear')
        if (decision.line?.id != null) spoken.add(decision.line.id)
      }
    }

    const unanalysed = [...spoken].filter((id) => !reachable.has(id)).sort()
    assert.deepEqual(unanalysed, [], 'these lines get spoken but would never be pre-cached')

    // Sanity: the walk has to actually exercise the flow for the assertion above to mean
    // anything.
    assert.ok(spoken.size >= 15, `walk only reached ${spoken.size} lines`)
  })

  it('reports no dead lines or states in the shipped flow', () => {
    const report = analyseReachability(FLOW, 'en-IN', VARS)

    assert.deepEqual(report.unreachableLineIds, [])
    assert.deepEqual(report.unreachableStates, [])
    assert.deepEqual(report.missingLineIds, [])
  })

  it('renders every reachable line fully, so each one is cacheable', () => {
    const report = analyseReachability(FLOW, 'en-IN', VARS)
    const unrendered = report.lines.filter((l) => l.text.includes('{{'))

    assert.deepEqual(
      unrendered.map((l) => l.id),
      [],
      'a leftover placeholder differs per lead, so its cache key is never hit',
    )
  })

  it('keys the cache on the voice, so two voices do not collide', () => {
    const a = analyseReachability(FLOW, 'en-IN', VARS, { voiceId: 'bulbul-v3' })
    const b = analyseReachability(FLOW, 'en-IN', VARS, { voiceId: 'kokoro' })

    assert.notEqual(a.lines[0]?.cacheKey, b.lines[0]?.cacheKey)
    assert.equal(a.lines[0]?.text, b.lines[0]?.text)
  })
})

describe('reachability diagnostics', () => {
  it('spots a line shadowed by an earlier unconditional objection rule', () => {
    const flow = parseFlow(`
version: 1
initial: A
lines:
  hi: { en-IN: "hi" }
  hangup: { en-IN: "understood" }
  reb_no_time: { en-IN: "just a moment" }
objections:
  intents: [no_time]
  rules:
    - when: { intent_in: [no_time] }
      say: hangup
      goto: A
      end: true
    - say: reb_no_time
      goto: A
states:
  A: { say: hi }
`)
    const report = analyseReachability(flow, 'en-IN', {})
    assert.deepEqual(report.unreachableLineIds, ['reb_no_time'])
  })

  it('keeps a line reachable when the rule above it is conditional', () => {
    const flow = parseFlow(`
version: 1
initial: A
lines:
  hi: { en-IN: "hi" }
  second_time: { en-IN: "again?" }
  first_time: { en-IN: "sure" }
objections:
  intents: [not_interested]
  rules:
    - when: { repeated: true }
      say: second_time
      goto: A
    - say: first_time
      goto: A
states:
  A: { say: hi }
`)
    const report = analyseReachability(flow, 'en-IN', {})
    assert.deepEqual(report.unreachableLineIds, [], 'a guard that can fail does not shadow')
  })

  it('spots a state nothing can reach', () => {
    const flow = parseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi }
  ORPHAN: { say: hi }
`)
    assert.deepEqual(analyseReachability(flow, 'en-IN', {}).unreachableStates, ['ORPHAN'])
  })

  it('reports a templated say whose expansion has no line', () => {
    const flow = parseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" }, rebuttal_known: { en-IN: "ok" } }
objections:
  intents: [known, missing_one]
  rules:
    - say: rebuttal_{{intent}}
      goto: A
states:
  A: { say: hi }
`)
    assert.deepEqual(analyseReachability(flow, 'en-IN', {}).missingLineIds, [
      'rebuttal_missing_one',
    ])
  })
})
