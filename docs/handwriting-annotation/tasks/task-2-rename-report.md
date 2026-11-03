# Task 2 rename closed-boundary implementation — NEEDS_MAIN_VERIFICATION

## Finding / scope

The rename boundary gap was confirmed by the red run. `VfsFileRepo::update_file_name_with_conn` previously updated only `files.file_name`; Ink manifest title and `.dsink` suffix are owned by `VfsInkRepo::rename_with_conn`, which requires `expected_revision` and `operation_id` and atomically commits the title, manifest blob, revision receipt, and canonical filename. The DSTU `files` branch and `dstu_set_metadata.fileName` now use small private helpers for the Ink-aware route.

Implemented the rename guard and versioned DSTU route in the existing generic file repo and handler helpers. Generic file rename now rejects Ink by canonical MIME while preserving ordinary-file behavior. DSTU `files` rename fetches the current manifest revision, generates an operation ID, strips only a trailing `.dsink` from the requested title, and delegates to `VfsInkRepo::rename_with_conn`; the repo persists canonical `title.dsink`. Versionless `dstu_set_metadata.fileName` fails closed for Ink rather than mutating only `files.file_name`. No edits to `VfsInkRepo`, public DSTU node types, MockRuntime features, or broad handler infrastructure.

## Test selectors

Main owns implementation verification; this task hand ran no tests or builds.

File repository:

- `vfs::repos::file_repo::tests::generic_rename_rejects_ink_documents_without_changing_manifest_or_filename`
- `vfs::repos::file_repo::tests::generic_rename_still_renames_ordinary_files`

DSTU handler facade:

- `dstu::handlers::tests::dstu_file_rename_uses_versioned_ink_repo_contract`
- `dstu::handlers::tests::dstu_metadata_file_name_uses_same_ink_rename_boundary`

Exact focused verification command for main:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib rename
```

Main previously reported `task-2-vfs-ink-gates-r7.log`: the test target compiled; the generic Ink rename, versioned DSTU rename contract, and metadata filename contract tests all failed as expected. The implementation now addresses those failures, but has not been verified by this hand. Main should rerun the focused command and report its result. No tests/builds were run here.

## Verification handoff

Main should rerun `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib rename`. No generic behavior for ordinary files was changed, and no new public DSTU node type or Ink repository implementation was added. Metadata filename updates for Ink intentionally fail closed; clients should use the dedicated versioned rename command.

## Relevant paths

- `src-tauri/crates/dstu-vfs/src/vfs/repos/file_repo.rs`
- `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs`
- `docs/handwriting-annotation/tasks/task-2-rename-report.md`
