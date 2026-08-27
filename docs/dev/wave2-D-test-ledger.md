# 0824 Wave2-D 测试台账（R7 第 8 报）

> 只文档。不改产品。不执行测试。不 commit（由收轮统一处理）。不标 Goal complete。
> 快照基准：本枝 tip `20957f23`（R6 收轮提交），fetch 后远端一致，工作树干净。
> **R2–R6 全部测试均为「已写未跑」：零编译、零执行。下表红绿全部是静态读源推断，
> 第 8 轮才可执行验证。任何一个编译错误都会让整批推断作废。**

## 0. 判定口径

- **预期绿（静态）**：测试与其钉住的修复在同一轮（或更早）落地，静态读源判断断言应过。
- **预期红（静态）**：测试故意钉一个已知未修的缺口（红是设计目标，见 §8）。
- **待定**：断言依赖运行期行为（真实迁移器建库、tokio 并发调度、文件系统语义），静态无法收敛。
- 各测试源码内的「修复前红/修复前绿」注释是 R3 落笔时对*当时*实现的标注；本表给出的是对 **tip `20957f23`** 的静态预期，两者不同处已在备注说明。

## 1. R2（`00d50867`：配置 draft/test/publish 事务 + auto-sync 提升）

### 1.1 Rust inline（`cargo test --lib`，未跑）

| 文件 | 测试 | 静态预期 |
| --- | --- | --- |
| `src-tauri/src/secure_store.rs` | `staged_write_leaves_active_record_and_generation_untouched` | 绿 |
| 〃 | `commit_advances_generation_and_publishes_staged_values` | 绿 |
| 〃 | `abort_discards_staged_without_touching_active` | 绿 |
| 〃 | `staged_write_enforces_the_same_short_password_policy` | 绿 |
| 〃 | `stale_generation_handles_fail_closed_without_touching_active` | 绿 |
| 〃 | `commit_without_staged_record_fails_closed` | 绿 |
| 〃 | `transactional_delete_clears_active_staged_and_generation` | 绿 |

### 1.2 前端 vitest（未跑）

| 文件 | 状态 | 测试 | 静态预期 |
| --- | --- | --- | --- |
| `src/features/settings/components/__tests__/CloudStorageSection.draft-test.test.tsx` | **新增** | `a failing connection test persists nothing: no credentials, no SSOT, no publish`；`source contract: the test-connection path routes through testConnectionDraft` | 绿（R2 红灯设计：失败测试连接不得污染 SSOT；修复同轮落地） |
| `src/stores/__tests__/autoSyncStore.bootstrap.test.ts` | **新增** | `rehydrated enabled:true + ensureAutoSyncSchedulerStarted leaves a live startup timer`；`counterfactual: rehydrate alone never schedules — without an app-level ensure call there is no timer`；`app wiring contract: App.tsx starts the scheduler after persist hydration`；`ensureAutoSyncSchedulerStarted stays a no-op when the persisted toggle is off` | 绿（App.tsx 接线同轮落地；counterfactual 项钉「rehydrate 本身不排程」的既有事实） |
| `src/features/settings/components/__tests__/CloudStorageSection.cloudUi.test.tsx` | 改（对齐新路径） | 新增 `testing a connection goes through the draft command and never persists, even on failure` | 绿 |
| `src/features/settings/components/__tests__/cloudSyncPhase0.source.test.ts` | 改 | 新增 `publishes credentials and config as one logical commit, caching only after success`；`tests connections against the draft command without persisting anything` | 绿（源码契约测试） |
| `tests/vitest/data-governance/r09-ux-cloud-storage.test.tsx` | 改（对齐新路径） | 既有断言改指 draft/publish 命令 | 绿 |

## 2. R3（`57fa3fcc`：恢复域消费 + 稀疏 VFS 对象 + props 告警）

### 2.1 独立集成测试（`cargo test --test restore_domain_plan_tests`，未跑）

`src-tauri/tests/restore_domain_plan_tests.rs`（**新增文件**，9 件）：

