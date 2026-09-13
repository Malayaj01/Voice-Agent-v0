/**
 * Turn-latency telemetry — ARCHITECTURE.md §6.
 *
 * Instrument every stage separately and alert on p95 PER STAGE.
 */

/** Stages between "caller stops speaking" and "audio reaches caller", in order. */
export const TURN_STAGES = [
  'endpoint',
  'stt',
  'intent',
  'fsm',
  'tts_first_byte',
  'egress',
] as const

export type TurnStage = (typeof TURN_STAGES)[number]

/** Per-stage p95 ceilings in ms. Breaching one of these is the alert, not the total. */
export const STAGE_BUDGET_MS: Readonly<Record<TurnStage, number>> = {
  endpoint: 300,
  stt: 200,
  intent: 150,
  fsm: 1,
  tts_first_byte: 250,
  egress: 100,
}

/** The product spec. §6 */
export const TURN_BUDGET_P95_MS = 800

export type TurnTimings = Partial<Record<TurnStage, number>>

export function totalMs(timings: TurnTimings): number {
  let total = 0
  for (const stage of TURN_STAGES) {
    total += timings[stage] ?? 0
  }
  return total
}

/** Stages that exceeded their individual budget. Empty array means the turn was healthy. */
export function breachedStages(timings: TurnTimings): TurnStage[] {
  return TURN_STAGES.filter((stage) => {
    const observed = timings[stage]
    return observed !== undefined && observed > STAGE_BUDGET_MS[stage]
  })
}
