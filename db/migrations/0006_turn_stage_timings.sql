-- 0006 · turns: the remaining §6 stages, and barge-in
--
-- A deliberate extension of the §8 schema, not a correction of it.
--
-- §6 names six stages between "caller stops speaking" and "audio reaches caller" and says to
-- alert on p95 PER STAGE. §8 gives `turns` four timing columns, leaving the FSM decision and
-- the egress hop unmeasurable — so a turn could breach the 800ms budget with no column able
-- to say which half was responsible.
--
-- `barged_in` records that the caller interrupted this line. Without it there is no way to
-- ask which lines get talked over, which is the main thing the openings and rebuttals need
-- to be scored on (§7.5, §10.4).

ALTER TABLE turns
    ADD COLUMN t_fsm_ms     integer,
    ADD COLUMN t_egress_ms  integer,
    ADD COLUMN barged_in    boolean NOT NULL DEFAULT false;

-- Which lines get interrupted, and how often.
CREATE INDEX turns_barged_in_idx ON turns (state) WHERE barged_in;
