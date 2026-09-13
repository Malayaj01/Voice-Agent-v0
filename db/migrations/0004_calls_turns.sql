-- 0004 · calls, turns
-- `calls` is the fact table for all reporting. `turns` carries the per-stage latency
-- breakdown — ARCHITECTURE.md §6 and §8.

CREATE TABLE calls (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id       uuid NOT NULL REFERENCES campaigns (id),
    lead_id           uuid NOT NULL REFERENCES leads (id),
    -- Version stamping (§7.5) is what makes conversion attributable to a script revision.
    script_version_id uuid NOT NULL REFERENCES script_versions (id),
    -- §8 lists this column but defines no prompt_versions table yet; left FK-less until it
    -- exists rather than inventing a schema for it here.
    prompt_version_id uuid,
    provider_call_id  text,
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    duration_s        integer CHECK (duration_s IS NULL OR duration_s >= 0),
    connected         boolean NOT NULL DEFAULT false,
    disposition       text CHECK (disposition IS NULL OR disposition IN (
                          'connected', 'no_answer', 'busy', 'failed',
                          'voicemail', 'dnc_requested', 'hangup')),
    lead_score        numeric(5, 2),
    next_action       text,
    recording_uri     text
);

CREATE INDEX calls_campaign_started_idx ON calls (campaign_id, started_at DESC);
CREATE INDEX calls_lead_idx ON calls (lead_id);
CREATE UNIQUE INDEX calls_provider_call_idx ON calls (provider_call_id)
    WHERE provider_call_id IS NOT NULL;

CREATE TABLE turns (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id uuid     NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    seq     integer  NOT NULL,
    role    text     NOT NULL CHECK (role IN ('caller', 'agent')),
    text    text     NOT NULL,
    intent  text,
    state   text,

    -- Per-stage latency. Alert on p95 PER STAGE: total-only telemetry tells you that you
    -- are slow, never where. Budget: endpoint 300 / stt 200 / intent 150 /
    -- tts_first_byte 250, total p95 < 800ms.
    t_endpoint_ms       integer,
    t_stt_ms            integer,
    t_intent_ms         integer,
    t_tts_first_byte_ms integer,

    UNIQUE (call_id, seq)
);

CREATE INDEX turns_call_idx ON turns (call_id, seq);
