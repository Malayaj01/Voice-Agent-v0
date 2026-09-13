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
