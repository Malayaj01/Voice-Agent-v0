/**
 * These pin the TRAI/DLT rules from §2. Each one is worth a specific amount of money: a
 * non-compliant call is Rs 1,000-10,000, and at 2,000 calls/day a gate that silently stops
 * working is roughly Rs 2 crore/day of exposure plus a blacklisted number.
 *
 * So they are written as "this call must be refused", not as coverage.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toE164 } from '../ids.js'
import {
  DIAL_GATES,
  DialBlockedError,
  assertDialAllowed,
  evaluateGates,
  type DialFacts,
} from './gates.js'

const NOW = new Date('2026-09-21T06:30:00Z') // 12:00 IST — inside any sane window

function facts(overrides: Partial<DialFacts> = {}): DialFacts {
  return {
    phoneE164: toE164('+919876543210'),
    promotional: true,
    registration: {
      peRegistered: true,
      tmRegistered: true,
      linkageActive: true,
      numberSeries: '140x',
    },
    onDnc: false,
    consent: {
      dltConsentId: 'DLT-CONSENT-1',
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: null,
      revokedAt: null,
    },
    activeHours: { startHour: 9, endHour: 21, timeZone: 'Asia/Kolkata' },
    callsInWindow: 0,
    frequencyCap: 3,
    now: NOW,
    ...overrides,
  }
}

function failed(f: DialFacts): string[] {
  return evaluateGates(f)
    .filter((r) => !r.passed)
    .map((r) => r.gate)
}

describe('dial gates', () => {
  it('evaluates every declared gate, so none can be silently skipped', () => {
    const results = evaluateGates(facts())
    assert.deepEqual(
      results.map((r) => r.gate).sort(),
      [...DIAL_GATES].sort(),
      'evaluateGates must cover DIAL_GATES exactly',
    )
  })

  it('allows a fully compliant call', () => {
    assert.deepEqual(failed(facts()), [])
    assert.doesNotThrow(() => assertDialAllowed(facts()))
  })
})

describe('DLT registration — §2', () => {
  it('refuses without Principal Entity registration', () => {
    const f = facts()
    f.registration.peRegistered = false
    assert.deepEqual(failed(f), ['dlt_registration'])
  })

  it('refuses without Telemarketer registration', () => {
    const f = facts()
    f.registration.tmRegistered = false
    assert.deepEqual(failed(f), ['dlt_registration'])
  })

  it('refuses when the PE-TM linkage is inactive, even with both registered', () => {
    const f = facts()
    f.registration.linkageActive = false
    assert.deepEqual(failed(f), ['dlt_registration'])
  })

  /** The specific violation §2 calls out: a sales bot on an ordinary number. */
  it('refuses a promotional call from a non-140x number', () => {
    const f = facts()
    f.registration.numberSeries = '1600'
    const [result] = evaluateGates(f).filter((r) => r.gate === 'dlt_registration')

    assert.equal(result?.passed, false)
    assert.match(result?.reason ?? '', /140x/)
  })

  it('refuses a number with no registered series at all', () => {
    const f = facts()
    f.registration.numberSeries = null
    assert.deepEqual(failed(f), ['dlt_registration'])
  })

  it('allows a transactional call on a 1600 number', () => {
    const f = facts({ promotional: false })
    f.registration.numberSeries = '1600'
    assert.deepEqual(failed(f), [])
  })
})

describe('consent', () => {
  it('refuses a promotional call with no DLT consent id', () => {
    const f = facts()
    f.consent.dltConsentId = null
    assert.deepEqual(failed(f), ['has_valid_consent'])
  })

  it('refuses when consent has been revoked', () => {
    const f = facts()
    f.consent.revokedAt = new Date('2026-06-01T00:00:00Z')
    assert.deepEqual(failed(f), ['has_valid_consent'])
  })

  it('refuses when consent has expired', () => {
    const f = facts()
    f.consent.expiresAt = new Date('2026-09-01T00:00:00Z')
    assert.deepEqual(failed(f), ['has_valid_consent'])
  })

  it('allows consent that expires in the future', () => {
    const f = facts()
    f.consent.expiresAt = new Date('2027-01-01T00:00:00Z')
    assert.deepEqual(failed(f), [])
  })

  /** Consent is the promotional regime; a service call is not under it. */
  it('does not require consent for a transactional call', () => {
    const f = facts({ promotional: false })
    f.consent.dltConsentId = null
    f.registration.numberSeries = '1600'
    assert.deepEqual(failed(f), [])
  })
})

describe('calling hours', () => {
  it('refuses a call before the window opens', () => {
    // 03:00 UTC is 08:30 IST — half an hour early.
    assert.deepEqual(failed(facts({ now: new Date('2026-09-21T03:00:00Z') })), [
      'within_active_hours',
    ])
  })

  it('refuses a call after the window closes', () => {
    // 16:00 UTC is 21:30 IST.
    assert.deepEqual(failed(facts({ now: new Date('2026-09-21T16:00:00Z') })), [
      'within_active_hours',
    ])
  })

  it('allows a call at the opening hour and refuses at the closing hour', () => {
    // 03:35 UTC = 09:05 IST, inside. 15:35 UTC = 21:05 IST, outside.
    assert.deepEqual(failed(facts({ now: new Date('2026-09-21T03:35:00Z') })), [])
    assert.deepEqual(failed(facts({ now: new Date('2026-09-21T15:35:00Z') })), [
      'within_active_hours',
    ])
  })

  it('evaluates the window in the campaign timezone, not the server one', () => {
    // 20:00 UTC is 01:30 IST the next day — the middle of the night for the callee.
    assert.deepEqual(failed(facts({ now: new Date('2026-09-21T20:00:00Z') })), [
      'within_active_hours',
    ])
  })
})

describe('dnc and frequency', () => {
  it('refuses a number on the DNC list', () => {
    assert.deepEqual(failed(facts({ onDnc: true })), ['not_on_dnc'])
  })

  it('refuses once the frequency cap is reached', () => {
    assert.deepEqual(failed(facts({ callsInWindow: 3, frequencyCap: 3 })), [
      'under_frequency_cap',
    ])
    assert.deepEqual(failed(facts({ callsInWindow: 2, frequencyCap: 3 })), [])
  })
})

describe('assertDialAllowed', () => {
  /**
   * Throwing rather than returning a boolean is the point: a caller that forgets to check a
   * boolean places the call anyway.
   */
  it('throws with every failure named, not just the first', () => {
    const f = facts({ onDnc: true, callsInWindow: 9 })
    f.registration.peRegistered = false

    assert.throws(
      () => assertDialAllowed(f),
      (err: unknown) => {
        assert.ok(err instanceof DialBlockedError)
        assert.deepEqual(
          err.failures.map((x) => x.gate).sort(),
          ['dlt_registration', 'not_on_dnc', 'under_frequency_cap'],
        )
        assert.match(err.message, /dial blocked by 3 compliance gate/)
        return true
      },
    )
  })

  it('returns the passing results when the call is allowed', () => {
    const results = assertDialAllowed(facts())
    assert.equal(results.length, DIAL_GATES.length)
    assert.ok(results.every((r) => r.passed))
  })
})
