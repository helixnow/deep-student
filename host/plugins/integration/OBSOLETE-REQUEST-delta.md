# L22 delta 族 `obsolete` 申请（已获批准）

日期：2026-11-04 · 分支 `ds-mig/L22-app-commands`
范围：`src-tauri/tests/sync_r12_delta_{format,upload,restore,gc,inventory}.rs`
批准：`migration/approvals.d/C2-platform.json`，main 提交 `294cbe65f`
（2026-11-04 协调者批准 43 条行为测试 + 6 条 `delta_inventory`）。

## 1. 结论

Rust 侧 backup-v2 / delta 原语族（`delta_format` / `delta_upload` /
`delta_restore` / `delta_gc`）是**书面的 experimental 隔离、零生产接线**。
按协调者指令「若确死列测试 ID 申请 obsolete；不要因为审计要求就把 Rust
未启用 delta 接到生产」，本 lane 申请把 **43 条行为测试**标为
`obsolete:dead-in-rust experimental`，并把 6 条 `delta_inventory` 行为测试列为
同族项；两部分**均已获批准**，共 49 条。

**保持 `ported` 的 5 条 source-lock**（它们正是零接线的证据，不申请 obsolete；
前 4 条为四个 delta 模块，另 1 条属于 inventory）：

- `sync_r12_delta_format.rs::r12_source_lock_sync_manager_still_uploads_whole_zip`
- `sync_r12_delta_gc.rs::r12_source_lock_delta_gc_has_zero_production_wiring`
- `sync_r12_delta_restore.rs::r12_source_lock_delta_restore_has_zero_production_wiring`
- `sync_r12_delta_upload.rs::r12_source_lock_delta_upload_has_zero_production_wiring`
- `sync_r12_delta_inventory.rs::r12_source_lock_inventory_has_no_production_callers`

## 2. 证据

### 2.1 Rust 裁决与源码注释

- `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:31-40`：
  「[Wave2-D R5 裁决] backup-v2 / delta 原语族 = **experimental 隔离**……
  仅 sync_r12_* 集成测试消费，生产 Cloud backup/restore 默认路径仍是
  『全量 ZIP → 单对象 put/get』，不得因这些模块存在而宣称增量备份已实现。」
  四个 `pub mod delta_*;` 声明行均带「experimental，零生产接线」doc 注释。
- `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:44-46`：
  `backup_lease` 同样标注「零生产接线」。
- `src-tauri/crates/dstu-sync/src/data_governance/backup/mod.rs:36`：
  `pub mod delta_inventory;`，仅被 `delta_upload` / `delta_restore` 这两个
  未接线积木引用。
- `docs/dev/wave2-D-backup-v2-decision.md` §0/§1/§2：
  明确「delta 族维持 experimental 隔离，不排接线」；列出
  `delta_format` / `delta_inventory` / `backup_lease` / `delta_upload` /
  `delta_restore` / `delta_gc` 的「生产入口」全部为**无**；并记录
  `publish_verified_staging`、`restore_snapshot_to_staging`、
  `collect_gc_candidates`、`sweep_gc_candidates`、
  `acquire_backup_repo_lease` 在 `src/**/*.rs` 的调用方仅限各自模块。

### 2.2 本轮只读复核

对 `src-tauri/src` 与 `src-tauri/crates` 执行字面扫描：

- `delta_format` / `delta_upload` / `delta_restore` / `delta_gc` 的引用只出现在
  这四个模块相互之间、`cloud_storage/mod.rs` 的裸声明行，以及
  `src-tauri/tests/sync_r12_*` 集成测试；
- `delta_inventory` 的引用只出现在 `delta_upload.rs` / `delta_restore.rs` /
  模块自身 / `backup/mod.rs` 声明行；
- 命令层（`src-tauri/src/commands*.rs`、`main.rs`/`lib.rs` 的
  `invoke_handler`）没有 delta 族引用；
- Host 侧 `host/plugins/sync-providers/src/delta_{format,upload,restore,gc}.ts`
  文件头均写明 **Not wired: no Tauri command, UI, sync_manager or other
  production entry point**；`host/` 生产代码没有导入这些模块（只有
  `sync-providers/api.ts` 再导出供测试使用）；
- 本 lane `host/plugins/integration/tests/sync-r12-locks.test.ts` 已用真实
  WebDAV 命令链锁定「整 ZIP 上传/下载 + 无 backup-v2/delta 对象」。

