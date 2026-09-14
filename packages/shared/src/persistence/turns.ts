/**
 * The `turns` write port.
 *
 * A port rather than a driver call, because the turn loop is the one latency-critical
 * process (§3) and must not learn about Postgres. The in-memory adapter is what the tests
 * drive; the Postgres adapter lives in the call worker next to its pool.
 *
 * Which row carries the timings, and why:
 *
 *   caller row -> text + the intent it classified to. Timings null.
 *   agent  row -> the line spoken, the state it moved to, and the COMPLETE §6 breakdown for
 *                 the exchange that produced it.
 *
 * The alternative — splitting the breakdown across the pair, endpoint/stt on the caller row
 * and the rest on the agent row — is arguably more literal, but it makes "p95 of total turn
 * latency" a window function over adjacent rows instead of a sum of columns on one row. §6
 * asks for per-stage p95 alerting; keeping a turn's six stages on a single row is what makes
 * that a plain aggregate.
 */

import type { TurnRole } from '../domain.js'
import type { TurnTimings } from '../latency.js'

export type { TurnRole }

export interface TurnWrite {
  callId: string
  /** Monotonic within a call; `turns` has UNIQUE (call_id, seq). */
  seq: number
  role: TurnRole
  text: string
  /** Set on caller rows; null on agent rows. */
  intent: string | null
  /** FSM state this row belongs to. */
  state: string | null
  timings: TurnTimings
  /** The caller talked over this line. Agent rows only. */
  bargedIn: boolean
}

export interface TurnSink {
  record(turn: TurnWrite): Promise<void>
}

/** Test and Phase-1 adapter. Keeps every row in order. */
export class InMemoryTurnSink implements TurnSink {
  readonly rows: TurnWrite[] = []

  record(turn: TurnWrite): Promise<void> {
    this.rows.push({ ...turn, timings: { ...turn.timings } })
    return Promise.resolve()
  }

  byRole(role: TurnRole): TurnWrite[] {
    return this.rows.filter((r) => r.role === role)
  }
}

/** Discards writes. For a smoke run where persistence is not the thing under test. */
export class NullTurnSink implements TurnSink {
  record(): Promise<void> {
    return Promise.resolve()
  }
}
