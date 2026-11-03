# Task 2/6 continued — Ink artifact backup/restore closure

**Status: BACKUP_RESTORE_VERIFIED (main rerun)**

This slice fixes the whitespace-only migration diff issue, adds a real local VFS database + VFS blob asset backup/restore regression, and adds a migration fixture oracle for the newly registered artifact migration. No tests/builds were run by this worker.

## Files touched

- `src-tauri/crates/dstu-storage/src/migration/vfs.rs` — removed trailing whitespace at the immutable-delete trigger selector. The earlier `git diff --check` for that whitespace-only edit had no output.
- `src-tauri/crates/dstu-sync/src/data_governance/backup/mod.rs` — added `vfs_backup_restore_preserves_ink_manifest_artifact_blob_pin_and_immutable_triggers`.
- `src-tauri/tests/migration_tests.rs` — added `ink_render_artifacts` to the exact VFS schema-integrity table list; no table assertion was weakened.
- `src-tauri/tests/fixtures/migrations/manifest.json` — added HEAD artifact-table and V20261103 migration-history oracles to the v0.9.44 upgrade fixture.

No sync classification or VFS artifact repository code was changed in this slice.

## Backup/restore regression selector

`data_governance::backup::tests::vfs_backup_restore_preserves_ink_manifest_artifact_blob_pin_and_immutable_triggers`

It migrates a real local VFS database to the registered schema head, creates an Ink document with a text page and PNG page background, stores a render artifact over the same PNG bytes, and checks the background/file/artifact ownership total of three blob references. It then uses the existing SQLite `backup_single_database` path and `assets::backup_assets` for `AssetType::VfsBlobs`, restores both with `restore_single_database_to_dir` and `assets::restore_assets` into an isolated target, and checks manifest/page restoration, PNG bytes, artifact read, persisted blob refcount, migration head, immutable triggers, and update/delete rejection. After closing/reopening the VFS DB it loads the old artifact and PNG again.

### Main's first attempt and fix

`docs/handwriting-annotation/verification/task-2-backup-red.log` showed the first test attempt failed at backup setup with `RestoreFailed("备份不是可替换数据槽的完整快照: PartialOverlay")`: `backup_with_assets` produces a partial overlay, which is invalid input to `restore_with_assets_to_dir`. No artifact restore assertion ran in that attempt. Production code was not changed. The regression now uses the existing full single-database SQLite backup/restore methods together with the real VFS blob asset backup/restore methods, preserving the intended DB-plus-filesystem restoration closure.

## Migration coverage

The VFS schema-integrity integration test now explicitly checks `ink_render_artifacts`. The migration fixture manifest's `v0944_anki_library` case now verifies both that the table exists after upgrade and that `refinery_schema_history` contains version `20261103` named `ink_render_artifacts`. The migration's own `ink_render_artifact_migration_pins_blobs_and_rejects_mutation` test checks the blob pin trigger, insert change-log trigger, immutable update/delete guards, and FK retention behavior.

## Verification status / handoff

Main rerun evidence: `docs/handwriting-annotation/verification/task-2-backup-r2.log` reports the exact selector `data_governance::backup::tests::vfs_backup_restore_preserves_ink_manifest_artifact_blob_pin_and_immutable_triggers` **1 passed, exit 0**. The corrected database + VFS blob asset restore exercised manifest/page/background/artifact/pin, immutable triggers, and post-reopen PNG readability. This verifies the requested backup/restore closure for the regression.

The earlier `task-2-backup-red.log` setup failure (`PartialOverlay`) is resolved by using the compatible existing lower-level SQLite database backup/restore plus VFS blob asset backup/restore APIs; no production restore code was changed. This worker ran no tests/builds and made no source changes after the reported pass; only this evidence/status report was updated.
