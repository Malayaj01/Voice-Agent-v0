/**
 * These pin the behaviour ported from the predecessor's stateMachine.ts. Each test names the
 * rule it protects, because the rules are the product: a flow edit that breaks one of them is
 * a compliance or conversion regression, not a failing unit test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { Fsm } from './fsm.js'
import { parseFlow, type Flow } from './flow.js'
import { enumerateLines, interpolate, lineCacheKey } from './lines.js'

/** dist/script/ -> packages/shared -> repo root */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const FLOW_PATH = join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml')

const FLOW: Flow = parseFlow(readFileSync(FLOW_PATH, 'utf8'))

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

function fsm(lang: 'en-IN' | 'hi-IN-hinglish' = 'en-IN'): Fsm {
  return new Fsm({ flow: FLOW, lang, vars: VARS })
}

describe('flow document', () => {
  it('parses and every goto and say resolves', () => {
    assert.equal(FLOW.version, 1)
    assert.equal(FLOW.initial, 'OPENING')
  })

  it('rejects a goto pointing at a state that does not exist', () => {
    assert.throws(
      () =>
        parseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A:
    say: hi
    default: { goto: NOWHERE }
`),
        /unknown state "NOWHERE"/,
    )
  })

  it('rejects a say pointing at a line that does not exist', () => {
    assert.throws(
      () =>
        parseFlow(`
version: 1
initial: A
lines: { hi: { en-IN: "hi" } }
objections: { intents: [], rules: [] }
states:
  A:
    say: missing_line
`),
      /unknown line "missing_line"/,
    )
  })
})

describe('global rules — apply from any state', () => {
  it('dnc ends the call and flags it, mid-pitch', () => {
    const m = fsm()
    m.advance('acknowledge')
    m.advance('acknowledge')
    const d = m.advance('dnc')

    assert.equal(d.nextState, 'WRAP_UP')
    assert.ok(d.ended)
    assert.deepEqual(d.flags, ['do_not_call_requested'])
    assert.match(d.line?.text ?? '', /removing this number/i)
  })

  it('hostile ends the call through FALLBACK', () => {
    const d = fsm().advance('hostile')
    assert.equal(d.nextState, 'FALLBACK')
    assert.ok(d.ended)
    assert.deepEqual(d.flags, ['hostile_exit'])
  })

  it('wrong_person ends the call', () => {
    const d = fsm().advance('wrong_person')
    assert.ok(d.ended)
    assert.match(d.line?.text ?? '', /wrong person/i)
  })

  it('an off-script intent holds position instead of advancing', () => {
    const m = fsm()
    const d = m.advance('unclear')

    assert.equal(d.fromState, 'OPENING')
    assert.equal(d.nextState, 'OPENING', 'off-script must not advance the flow')
    assert.ok(!d.ended)
    assert.match(d.line?.text ?? '', /didn't catch that/i)
  })

  it('nothing advances after the call has ended', () => {
    const m = fsm()
    m.advance('dnc')
    const after = m.advance('interested')

    assert.equal(after.line, null)
    assert.ok(after.ended)
  })
})

describe('happy path', () => {
  it('walks OPENING -> CONTEXT_BRIDGE -> PITCH -> CLOSE -> booked', () => {
    const m = fsm()
    assert.match(m.start().line?.text ?? '', /Hi Rahul/)

    assert.equal(m.advance('acknowledge').nextState, 'CONTEXT_BRIDGE')
    assert.equal(m.advance('acknowledge').nextState, 'PITCH')
    assert.equal(m.advance('acknowledge').nextState, 'CLOSE')

    const booked = m.advance('accept_slot')
    assert.equal(booked.nextState, 'WRAP_UP')
    assert.ok(booked.ended)
    assert.match(booked.line?.text ?? '', /Monday 11/)
  })

  it('give_availability ends with the calendar link and a flag', () => {
    const m = fsm()
    m.advance('acknowledge')
    m.advance('acknowledge')
    m.advance('acknowledge')

    const d = m.advance('give_availability')
    assert.ok(d.ended)
    assert.deepEqual(d.flags, ['availability_captured'])
  })
})

describe('objection routine', () => {
  it('rebuts the first objection and moves to CLOSE', () => {
    const d = fsm().advance('not_interested')
    assert.equal(d.nextState, 'CLOSE')
    assert.ok(!d.ended)
    assert.match(d.line?.text ?? '', /if a short demo isn't useful/i)
  })

  it('a repeated not_interested ends the call', () => {
    const m = fsm()
    assert.ok(!m.advance('not_interested').ended)

    const second = m.advance('not_interested')
    assert.ok(second.ended, 'the same hard objection twice means stop')
    assert.equal(second.nextState, 'WRAP_UP')
  })

  it('a repeated who_gave_number ends the call', () => {
    const m = fsm()
    m.advance('who_gave_number')
    assert.ok(m.advance('who_gave_number').ended)
  })

  it('three distinct objections then not_interested ends the call', () => {
    const m = fsm()
    m.advance('how_much')
    m.advance('send_email')
    const third = m.advance('not_interested')

    assert.ok(third.ended, 'three objections deep and still not interested means stop')
  })

  it('no_time hangs up politely rather than rebutting', () => {
    const d = fsm().advance('no_time')
    assert.ok(d.ended)
    assert.match(d.line?.text ?? '', /won't take your time/i)
  })

  it('how_much never quotes a price — §7.4 deny-list', () => {
    const d = fsm().advance('how_much')
    assert.ok(!d.ended)
    assert.match(d.line?.text ?? '', /don't want to give you a random number/i)
    assert.doesNotMatch(d.line?.text ?? '', /\d+\s*(rs|rupees|\$|per month)/i)
  })

  it('is_this_ai discloses rather than deflecting', () => {
    const d = fsm().advance('is_this_ai')
    assert.match(d.line?.text ?? '', /AI assistant/i)
  })
})

describe('CLOSE', () => {
  function atClose(): Fsm {
    const m = fsm()
    m.advance('acknowledge')
    m.advance('acknowledge')
    m.advance('acknowledge')
    assert.equal(m.currentState, 'CLOSE')
    return m
  }

  it('acknowledge confirms the slot and stays in CLOSE', () => {
    const d = atClose().advance('acknowledge')
    assert.equal(d.nextState, 'CLOSE')
    assert.match(d.line?.text ?? '', /lock Monday 11/i)
  })

  it('decline_slots falls back to a calendar link', () => {
    const d = atClose().advance('decline_slots')
    assert.ok(d.ended)
    assert.match(d.line?.text ?? '', /calendar link/i)
  })
})

describe('silence', () => {
  it('nudges once, then hangs up on the second', () => {
    const m = fsm()
    const first = m.onSilence()
    assert.ok(!first.ended)
    assert.match(first.line?.text ?? '', /still there/i)

    const second = m.onSilence()
    assert.ok(second.ended)
    assert.deepEqual(second.flags, ['silence_hangup'])
  })

  it('a caller utterance resets the nudge count', () => {
    const m = fsm()
    m.onSilence()
    m.advance('acknowledge')

    assert.ok(!m.onSilence().ended, 'speaking resets the silence counter')
  })
})

describe('lines', () => {
  it('interpolates vars and leaves unknown placeholders visible', () => {
    assert.equal(interpolate('Hi {{contact_first_name}}', VARS), 'Hi Rahul')
    assert.equal(interpolate('Hi {{nope}}', VARS), 'Hi {{nope}}')
  })

  it('falls back to the default language when a line lacks the requested one', () => {
    const flow = parseFlow(`
version: 1
initial: A
default_lang: en-IN
lines: { hi: { en-IN: "English only" } }
objections: { intents: [], rules: [] }
states:
  A: { say: hi }
`)
    const m = new Fsm({ flow, lang: 'hi-IN-hinglish' })
    assert.equal(m.start().line?.text, 'English only')
  })

  it('speaks Hinglish when the line has it', () => {
    const d = fsm('hi-IN-hinglish').start()
    assert.match(d.line?.text ?? '', /Namaste Rahul/)
  })

  it('enumerates the closed set, which is what pre-caching iterates', () => {
    const lines = enumerateLines(FLOW, 'en-IN', VARS)

    assert.ok(lines.length > 15, 'the flow has a substantial closed set')
    assert.ok(
      lines.every((l) => !l.text.includes('{{')),
      'every line renders fully with a lead’s vars — anything left is uncacheable',
    )
  })

  it('cache keys separate voice and language for the same text', () => {
    const a = lineCacheKey('hello', 'v1', 'en-IN')
    assert.equal(a, lineCacheKey('hello', 'v1', 'en-IN'), 'stable')
    assert.notEqual(a, lineCacheKey('hello', 'v2', 'en-IN'))
    assert.notEqual(a, lineCacheKey('hello', 'v1', 'hi-IN-hinglish'))
  })
})
