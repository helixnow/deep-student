# L23-sync-providers 测试去向（`host/plugins/sync-providers`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L23-sync-providers：859 行（真实测试 859）· pending 173 · ported 685 · merged 0 · obsolete 1
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-sync/src/cloud_storage/backup_lease.rs::tests::backup_lease_namespace_is_isolated_from_sync_lease` | test | L494 | ported:host/plugins/sync-providers/tests/backup_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/backup_lease.rs::tests::backup_lease_error_code_is_distinct_from_sync_lease` | test | L504 | ported:host/plugins/sync-providers/tests/backup_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/backup_lease.rs::tests::default_ttl_is_ten_minutes` | test | L517 | ported:host/plugins/sync-providers/tests/backup_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::bad_final_with_verified_tmp_converges` | tokio::test | L455 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::bad_final_without_tmp_fails_closed_and_quarantines` | tokio::test | L509 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::user_backup_data_object_is_never_auto_deleted` | tokio::test | L539 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::healthy_final_is_untouched` | tokio::test | L567 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::unverifiable_tmp_is_not_trusted_and_is_retained` | tokio::test | L581 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::missing_final_with_verified_tmp_converges_without_quarantine` | tokio::test | L599 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::missing_final_without_tmp_is_absent` | tokio::test | L618 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::newest_verified_tmp_wins` | tokio::test | L628 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::verified_publish_style_tmp_residue_converges` | tokio::test | L655 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::tmp_object_key_recognition_covers_both_generations` | test | L677 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::rejects_non_final_keys` | tokio::test | L701 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::real_keep_tmp_endgame_converges_on_next_round` | tokio::test | L782 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::real_keep_tmp_staging_endgame_stays_honest_absent` | tokio::test | L877 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::fail_closed_round_then_next_round_is_honest_absent` | tokio::test | L917 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::user_backup_bad_object_survives_repeated_rounds` | tokio::test | L955 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/bad_object.rs::tests::cross_generation_residue_newest_verified_tmp_wins` | tokio::test | L980 | ported:host/plugins/sync-providers/tests/bad_object.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_config_validation` | test | L429 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_https_enforcement_webdav` | test | L469 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_https_enforcement_s3` | test | L533 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_debug_redaction` | test | L565 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_default_root` | test | L598 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_is_local_endpoint` | test | L622 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_localhost_evil_rejected` | test | L649 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_ftp_config_validation` | test | L683 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_ftp_rejected_on_android` | test | L735 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_ftp_debug_redaction` | test | L758 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::in_flight_writer_cannot_be_stolen_after_its_lease_expires` | tokio::test | L763 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::abandoned_pending_writer_is_not_silently_stolen_by_ttl` | tokio::test | L816 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::first_claim_writes_lease_then_marker_and_cleans_lease` | tokio::test | L843 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::claim_fails_when_marker_already_exists` | tokio::test | L871 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::live_foreign_lease_blocks_claim_and_never_writes_marker` | tokio::test | L898 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::expired_foreign_lease_is_reclaimed` | tokio::test | L923 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::corrupted_fresh_lease_fails_closed_and_stale_one_is_reclaimed` | tokio::test | L943 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::legacy_v1_upgrade_hands_snapshot_to_builder_and_rejects_v2` | tokio::test | L982 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::lease_overwritten_before_readback_aborts_without_marker_write` | tokio::test | L1070 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::lease_stolen_after_marker_write_reports_failure_without_rollback` | tokio::test | L1142 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::conditional_put_backend_claims_without_lease_and_second_claim_conflicts` | tokio::test | L1216 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::oversized_lease_object_fails_closed_within_ttl_window` | tokio::test | L1256 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::two_device_claim_full_permutation_at_most_one_succeeds` | tokio::test | L1334 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/e2ee_claim.rs::tests::registered_writer_blocks_rival_in_lease_window` | tokio::test | L1559 | ported:host/plugins/sync-providers/tests/e2ee_claim.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_join_paths` | test | L1298 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_remote_path` | test | L1308 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_pyftpdlib_not_retrievable_is_not_found` | test | L1328 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_not_found_whitelist_accepts_explicit_missing_messages` | test | L1337 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_broad_not_found_substring_no_longer_matches` | test | L1352 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_unclassifiable_550_is_not_treated_as_missing` | test | L1368 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::explicit_missing_parent_directory_cwd_is_treated_as_absent` | test | L1384 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::test_extract_status_code` | test | L1399 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::ambiguous_or_permission_denied_cwd_is_still_an_error` | test | L1413 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::ftp_contract_source_guards` | test | L1430 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::stream_to_file_accepts_exact_size_and_returns_sha256` | tokio::test | L1548 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::stream_to_file_rejects_truncated_stream` | tokio::test | L1565 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::stream_to_file_rejects_oversized_stream` | tokio::test | L1581 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::stream_to_file_aborts_oversized_stream_midway` | tokio::test | L1601 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::with_retry_does_not_retry_budget_exceeded_errors` | tokio::test | L1626 | ported:host/plugins/sync-providers/tests/ftp.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::test_config_validation` | test | L747 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::test_provider_display` | test | L761 | ported:host/plugins/sync-providers/tests/config.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::sync_e2ee_error_prefixes_stable_codes` | test | L767 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_rejected_when_marker_present_but_object_not_dsbk` | test | L785 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_allowed_when_marker_present_and_object_is_dsbk` | test | L804 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_allowed_for_legacy_plaintext_without_marker` | test | L812 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_allowed_for_dsbk_without_marker` | test | L819 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_rejected_when_marker_deleted_but_locally_remembered` | test | L827 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_allowed_for_dsbk_when_locally_remembered` | test | L842 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_opt_in_allows_plaintext_history_once` | test | L850 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_opt_in_has_no_effect_on_ciphertext_and_default_still_rejects` | test | L862 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/mod.rs::tests::download_head_classification_matches_backup_crypto_magic` | test | L872 | ported:host/plugins/sync-providers/tests/mod.test.ts |
| `crates/dstu-sync/src/cloud_storage/repo_check.rs::tests::version_id_whitelist_matches_sync_manager_rules` | test | L657 | ported:host/plugins/sync-providers/tests/repo_check.test.ts |
| `crates/dstu-sync/src/cloud_storage/repo_check.rs::tests::dsbk_v2_header_roundtrip_is_decodable` | test | L665 | ported:host/plugins/sync-providers/tests/repo_check.test.ts |
| `crates/dstu-sync/src/cloud_storage/repo_check.rs::tests::dsbk_v2_min_object_len_boundary_is_exact` | test | L692 | ported:host/plugins/sync-providers/tests/repo_check.test.ts |
| `crates/dstu-sync/src/cloud_storage/repo_check.rs::tests::dsbk_header_rejects_unknown_version_and_bad_params` | test | L716 | ported:host/plugins/sync-providers/tests/repo_check.test.ts |
| `crates/dstu-sync/src/cloud_storage/repo_check.rs::tests::dsbk_header_rejects_truncated_object` | test | L735 | ported:host/plugins/sync-providers/tests/repo_check.test.ts |
| `crates/dstu-sync/src/cloud_storage/resume.rs::tests::dest_resume_len_keeps_valid_prefix_and_drops_oversize` | test | L177 | ported:host/plugins/sync-providers/tests/resume.test.ts |
| `crates/dstu-sync/src/cloud_storage/resume.rs::tests::persist_download_replaces_existing_dest_without_appending` | test | L197 | ported:host/plugins/sync-providers/tests/resume.test.ts |
| `crates/dstu-sync/src/cloud_storage/resume.rs::tests::content_keyed_part_path_isolates_versions` | test | L209 | ported:host/plugins/sync-providers/tests/resume.test.ts |
| `crates/dstu-sync/src/cloud_storage/resume.rs::tests::cleanup_stale_parts_keeps_only_current_hash` | test | L233 | ported:host/plugins/sync-providers/tests/resume.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::put_file_source_guards_remote_size_check` | test | L1092 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::stale_multipart_keeps_recent_and_unknown_initiated` | test | L1159 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::parse_content_range_start_accepts_standard_form` | test | L1180 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::parse_content_range_start_rejects_unsatisfiable_form` | test | L1192 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::resume_actual_start_restarts_when_range_ignored` | test | L1198 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::resume_actual_start_fails_closed_on_misaligned_range` | test | L1212 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::multipart_threshold_fits_single_put_attempt_timeout` | test | L1222 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::plan_part_size_uses_default_chunk_for_common_sizes` | test | L1239 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::normalize_endpoint_strips_bucket_prefixed_host` | test | L1257 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::plan_part_size_scales_up_to_respect_ten_thousand_part_limit` | test | L1290 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::plan_part_size_rejects_files_beyond_s3_hard_limits` | test | L1308 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::planned_part_count_covers_exact_and_ragged_sizes` | test | L1316 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::resolve_region_treats_blank_as_unset_and_infers_from_endpoint` | test | L1324 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::normalize_endpoint_adds_https_scheme_and_trims` | test | L1355 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::normalize_endpoint_keeps_path_style_paths_untouched` | test | L1369 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::normalize_endpoint_keeps_canonical_endpoints_untouched` | test | L1385 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/s3.rs::tests::normalize_endpoint_conservative_cases` | test | L1408 | ported:host/plugins/sync-providers/tests/s3.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_lease.rs::tests::lease_held_by_this_device_reports_unfinished_previous_sync` | test | L528 | ported:host/plugins/sync-providers/tests/sync_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_lease.rs::tests::lease_held_by_another_device_keeps_existing_message` | test | L545 | ported:host/plugins/sync-providers/tests/sync_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_lease.rs::tests::corrupt_or_unknown_holder_is_never_treated_as_self` | test | L561 | ported:host/plugins/sync-providers/tests/sync_lease.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_uses_first_chunk_without_full_download_for_v2` | tokio::test | L2157 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_wrong_password_fails_fast_on_first_chunk` | tokio::test | L2198 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_falls_back_to_second_newest_when_latest_corrupt` | tokio::test | L2235 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_v1_container_still_proves_via_whole_file` | tokio::test | L2281 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_plain_zip_detected_from_prefix_without_full_download` | tokio::test | L2320 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::prove_non_default_chunk_triggers_precise_topup_read` | tokio::test | L2349 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::plaintext_upload_allowed_without_marker` | tokio::test | L2391 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::plaintext_upload_rejected_when_marker_present` | tokio::test | L2403 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::encrypted_upload_succeeds_and_keeps_marker` | tokio::test | L2442 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::wrong_password_upload_rejected_before_any_backup_write` | tokio::test | L2481 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::legacy_marker_without_verifier_is_upgraded_once` | tokio::test | L2521 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::first_claim_blocked_by_foreign_live_lease` | tokio::test | L2585 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::expired_foreign_lease_reclaimed_then_claim_succeeds` | tokio::test | L2616 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::v1_upgrade_blocked_by_foreign_live_lease` | tokio::test | L2640 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::publish_recheck_rejects_marker_swapped_between_verify_and_publish` | tokio::test | L2685 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::oversized_marker_fails_closed_for_both_upload_paths` | tokio::test | L2729 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::concurrent_two_password_claims_never_both_succeed` | tokio::test | L2816 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::corrupted_marker_blocks_encrypted_upload` | tokio::test | L2905 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::persist_encryption_marker_fails_when_reread_mismatches` | tokio::test | L2974 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::persist_encryption_marker_fails_when_missing_after_put` | tokio::test | L3004 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::unknown_verifier_kdf_fails_closed` | tokio::test | L3034 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::v2_marker_missing_verifier_fails_closed` | tokio::test | L3068 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::corrupted_marker_still_blocks_plaintext_upload` | tokio::test | L3095 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::old_backup_version_json_without_recovery_kind_still_deserializes` | test | L3110 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::mixed_manifest_keeps_old_unknown_and_new_recovery_kind` | test | L3125 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::upload_persists_recovery_kind_for_list_and_status` | tokio::test | L3161 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::new_version_id_is_22_hex_and_not_a_timestamp` | test | L3196 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::device_manifest_key_uses_short_hash_not_raw_device_id` | test | L3209 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::upload_fails_when_remote_zip_size_mismatches` | tokio::test | L3307 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::upload_fails_when_remote_zip_missing_after_put` | tokio::test | L3377 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::upload_fails_when_published_manifest_reread_mismatches` | tokio::test | L3409 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/sync_manager.rs::tests::upload_without_recovery_kind_stays_unknown` | tokio::test | L3446 | ported:host/plugins/sync-providers/tests/sync_manager.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::memory_get_accepts_matching_or_missing_length` | test | L675 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::memory_get_rejects_short_body_when_length_declared` | test | L684 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::get_budget_small_chunks_flooding_aborts_and_buffer_stays_bounded` | test | L697 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::get_budget_rejects_oversized_declared_length_before_body` | test | L730 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::get_budget_unknown_length_stream_aborts_over_budget` | test | L759 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::default_get_prefix_fails_closed` | tokio::test | L810 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/traits.rs::tests::default_get_bounded_enforces_budget_for_test_doubles` | tokio::test | L827 | ported:host/plugins/sync-providers/tests/traits.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::happy_path_publishes_and_cleans_tmp` | tokio::test | L465 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::oversize_data_rejected_before_any_write` | tokio::test | L480 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::conditional_publish_fails_closed_without_cas` | tokio::test | L492 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::tmp_corruption_keeps_tmp_and_never_touches_final_key` | tokio::test | L514 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::final_corruption_with_isolate_bad_renames_bad_object` | tokio::test | L531 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::final_corruption_with_keep_tmp_leaves_bad_object_in_place` | tokio::test | L557 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/verified_publish.rs::tests::traversal_key_rejected` | tokio::test | L577 | ported:host/plugins/sync-providers/tests/verified_publish.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::cancelled_token_aborts_waits` | tokio::test | L1809 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::provider_rate_limit_window_is_shared_across_storage_instances` | test | L1866 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::build_url_adds_root_once` | test | L1885 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::build_path_url_uses_raw_server_path` | test | L1897 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::remote_path_joins_once` | test | L1909 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::extract_relative_key_handles_empty_root` | test | L1926 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::extract_relative_key_handles_root_slash_normalization` | test | L1944 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::retry_after_parsing_and_cap` | test | L2063 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::retries_retryable_statuses_and_respects_retry_after` | tokio::test | L2093 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::rate_limit_response_preserves_server_detail_without_retry` | tokio::test | L2123 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::rate_limit_details_survive_all_request_paths_without_retries` | tokio::test | L2156 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::error_xml_entities_plaintext_and_generic_service_outages_remain_distinct` | test | L2233 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::oversized_error_body_is_bounded_and_still_reports_status` | tokio::test | L2254 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::does_not_retry_deterministic_client_errors` | tokio::test | L2268 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::retry_is_bounded_when_server_keeps_failing` | tokio::test | L2278 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::put_file_retries_on_503_with_retry_after` | tokio::test | L2292 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::put_file_fails_when_propfind_size_mismatches` | tokio::test | L2324 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_survives_collection_get_501` | tokio::test | L2363 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_fails_when_mkcol_rejected_and_root_missing` | tokio::test | L2384 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_tolerates_404_when_mkcol_succeeds` | tokio::test | L2415 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_fails_when_mkcol_chain_conflicts_and_root_missing` | tokio::test | L2433 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_tolerates_409_when_root_exists` | tokio::test | L2457 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_deeper_mkcol_success_clears_earlier_conflict` | tokio::test | L2475 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_reports_lock_and_rate_limit_instead_of_create_failure` | tokio::test | L2495 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::check_connection_get_fallback_404_fails_when_mkcol_rejected` | tokio::test | L2536 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::directory_cache_skips_repeat_mkcol` | tokio::test | L2557 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::suspicious_response_count_boundaries` | test | L2591 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::list_outcome_truncation_matrix_via_fake_server` | tokio::test | L2619 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::extract_relative_key_decodes_non_ascii_endpoint_path` | test | L2655 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::extract_relative_key_decodes_space_in_endpoint_path` | test | L2708 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::parse_propfind_entries_with_encoded_hrefs_lists_files_and_subdirs` | test | L2732 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::webdav_contract_source_guards` | test | L2784 | ported:host/plugins/sync-providers/tests/webdav.test.ts |
| `tests/e2ee_claim_race_tests.rs::race_empty_root_concurrent_claim_with_two_passwords_at_most_one_succeeds` | tokio::test | L289 | ported:host/plugins/sync-providers/tests/e2ee_claim_race.test.ts |
| `tests/e2ee_claim_race_tests.rs::race_second_device_must_not_overwrite_existing_marker` | tokio::test | L372 | ported:host/plugins/sync-providers/tests/e2ee_claim_race.test.ts |
| `tests/e2ee_claim_race_tests.rs::race_v1_to_v2_upgrade_must_not_let_both_devices_win` | tokio::test | L437 | ported:host/plugins/sync-providers/tests/e2ee_claim_race.test.ts |
| `tests/e2ee_claim_race_tests.rs::race_v1_to_v2_upgrade_same_password_writes_marker_at_most_once` | tokio::test | L508 | ported:host/plugins/sync-providers/tests/e2ee_claim_race.test.ts |
| `tests/sync_adversarial_tests.rs::adv_01_clock_rewind_by_attacker` | test | L129 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_02_clock_ahead_is_rejected_by_drift_guard` | test | L167 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_03_same_second_concurrent_writes` | test | L199 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_04_timestamp_format_variants` | test | L238 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_05_timezone_handling` | test | L269 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_06_zombie_prevention_stale_upsert_after_delete` | test | L302 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_07_legitimate_revive_with_newer_timestamp` | test | L342 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_08_row_level_lww_loses_orthogonal_field_edits` | test | L389 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_09_field_level_merge_loss_documented` | test | L440 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_10_prune_gap_detection` | test | L494 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_11_payload_missing_fields_preserves_local` | test | L515 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_12_payload_unknown_columns_rejected` | test | L548 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_13_payload_type_mismatch` | test | L570 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_14_device_id_collision_scenario` | test | L599 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_adversarial_tests.rs::adv_15_echo_loop_prevention` | test | L616 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_16_large_single_record` | test | L665 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_17_high_frequency_conflicts` | test | L687 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_18_json_special_numeric_values` | test | L753 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_19_very_long_record_id` | test | L775 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_20_binary_like_string_in_text_column` | test | L796 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_21_local_missing_updated_at_allows_cloud` | test | L824 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_22_cloud_garbage_updated_at` | test | L855 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_23_insert_nonexistent_passes_lww` | test | L880 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_24_payload_missing_updated_at_is_rejected` | test | L903 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_25_conflict_tie_break_same_timestamp` | test | L934 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_26_batch_apply_same_record_multiple_changes` | test | L978 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_27_millisecond_granularity` | test | L1026 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_28_table_name_injection_blocked` | test | L1056 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_29_double_quotes_in_field_value` | test | L1081 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_30_malicious_column_name_in_payload` | test | L1102 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_31_tags_field_semantic_equality` | test | L1134 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_32_deterministic_batch_apply` | test | L1185 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_33_payload_id_mismatch_with_record_id` | test | L1224 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_34_conflict_table_query_by_record` | test | L1271 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_35_cumulative_conflict_rounds` | test | L1319 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_36_empty_batch_noop` | test | L1370 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_37_many_changes_same_record_latest_wins` | test | L1378 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_38_delete_then_update_in_same_batch` | test | L1406 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_39_update_then_delete_in_same_batch` | test | L1439 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_adversarial_tests.rs::adv_40_delete_with_unexpected_data_field` | test | L1467 | ported:host/plugins/sync-providers/tests/adversarial_sync.test.ts |
| `tests/sync_android_device_switch.rs::android_create_storage_rejects_ftp_with_mappable_message` | tokio::test | L474 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_device_switch.rs::android_ssot_rejects_ftp_on_save_and_load` | test | L525 | pending |
| `tests/sync_android_device_switch.rs::build_without_s3_rejects_s3_with_user_facing_message` | tokio::test | L572 | pending |
| `tests/sync_android_device_switch.rs::mobile_feature_profiles_exclude_s3_backend` | test | L657 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_device_switch.rs::platform_capability_constants_stay_mappable` | test | L695 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_device_switch.rs::webdav_only_device_switch_closed_loop` | tokio::test | L752 | pending |
| `tests/sync_android_device_switch.rs::restart_guard_refuses_boot_when_lease_target_not_activated` | test | L976 | ported:host/plugins/sync-providers/tests/data_space_cutover.test.ts |
| `tests/sync_android_device_switch.rs::r09_device_id_probe_subprocess` | test | L1021 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_android_device_switch.rs::device_id_lives_in_app_data_dir_and_rotates_after_restore` | test | L1090 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_android_restart.rs::platform_rejection_codes_are_stable_contract` | test | L64 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::desktop_accepts_complete_ftp_config_so_android_gate_is_the_only_difference` | test | L96 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::mobile_profiles_exclude_s3_and_keep_recovery_core` | test | L121 | obsolete:mobile-only；C2 于 bccaf6201 逐行核实 Rust sync_android_restart.rs:117-137 只读取 mobile-slim/android-release 两个移动 Cargo profile，已批准（main migration/approvals.d/C2-platform.json） |
| `tests/sync_android_restart.rs::s3_disabled_build_fails_closed_like_mobile_slim` | tokio::test | L144 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::webdav_transfer_path_constructible_without_network` | tokio::test | L182 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::android_only::android_validate_rejects_complete_ftp_config` | test | L232 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::android_only::android_create_storage_rejects_ftp_before_any_network_io` | tokio::test | L243 | ported:host/plugins/sync-providers/tests/sync_android_platform.test.ts |
| `tests/sync_android_restart.rs::android_only::android_ssot_refuses_to_persist_or_load_ftp_records` | test | L261 | pending |
| `tests/sync_android_restart.rs::android_only::android_ssot_keeps_webdav_available` | test | L307 | pending |
| `tests/sync_android_restart.rs::webdav_only_device_switch_upload_download_roundtrip` | tokio::test | L568 | ported:host/plugins/sync-providers/tests/sync_android_restart.test.ts |
| `tests/sync_android_restart.rs::restore_writes_inactive_slot_and_switch_happens_only_after_restart` | test | L632 | ported:host/plugins/sync-providers/tests/data_space_cutover.test.ts |
| `tests/sync_android_restart.rs::startup_fails_closed_when_lease_target_is_not_active` | test | L721 | ported:host/plugins/sync-providers/tests/data_space_cutover.test.ts |
| `tests/sync_android_restart.rs::restore_cutover_registration_guards_reject_invalid_input` | test | L747 | ported:host/plugins/sync-providers/tests/data_space_cutover.test.ts |
| `tests/sync_android_restart.rs::sync_r07_device_id_probe` | test | L789 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_android_restart.rs::device_id_persists_in_app_data_dir_and_rotates_after_restore` | test | L858 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_chaos_tests.rs::chaos_short_session_converges_seed_1` | test | L360 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_short_session_converges_seed_42` | test | L370 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_medium_session_converges` | test | L376 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_with_network_faults_still_converges` | test | L382 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_high_fault_rate_still_converges` | test | L389 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_many_seeds_all_converge` | test | L395 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_long_session_converges` | test | L412 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_three_devices_converge` | test | L503 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_no_runaway_conflict_accumulation` | test | L516 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_chaos_tests.rs::chaos_per_record_state_matches` | test | L620 | ported:host/plugins/sync-providers/tests/chaos_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_registry_has_all_4_databases` | test | L25 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_row_sync_tables_have_valid_config` | test | L35 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_checksum_tables_excludes_runtime` | test | L60 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_fts_shadows_are_excluded` | test | L82 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_user_tables_not_excluded` | test | L102 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_business_unique_keys_not_empty` | test | L117 | pending |
| `tests/sync_comprehensive_tests.rs::tests::classification_tests::test_chat_v2_attachments_content_hash_is_not_business_unique_key` | test | L126 | pending |
| `tests/sync_comprehensive_tests.rs::tests::checksum_tests::test_checksum_compiles_and_runs` | test | L173 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::checksum_tests::test_checksum_on_empty_db` | test | L188 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::checksum_tests::test_checksum_reflects_sync_version` | test | L196 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_touches_local_version` | test | L217 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_multiple_tables` | test | L279 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_table_without_local_version_is_skipped` | test | L347 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_empty_db_does_not_panic` | test | L385 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_ref_count_falls_back_to_conflict` | test | L421 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_ref_count_equal_is_identity` | test | L430 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_ref_count_zero_identity` | test | L439 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_blobs_ref_count_falls_back_to_conflict` | test | L448 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_tag_union_with_overlap` | test | L459 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_tag_union_disjoint` | test | L472 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_tag_union_identical` | test | L485 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_tag_union_empty` | test | L496 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_max_value` | test | L506 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_max_value_reverse` | test | L521 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_estimated_pomodoros_falls_back_to_lww_conflict` | test | L535 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_estimated_pomodoros_lower_remote_is_not_bounced_by_max` | test | L548 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_boolean_or_true_wins` | test | L564 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_boolean_or_both_false` | test | L576 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_free_text_conflict_uses_remote_candidate` | test | L590 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_free_text_empty_local_still_flags_conflict_when_values_differ` | test | L603 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_free_text_does_not_auto_concatenate` | test | L616 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_deep_json_conflict_uses_remote_candidate` | test | L631 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_json_deep_merge_no_change` | test | L645 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_deep_json_primitive_conflict_uses_remote_candidate` | test | L657 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_identical` | test | L673 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_generic_conflict` | test | L682 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_none_values` | test | L694 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_ease_factor_falls_back_to_conflict` | test | L706 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_interval_days_falls_back_to_lww_conflict` | test | L719 | pending |
| `tests/sync_comprehensive_tests.rs::tests::field_merge_tests::test_merge_field_ordered_json_arrays_fall_back_to_conflict` | test | L733 | pending |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_detected_when_since_far_behind` | test | L754 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_not_detected_when_ahead` | test | L763 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_not_detected_when_equal` | test | L769 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_not_detected_at_zero` | test | L775 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_not_detected_when_no_min_available` | test | L784 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_boundary_exact_match` | test | L790 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::prune_gap_tests::test_gap_large_distance` | test | L796 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_no_duplicate_row_sync_classifications` | test | L811 | pending |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_every_classification_has_merge_notes` | test | L826 | pending |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_no_duplicate_classifications` | test | L838 | pending |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_registry_size_is_reasonable` | test | L848 | pending |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_row_sync_tables_include_key_tables` | test | L855 | pending |
| `tests/sync_comprehensive_tests.rs::tests::trigger_coverage_tests::test_row_sync_tables_have_trigger_count` | test | L869 | pending |
| `tests/sync_comprehensive_tests.rs::tests::edge_case_tests::test_composite_pk_tables` | test | L914 | pending |
| `tests/sync_comprehensive_tests.rs::tests::edge_case_tests::test_chat_messages_in_mistakes_is_row_sync` | test | L955 | pending |
| `tests/sync_comprehensive_tests.rs::tests::edge_case_tests::test_virtual_fts_tables_have_virtual_pk` | test | L965 | pending |
| `tests/sync_comprehensive_tests.rs::tests::edge_case_tests::test_refinery_schema_history_not_in_registry` | test | L979 | pending |
| `tests/sync_comprehensive_tests.rs::tests::edge_case_tests::test_deprecated_tables_exist` | test | L991 | pending |
| `tests/sync_comprehensive_tests.rs::tests::review_plan_merge_tests::test_review_plan_question_id_conflict_uses_upsert` | test | L1011 | ported:host/plugins/sync-providers/tests/comprehensive_sync.test.ts |
| `tests/sync_file_level_e2ee.rs::r07_blob_upload_with_password_wraps_dsbk_and_roundtrips` | tokio::test | L171 | pending |
| `tests/sync_file_level_e2ee.rs::r07_blob_download_of_encrypted_object_without_password_fails_closed` | tokio::test | L218 | pending |
| `tests/sync_file_level_e2ee.rs::r07_blob_download_with_undecryptable_object_fails` | tokio::test | L259 | pending |
| `tests/sync_file_level_e2ee.rs::r07_legacy_plaintext_blob_and_substitution_are_rejected` | tokio::test | L292 | pending |
| `tests/sync_file_level_e2ee.rs::r07_plaintext_file_uploads_rejected_when_marker_exists` | tokio::test | L359 | pending |
| `tests/sync_file_level_e2ee.rs::r07_asset_directory_roundtrip_is_encrypted` | tokio::test | L430 | pending |
| `tests/sync_file_level_e2ee.rs::r07_workspace_database_roundtrip_is_encrypted` | tokio::test | L483 | pending |
| `tests/sync_integration_deep_tests.rs::hlc_string_lww_ordering` | test | L66 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::hlc_counter_order_is_lexicographic` | test | L84 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::out_of_order_delivery_rerordered_by_hlc` | test | L93 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::partial_failure_retry_is_idempotent` | test | L166 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::invariant_insert_count_matches_items_count` | test | L228 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::invariant_delete_sets_tombstone` | test | L270 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::invariant_replay_does_not_pollute_pending` | test | L334 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::invariant_self_applied_changes_have_no_echo` | test | L395 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::conflict_record_data_is_roundtripped` | test | L442 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::large_batch_1000_records` | test | L514 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::stress_same_record_many_updates` | test | L551 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_integration_deep_tests.rs::mixed_batch_atomicity` | test | L599 | ported:host/plugins/sync-providers/tests/integration_deep_sync.test.ts |
| `tests/sync_pathological_tests.rs::p01_hlc_as_updated_at_lww_comparison` | test | L95 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p02_older_hlc_rejected_by_lww` | test | L134 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p03_full_lifecycle_then_revive` | test | L171 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p04_chaotic_delete_update_interleaving` | test | L219 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p05_mixed_conflict_guard_and_plain_apply` | test | L262 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p06_mass_update_on_empty_db_becomes_insert` | test | L327 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p07_delete_with_payload_ignored` | test | L351 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p08_empty_batch_does_not_create_conflict_table` | test | L389 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p09_corrupted_conflict_table_recovers` | test | L418 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p10_massive_conflict_batch` | test | L487 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p11_wal_mode_works` | test | L550 | ported:host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts |
| `tests/sync_pathological_tests.rs::p12_savepoint_conflicts_with_immediate_tx` | test | L572 | ported:host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts |
| `tests/sync_pathological_tests.rs::p13_foreign_keys_off_still_atomic` | test | L598 | ported:host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts |
| `tests/sync_pathological_tests.rs::p14_exclusive_locking_mode` | test | L647 | ported:host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts |
| `tests/sync_pathological_tests.rs::p15_query_only_pragma_prevents_writes` | test | L671 | ported:host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts |
| `tests/sync_pathological_tests.rs::p16_missing_change_log_table_tolerated` | test | L700 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p17_suppress_granularity` | test | L734 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p18_out_of_order_replay_no_pending_pollution` | test | L787 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p19_change_log_with_id_zero_still_works` | test | L820 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p20_large_synced_changelog_does_not_slow_sync` | test | L852 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p21_manual_hard_delete_then_tombstone` | test | L892 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p22_manual_revive_then_incoming_delete` | test | L914 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p23_mixed_device_delete_update` | test | L942 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p24_rogue_deleted_at_value` | test | L979 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p25_two_tables_in_one_batch` | test | L1013 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p26_same_record_id_in_different_tables` | test | L1064 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p27_table_with_many_columns` | test | L1115 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p28_array_order_matters_in_tags` | test | L1162 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p29_tags_string_vs_array_empty_compared_equal` | test | L1202 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p30_meta_fields_ignored_in_conflict` | test | L1243 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p31_payload_with_operation_field` | test | L1304 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p32_record_id_case_sensitive` | test | L1326 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p33_same_id_different_case_in_batch` | test | L1366 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p34_heterogeneous_payload_shapes` | test | L1403 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p35_payload_with_many_unknown_columns` | test | L1442 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p36_5000_sequential_single_changes` | test | L1475 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p37_change_log_count_invariant` | test | L1508 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p38_single_record_full_stress` | test | L1550 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p39_double_delete_preserves_earlier_tombstone` | test | L1598 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_pathological_tests.rs::p40_bulk_payload_id_record_id_mismatch` | test | L1668 | ported:host/plugins/sync-providers/tests/pathological_sync.test.ts |
| `tests/sync_proptest.rs::prop_idempotent_apply` | test in proptest! | L226 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_proptest.rs::prop_conflict_guard_never_loses_data` | test in proptest! | L255 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_proptest.rs::prop_convergence_after_global_sort` | test in proptest! | L350 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_proptest.rs::prop_invalid_change_is_isolated` | test in proptest! | L392 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_proptest.rs::prop_insert_and_update_equivalent_when_record_exists` | test in proptest! | L444 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_proptest.rs::prop_delete_is_idempotent` | test in proptest! | L516 | ported:host/plugins/sync-providers/tests/proptest_sync.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_basic_object_contract` | tokio::test | L1999 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_object_semantics_contract` | tokio::test | L2006 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_file_checksum_contract` | tokio::test | L2013 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_encrypted_backup_payload_contract` | tokio::test | L2020 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_file_checksum_mismatch_preserves_local_target_contract` | tokio::test | L2027 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::webdav_sync_manager_roundtrip_contract` | tokio::test | L2034 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_encrypted_data_governance_payload_contract` | tokio::test | L2041 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_mixed_plaintext_and_encrypted_change_contract` | tokio::test | L2048 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_duplicate_enriched_change_files_are_idempotent_contract` | tokio::test | L2055 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_corrupt_change_file_contract` | tokio::test | L2062 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_corrupt_manifest_contract` | tokio::test | L2069 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_prune_old_changes_contract` | tokio::test | L2076 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_workspace_database_file_sync_contract` | tokio::test | L2083 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_workspace_remote_same_size_corruption_rejected_contract` | tokio::test | L2090 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_vfs_blob_file_sync_and_tombstone_contract` | tokio::test | L2097 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_vfs_blob_remote_same_size_corruption_rejected_contract` | tokio::test | L2104 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_asset_directories_file_sync_and_tombstone_contract` | tokio::test | L2111 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_asset_shared_object_tombstone_contract` | tokio::test | L2118 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_asset_remote_same_size_corruption_rejected_contract` | tokio::test | L2125 | pending |
| `tests/sync_provider_contract_tests.rs::webdav_bad_credentials_rejected` | tokio::test | L2132 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_basic_object_contract` | tokio::test | L2144 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_object_semantics_contract` | tokio::test | L2152 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_file_checksum_contract` | tokio::test | L2160 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_encrypted_backup_payload_contract` | tokio::test | L2168 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_file_checksum_mismatch_preserves_local_target_contract` | tokio::test | L2176 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_sync_manager_roundtrip_contract` | tokio::test | L2184 | pending |
| `tests/sync_provider_contract_tests.rs::s3_encrypted_data_governance_payload_contract` | tokio::test | L2192 | pending |
| `tests/sync_provider_contract_tests.rs::s3_mixed_plaintext_and_encrypted_change_contract` | tokio::test | L2200 | pending |
| `tests/sync_provider_contract_tests.rs::s3_duplicate_enriched_change_files_are_idempotent_contract` | tokio::test | L2208 | pending |
| `tests/sync_provider_contract_tests.rs::s3_corrupt_change_file_contract` | tokio::test | L2216 | pending |
| `tests/sync_provider_contract_tests.rs::s3_corrupt_manifest_contract` | tokio::test | L2224 | pending |
| `tests/sync_provider_contract_tests.rs::s3_prune_old_changes_contract` | tokio::test | L2232 | pending |
| `tests/sync_provider_contract_tests.rs::s3_workspace_database_file_sync_contract` | tokio::test | L2240 | pending |
| `tests/sync_provider_contract_tests.rs::s3_workspace_remote_same_size_corruption_rejected_contract` | tokio::test | L2248 | pending |
| `tests/sync_provider_contract_tests.rs::s3_vfs_blob_file_sync_and_tombstone_contract` | tokio::test | L2256 | pending |
| `tests/sync_provider_contract_tests.rs::s3_vfs_blob_remote_same_size_corruption_rejected_contract` | tokio::test | L2264 | pending |
| `tests/sync_provider_contract_tests.rs::s3_asset_directories_file_sync_and_tombstone_contract` | tokio::test | L2272 | pending |
| `tests/sync_provider_contract_tests.rs::s3_asset_shared_object_tombstone_contract` | tokio::test | L2280 | pending |
| `tests/sync_provider_contract_tests.rs::s3_asset_remote_same_size_corruption_rejected_contract` | tokio::test | L2288 | pending |
| `tests/sync_provider_contract_tests.rs::s3_bad_credentials_rejected` | tokio::test | L2296 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_list_pagination_contract` | tokio::test | L2308 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::s3_multipart_file_contract` | tokio::test | L2316 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_basic_object_contract` | tokio::test | L2323 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_object_semantics_contract` | tokio::test | L2330 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_file_checksum_contract` | tokio::test | L2337 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_encrypted_backup_payload_contract` | tokio::test | L2344 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_file_checksum_mismatch_preserves_local_target_contract` | tokio::test | L2351 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_provider_contract_tests.rs::ftp_sync_manager_roundtrip_contract` | tokio::test | L2358 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_encrypted_data_governance_payload_contract` | tokio::test | L2365 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_mixed_plaintext_and_encrypted_change_contract` | tokio::test | L2372 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_duplicate_enriched_change_files_are_idempotent_contract` | tokio::test | L2379 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_corrupt_change_file_contract` | tokio::test | L2386 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_corrupt_manifest_contract` | tokio::test | L2393 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_prune_old_changes_contract` | tokio::test | L2400 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_workspace_database_file_sync_contract` | tokio::test | L2407 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_workspace_remote_same_size_corruption_rejected_contract` | tokio::test | L2414 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_vfs_blob_file_sync_and_tombstone_contract` | tokio::test | L2421 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_vfs_blob_remote_same_size_corruption_rejected_contract` | tokio::test | L2428 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_asset_directories_file_sync_and_tombstone_contract` | tokio::test | L2435 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_asset_shared_object_tombstone_contract` | tokio::test | L2442 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_asset_remote_same_size_corruption_rejected_contract` | tokio::test | L2449 | pending |
| `tests/sync_provider_contract_tests.rs::ftp_bad_credentials_rejected` | tokio::test | L2456 | ported:host/plugins/sync-providers/tests/sync_provider_contract.test.ts |
| `tests/sync_r02_hardening_tests.rs::r02x_two_device_tag_union_converges_when_both_sides_have_pending` | test | L146 | ported:host/plugins/sync-providers/tests/hardening_sync.test.ts |
| `tests/sync_r02_hardening_tests.rs::r02x_local_win_fold_lands_in_next_upload_payload` | test | L231 | ported:host/plugins/sync-providers/tests/hardening_sync.test.ts |
| `tests/sync_r02_hardening_tests.rs::r02x_composite_pk_stale_delete_rejected_fresh_delete_applies` | test | L400 | ported:host/plugins/sync-providers/tests/hardening_sync.test.ts |
| `tests/sync_r02_hardening_tests.rs::r02x_slow_clock_loser_recorded_once_across_redeliveries` | test | L522 | ported:host/plugins/sync-providers/tests/hardening_sync.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_slow_clock_delete_losing_lww_lands_in_sync_conflicts` | test | L101 | ported:host/plugins/sync-providers/tests/delete_hardening_sync.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_slow_clock_delete_with_local_pending_change_records_both_sides` | test | L170 | ported:host/plugins/sync-providers/tests/delete_hardening_sync.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_delete_with_unparseable_changed_at_goes_to_quarantine` | test | L230 | ported:host/plugins/sync-providers/tests/delete_hardening_sync.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_record_upload_with_marker_but_no_password_is_rejected` | tokio::test | L407 | ported:host/plugins/sync-providers/tests/sync_r05_record_upload_policy.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_record_upload_without_marker_and_no_password_is_allowed` | tokio::test | L458 | ported:host/plugins/sync-providers/tests/sync_r05_record_upload_policy.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_corrupted_marker_still_blocks_plaintext_record_upload` | tokio::test | L474 | ported:host/plugins/sync-providers/tests/sync_r05_record_upload_policy.test.ts |
| `tests/sync_r05_regression_tests.rs::r05_fresh_delete_still_applies_without_conflict_rows` | test | L498 | ported:host/plugins/sync-providers/tests/delete_hardening_sync.test.ts |
| `tests/sync_r06_delete_resolve_tests.rs::r06_lww_gate_losing_delete_writes_only_cloud_side_snapshot` | test | L157 | ported:host/plugins/sync-providers/tests/delete_resolve_sync.test.ts |
| `tests/sync_r06_delete_resolve_tests.rs::r06_one_sided_delete_conflict_should_be_resolvable` | test | L245 | ported:host/plugins/sync-providers/tests/delete_resolve_sync.test.ts |
| `tests/sync_r07_autosync_pending_tests.rs::r07_autosync_config_surface_serde_contract` | test | L23 | pending |
| `tests/sync_r07_autosync_pending_tests.rs::r07_autosync_scheduler_behavior_pending` | test | L71 | pending |
| `tests/sync_r07_cross_platform_names_tests.rs::r07_windows_hostile_names_roundtrip_bytewise_on_unix` | tokio::test | L144 | pending |
| `tests/sync_r07_cross_platform_names_tests.rs::r07_case_only_different_names_stay_distinct_entries` | tokio::test | L218 | pending |
| `tests/sync_r07_cross_platform_names_tests.rs::r07_nfc_and_nfd_names_stay_distinct_without_normalization` | tokio::test | L267 | pending |
| `tests/sync_r07_cross_platform_names_tests.rs::r07_malicious_manifest_keys_fail_closed_and_write_nothing` | tokio::test | L366 | pending |
| `tests/sync_r07_delete_resolve_lock_tests.rs::r07_one_sided_delete_conflict_keep_cloud_applies_delete` | test | L213 | ported:host/plugins/sync-providers/tests/delete_resolve_sync.test.ts |
| `tests/sync_r07_delete_resolve_lock_tests.rs::r07_one_sided_delete_conflict_merged_null_applies_delete` | test | L266 | ported:host/plugins/sync-providers/tests/delete_resolve_sync.test.ts |
| `tests/sync_r07_delete_resolve_lock_tests.rs::r07_one_sided_delete_conflict_stale_expected_ids_rejected_without_side_effects` | test | L310 | ported:host/plugins/sync-providers/tests/delete_resolve_sync.test.ts |
| `tests/sync_r07_e2ee_wrong_password_tests.rs::r07_zip_wrong_password_rejection_leaves_root_clean_and_recoverable` | tokio::test | L154 | ported:host/plugins/sync-providers/tests/sync_r07_e2ee_wrong_password.test.ts |
| `tests/sync_r07_e2ee_wrong_password_tests.rs::r07_zip_near_miss_password_variants_all_rejected` | tokio::test | L209 | ported:host/plugins/sync-providers/tests/sync_r07_e2ee_wrong_password.test.ts |
| `tests/sync_r07_e2ee_wrong_password_tests.rs::r07_file_level_wrong_password_fails_closed_without_polluting_root` | tokio::test | L289 | pending |
| `tests/sync_r07_e2ee_wrong_password_tests.rs::r07_file_level_wrong_password_blobs_channel_fails_closed` | tokio::test | L373 | pending |
| `tests/sync_r07_filename_tests.rs::r07_windows_reserved_chars_are_sanitized_in_keys_and_roundtrip` | tokio::test | L178 | pending |
| `tests/sync_r07_filename_tests.rs::r07_single_asset_download_failure_is_soft_and_only_visible_in_outcome` | tokio::test | L260 | pending |
| `tests/sync_r07_filename_tests.rs::r07_case_insensitive_key_collision_surfaces_a_warning_and_blocks_upload` | tokio::test | L318 | pending |
| `tests/sync_r07_filename_tests.rs::r07_unicode_normalization_forms_are_distinct_and_reversible` | tokio::test | L395 | pending |
| `tests/sync_r09_download_resume_tests.rs::interrupted_download_keeps_partial_then_resume_completes` | tokio::test | L279 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_download_resume_tests.rs::corrupted_partial_is_discarded_with_explicit_checksum_error` | tokio::test | L326 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_download_resume_tests.rs::server_ignoring_resume_restarts_from_zero_and_still_succeeds` | tokio::test | L367 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_download_resume_tests.rs::oversized_partial_is_discarded_and_download_restarts_fresh` | tokio::test | L392 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_download_resume_tests.rs::non_resumable_provider_downloads_whole_file_without_partial` | tokio::test | L417 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_download_resume_tests.rs::default_get_file_resumable_is_fail_closed` | tokio::test | L440 | ported:host/plugins/sync-providers/tests/sync_r09_download_resume.test.ts |
| `tests/sync_r09_file_e2ee.rs::r09_wrong_password_object_decrypt_never_overwrites_local_workspace` | tokio::test | L249 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_wrong_password_fails_closed_at_encrypted_manifest` | tokio::test | L319 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_tampered_blob_ciphertext_rejected_without_partial_file` | tokio::test | L360 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_tampered_workspace_ciphertext_keeps_stale_local_intact` | tokio::test | L408 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_legacy_plaintext_blob_rejected_when_encryption_enabled` | tokio::test | L461 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_legacy_plaintext_workspace_rejected_with_actionable_error` | tokio::test | L509 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_manifest_merge_prefers_ciphertext_entry_over_newer_plaintext` | tokio::test | L560 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_object_keys_remain_plaintext_content_addressed` | tokio::test | L638 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_missing_password_fails_closed_at_encrypted_manifest` | tokio::test | L732 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_missing_password_fails_closed_at_encrypted_object` | tokio::test | L767 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_legacy_v1_marker_readable_upgraded_once_and_locks_wrong_password` | tokio::test | L818 | pending |
| `tests/sync_r09_file_e2ee.rs::r09_corrupted_marker_fails_closed_and_is_preserved` | tokio::test | L889 | pending |
| `tests/sync_r09_filenames.rs::r11_reversible_names_upload_download_and_rescan_without_pingpong` | tokio::test | L192 | pending |
| `tests/sync_r09_filenames.rs::r11_case_only_names_keep_one_and_report` | tokio::test | L279 | pending |
| `tests/sync_r09_filenames.rs::r11_nfc_and_nfd_are_distinct_reversible_nfc_safe_keys` | tokio::test | L305 | pending |
| `tests/sync_r09_filenames.rs::r11_legacy_underscore_key_dual_lookup_then_migrates_on_content_change` | tokio::test | L342 | pending |
| `tests/sync_r09_filenames.rs::r11_new_reversible_and_legacy_underscore_keys_can_coexist` | tokio::test | L397 | pending |
| `tests/sync_r09_filenames.rs::r11_overlong_local_path_fails_before_any_cloud_write` | tokio::test | L434 | pending |
| `tests/sync_r09_filenames.rs::r11_malformed_or_overlong_cloud_key_fails_closed_without_local_write` | tokio::test | L458 | pending |
| `tests/sync_real_business_tables_tests.rs::b01_resources_integer_millis_updated_at_lww` | test | L268 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b02_resources_refcount_is_recomputed_not_delta_merged` | test | L321 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b03_resources_integer_deleted_at_tombstone` | test | L378 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b04_resources_large_inline_data` | test | L417 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b05_resources_hash_unique_conflict` | test | L465 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b06_notes_tags_merge_loses_orthogonal_tags` | test | L511 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b07_notes_favorite_and_title_lww` | test | L567 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b08_notes_soft_delete_revive_with_text_deleted_at` | test | L611 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b09_notes_unicode_title` | test | L657 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b10_messages_dual_timestamp_lww_uses_updated_at` | test | L696 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b11_messages_block_ids_json_ordering` | test | L745 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b12_messages_parent_id_branch_chain` | test | L788 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b13_messages_burst_same_session_same_second` | test | L834 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b14_blocks_large_content` | test | L876 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b15_blocks_streaming_updates` | test | L914 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b16_blocks_concurrent_streaming_on_both_devices` | test | L967 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b17_llm_usage_composite_key_record_id_json_format` | test | L1017 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b18_llm_usage_daily_lww_loses_concurrent_increments` | test | L1035 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b19_llm_usage_daily_different_providers_independent` | test | L1063 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b20_mistakes_multi_field_upsert` | test | L1092 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b21_mistakes_revive_from_soft_delete` | test | L1134 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b22_mixed_tables_apply_in_one_batch` | test | L1178 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b23_resources_then_notes_ordered_insert` | test | L1212 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b24_composite_key_record_id_roundtrip_via_change_log` | test | L1250 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_business_tables_tests.rs::b25_resources_deletion_vs_notes_orphan` | test | L1270 | ported:host/plugins/sync-providers/tests/business_tables_sync.test.ts |
| `tests/sync_real_flow_smoke_tests.rs::real_vfs_note_roundtrips_without_pending_echo` | test | L1670 | ported:host/plugins/sync-providers/tests/real_flow_smoke_sync.test.ts |
| `tests/sync_real_flow_smoke_tests.rs::real_chat_fk_chain_roundtrips_without_pending_echo` | test | L1722 | ported:host/plugins/sync-providers/tests/real_flow_smoke_sync.test.ts |
| `tests/sync_real_flow_smoke_tests.rs::real_restore_baseline_clears_old_changes_and_allows_new_delta` | test | L1777 | ported:host/plugins/sync-providers/tests/real_flow_smoke_sync.test.ts |
| `tests/sync_real_flow_smoke_tests.rs::real_migrated_all_row_sync_tables_roundtrip_with_reordered_changes` | test | L1815 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_migrated_all_row_sync_tables_update_roundtrip_with_reordered_changes` | test | L1904 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_delete_tombstones_vfs_and_chat_fk_chains_without_pending_echo` | test | L2003 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_business_unique_key_conflicts_alias_ids_and_remap_dependents` | test | L2088 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_llm_usage_daily_is_derived_and_legacy_pending_entries_are_filtered` | test | L2368 | ported:host/plugins/sync-providers/tests/real_flow_smoke_sync.test.ts |
| `tests/sync_real_flow_smoke_tests.rs::real_legacy_non_row_sync_pending_entries_are_filtered_for_all_databases` | test | L2423 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_non_row_sync_tables_with_real_rows_never_enter_incremental_upload` | test | L2448 | pending |
| `tests/sync_real_flow_smoke_tests.rs::cross_version_llm_usage_daily_legacy_change_log_is_pruned_after_upgrade` | test | L2516 | pending |
| `tests/sync_real_flow_smoke_tests.rs::cross_version_vfs_legacy_question_exam_record_ids_are_requeued_after_upgrade` | test | L2605 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_download_rejects_stale_schema_manifest_then_succeeds_after_migration` | tokio::test | L2720 | pending |
| `tests/sync_real_flow_smoke_tests.rs::real_full_cycle_all_databases_through_manifest_and_cloud_changes` | tokio::test | L2792 | pending |
| `tests/sync_real_flow_smoke_tests.rs::workspace_sync_unchanged_db_is_not_reuploaded` | tokio::test | L2951 | pending |
| `tests/sync_real_schema_tests.rs::real_61_fk_violation_rolls_back_batch` | test | L247 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_62_cascade_insert_order_independence` | test | L280 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_63_three_level_cascade` | test | L335 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_64_soft_delete_resource_while_referenced_is_allowed` | test | L421 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_64b_physical_delete_blocked_by_fk` | test | L470 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_65_fts_trigger_fires_but_batch_stays_transactional` | test | L521 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_66_ref_count_is_recomputed_not_delta_merged` | test | L606 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_67_integer_updated_at_handled_correctly` | test | L674 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_68_composite_primary_key_upsert` | test | L741 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_69_delete_resource_after_child_was_deleted_by_another_device` | test | L806 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_real_schema_tests.rs::real_70_many_notes_one_resource_concurrent_update` | test | L870 | ported:host/plugins/sync-providers/tests/real_schema_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s01_single_device_creates_note_syncs_other_receives` | test | L833 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s02_update_note_title_sync_propagates` | test | L851 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s03_delete_note_tombstone_sync_propagates` | test | L879 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s04_create_50_notes_bulk_sync` | test | L904 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s05_create_resource_then_note_fk_order` | test | L934 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s06_update_resource_data_verify_note_sees_new_data` | test | L952 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s07_create_question_linked_to_exam_sync_both` | test | L975 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s08_create_review_plan_for_question_sync` | test | L994 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s09_create_folder_add_items_sync_tree` | test | L1014 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s10_create_todo_list_with_items_sync_hierarchy` | test | L1034 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s11_create_pomodoro_record_linked_to_todo_item_sync` | test | L1053 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s12_create_essay_sync_with_grading` | test | L1079 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s13_create_translation_sync_with_metadata` | test | L1097 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s14_create_mindmap_sync_with_settings` | test | L1115 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s15_create_exam_sheet_sync_with_preview` | test | L1133 | ported:host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s16_create_session_with_messages_and_blocks_full_sync` | test | L1155 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s17_update_message_content_streaming_block_sync` | test | L1177 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s18_add_attachment_to_message_sync` | test | L1208 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s19_create_session_group_sync` | test | L1239 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s20_link_session_to_mistake_sync` | test | L1261 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s21_create_workspace_index_entry_sync` | test | L1284 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s22_create_chat_v2_resources_entry_sync` | test | L1307 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s23_multi_model_variant_in_message_sync_variants_json` | test | L1327 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s24_session_compaction_sync_reference` | test | L1353 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s25_large_chat_history_50_messages_bulk_sync` | test | L1382 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s26_create_mistake_with_analysis_images_sync` | test | L1416 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s27_add_chat_messages_to_mistake_sync_conversation` | test | L1439 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s28_create_review_analysis_sync_with_mistake_ids` | test | L1463 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s29_create_review_session_with_linked_mistakes_sync` | test | L1486 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s30_create_anki_card_from_document_tasks_sync` | test | L1516 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s31_custom_anki_template_sync_as_backup` | test | L1545 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s32_update_mistake_tags_verify_tag_union` | test | L1581 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s33_update_anki_card_front_back_sync` | test | L1603 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s34_concurrent_mistake_analysis_two_devices` | test | L1632 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s35_review_chat_messages_sync` | test | L1660 | ported:host/plugins/sync-providers/tests/realistic_scenarios_chat_mistakes_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s36_same_resource_created_both_devices_hash_conflict` | test | L1689 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s37_both_devices_update_same_note_title_lww` | test | L1709 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s38_device_a_edits_device_b_deletes_tombstone_conflict` | test | L1737 | pending |
| `tests/sync_realistic_scenarios.rs::s39_ref_count_counter_merge_two_devices` | test | L1768 | pending |
| `tests/sync_realistic_scenarios.rs::s40_both_add_tags_to_note_tag_union` | test | L1802 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s41_modify_metadata_json_deep_merge` | test | L1836 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s42_folder_item_unique_constraint_conflict` | test | L1858 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s54_special_characters_in_json_cols` | test | L1882 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s43_both_devices_add_different_tags_to_question` | test | L1900 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s44_both_devices_modify_metadata_json_resource` | test | L1948 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s45_same_file_sha256_dedup` | test | L1982 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s46_three_devices_concurrent_edit_cascade` | test | L2001 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s47_device_a_delete_device_b_edit_then_sync` | test | L2031 | pending |
| `tests/sync_realistic_scenarios.rs::s48_conflict_table_accumulation_3_rounds` | test | L2067 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s49_resolved_conflict_new_identical_conflict` | test | L2103 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s50_long_record_id_1000_chars` | test | L2138 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s51_unicode_content_chinese_japanese_emoji` | test | L2155 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s52_very_large_json_blob` | test | L2172 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s53_concurrent_sync_plus_local_writes` | test | L2189 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s55_large_record_data_50kb` | test | L2209 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s56_zero_local_version_initial_sync` | test | L2228 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s57_millisecond_timestamps_in_updated_at` | test | L2242 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s58_negative_ease_factor` | test | L2266 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s59_deleted_at_in_future` | test | L2285 | pending |
| `tests/sync_realistic_scenarios.rs::s60_device_id_mismatch_detection` | test | L2302 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s61_empty_change_log_on_one_device` | test | L2312 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s62_foreign_key_orphan_detection` | test | L2326 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s63_self_referencing_fk_folder_parent_id` | test | L2345 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s64_composite_pk_record_id` | test | L2363 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s65_autoincrement_pk_on_chat_messages` | test | L2387 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s66_create_resource_note_in_same_batch_atomic` | test | L2416 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s67_delete_parent_cascade_synced` | test | L2432 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s68_reorder_folder_items_sort_order_preserved` | test | L2457 | ported:host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s69_move_note_between_folders` | test | L2482 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s70_link_unlink_mistake_to_session_cross_db` | test | L2511 | pending |
| `tests/sync_realistic_scenarios.rs::s71_create_todo_item_with_parent_id_subtask` | test | L2546 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s72_pomodoro_record_with_end_time_before_start` | test | L2572 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s73_answer_submission_idempotency_client_request_id` | test | L2598 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s74_question_with_parent_id_variant_question` | test | L2633 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s75_simultaneous_folder_tree_restructure` | test | L2666 | pending |
| `tests/sync_realistic_scenarios.rs::s76_increment_ref_count_from_2_devices` | test | L2706 | pending |
| `tests/sync_realistic_scenarios.rs::s77_decrement_ref_count_verify_not_below_zero` | test | L2741 | pending |
| `tests/sync_realistic_scenarios.rs::s78_ref_count_to_zero_should_not_delete_resource` | test | L2765 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s79_concurrent_pomodoro_completion_counts_sum_merge` | test | L2789 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s80_concurrent_attempt_count_on_question_max_merge` | test | L2837 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s81_concurrent_correct_count_updates_max_merge` | test | L2880 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s82_concurrent_estimated_pomodoros_sum_merge` | test | L2923 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s83_concurrent_total_reviews_on_review_plan_max_merge` | test | L2964 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s84_ref_count_on_chat_v2_resources_separate_table` | test | L3008 | pending |
| `tests/sync_realistic_scenarios.rs::s85_blob_ref_count_not_in_row_sync` | test | L3030 | pending |
| `tests/sync_realistic_scenarios.rs::s86_normal_sync_after_small_gap` | test | L3052 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s87_gap_detected_and_handled` | test | L3077 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s88_multiple_incomplete_syncs_then_full_sync` | test | L3094 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s89_device_offline_for_10_rounds_then_reconnects` | test | L3118 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s90_corrupt_change_log_entry_skip_not_crash` | test | L3156 | pending |
| `tests/sync_realistic_scenarios.rs::s91_missing_manifest_on_cloud_graceful_fallback` | test | L3181 | pending |
| `tests/sync_realistic_scenarios.rs::s92_duplicate_change_upload_idempotent_application` | test | L3194 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s93_sync_with_no_changes_zero_op_cycle` | test | L3217 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s94_upload_fails_midway_retry_succeeds` | test | L3235 | ported:host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s95_different_schema_versions_should_detect` | test | L3257 | pending |
| `tests/sync_realistic_scenarios.rs::s96_ease_factor_field_merge_average` | test | L3318 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s97_interval_days_field_merge_max` | test | L3356 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s98_consecutive_failures_field_merge_max` | test | L3400 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s99_user_note_string_concat_merge` | test | L3449 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s100_ai_feedback_string_concat_merge` | test | L3492 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s101_is_favorite_boolean_or_merge` | test | L3529 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s102_is_bookmarked_boolean_or_merge` | test | L3557 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s103_metadata_json_deep_merge` | test | L3592 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s104_citations_json_deep_merge` | test | L3615 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s105_tags_json_set_union_on_anki_cards` | test | L3653 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s106_1000_records_bulk_create_and_sync` | test | L3700 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s107_100_records_each_with_50_updates` | test | L3727 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s108_10_devices_each_creating_10_records` | test | L3768 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s109_rapid_successive_syncs_10_cycles` | test | L3805 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s110_deeply_nested_json_5_levels` | test | L3829 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s111_100_folders_with_5_items_each` | test | L3846 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s112_50_sessions_with_20_messages_each` | test | L3894 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s113_concurrent_sync_plus_local_writes` | test | L3938 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s114_large_attachment_metadata_100_attachments` | test | L3965 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_realistic_scenarios.rs::s115_full_database_population_all_tables_sync` | test | L4002 | ported:host/plugins/sync-providers/tests/realistic_scenarios_stress_sync.test.ts |
| `tests/sync_regression_tests.rs::r01_hlc_same_millis_counter_tie_break_in_apply` | test | L100 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r02_hlc_local_newer_counter_wins_lww` | test | L137 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r03_hlc_drift_over_60s_future_rejected` | test | L170 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r04_hlc_local_vs_iso_cloud_mixed_formats` | test | L206 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r05_hlc_burst_10000_counter_monotonic` | test | L239 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r06_reset_baseline_on_empty_db` | test | L258 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r07_reset_baseline_skips_tables_without_sync_columns` | test | L279 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r08_reset_baseline_excludes_system_tables` | test | L312 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r09_reset_baseline_is_idempotent` | test | L342 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r10_post_restore_no_pending_changes` | test | L394 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r11_post_restore_only_new_edits_are_pending` | test | L429 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r12_repeated_restore_reset_cycles` | test | L464 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r13_post_restore_clears_unresolved_conflicts` | test | L489 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r14_archive_preserves_pending_changes` | test | L521 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r15_archive_with_very_early_cutoff_noop` | test | L560 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r16_archive_with_very_late_cutoff_deletes_all_synced` | test | L575 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r17_archive_is_idempotent` | test | L592 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r18_apply_3000_records_crosses_batch_boundary` | test | L618 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r19_apply_empty_noop` | test | L654 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r20_hlc_ordering_preserved_across_batch_size` | test | L665 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r21_mixed_format_cmp_is_deterministic` | test | L691 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r22_identical_hlc_tie_resolved_by_content_convergently` | test | L722 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r23_hlc_not_swallowed_by_clock_skew_tolerance` | test | L764 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r24_conflict_falls_into_table` | test | L797 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r25_conflict_guard_idempotent_on_replay` | test | L869 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r25b_resolved_does_not_block_new_identical_conflict` | test | L955 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_regression_tests.rs::r26_clock_drift_upsert_quarantined_then_replayable` | test | L1041 | ported:host/plugins/sync-providers/tests/quarantine_replay_sync.test.ts |
| `tests/sync_regression_tests.rs::r27_clock_drift_delete_quarantined` | test | L1133 | ported:host/plugins/sync-providers/tests/regression_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_01_fresh_insert_applies_cleanly` | test | L361 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_02_update_without_local_changes_overwrites` | test | L370 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_03_delete_soft_deletes_when_tombstone_column_exists` | test | L380 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_04_delete_idempotent` | test | L393 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_05_explicit_null_on_not_null_column_is_quarantined` | test | L406 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_06_suppress_change_log_echo_is_exact` | test | L444 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_07_transaction_rollback_on_fk_violation` | test | L471 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_08_reject_writes_to_internal_tables` | test | L523 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_09_reject_writes_to_sqlite_system_tables` | test | L544 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_10_unknown_table_returns_error` | test | L565 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_11_no_local_change_no_conflict` | test | L590 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_12_concurrent_edit_keeplatest_newer_cloud_wins` | test | L609 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_13_concurrent_edit_keeplatest_newer_local_wins` | test | L635 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_14_keepcloud_always_wins_but_records_loser` | test | L658 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_15_keeplocal_cloud_data_still_saved` | test | L687 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_16_delete_vs_local_update_conflict` | test | L716 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_17_identical_data_no_conflict` | test | L741 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_18_keeplatest_cloud_newer_with_small_skew_wins` | test | L793 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_19_three_way_conflict_sequence` | test | L816 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_20_multiple_records_mixed_outcomes` | test | L840 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_21_prune_gap_detection_triggers` | test | L878 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_22_replay_same_change_twice_idempotent` | test | L890 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_23_replay_insert_then_update_sequence` | test | L900 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_24_replay_insert_then_delete_sequence` | test | L909 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_25_replay_in_reverse_order_still_converges` | test | L919 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_26_upsert_preserves_row_identity` | test | L938 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_27_large_batch_transactional` | test | L954 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_28_large_batch_partial_failure_rolls_back_all` | test | L970 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_29_millis_sync_version_normalized` | test | L1030 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_30_empty_batch_is_noop` | test | L1055 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_31_blob_tombstone_upload_download` | tokio::test | L1078 | ported:host/plugins/sync-providers/tests/cloud_mark_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_32_asset_tombstone_propagates` | tokio::test | L1099 | ported:host/plugins/sync-providers/tests/cloud_mark_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_33_tombstone_second_device_sees_deletion` | tokio::test | L1113 | ported:host/plugins/sync-providers/tests/cloud_mark_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_34_tombstone_offline_returns_error` | tokio::test | L1139 | ported:host/plugins/sync-providers/tests/cloud_mark_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_35_apply_blob_tombstones_removes_local_file` | tokio::test | L1150 | ported:host/plugins/sync-providers/tests/tombstone_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_36_tombstone_retained_without_authoritative_snapshot` | tokio::test | L1202 | ported:host/plugins/sync-providers/tests/tombstone_scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_37_sync_vfs_blobs_with_tombstones_respects_deletion` | tokio::test | L1235 | pending |
| `tests/sync_scenarios_tests.rs::scenario_38_device_id_persistence` | tokio::test | L1287 | ported:host/plugins/sync-providers/tests/device_identity.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_39_mock_cloud_storage_list_by_prefix` | tokio::test | L1296 | pending |
| `tests/sync_scenarios_tests.rs::scenario_40_full_cycle_two_devices_sync_and_delete` | tokio::test | L1310 | pending |
| `tests/sync_scenarios_tests.rs::scenario_41_deep_nested_json_in_text_column` | test | L1367 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_42_special_chars_in_record_id` | test | L1399 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_43_reject_injection_via_table_name` | test | L1413 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_44_reject_injection_via_column_name` | test | L1437 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_45_unicode_content_preserved` | test | L1468 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_46_upsert_does_not_retrigger_change_log` | test | L1496 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_47_local_user_edit_during_download_preserved` | test | L1514 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_48_conflict_table_survives_db_close_reopen` | test | L1543 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_49_very_long_field_value` | test | L1619 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_50_mixed_sequence_with_conflicts_and_new` | test | L1648 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_51_mock_storage_concurrent_puts` | tokio::test | L1724 | pending |
| `tests/sync_scenarios_tests.rs::scenario_52_delete_of_nonexistent_is_safe` | test | L1741 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_53_empty_string_updated_at_handled` | test | L1751 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_54_multiple_conflict_rounds_accumulate` | test | L1773 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_55_downloaded_delete_of_already_deleted_record` | test | L1807 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_56_restore_from_conflict_table` | test | L1827 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_57_tombstone_survives_reupload_attempt` | tokio::test | L1866 | pending |
| `tests/sync_scenarios_tests.rs::scenario_58_shared_state_replays_tombstones_idempotently` | tokio::test | L1915 | pending |
| `tests/sync_scenarios_tests.rs::scenario_59_tombstone_then_recreate_with_same_hash` | tokio::test | L1977 | pending |
| `tests/sync_scenarios_tests.rs::scenario_60_conflict_guard_preserves_atomicity_on_failure` | test | L2037 | ported:host/plugins/sync-providers/tests/scenarios_sync.test.ts |
| `tests/sync_scenarios_tests.rs::scenario_61_legacy_snapshot_bootstrap_does_not_enable_prune` | tokio::test | L2090 | pending |
| `tests/sync_scenarios_tests.rs::blob_tombstone_rejected_when_locally_referenced_and_blob_revived` | tokio::test | L2262 | pending |
| `tests/sync_scenarios_tests.rs::blob_tombstone_applies_when_ref_count_zero` | tokio::test | L2323 | pending |
| `tests/sync_scenarios_tests.rs::recompute_ref_counts_skips_unchanged_rows` | test | L2371 | pending |
| `tests/sync_scenarios_tests.rs::manifest_decrypt_failure_fails_closed` | tokio::test | L2475 | pending |
| `tests/sync_scenarios_tests.rs::tombstone_decrypt_failure_fails_closed` | tokio::test | L2515 | pending |
| `tests/sync_scenarios_tests.rs::assets_manifest_decrypt_failure_fails_closed` | tokio::test | L2577 | pending |
| `tests/sync_scenarios_tests.rs::append_only_asset_manifests_merge_without_lost_entries` | tokio::test | L2642 | pending |
| `tests/sync_scenarios_tests.rs::corrupt_append_only_file_manifests_fail_closed` | tokio::test | L2718 | pending |
| `tests/sync_scenarios_tests.rs::download_only_asset_tombstone_does_not_rehydrate_in_same_round` | tokio::test | L2776 | pending |
| `tests/sync_scenarios_tests.rs::asset_tombstone_deletes_unreferenced_content_object` | tokio::test | L2819 | pending |
| `tests/sync_scenarios_tests.rs::asset_tombstone_resolves_object_key_and_keeps_shared_content_object` | tokio::test | L2891 | pending |
| `tests/sync_schema_coverage_tests.rs::real_schema_tables_are_all_classified` | test | L195 | pending |
| `tests/sync_schema_coverage_tests.rs::classified_non_deprecated_tables_exist_in_real_schema` | test | L226 | pending |
| `tests/sync_schema_coverage_tests.rs::row_sync_tables_have_primary_keys_and_change_log_triggers` | test | L257 | pending |
| `tests/sync_schema_coverage_tests.rs::row_sync_change_log_record_ids_follow_classified_primary_keys` | test | L302 | pending |
| `tests/sync_schema_coverage_tests.rs::row_sync_business_unique_keys_match_real_unique_indexes` | test | L361 | pending |
| `tests/sync_schema_coverage_tests.rs::row_sync_foreign_key_parents_are_incrementally_available` | test | L393 | pending |
| `tests/sync_schema_coverage_tests.rs::non_row_sync_tables_do_not_emit_incremental_change_log_triggers` | test | L423 | pending |
| `tests/sync_schema_coverage_tests.rs::change_log_schema_supports_field_deltas_in_every_database` | test | L448 | pending |
| `tests/sync_schema_coverage_tests.rs::checksum_scope_contains_only_row_or_file_sync_tables` | test | L471 | pending |
| `tests/sync_schema_coverage_tests.rs::migration_order_still_covers_all_governed_databases` | test | L493 | pending |
| `tests/sync_schema_coverage_tests.rs::migration_definition_sets_match_embedded_sql_files` | test | L512 | pending |
| `tests/sync_weird_tests.rs::w01_emoji_zwj_sequences` | test | L109 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w02_unicode_normalization_forms` | test | L134 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w03_bidi_override_characters` | test | L161 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w04_four_byte_utf8_planes` | test | L181 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w05_nested_quote_escape_hell` | test | L201 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w06_weird_record_id_with_control_chars` | test | L220 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w07_record_id_whitespace_only` | test | L239 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w08_empty_record_id` | test | L258 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w09_id_with_sql_backticks_and_brackets` | test | L285 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w10_null_byte_in_string_value` | test | L305 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w11_i64_extremes` | test | L338 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w12_large_numbers_in_json` | test | L367 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w13_float_infinity_nan_not_serializable` | test | L388 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w14_tiny_float` | test | L401 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w15_float_precision_03` | test | L423 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w16_epoch_zero_timestamp` | test | L450 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w17_y2038_overflow_safe` | test | L469 | pending |
| `tests/sync_weird_tests.rs::w18_negative_epoch_rejected_or_handled` | test | L495 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w19_leap_second_representation` | test | L514 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w20_nanosecond_precision` | test | L533 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w21_nanosecond_tie_break` | test | L560 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w22_numeric_timestamp_instead_of_string` | test | L601 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w23_empty_updated_at` | test | L620 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w24_hlc_counter_saturation` | test | L641 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w25_hlc_counter_overflow_rolls_wall` | test | L659 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w26_deeply_nested_json_as_string` | test | L672 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w27_duplicate_json_keys` | test | L703 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w28_data_is_json_null_value` | test | L716 | pending |
| `tests/sync_weird_tests.rs::w29_data_is_array` | test | L739 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w30_data_empty_object` | test | L761 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w31_all_fields_null` | test | L772 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w32_object_as_field_value_serialized` | test | L793 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w33_deeply_nested_recursion` | test | L816 | pending |
| `tests/sync_weird_tests.rs::w34_string_value_equals_another_pk` | test | L831 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w35_sql_reserved_words_as_data_keys` | test | L869 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w36_delete_already_deleted` | test | L928 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w37_delete_ghost_record` | test | L951 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w38_delete_timestamp_before_insert` | test | L970 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w39_tombstone_for_nonexistent_blob` | tokio::test | L997 | ported:host/plugins/sync-providers/tests/tombstone_scenarios_sync.test.ts |
| `tests/sync_weird_tests.rs::w40_delete_rollback_preserves_record` | test | L1051 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w41_same_record_alternating_20_ops` | test | L1103 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w42_many_records_many_versions_in_one_batch` | test | L1140 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w43_all_same_timestamp` | test | L1181 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w44_single_bad_in_1000_rolls_back_all` | test | L1211 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w45_revive_then_delete_in_same_batch` | test | L1256 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w46_hlc_receive_when_saturated` | test | L1296 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w47_hlc_concurrent_ticks` | test | L1303 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w48_two_clocks_exchange_converge` | test | L1310 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w49_hlc_receive_within_drift_window` | test | L1325 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w50_hlc_compare_strings_edge` | test | L1333 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w51_multiple_connections_to_same_file` | test | L1351 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w52_concurrent_user_write_during_sync` | test | L1404 | pending |
| `tests/sync_weird_tests.rs::w53_negative_sync_version_tolerated` | test | L1479 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w54_change_log_id_large_autoincrement` | test | L1499 | ported:host/plugins/sync-providers/tests/weird_sync.test.ts |
| `tests/sync_weird_tests.rs::w55_readonly_connection_rejected` | test | L1531 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w56_crash_after_commit_preserves_changes` | test | L1569 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w57_many_blob_tombstones` | tokio::test | L1607 | pending |
| `tests/sync_weird_tests.rs::w58_large_conflict_table_state` | test | L1664 | pending |
| `tests/sync_weird_tests.rs::w59_wall_clock_jump_backward_between_events` | test | L1714 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w60_llm_usage_daily_malformed_record_id` | test | L1759 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w61_identical_edits_from_two_devices_no_conflict` | test | L1794 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w62_empty_vs_whitespace_title_distinct` | test | L1837 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w63_all_changes_without_suppress_flag` | test | L1875 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w64_id_as_number_in_payload` | test | L1912 | pending |
| `tests/sync_weird_tests.rs::w65_extremely_long_record_id` | test | L1932 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w66_many_small_batches_sequential` | test | L1951 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w67_existing_conflict_table_is_reused` | test | L1979 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w68_resolved_conflicts_dont_block_new_ones` | test | L2035 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w69_ten_thousand_tiny_records` | test | L2114 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::apply_results_preserve_prior_keys_after_savepoint_rollback` | test | L2146 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::force_exact_results_are_validated_before_finalize` | test | L2200 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/sync_weird_tests.rs::w70_seven_devices_cross_edit` | test | L2253 | ported:host/plugins/sync-providers/tests/weird_batch_sync.test.ts |
| `tests/webdav_download_resume_tests.rs::webdav_advertises_resumable_download` | tokio::test | L256 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_download_resume_tests.rs::range_206_resumes_exactly_from_offset` | tokio::test | L266 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_download_resume_tests.rs::range_ignored_200_truncates_and_rewrites_from_zero` | tokio::test | L294 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_download_resume_tests.rs::misaligned_content_range_fails_closed_and_keeps_partial` | tokio::test | L318 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_download_resume_tests.rs::truncated_body_is_an_error_and_partial_stays_prefix_complete` | tokio::test | L345 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_download_resume_tests.rs::fresh_download_with_zero_offset_sends_no_range_header` | tokio::test | L380 | ported:host/plugins/sync-providers/tests/webdav_download_resume.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_750_files_is_marked_truncated` | tokio::test | L177 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_101_files_is_not_truncated` | tokio::test | L189 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_exactly_100_files_should_not_be_truncated` | tokio::test | L205 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_small_directory_is_not_truncated` | tokio::test | L216 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_1000_files_is_marked_truncated` | tokio::test | L226 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_999_files_is_marked_truncated` | tokio::test | L239 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_1001_files_is_not_truncated` | tokio::test | L252 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
| `tests/webdav_list_truncation_tests.rs::list_with_2000_files_is_not_truncated` | tokio::test | L266 | ported:host/plugins/sync-providers/tests/webdav_list_truncation.test.ts |
<!-- END GENERATED:testmap:rows -->

## WP-180：原 WP-032 八条逐断言映射

Rust 文件为 `src-tauri/tests/sync_comprehensive_tests.rs`，模块
`tests::field_merge_tests`；TS 文件为
`host/plugins/sync-providers/tests/comprehensive_sync.test.ts`，标题逐条保留 Rust ID。
八例均直接使用 `host/plugins/sync/api.ts:31` 重导出的同一生产 `mergeField`，
不经策略分流或行值推断返回标志。亲读 Rust 全部断言后映射如下：

| Rust ID / 起始行 | TS 起始行（同名 it） | 原输入及逐项断言对应 |
|---|---|---|
| `test_ref_count_falls_back_to_conflict` :421 | :275 | resources.ref_count 5/3；Rust :424/425/426 → TS :277/278/279：value=3、merged=false、conflict=true |
| `test_ref_count_equal_is_identity` :430 | :282 | resources.ref_count 7/7；Rust :433/434/435 → TS :284/285/286：7、false、false |
| `test_ref_count_zero_identity` :439 | :289 | resources.ref_count 0/0；Rust :442/443/444 → TS :291/292/293：0、false、false |
| `test_blobs_ref_count_falls_back_to_conflict` :448 | :296 | blobs.ref_count 10/3；Rust :451/452/453 → TS :298/299/300：3、false、true |
| `test_tag_union_with_overlap` :459 | :303 | notes.tags [a,b,c]/[b,c,d]；Rust :466 as_array().unwrap() → TS :306 Array.isArray；:467/:468 → :307/:308：len=4、merged=true |
| `test_tag_union_disjoint` :472 | :311 | notes.tags [x,y]/[a,b]；Rust :479 as_array().unwrap() → TS :314 Array.isArray；:480/:481 → :315/:316：len=4、merged=true |
| `test_tag_union_identical` :485 | :319 | notes.tags [a,b]/[a,b]；Rust :492 → TS :321：merged=false（原测试忽略 value/conflict） |
| `test_tag_union_empty` :496 | :324 | notes.tags []/[]；Rust :499/:500 → TS :326/:327：value=[]、merged=false |

失败/边界覆盖：两个不同值派生计数必须回退冲突且保远端候选，不能自动求和或取 max；
7/7 与零值必须走 identity，不得误报合并/冲突；标签交集去重和不相交合并均须返回
数组及长度4（仅检查 length 会误接受字符串）；相同/空集合保持未合并。标签原用例
不固定顺序/成员或 conflict，本包按原断言保持，不额外引入结果政策。

验证：Node `20261105220122-6571e1`、Electron `20261105220122-949091` 均 exit0，
本文件23 passed / 0 failed / 0 skipped，无 Errors；新增八条全部执行，既有15条保留。
实际859行：pending **189→181**、ported **669→677**、merged **0→0**、obsolete **1→1**；
仅上述八条去向变化，生成统计头保留由维护者刷新。`test_max_value` 既有跨 lane
ported 去向不在本包裁定范围，原 WP-032 报告/预检证据保留；C2 独立抽检待回执。

## WP-221：后续八条字段合并逐断言证据

Rust 文件：`src-tauri/tests/sync_comprehensive_tests.rs`，ID 前缀
`tests/sync_comprehensive_tests.rs::tests::field_merge_tests::`；TS 文件：
`host/plugins/sync-providers/tests/comprehensive_sync.test.ts`，完整用例名为
`sync comprehensive field merge > <下表 Rust 测试名>`。

| Rust 测试名 / 起始行 | TS 起始行 | 原输入与全部 assert 对应 |
|---|---|---|
| `test_max_value_reverse` :521 | :331 | review_plans.total_reviews 3/15；Rust :528/529 → TS :333/334：value=15、merged=true |
| `test_estimated_pomodoros_falls_back_to_lww_conflict` :535 | :337 | todo_items.estimated_pomodoros 3/4；Rust :542/543/544 → TS :339/340/341：value=4、merged=false、conflict=true |
| `test_estimated_pomodoros_lower_remote_is_not_bounced_by_max` :548 | :344 | todo_items.estimated_pomodoros 5/0；Rust :556/557/558 → TS :346/347/348：value=0、merged=false、conflict=true |
| `test_boolean_or_true_wins` :564 | :351 | notes.is_favorite false/true；Rust :571/572 → TS :353/354：value=true、merged=true |
| `test_boolean_or_both_false` :576 | :357 | notes.is_favorite false/false；Rust :583/584 → TS :359/360：value=false、merged=false |
| `test_free_text_conflict_uses_remote_candidate` :590 | :363 | questions.user_note "Hello"/"World"；Rust :597/598/599 → TS :365/366/367：value="World"、merged=false、conflict=true |
| `test_free_text_empty_local_still_flags_conflict_when_values_differ` :603 | :370 | questions.user_note ""/"World"；Rust :610/611/612 → TS :372/373/374：value="World"、merged=false、conflict=true |
| `test_free_text_does_not_auto_concatenate` :616 | :377 | questions.user_note "Hello World"/"Hello"；Rust :623/624/625 → TS :379/380/381：value="Hello"、merged=false、conflict=true |

八例共21个原 assert，TS 逐一对应21个 expect；这八条原测试没有 unwrap/Result 或
额外失败分支。全部 Some(value) 用同值参数传入；三个原 `_` conflict 槽保持不增加
断言，不把数字布尔换为 SQLite 0/1。空字符串仍是有值的 Some，不当成缺省。
下降到零与短远端文本分别验证不被 max 回弹、不自动拼接；双 false 验证 identity。

公开同源链（开工 main `0292921234955ff14c6f105d2595acc958ccb5da`）：
`sync/api.ts:31` 直接重导出 `sync/src/field-merge.ts:68`；生产
`sync/index.ts:169-181` → `repository/apply-batch.ts` / `apply-guard.ts` →
`apply-record.ts:604` / `apply-guard.ts:120` 调用同一实现。原算法对应
Rust `field_merge.rs:95-111,137-188,319-338`：相同值 identity、MaxValue、BooleanOr、
未注册列回退远端候选/false/true。estimated_pomodoros/user_note 不在生产自动合并
picklist，按原测试直接验证公共函数的回退语义，不冒称这两列会经 picklist 自动合并。
本包测试不复制算法、不改生产实现；运行结果与去向统计见 WP-221 交付报告。

Node `20261105235110-23fcfb`、Electron `20261105235110-5c9708` 均原 exit0，
整文件31 passed / 0 failed / 0 skipped / Errors0。通过后仅本包八行 pending→ported：
逐行实数859，ported **677→685**、pending **181→173**、merged **0→0**、obsolete **1→1**。
按本包 brief 明确授权修正旧头部统计；其余851行去向不变。C2 抽检至少1/8及清洁组合
门禁待独立回执，局部结果不升级全域 A/B/C。