| 测试 | 落笔时标注 | 对 tip 静态预期 |
| --- | --- | --- |
| `matrix_registry_locks_domain_terminal_contract` | 修复前绿 | 绿 |
| `full_snapshot_marks_all_matrix_domains_complete` | 修复前绿 | 绿 |
| `audit_complete_domain_restores_via_manifest_plan_consumer` | 修复前绿 | 绿 |
| `candidate_restore_lands_data_trust_domains_in_restore_target` | webview/grading 两断言修复前红 | 绿（消费者同轮落地） |
| `candidate_restore_isolates_executable_domains_pending_trust` | 隔离暂存两断言修复前红 | 绿（`.restore_pending_trust` 同轮落地） |
| `restore_assets_with_progress_never_materializes_agent_executables` | **修复前红** | **红**（见 §8：R6 二检确认函数本体仍无 trust 过滤，只有调用方过滤） |
| `unconsumed_audit_domain_rejected_in_slot_restore` | 修复前红 | 绿（未消费断言同轮落地） |
| `unconsumed_webview_settings_domain_rejected_in_candidate_restore` | 修复前红 | 绿 |
| `crypto_complete_domain_restores_key_material_end_state` | 修复前绿 | 绿 |

### 2.2 Rust inline（未跑）

| 文件 | 测试 | 静态预期 |
| --- | --- | --- |
| `src-tauri/src/data_governance/migration/coordinator.rs` | `test_sparse_vfs_v20260130_recorded_missing_index_fts_view_is_rejected` | 绿（红灯设计：只跑 table backfill 应被 verifier 拒；断言的是「拒」） |
| 〃 | `test_sparse_vfs_after_init_object_backfill_passes_verifier` | 绿（`apply_vfs_init_missing_schema_objects` 同轮落地） |
| 〃 | `test_sparse_vfs_full_migrate_entry_never_reports_success_without_init_objects` | 绿 |
| `src-tauri/src/data_governance/restore_codes.rs` | `stable_code_literals_are_frozen`；`tagged_message_matches_bracket_prefix_convention`；`codes_are_distinct` | 绿（字面量冻结） |
| `src-tauri/src/vfs/note_props.rs` | `valid_operator_keys_pass_all_three_syntaxes`；`storable_keys_outside_operator_syntax_are_pinned`；`invalid_keys_are_rejected_with_expected_category`；`normalize_drops_only_empty_keys`；`parse_props_cell_accepts_nonempty_object_and_preserves_json_types`；`parse_props_cell_null_is_silent_and_uncounted`；`parse_props_cell_counts_invalid_json`；`parse_props_cell_counts_non_object`；`parse_props_cell_counts_empty_object`；`snippet_truncates_long_raw_on_char_boundary`（10 件） | 绿 |
| `src-tauri/src/vfs/repos/note_repo.rs` | `test_row_to_note_malformed_props_fall_back_with_trace`；`test_note_props_shared_key_vectors_round_trip_write_side` | 绿 |
| `src-tauri/src/dstu/handler_utils/search_helpers.rs` | `note_prop_filters_agree_with_shared_key_vectors` | 绿（共享向量镜像） |
| `src-tauri/src/data_governance/backup/restore_plan.rs` | `consume_restores_persistent_settings_and_reports_every_ledger_domain`；`untrusted_user_skills_are_quarantined_not_written_to_restore_target`；`unconsumed_complete_domain_fails_with_stable_code`；`primary_domain_missing_from_slot_is_reported_unconsumed` | 绿 |

### 2.3 前端 vitest（未跑）

| 文件 | 状态 | 内容 | 静态预期 |
| --- | --- | --- | --- |
| `src/features/workbench/apps/notes/__tests__/parseTagQuery.test.ts` | 改（只读对齐，越权记录在案） | 新增 describe `shared prop key syntax vectors (mirror of vfs::note_props::test_vectors)`：3 件 | 绿 |

## 3. R4（`d80a529a`：GET 预算 + verified publish + E2EE 租约 + 防降级）

### 3.1 独立集成测试（`cargo test --test e2ee_claim_race_tests`，未跑）

`src-tauri/tests/e2ee_claim_race_tests.rs`（**新增文件**，4 件，multi-thread tokio 并发竞态）：

| 测试 | 静态预期 |
| --- | --- |
| `race_empty_root_concurrent_claim_with_two_passwords_at_most_one_succeeds` | 绿·待定（断言逻辑成立；真并发调度只有跑了才知道稳不稳） |
| `race_second_device_must_not_overwrite_existing_marker` | 绿·待定 |
| `race_v1_to_v2_upgrade_must_not_let_both_devices_win` | 绿·待定 |
| `race_v1_to_v2_upgrade_same_password_writes_marker_at_most_once` | 绿·待定 |

### 3.2 Rust inline（未跑，共 46 件）

