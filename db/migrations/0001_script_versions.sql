-- 0001 · script_versions
-- ARCHITECTURE.md §7.1: the conversation flow is YAML DATA, versioned and hot-reloadable —
-- never TypeScript functions. campaigns and calls both reference this table, so it is first.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE script_versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version    integer     NOT NULL UNIQUE,
    yaml       text        NOT NULL,
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    active     boolean     NOT NULL DEFAULT false
);

-- At most one active script version at a time.
CREATE UNIQUE INDEX script_versions_one_active
    ON script_versions ((active)) WHERE active;
