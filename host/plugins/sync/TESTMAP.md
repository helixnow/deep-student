# L20-sync 测试去向（`host/plugins/sync`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L20-sync：263 行（真实测试 263）· pending 81 · ported 182
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::rclone_style_unsafe_characters_roundtrip_without_collisions` | test | L523 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::reserved_trailing_and_dot_names_are_safe_and_reversible` | test | L536 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::nfc_and_nfd_remain_distinct_nfc_safe_keys_and_roundtrip` | test | L548 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::marker_and_quote_in_user_name_are_data_not_protocol` | test | L560 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::malformed_or_noncanonical_encodings_fail_closed` | test | L567 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::segment_and_total_path_limits_fail_closed_without_truncation` | test | L582 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::paths_roundtrip_and_traversal_fails_closed` | test | L601 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::legacy_lossy_alias_is_available_beside_new_key` | test | L625 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::casefold_keeps_case_conflicts_but_not_nfc_nfd_collision` | test | L639 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/asset_filenames.rs::tests::conflict_messages_carry_stable_marker` | test | L650 | ported:host/plugins/sync/tests/asset-filenames.test.ts |
| `crates/dstu-sync/src/data_governance/sync/classification.rs::tests::vfs_profile_ledger_is_rebuilt_locally_and_excluded_from_row_sync` | test | L1380 | ported:host/plugins/sync/tests/classification.test.ts |
| `crates/dstu-sync/src/data_governance/sync/classification.rs::tests::td02_completed_pomodoros_registered_as_derived_cache_of_pomodoro_records` | test | L1397 | ported:host/plugins/sync/tests/classification.test.ts |
| `crates/dstu-sync/src/data_governance/sync/classification.rs::tests::anki_cards_export_receipt_columns_are_registered_as_row_level_lww` | test | L1429 | ported:host/plugins/sync/tests/classification.test.ts |
| `crates/dstu-sync/src/data_governance/sync/emitter.rs::tests::test_optional_emitter_none` | tokio::test | L455 | ported:host/plugins/sync/tests/emitter.test.ts |
| `crates/dstu-sync/src/data_governance/sync/emitter.rs::tests::test_optional_emitter_from_none` | test | L468 | ported:host/plugins/sync/tests/emitter.test.ts |
| `crates/dstu-sync/src/data_governance/sync/emitter.rs::tests::test_noop_callback` | tokio::test | L474 | ported:host/plugins/sync/tests/emitter.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_tag_union` | test | L357 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_max_value` | test | L376 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_boolean_or` | test | L383 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m14_boolean_or_accepts_sqlite_integer_bool` | test | L390 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_td02_completed_pomodoros_is_not_field_merged` | test | L397 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_r02_non_monotonic_fields_are_not_max_merged` | test | L431 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_r04_question_counters_are_not_max_merged` | test | L466 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m21_ordered_json_arrays_fall_back_to_lww_conflict` | test | L490 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m21_deep_json_falls_back_to_lww_conflict` | test | L504 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m22_ref_count_is_not_auto_merged` | test | L518 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m22_picklist_only_exposes_convergent_strategies` | test | L527 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m22_registry_is_single_source_for_picklist` | test | L538 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_m22_classification_field_merge_requires_registered_columns` | test | L549 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::note_props_uses_whole_object_lww_not_unsafe_deep_merge` | test | L569 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::anki_export_receipt_columns_fall_back_to_row_level_lww` | test | L584 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_unregistered_json_looking_field_remains_conflict` | test | L614 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_merge_field_ref_count` | test | L627 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_merge_field_tags` | test | L636 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_j8b_notes_single_value_tags_keep_numeric_max` | test | L658 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_j8b_notes_enum_value_tags_keep_single_deterministic` | test | L692 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_j8b_ref_tags_keep_union_semantics` | test | L707 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_j8b_other_tables_tags_are_pure_union` | test | L721 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::regression_j8c_resources_data_non_profile_falls_back_to_lww` | test | L739 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_merge_field_identity` | test | L765 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/field_merge.rs::tests::test_merge_field_conflict` | test | L773 | ported:host/plugins/sync/tests/field-merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/hlc.rs::tests::test_hlc_encoding_is_lex_sortable` | test | L69 | ported:host/plugins/sync/tests/hlc.test.ts |
| `crates/dstu-sync/src/data_governance/sync/hlc.rs::tests::test_hlc_parse_roundtrip` | test | L79 | ported:host/plugins/sync/tests/hlc.test.ts |
| `crates/dstu-sync/src/data_governance/sync/hlc.rs::tests::test_hlc_u64_roundtrip` | test | L86 | ported:host/plugins/sync/tests/hlc.test.ts |
| `crates/dstu-sync/src/data_governance/sync/hlc.rs::tests::test_lex_order_matches_hlc_order_for_sequence` | test | L93 | ported:host/plugins/sync/tests/hlc.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::v3_format_descriptor_defaults_into_v4_compatible_skeleton` | test | L12955 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::fresh_device_cursor_zero_is_not_a_prune_gap` | test | L12968 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::decode_payload_accepts_plaintext_when_encryption_disabled` | test | L12981 | ported:host/plugins/sync/tests/payload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::decode_payload_rejects_plaintext_when_encryption_enabled` | test | L12995 | ported:host/plugins/sync/tests/payload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::decode_payload_roundtrips_encrypted_payload` | test | L13022 | ported:host/plugins/sync/tests/payload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::decode_payload_rejects_encrypted_payload_without_password` | test | L13036 | ported:host/plugins/sync/tests/payload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::schema_error_reports_only_real_mismatches_in_stable_order` | test | L13084 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::schema_upload_rejects_peer_and_same_device_downgrades_without_writes` | tokio::test | L13128 | ported:host/plugins/sync/tests/manifest-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::schema_upload_allows_upgrade_and_rejects_missing_local_database` | tokio::test | L13155 | ported:host/plugins/sync/tests/manifest-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::schema_gate_checks_both_raw_and_hashed_manifests_before_deduplication` | tokio::test | L13176 | ported:host/plugins/sync/tests/manifest-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::cloud_manifest_keeps_highest_schema_despite_newer_old_client_data_version` | tokio::test | L13198 | ported:host/plugins/sync/tests/remote-manifest.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::rebuilt_cloud_ignores_stale_database_versions_and_old_instance_cursors` | tokio::test | L13257 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::sequence_gap_preflight_catches_prefix_middle_tail_and_entire_missing_logs` | tokio::test | L13294 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::sequence_gap_preflight_allows_publication_after_listing` | tokio::test | L13361 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::sequence_gap_download_allows_publication_after_listing` | tokio::test | L13394 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::legacy_timestamp_distance_alone_is_not_a_proven_prune_gap` | tokio::test | L13418 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::sync_outer_retry_preserves_rate_limit_without_another_attempt` | tokio::test | L13441 | ported:host/plugins/sync/tests/manifest-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_with_nonce` | test | L13458 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_legacy_no_nonce` | test | L13464 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_seconds_with_nonce` | test | L13471 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c1_v3_change_key_parses_seq_and_timestamp` | test | L13479 | ported:host/plugins/sync/tests/change-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::v4_change_shard_key_is_sequenced_and_parseable` | test | L13503 | ported:host/plugins/sync/tests/change-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::v4_migration_requires_every_non_superseded_manifest` | test | L13527 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c4_dedupe_keeps_last` | test | L13560 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c4_dedupe_distinct_kept` | test | L13580 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c6_normalize_version_to_seconds` | test | L13595 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c7_mark_synced_batches_over_variable_limit` | test | L13613 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c8_upload_path_verifies_size` | test | L13649 | ported:host/plugins/sync/tests/change-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_zst_with_nonce` | test | L13696 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_zst_legacy_no_nonce` | test | L13703 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_invalid` | test | L13710 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_version_space_compatibility_seconds` | test | L13724 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_build_change_key_unique` | test | L13740 | obsolete:dead-in-rust C2批准89bc4d8a5；mod.rs:3942-3945废弃上传链，仅测试调用 |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::record_path_id_is_short_hash_and_matches_raw_or_hashed` | test | L13758 | ported:host/plugins/sync/tests/change-upload.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_and_snapshot_keys_are_neutral_ids` | test | L13778 | pending |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::is_own_change_file_accepts_hashed_and_legacy_raw_prefix` | test | L13814 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::path_aliases_merge_raw_and_hashed_prefixes` | test | L13829 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_normalize_version_to_seconds` | test | L13846 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_same_second_download_not_skipped` | test | L13866 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_no_conflicts` | test | L13874 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_schema_mismatch` | test | L13884 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_data_conflict` | test | L13899 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_local_only` | test | L13914 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_cloud_only` | test | L13932 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_sync_keep_local` | test | L13953 | obsolete:dead-in-rust C2批准89bc4d8a5；mod.rs:1272-1275旧sync无生产调用 |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_record_conflict_detection` | test | L13962 | obsolete:dead-in-rust C2批准89bc4d8a5；mod.rs:1208-1211旧detect_record_conflicts仅测试调用 |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_checksum_detects_content_drift_without_updated_at_change` | test | L14029 | ported:host/plugins/sync/tests/plugin.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_pending_changes_empty` | test | L14074 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_pending_changes_with_data` | test | L14085 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_pending_changes_with_field_deltas_json` | test | L14104 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_from_entry_with_data_injects_field_deltas_metadata` | test | L14127 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_pending_changes_with_table_filter` | test | L14152 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_pending_changes_with_limit` | test | L14166 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_mark_synced` | test | L14179 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_mark_synced_empty` | test | L14197 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_mark_synced_with_timestamp` | test | L14205 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_cleanup_synced_changes` | test | L14219 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_compare_timestamps_hlc_fast_path` | test | L14255 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_compare_timestamps_mixed_hlc_and_iso` | test | L14278 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_reset_sync_baseline_after_restore` | test | L14291 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::remote_resource_apply_strips_and_resets_local_vector_index_lifecycle` | test | L14359 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::remote_business_rows_keep_multimodal_index_fields_local` | test | L14478 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::preferred_project_root_path_is_local_derived_for_session_groups` | test | L14597 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_merge_strategy_keep_local` | test | L14609 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_merge_strategy_use_cloud` | test | L14633 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_merge_strategy_keep_latest` | test | L14657 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m3_keep_latest_uses_device_tiebreaker` | test | L14696 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_merge_strategy_manual_error` | test | L14720 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_change_log_stats` | test | L14745 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_change_operation_from_str` | test | L14762 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_change_operation_as_str` | test | L14783 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_pending_changes_get_table_changes` | test | L14790 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_pending_changes_get_change_ids` | test | L14834 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_pending_changes_time_range` | test | L14863 | ported:host/plugins/sync/tests/change-log.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_merge_application_result` | test | L14907 | ported:host/plugins/sync/tests/merge.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::delete_version_blocks_delayed_older_upsert` | test | L14968 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::strictly_newer_upsert_can_resurrect_and_clears_delete_version` | test | L15015 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m5_apply_explicit_null_clears_column` | test | L15059 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m1_single_sided_remote_tag_delete_is_not_field_merged_back` | test | L15098 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m1_pending_local_change_allows_field_merge` | test | L15146 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r02_conflict_guard_merges_tags_union_when_cloud_wins` | test | L15240 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r02_conflict_guard_folds_safe_fields_when_local_wins` | test | L15282 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r04_keep_local_policy_does_not_fold_safe_fields` | test | L15324 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r04_fold_skips_semantically_equal_local_values` | test | L15373 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r02_stale_delete_without_tombstone_is_rejected` | test | L15437 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r02_slow_clock_stale_upsert_is_visible_in_conflicts` | test | L15507 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r04_delete_with_unparseable_changed_at_fails_closed` | test | L15570 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_r04_stale_delete_losing_lww_lands_in_sync_conflicts` | test | L15633 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_insert_with_data_none_is_skipped` | test | L15696 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_update_with_data_none_is_skipped` | test | L15737 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_delete_without_data_succeeds` | test | L15785 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_mixed_data_none_and_valid` | test | L15827 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_semantically_equal_skip_is_not_incomplete` | test | L15887 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_record_data_composite_pk_with_json_record_id` | test | L15925 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_downloaded_changes_can_suppress_change_log_echo` | test | L15962 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_downloaded_changes_skips_equivalent_replay_without_new_echo_log` | test | L16019 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_dedupe_downloaded_changes_collapses_equivalent_payloads` | test | L16091 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_record_conflicts_with_diverged_sync_versions` | test | L16122 | obsolete:dead-in-rust C2批准89bc4d8a5；mod.rs:1208-1211旧helper仅测试调用 |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_detect_record_conflicts_same_data_not_conflict` | test | L16152 | obsolete:dead-in-rust C2批准89bc4d8a5；mod.rs:1208-1211旧helper仅测试调用 |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_delete_uses_tombstone_when_column_exists` | test | L16181 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_skips_incomplete_upsert_shadowed_by_batch_delete` | test | L16224 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_conflict_guard_skips_incomplete_upsert_shadowed_by_batch_delete` | test | L16263 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_downloaded_changes_rolls_back_on_fk_violation` | test | L16311 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m10_poison_payload_is_quarantined_without_blocking_batch` | test | L16400 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::quarantine_replay_persists_baseline_and_clears_state_with_guarded_apply` | test | L16462 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::quarantine_replay_baseline_mismatch_preserves_both_sides` | test | L16522 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::quarantine_replay_rejects_payload_hash_mismatch` | test | L16580 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m20_unregistered_table_payload_is_quarantined` | test | L16635 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_downloaded_changes_orders_todo_parent_before_child` | test | L16829 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_conflict_guard_orders_todo_parent_before_child` | test | L16844 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_quarantine_source_uses_v3_metadata` | test | L16956 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_apply_downloaded_changes_orders_blob_metadata_before_files` | test | L16978 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_ref_count_is_recomputed_after_download_apply` | test | L16989 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_recompute_counts_json_embedded_blob_refs` | test | L17014 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_changes_to_json_ref_tables_trigger_recompute_gate` | test | L17135 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_conflict_guard_orders_blob_metadata_before_files` | test | L17174 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::persisted_id_alias_lookup_is_read_only_and_preserves_cycle_behavior` | test | L17194 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_p3_5_files_same_sha_is_aliased_to_existing_file` | test | L17227 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m15_sqlite_text_json_string_is_not_reserialized` | test | L17314 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m15_sqlite_blob_is_typed_dsblob_payload` | test | L17338 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_business_key_alias_remaps_child_fk_when_child_arrives_first` | test | L17480 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_business_key_alias_reuses_canonical_id_when_parent_arrives_first` | test | L17494 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::fsrs_child_first_log_remaps_duplicate_state_id_without_physical_fk` | test | L17508 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_m9_same_batch_business_key_alias_remaps_later_child_fk` | test | L17648 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_conflict_guard_business_key_alias_remaps_child_fk` | test | L17739 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_suppress_change_log_does_not_mark_existing_user_update` | test | L17762 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::encrypted_file_upload_reuses_session_and_preserves_payload` | tokio::test | L17951 | ported:host/plugins/sync/tests/file-transfer.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::workspace_upload_fails_when_remote_object_size_mismatches` | tokio::test | L18046 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_workspace_roundtrip_between_encrypted_devices` | tokio::test | L18073 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_workspace_plaintext_mode_unaffected` | tokio::test | L18127 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_manifest_publish_uses_neutral_object_name` | tokio::test | L18166 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_manifest_download_reads_legacy_raw_device_dir` | tokio::test | L18200 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_workspace_rejects_legacy_plaintext_entry` | tokio::test | L18283 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_workspace_migrates_legacy_plaintext_entry_on_upload` | tokio::test | L18319 | ported:host/plugins/sync/tests/workspace-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_blob_roundtrip_rejection_and_migration` | tokio::test | L18398 | ported:host/plugins/sync/tests/blob-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::asset_tombstone_reclaims_object_without_conflict_resurrection` | tokio::test | L18547 | ported:host/plugins/sync/tests/file-deletions.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_e2ee_asset_roundtrip_and_legacy_rejection` | tokio::test | L18653 | ported:host/plugins/sync/tests/asset-sync.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_recompute_counts_qbank_material_source_and_pinned_draft_assets` | test | L18753 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::remap_json_embedded_file_ids_rewrites_material_images_and_source_descriptors` | test | L18838 | ported:host/plugins/sync/tests/apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::direct_remote_resource_update_keeps_both_full_document_snapshots` | test | L417 | ported:host/plugins/sync/tests/note-history.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it` | test | L471 | ported:host/plugins/sync/tests/note-history.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::remote_pin_is_retained_after_unpinned_replay_and_prune` | test | L537 | ported:host/plugins/sync/tests/note-history.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::row_sync_transmits_history_dependencies_and_preserves_remote_before_after` | test | L583 | ported:host/plugins/sync/tests/note-history.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins` | test | L680 | ported:host/plugins/sync/tests/note-history.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_two_devices_2_plus_3_converge_to_5` | test | L289 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_remote_tombstone_delete_does_not_resurrect_count` | test | L366 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_repeated_apply_is_idempotent` | test | L416 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo` | test | L466 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_remote_delete_operation_zeroes_count` | test | L494 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_partial_apply_with_quarantined_change_reflects_committed_rows_only` | test | L532 | ported:host/plugins/sync/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_recompute_scope_idempotency_and_echo_suppression` | test | L571 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_recompute_skips_databases_without_todo_tables` | test | L666 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_phase_display_name` | test | L460 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_phase_is_terminal` | test | L467 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_progress_builders` | test | L475 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::legacy_progress_deserializes_without_operation_metadata` | test | L497 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_progress_with_methods` | test | L514 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_speed_calculator_insufficient_samples` | test | L527 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_speed_calculator_with_samples` | test | L537 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_speed_calculator_eta` | test | L552 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_speed_calculator_window_overflow` | test | L567 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_progress_tracker` | test | L579 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_progress_tracker_fail` | test | L598 | ported:host/plugins/sync/tests/progress.test.ts |
| `crates/dstu-sync/src/data_governance/sync/state.rs::tests::tombstone_event_sequence_is_monotonic_and_idempotent` | test | L579 | ported:host/plugins/sync-support/tests/state.test.ts |
| `crates/dstu-sync/src/data_governance/sync/state.rs::tests::tombstone_sequence_waits_for_writer_before_reading` | test | L597 | pending |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_prune_tombstones_retains_expired_without_authoritative_snapshot` | test | L1740 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::watermark_never_filters_same_millisecond_or_clock_rewind_tombstones` | test | L1772 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::malformed_tombstone_manifest_fails_closed` | test | L1817 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_find_blob_by_hash` | test | L1829 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_blob_tombstones_roundtrip` | test | L1854 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::immutable_event_identity_and_key_are_stable` | test | L1872 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::per_device_tombstone_manifests_reread_after_put` | test | L2027 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstones_fails_when_reread_mismatches` | tokio::test | L2048 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstones_fails_when_missing_after_put` | tokio::test | L2092 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::bad_or_future_deleted_at_is_skipped_and_never_advances_watermark` | test | L2125 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::apply_blob_tombstones_skips_bad_clock_entries_without_failing_batch` | tokio::test | L2178 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::event_watermark_stops_before_bad_clock_event` | tokio::test | L2235 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_excludes_bad_entries_from_merge_and_watermark` | tokio::test | L2284 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::tombstone_watermark_source_uses_content_device_id` | test | L2342 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_reads_legacy_raw_name_as_same_device` | tokio::test | L2373 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_rejects_path_content_mismatch` | tokio::test | L2406 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::tombstone_device_keys_use_short_hash_not_raw_id` | test | L2435 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_own_blob_tombstone_reads_legacy_raw_name` | tokio::test | L2467 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstone_migrates_legacy_raw_name` | tokio::test | L2494 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::publish_events_continues_seq_from_legacy_raw_prefix` | tokio::test | L2548 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::torn_blob_dual_write_retry_converges_without_duplicate_event` | tokio::test | L2671 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::interleaved_blob_dual_writes_extend_stream_without_gap_or_duplicate` | tokio::test | L2764 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::cross_device_dual_write_interleaving_keeps_streams_independent` | tokio::test | L2822 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::torn_asset_dual_write_retry_converges_without_duplicate_event` | tokio::test | L2892 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::conflicting_same_operation_rewrite_fails_closed_and_keeps_original_event` | tokio::test | L2952 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `src/data_governance/commands_sync.rs::tests::manual_sync_json_buffered_roundtrip_preserves_record_data` | test | L5916 | ported:host/plugins/sync/tests/transfer-commands.test.ts |
| `src/data_governance/commands_sync.rs::tests::manual_sync_json_retains_read_parse_and_write_error_categories` | test | L5951 | ported:host/plugins/sync/tests/transfer-commands.test.ts |
| `src/data_governance/commands_sync.rs::tests::config_encryption_password_ignores_empty_password` | test | L6054 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::record_upload_policy_allows_plaintext_without_marker` | tokio::test | L6064 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::record_upload_policy_writes_marker_with_verifier_when_encrypted` | tokio::test | L6080 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::record_upload_policy_rejects_plaintext_when_marker_exists` | tokio::test | L6100 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::record_upload_policy_allows_same_password_when_marker_exists` | tokio::test | L6122 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::record_upload_policy_rejects_wrong_password_before_upload` | tokio::test | L6133 | ported:host/plugins/sync/tests/upload-policy.test.ts |
| `src/data_governance/commands_sync.rs::tests::count_unresolved_conflicts_reports_groups_and_rows` | test | L6216 | ported:host/plugins/sync/tests/conflicts.test.ts |
| `src/data_governance/commands_sync.rs::tests::count_unresolved_conflicts_is_zero_without_table_or_rows` | test | L6235 | ported:host/plugins/sync/tests/conflicts.test.ts |
| `src/data_governance/commands_sync.rs::tests::count_and_list_share_group_semantics` | test | L6253 | ported:host/plugins/sync/tests/conflicts.test.ts |
| `src/data_governance/commands_sync.rs::tests::progress_v2_download_paths_enforce_prune_gap_check` | test | L6272 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `src/data_governance/commands_sync.rs::tests::unsafe_snapshot_bootstrap_is_disabled` | test | L6293 | ported:host/plugins/sync/tests/remote-protocol.test.ts |
| `src/data_governance/commands_sync.rs::tests::deletion_queues_never_permanently_abandon_failed_entries` | test | L6314 | ported:host/plugins/sync/tests/deletion-queues.test.ts |
| `src/data_governance/commands_sync.rs::tests::registry_drift_preflight_rejects_missing_row_sync_trigger` | test | L6333 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tests::registry_drift_preflight_rejects_unregistered_change_log_trigger` | test | L6360 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tests::trigger_event_reads_the_header_regardless_of_whitespace` | test | L6392 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tests::registry_drift_preflight_accepts_the_production_pin_trigger_text` | test | L6414 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tests::registry_drift_preflight_allows_exempt_delete_and_update_of_trigger` | test | L6465 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tests::registry_drift_preflight_update_of_counts_as_update_op` | test | L6512 | ported:host/plugins/sync/tests/registry-preflight.test.ts |
| `src/data_governance/commands_sync.rs::tombstone_serial_tests::concurrent_direct_tombstone_marks_serialize_or_fail_busy` | tokio::test | L6635 | ported:host/plugins/sync/tests/tombstone-commands.test.ts |
| `src/data_governance/commands_sync.rs::tombstone_serial_tests::tombstone_limiter_busy_code_is_stable` | test | L6693 | ported:host/plugins/sync/tests/tombstone-commands.test.ts |
| `src/data_governance/commands_sync.rs::tombstone_serial_tests::tombstone_direct_commands_take_permit_and_keep_readback_invariant` | test | L6710 | ported:host/plugins/sync/tests/tombstone-commands.test.ts |
| `src/data_governance/commands_sync.rs::unsynced_items_tests::classify_blobs_distinguishes_present_pending_and_legacy_plaintext` | test | L6797 | ported:host/plugins/sync/tests/unsynced-classification.test.ts |
| `src/data_governance/commands_sync.rs::unsynced_items_tests::classify_assets_reports_case_conflict_sanitized_conflict_and_invalid_key` | test | L6838 | ported:host/plugins/sync/tests/unsynced-classification.test.ts |
| `src/data_governance/commands_sync.rs::unsynced_items_tests::merge_blob_manifests_prefers_cipher_entries_over_plaintext` | test | L6921 | ported:host/plugins/sync/tests/unsynced-classification.test.ts |
| `src/data_governance/commands_sync.rs::unsynced_items_tests::merge_asset_manifests_higher_revision_wins` | test | L6939 | ported:host/plugins/sync/tests/unsynced-classification.test.ts |
| `src/sync_app_tests.rs::field_merge_app_tests::regression_j8c_resources_data_merges_learner_profiles` | test | L13 | pending |
<!-- END GENERATED:testmap:rows -->

