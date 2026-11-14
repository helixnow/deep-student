# F3-storage 测试去向（地基线；实现目录不归 scaffold 所有，去向同样由该 lane 填写）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane F3-storage：362 行（真实测试 362）· merged 8 · obsolete 30 · pending 3 · ported 321
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-storage/src/backup_common.rs::tests::process_operation_lock_blocks_a_second_holder` | test | L1021 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_calculate_file_hash_known_content` | test | L1051 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_calculate_file_hash_empty_file` | test | L1065 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_calculate_file_hash_nonexistent_file` | test | L1077 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_calculate_bytes_hash` | test | L1083 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_removes_all_sensitive_entries` | test | L1092 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_fails_closed_on_removal_error` | test | L1115 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_fails_closed_when_entry_remains` | test | L1132 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_crypto_secret_relative_path_matching_is_component_scoped` | test | L1144 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_matches_ascii_case_variants` | test | L1164 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_removes_symlink_without_touching_target` | test | L1177 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_strip_crypto_secrets_rejects_symlinked_backup_root` | test | L1195 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_zip_security_normal_zip` | test | L1213 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_zip_security_rejects_oversized_file` | test | L1233 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_zip_security_rejects_extreme_ratio` | test | L1249 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_zip_security_rejects_too_many_files` | test | L1265 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_is_symlink_regular_file` | test | L1284 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_is_symlink_actual_symlink` | test | L1294 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_get_available_disk_space_current_dir` | test | L1311 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_log_and_skip_entry_err_ok_value` | test | L1323 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_log_and_skip_entry_err_err_value` | test | L1330 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_copy_directory_safe_basic` | test | L1341 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_copy_directory_safe_skips_symlinks` | test | L1372 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_path_not_symlink_regular_file` | test | L1400 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/backup_common.rs::tests::test_check_path_not_symlink_rejects_symlink` | test | L1410 | ported:host/platform/storage/tests/backup-common.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_ensure_layout_creates_directories` | test | L2691 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_read_write_state_roundtrip` | test | L2710 | ported:host/platform/storage/tests/locations.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_atomic_write_state_file_content` | test | L2732 | ported:host/platform/storage/tests/locations.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_corruption_recovery_from_tmp` | test | L2759 | ported:host/platform/storage/tests/locations.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_corruption_recovery_infer_from_dirs` | test | L2785 | ported:host/platform/storage/tests/locations.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_mark_pending_switch` | test | L2807 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_mark_pending_switch_empty_target_fails` | test | L2829 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_initialize_on_start_valid_pending` | test | L2842 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_initialize_on_start_invalid_pending` | test | L2870 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_initialize_on_start_rolls_back_uncommitted_crypto_publication` | test | L2894 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_initialize_on_start_rolls_forward_committed_crypto_publication` | test | L2931 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_initialize_on_start_pending_empty_slot` | test | L2972 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_verify_slot_integrity_healthy` | test | L2999 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_verify_slot_integrity_empty_slot` | test | L3030 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_verify_slot_integrity_missing_dir` | test | L3050 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_slot_integrity_report_is_healthy` | test | L3069 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_slot_size_calculation` | test | L3105 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_slot_basic_methods` | test | L3134 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_ensure_layout_idempotent` | test | L3161 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_active_inactive_slot` | test | L3181 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_clear_slot_for_restore_moves_residual_to_trash` | test | L3204 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_clear_slot_for_restore_rejects_active_slot` | test | L3240 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_clear_slot_for_restore_empty_slot_is_noop` | test | L3255 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::restore_cutover_lease_survives_restart_until_activation_commit` | test | L3267 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::legacy_slot_backups_are_durably_migrated_and_idempotent` | test | L3292 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::test_slot_integrity_report_summary` | test | L3316 | ported:host/platform/storage/tests/data-space.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_detects_conflict_and_quarantines_legacy_root` | test | L3351 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_can_select_existing_slot_without_merging_legacy` | test | L3384 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_can_restore_legacy_and_archive_slot_a` | test | L3420 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_reinspection_is_idempotent` | test | L3458 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_rejects_candidates_without_known_core_databases` | test | L3496 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_resolution_error_remains_visible_and_retryable` | test | L3522 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::startup_recovery_can_expose_an_ephemeral_preflight_failure` | test | L3547 | ported:host/platform/storage/tests/startup-recovery.test.ts |
| `crates/dstu-storage/src/data_space.rs::tests::recovery_export_staging_stays_outside_incidents_and_purges_stale_files` | test | L3568 | ported:host/platform/storage/tests/recovery-export.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::primary_path_takes_precedence_over_legacy` | test | L335 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::legacy_id_is_migrated_to_primary_once` | test | L348 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::legacy_candidates_are_consulted_in_priority_order` | test | L368 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::generated_id_is_persisted_to_primary_and_stable_afterwards` | test | L382 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::persist_failure_is_reported_instead_of_faked` | test | L396 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::persist_writes_primary_and_refreshes_existing_legacy_copies` | test | L415 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::persist_fails_when_primary_is_unwritable` | test | L443 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::persist_falls_back_to_legacy_when_primary_unavailable` | test | L457 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::persist_rejects_empty_identity` | test | L469 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/data_space/device_id.rs::device_id_tests::read_device_id_file_normalizes_and_rejects_blank` | test | L476 | ported:host/platform/paths/paths.test.ts |
| `crates/dstu-storage/src/database/maintenance.rs::tests::state_machine_enforces_single_owner_and_fail_close_transitions` | test | L217 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/maintenance.rs::tests::placeholder_pool_never_hands_out_connections` | test | L247 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/maintenance.rs::tests::deny_all_placeholder_connection_rejects_reads_and_writes` | test | L257 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/maintenance.rs::tests::drain_waits_for_outstanding_lease_and_times_out_otherwise` | test | L271 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/maintenance.rs::tests::strict_checkpoint_succeeds_on_healthy_wal_database` | test | L296 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/manager.rs::tests::maintenance_barrier_fails_closed_and_preserves_data` | test | L278 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/manager.rs::tests::maintenance_barrier_is_exclusive_and_exit_is_idempotent` | test | L319 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/manager.rs::tests::maintenance_barrier_drains_in_flight_connections_or_fails` | test | L340 | merged:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::maintenance_barrier_fails_closed_for_all_connection_paths` | test | L8118 | ported:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::bundled_sqlite_contains_wal_reset_corruption_fix` | test | L8238 | ported:host/platform/storage/tests/database.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::large_setting_upsert_preserves_rowid_and_integrity` | test | L8247 | ported:host/platform/storage/tests/settings-consumer.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::sensitive_secret_secure_write_failure_does_not_write_plaintext` | test | L8287 | ported:host/platform/storage/tests/settings-secrets.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::sensitive_secret_db_delete_failure_is_reported_and_secure_write_is_rolled_back` | test | L8329 | ported:host/platform/storage/tests/settings-secrets.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::sensitive_secret_success_removes_legacy_plaintext_row` | test | L8368 | ported:host/platform/storage/tests/settings-secrets.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::sensitive_secret_read_migrates_legacy_plaintext_row` | test | L8390 | ported:host/platform/storage/tests/settings-secrets.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::sensitive_secret_delete_cleans_legacy_row_even_when_secure_store_fails` | test | L8411 | ported:host/platform/storage/tests/settings-secrets.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::append_preserves_turn_metadata_and_scoped_deletion` | test | L8435 | obsolete:dead-in-rust（C2 approvals.d 已批准；无生产调用入口） |
| `crates/dstu-storage/src/database/mod.rs::tests::save_document_task_with_cards_atomic_rolls_back_when_all_cards_ignored` | test | L8595 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::update_anki_card_rows_reports_zero_when_id_missing` | test | L8676 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::document_task_status_update_rejects_missing_and_tombstoned_tasks` | test | L8740 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::export_receipts_only_update_live_cards_with_live_parents` | test | L8794 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::list_anki_library_cards_exposes_generation_source_and_session` | test | L8883 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::list_anki_library_cards_filters_and_counts_by_deck` | test | L8928 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::list_anki_library_cards_paginates_live_cards_with_active_fsrs_state` | test | L9065 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::list_anki_library_cards_searches_tags_and_escapes_like_wildcards` | test | L9264 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::generic_anki_writes_reject_tombstoned_cards_and_parent_tasks` | test | L9321 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::document_sessions_and_anki_stats_exclude_task_and_card_tombstones` | test | L9412 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::agent_library_reads_and_content_cas_cover_null_and_foreign_sessions` | test | L9497 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::agent_library_cards_by_ids_preserve_order_and_fail_closed` | test | L9589 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::soft_delete_builtin_template_keeps_row_and_sets_tombstone` | test | L9689 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::mark_template_user_modified_only_affects_builtin_rows` | test | L9722 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/database/mod.rs::tests::replace_custom_template_content_keeps_id_and_builtin_flag` | test | L9744 | ported:host/platform/storage/tests/anki-domain.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::test_feature_flag_creation` | test | L454 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::test_feature_flag_state_changes` | test | L467 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::test_feature_flag_manager` | test | L485 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::test_gradual_rollout` | test | L502 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::test_user_specific_flags` | test | L528 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::workbench_browser_flags_defaults` | test | L548 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::merge_missing_defaults_adds_enabled_workbench_agent` | test | L576 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/feature_flags.rs::tests::merge_missing_defaults_preserves_disabled_workbench_agent` | test | L589 | ported:host/platform/storage/tests/feature-flags.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::recovers_crash_after_prepare` | test | L824 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::recovers_crash_after_file_delete` | test | L850 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::ready_outbox_failure_is_visible_and_recoverable` | test | L877 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::changed_content_cancels_recovery` | test | L910 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::duplicate_operation_id_is_idempotent_only_for_same_intent` | test | L940 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::prepared_asset_intent_rolls_back_with_business_metadata` | test | L986 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_deletion_queue.rs::tests::missing_local_asset_still_produces_ready_remote_deletion` | test | L1033 | ported:host/platform/storage/tests/file-deletion-queue.test.ts |
| `crates/dstu-storage/src/file_manager.rs::note_asset_path_tests::rejects_traversal_subject_and_note_id` | test | L1450 | ported:host/platform/storage/tests/file-manager.test.ts |
| `crates/dstu-storage/src/file_manager.rs::note_asset_path_tests::accepts_plain_segments` | test | L1460 | ported:host/platform/storage/tests/file-manager.test.ts |
| `crates/dstu-storage/src/file_manager.rs::note_asset_path_tests::serializes_relative_asset_paths_with_forward_slashes` | test | L1470 | ported:host/platform/storage/tests/file-manager.test.ts |
| `crates/dstu-storage/src/file_manager.rs::image_quality_tests::bytes_quality_preserves_original_on_noop_or_invalid_image` | test | L1492 | ported:host/platform/storage/tests/image-quality-service.test.ts |
| `crates/dstu-storage/src/file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions` | test | L1513 | ported:host/platform/storage/tests/image-quality-native.test.ts |
| `crates/dstu-storage/src/injection_budget.rs::tests::test_injection_item_creation` | test | L469 | ported:host/platform/storage/tests/injection-budget-exact.test.ts |
| `crates/dstu-storage/src/injection_budget.rs::tests::test_budget_allocation_basic` | test | L483 | ported:host/platform/storage/tests/injection-budget-exact.test.ts |
| `crates/dstu-storage/src/injection_budget.rs::tests::test_priority_allocation` | test | L506 | ported:host/platform/storage/tests/injection-budget-exact.test.ts |
| `crates/dstu-storage/src/injection_budget.rs::tests::test_type_limits` | test | L538 | ported:host/platform/storage/tests/injection-budget-exact.test.ts |
| `crates/dstu-storage/src/injection_budget.rs::tests::test_smart_truncation` | test | L560 | ported:host/platform/storage/tests/injection-budget-exact.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_collector_creation` | tokio::test | L634 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_single` | tokio::test | L641 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_from_api_response` | tokio::test | L661 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_batch` | tokio::test | L695 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_writes_real_adapter_and_token_source` | tokio::test | L718 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_writes_cache_write_tokens_null_means_unmeasured` | tokio::test | L756 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_shutdown` | tokio::test | L793 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_after_shutdown` | tokio::test | L822 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_record_with_error` | tokio::test | L837 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/collector.rs::tests::test_extract_provider` | test | L870 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_database_creation` | test | L609 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_migrations_idempotent` | test | L621 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_direct_initializer_repairs_v20260824_column_without_history` | test | L641 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_foreign_keys_enabled` | test | L694 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_get_connection` | test | L704 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_get_statistics` | test | L721 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_tables_created` | test | L735 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_indexes_created` | test | L756 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_insert_usage_log` | test | L782 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_daily_summary_upsert` | test | L826 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_maintenance_barrier_fails_closed_and_preserves_data` | test | L858 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_maintenance_barrier_drains_in_flight_connections_or_fails` | test | L910 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/database.rs::tests::test_reinitialize` | test | L934 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/mod.rs::tests::pending_queue_is_bounded` | test | L341 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_insert_and_query` | test | L734 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_get_summary` | test | L747 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_insert_usage_writes_real_adapter_and_token_source` | test | L760 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_cache_debug_usage_line_reports_hit_ratio` | test | L786 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_insert_usage_persists_cache_write_tokens_and_null_unmeasured` | test | L802 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/repo.rs::tests::test_insert_usage_prefers_explicit_provider_id` | test | L848 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/types.rs::tests::test_caller_type_display` | test | L839 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/types.rs::tests::test_caller_type_from_str` | test | L850 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/types.rs::tests::test_usage_record_builder` | test | L869 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/types.rs::tests::test_daily_summary_accumulate` | test | L887 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/llm_usage/types.rs::tests::test_time_granularity_display` | test | L905 | ported:host/platform/storage/tests/llm-usage.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_migration_set_structure` | test | L670 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_v20260130_migration` | test | L676 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_expected_tables_count` | test | L687 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_expected_indexes_count` | test | L692 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_latest_version` | test | L698 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_v20260528_rebuild_removes_type_check_and_preserves_data` | test | L706 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_v20260711_session_tags_emit_unambiguous_composite_keys` | test | L774 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_pending_migrations` | test | L860 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_get_compaction_migration` | test | L882 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/chat_v2.rs::tests::test_v20260910_revocation_epochs_and_budget_idempotent` | test | L892 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::sql_splitter_keeps_case_end_inside_trigger_body` | test | L5600 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::sql_splitter_delegates_quotes_comments_and_transactions_to_sqlite` | test | L5620 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_v0944_vfs_upgrade_adds_nullable_note_props_without_touching_rows` | test | L5639 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_v20260824_duplicate_column_rerun_is_repaired_and_preserves_props` | test | L5667 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_v20260824_recorded_schema_gap_backfills_props_column` | test | L5699 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_new_coordinator` | test | L5854 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_database_paths` | test | L5860 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migration_report` | test | L5887 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_needs_migration_nonexistent_db` | test | L5920 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_pending_migrations_count_empty` | test | L5931 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_get_current_version_no_table` | test | L5944 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_check_dependencies_success` | test | L5957 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_legacy_baseline_skips_when_init_contract_missing` | test | L5984 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_legacy_baseline_writes_record_when_init_contract_satisfied` | test | L6015 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_apply_mistakes_init_compat_repairs_legacy_schema` | test | L6049 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_extract_vfs_init_create_tables_includes_change_log_parents` | test | L6098 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_pre_repair_vfs_backfills_questions_before_change_log` | test | L6118 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_vfs_init_backfill_restores_recorded_note_props_contract` | test | L6179 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_vfs_v20260130_recorded_missing_index_fts_view_is_rejected` | test | L6314 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_vfs_after_init_object_backfill_passes_verifier` | test | L6395 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_vfs_full_migrate_entry_never_reports_success_without_init_objects` | test | L6464 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_matrix_vfs_missing_idx_folders_parent_rejected_then_backfilled` | test | L6711 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_matrix_vfs_missing_questions_fts_rejected_then_backfilled` | test | L6734 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_matrix_vfs_missing_trash_view_rejected_then_backfilled` | test | L6778 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_sparse_matrix_vfs_missing_all_three_objects_rejected_then_backfilled` | test | L6797 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_verify_migrations_persists_schema_fingerprint` | test | L6811 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_verify_migrations_detects_schema_fingerprint_drift` | test | L6860 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_newer_history_does_not_create_or_update_fingerprint` | test | L6916 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_prior_scope_fingerprint_is_recovered` | test | L6985 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_recovery_rejects_changed_trigger_sql` | test | L7023 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_recovery_rejects_unrelated_managed_schema_drift` | test | L7054 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_prior_scope_fingerprint_is_recovered_and_stable` | test | L7084 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_recovers_v20260719_historical_scope_fingerprint` | test | L7137 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_recovery_rejects_changed_journal_table_sql` | test | L7180 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_recovery_rejects_changed_journal_index_sql` | test | L7210 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_recovery_rejects_changed_journal_trigger_sql` | test | L7241 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_v20260721_recovery_rejects_malformed_stored_hash` | test | L7272 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_known_chat_v2_prior_scope_recovery_rejects_unlisted_versions_and_databases` | test | L7303 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_vfs_recorded_v20260714_schema_gap_is_repaired_idempotently` | test | L7349 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_unknown_checksum_drift_fails_close` | test | L7525 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migration_name_conflict_fails_close` | test | L7570 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_baseline_zero_checksum_is_aligned_to_real_checksum` | test | L7599 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_startup_compat_replay_respects_version_boundary` | test | L7641 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_mistakes_recorded_v20260523_document_tasks_gap_is_repaired_and_rebaselined` | test | L7672 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_schema_fingerprint_ignores_runtime_managed_objects` | test | L7823 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_schema_fingerprint_rebaselines_legacy_broad_scope_record` | test | L7869 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_apply_mistakes_init_compat_is_idempotent_on_sparse_legacy_schema` | test | L7946 | ported:host/platform/storage/tests/repairs.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migrate_single_mistakes_recovers_partial_legacy_database` | test | L8047 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migrate_single_mistakes_reentrant_after_recovery` | test | L8136 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_check_dependencies_failure` | test | L8192 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_core_backup_creates_snapshot_for_four_core_dbs` | test | L8213 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_core_backup_only_once_in_same_process_for_same_data_dir` | test | L8241 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_core_backup_skips_when_no_pending_migrations` | test | L8264 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_core_backup_preflight_isolates_unreadable_database` | test | L8294 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_reproduce_llm_usage_v20260202_failure` | test | L8329 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_reproduce_mistakes_v20260208_v20260209_failure` | test | L8397 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_failpoint_injection_keeps_core_state_atomic_and_retry_succeeds` | test | L8659 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_vfs_failure_blocks_dependency_closure_but_not_llm_usage` | test | L8797 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_chat_failure_isolated_from_mistakes_and_llm_usage` | test | L8836 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_failpoint_before_restore_leaves_untouched_state_consistent` | test | L8873 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_failpoint_after_restore_disk_recovered_despite_reported_failure` | test | L8926 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_failpoint_unarmed_is_noop_and_guard_disarms_on_drop` | test | L8972 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_make_alter_columns_safe_replays_backfill_when_all_columns_exist` | test | L9042 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_make_alter_columns_safe_completes_partial_columns_and_backfills` | test | L9092 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migrate_single_recovers_alter_residue_without_skipping_backfill` | test | L9135 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_llm_usage_v20260824_recovers_column_without_history_and_reruns` | test | L9177 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migration_fails_cleanly_when_database_write_locked_then_retries` | test | L9268 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_migration_fails_cleanly_on_readonly_database_then_retries` | test | L9315 | ported:host/platform/storage/tests/coordinator.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_restore_without_snapshot_errors_explicitly` | test | L9360 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_restore_overwrites_tampered_data_and_cleans_stale_wal_files` | test | L9371 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_single_database_restore_does_not_rewind_unrelated_databases` | test | L9424 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/coordinator.rs::tests::test_restore_picks_latest_snapshot` | test | L9470 | ported:host/platform/storage/tests/backup.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_migration_set_structure` | test | L218 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_v20260130_migration` | test | L224 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_expected_tables_count` | test | L235 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_sql_content_not_empty` | test | L240 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_latest_version` | test | L246 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/llm_usage.rs::tests::test_pending_migrations` | test | L251 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_migration_set_structure` | test | L503 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_v20260130_migration` | test | L512 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_expected_tables_count` | test | L533 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_expected_indexes_count` | test | L538 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_sql_content_not_empty` | test | L543 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_latest_version` | test | L555 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_get_migration` | test | L563 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mistakes.rs::tests::test_recent_sync_migrations_are_registered` | test | L579 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_all_migration_sets_count` | test | L243 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_all_migration_sets_names` | test | L248 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_get_migration_set` | test | L260 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_all_sets_have_migrations` | test | L269 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_all_sets_have_valid_versions` | test | L280 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/mod.rs::tests::test_all_migration_scripts_pass_checker` | test | L295 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_missing_cleanup` | test | L921 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_with_cleanup` | test | L938 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_fk_without_cleanup` | test | L954 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_fk_with_cleanup` | test | L969 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_fk_in_brand_new_table_passes` | test | L989 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_fk_outside_table_body_not_exempted` | test | L1011 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_check_fk_rebuild_after_brand_new_table_still_checked` | test | L1035 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_skip_check_marker` | test | L1058 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_skip_all_checks` | test | L1069 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_idempotent_create_warning` | test | L1081 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_real_migration_script` | test | L1097 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_init_script_skips_checks` | test | L1131 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_reinitialize_not_treated_as_init` | test | L1156 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_create_index_warning` | test | L1168 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_create_index_with_if_not_exists` | test | L1180 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_delete_without_where` | test | L1203 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_drop_table_and_column` | test | L1215 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_unique_constraint` | test | L1233 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_add_not_null_and_backfill` | test | L1257 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_init_script_exempt` | test | L1278 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_comments_and_strings_not_flagged` | test | L1287 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_ack_annotation` | test | L1302 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_allow_data_change_alias` | test | L1314 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_ack_multiple_rules_and_unknown` | test | L1328 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_danger_rule_roundtrip` | test | L1338 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/script_checker.rs::tests::test_fk_cleanup_with_not_exists` | test | L1353 | ported:host/platform/storage/tests/script-checker.test.ts |
| `crates/dstu-storage/src/migration/verifier.rs::tests::verify_supports_query_smoke_tests` | test | L150 | ported:host/platform/storage/tests/verifier.test.ts |
| `crates/dstu-storage/src/migration/verifier.rs::tests::verify_fails_when_query_smoke_test_breaks` | test | L171 | ported:host/platform/storage/tests/verifier.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_vfs_migration_set_structure` | test | L1335 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_v20260130_migration_def` | test | L1376 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_note_history_is_registered_as_vfs_schema_head` | test | L1390 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_v001_expected_tables_count` | test | L1420 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_v001_sql_not_empty` | test | L1426 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_notes_versions_create_then_drop_is_declared` | test | L1432 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_all_table_names_completeness` | test | L1442 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_key_tables_present` | test | L1451 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_key_indexes_present` | test | L1464 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_migration_set_get` | test | L1481 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::test_latest_version` | test | L1496 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/migration/vfs.rs::tests::vector_profile_migration_backfills_legacy_image_as_multimodal_deterministically` | test | L1504 | ported:host/platform/storage/tests/definitions.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_aggregate_from_single_database` | test | L568 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_aggregate_from_multiple_databases` | test | L587 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_aggregate_with_empty_database` | test | L617 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_check_dependencies_satisfied` | test | L631 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_check_dependencies_not_satisfied` | test | L656 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_calculate_global_version` | test | L688 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_needs_migration` | test | L713 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_get_summary` | test | L730 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_aggregated_checksum_consistency` | test | L749 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_data_contract_version_mapping` | test | L769 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_database_id_dependencies` | test | L777 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/schema_registry.rs::tests::test_database_id_all_ordered` | test | L792 | ported:host/platform/storage/tests/schema-registry.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::chunks_assemble_in_order_and_take_cleans_up` | test | L526 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::rejects_out_of_order_and_oversized_chunks` | test | L542 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::begin_enforces_size_limit` | test | L556 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::incomplete_upload_cannot_be_taken_and_is_removed` | test | L583 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::abort_removes_file_and_is_idempotent` | test | L593 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::read_bounded_rejects_over_limit` | test | L606 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::stage_from_reader_enforces_limit_and_cleans_up` | test | L615 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::sweep_removes_orphans_but_keeps_registered` | test | L634 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/staged_upload.rs::tests::parses_raw_json_and_array_payloads` | test | L646 | ported:host/platform/storage/tests/staged-upload.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::lexical_normalize_path_resolves_dot_segments` | test | L1112 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::canonicalize_lenient_handles_missing_files` | test | L1138 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::digest_copy_roundtrip_matches_reread` | test | L1160 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::ensure_identical_copy_rejects_size_or_hash_mismatch` | test | L1173 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::ensure_enough_temp_space_requires_double_source_size` | test | L1188 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::reject_double_encoded_virtual_uri_keeps_raw_content_ok` | test | L1197 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::queue_persistable_saf_uri_writes_content_only` | test | L1211 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `crates/dstu-storage/src/unified_file_manager.rs::tests::queue_persistable_saf_uri_handles_concurrent_producers` | test | L1274 | ported:host/platform/storage/tests/unified-file-manager.test.ts |
| `tests/migration_fixture_upgrade_gate.rs::fixture_upgrade_gate` | test | L103 | ported:host/platform/storage/tests/migration-integration.test.ts |
| `tests/migration_tests.rs::chat_v2_migration_tests::test_migration_path_v1_to_latest` | test | L61 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::chat_v2_migration_tests::test_migration_rollback_on_failure` | test | L100 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::chat_v2_migration_tests::test_database_corrupted_error_on_rollback_failure` | test | L189 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::chat_v2_migration_tests::test_migration_idempotency` | test | L229 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::chat_v2_migration_tests::test_schema_integrity_verification` | test | L296 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::workspace_migration_tests::test_real_workspace_migration_path_to_latest` | test | L373 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::workspace_migration_tests::test_workspace_migration_table_creation` | test | L413 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::workspace_migration_tests::test_workspace_simulated_migration_path` | test | L475 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::workspace_migration_tests::test_workspace_migration_rollback` | test | L563 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::textbooks_table_tests::test_textbooks_table_structure` | test | L635 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::textbooks_table_tests::test_textbooks_crud_operations` | test | L736 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_migration_path_v1_to_latest` | test | L817 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_schema_integrity` | test | L845 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_migration_idempotency` | test | L961 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_database_statistics` | test | L1037 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_migration_table_structure` | test | L1069 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_key_columns_after_migration_011` | test | L1108 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_expected_columns_coverage` | test | L1188 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_migration_from_scratch` | test | L1284 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_schema_verification` | test | L1393 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::vfs_migration_tests::test_vfs_migration_032_integrity_validation` | test | L1504 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::llm_usage_migration_tests::test_llm_usage_migration_path_v1_to_latest` | test | L1638 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::llm_usage_migration_tests::test_llm_usage_schema_integrity` | test | L1691 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::llm_usage_migration_tests::test_llm_usage_migration_idempotency` | test | L1834 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::llm_usage_migration_tests::test_llm_usage_crud_operations` | test | L1923 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::llm_usage_migration_tests::test_llm_usage_migration_rollback` | test | L1994 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::migration_utils_tests::test_column_exists_check` | test | L2076 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::migration_utils_tests::test_table_exists_check` | test | L2116 | obsolete:feature old_migration_impl 从未启用（已批准） |
| `tests/migration_tests.rs::migration_utils_tests::test_transaction_atomicity` | test | L2153 | obsolete:feature old_migration_impl 从未启用（已批准） |
<!-- END GENERATED:testmap:rows -->

## 本 lane 新增测试（不计入 362 行 Rust 映射）

- WP-008 / B5-D17：`host/platform/storage/tests/busy-capability.test.ts` 经公开开库入口验证真实
  双连接 IMMEDIATE 争用返回后的状态、worker 再次取锁读到提交，以及 DEFERRED 升级负控的
  读锁阻塞、rollback/close 释放。**不是** L20b `state.rs:597` 的 busy-handler 测试移植：
  不具备 handler 在途暂停通知，原三条断言未全部覆盖，L20b 保持 pending。
  Node `20261105140509-cee8ea` / Electron `20261105140509-13217d` 各 4 passed（含原有
  startup-database 2 条）/ exit 0 / 无 Errors；合并 main 后 F3 映射 pending 前 0 → 后 0，零行变更。
  本文件旧生成表头滞后，实际 362 行为 ported 324 / merged 8 / obsolete 30 / pending 0；
  本包不手改 GENERATED 区域统计，也不将 main 已移植的三行计为本包产出。

- `host/platform/storage/tests/startup-finalizers.test.ts`：D2 finalizer 拓扑排序、重复/未知依赖/环、
  失败保留名称与原始 cause、成功后重试跳过已完成。
- `host/platform/storage/tests/worker-pool.test.ts`：L13b worker 真实线程 hop（`threadId` 不同）、
  worker 事务回滚、业务 `CommandError.value` 与字符串 Err 跨线程保真、未知任务拒绝（无 SQL 通道）、
  维护 pause 的 drain/terminate 与 resume 前排队，以及通过实际 parent `ctx.storage` 注册参与者后
  `enterMaintenance` 暂停/release 恢复该 pool。
- `host/platform/storage/tests/service.test.ts`：L03 `openFile` 精确文件语义（默认递归建父目录；
  `createParentDirs: false` 时父目录存在可建库、父目录缺失抛 `SQLITE_CANTOPEN` 且不建目录）与
  L11 维护参与者（库 scope、重叠 lease 引用计数、逆序 exit、enter 失败回滚、维护期间拒绝注册）。
- `host/platform/storage/tests/file-deletion-queue.test.ts`：D1/D4 `SqlExecutor` 同事务回滚、
  提交后物理删除、ready→published、workspace autocommit 边界。
- `host/platform/storage/tests/database.test.ts`：S05 `StorageError.phase` prepare/bind/execute。

## 历史 pending（2026-11-04；三行在当前 main 已为 ported）

2026-11-05 WP-008 复核实际状态列：以下三行已在 main 指向 anki-domain.test.ts /
image-quality-native.test.ts，原依赖描述保留作历史，不再作为本包阻塞。本包没有改映射去向。

3 条 pending 均为跨 lane / 原生能力阻塞，接口与证据见
`host/platform/storage/BLOCKERS.md` 与 `host/platform/storage/native-needs.md`：

- `database/mod.rs::tests::agent_library_reads_and_content_cas_cover_null_and_foreign_sessions`
  —— L16 分支 HEAD `fbed2b6c8` 的 `AnkiService` 已有 `listAnkiAgentLibraryCards`、
  `updateAnkiCardIfVersionForLibrary/ForSession`（并已修复 `generation-service.ts` 导入）；
  main 尚未合入这些方法，待集成后恢复断言。
- `database/mod.rs::tests::agent_library_cards_by_ids_preserve_order_and_fail_closed`
  —— L16 分支 HEAD `fbed2b6c8` 已有 `getAnkiAgentLibraryCardsByIds`，main 未合入；
  L24 `chatanki/api.ts:177-195` 仍只有接口，`tests/chatanki-card-double.ts:140` 是替身。
- `file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions`
  —— main 的 `NativeImage` 没有 `resizeAndEncodeJpeg`；F7 候选分支 `ds-mig/F7-native`
  已有（RGBA8 + jpeg-js），未证明与 `image 0.24.9` 的 Triangle/JPEG 等价，D5 JPEG PSNR
  独立未签；需 F7 合入 main 或协调者接受交叉向量/容差。

`bytes_quality_preserves_original_on_noop_or_invalid_image` 已由
`image-quality-service.test.ts` 用真实 64×32 PNG + 真实 `ctx.nativeImage.dimensions` decode
恢复为 ported；这只证明 Rust 测试语义，不等于 L12 生产接线闭合。L12 仍需删除自有
`image-codec.ts` 策略并改传 `ctx.nativeImage`。

L20b 的 S05（SQL 阶段错误，F3 已发布 `StorageError.phase`）与 S06（真实 SQLite busy
回调，仍待 F7/架构师原生绑定）不计入本文件 362 行，见
`host/platform/storage/L20B-OBSERVABILITY.md`；D1/D2/D4 的 journal/finalizer/worker
接缝状态见 `host/platform/storage/BLOCKERS.md` §5.1；F2/X4 的 migrationsDir、purge
同步基线重置与 startupGate 接线见 `host/platform/storage/STARTUP-WIRING.md`。
