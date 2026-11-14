# Migration CI tooling

Database migration checks for the Node Host. PRs run the SQL lock/checksum gate and exercise the production storage coordinator against representative historical data. The nightly workflow adds full fixture upgrades, failure handling and scale checks.

| Workflow | Coverage |
|---|---|
| `ci.yml` → `migration-gate` | Static migration gate, Host migration and backup tests, representative fixtures |
| `migration-nightly.yml` | Full fixture upgrades and fault tests, plus a scale run when its fixtures are available |

`fetch-fixtures.sh` selects the requested tier from checked-in fixtures or a private archive. When optional fixtures are absent, CI reports the skip. `generate-report.mjs` writes the nightly compatibility report.

## Fixture archive layout

```
fixtures.tar.gz
├── representative/<case>/   # small, PR-tier cases
├── full/<case>/             # complete historical matrix (nightly)
└── scale/<case>/            # large data-volume cases (nightly scale entry)
```

Each `<case>` is an app-data directory: `databases/vfs.db`, `chat_v2.db`,
`mistakes.db`, `llm_usage.db` (any subset; the coordinator creates missing
databases).

## Secrets

- `MIGRATION_FIXTURE_URL` — HTTPS URL of the fixture archive.
- `MIGRATION_FIXTURE_SHA256` — required pin for the archive.
- `MIGRATION_FIXTURE_TOKEN` — optional bearer token.

## Self-tests

```
node --test scripts/migration-ci/__tests__/*.test.mjs
```
