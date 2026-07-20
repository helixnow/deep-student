# Migration CI tooling

Layered database-migration gating used by `.github/workflows/ci.yml`,
`.github/workflows/migration-nightly.yml` and `.github/workflows/release.yml`.
Kept in its own directory so it never collides with the static checkers in
`scripts/` (e.g. `scripts/check-migrations.mjs`, owned by the migration
static-gate work).

## Layers

| Tier | Where | What runs |
|------|-------|-----------|
| PR / branch push | `ci.yml` → `migration-gate` | `node scripts/check-migrations.mjs` (static gate), production `data_governance` migration tests with a **non-zero test-count check**, representative fixture upgrades (skips loudly when the fixture secret is unavailable, e.g. fork PRs) |
| main / nightly | `migration-nightly.yml` | Full fixture upgrades + fault-injection + scale entrypoints. Missing fixture secret ⇒ explicit non-blocking skip |
| Release | `release.yml` → `migration-compatibility-gate` | Everything above but **fail-closed**: missing fixtures or expired E2E waivers block the release. Emits the machine-readable `migration-compatibility-report` artifact |

## Tools

- `run-migration-tests.sh` — runs `cargo test --lib data_governance::migration`
  (the *production* unified-migration framework tests; the old
  `cargo test --test migration_tests` target is feature-gated to emptiness and
  was a fake green). Parses the cargo summary and fails unless at least
  `--min-tests` tests actually passed.
- `fetch-fixtures.sh` — obtains fixture app-data directories, either
  checked-in under `src-tauri/tests/migration-fixtures/<tier>/` or from the
  private archive pointed to by the `MIGRATION_FIXTURE_URL` secret
  (integrity-pinned by `MIGRATION_FIXTURE_SHA256`, optional bearer
  `MIGRATION_FIXTURE_TOKEN`). `--mode skip` = explicit non-blocking skip,
  `--mode require` = fail-closed (release).
- `fixture-upgrade-harness.rs` — Rust integration-test template that drives
  the production `MigrationCoordinator::run_all()` against each fixture case.
  Modes: `upgrade`, `fault` (corrupts DBs, requires a surfaced failure),
  `scale` (upgrade + wall-clock budget). Run by…
- `run-fixture-upgrades.sh` — runs the gate test
  `src-tauri/tests/migration_fixture_upgrade_gate.rs`. If that file is already
  committed it must be byte-identical to the template (the script fails
  loudly on drift and never deletes a pre-existing file); if absent, the
  template is installed for the run and removed afterwards. The run fails
  unless ≥ 1 test actually executed (no feature-gated fake green).
- `generate-report.mjs` — writes the migration compatibility report
  (`deep-student/migration-compatibility-report@1`): candidate commit, tag,
  platform, fixture hash + per-case results, executed test count,
  release-requirements outcome.
- `verify-release-requirements.mjs` + `release-requirements.json` — honest
  gate for real-artifact upgrade E2E on macOS/Windows/Linux/Android. The repo
  has no upgrade-E2E driver today, so instead of an always-green placeholder
  job, each platform requirement carries an explicit dated waiver. Expired
  waiver or missing driver capability ⇒ the release **fails** until a driver
  (`scripts/migration-ci/e2e/upgrade-<platform>.*`) lands or the waiver is
  consciously renewed in code review. Once a driver script exists it must be
  executed and pass for every release (`--results`).

## Fixture archive layout

```
fixtures.tar.gz
├── representative/<case>/   # small, PR-tier cases
├── full/<case>/             # complete historical matrix (main/nightly/release)
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