## 未接入说明（2026-11-03 wiring 复核）

### D8 部分退休（C2 审批分片，保留活跃断言）

- `schema_upload_rejects_peer_and_same_device_downgrades_without_writes`：只退休 mod.rs:13147-13150 的 dead execute_upload(empty) 子断言（:3942-3945 明确废弃且零生产调用）。:13129-13146 current/peer uploadManifest 错误版本、字节不变、对象总数1、零新增写由 manifest-upload.test.ts 经公开 sync.uploadManifest 完整覆盖。
- `file_and_snapshot_keys_are_neutral_ids`：只退休 :13799-13810 snapshot_key 的前后缀/设备/时间断言（:1415 false，:3510-3515 直接返回）。:13779-13797 blobs file_manifest 前缀、json后缀、UUID长度、无raw/hash/time保留；等待文件服务接线，继续pending。
- `regression_c8_upload_path_verifies_size`：只退休 :13662-13664 中 legacy upload_changes/execute_upload 使用回读的子义；同句实例/设备清单 GET，以及其余record size/bytes/文件清单回读/短写不发布/下载截断不确认均已由 `change-upload.test.ts`（size 短写拒绝 + 同长度错包回读拒绝，published 不推进）与 `workspace-sync.test.ts`（文件级清单回读）行为化覆盖，行已改 ported。