| 文件 | 测试（数量） | 静态预期 |
| --- | --- | --- |
| `src-tauri/src/cloud_storage/bad_object.rs`（新增模块） | `bad_final_with_verified_tmp_converges`；`bad_final_without_tmp_fails_closed_and_quarantines`；`user_backup_data_object_is_never_auto_deleted`；`healthy_final_is_untouched`；`unverifiable_tmp_is_not_trusted_and_is_retained`；`missing_final_with_verified_tmp_converges_without_quarantine`；`missing_final_without_tmp_is_absent`；`newest_verified_tmp_wins`；`rejects_non_final_keys`（9） | 绿 |
| `src-tauri/src/cloud_storage/e2ee_claim.rs`（新增模块） | `first_claim_writes_lease_then_marker_and_cleans_lease`；`claim_fails_when_marker_already_exists`；`live_foreign_lease_blocks_claim_and_never_writes_marker`；`expired_foreign_lease_is_reclaimed`；`corrupted_fresh_lease_fails_closed_and_stale_one_is_reclaimed`；`legacy_v1_upgrade_hands_snapshot_to_builder_and_rejects_v2`；`lease_overwritten_before_readback_aborts_without_marker_write`；`lease_stolen_after_marker_write_reports_failure_without_rollback`；`conditional_put_backend_claims_without_lease_and_second_claim_conflicts`；`oversized_lease_object_fails_closed_within_ttl_window`（10） | 绿（注意 R6 对过期回收改为 `delete_if_unchanged=false` fail-closed，`expired_foreign_lease_is_reclaimed` 若未随 R6 同步语义则可能红——R6 diff 触碰了本文件，静态判断已对齐，标绿·待定） |
| `src-tauri/src/cloud_storage/verified_publish.rs`（新增模块） | `happy_path_publishes_and_cleans_tmp`；`oversize_data_rejected_before_any_write`；`conditional_publish_fails_closed_without_cas`；`tmp_corruption_keeps_tmp_and_never_touches_final_key`；`final_corruption_with_isolate_bad_renames_bad_object`；`final_corruption_with_keep_tmp_leaves_bad_object_in_place`；`traversal_key_rejected`（7） | 绿 |
| `src-tauri/src/cloud_storage/sync_manager.rs` | `first_claim_blocked_by_foreign_live_lease`；`expired_foreign_lease_reclaimed_then_claim_succeeds`；`v1_upgrade_blocked_by_foreign_live_lease`；`publish_recheck_rejects_marker_swapped_between_verify_and_publish`；`oversized_marker_fails_closed_for_both_upload_paths`；`concurrent_two_password_claims_never_both_succeed`（6） | 绿·待定（并发件同 §3.1） |
| `src-tauri/src/cloud_storage/traits.rs` | `get_budget_small_chunks_flooding_aborts_and_buffer_stays_bounded`；`get_budget_rejects_oversized_declared_length_before_body`；`get_budget_unknown_length_stream_aborts_over_budget`；`default_get_bounded_enforces_budget_for_test_doubles`（4） | 绿 |
| `src-tauri/src/cloud_storage/ftp.rs` | `stream_to_file_aborts_oversized_stream_midway`；`with_retry_does_not_retry_budget_exceeded_errors`（2） | 绿 |
| `src-tauri/src/cloud_storage/mod.rs` | `download_rejected_when_marker_present_but_object_not_dsbk`；`download_allowed_when_marker_present_and_object_is_dsbk`；`download_allowed_for_legacy_plaintext_without_marker`；`download_allowed_for_dsbk_without_marker`；`download_head_classification_matches_backup_crypto_magic`（5） | 绿（R6 在同文件加了本机记忆双门，未改这 5 件的输入组合） |
| `src-tauri/src/data_governance/commands_sync.rs` | `concurrent_direct_tombstone_marks_serialize_or_fail_busy`；`tombstone_limiter_busy_code_is_stable`；`tombstone_direct_commands_take_permit_and_keep_readback_invariant`（3，其中第三件为源码锁） | 绿 |
| `src-tauri/src/cloud_storage/webdav.rs` / `s3.rs` | 既有源码锁测试 `webdav_contract_source_guards` / `put_file_source_guards_remote_size_check` **扩断言**（`[R4-get-budget]` 三件套：`get_bounded` / 声明预检 / 兜底预算） | 绿 |

## 4. R5（`60dfb9af`：prove 首块 + 导出合并 + KDF/熵 + 迁移锁；同轮含文案收敛批）

### 4.1 独立集成测试（`cargo test --test sync_r13_migration_change_log_propagation`，未跑）

`src-tauri/tests/sync_r13_migration_change_log_propagation.rs`（**新增文件**，3 件；用真实迁移协调器建库）：

