# 0824 LLM Usage release compatibility

## Scope and baselines

- Candidate migration: `llm_usage/V20260824__add_cache_write_tokens.sql`
- Candidate base: `cursor/0824-cde6`
- Release baseline: `v0.9.44` (`1cf6cabc`)
- `v0.9.44` core schema tuple:
  - `vfs=20260808`
  - `chat_v2=20260806`
  - `mistakes=20260724`
  - `llm_usage=20260525`
- The migration remains one additive statement:
  `ALTER TABLE llm_usage_logs ADD COLUMN cache_write_tokens INTEGER`.
  The column has no `NOT NULL` or default constraint. Its contract is
  `NULL = unmeasured`, `0 = measured and no cache write`.

## Bugs found

1. **Interrupted V20260824 could block every later startup.**
   `MigrationCoordinator::make_alter_columns_safe` intentionally stops at
   `V20260801`. V20260824 was therefore passed back to Refinery even when its
   column already existed but its history row did not, causing
   `duplicate column name: cache_write_tokens`. The standalone
   `LlmUsageDatabase::ensure_schema` also ran Refinery directly and had no
   residue repair.
2. **Three usage parsers collapsed measured zero into unmeasured.**
   Chat V2 `parse_api_usage`, provider `build_usage_event`, and Model2
   `extract_usage_tokens` used `> 0`/`unwrap_or(0)` as the presence test.
   Explicit provider values of `0` became `None`/JSON `null`, violating the
   migration contract.
3. **Model2 parsed cache-write tokens and then discarded them.**
   Its extractor computed `cache_write_tokens`, returned only four tuple
   fields, and called `record_llm_usage_ext`, which intentionally writes NULL.
   Non-Chat-V2 Model2 calls therefore lost valid cache-write telemetry.
4. **The nightly fixture manifest had no exact v0.9.44 schema tuple.**
   Older `llm_usage=20260525` states were covered indirectly, but there was no
   release-labelled case pinning all four v0.9.44 schema versions.
5. **The frontend recent-usage type omitted `cacheWriteTokens`.**
   Rust serialized the optional field, but the TypeScript API contract did not
   expose it. The stats UI does not currently render cache-write data, so it
   was not manufacturing a false zero; the missing type still prevented safe
   future use of the nullable field.

## Fixes

- Add a dedicated V20260824 pre-repair in the coordinator. It marks the exact
  embedded migration complete only when `cache_write_tokens` already exists
  and the history row is absent while predecessor V20260525 is recorded. This
  is sound because V20260824 contains no DML or second statement to replay.
- Apply the same narrow repair in the direct `LlmUsageDatabase` initializer.
  The generic compatibility boundary remains `20260801`; it is not widened.
- Preserve field presence independently from numeric value in all three usage
  parsers and carry Model2 cache-write values through
  `record_llm_usage_cache_ext`.
- Add regression coverage for `Some(0)` versus `None`, interrupted migration
  repair, direct initialization, idempotent rerun, and old explicit-column
  inserts.
- Add a deterministic fixture with the exact v0.9.44 core schema tuple to the
  checked-in nightly fixture manifest.
- Add `cacheWriteTokens?: number` to the frontend API type. Omission means
  unmeasured; zero remains a valid value.

## Reader, writer, and report audit

- Production inserts in `llm_usage/repo.rs` and `llm_usage/collector.rs`
  explicitly bind `Option<u32>` into `cache_write_tokens`; `None` reaches
  SQLite as NULL and `Some(0)` reaches it as integer zero.
- Old v0.9.44-style inserts name their columns. The new nullable column may be
  omitted and receives NULL, so old binaries remain write-compatible after a
  downgrade.
- Recent-row reads use `Option<u32>` and preserve NULL.
- `scripts/cache-hit-report.py` probes `pragma_table_info` before selecting the
  new column. An old DB without the column is reported as unmeasured rather
  than failing. Its aggregation separately tracks measurement presence, so
  all-NULL renders `无测量` while explicit zero renders `0`.
- The current stats UI does not aggregate or render cache-write telemetry and
  therefore has no NULL-to-zero display path. The API type now preserves the
  optional contract for future UI work.

## Migration lock and rollback/rerun analysis

- The SQL file is unchanged by this release-compat patch, so its locked SHA-256
  remains `dc7fc74c894296bb9d95d65975608104e7ca2c238e5c141b9bd757367cee6bc2`.
- Normal v0.9.44 upgrade: old rows gain NULL; the migration is recorded once.
- Interrupted upgrade after ALTER but before history: dedicated repair writes
  the embedded name/checksum and avoids duplicate-column failure.
- Rerun/reopen: Refinery sees the recorded version and applies zero migrations.
- Downgrade to v0.9.44 without restoring the DB: SQLite tolerates the extra
  nullable column; old explicit-column reads/writes continue to work and new
  old-binary rows receive NULL.
- Restore of a true v0.9.44 DB: the column is absent and V20260824 runs normally.

## Verification

To be filled with the pushed fix SHA and final command results after the
pre-test implementation commit.

## Decision

**Provisional TAKE**, conditional on the focused Rust/parser/report tests,
migration static gate, v0.9.44 fixture upgrade, full production migration gate,
and TypeScript typecheck passing.
