# Task 5 — source preparation backend

Status: **IMPLEMENTED — main-reported focused VFS Ink gates pass (87/87).** A broader final VFS regression run remains with main. No tests/builds were run in this turn.

## Backend behavior

- `src-tauri/crates/dstu-vfs/src/vfs/repos/ink_prepare_repo.rs` provides `InkPreparedPage` and `VfsInkPrepareRepo::prepare_with_conn` for PDF, image, DOCX, and PPTX source resources.
- Resolves each source through `resources.source_id/source_table` to its active file and actual blob, checks canonical resource/file/blob hashes and bytes, and rechecks source identity/hash before publishing the default backpointer.
- Persists the stable default document ID only in source `resources.metadata_json.default_ink_document_id`. A repeated prepare reopens the same prepared document only when its source hash and conversion revision match; mismatch reports `ink.source_changed`.
- Page input is bounded to 1–500 pages, validates logical dimensions and contiguous PDF page indexes, and requires the background PNG raster dimensions to equal the page dimensions. PNG validation reuses `ink_artifact_repo::validate_png_bytes`, including full decode; the persisted bytes are SHA-256 checked before decode.
- The PDF success fixture generates a real 612×792 PNG to match its page dimensions. Image-source tests use the real 1×1 fixture. The source-drift fixture replaces file/resource hashes with a registered replacement blob and adjusts the original blob reference so the migrated-schema foreign keys remain valid.
- New document/page/manifest persistence uses the canonical Ink commit path and existing manifest-derived unique per-document blob references. Source purge leaves the prepared document and its owned background reference intact.

## Lock ordering

- `blob_repo.rs` exposes an internal `BlobMutationGuard` token. Ordinary `store_blob_with_conn` and `store_staged_blob_with_conn` preserve their API and acquire the global mutation mutex before storage, including when called within existing savepoints; guarded internal variants accept the already-held token.
- Ink create, copy, append, rename, save, and commit paths acquire the token before their savepoints and call guarded blob-store helpers with the same token. Prepare obtains the checked guard before its outer savepoint and passes it to guarded create/commit internals; nested operations do not recursively acquire the mutex. No global lock ordering was changed and the prepare API is unchanged for jobs.
- The prepare/blob two-connection probe has bounded waits and asserts both workers complete. It verifies bounded liveness under overlap but does not force a deterministic lock-cycle interleaving, so it is not proof that the inversion is impossible.

## Ink command error-boundary follow-up — implemented, main verification required

- `ink_repo.rs` preserves domain error codes when mapping `InkError`: invalid argument remains `VfsError::InvalidArgument`; limit exceeded and unsupported schema are represented as `ink.limit_exceeded` and `ink.unsupported_schema` conflict keys. Overlong create titles use the limit key.
- `ink_commands.rs` maps those keys to `LIMIT_EXCEEDED` and `UNSUPPORTED_SCHEMA`, maps `ink.source_changed` to `SOURCE_CHANGED`, and maps `ink.artifact.provenance_mismatch` to `REVISION_CONFLICT`. No `VfsError` enum expansion was needed.
- Tests cover overlong create titles, unsupported schema and malformed JSON via the public service, source/artifact command-boundary codes, and failed save atomicity. The failed-save case keeps the real page ID and uses out-of-bounds stroke data, asserting revision and blob reference counts are unchanged.
- Main reported `ink-error-boundary-red-r1`: 13 tests, 9 pass / 4 fail for the original mappings. The implementation and corrected test are now in place; no verification command was run in this turn.

## Verification handoff

Earlier main report `task-2-vfs-ink-green-r9.log`: **87 tests passed, 0 failed** for focused VFS Ink gates. Main should run the updated error-boundary tests and the broader VFS regression gates; this turn did not run tests or builds.
