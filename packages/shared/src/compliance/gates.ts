/**
 * TRAI/DLT dial gates — ARCHITECTURE.md §2.
 *
 * Every outbound commercial call from an Indian entity must be registered. TRAI draws no
 * distinction between an AI bot and a human caller, and the penalty is Rs 1,000-10,000 PER
 * NON-COMPLIANT CALL. At 2,000 calls/day that is roughly Rs 2 crore/day of exposure, plus the
 * number getting blacklisted.
 *
 * So these are not validations. They are the difference between a business and a fine.
 *
 * WHERE THIS LIVES. CLAUDE.md says compliance gates live in the dialer, in code — the point
 * being that they are never config and never assumed handled upstream. The RULES live here,
 * as pure functions over facts, so there is exactly one implementation; the dialer is what
 * runs them in production, and any other dial path (an operator placing a single call by
 * hand) has to run the same ones. Two implementations of this would be the actual hazard.
 *
 * Adding a gate: add it to DIAL_GATES and to evaluateGates. The list is exhaustive by
 * construction so a new gate cannot be silently skipped.
 */

import type { E164 } from '../ids.js'

export const DIAL_GATES = [
  /** PE + TM registered on DLT with an active linkage, dialling from a 140x number. §2 */
  'dlt_registration',
  /** Inside the TRAI-legal calling window. */
  'within_active_hours',
  /** Not on our own suppression list or the national DND registry. */
  'not_on_dnc',
  /** DLT-registered consent, granted, unexpired, unrevoked. */
  'has_valid_consent',
  /** Under the per-lead frequency cap. */
  'under_frequency_cap',
] as const

export type DialGate = (typeof DIAL_GATES)[number]

/** Number series. 140x is promotional/sales; 1600 is transactional/service. §2 */
export type NumberSeries = '140x' | '1600'

export interface RegistrationFacts {
  /** Principal Entity registered on DLT. */
  peRegistered: boolean
  /** Telemarketer registered — the entity placing calls on the PE's behalf. */
  tmRegistered: boolean
  /** PE-TM linkage active. Without it the calls are not legitimate even if both registered. */
  linkageActive: boolean
  /** The series the outbound number belongs to. */
  numberSeries: NumberSeries | null
}

export interface ConsentFacts {
  dltConsentId: string | null
  grantedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

export interface ActiveHours {
  /** Inclusive local hour the window opens. */
  startHour: number
  /** Exclusive local hour it closes. */
  endHour: number
  /** IANA zone the window is expressed in. */
  timeZone: string
}

export interface DialFacts {
  phoneE164: E164
  /** Promotional calls need DLT consent; transactional/service calls are a different regime. */
  promotional: boolean
  registration: RegistrationFacts
  onDnc: boolean
  consent: ConsentFacts
  activeHours: ActiveHours
  callsInWindow: number
  frequencyCap: number
  now: Date
}

export interface GateResult {
  gate: DialGate
  passed: boolean
  /** Why it failed. Recorded, because "the dialer refused" is not a diagnosis. */
  reason?: string
}

function hourIn(zone: string, at: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    hour12: false,
  }).format(at)
  return Number(hour)
}

function checkRegistration(f: DialFacts): GateResult {
  const { registration: r } = f
  const missing: string[] = []
  if (!r.peRegistered) missing.push('Principal Entity not registered on DLT')
  if (!r.tmRegistered) missing.push('Telemarketer not registered')
  if (!r.linkageActive) missing.push('PE-TM linkage not active')

  if (r.numberSeries === null) {
    missing.push('outbound number is not from a registered series')
  } else if (f.promotional && r.numberSeries !== '140x') {
    // A sales bot dialling from anything but 140x is a violation even when everything else
    // is in order — including from an ordinary 10-digit mobile.
    missing.push(`promotional calls require a 140x number, got ${r.numberSeries}`)
  }

  return missing.length === 0
    ? { gate: 'dlt_registration', passed: true }
    : { gate: 'dlt_registration', passed: false, reason: missing.join('; ') }
}

function checkHours(f: DialFacts): GateResult {
  const hour = hourIn(f.activeHours.timeZone, f.now)
  const inside = hour >= f.activeHours.startHour && hour < f.activeHours.endHour
  return inside
    ? { gate: 'within_active_hours', passed: true }
    : {
        gate: 'within_active_hours',
        passed: false,
        reason: `${hour}:00 ${f.activeHours.timeZone} is outside ${f.activeHours.startHour}:00-${f.activeHours.endHour}:00`,
      }
}

function checkConsent(f: DialFacts): GateResult {
  // Transactional/service calls are not under the promotional consent regime.
  if (!f.promotional) return { gate: 'has_valid_consent', passed: true }

  const { consent: c } = f
  if (c.dltConsentId === null || c.grantedAt === null) {
    return { gate: 'has_valid_consent', passed: false, reason: 'no DLT-registered consent' }
  }
  if (c.revokedAt !== null && c.revokedAt <= f.now) {
    return { gate: 'has_valid_consent', passed: false, reason: 'consent revoked' }
  }
  if (c.expiresAt !== null && c.expiresAt <= f.now) {
    return { gate: 'has_valid_consent', passed: false, reason: 'consent expired' }
  }
  return { gate: 'has_valid_consent', passed: true }
}

/** Evaluates every gate. Always returns one result per gate, pass or fail. */
export function evaluateGates(f: DialFacts): GateResult[] {
  return [
    checkRegistration(f),
    checkHours(f),
    f.onDnc
      ? { gate: 'not_on_dnc' as const, passed: false, reason: 'number is on the DNC list' }
      : { gate: 'not_on_dnc' as const, passed: true },
    checkConsent(f),
    f.callsInWindow >= f.frequencyCap
      ? {
          gate: 'under_frequency_cap' as const,
          passed: false,
          reason: `${f.callsInWindow} calls already, cap is ${f.frequencyCap}`,
        }
      : { gate: 'under_frequency_cap' as const, passed: true },
  ]
}

export class DialBlockedError extends Error {
  override readonly name = 'DialBlockedError'
  constructor(readonly failures: readonly GateResult[]) {
    super(
      `dial blocked by ${failures.length} compliance gate(s):\n` +
        failures.map((f) => `  ${f.gate}: ${f.reason ?? 'failed'}`).join('\n'),
    )
  }
}

/**
 * Throws unless every gate passes.
 *
 * Deliberately not a boolean. A caller that forgets to check a boolean places the call
 * anyway; a caller that forgets to catch this does not.
 */
export function assertDialAllowed(f: DialFacts): GateResult[] {
  const results = evaluateGates(f)
  const failures = results.filter((r) => !r.passed)
  if (failures.length > 0) throw new DialBlockedError(failures)
  return results
}
