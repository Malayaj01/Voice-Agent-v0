# Database

Postgres schema for ARCHITECTURE.md §8.

## Applying

Migrations are plain SQL, applied in filename order. There is no runner yet — one lands
with Phase 4, when migrations start running anywhere other than a local machine.

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

## Ordering

`script_versions` is first because both `campaigns` and `calls` reference it. Otherwise the
files are grouped by concern, not by table count.

| File | Tables |
|---|---|
| `0001_script_versions.sql` | `script_versions` |
| `0002_campaigns_leads.sql` | `campaigns`, `leads` |
| `0003_compliance.sql` | `consent_records`, `dnc` |
| `0004_calls_turns.sql` | `calls`, `turns` |
| `0005_faq_entries.sql` | `faq_entries` |

## The flow (script_versions)

`seed/flow-v1.yaml` is the conversation flow — ARCHITECTURE.md §7.1. It is authored as a
file and published into `script_versions`, which is what workers read.

```bash
# validate before anything else; --strict also fails on dead lines and unreachable states
npx voice-flow validate db/seed/flow-v1.yaml --strict

# every line the flow can actually say, for one lead, with §6 TTS cache keys
npx voice-flow render db/seed/flow-v1.yaml --lang hi-IN-hinglish --voice bulbul-v3 \
  --lead lead.json > precache.json

# write it to script_versions; --activate makes it the version new calls use
DATABASE_URL=... npx voice-flow publish db/seed/flow-v1.yaml --activate
```

`render` lists **reachable** lines, not every declared line: rendering audio for a line the
graph cannot reach wastes synthesis and hides the fact that it is dead. It exits non-zero if
any line still holds an unfilled `{{placeholder}}`, because such a line's cache key is never
looked up and the pre-cache would silently miss on it.

Workers poll for a new active version (`FLOW_POLL_MS`, default 30s) and hot-swap. A version
that fails validation never replaces a good one — the worker keeps serving the last good flow
and reports `degraded`. Calls already in progress keep the version they started with, so the
`script_version_id` stamped on the call row stays true (§7.5).

## Extensions

- `pgcrypto` — `gen_random_uuid()`
- `vector` (pgvector) — FAQ retrieval. Must be installed on the server; managed Postgres
  usually offers it as an opt-in extension.

## Notes

- **Phone numbers are E.164**, enforced by CHECK constraints on every column that holds one.
- Row types in `packages/shared/src/domain.ts` mirror these tables. Change both in the
  same commit.
- `calls.prompt_version_id` has no foreign key: §8 lists the column but defines no
  `prompt_versions` table. Add the FK when that table exists.
- `faq_entries.embedding` is `vector(768)` as a placeholder — the dimension must match the
  chosen embedding model (§11 open question).