2026-11-04 C2/D8/D2 续作后状态列统计：213 ported / 45 pending / 0 merged / 5 approved obsolete。生成表头保留脚手架原文，待协调者刷新。

支撑方28条仍指向sync-support；writer busy握手仍pending。按C2后续更正，本 lane 独立具备真实apply链的11条恢复为本 lane 测试映射，逐项证据见下。不是把L20b的recompute-only测试当完整apply，也不表示S03或单写者接缝已签收。

### 11 项原断言与真实生产入口证据

两文件均先安装 sync 插件，再调用 `host.ctx.sync.applyDownloadedChanges`，没有测试自写 apply。笔记宿主还安装真实 vfs-repos/notes，无旧服务名转发、无 notes 内部 import。该服务从 index.ts → apply-batch.ts 使用 IMMEDIATE/SAVEPOINT/隔离和提交前重算；笔记出站通过公开 getPendingChanges/enrichChangesWithData。L11计数所有者接缝现已集成到main，本lane删除重复SQL并传同一个事务；另有所有者故障导致整批回滚的测试。历史所有者精度接缝待独立整改，不以计数用例通过冒充S03全闭合。

| Rust 测试 | 原断言保留/TS 路径 |
|---|---|
| direct_remote_resource_update_keeps_both_full_document_snapshots | note-history.test.ts：初次/资源Update failure_count=0；before全正文+pinned、after全正文都能经ctx.notes.revisions读取 |
| relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it | 同文件：出站无revision；目标首次1、重放1、换绑2、重放2；缺目标不造resources；真实notes_relation_get验证两项reference=true |
| remote_pin_is_retained_after_unpinned_replay_and_prune | 同文件：真实apply pin/unpin，再真实Delete；读取原version仍pinned |
| row_sync_transmits_history_dependencies_and_preserves_remote_before_after | 同文件：未来format/serializer整批拒绝且空库；出站history无seq且有pinned；乱序两设备before/after、restoreCopy恢复before |
| immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins | 同文件：tampered failure=1，原正文/pin保留；合法retry failure=0；Delete保留pin；未来版本failure=1且不存在 |
| td02_two_devices_2_plus_3_converge_to_5 | pomodoro-counts.test.ts：两个真实SQLite库初始2/3，对称公开apply后均5（Rust:289-359） |
| td02_remote_tombstone_delete_does_not_resurrect_count | 同文件：本地pending开启字段合并，远端软删落地，2→1，整批重放仍1（:366-411） |
| td02_repeated_apply_is_idempotent | 同文件：两次真实apply计数均5、事实表行数5（:416-461） |
| td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo | 同文件：初始1/0，远端换绑apply后0/1（:466-488） |
| td02_remote_delete_operation_zeroes_count | 同文件：真实Delete写deleted_at，计数1→0（:494-525） |
| td02_partial_apply_with_quarantined_change_reflects_committed_rows_only | 同文件：坏payload+正常行真实SAVEPOINT apply，success=1/failure=1，计数仅1（:532-562） |

