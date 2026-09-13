-- 0003 · consent_records, dnc
-- ARCHITECTURE.md §2. Under TRAI's DLT framework consent is a first-class table, not an
-- afterthought. Penalty for a non-compliant call is Rs 1,000-10,000 — EACH.

CREATE TABLE consent_records (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164     text        NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    -- The consent id registered on DLT. Without it a promotional call is not legitimate.
    dlt_consent_id text        NOT NULL,
    source         text        NOT NULL,
    granted_at     timestamptz NOT NULL,
    expires_at     timestamptz,
    revoked_at     timestamptz
);

-- The dialer's consent gate reads this: valid = granted, not revoked, not expired.
CREATE INDEX consent_active_idx ON consent_records (phone_e164, granted_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE dnc (
    phone_e164 text PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    reason     text        NOT NULL,
    source     text        NOT NULL CHECK (source IN ('own', 'DND_registry')),
    added_at   timestamptz NOT NULL DEFAULT now()
);