| 测试 | 静态预期 |
| --- | --- |
| `v20260824_normalization_updates_enter_change_log_as_pending` | 绿·待定（依赖真实触发器装配顺序，静态读 SQL 判断成立） |
| `v20260824_null_source_tombstone_sweep_enters_change_log` | 绿·待定 |
| `gap_v20260302_folder_items_normalization_never_entered_change_log` | 绿（**钉历史缺口为已知行为**，不是修复；缺口本身不在本 Wave 修） |

### 4.2 Rust inline（未跑，共 36 件）

| 文件 | 测试（数量） | 静态预期 |
| --- | --- | --- |
| `src-tauri/src/crypto/backup_crypto.rs` | KDF 帽 4 件：`new_password_cap_matches_platform_and_never_loosens_global_cap`；`new_password_cap_covers_default_write_surface_on_every_platform`；`session_with_params_rejects_m_cost_above_new_password_cap`；`decrypt_and_legacy_verifier_paths_are_not_tightened_by_new_password_cap`。首块试解 8 件：`first_chunk_trial_proves_password_with_prefix_only`；`first_chunk_trial_final_flag_matches_object_size`；`first_chunk_trial_tampered_first_block_fails`；`first_chunk_plan_v1_requires_whole_file`；`first_chunk_plan_rejects_bad_headers`；`first_chunk_trial_truncated_prefix_rejected`；`first_chunk_trial_oversized_kdf_params_rejected_fast`；`speculative_prefix_len_covers_own_write_surface`（12） | 绿 |
| `src-tauri/src/cloud_storage/sync_manager.rs` | prove 6 件：`prove_uses_first_chunk_without_full_download_for_v2`（计数存储断言零整包 get）；`prove_wrong_password_fails_fast_on_first_chunk`；`prove_falls_back_to_second_newest_when_latest_corrupt`；`prove_v1_container_still_proves_via_whole_file`；`prove_plain_zip_detected_from_prefix_without_full_download`；`prove_non_default_chunk_triggers_precise_topup_read` | 绿 |
| `src-tauri/src/cloud_storage/traits.rs` | `default_get_prefix_fails_closed`（1） | 绿 |
| `src-tauri/src/data_governance/backup/portable_precheck.rs`（新增模块） | `no_password_is_left_to_existing_missing_password_gate`；`explicit_password_on_portable_zip_fails_fast_in_both_modes`；`wrong_password_on_sealed_zip_fails_fast_without_resume`；`correct_password_on_sealed_zip_passes_precheck`；`resumable_sealed_zip_defers_wrong_password_to_unseal_layer`；`corrupted_sealed_payload_fails_fast_with_any_password`；`import_portable_zip_with_explicit_password_fails_before_touching_target`；`import_sealed_zip_with_wrong_password_fails_before_touching_target`；`progress_import_sealed_zip_wrong_password_never_reaches_extract_phase`（9） | 绿 |
| `src-tauri/src/data_governance/backup/zip_export.rs` | `test_export_cancel_token_set_midway_stops_export`；`test_export_encrypted_cancel_token_set_midway_stops_export`；`test_export_progress_reports_all_phases_monotonically`（3） | 绿 |
| `src-tauri/src/secure_store.rs` | 弱口令 5 件：`weak_password_predicate_semantics`；`new_password_gate_checks_length_before_weakness`；`new_weak_encryption_password_is_rejected_and_not_persisted`；`preexisting_weak_encryption_password_is_accepted`；`staged_write_enforces_the_same_weak_password_policy` | 绿（红线：存量弱口令不收紧，`preexisting_*` 正是钉这条） |
| `src-tauri/src/cloud_storage/webdav.rs` / `s3.rs` | 既有源码锁再扩断言（`supports_prefix_read` / `get_prefix` Range 实现锁） | 绿 |

### 4.3 前端 vitest（未跑）

| 文件 | 状态 | 内容 | 静态预期 |
| --- | --- | --- | --- |
| `tests/vitest/data-governance/syncE2eeErrorMapping.test.ts` | 改 | 新增 `classifies R4 anti-downgrade rejections ahead of the plaintext-legacy bucket`；`classifies R4 claim-lease conflicts`；describe `E2EE 稳定 code 跨层契约`（含 `e2ee_claim.rs` 跨层码一致性） | 绿 |

## 5. R6（`20957f23`：二检翻案补丁）

### 5.1 Rust inline（未跑，共 6 件）