- `asset_filenames.rs` 全部 10 个测试：已映射到 `asset-filenames.test.ts`（10/10，逐条比对 Rust 原断言/边界后改为 ported；冲突标记、控制字符、NFC/NFD、255 单位上限、路径遍历等断言一一对应）。
- `tombstone.rs` 本目录 `tests/tombstone.test.ts` 原映射的 9 行：未接入：生产归 L20b `syncSupport.tombstone`，本目录纯函数副本没有生产调用方。L20b 已发布同步 `PayloadCodec.encode/decode`，而 F4 DSBK 接口返回 Promise；需 L20b 增补异步 codec 接口，不能给启用 E2EE 的生产路径传 plainCodec。
- `state.rs::tombstone_event_sequence_is_monotonic_and_idempotent`：未接入：生产归 L20b `syncSupport.state`，本目录 `repository/state.ts` 副本不应作为第二个状态写入方；待消费真实服务后映射到覆盖服务行为的测试。

其余 pending 不因存在测试文件而计作完成；全量剩余项与证据见 REPORT.md。

## WP-004（2026-11-05）

实际去向列：pending 2 → 2、ported 256 → 256、merged 0 → 0、approved obsolete 5 → 5。本包无映射条目变更；生成表头和上方旧统计保留历史原文。

新增 `tests/mastery-integration.test.ts` 五项为生产入口集成回归：真实 review+sync+backup 验证导入响应、公开多库 apply 的删除重建、两个 mastery 后置错误与提交边界、策略失败/许可释放；Rust 行为对应见 SPEC 的 WP-004 小节。没有把新增用例映射成画像 merger 原测试。

`regression_j8c_resources_data_merges_learner_profiles` 的 memory 公共 merger 已发布（main `memory/api.ts:60`），剩余消费/断言核对留后续包；`file_and_snapshot_keys_are_neutral_ids` 的活跃 blob manifest 断言亦留后续复核，已批准退休的 snapshot 子义不需补实现。