### 2.3 为什么不接线

协调者明确要求：**不要因为审计要求就把 Rust 未启用的 delta 接到生产**。
把未启用的增量备份/恢复/GC 接到命令层会改变生产数据路径，超出测试迁移范围，
也会违反 `wave2-D-backup-v2-decision.md` 的接线前置清单。

## 3. 已批准 `obsolete` 的 43 条行为测试

| 文件 | 行为行数 | 当前 TESTMAP 状态（批准后） |
|---|---:|---|
| `sync_r12_delta_format.rs` | 14 | 14 `obsolete` |
| `sync_r12_delta_upload.rs` | 10 | 10 `obsolete` |
| `sync_r12_delta_restore.rs` | 11 | 11 `obsolete` |
| `sync_r12_delta_gc.rs` | 8 | 8 `obsolete` |
| **合计** | **43** | **43 `obsolete`** |

批准前的状态为 14 `merged` + 21 `ported` + 8 `pending`。其中 8 条原 `merged`
目标只覆盖部分 Rust 断言（GC 截断/重新引用、restore 显式版本/同尺寸换体/ZIP
逐字节、upload 首版全量/损坏 descriptor/E2EE 二次复用），已先按 quality §10
降回 `pending`，没有使用“文件存在”冒充完成；随后随本申请一并转为
`obsolete:dead-in-rust experimental`。5 条 source-lock 保持 `ported`。

批准后本 lane 当前 A = **193/243 = 79.4%**（135 ported + 5 merged +
53 obsolete，含此前的 4 条 mobile-only）。按 `ledger-core.mjs:40-44`，已批准
`obsolete` 为 A=B=true：49 条中 35 条（21 ported + 14 merged）原本已是 A，
14 条原 pending（8 条行为 + 6 条 inventory）因批准转为 A。实际执行仍是
24 文件 / 249 用例（`delta-backup-v2.test.ts` 的 21 条继续运行）；退休的是
49 条 TESTMAP 迁移义务，不是删除测试。这不是为了提高百分比；本 lane 不会为了
维持百分比把未接线的 delta 接到生产。

### 3.1 `sync_r12_delta_format.rs`（14 条）

- `tests/sync_r12_delta_format.rs::r12_descriptor_roundtrip_is_lossless`
- `tests/sync_r12_delta_format.rs::r12_repo_config_roundtrip_is_lossless`
- `tests/sync_r12_delta_format.rs::r12_encoded_field_names_are_camel_case`
- `tests/sync_r12_delta_format.rs::r12_future_format_version_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_wrong_format_string_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_parent_or_patch_fields_are_rejected_not_ignored`
- `tests/sync_r12_delta_format.rs::r12_repo_config_refuses_key_material_and_zero_epoch`
- `tests/sync_r12_delta_format.rs::r12_logical_path_traversal_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_object_key_traversal_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_file_count_over_limit_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_path_and_object_key_length_limits_reject_not_truncate`
- `tests/sync_r12_delta_format.rs::r12_duplicate_logical_path_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_logical_size_mismatch_is_rejected`
- `tests/sync_r12_delta_format.rs::r12_invalid_hex_digests_are_rejected`

### 3.2 `sync_r12_delta_upload.rs`（10 条）

- `tests/sync_r12_delta_upload.rs::r12_first_version_uploads_every_logical_file`
- `tests/sync_r12_delta_upload.rs::r12_blank_device_id_fails_closed_with_zero_writes`
- `tests/sync_r12_delta_upload.rs::r12_zero_change_second_version_reuses_all_data_objects`
- `tests/sync_r12_delta_upload.rs::r12_single_file_change_uploads_only_that_file_and_manifest`
- `tests/sync_r12_delta_upload.rs::r12_cross_device_never_reuses_other_devices_objects`
- `tests/sync_r12_delta_upload.rs::r12_index_put_failure_leaves_orphans_but_no_new_version`
- `tests/sync_r12_delta_upload.rs::r12_descriptor_put_failure_leaves_objects_but_no_new_version`
- `tests/sync_r12_delta_upload.rs::r12_held_lease_blocks_publish_with_zero_object_writes`
- `tests/sync_r12_delta_upload.rs::r12_corrupted_index_or_descriptor_fails_closed_without_new_objects`
- `tests/sync_r12_delta_upload.rs::r12_e2ee_encrypts_objects_and_descriptor_with_one_session`

