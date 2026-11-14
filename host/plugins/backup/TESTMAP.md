# L21-backup-governance 测试去向（`host/plugins/backup`）

> WP-005（2026-11-05）核对实际323行：319 ported / 1 merged / **3 pending → 3 pending**。
> 本包没有更改任何去向；`tests/migration-diagnostic.test.ts` 为新增生产命令阶段/原5秒预算回归，无对应新增 Rust 测试 ID。
> 下方旧人工313/10及GENERATED头311/12不是当前逐行统计；现存3个pending的证据见文末。F4 Value消费已完成的历史回执见LANE末尾。

> v2 证据修正（2026-11-05，生成区外）：当前去向行的313 ported/10 pending只是旧形式状态。
> 初步确认7个旧ported测本地副本；其中3项现已改实际F3启动入口并有候选证据，剩2报告+2策略共4项仍不能算生产证据。
> 逐个Rust ID及状态见 `BLOCKERS.md` §1.0.1。已请求协调者经元数据维护通道对齐，本轮不手改GENERATED。
> 既有8个初始化/锁pending未恢复，两项obsolete仍未获批准，候选不等于独立签收。
> 新增审计Value超f64/高精度重存两正例完成状态pending，但已按C2要求恢复普通it.each执行，当前Node/Electron均2项真实失败；不使用skip/fails/能力探测跳过，不属于本表323个Rust行，不修改GENERATED计数。
> 已撤回把合法1e999期望为null的新断言及其旧绿结果作为桌面语义签收，详见BLOCKERS的F4 Value合同。

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L21-backup-governance：323 行（真实测试 323）· pending 12 · ported 311
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-sync/src/backup_job_manager.rs::tests::zip_checkpoint_retains_resume_path_and_scalar_progress_without_names` | test | L1376 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/backup_job_manager.rs::tests::database_checkpoint_still_retains_processed_items` | test | L1399 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/backup_job_manager.rs::tests::terminal_state_reentry_is_rejected_to_deduplicate_notifications` | test | L1410 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/backup_job_manager.rs::tests::incremental_disabled_message_is_english_and_aligned` | test | L1422 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/backup_job_manager.rs::tests::set_params_rejects_incremental_job_with_english_removed_message` | test | L1440 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/backup_job_manager.rs::tests::set_params_allows_full_backup_type` | test | L1479 | ported:host/plugins/backup/tests/jobs.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::dto_rejects_secret_fields` | test | L1072 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::public_http_requires_persisted_opt_in` | test | L1081 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::loopback_http_does_not_persist_risk_override` | test | L1108 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::public_plaintext_ftp_requires_persisted_opt_in` | test | L1120 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::ftp_platform_error_has_stable_code_and_shared_diagnostic` | test | L1132 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::s3_platform_error_has_stable_code_independent_of_message` | test | L1158 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::android_rejects_ftp_on_save_and_persists_nothing` | test | L1170 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_config_commands.rs::tests::android_rejects_stored_ftp_record_on_load` | test | L1189 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_credentials.rs::cloud_hydration_tests::backend_hydration_fills_only_secret_fields` | test | L161 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_credentials.rs::cloud_hydration_tests::hydration_rejects_ipc_secret_in_favor_of_secure_store` | test | L208 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_credentials.rs::cloud_hydration_tests::hydration_clears_ipc_secrets_when_secure_store_is_empty` | test | L231 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_credentials.rs::cloud_hydration_tests::persisted_nonsecret_config_replaces_the_complete_ipc_shape` | test | L250 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/cloud_credentials.rs::cloud_hydration_tests::missing_backend_ssot_discards_the_complete_ipc_shape` | test | L281 | ported:host/plugins/backup/tests/cloud-config.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_asset_type_properties` | test | L1644 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_is_sensitive_file` | test | L1665 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_backup_config_defaults` | test | L1676 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_backup_and_restore_assets` | test | L1685 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_verify_assets_rejects_relative_path_traversal` | test | L1729 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_verify_assets_rejects_symlinked_source` | test | L1752 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_restore_assets_rejects_symlinked_destination_parent` | test | L1780 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_skip_sensitive_files` | test | L1803 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_file_size_limit` | test | L1829 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_unreadable_asset_metadata_aborts_backup` | test | L1855 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_scan_assets` | test | L1881 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_restore_assets_with_progress_can_cancel` | test | L1898 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_restore_assets_with_progress_skips_untrusted_executable_assets` | test | L1932 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_restore_assets_from_dir_with_progress_can_cancel` | test | L2007 | ported:host/plugins/backup/tests/assets.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::backup_incremental_create_returns_removed_error` | test | L6433 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::restore_rejects_legacy_incremental_manifest` | test | L6478 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::legacy_incremental_listed_as_incremental_and_restore_rejected` | test | L6529 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::backup_crypto_keys_excludes_codex_oauth_session` | test | L6611 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::root_crypto_and_audit_are_found_when_manager_receives_active_slot` | test | L6637 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_new_manager` | test | L6666 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_verify_rejects_manifest_file_path_traversal_before_reading` | test | L6673 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_verify_rejects_symlinked_manifest_file` | test | L6697 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_manifest_loader_rejects_oversized_file_before_allocation` | test | L6723 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_list_backups_overrides_manifest_backup_id_with_dir_name` | test | L6736 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_manifest_serialization` | test | L6758 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::incomplete_vfs_lance_restore_removes_partial_files_and_resets_local_manifest` | test | L6777 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::vfs_lance_restore_contract_handles_legacy_schema_and_preserves_complete_component` | test | L7032 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_backup_and_restore_single_database` | test | L7072 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_current_chat_v2_schema_self_backup_and_restore` | test | L7117 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_crypto_keys_rejects_incompatible_dpapi_seed_before_overwrite` | test | L7177 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_crypto_keys_rejects_symlinked_secure_dir_before_overwrite` | test | L7216 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_crypto_keys_rejects_encrypted_files_without_seed_before_overwrite` | test | L7255 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_crypto_keys_replaces_secure_directory_without_mixing_old_credentials` | test | L7283 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_crypto_keys_aborts_when_snapshot_cannot_be_created` | test | L7307 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_verify_checksum_mismatch` | test | L7330 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_list_and_cleanup_backups` | test | L7354 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_calculate_file_sha256` | test | L7396 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_backup_full_rejects_missing_core_database` | test | L7411 | ported:host/plugins/backup/tests/mod-behavior.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_manifest_save_and_load` | test | L7426 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::legacy_v1_v2_manifests_load_as_candidates_without_coverage` | test | L7451 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::manifest_v3_without_coverage_is_rejected_instead_of_downgraded` | test | L7485 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::empty_legacy_candidate_cannot_pass_upgrade_gate` | test | L7516 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::legacy_upgrade_rejects_unclassified_persistent_files` | test | L7547 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::persistent_registry_marks_user_skills_untrusted_executable` | test | L7575 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::executable_agent_assets_require_explicit_restore_trust` | test | L7591 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::active_data_space_settings_are_manifested_with_restore_scope` | test | L7611 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::full_label_is_not_synthesized_without_coverage_evidence` | test | L7639 | ported:host/plugins/backup/tests/manifest.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::crypto_tamper_fails_even_if_manifest_hash_is_rewritten` | test | L7653 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::corrupted_audit_database_fails_integrity_after_hash_rewrite` | test | L7693 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_reverts_data_to_backup_state` | test | L7739 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_integrity_check_passes_on_restored_db` | test | L7844 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_rejects_corrupted_backup_db` | test | L7945 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_handles_write_failure_gracefully` | test | L8011 | ported:host/plugins/backup/tests/restore.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_schema_version_matches_backup_metadata` | test | L8064 | ported:host/plugins/backup/tests/backup-manager.test.ts |
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_pre_restore_backup_and_rollback_mechanism` | test | L8158 | pending |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::no_password_is_left_to_existing_missing_password_gate` | test | L243 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::explicit_password_on_portable_zip_fails_fast_in_both_modes` | test | L265 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::wrong_password_on_sealed_zip_fails_fast_without_resume` | test | L285 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::correct_password_on_sealed_zip_passes_precheck` | test | L311 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::resumable_sealed_zip_defers_wrong_password_to_unseal_layer` | test | L322 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::corrupted_sealed_payload_fails_fast_with_any_password` | test | L333 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::import_portable_zip_with_explicit_password_fails_before_touching_target` | test | L401 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::import_sealed_zip_with_wrong_password_fails_before_touching_target` | test | L433 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::progress_import_sealed_zip_wrong_password_never_reaches_extract_phase` | test | L477 | ported:host/plugins/backup/tests/portable-precheck.test.ts |
| `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::consume_restores_persistent_settings_and_reports_every_ledger_domain` | test | L595 | ported:host/plugins/backup/tests/restore-plan.test.ts |
| `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::untrusted_user_skills_are_quarantined_not_written_to_restore_target` | test | L675 | ported:host/plugins/backup/tests/restore-plan.test.ts |
| `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::unconsumed_complete_domain_fails_with_stable_code` | test | L735 | ported:host/plugins/backup/tests/restore-plan.test.ts |
| `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::primary_domain_missing_from_slot_is_reported_unconsumed` | test | L759 | ported:host/plugins/backup/tests/restore-plan.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_default_options` | test | L2318 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_with_custom_output_path` | test | L2334 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_excludes_crypto_secrets` | test | L2351 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_unencrypted_export_excludes_user_skills` | test | L2402 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_excludes_encrypted_user_skills_domain` | test | L2436 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_rejects_output_inside_source_without_overwriting_it` | test | L2500 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_actual_copy_budget_rejects_more_bytes_than_declared_budget` | test | L2518 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_rejects_symlinked_destination_parent` | test | L2531 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_store_only` | test | L2554 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_compression_ratio` | test | L2569 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_nonexistent_dir` | test | L2584 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_invalid_compression_level` | test | L2593 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_from_zip` | test | L2610 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_sealed_payload_stores_key_seed_as_plaintext` | test | L2692 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_encrypted_export_imports_after_seed_manifest_sync` | test | L2738 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_unencrypted_zip_succeeds_without_password` | test | L2792 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_never_skips_manifest_json` | test | L2818 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_unencrypted_zip_rejects_password` | test | L2874 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_encrypted_zip_requires_password_before_touching_target` | test | L2906 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_encrypted_zip_with_password_restores_full_snapshot` | test | L2935 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct` | test | L2962 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_unseal_failure_cleans_partial_plaintext` | test | L3015 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_non_resumable_import_encrypted_zip_fails_early_without_password` | test | L3061 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_non_resumable_progress_import_encrypted_zip_fails_early_without_password` | test | L3092 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_non_resumable_import_encrypted_zip_with_password_still_succeeds` | test | L3134 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_cancel_token_set_midway_stops_export` | test | L3154 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_encrypted_cancel_token_set_midway_stops_export` | test | L3205 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_progress_reports_all_phases_monotonically` | test | L3238 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::zip_contains_encrypted_secrets_distinguishes_portable_and_sealed` | test | L3288 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_cancelled_before_scan_leaves_target_untouched` | test | L3389 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_cancelled_after_scan_validation_extracts_nothing` | test | L3422 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_cancel_midway_extract_leaves_no_partial_files` | test | L3464 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_encrypted_cancelled_before_verify_keeps_sealed_payload` | test | L3526 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_cancel_midway_then_resumable_retry_completes` | test | L3569 | ported:host/plugins/backup/tests/zip.test.ts |
| `crates/dstu-sync/src/data_governance/restore_codes.rs::tests::stable_code_literals_are_frozen` | test | L68 | ported:host/plugins/backup/tests/restore-codes.test.ts |
| `crates/dstu-sync/src/data_governance/restore_codes.rs::tests::tagged_message_matches_bracket_prefix_convention` | test | L91 | ported:host/plugins/backup/tests/restore-codes.test.ts |
| `crates/dstu-sync/src/data_governance/restore_codes.rs::tests::codes_are_distinct` | test | L100 | ported:host/plugins/backup/tests/restore-codes.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::handles_only_governance_tools_with_expected_policy` | test | L867 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::pagination_defaults_and_caps_at_twenty` | test | L894 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::backup_create_rejects_incremental_and_unreviewed_asset_values` | test | L908 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::sync_args_reject_cloud_config_credentials_and_manual_policy` | test | L930 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::skipped_or_warning_sync_is_never_reported_as_success` | test | L948 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::clean_sync_result_is_success_and_failure_without_effects_is_error` | test | L983 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::issued_job_receipt_distinguishes_expired_from_unknown` | test | L1014 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/chat_v2/tools/data_governance_executor.rs::tests::governance_errors_are_bounded_and_structured` | test | L1024 | ported:host/plugins/backup/tests/governance-tool.test.ts |
| `src/data_governance/commands.rs::tests::resolve_target_and_pending_uses_migration_set_when_status_missing` | test | L1330 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::resolve_target_and_pending_returns_zero_when_latest_reached` | test | L1346 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::resolve_target_and_pending_prefers_status_target_version` | test | L1356 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::validate_backup_id_allows_safe_id` | test | L1380 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::validate_backup_id_rejects_parent_traversal` | test | L1386 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::validate_backup_id_rejects_absolute_path` | test | L1392 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::validate_backup_id_rejects_encoded_bypass` | test | L1398 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::refresh_schema_registry_from_dir_swaps_latest_live_state` | test | L1404 | ported:host/plugins/backup/tests/migrations.test.ts |
| `src/data_governance/commands.rs::tests::refresh_schema_registry_from_dir_maps_poisoned_lock_error` | test | L1437 | pending |
| `src/data_governance/commands.rs::tests::test_infer_database_chat_v2_prefix` | test | L1458 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_chat_v2_known_tables` | test | L1471 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_resources_ambiguous_returns_none` | test | L1481 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_mistakes` | test | L1487 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_vfs` | test | L1506 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_llm_usage` | test | L1517 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_unknown_returns_none` | test | L1529 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands.rs::tests::test_infer_database_no_cross_routing` | test | L1535 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands_backup.rs::tests::open_sync_connection_sets_busy_timeout` | test | L699 | ported:host/plugins/backup/tests/commands-backup-sync.test.ts |
| `src/data_governance/commands_backup.rs::tests::missing_target_database_rejects_package_before_cursor_ack` | test | L727 | ported:host/plugins/backup/tests/commands-backup-sync.test.ts |
| `src/data_governance/commands_backup.rs::tests::unknown_target_database_rejects_package_before_cursor_ack` | test | L740 | ported:host/plugins/backup/tests/commands-backup-sync.test.ts |
| `src/data_governance/commands_backup.rs::tests::keep_latest_local_newer_conflict_still_falls_into_conflict_table` | test | L753 | ported:host/plugins/backup/tests/commands-backup-sync.test.ts |
| `src/data_governance/commands_backup.rs::tests::keep_local_preserves_existing_non_conflicting_local_record` | test | L834 | ported:host/plugins/backup/tests/commands-backup-sync.test.ts |
| `src/data_governance/commands_backup.rs::tests::restore_disk_budget_uses_checked_arithmetic` | test | L904 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands_backup.rs::tests::governance_backup_directory_is_outside_slots` | test | L911 | ported:host/plugins/backup/tests/paths.test.ts |
| `src/data_governance/commands_restore.rs::tests::atomic_restore_unavailable_refusal_has_stable_code` | test | L1504 | ported:host/plugins/backup/tests/restore-codes.test.ts |
| `src/data_governance/commands_restore.rs::tests::post_key_publication_failure_restores_old_global_keys_and_active_slot` | test | L1514 | ported:host/plugins/backup/tests/restore.test.ts |
| `src/data_governance/commands_restore.rs::tests::pre_cutover_interruption_is_retryable_and_second_publish_commits_lease` | test | L1617 | ported:host/plugins/backup/tests/restore.test.ts |
| `src/data_governance/commands_restore.rs::tests::post_cutover_failure_audit_details_carry_cutover_committed_and_close_started_row` | test | L1711 | ported:host/plugins/backup/tests/restore.test.ts |
| `src/data_governance/commands_restore.rs::tests::terminal_restore_job_can_never_flip_to_success` | tokio::test | L1810 | ported:host/plugins/backup/tests/restore.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::flag_without_stored_password_is_fail_closed` | test | L1930 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::unconfigured_stays_portable` | test | L1950 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::stored_password_used_when_flag_on` | test | L1967 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::explicit_password_overrides_stored` | test | L1976 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::empty_explicit_falls_back_to_stored` | test | L1989 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::portable_import_ignores_stored_password` | test | L2002 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::portable_import_keeps_explicit_password_for_existing_reject` | test | L2011 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::sealed_import_uses_stored_password` | test | L2025 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::sealed_import_without_stored_is_fail_closed` | test | L2034 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::short_stored_password_is_fail_closed` | test | L2042 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::short_explicit_password_is_fail_closed` | test | L2056 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::password_minimum_counts_unicode_code_points_and_keeps_stable_code` | test | L2070 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::short_leftover_does_not_force_portable_when_flag_off` | test | L2094 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::sealed_import_short_stored_passes_through_to_unseal` | test | L2104 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::sealed_import_short_explicit_passes_through_to_unseal` | test | L2113 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/commands_zip.rs::resolve_zip_encryption_password_tests::portable_import_keeps_short_explicit_for_existing_reject` | test | L2127 | ported:host/plugins/backup/tests/zip-password.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue1_restore_old_backup_needs_migration_is_true` | test | L89 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue1_restore_old_backup_then_migrate_reaches_latest` | test | L151 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue2_vfs_data_survives_migration` | test | L219 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue2_mistakes_anki_cards_data_survives_migration` | test | L320 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue2_chat_v2_data_survives_migration` | test | L439 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue2_llm_usage_data_survives_migration` | test | L517 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue3_restore_does_not_check_schema_version_compatibility` | test | L587 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue4_corrupted_database_file_returns_friendly_error` | test | L648 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue4_truncated_database_file` | test | L685 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue4_readonly_database_file` | test | L716 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue5_tampered_checksum_is_silently_repaired` | test | L768 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue6_incremental_create_returns_removed_error` | test | L844 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue6_incremental_restore_silently_restores_nothing` | test | L883 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue7_audit_log_grows_unbounded` | test | L957 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue8_restore_with_corrupted_backup_triggers_rollback_error` | test | L1007 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue9_vfs_deleted_at_column_type_inconsistency` | test | L1090 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue10_checkpoint_then_write_then_backup_may_lose_data` | test | L1149 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue11_migration_error_has_no_disk_space_variant` | test | L1224 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue12_schema_fingerprint_changes_with_sql_formatting` | test | L1261 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue13_duplicate_test_functions_exist` | test | L1336 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue14_hardcoded_migration_counts_must_match` | test | L1384 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue16_sync_module_has_no_integration_tests_with_real_db` | test | L1424 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_combined_issue1_2_legacy_mistakes_data_survives_recovery` | test | L1470 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue5_supplement_checksum_repair_not_audited` | test | L1576 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_initialization_preserves_existing_data` | test | L1644 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_needs_migration_on_empty_file` | test | L1686 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/init.rs::tests::test_ensure_directories` | test | L370 | ported:host/plugins/backup/tests/init-startup.test.ts |
| `src/data_governance/init.rs::tests::test_initialization_report_new` | test | L382 | ported:host/plugins/backup/tests/init-startup.test.ts |
| `src/data_governance/init.rs::tests::test_initialization_report_is_fully_successful` | test | L392 | ported:host/plugins/backup/tests/init-startup.test.ts |
| `src/data_governance/init.rs::tests::test_needs_initialization_new_app` | test | L409 | merged:host/plugins/backup/tests/migration-behavior.test.ts::test_needs_initialization_new_app |
| `src/data_governance/init.rs::tests::test_get_current_schema_state_empty` | test | L420 | ported:host/plugins/backup/tests/init-startup.test.ts |
| `src/data_governance/init.rs::tests::test_initialize_audit_log` | test | L434 | ported:host/plugins/backup/tests/init-startup.test.ts |
| `src/data_governance/init.rs::tests::test_initialize_without_feature` | test | L452 | pending |
| `src/data_governance/migration_compat_tests.rs::tests::manifest_with_zero_cases_is_rejected` | test | L796 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_compat_tests.rs::tests::release_binary_fixture_kind_fails_loudly_until_provisioned` | test | L809 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_compat_tests.rs::tests::manifest_is_valid_and_non_trivial` | test | L834 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_compat_tests.rs::tests::historical_fixtures_upgrade_to_head_via_production_coordinator` | test | L859 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_full_migration_from_empty_database` | test | L135 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_no_broken_symlink_migration_files` | test | L229 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_vfs_database_full_migration` | test | L312 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_chat_v2_database_full_migration` | test | L343 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_llm_usage_database_full_migration` | test | L373 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_database_full_migration` | test | L398 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_run_all_executes_in_correct_order` | test | L439 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_run_all_idempotency` | test | L478 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_run_all_stops_on_dependency_failure` | test | L516 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_pending_migrations_count` | test | L554 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_pending_migrations_zero_after_run` | test | L572 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_vfs_tables_verified_after_migration` | test | L593 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_vfs_indexes_verified_after_migration` | test | L630 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_chat_v2_schema_verified_after_migration` | test | L665 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_verifier_detects_missing_table` | test | L727 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_verifier_detects_missing_column` | test | L757 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_verifier_detects_missing_index` | test | L787 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_database_dependencies_definition` | test | L824 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_database_ordering_satisfies_dependencies` | test | L854 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_dependency_not_satisfied_error` | test | L885 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_dependency_satisfied_success` | test | L912 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_full_dependency_chain_migration` | test | L939 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_audit_log_table_initialization` | test | L965 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_audit_log_records_migration_complete` | test | L999 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_audit_log_records_migration_failed` | test | L1028 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_migration_with_audit_logging` | test | L1063 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_audit_log_query_filtering` | test | L1091 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_schema_registry_aggregation_after_migration` | test | L1148 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_schema_registry_dependency_check_passes` | test | L1198 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_needs_migration_check` | test | L1219 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_no_migration_needed_after_run` | test | L1235 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_needs_initialization_new_app` | test | L1261 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_complete_initialization_flow` | test | L1271 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_no_initialization_needed_after_init` | test | L1311 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_all_migration_sets_count` | test | L1328 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_migration_set_properties` | test | L1339 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_migration_versions_ordered` | test | L1377 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_legacy_sparse_schema_recovers_to_latest` | test | L1392 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_legacy_recovery_is_reentrant_across_restart` | test | L1479 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_schema_fingerprint_drift_fails_close` | test | L1538 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_missing_index_is_self_healed` | test | L1566 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_preview_column_legacy_state_is_marked_without_duplicate_failure` | test | L1601 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_run_all_recovers_after_chat_v2_lock_failure` | test | L1666 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_sparse_schema_with_inflated_history_converges` | test | L1755 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_mistakes_migrate_recovers_after_lock_release` | test | L1818 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_vfs_malformed_history_record_is_cleaned_on_retry` | test | L1860 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_get_current_version_new_database` | test | L1899 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/migration_tests.rs::tests::test_get_current_version_migrated_database` | test | L1914 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/mod.rs::policy_tests::schema_fingerprint_drift_does_not_force_maintenance_mode` | test | L163 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/mod.rs::policy_tests::non_drift_verification_failure_still_forces_maintenance_mode` | test | L176 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/mod.rs::policy_tests::startup_health_applies_vfs_dependency_closure_only` | test | L189 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/mod.rs::policy_tests::startup_health_serializes_stable_status_values` | test | L211 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_vfs_full_migration` | test | L76 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_chat_v2_full_migration` | test | L103 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_mistakes_full_migration` | test | L128 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_llm_usage_full_migration` | test | L160 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_run_all_migrations` | test | L187 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_vfs_table_verification` | test | L226 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_vfs_index_verification` | test | L268 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_chat_v2_column_verification` | test | L306 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_verifier_detects_missing_table` | test | L345 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_verifier_detects_missing_column` | test | L378 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_verifier_detects_missing_index` | test | L411 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_database_dependencies` | test | L451 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_database_ordering` | test | L481 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_dependency_not_satisfied_error` | test | L507 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_dependency_satisfied` | test | L534 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_full_dependency_chain_migration` | test | L561 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_report_empty` | test | L601 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_report_add_success` | test | L618 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_report_add_failure` | test | L637 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_report_content` | test | L659 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_schema_registry_aggregation` | test | L696 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_schema_registry_dependency_check` | test | L736 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_needs_migration_check` | test | L760 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_no_migration_needed_after_run` | test | L776 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_needs_initialization` | test | L803 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_full_initialization` | test | L814 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_no_initialization_needed_after_init` | test | L854 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_audit_log_initialization` | test | L873 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_audit_log_migration_record` | test | L896 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_with_audit_logging` | test | L925 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_idempotency` | test | L959 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_pending_migrations_count` | test | L989 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_pending_migrations_zero_after_run` | test | L1007 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_get_current_version_new_db` | test | L1024 | ported:host/plugins/backup/tests/migration-behavior.test.ts |
| `src/data_governance/tests.rs::integration_tests::test_migration_set_properties` | test | L1039 | ported:host/plugins/backup/tests/migrations-metadata.test.ts |
| `tests/restore_domain_plan_tests.rs::matrix_registry_locks_domain_terminal_contract` | test | L263 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::full_snapshot_marks_all_matrix_domains_complete` | test | L343 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::audit_complete_domain_restores_via_manifest_plan_consumer` | test | L378 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::candidate_restore_lands_data_trust_domains_in_restore_target` | test | L402 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::candidate_restore_isolates_executable_domains_pending_trust` | test | L461 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::restore_assets_with_progress_never_materializes_agent_executables` | test | L525 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::unconsumed_audit_domain_rejected_in_slot_restore` | test | L588 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::unconsumed_webview_settings_domain_rejected_in_candidate_restore` | test | L611 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::crypto_complete_domain_restores_key_material_end_state` | test | L638 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::r7_cancelled_restore_before_cutover_leaves_no_lease_and_full_retry_succeeds` | test | L686 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::r7_failed_restore_before_cutover_is_retryable_after_clearing_slot` | test | L783 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::r7_committed_cutover_allows_same_backup_retry_but_rejects_different_backup` | test | L838 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/restore_domain_plan_tests.rs::r7_committed_cutover_lease_is_forward_only_until_activation` | test | L877 | ported:host/plugins/backup/tests/restore-domain-plan.test.ts |
| `tests/zip_export_import_restore_tests.rs::zip_roundtrip_restore_succeeds_or_returns_actionable_error` | test | L83 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::imported_manifest_classification_matches_restore_gate` | test | L206 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::encrypted_zip_roundtrip_restores_full_slot` | test | L273 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::encrypted_zip_import_without_password_returns_actionable_error` | test | L386 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::encrypted_zip_import_with_wrong_password_fails` | test | L413 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::encrypted_zip_wrong_password_never_touches_target_slot` | test | L450 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::unencrypted_portable_zip_is_honestly_partial` | test | L551 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::encrypted_zip_import_really_accepts_a_legacy_short_password` | test | L669 | ported:host/plugins/backup/tests/zip-integration.test.ts |
| `tests/zip_export_import_restore_tests.rs::stored_password_resolution_selects_portable_or_encrypted_export` | test | L718 | ported:host/plugins/backup/tests/zip-integration.test.ts |
<!-- END GENERATED:testmap:rows -->

