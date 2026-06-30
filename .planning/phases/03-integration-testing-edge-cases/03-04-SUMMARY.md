---
phase: 03-integration-testing-edge-cases
plan: 04
subsystem: backend-testing
tags: [rust, sqlite, wal, tool_pack, vfs]

requires:
  - phase: 03-integration-testing-edge-cases
    plan: 03
    provides: "Real built-in ToolPack registry and Chat V2 DB helper"
provides:
  - "Executable shared-state audit for selected real ToolPack sub-tools"
  - "VFS todo write-load ToolPack contention coverage with Chat V2 tool-block persistence"
  - "Repeated 20-sub-tool write-load regression guard against SQLite lock errors"
affects: [backend-tool-pack, vfs, chat-v2-db, EXEC-02, RES-01, SAF-01, SAF-03]

tech-stack:
  added: []
  patterns:
    - "Source-level audit guard via include_str! for selected real sub-tools"
    - "Migrate VFS and Chat V2 temp databases before write-heavy ToolPack tests"
    - "Scan every aggregate error for database is locked, sqlite_busy, and database table is locked"

key-files:
  created:
    - ".planning/phases/03-integration-testing-edge-cases/03-04-SUMMARY.md"
  modified:
    - "src-tauri/tests/tool_pack_integration_tests.rs"

key-decisions:
  - "Kept 03-04 test-only; no production code changes were needed for SQLite/WAL contention coverage."
  - "Registered UserTodoExecutor in the focused ToolPack test registry so write-heavy tests use the real builtin-user_todo_create_item path."
  - "Audited selected real sub-tools for direct AppState/shared lock hazards before the write-load tests."

patterns-established:
  - "Representative ToolPack SQLite contention tests should attach both migrated VFS and Chat V2 databases so sub-tools exercise todo writes and save_tool_block persistence."
  - "Back-to-back contention guards should reuse the same DB pools without sleeps to catch cleanup and WAL/pool pressure issues."

requirements-completed: [EXEC-02, RES-01, SAF-01, SAF-03]

duration: manual continuation
completed: 2026-06-28
---

# Phase 03 Plan 04: SQLite/WAL Contention Summary

**Representative write-heavy ToolPack coverage was added for VFS todo writes plus Chat V2 tool-block persistence.**

## Accomplishments

- Extended the ToolPack integration registry with `UserTodoExecutor`.
- Added `create_vfs_db()` using `MigrationCoordinator::migrate_single(DatabaseId::Vfs)` and `VfsDatabase::new`.
- Added `tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths`, an executable source audit for `builtin-template_validate`, `builtin-session_list`, and `builtin-user_todo_create_item`.
- Added `tool_pack_vfs_write_load_does_not_surface_sqlite_busy_or_database_locked`, building exactly 20 `builtin-user_todo_create_item` sub-tools under `timeout: 30`.
- Added `tool_pack_repeated_vfs_write_load_remains_free_of_sqlite_lock_errors`, running three sequential 20-tool packs against the same migrated VFS and Chat V2 database pools.
- Added `assert_no_sqlite_lock_errors` scanning every per-tool error for `database is locked`, `sqlite_busy`, and `database table is locked`.

## Task Commits

1. **SQLite contention coverage** - `9138323e` (test)

This summary is committed separately after creation.

## Files Created/Modified

- `src-tauri/tests/tool_pack_integration_tests.rs` - Adds UserTodo registry support, VFS DB helper, shared-state audit, single write-load test, repeated write-load test, and lock-error assertions.
- `.planning/phases/03-integration-testing-edge-cases/03-04-SUMMARY.md` - Documents plan execution and verification.

## Verification

- `cargo test --test tool_pack_integration_tests --no-run` - PASS; integration test binary compiled successfully after clearing a stale test process that held the exe open.
- `cargo test --test tool_pack_integration_tests tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths -- --exact --nocapture` - BLOCKED locally after compile by `STATUS_ENTRYPOINT_NOT_FOUND`.
- `rg -n "tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths|AppState|\\.state::<|Mutex<|RwLock<|\\.lock\\(\\)\\.await|blocking_lock|std::sync::Mutex|tokio::sync::Mutex|VfsTodoRepo::create_todo_item|ChatV2Database|save_tool_block|emit_tool_call|emit_todo_changed|ToolExecutorRegistry|registry_clone\\.execute" src-tauri/tests/tool_pack_integration_tests.rs` - PASS.
- `Select-String -Path src-tauri\\tests\\tool_pack_integration_tests.rs -SimpleMatch 'include_str!(\"../src/chat_v2/tools/user_todo_executor.rs\")','include_str!(\"../src/chat_v2/tools/executor.rs\")'` - PASS.
- `rg -n "tool_pack_vfs_write_load_does_not_surface_sqlite_busy_or_database_locked|create_vfs_db|DatabaseId::Vfs|builtin-user_todo_create_item|assert_no_sqlite_lock_errors|database is locked|SQLITE_BUSY|database table is locked|sqlite_busy|0\\.\\.20|write-pack-tool_pack-19|timeout.*30|ToolPackTestHarness|harness\\.context = harness\\.context\\.with_vfs_db|harness\\.context = harness\\.context\\.with_chat_v2_db|tool_pack_repeated_vfs_write_load_remains_free_of_sqlite_lock_errors|phase-3-repeat|write-repeat|for round in 0\\.\\.3" src-tauri/tests/tool_pack_integration_tests.rs` - PASS.
- `git diff --check` - PASS.

## Deviations from Plan

- Runtime execution of the contention tests could not be completed in this local Windows/Tauri environment because the compiled Rust test binary exits with `STATUS_ENTRYPOINT_NOT_FOUND`.
- The executable audit scans selected tool sources for forbidden direct lock/AppState patterns and separately asserts allowed shared paths in tool_pack/executor sources; it intentionally does not forbid the connection-pool internals in database modules.

## Issues Encountered

- A stale `tool_pack_integration_tests-215b55a18dfb0c07.exe` process from an earlier timed-out runtime command held the test exe open and caused one linker `LNK1104` failure. After stopping the residual process, `cargo test --test tool_pack_integration_tests --no-run` passed.
- Existing crate warnings remain unrelated to this plan.

## Known Stubs

None. The write-load tests use real `UserTodoExecutor`, real migrated VFS databases, and real migrated Chat V2 databases.

## Threat Flags

- SAF-03 is covered by an executable shared-state audit for selected sub-tools.
- SQLite lock failures are explicitly scanned in every aggregate result when the runtime environment can execute the tests.

## User Setup Required

None for compile verification. Running the Rust/Tauri integration test binary requires resolving the local Windows `STATUS_ENTRYPOINT_NOT_FOUND` issue.

## Next Phase Readiness

All Phase 03 planned implementation artifacts now exist. Phase-level verification can proceed with compile/static gates and should record the Rust runtime blocker separately from code completion.

## Self-Check: PASSED

- Summary file exists at `.planning/phases/03-integration-testing-edge-cases/03-04-SUMMARY.md`.
- Test commit `9138323e` exists.
- No production source file was modified by this plan.
- `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, and `.planning/PROJECT.md` were not modified by this plan.

---
*Phase: 03-integration-testing-edge-cases*
*Completed: 2026-06-28*