### 3.3 `sync_r12_delta_restore.rs`（11 条）

- `tests/sync_r12_delta_restore.rs::r12_plaintext_roundtrip_restores_every_logical_file`
- `tests/sync_r12_delta_restore.rs::r12_blank_device_id_or_unknown_version_fails_closed`
- `tests/sync_r12_delta_restore.rs::r12_reused_object_version_restores_correctly`
- `tests/sync_r12_delta_restore.rs::r12_e2ee_roundtrip_and_wrong_password_fails_closed`
- `tests/sync_r12_delta_restore.rs::r12_cipher_on_plaintext_repo_fails_closed`
- `tests/sync_r12_delta_restore.rs::r12_missing_object_fails_closed_with_empty_dest`
- `tests/sync_r12_delta_restore.rs::r12_same_size_swapped_object_fails_closed`
- `tests/sync_r12_delta_restore.rs::r12_corrupted_descriptor_or_index_fails_closed`
- `tests/sync_r12_delta_restore.rs::r12_held_lease_blocks_restore_with_zero_storage_writes`
- `tests/sync_r12_delta_restore.rs::r12_compatible_zip_written_only_after_verification`
- `tests/sync_r12_delta_restore.rs::r12_compatible_zip_failure_leaves_no_partial_zip`

### 3.4 `sync_r12_delta_gc.rs`（8 条）

- `tests/sync_r12_delta_gc.rs::r12_gc_keeps_shared_objects_and_reclaims_pruned_snapshot_after_grace`
- `tests/sync_r12_delta_gc.rs::r12_gc_orphan_needs_grace_and_first_seen_is_not_refreshed`
- `tests/sync_r12_delta_gc.rs::r12_gc_truncated_listing_fails_closed`
- `tests/sync_r12_delta_gc.rs::r12_gc_corrupt_descriptor_means_zero_deletes_and_zero_candidates`
- `tests/sync_r12_delta_gc.rs::r12_gc_wrong_password_or_policy_mismatch_means_zero_deletes`
- `tests/sync_r12_delta_gc.rs::r12_gc_held_lease_blocks_both_passes_with_zero_writes`
- `tests/sync_r12_delta_gc.rs::r12_gc_rereferenced_candidate_is_dropped_without_deleting_object`
- `tests/sync_r12_delta_gc.rs::r12_gc_candidate_codec_rejects_unknown_fields_and_out_of_scope_keys`

## 4. 已批准同族 `obsolete`：`sync_r12_delta_inventory.rs`（6 条）

`delta_inventory` 在裁决文档中同属 delta 族且「生产入口：无」；它只被
`delta_upload` / `delta_restore` 两个未接线模块引用。协调者已确认整族按
experimental 处理，下列 6 条行为测试已随 §3 一并标为 `obsolete`：

- `tests/sync_r12_delta_inventory.rs::r12_inventory_roundtrip_small_staging`
- `tests/sync_r12_delta_inventory.rs::r12_zero_change_reuses_everything_except_manifest`
- `tests/sync_r12_delta_inventory.rs::r12_sqlite_row_change_marks_only_that_file_upload_new`
- `tests/sync_r12_delta_inventory.rs::r12_diff_marks_deleted_paths`
- `tests/sync_r12_delta_inventory.rs::r12_logical_path_traversal_and_overlong_are_rejected`
- `tests/sync_r12_delta_inventory.rs::r12_staging_with_backslash_filename_or_symlink_fails_closed`

若 L21 后续决定发布 `build_inventory_cross_checked` 作为生产能力，需另行提出
恢复迁移的申请；当前按已批准的 experimental 隔离处理。

## 5. 批准后的处理（已完成）

1. 协调者已把批准写入 `migration/approvals.d/C2-platform.json`（main `294cbe65f`）；
   本 lane 未手改 approvals。
2. 本 lane 已将上述 43 条行为测试 + 6 条 inventory 的 TESTMAP 行改为
   `obsolete:dead-in-rust experimental`；5 条 source-lock 行为保持 `ported`。
3. `tests/delta-backup-v2.test.ts` 的生产实现测试仍保留在套件中运行
   （24 文件 / 249 用例），是否移除由协调者另行决定。
4. 不把 delta 族接到命令层 / UI / `sync_manager`；`sync-r12-locks.test.ts`
   的零接线源码锁继续保留。
