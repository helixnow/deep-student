# Closure Task 1 gate report (phase5 + migration lock)

Scope: closure-plan.md Task 1 only. No tests, builds, staging, commits, or production changes were made by this hand; main owns rerun/review/verification.

## 1. phase5_tool_execution_e2e stale source assertion

- File: `src-tauri/tests/phase5_tool_execution_e2e.rs`
- Changed line: 212 (inside `user_todo_executor_runs_crud_occ_trash_restore_and_reorder_on_production_vfs`)
  - before: `assert_eq!(create_list_event["source"], "ai");`
  - after: `assert_eq!(create_list_event["source"], "agent");`
- Only this line changed; the adjacent `entityIds` assertion and all runId/CRUD/OCC/trash/restore/reorder checks are untouched.

Rationale (canonical source is `agent`):

- `docs/dev/acr/ACR-4.0.md:121` (A1 record): Rust domain-event source unified `"ai" → "agent"`.
- `src-tauri/src/chat_v2/tools/user_todo_executor.rs:267-269`: `emit_todo_changed` emits `"source": "agent"` with the ACR 4.0 comment; no production reversion.
- Legacy compatibility remains on the frontend: `src/features/workbench/agent/domainEvents.ts:286,295` and `drivers/todoDriver.ts:87` / `drivers/finderDriver.ts:90` normalize `"ai"` to `"agent"`.

Evidence: main's RED `docs/handwriting-annotation/verification/closure-phase5-red-r1.log` exits 101 and fails at `tests/phase5_tool_execution_e2e.rs:212` with `left: String("agent")` vs `right: "ai"`.

## 2. Migration static lock

- Command run (generator only): `node scripts/check-migrations.mjs --update`
- Exit code: 0; output: `已写入 src-tauri/migrations/migration-lock.json` / `✅ 迁移静态门禁通过（135 个迁移文件）`.

Diff on `src-tauri/migrations/migration-lock.json` adds exactly three entries, no other edits:

| database | version | name | sha256 |
| --- | --- | --- | --- |
| chat_v2 | 20260911 | chat_block_ink_artifacts | `36f74c669259d2be3efff5bc5eec43c7f1067177097961535df3fe615027933e` |
| chat_v2 | 20260912 | ink_tool_undo | `316226fdfd6f2a6286f6d53a03e1b85679f1e1aab42294b0e20c93efafa77f44` |
| vfs | 20261103 | ink_render_artifacts | `e6ce8747a6ba52882782477b5ec7b440449b4e6b13f93c03ec7818a3ebc7ca2b` |

Verification performed on the before/after JSON:

- entries 132 → 135; added exactly the three paths above; removed 0; changed 0.
- every pre-existing entry byte-identical (path/sha256/dangers unchanged), original order preserved.
- `version` and `generatedBy` unchanged.
- each recorded sha256 equals `sha256sum` of the corresponding new SQL file.
- the generator did not touch `src-tauri/tests/fixtures/migrations/manifest.json` (its pre-existing diff/mtime is from earlier work).

RED evidence: main's `docs/handwriting-annotation/verification/closure-migration-red-r1.log` exits 1 with exactly the same three files reported unlocked.

## 3. Phase5 GTK single-App isolation (green-r1 failure)

Root cause: the harness is `harness = false` with a custom `main` that ran both async cases sequentially in one process. Each case calls `create_harness`, which builds a new Tauri default app; tao can export only one `/org/gtk/Application/anonymous` per process, so the second build aborts at `tao-0.35.3/src/platform_impl/linux/event_loop.rs:217`. Main's log: `docs/handwriting-annotation/verification/closure-phase5-green-r1.log` (line 212 assertion no longer fails; the GTK panic follows).

Fix (only `src-tauri/tests/phase5_tool_execution_e2e.rs`, lines 807-903): parent/child subprocess self-isolation, following the existing `device_identity_tests.rs` / `sync_android_restart.rs` probe pattern but without libtest (this binary is `harness = false`).

- `PHASE5_CASES` (807-810): the two case functions are the registry; the parent iterates it so any added case is automatically isolated.
- `run_case` (814-832): child path; builds one current-thread runtime and runs exactly one named case. Unknown names panic (no skipping).
- `run_case_in_subprocess` (843-885): parent path; spawns `current_exe --case <name>` with piped stdout/stderr drained by reader threads. Polls `try_wait` every 50 ms with a 180 s timeout; on timeout kills/waits the child and panics with captured output.
- `main` (887-903): no args → parent runs every registered case. A failed child prints its captured stdout/stderr and the parent calls `std::process::exit(status.code().unwrap_or(1))`, propagating the true exit code. `--case <name>` → child runs only that case.

Each case therefore gets a fresh process, fresh GTK Application, fresh TempDirs, and fresh event listeners; independence is by process boundary, not by sharing one App/event loop.

Commands (main runs):

```bash
# all registered cases (currently the two async case functions)
xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --test phase5_tool_execution_e2e

# one case
xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --test phase5_tool_execution_e2e -- --case user_todo_executor_runs_crud_occ_trash_restore_and_reorder_on_production_vfs
xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --test phase5_tool_execution_e2e -- --case automation_executor_runs_db_occ_events_restore_contracts_and_manual_wrapper
```

The file currently registers two case functions (todo CRUD/OCC and automation); the parent runs all of them. No selector is dropped or ignored.

## 4. Phase5 green-r2: kill-switch admission in the automation case

Main's `closure-phase5-green-r2.log`: todo case PASSED; automation child panicked in `structured_error` (line 177) because the failed result's `error` was not JSON.

Root cause (production contract unchanged; no production edit):

- `AutomationExecutor` is unmodified at HEAD `5ea56e40`. It returns `ToolResultInfo::failure` (output `Null`) and JSON strings for OCC (`automation_occ_required_error`) and version conflicts (`serialize_automation_update_error`). Canonical structured diagnostics live in `result.error`; they were not moved to `result.output`.
- The plain error belongs to `automation-run-now-stale` / tool `automation_run_now`, input `{"id":"<test automation>","expected_version":"<stale version>"}`. `run_automation_now_core` checks admission before version: `admit_or_block_from_app` failed closed with `KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE` because the harness app never managed `ChatV2State`.
- Not a `can_handle`/prefix problem: earlier automation calls dispatch normally, and this is the first `run_now` call that passes argument parsing.

Fixes (test-only, `src-tauri/tests/phase5_tool_execution_e2e.rs`):

- line 10 + line 65: harness now manages `Arc<ChatV2State>` like production startup, so kill-switch admission succeeds.
- lines 171-184: `structured_error` keeps parsing `result.error` (canonical) but its panic now includes `tool_name`, `input`, `error`, and `output`, naming the exact failing call without weakening assertions.
- lines 757-778: directly verified drift corrected — `run_now` returns `"result.status": "started"` (notify delivery is asynchronous), not `"notified"`; run history waits up to 5 s for the claimed manual run to leave `"running"`, then retains the existing one-run/manual/non-running assertions.

No production changes; no tests/builds run by this hand.

## Concerns / open items for main

- `--update` only generates the manifest; acceptance still requires main to rerun check mode (`node scripts/check-migrations.mjs`) and the migration tests.
- The subprocess fix has not been compiled or run by this hand (per instruction); main's green run is the first verification. Watch for the child binary path resolution under `xvfb-run` and the 180 s timeout margin.
- If a future case hangs, the parent kills it and fails with captured stdout/stderr; no failure is swallowed.
- No speculative fixes were applied to other assertions or production code.