| 文件 | 测试 | 静态预期 |
| --- | --- | --- |
| `src-tauri/src/cloud_storage/bad_object.rs` | `verified_publish_style_tmp_residue_converges`；`tmp_object_key_recognition_covers_both_generations`（认两代 tmp 名） | 绿 |
| `src-tauri/src/cloud_storage/mod.rs` | `download_rejected_when_marker_deleted_but_locally_remembered`；`download_allowed_for_dsbk_when_locally_remembered`；`download_opt_in_allows_plaintext_history_once`；`download_opt_in_has_no_effect_on_ciphertext_and_default_still_rejects`（本机记忆双门 + 休眠 opt-in，4 件） | 绿 |

### 5.2 前端 vitest（未跑）

| 文件 | 状态 | 测试 | 静态预期 |
| --- | --- | --- | --- |
| `src/stores/__tests__/autoSyncStore.bootstrap.idempotent.test.ts` | **新增** | `repeated ensure calls before the first run leave exactly one live timer`；`re-ensuring after a completed round must not stack a second schedule`；`duplicate ensure calls never cause duplicate rounds to execute`（3 件） | 绿 |

## 6. R7（本轮）

截至本台账落笔（tip `20957f23`，工作树与远端均无新增），**R7 尚无测试文件落盘**。R6 收轮排定的 R7 测试任务如下，若并行子任务在本轮内落盘，以收轮 diff 为准，不在本表预登记红绿：

| 计划项 | 目标文件（预计） | 预期性质 |
| --- | --- | --- |
| P9 crypto journal 三点注入故障矩阵（非对称部分 rename / `remove_journal` 失败分支；只写不跑） | `src-tauri/src/crypto_publication.rs`（现有 7 件 Step 22 测试之上补矩阵） | 视是否随修复同落而定 |
| 钉 `restore_assets_with_progress` 函数本体 trust 过滤 | 已有 §2.1 第 6 件在钉，**静态预期红** | 红（除非 R7 修函数本体） |

## 7. 范围外备注（R1）

R1（`48aa8789`）另有 1 件测试源码同样未跑：`test_resumable_import_never_skips_manifest_json`（`src-tauri/src/data_governance/backup/zip_export.rs`，manifest.json/.db 不可跳过）。静态预期绿。不计入 R2–R7 汇总，仅在此备案避免第 8 轮漏跑。

## 8. 静态预期红清单（第 8 轮必须先看这里）

只有 1 件是**设计上的红**：

1. `restore_assets_with_progress_never_materializes_agent_executables`
   （`src-tauri/tests/restore_domain_plan_tests.rs:517`）——R3 落笔标注「修复前红」；
   R6 二检确认 `restore_assets_with_progress` **函数本体**仍无 trust 过滤（生产调用方已过滤，
   G4 不变量在调用点成立）。此件红不代表生产路径失守，代表函数级防线欠账，排在 R7/R8 修。
   如果第 8 轮跑出它是绿的，说明有人在本表之后修了函数本体——须核对 diff 而不是直接采信。

其余全部静态预期绿。任何额外的红都意味着：编译错误、断言与 R6 补丁语义错位（重点怀疑
`e2ee_claim.rs::expired_foreign_lease_is_reclaimed` 对 fail-closed 回收的适配）、或并发调度不稳
（§3.1、`concurrent_two_password_claims_never_both_succeed`、`concurrent_direct_tombstone_marks_serialize_or_fail_busy`）。

## 9. 第 8 轮执行清单（本轮禁止执行，仅静态列出）

```
# Rust（src-tauri/）
cargo test --lib                                              # §1–§5 全部 inline
cargo test --test restore_domain_plan_tests                   # §2.1
cargo test --test e2ee_claim_race_tests                       # §3.1
cargo test --test sync_r13_migration_change_log_propagation   # §4.1

# 前端
npx vitest run \
  src/features/settings/components/__tests__/CloudStorageSection.draft-test.test.tsx \
  src/features/settings/components/__tests__/CloudStorageSection.cloudUi.test.tsx \
  src/features/settings/components/__tests__/cloudSyncPhase0.source.test.ts \
  src/stores/__tests__/autoSyncStore.bootstrap.test.ts \
  src/stores/__tests__/autoSyncStore.bootstrap.idempotent.test.ts \
  tests/vitest/data-governance/r09-ux-cloud-storage.test.tsx \
  tests/vitest/data-governance/syncE2eeErrorMapping.test.ts \
  src/features/workbench/apps/notes/__tests__/parseTagQuery.test.ts
```

汇总：R2–R6 已写未跑 Rust inline 118 件（R2 7 + R3 23 + R4 46 + R5 36 + R6 6）+
独立集成 16 件（3 个新测试文件）+ 前端新增/改动 8 个 vitest 文件
（新增用例 12 件、对齐改动若干）。静态预期红 1 件（§8）。
