# Task 5 — prepare backend first red slice

Status: **MAIN_RED_REQUIRED — compiling error stub and two positive migrated-DB tests authored; implementation intentionally not started.**

## Scope

- Added `VfsInkPrepareRepo::prepare_with_conn` and `InkPreparedPage` in `src-tauri/crates/dstu-vfs/src/vfs/repos/ink_prepare_repo.rs`. The method currently returns `VfsError::InvalidState` as the compiling stub.
- Registered/exported the new repository and input type in `src-tauri/crates/dstu-vfs/src/vfs/repos/mod.rs`.
- Added two tests using `setup_migrated_test_db()` and real VFS blob/file fixtures:
  1. A PDF source file and PNG background blob prepare into a PDF-page background, reopen the manifest and empty page, and retain the frozen PNG bytes/ref.
  2. An image source and PNG background prepare once, then a second same-source call reuses the identical manifest/document and does not add another background reference; it checks `resources.metadata_json.default_ink_document_id` and reopens the empty page.

## Handoff

Run the two new tests to confirm their expected RED against the error stub. Stop at that main RED before implementation. No tests, builds, installs, agents, or commits were run in this turn. The broader source-format/concurrency/rollback/error contract and all frontend work remain out of this first slice.
