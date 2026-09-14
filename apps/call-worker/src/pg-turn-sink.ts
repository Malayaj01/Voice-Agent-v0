/**
 * Postgres adapter for the `turns` write port.
 *
 * Lives in the call worker rather than in shared, so the port stays free of a driver and the
 * turn loop keeps its single dependency direction: it knows about an interface, not a pool.
 *
 * The write is deliberately a plain INSERT with no read-back. It happens after the line has
 * been spoken, off the latency path, and a turn row is an observation — losing one to a
 * transient database error must never take down a live call, which is why `record` is called
 * in a position where a rejection surfaces as a logged failure rather than a dropped turn.
 */

import type { Pool } from 'pg'

import type { TurnSink, TurnWrite } from '@voice-agent/shared'

const INSERT = `
  INSERT INTO turns (
    call_id, seq, role, text, intent, state,
    t_endpoint_ms, t_stt_ms, t_intent_ms, t_tts_first_byte_ms, t_fsm_ms, t_egress_ms,
    barged_in
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`

/**
 * The t_*_ms columns are `integer`, and the clock produces fractional milliseconds. Rounding
 * here rather than at the measurement keeps full precision in memory for the in-process
 * budget checks, and only quantises at the storage boundary.
 */
function ms(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value)
}

export class PgTurnSink implements TurnSink {
  constructor(private readonly pool: Pool) {}

  async record(turn: TurnWrite): Promise<void> {
    await this.pool.query(INSERT, [
      turn.callId,
      turn.seq,
      turn.role,
      turn.text,
      turn.intent,
      turn.state,
      ms(turn.timings.endpoint),
      ms(turn.timings.stt),
      ms(turn.timings.intent),
      ms(turn.timings.tts_first_byte),
      ms(turn.timings.fsm),
      ms(turn.timings.egress),
      turn.bargedIn,
    ])
  }
}
