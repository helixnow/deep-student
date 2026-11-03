# Task 2 sync test slice

Status: main verification passed. Main reports `task-2-artifact-sync-green-r2.log`: 11 sync tests passed, 0 failed, exit 0. Main also reports `task-2-backup-r2.log`: the separate backup/restore closure test passed (1 passed).

## Current APIs and files

- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-sync/src/data_governance/sync/ink_tests.rs` — one consolidated artifact test set: registry RowSync keyed by `render_id` with `NoConflict` and no field-merge columns; two render IDs sharing one PNG and preserving one pin each across visible-file purge/recount/GC; identical update; incoming INSERT quarantined while image bytes are missing then retried after transfer; and changed metadata quarantined without replacing provenance or pins. Uses `VfsInkArtifactRepo::store_png_with_conn` / `load_with_conn`, `VfsFileRepo::purge_file_with_conn`, `VfsBlobRepo`, and a valid 1x1 PNG fixture. Tests use actual migrated databases.
- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-sync/src/data_governance/sync/classification.rs` — registers `ink_render_artifacts` as VFS RowSync with primary key `render_id`, `NoConflict`, no business-unique alias, and immutable/global-provenance notes.
- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-sync/src/data_governance/sync/ink.rs` — dsink canonical pointer validation and immutable artifact payload validation. Artifact checks require a complete matching row/metadata tuple, an available content-addressed PNG, matching hash/MIME/dimensions, and reuse `validate_png_bytes` for bounded full PNG decoding. Exact existing artifact rows pass; changed rows fail into the existing apply quarantine path.
- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs` — invokes `ink::validate_change` at ordinary, force-exact and conflict-aware apply boundaries; blob recount includes one `ink_render_artifacts.image_blob_hash` reference per artifact row.
- `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-vfs/src/vfs/repos/ink_artifact_repo.rs` — exports its existing bounded PNG validator as `validate_png_bytes`; validation behavior itself is unchanged.
- Artifact schema remains `/home/xutao/deepstudent/deep-student/src-tauri/migrations/vfs/V20261103__ink_render_artifacts.sql`; this slice does not modify it or the artifact repository's storage behavior.

## Test selectors

Full sync module: `data_governance::sync::ink_tests`.

Artifact cases:
- `data_governance::sync::ink_tests::ink_render_artifacts_are_row_sync_by_render_id_and_never_field_merged`
- `data_governance::sync::ink_tests::artifact_pin_survives_visible_file_purge_and_sync_recount_gc`
- `data_governance::sync::ink_tests::identical_artifact_sync_upsert_is_idempotent_without_mutating_immutable_row`
- `data_governance::sync::ink_tests::validated_artifact_insert_accepts_verified_png_and_recounts_one_artifact_pin`
- `data_governance::sync::ink_tests::changed_artifact_sync_upsert_is_quarantined_and_cannot_replace_provenance_or_pin`

Main can rerun with `cargo test -p dstu-sync data_governance::sync::ink_tests` from `/home/xutao/deepstudent/deep-student/src-tauri`.

## Scope and verification

The earlier dsink slice still covers current manifest/page refcounts, unresolved conflict dependency pins, complete canonical tuple guards, quarantine/retry for unavailable blob closure, mirror reconciliation, and generic recount regression. The artifact subset adds only sync classification, row guards, recount and migrated-DB tests. No tests/builds were run for this report-only update. The verified final consolidated sync selector contained 11 tests (not 12); the actual PNG and sync-closure checks were included in the passing run. The separate backup/restore test also passed as reported above.
