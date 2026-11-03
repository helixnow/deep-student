# Task 6 — immutable artifact repository implementation

**Status: READY_FOR_MAIN_GREEN_VERIFICATION**

Implemented the artifact repository and its VFS migration. No tests or builds were run in this slice; the main agent should now run the three artifact repository tests against the migrated database. No claim is made here that Rust compilation or tests pass.

## Changed files

- `src-tauri/crates/dstu-vfs/src/vfs/repos/ink_artifact_repo.rs` — artifact types, PNG persistence/load, provenance checks, and DB behavior tests.
- `src-tauri/crates/dstu-vfs/src/vfs/repos/mod.rs` — artifact module/type registration only; existing in-progress Ink repo registration was retained.
- `src-tauri/migrations/vfs/V20261103__ink_render_artifacts.sql` — canonical table, blob pin trigger, RowSync insert change-log trigger, and immutable update/delete guards.
- `src-tauri/crates/dstu-storage/src/migration/vfs.rs` — migration registration, schema head/table registry update, and migration behavior test.

## Repository contract

`InkArtifact` stores global render provenance; it has no session or tool-call fields. `artifact_id` is constrained to equal `render_id`, making retries return the same immutable artifact. Reuse of a `render_id` with changed provenance or image bytes returns a conflict. `load_for_document_with_conn` additionally verifies document and revision ownership; session/call authorization remains with typed Chat references/request-envelope callers.

PNG writes are limited to 4 MiB and bounded-decoded through the existing `image` crate PNG decoder with a 2048x2048 dimension ceiling, pixel/decoded-allocation bounds, and complete payload validation. The supplied dimensions must match decoded IHDR dimensions. Source hashes are validated as lowercase 64-character SHA-256 hex. The normal VFS image file `sha256`/`blob_hash` is the SHA-256 of the actual PNG bytes.

A canonical `ink_render_artifacts` row stores `render_id`, unique `artifact_id`, `metadata_json`, `image_blob_hash`, `image_file_id`, `image_resource_id`, and `created_at`. The visible image file/resource are intentionally not foreign-key cascade parents of the artifact row. An insert trigger independently increments the blob reference and writes an insert to `__change_log`; the blob foreign key is `ON DELETE RESTRICT`. Update/delete attempts are rejected, so the pin and historical render provenance are retained.

For the sync worker’s classification and refcount/recount closure, the new table has these relevant fields:

- Row identity: `render_id` (primary key; immutable global render identity).
- Blob ownership: `image_blob_hash` (one independent row-owned reference per artifact; also the FK target and recount key).
- Other persisted references: `image_file_id`, `image_resource_id` (intentionally not cascading FKs).
- Canonical provenance: `artifact_id`, `metadata_json`, `created_at`.
- Change-log behavior: insert-only trigger `trg__change_log_ink_render_artifacts_insert`; no update/delete trigger because those operations are rejected by immutable guards. Please register the corresponding immutable RowSync trigger exemption/NoConflict policy as appropriate in the worker-owned classification; do not add cascade-based pin release.

## Tests added, not run

The VFS tests continue using `setup_migrated_test_db()` and a complete locally generated 1x1 RGBA PNG fixture:

- `stores_same_png_as_distinct_immutable_revision_artifacts_and_pins_it` — identical PNG bytes under two render IDs/revisions remain distinct; checks actual image SHA-256, shared image blob, the two row-owned pins, visible file removal, and historical loads.
- `render_id_collision_with_different_provenance_cannot_mutate_original` — reused render ID with different revision is rejected and original remains readable.
- `document_revision_mismatch_is_rejected_without_session_binding` — document/revision mismatch rejects, matching provenance loads without an exclusive session binding.
- `invalid_and_mismatched_pngs_are_rejected_before_storage` — malformed PNG, wrong dimensions, and non-SHA-256 source hash are rejected before artifact creation.

The migration test `ink_render_artifact_migration_pins_blobs_and_rejects_mutation` applies the migration to a minimal in-memory schema and checks blob pin increment, insert change-log row, immutable update/delete rejection, and the blob FK preventing pin-target deletion.

## Not included / handoff

Sync classification and the global blob/resource recount implementation are intentionally left to the active sync worker. Chat typed-block references, app bridge/UI, request bus, staged-upload/render implementation, and integration are out of scope. Migration fixture upgrades should be covered by the main migration gate when available.

No tests, builds, installs, agents, commits, or pushes were run/performed.