# Task 2 API slice report

## Status

`NEEDS_RED_VERIFICATION` — for the append-page/rename extension, request structs and test scaffolds are present along with compileable placeholder service signatures returning structured `INTERNAL` not-implemented errors. The tests now compile against these names and are expected to fail behavior assertions until the repo owner implements the atomic operations; no red result is claimed because execution was prohibited. Main reports the previous five-command Tauri integration had app-check PASS. The initial Rust 3 service tests and TS 2 API tests were reported green (`task-2-api-initial-r2.log`, `task-2-api-ts-initial.log`) and were not rerun here.

## Implemented

- Added `src-tauri/crates/dstu-vfs/src/vfs/ink_commands.rs` and registered `pub mod ink_commands` in `src-tauri/crates/dstu-vfs/src/vfs/mod.rs`.
- Added deny-unknown-fields Rust request types and thin synchronous shared service functions for create/get/get-page/save-page/copy. They acquire `get_conn_safe()` and call `VfsInkRepo::*_with_conn` directly.
- Added migrated-database service success tests for create/get and save/get-page, plus a combined unsupported-file and stale-revision structured-error test. Main run reports these 3 service tests passed in `task-2-api-initial-r2.log`.
- Added `src/features/ink/api.ts` and `api.test.ts`. The stable editor surface is `inkApi.create/get/getPage/savePage/copy`, each accepting a snake_case request object. Tauri receives `{ request }`; success values are Ink manifest/page domain values. `InkApiError` preserves `code`, `current_revision`, and related structured fields; errors are rejected, not converted to success. Main run reports the 2 API tests passed in `task-2-api-ts-initial.log`. The frontend API is thin transport plumbing to the existing service, not new domain behavior.
- Added `vfs_ink_*` async Tauri wrappers using `spawn_blocking` and the managed `State<Arc<VfsDatabase>>`. Create/save/copy emit `ink:changed` with `{ document_id, revision, operation_id, affected_page_ids }` after service success; failed commands do not emit. Added request unknown-field, safe structured error, and event payload unit tests.
- Registered the five commands in the single app `generate_handler!` and the exact-match `allow-application-commands` ACL list. Existing build-time ACL parity checks cover registry synchronization. The existing `app_command_acl` integration test is available to reverify main vs remote-webview permission behavior.

## Verification selectors for the main run

- Rust service and request/error/event boundary tests (3 original service cases reported green initially; 3 boundary tests were added during Tauri integration; 3 append/rename DB tests are newly added and pending repo-owner implementations): `cargo test -p dstu-vfs vfs::ink_commands::tests`
- TS API plumbing tests (2 passed initially; no TS behavior change in this integration pass): `npm test -- src/features/ink/api.test.ts`
- App compile plus `build.rs` exact command-registration/ACL parity: `cargo check -p deep-student --lib`
- Existing command registry/ACL integration test (checks the local-main vs remote-origin policy): `cargo test -p deep-student --test app_command_acl`

This agent did not run commands during this integration pass. The service/API test results above were supplied by the main run.

## Append-page / rename extension handoff

`NEEDS_RED_VERIFICATION` — added only request structs and migrated-database test expectations in `ink_commands.rs`; the append/rename service methods are intentionally not implemented here. The new tests currently reference the expected `append_page`/`rename` methods and therefore require the repo owner to add those service APIs before Rust test compilation. No test/build command was run for this extension, so this is not a claim of an observed failing test. The repo owner should implement the atomic service methods, then run the targeted selector.

- `InkAppendPageRequest`: `document_id`, `expected_revision`, `operation_id`, `width`, `height`, `ruling`.
- `InkRenameRequest`: `document_id`, `expected_revision`, `operation_id`, `title`.
- Migrated DB success expectations: append verifies page count, page identity retention, new dimensions/ruling and revision change; rename verifies title/revision and persisted readback.
- Migrated DB stale-rename error expectation verifies a stale revision does not overwrite the current manifest. Unknown fields are rejected for both requests.
- Expected service calls from the repo owner: `append_page(&db, InkAppendPageRequest)` and `rename(&db, InkRenameRequest)`.
- Targeted verification after implementation: `cargo test -p dstu-vfs vfs::ink_commands::tests`.

## Remaining review / caveats

- Main reports the existing five-command Tauri integration has been registered and passed app check. This extension adds no Tauri handlers, registrations, ACL entries, or frontend API functions. Its append/rename service test scaffold remains unverified pending repo-owner implementation.
- The existing `build.rs` exact parity check covers all `generate_handler!` commands against `permissions/application-commands.toml`; `app_command_acl` remains the existing main-vs-remote origin policy test. No new test target or permission file was needed.
- `VfsInkRepo::map_ink_error` currently converts domain validation failures (including limit/schema failures) into `VfsError::InvalidArgument`; this layer therefore cannot reliably restore `LIMIT_EXCEEDED` or `UNSUPPORTED_SCHEMA` for those cases without repository changes. The repository was left untouched per scope.
- The repository maps stale expected revisions to `ink.operation_state_unknown`; the service reports `OPERATION_STATE_UNKNOWN`. A concurrent write detected during the final update maps to `REVISION_CONFLICT`.