## 剩余 pending 说明（GENERATED 区块外）

| Rust 测试 | 阻塞类别 | 证据与解除条件 |
|---|---|---|
| `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_pre_restore_backup_and_rollback_mechanism` | 待协调者批准 `obsolete:dead-in-electron` | `create_pre_restore_backup` / `rollback_from_pre_restore` 仅服务已停用的原地恢复入口；新的切槽恢复走 `restore_with_assets_to_dir`（不创建预恢复数据库备份），已有独立切槽测试覆盖。批准后改填 `obsolete:`。 |
| `src/data_governance/commands.rs::tests::refresh_schema_registry_from_dir_maps_poisoned_lock_error` | 待架构/F3 裁定 | Rust 用 `RwLock` poison 产生错误；Electron 为单线程、无全局 Registry 写锁，`Governance.getSchemaRegistry` 每次经正式聚合重建（`src/governance.ts:98-121`）。要么由架构批准 `obsolete:no-lock-poison`，要么由 F3 发布可观察 Registry 状态持有者。 |
| `src/data_governance/init.rs::tests::test_initialize_without_feature` | 待架构批准 `obsolete:feature-always-on` | 该用例仅编译于 `cfg(not(feature = "data_governance"))`；Electron 构建始终启用迁移，无对应生产分支，不能伪造 runtime feature 开关。 |
已把 `test_restore_handles_write_failure_gracefully` 适配到真实切槽恢复：非活跃槽只读时任务失败并返回 IO/权限错误，保留原“不 panic、可操作错误”断言（`tests/restore.test.ts:337`）。
原 `commands_backup` 的 5 条多库应用/冲突测试已随 main 集成的 L20 `sync@1` 公开面移植到 `tests/commands-backup-sync.test.ts`，经 `ctx.get('sync')` 按需消费，不复制 L20 实现。
