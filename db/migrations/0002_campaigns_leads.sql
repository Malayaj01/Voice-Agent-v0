-- 0002 · campaigns, leads

CREATE TABLE campaigns (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name              text        NOT NULL,
    script_version_id uuid        NOT NULL REFERENCES script_versions (id),
    -- Dialer pacing parameters; shape owned by the dialer.
    pacing            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- TRAI-legal calling window. Enforced in the dialer, in code — never assumed.
    active_hours      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   uuid    NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    name          text    NOT NULL,
    -- E.164 everywhere. A bare 10-digit number must never reach the dialer.
    phone_e164    text    NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    language      text    NOT NULL CHECK (language IN ('en-IN', 'hi-IN', 'hi-IN-hinglish')),
    priority_tier smallint NOT NULL DEFAULT 3 CHECK (priority_tier BETWEEN 1 AND 3),
    meta          jsonb   NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX leads_campaign_idx ON leads (campaign_id);
CREATE INDEX leads_phone_idx ON leads (phone_e164);

-- Supports the dialer's SKIP LOCKED claim: highest priority first within a campaign.
CREATE INDEX leads_claim_idx ON leads (campaign_id, priority_tier, id);
