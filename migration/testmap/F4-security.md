# F4-security 测试去向（地基线；实现目录不归 scaffold 所有，去向同样由该 lane 填写）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane F4-security：300 行（真实测试 300）· merged 17 · obsolete 7 · pending 30 · ported 246
<!-- END GENERATED:testmap:header -->

> 计数快照：C2 复核的 `bef778fcf` 为 219 ported / 15 merged / 7 obsolete / 59 pending（闭合 241）；
> 当前分支在 SSE/P06/L03/F1 追加后为 246 / 17 / 7 / 30（闭合 270）。计数按去向列统计；A 由 ledger
> 计算，不在本表手算。

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-core/src/agent.rs::tests::message_block_starts_pending_and_records_first_chunk` | test | L477 | pending |
| `crates/dstu-core/src/agent.rs::tests::tool_result_info_strip_payload_requires_block_id` | test | L489 | pending |
| `crates/dstu-core/src/agent.rs::tests::tool_scope_serializes_with_kind_tag` | test | L515 | ported:host/platform/util/tests/agent-scope.test.ts |
| `crates/dstu-core/src/canonical_tools.rs::tests::canonical_tool_name_codec_round_trips_invalid_names` | test | L173 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::canonical_tool_name_codec_round_trips_invalid_names |
| `crates/dstu-core/src/canonical_tools.rs::tests::canonical_tool_name_codec_preserves_valid_names` | test | L183 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::canonical_tool_name_codec_preserves_valid_names |
| `crates/dstu-core/src/canonical_tools.rs::tests::canonical_tool_name_codec_reencodes_reserved_prefix_names` | test | L193 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::canonical_tool_name_codec_reencodes_reserved_prefix_names |
| `crates/dstu-core/src/canonical_tools.rs::tests::build_openai_function_tool_schema_normalizes_missing_parameters` | test | L205 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::build_openai_function_tool_schema_normalizes_missing_parameters |
| `crates/dstu-core/src/canonical_tools.rs::tests::build_openai_function_tool_schema_normalizes_non_object_parameters` | test | L212 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::build_openai_function_tool_schema_normalizes_non_object_parameters |
| `crates/dstu-core/src/canonical_tools.rs::tests::prepare_external_tool_for_legacy_pipeline_uses_bridge_name_source` | test | L220 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::prepare_external_tool_for_legacy_pipeline_uses_bridge_name_source |
| `crates/dstu-core/src/canonical_tools.rs::tests::prepare_external_tool_for_chat_pipeline_uses_internal_name_source` | test | L244 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::prepare_external_tool_for_chat_pipeline_uses_internal_name_source |
| `crates/dstu-core/src/canonical_tools.rs::tests::external_route_tuple_encoding_prevents_tool_server_boundary_collisions` | test | L273 | merged:host/plugins/chat-pipeline/tests/canonical-tools.test.ts::external_route_tuple_encoding_prevents_tool_server_boundary_collisions |
| `crates/dstu-core/src/error_details.rs::tests::test_error_details_builder` | test | L398 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_details.rs::tests::test_http_status_conversion` | test | L406 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_details.rs::tests::command_error_serializes_camel_case_and_skips_none` | test | L416 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_details.rs::tests::command_error_from_error_details_reuses_screaming_code` | test | L433 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_details.rs::tests::command_error_code_is_stable_across_message_changes` | test | L442 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_details.rs::tests::test_error_inference` | test | L450 | ported:host/platform/errors/tests/errors.test.ts |
| `crates/dstu-core/src/error_recovery.rs::tests::test_retry_success_after_failures` | tokio::test | L310 | obsolete:zero-production-callers |
| `crates/dstu-core/src/error_recovery.rs::tests::test_retry_all_failures` | test | L336 | obsolete:zero-production-callers |
| `crates/dstu-core/src/events.rs::tests::event_type_strings_stay_wire_stable` | test | L130 | ported:host/platform/util/tests/shared-events.test.ts |
| `crates/dstu-core/src/lib.rs::tests::app_version_is_injected_from_app_manifest` | test | L41 | merged:host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest |
| `crates/dstu-core/src/models.rs::tests::image_generation_model_assignment_defaults_for_legacy_payload` | test | L2163 | ported:host/platform/util/tests/model-assignments.test.ts |
| `crates/dstu-core/src/prompt_contracts.rs::tests::latex_rules_contains_core_constraints` | test | L71 | merged:host/plugins/chat-pipeline/tests/prompt-contracts.test.ts::latex_rules_contains_core_constraints |
| `crates/dstu-core/src/prompt_contracts.rs::tests::latex_output_brief_is_consistent_with_full_rules` | test | L80 | merged:host/plugins/chat-pipeline/tests/prompt-contracts.test.ts::latex_output_brief_is_consistent_with_full_rules |
| `crates/dstu-core/src/prompt_contracts.rs::tests::difficulty_rubric_covers_all_levels` | test | L89 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_review_quality_from_u8` | test | L335 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_review_quality_is_passing` | test | L343 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_first_review_passed` | test | L353 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_first_review_passed returns FIRST_INTERVAL and one repetition |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_second_review_passed` | test | L363 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_second_review_passed returns SECOND_INTERVAL and two repetitions |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_third_review_passed` | test | L373 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_third_review_passed multiplies the previous interval by the new ease factor |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_review_failed` | test | L385 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_review_failed resets interval and repetitions but preserves ease factor |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_ease_factor_decrease` | test | L395 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_ease_factor_decrease lowers the ease factor on repeated difficult reviews |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_ease_factor_increase` | test | L406 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_ease_factor_increase raises the ease factor on a perfect review |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_ease_factor_minimum` | test | L415 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_ease_factor_minimum keeps the ease factor at or above 1.3 |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_interval_maximum` | test | L426 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_interval_maximum caps the interval at MAX_INTERVAL |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_calculate_next_review_date` | test | L434 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_calculate_next_review_date returns a YYYY-MM-DD date |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_is_due_for_review` | test | L443 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_days_overdue` | test | L462 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_advanced_api` | test | L475 | pending |
| `crates/dstu-core/src/spaced_repetition.rs::tests::test_calculate_ease_factor` | test | L484 | merged:host/plugins/review/tests/spaced-repetition.test.ts::test_calculate_ease_factor follows the standard SM-2 delta |
| `crates/dstu-core/src/task_objects.rs::tests::managed_locator_rejects_escape_and_absolute_paths` | test | L1123 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::materializable_handle_requires_managed_locator` | test | L1131 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::incomplete_batch_cannot_claim_complete_success` | test | L1141 | pending |
| `crates/dstu-core/src/task_objects.rs::tests::connector_commit_requires_matching_preview_confirmation` | test | L1160 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::derived_edge_serializes_v2_and_reads_legacy_string` | test | L1183 | pending |
| `crates/dstu-core/src/task_objects.rs::tests::schema_v1_handle_with_string_lineage_still_validates` | test | L1209 | pending |
| `crates/dstu-core/src/task_objects.rs::tests::builder_requires_explicit_lineage` | test | L1244 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::builder_origin_unknown_builds_with_empty_lineage` | test | L1252 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::builder_build_runs_validation` | test | L1262 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_multi_page_concat_matches_original_and_sha256` | test | L1292 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_rejects_foreign_roots_and_escapes` | test | L1322 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_rejects_symlink_escape` | test | L1357 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_utf8_boundary_and_progress_guarantee` | test | L1371 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_binary_returns_base64` | test | L1395 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::read_page_offset_edges_and_empty_file` | test | L1419 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_paginates_without_dropping_any_file` | test | L1473 | pending |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_keeps_same_name_files_as_distinct_entries` | test | L1517 | merged:host/plugins/agent-skills/tests/task-objects-manifests.test.ts::corpus_manifest_keeps_same_name_files_as_distinct_entries |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count` | test | L1536 | merged:host/plugins/agent-skills/tests/task-objects-manifests.test.ts::corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_notice_states_totals_and_readback_path` | test | L1568 | merged:host/plugins/agent-skills/tests/task-objects-manifests.test.ts::corpus_manifest_notice_states_totals_and_readback_path |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_pages_are_snapshot_immutable_after_source_change` | test | L1587 | merged:host/plugins/agent-skills/tests/task-objects-manifests.test.ts::corpus_manifest_pages_are_snapshot_immutable_after_source_change |
| `crates/dstu-core/src/task_objects.rs::tests::corpus_manifest_validate_rejects_bad_shape` | test | L1614 | merged:host/plugins/agent-skills/tests/task-objects-manifests.test.ts::corpus_manifest_validate_rejects_bad_shape |
| `crates/dstu-core/src/task_objects.rs::tests::write_page_create_overwrite_and_pwrite` | test | L1678 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::write_page_optimistic_lock_and_offset_bounds` | test | L1714 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::write_page_rejects_foreign_roots_and_escapes` | test | L1748 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/task_objects.rs::tests::write_page_rejects_symlink_escape` | test | L1775 | ported:host/platform/util/tests/task-objects.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_coerce_json_array_accepts_native_array` | test | L148 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_coerce_json_array_accepts_stringified_array` | test | L155 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_coerce_json_array_rejects_non_array_json_string` | test | L162 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_get_string_array_arg_accepts_stringified_array` | test | L168 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_with_localized_message_keeps_machine_and_readable_fallbacks` | test | L178 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_ensure_localized_error_wraps_plain_and_legacy_errors` | test | L203 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_ensure_localized_error_preserves_complete_contract` | test | L233 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_args.rs::tests::test_ensure_localized_error_bounds_internal_detail` | test | L253 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_names.rs::tests::test_external_mcp_namespace_detection_preserves_source` | test | L38 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/tool_names.rs::tests::strip_tool_namespace_removes_builtin_and_mcp_prefixes` | test | L46 | ported:host/platform/errors/tests/tool-args.test.ts |
| `crates/dstu-core/src/workflow_error_handler.rs::tests::test_error_handler_retry` | tokio::test | L443 | obsolete:zero-production-callers |
| `crates/dstu-core/src/workflow_error_handler.rs::tests::test_circuit_breaker` | tokio::test | L463 | obsolete:zero-production-callers |
| `crates/dstu-platform/src/background_tasks.rs::tests::tracked_tauri_spawn_does_not_require_an_entered_tokio_runtime` | test | L121 | ported:host/platform/diagnostics/tests/background-tasks.test.ts |
| `crates/dstu-platform/src/background_tasks.rs::tests::admission_closed_rejects_new_spawn_but_drains_admitted` | test | L134 | ported:host/platform/diagnostics/tests/background-tasks.test.ts |
| `crates/dstu-platform/src/debug_log_service.rs::tests::write_debug_response_entry_preserves_raw_response_completely` | test | L751 | ported:host/platform/log/log.test.ts |
| `crates/dstu-platform/src/debug_log_service.rs::tests::write_debug_response_entry_redacts_credential_like_text` | test | L786 | ported:host/platform/log/log.test.ts |
| `crates/dstu-platform/src/debug_log_service.rs::tests::write_debug_log_entry_still_writes_and_redacts_request_body` | test | L805 | ported:host/platform/log/log.test.ts |
| `crates/dstu-platform/src/debug_log_service.rs::tests::safe_components_keep_filename_safe` | test | L833 | ported:host/platform/log/log.test.ts |
| `crates/dstu-platform/src/secret_prompt.rs::tests::handles_are_memory_only_ttl_bound_and_one_shot` | test | L198 | obsolete:dead-in-rust disabled-entry |
| `crates/dstu-platform/src/secret_prompt.rs::tests::purpose_mismatch_consumes_and_zeroizes_entry` | test | L219 | obsolete:dead-in-rust disabled-entry |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::roundtrip_encrypt_decrypt` | test | L1118 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::wrong_password_fails` | test | L1131 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::tampered_data_fails` | test | L1138 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::non_encrypted_file_detected` | test | L1146 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::stream_roundtrip_various_sizes` | test | L1152 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::stream_wrong_password_fails` | test | L1177 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::stream_truncation_is_detected` | test | L1188 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::password_verifier_roundtrip_and_wrong_password` | test | L1203 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::password_verifier_digest_does_not_leak_key` | test | L1214 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::password_verifier_unknown_kdf_fails_closed` | test | L1232 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::password_verifier_corrupted_fields_fail_closed` | test | L1242 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::session_bytes_roundtrip_and_wrong_password` | test | L1269 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::session_file_roundtrip_across_sessions` | test | L1286 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::session_output_interoperates_with_password_api` | test | L1319 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::session_rejects_empty_password` | test | L1338 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::kdf_limits_cover_default_write_surface` | test | L1345 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::kdf_oversized_params_rejected_before_derivation` | test | L1362 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::verifier_oversized_params_fail_closed_as_err` | test | L1385 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::dsbk_headers_with_oversized_params_rejected` | test | L1394 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::new_password_cap_matches_platform_and_never_loosens_global_cap` | test | L1419 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::new_password_cap_covers_default_write_surface_on_every_platform` | test | L1439 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::session_with_params_rejects_m_cost_above_new_password_cap` | test | L1450 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::decrypt_and_legacy_verifier_paths_are_not_tightened_by_new_password_cap` | test | L1472 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::encrypted_root_memory_roundtrip_and_isolation` | test | L1495 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::encrypted_root_memory_corrupted_file_fails_closed` | test | L1514 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::dsbk_layout_constants_match_real_containers` | test | L1533 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::stream_decrypts_legacy_v1_file` | test | L1562 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_trial_proves_password_with_prefix_only` | test | L1587 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_trial_final_flag_matches_object_size` | test | L1615 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_trial_tampered_first_block_fails` | test | L1649 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_plan_v1_requires_whole_file` | test | L1660 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_plan_rejects_bad_headers` | test | L1678 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_trial_truncated_prefix_rejected` | test | L1705 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::first_chunk_trial_oversized_kdf_params_rejected_fast` | test | L1715 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/backup_crypto.rs::tests::speculative_prefix_len_covers_own_write_surface` | test | L1732 | ported:host/platform/secrets/backup-crypto.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_crypto_service_creation` | tokio::test | L9 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_encrypt_decrypt_cycle` | tokio::test | L18 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_encrypted_format_detection` | tokio::test | L35 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_migrate_plaintext_key` | tokio::test | L50 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_key_rotation` | tokio::test | L69 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_empty_and_invalid_data` | tokio::test | L89 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto/tests.rs::test_encrypted_data_serialization` | test | L110 | ported:host/platform/secrets/crypto-service.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::recover_without_journal_is_clean_and_sweeps_stale_rollback` | test | L269 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::uncommitted_publication_rolls_back_previous_keys` | test | L281 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::uncommitted_publication_removes_new_keys_when_no_previous_generation` | test | L305 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_before_moving_old_keys_leaves_target_untouched` | test | L319 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::committed_publication_rolls_forward_and_keeps_new_keys` | test | L344 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::mismatched_lease_fails_closed` | test | L364 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::corrupted_journal_fails_closed` | test | L376 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p1_after_journal_write_keeps_all_domains_old` | test | L463 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p2_midway_old_master_moved_restores_old_generation` | test | L480 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p2_new_master_installed_secure_pending_restores_old` | test | L504 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p2_first_install_midway_removes_partial_new_keys` | test | L531 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p3_before_pending_slot_registration_rolls_back_to_old` | test | L557 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/crypto_publication.rs::tests::crash_matrix_p3_after_pending_slot_registration_rolls_forward` | test | L586 | ported:host/platform/secrets/crypto-publication.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::stable_seed_is_persisted` | test | L1538 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::plaintext_backup_seed_is_portable` | test | L1550 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::oversized_backup_seed_is_rejected_before_reading` | test | L1560 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::empty_existing_seed_fails_closed_without_replacement` | test | L1573 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::oversized_encrypted_secret_is_rejected_before_allocation` | test | L1590 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::symlinked_backup_seed_is_rejected` | test | L1607 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::dpapi_wrapped_backup_seed_is_rejected_off_windows` | test | L1622 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::plaintext_seed_migrates_to_dpapi_wrapping` | test | L1635 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::plaintext_seed_exports_for_password_encrypted_backup` | test | L1677 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::exported_plaintext_seed_survives_import_roundtrip` | test | L1690 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::reseal_wraps_imported_plaintext_seed_on_windows` | test | L1715 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::reseal_keeps_imported_plaintext_seed_off_windows` | test | L1743 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::dpapi_seed_export_fails_closed_off_windows` | test | L1762 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_marker_seed_reseal_is_noop_and_export_fails_without_backend` | test | L1779 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::classify_seed_content_variants` | test | L1844 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::seed_fingerprint_is_stable_hex` | test | L1867 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::plaintext_seed_migrates_into_keystore_with_verified_marker` | test | L1878 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::migration_store_failure_keeps_plaintext_file` | test | L1907 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::migration_readback_mismatch_keeps_plaintext_file` | test | L1924 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_ref_fails_closed_without_backend` | test | L1941 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_ref_fails_closed_when_backend_unavailable` | test | L1949 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_ref_fails_closed_when_entry_missing` | test | L1963 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_ref_fingerprint_mismatch_fails_closed` | test | L1972 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_marker_seed_file_never_replaced_by_new_seed` | test | L1986 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::keystore_marker_backup_seed_is_rejected_without_backend` | test | L2007 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::dpapi_seed_is_rejected_off_windows_when_reading` | test | L2024 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::new_seed_stays_in_local_file_by_default` | test | L2041 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::enabling_keystore_protection_fails_closed_without_backend` | test | L2073 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::disabling_keystore_protection_is_idempotent` | test | L2091 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::tests::can_read_legacy_ciphertext_and_migrate` | test | L2103 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::credential_status_never_serializes_secret_values` | test | L2732 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::debug_output_redacts_all_secret_values` | test | L2749 | pending |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::debug_output_preserves_presence_information` | test | L2779 | pending |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::credential_update_preserves_omitted_backend_secrets` | test | L2797 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::short_encryption_password_is_rejected_and_does_not_mark_configured` | test | L2821 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::preexisting_short_encryption_password_is_accepted` | test | L2863 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::preexisting_policy_does_not_relax_the_default_entry` | test | L2888 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::weak_password_predicate_semantics` | test | L2911 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::new_password_gate_checks_length_before_weakness` | test | L2937 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::new_weak_encryption_password_is_rejected_and_not_persisted` | test | L2948 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::preexisting_weak_encryption_password_is_accepted` | test | L2988 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::clearing_encryption_password_keeps_transport_credentials` | test | L3012 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::clearing_the_only_secret_removes_the_record_entirely` | test | L3039 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::clearing_encryption_password_without_stored_credentials_is_a_noop` | test | L3062 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::successful_cloud_credential_clear_removes_the_secret_record` | test | L3075 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::staged_write_leaves_active_record_and_generation_untouched` | test | L3109 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::commit_advances_generation_and_publishes_staged_values` | test | L3174 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::abort_discards_staged_without_touching_active` | test | L3227 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::staged_write_enforces_the_same_short_password_policy` | test | L3276 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::staged_write_enforces_the_same_weak_password_policy` | test | L3326 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::stale_generation_handles_fail_closed_without_touching_active` | test | L3371 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::commit_without_staged_record_fails_closed` | test | L3437 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::transactional_delete_clears_active_staged_and_generation` | test | L3458 | ported:host/platform/secrets/secure-store.test.ts |
| `crates/dstu-util/src/qr.rs::tests::generates_non_empty_png` | test | L29 | merged:host/kernel/tests/plugins.test.ts::qrcode_png_base64 starts with the PNG signature and contains a decodable payload |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_ascii_passthrough` | test | L134 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_chinese_char_split_across_chunks` | test | L142 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_chinese_text_split_at_every_position` | test | L154 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_four_byte_emoji_split_three_ways` | test | L169 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_sse_line_split_mid_char` | test | L182 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_truly_invalid_bytes_replaced` | test | L196 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_flush_incomplete_tail_becomes_replacement` | test | L205 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utf8_stream.rs::tests::test_empty_chunk` | test | L214 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/chat_query.rs::tests::test_derive_latest_user_query_from_history` | test | L177 | obsolete:zero-production-callers |
| `crates/dstu-util/src/utils/chat_query.rs::tests::test_derive_latest_user_query_fallback` | test | L228 | obsolete:zero-production-callers |
| `crates/dstu-util/src/utils/chat_query.rs::tests::test_derive_mistake_query` | test | L237 | obsolete:zero-production-callers |
| `crates/dstu-util/src/utils/fetch.rs::tests::blocks_non_http_schemes` | test | L108 | ported:host/platform/net-policy/tests/fetch-policy.test.ts |
| `crates/dstu-util/src/utils/fetch.rs::tests::allows_loopback_hosts` | test | L115 | ported:host/platform/net-policy/tests/fetch-policy.test.ts |
| `crates/dstu-util/src/utils/fetch.rs::tests::blocks_private_and_link_local_ipv4` | test | L125 | ported:host/platform/net-policy/tests/fetch-policy.test.ts |
| `crates/dstu-util/src/utils/fetch.rs::tests::blocks_local_ipv6_ranges` | test | L133 | ported:host/platform/net-policy/tests/fetch-policy.test.ts |
| `crates/dstu-util/src/utils/fetch.rs::tests::allows_public_ip_literal` | test | L139 | ported:host/platform/net-policy/tests/fetch-policy.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::policy_is_limited_to_glm_and_qwen_routes` | test | L639 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::disabled_policy_preserves_even_a_token_only_stream` | test | L663 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_token_only_stream_and_standalone_residual_line` | test | L670 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_torn_outer_wrappers` | test | L679 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::preserves_literal_tokens_in_prose` | test | L691 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::preserves_literal_tokens_in_inline_and_fenced_code` | test | L701 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::reset_discards_partial_candidate_from_failed_attempt` | test | L718 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_continuation_header_after_substantive_text` | test | L732 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_continuation_header_for_all_known_roles` | test | L746 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_continuation_header_at_stream_head_and_at_flush` | test | L758 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::stripped_continuation_header_opens_wrapper_for_its_closer` | test | L775 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::preserves_role_word_lines_that_are_not_bare_headers` | test | L784 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_tail_glued_closer_at_flush` | test | L810 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::strips_tail_glued_closer_followed_by_blank_lines_at_flush` | test | L822 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::preserves_mid_stream_glued_closer_when_content_follows` | test | L836 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::unpaired_backtick_does_not_disable_filtering_past_the_line` | test | L853 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/model_special_tokens.rs::tests::large_single_chunk_keeps_semantics_with_cursor_consumption` | test | L872 | ported:host/platform/util/tests/model-special-tokens.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_complete_lines` | test | L361 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_incomplete_line` | test | L372 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_mixed_complete_and_incomplete` | test | L386 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_flush_remaining` | test | L400 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_done_marker` | test | L414 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_empty_chunk` | test | L421 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_buffer_overflow_protection` | test | L429 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_buffer_exactly_at_limit` | test | L454 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::test_multiple_chunks_with_fragmentation` | test | L468 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_keeps_event_name_with_data_payload` | test | L499 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_preserves_utf8_split_across_byte_chunks` | test | L512 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_no_replacement_char_when_chinese_split_in_two_chunks` | test | L526 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_reassembles_multibyte_content_split_at_every_byte_boundary` | test | L544 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_flush_marks_stream_truncated_mid_character` | test | L569 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_emits_single_newline_done_tail` | test | L579 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_flushes_unterminated_event_block` | test | L589 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_preserves_jsonl_lines` | test | L602 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::stream_payload_accepts_bare_json_without_misreading_sse_metadata` | test | L614 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_enforces_combined_size_limit` | test | L627 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/sse_buffer.rs::tests::event_buffer_long_single_line_split_across_many_chunks_is_linear` | test | L637 | ported:host/platform/util/tests/sse-buffer.test.ts |
| `crates/dstu-util/src/utils/token_budget.rs::tests::estimate_tokens_with_model_short_text_matches_exact_encoding` | test | L248 | merged:host/platform/native/tests/tokenizer.test.ts::estimate_tokens_with_model_short_text_matches_exact_encoding |
| `crates/dstu-util/src/utils/token_budget.rs::tests::estimate_tokens_with_model_huge_repetitive_text_is_fast_and_reasonable` | test | L259 | merged:host/platform/native/tests/tokenizer.test.ts::estimate_tokens_with_model_huge_repetitive_text_is_fast_and_reasonable |
| `crates/dstu-util/src/utils/token_budget.rs::tests::estimate_tokens_with_model_heterogeneous_text_does_not_average_away_dense_segments` | test | L280 | merged:host/platform/native/tests/tokenizer.test.ts::estimate_tokens_with_model_heterogeneous_text_does_not_average_away_dense_segments |
| `crates/dstu-util/src/utils/token_budget.rs::tests::estimate_tokens_with_model_varied_huge_text_extrapolates_close_to_exact` | test | L308 | merged:host/platform/native/tests/tokenizer.test.ts::estimate_tokens_with_model_varied_huge_text_extrapolates_close_to_exact |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_zero_width` | test | L55 | ported:host/platform/paths/tests/unicode.test.ts |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_fullwidth` | test | L62 | ported:host/platform/paths/tests/unicode.test.ts |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_bidi` | test | L69 | ported:host/platform/paths/tests/unicode.test.ts |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_isolation` | test | L75 | ported:host/platform/paths/tests/unicode.test.ts |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_invisible_operators` | test | L80 | ported:host/platform/paths/tests/unicode.test.ts |
| `crates/dstu-util/src/utils/unicode.rs::tests::test_sanitize_normal_text` | test | L85 | ported:host/platform/paths/tests/unicode.test.ts |
| `src/backup_config.rs::tests::test_backup_config_default_values` | test | L724 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_backup_config_serialization_roundtrip` | test | L745 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_backup_config_deserialize_with_defaults` | test | L769 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_backup_config_camel_case_serialization` | test | L784 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_auto_backup_running_compare_exchange` | test | L811 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_get_effective_backup_dir_no_custom` | test | L847 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_default_backup_dir_escapes_runtime_slot` | test | L860 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_get_effective_backup_dir_custom_exists` | test | L869 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_get_effective_backup_dir_custom_not_exists` | test | L886 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_auto_backup_staging_is_under_app_data_not_custom_destination` | test | L901 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_cleanup_old_backups_removes_oldest` | test | L929 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_cleanup_old_backups_no_op_when_under_limit` | test | L966 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_cleanup_old_backups_ignores_non_auto_backups` | test | L987 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_log_and_skip_entry_err_ok` | test | L1015 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_log_and_skip_entry_err_err` | test | L1021 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_effective_backup_directory_none` | test | L1031 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_effective_backup_directory_existing` | test | L1040 | ported:host/platform/settings/backup-config.test.ts |
| `src/backup_config.rs::tests::test_effective_backup_directory_nonexistent` | test | L1053 | ported:host/platform/settings/backup-config.test.ts |
| `tests/cloud_half_configured_credentials_tests.rs::webdav_missing_password_fails_closed_before_any_network_io` | tokio::test | L63 | ported:host/platform/errors/tests/cloud-half-configured.test.ts |
| `tests/cloud_half_configured_credentials_tests.rs::webdav_whitespace_password_is_still_missing_credential` | tokio::test | L94 | ported:host/platform/errors/tests/cloud-half-configured.test.ts |
| `tests/cloud_half_configured_credentials_tests.rs::s3_missing_secret_key_fails_closed` | tokio::test | L107 | ported:host/platform/errors/tests/cloud-half-configured.test.ts |
| `tests/cloud_half_configured_credentials_tests.rs::ftp_missing_password_fails_closed` | tokio::test | L141 | ported:host/platform/errors/tests/cloud-half-configured.test.ts |
| `tests/cloud_half_configured_credentials_tests.rs::webdav_with_full_credentials_passes_validation` | tokio::test | L174 | ported:host/platform/errors/tests/cloud-half-configured.test.ts |
| `tests/device_identity_tests.rs::device_id_probe_subprocess` | test | L26 | merged:host/platform/paths/paths.test.ts::two_app_data_dirs_yield_distinct_persisted_device_ids |
| `tests/device_identity_tests.rs::two_app_data_dirs_yield_distinct_persisted_device_ids` | test | L73 | ported:host/platform/paths/paths.test.ts |
| `tests/error_details_tests.rs::test_error_details_creation` | test | L9 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_methods` | test | L25 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_api_key_missing` | test | L51 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_api_key_invalid` | test | L63 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_network_error` | test | L81 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_rate_limit` | test | L98 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_service_unavailable` | test | L116 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_tool_not_found` | test | L133 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_tool_timeout` | test | L144 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_builder_parse_error` | test | L162 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_http_status_to_error_code` | test | L180 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_infer_error_code_from_message` | test | L196 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_error_details_serialization` | test | L240 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/error_details_tests.rs::test_action_suggestion_serialization` | test | L258 | ported:host/platform/errors/tests/errors.test.ts |
| `tests/secure_store_tests.rs::test_secure_store_basic_operations` | tokio::test | L25 | ported:host/platform/secrets/secure-store.test.ts |
| `tests/secure_store_tests.rs::test_sensitive_key_detection` | tokio::test | L65 | ported:host/platform/secrets/secure-store.test.ts |
| `tests/secure_store_tests.rs::test_database_secure_integration` | tokio::test | L83 | ported:host/platform/settings/settings.test.ts |
| `tests/secure_store_tests.rs::test_fallback_behavior` | tokio::test | L115 | ported:host/platform/settings/settings.test.ts |
<!-- END GENERATED:testmap:rows -->

## 归属说明（待协调者刷新 scaffold）

### WP-087 · X6 #22/#23 Debug 映射资格纠正（2026-11-06）

结论：两个旧 `merged` 均退回 `pending`。正常合入 main `6e2936bac` 后逐条读完 Rust
原测试与候选 TS，用例名相似及 status JSON 脱敏不构成 Debug 等价证据。
当前计数为 **245 ported / 32 merged / 9 obsolete / 14 pending**（pending 12 → 14）；
本节之后的 12 pending 是历史快照，下面跨 lane 的 12 条仍独立，新增 2 条是 F4 自有缺口。
只改这两个 ID 的去向；generated header 和其他映射保留。

Rust 路径前缀为 `src-tauri/crates/dstu-security/src/secure_store.rs`；TS 路径为
`host/platform/secrets/secure-store.test.ts`：

| Rust ID / 行 | 原输入、格式与逐条断言 | TS 候选 / 断言证据 | 去向与缺口 |
|---|---|---|---|
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::debug_output_redacts_all_secret_values` :2749-2775 | 四字段分别为 `webdav-secret` / `s3-secret` / `ftp-secret` / `encryption-secret`；对 `{:?}` 和 `{:#?}` 两种输出，每种逐一排除四个明文，包含 `[REDACTED]`，包含 `webdav_password`、`s3_secret_access_key`、`ftp_password`、`encryption_password`（每种 9 条，共 18 次断言） | 原 :326-330（现 :328-332）`credentialStatus reports one configured backend and three absent secrets` 只有 webdav 输入及 1 条精确 status JSON 断言；未格式化四秘密输入、未检查两种 Debug、REDACTED 或 snake_case 字段名。邻例 :321-325 的四秘密 status JSON 也不是 Debug | pending；尚无承接这 18 次断言的生产 Debug 入口/TS 测试 |
| `crates/dstu-security/src/secure_store.rs::cloud_hydration_tests::debug_output_preserves_presence_information` :2779-2793 | 只有 webdav 为 Some，其他 None；普通 `{:?}` 的单条精确字符串相等断言，期望值见下方 | 同一 TS :328-332 输入与原例一致，但 :329-331 比较 camelCase `*Configured` 布尔 JSON，不是类型名、snake_case 字段及 Some/None Debug 文本 | pending；原断言保留为补充 status 测试，不冒充 Debug presence |

第二条 Rust 原期望全文：

```text
CloudStorageCredentials { webdav_password: Some("[REDACTED]"), s3_secret_access_key: None, ftp_password: None, encryption_password: None }
```

生产缺口证据（属于 F4 自有实现，不是待供方）：

- Rust :2291-2302 手写 `CloudStorageCredentials::fmt`，用 `Option::as_ref().map` 脱敏，保留
  Some/None（Some 空串也存在）；`:2335-2353 status()` 则以 trim 后非空判断配置状态，是另一种语义。
- TS `secrets/api.ts:130-136` 只有结构接口；`secure-store.ts:530-554` 解码为普通对象，
  `:991-998 getCloudCredentials()` 原样返回，没有凭据 Debug / custom inspect 钩子。
- main 已有正式生产链 `secrets/index.ts:109-111` provide/register → `commands.ts:26`
  `secure_get_cloud_credentials` → `secure-store.ts:1013-1014 cloudCredentialStatus()` →
  `:501-511 credentialStatus()`；该链只返回四个 bool。`index.ts:78-94` 的服务出口亦无凭据
  Debug formatter。全 host 检索凭据类型及 custom inspect，现有 inspect 钩子属于 Codex 类型，
  不适用于此处凭据。未发现可复用的生产凭据 Debug 格式化入口。
- 缺的是 F4 在真实凭据对象/生产格式化路径上的对应行为及同输入全断言；本包按 brief 无入口则
  pending 的验收分支交付，不造仅测试 formatter，不把通用日志脱敏或 status JSON 当成替代。
- 原 TS 断言、输入、执行条件均保留，只纠正标题与注释；不增加 `::title` 来绕过整文件关联的
  Windows skip。两条 Debug 无 pass 签收；Windows 专属用例仍只在目标平台执行后才可验证。

### WP-007 · B4/D15-time（2026-11-05）

- 发布 `host/platform/time/{api,index}.ts::parseChronoDateTimeUtc(string): ParsedDateTime | null`，
  对应锁定 chrono0.4.41 的 `DateTimeVisitor` → `FromStr` → `parse_rfc3339_relaxed` → UTC。
  分支来源见 `migration/spec/F4-security.md` WP-007；上游原测试全文对照与未覆盖的非UTC/Debug
  子断言见 `host/platform/TESTMAP.md` WP-007，不把部分上游 corpus 计作整条项目测试 ported。
- 真实公开 api/index 回归：`host/platform/time/tests/chrono-serde.test.ts:6,24,34,45,79,92,112,134,156`。
  job `20261105141252-ed4f55`：新9 + 旧13 = **22 passed / 0 failed / 0 skipped / exit0 / 无Errors**。
  测试先于实现，初次 job `20261105140951-19a4d2` 因公开符号缺失 **9 failed / exit1**。
- 本包没有修改任何 generated 去向：pending **12 → 12**，245 ported / 34 merged / 9 obsolete。
  L19 OAuth持久化的生产接入由消费者后续完成；供方发布不代签 `auth.rs:212-219` 整条读取链。

按 `docs/dev/electron-migration/decisions.md`「共享 crate 的测试归属」与 `host/platform/TESTMAP.md`
第 145–146 行，以下 pending 行**不属于 F4 自有代码**，随使用方 lane 迁移，F4 不重复实现：

- `crates/dstu-core/src/{spaced_repetition,canonical_tools,agent,prompt_contracts,error_recovery,workflow_error_handler,lib,models}.rs`
  ——共享领域类型/纯函数，随使用方 lane；
- `crates/dstu-util/src/{utf8_stream,sse_buffer}`（28 个）——C2 于 2026-11-04 确认归 F4，已收敛为
  `host/platform/util/sse-buffer.ts` 单一共享实现，28 条原名测试在 `util/tests/sse-buffer.test.ts`；
  L01/L02 的本地副本待改用该入口。`chat_query` 3 条按 `obsolete:zero-production-callers` 计 B。
- `crates/dstu-util/src/utils/model_special_tokens.rs`（17 个）——C2 于 2026-11-04 确认归 F4；
  已由 F4 实现并发布到 `host/platform/util/{api,index,model-special-tokens}.ts`，17 条测试移植到
  `host/platform/util/tests/model-special-tokens.test.ts`。L02 选择策略、L01/L03 消费，不再复制策略。
- `tests/cloud_half_configured_credentials_tests.rs`（5 个）——已由 F4 用 L23 已发布的
  `host/plugins/sync-providers/api.ts` `validateConfig` 与真实插件的 `ctx.syncProvider.createStorage`
  移植到 `host/platform/errors/tests/cloud-half-configured.test.ts`（含网络 I/O 前 fail-closed 计数断言）。

`crates/dstu-core/src/task_objects.rs` 已由 F4 通过 L07 的 `agent-skills/api.ts` 覆盖 16 个；
`dstu-core/src/events.rs` 1 个通过 L04 的 `chat/api.ts` 覆盖；剩余 9 个 task_objects
（BatchManifest/CorpusManifest/serde legacy）见上方 BLOCKERS。

`dstu-util/src/utils/fetch.rs` 的 5 个 SSRF 测试已由 F4 移植到
`host/platform/net-policy/tests/fetch-policy.test.ts`；`dstu-util/src/qr.rs` 并入 F1 的
`host/kernel/tests/plugins.test.ts`（同一 PNG 签名与长度断言）。

`dstu-util/src/utils/token_budget.rs` 的 4 条已由 F7 编写并随 main `0ed7917b8` 可见于
`host/platform/native/tests/tokenizer.test.ts`：200K 原“数”用例的 <5 秒预算与 100K..400K 范围保留，
真实 Rust/WASM BPE 实测约 494ms；120K 多样文本的 ratio 0.8..1.25 断言也保留。当前阻塞不是算法性能，
原根依赖阻塞已由 D11/main `fb463060d` 正式解除。F4 定向执行原剩余 2 用例
（job `20261104165839-630b72`）：2 passed / exit 0，另外 7 skipped 为标题过滤、不把它们当通过。
200K 数原输入/<5 秒/100K..400K 与 120K 原混排文本/ratio 0.8..1.25 逐断言不变，
生产路径 `native/index.ts:50` 提供 `nativeTokenizer`，两行现映射为 merged。

F4 自有测试中两条 SecretPromptStore 的旧 ported 仅有测试内 insert/consume，已按 C2 正常 main
审批 `e4680aa8a` 限定为 obsolete:dead-in-rust disabled-entry（实现/原断言保留，见下方说明）；
其余原标记不因本说明自动获得 v2 全域签收。

canonical 8 条去重说明：删除的 `host/platform/errors/tests/canonical-tools.test.ts` 为 3 个测试 /
9 个断言（round-trips invalid 3、preserves valid 2、reencodes reserved 4），对应 L03
`chat-pipeline/tests/canonical-tools.test.ts` 的前 3 个原名测试。L03 用 7 个显式断言 + 2 处
`encoded!` 解引用失败覆盖了全部 9 个原断言（`not.toBeNull` 由解引用/后续断言隐式覆盖），且
L03 经 `chat-pipeline/api.ts` → `src/canonical-tools.ts` 生产导出，`index.ts` 的
`encodeToolNameForApi`/`decodeToolNameFromApi` 服务直接可达；F4 不再维护重复 fixture。

prompt 2 条去重说明：删除的 `host/platform/util/tests/prompt-contracts.test.ts` 为 1 个测试 /
4 个断言（`latex_output_brief_is_consistent_with_full_rules`：中英 `LATEX_OUTPUT_BRIEF`/`_EN`
各 2 条 `toContain`）。同名同断言的用例已在 main 的 L03
`chat-pipeline/tests/prompt-contracts.test.ts` 中逐条保留（`latex_rules_contains_core_constraints`
另含 4 条 `toContain` 与 `buildSystemPrompt` 生产集成断言）；TESTMAP 的
`latex_rules_contains_core_constraints` / `latex_output_brief_is_consistent_with_full_rules`
两行均指向该 L03 `merged:` 目标，不指向已删除文件，无虚报。

## BLOCKERS（跨 lane 接口，证据到符号）

按 `docs/dev/electron-migration/decisions.md:32-33`，共享 crate 测试随消费 lane 迁移；以下 12 行
不是 F4 自有实现，缺的是消费 lane 的**真实生产可达性**或 F7/F6 的能力。本轮复核 main
`0ed7917b8`（2026-11-05，已在本 lane 合并树）中的 API/调用点与原断言；历史已解除的 62 条
（cloud 5 + canonical 8 + LaTeX 2 + model_special_tokens 17 + models 1 + utf8/sse 28 + F1 1）不再列入。

| 剩余测试 | 行数 | 消费 lane | 缺什么（具体符号 / 文件） |
|---|---:|---|---|
| dstu-core/src/agent.rs | 2 | L04 | main 已有 message-values 及 ToolScope/worker-grant 公开实现；ToolScope 序列化一条已经真实 factory 移植解除。剩余 message block 构造/append/success 函数虽然公开并挂到 chatSession，但全 host 直接调用目前只在测试，不能只凭导出关闭；ToolResultInfo payload stripping 仍缺公开值操作面。 |
| dstu-core/src/prompt_contracts.rs | 1 | L18/L14（C1 协调） | main 中 L18 `llm-structurer-service.ts:139` / `vlm-grounding-service.ts:293`、L14 `question-import-legacy.ts:249` 已有实际 prompt 消费，但引用本地副本。F4 现发布 `util/api.ts::DIFFICULTY_RUBRIC` 与原名测试/逐字源对照；待 owner 正常 main 后切换到共享出口并复验 prompt，仍保持 pending，不把导出单独记 ported。 |
| dstu-core/src/spaced_repetition.rs | 5 | L15 | main 已含 SM-2 API 与 15 条原名测试，10 条生产可达映射已解除；尚余 `test_review_quality_from_u8` / `test_review_quality_is_passing` / `test_is_due_for_review` / `test_days_overdue` / `test_advanced_api`，对应 helper 没有从生产 index/register/provide 的真实调用证据。不能仅凭 API 导出或其余 10 条可达来关闭。 |
| dstu-core/src/task_objects.rs | 4 | L07/L04 | 新 main 的 L04 附件分页命令已消费公共 buildCorpusManifest/validateCorpusManifest/modelNotice，五条精确映射解除，见下方最新证据。剩 incomplete_batch 仍用 L05 本地副本；derived_edge 序列化测试仍用对象字面量而非公共值构造；schema_v1 的完整生产链证据待续审；分页原测试含 deserializeCorpusManifest roundtrip，当前 decoder 仍仅测试调用，不能随 builder 接线整体关闭。 |

L07 9 条逐 ID 核对（main `ec3921030` / 分支 `c8db359ad` 的 `tests/task-objects-manifests.test.ts`）：
`incomplete_batch_cannot_claim_complete_success`（Rust 仅断言不完整批次为 false；分支还覆盖完整/重复 item）、
`derived_edge_serializes_v2_and_reads_legacy_string`（v2 JSON 字段与 v1 纯字符串升级）、
`schema_v1_handle_with_string_lineage_still_validates`（v1 lineage + 未来版本拒绝）、
`corpus_manifest_paginates_without_dropping_any_file`、`..._keeps_same_name_files_as_distinct_entries`、
`..._dedupes_repeated_refs_and_keeps_ref_count`、`..._notice_states_totals_and_readback_path`、
`..._pages_are_snapshot_immutable_after_source_change`、`..._validate_rejects_bad_shape`。
此段为首次核对记录：九条均有原名测试，但仅导出不足以标记。新 main 的五条生产调用闭合见下文；其余四条继续 pending。

2026-11-05 新 main `23c679e40` 的真实消费闭合（仅五条）：
- `chat/index.ts:185-194` → `stage-context-command.ts:11-13` 注册真实
  `chat_v2_stage_context_attachments` → `attachment-stage.ts:649-650/598-628` →
  正式 `agent-skills/api.ts::{buildCorpusManifest,corpusManifestModelNotice}`；builder
  `task-objects.ts:300` 再调用 `validateCorpusManifest`，非本地 objects.ts 副本。
- 原 Rust :1517-1672 对应 TS :150-259：同名不同handle、重复引用3/1及总数4、notice八项、
  快照内容/旧新handle与不同manifest、七种坏shape的原断言逐条保留；不改被测实现或测试。
- job `20261105114147-b5f72c`：上述五原测试及真实 kernel 分页产物回归
  `chat/tests/stage-context-attachments.test.ts::paginates above MAX_AUTO_STAGE_ITEMS into a corpus manifest under artifacts`
  共6 passed / 27仅标题过滤skip / exit0，无Errors。命令回归检查真实产物页数/文件内容/hash/notice，
  不是用helper suite单独冒充生产消费；不授附件全域或Corpus decoder完整签收。
- 当前去向计数：245 ported / 34 merged / 9 obsolete / 12 pending；generated header不手改。

L15 15 条原测试核对（main `0ed7917b8` 的 `tests/spaced-repetition.test.ts`）：16 例中 15 例标题含
Rust 原名，逐条断言对齐 `spaced_repetition.rs::tests`；`test_review_failed` 额外断言
`ef === 2.0`、`test_review_quality_is_passing` 额外断言 `PASSING_GRADE === 3`，均不弱于 Rust；
第 16 例覆盖 `calculateNextReviewTimestamp` / `calculateNextReviewDateFromLast` 两个新增日期辅助。
main `review/index.ts:176-178` → `registerReviewPlanCommands` → `review_plan_process` →
`processReviewImpl`（`review-plan.ts:367,371`）真实调用 `calculateNextReview` / `calculateNextReviewDate`；
前者 `:135` 调用 `calculateEaseFactor`。上述 3 函数覆盖的 10 行已映射到精确 TS 标题，
job `20261104163919-93a437`：16 tests passed / exit 0；其余 5 个只有定义/测试调用的 helper 保持 pending。
这是闭合映射，不代签 L15 整 lane。加入 D11 两条 F7 及 L04 ToolScope、两条 SecretPromptStore 限定审批后的历史计数为245 ported / 29 merged / 9 obsolete / 17 pending；最新五条Corpus闭合计数见上文。
生成 header 的旧快照待 scaffold 刷新，不手改生成统计。

L04 ToolScope 解除证据（main `9b3c18601`）：`workspace-run-agent.ts:546` 调用
`issueWorkerGrant` → `grants.ts:303` 的 `scopesFromAllowedTools` → `toolScopeFromAllowEntry`；
`chat/api.ts:84-87` 正式导出。F4 原名测试从该 API 构造与 Rust `agent.rs:515-523` 相同的 MCP variant，
对真实序列化值保留原单条精确对象断言，不用测试内对象字面量代替被测实现。
job `20261104215522-1879cf`：1 passed / exit 0；不据此关闭同文件另外两条原测试。

### F4 SecretPromptStore 限定 disabled-entry 审批（仅此 2 ID）

- `secret_prompt.rs::tests::handles_are_memory_only_ttl_bound_and_one_shot`：Rust :198-215 的6个断言
  （memory_only/one_shot/!consumer_available/contains/secret相等/再次consume错误）已保留在
  `secrets/tests/commands.test.ts:8-19`；TS insert/consume 只有测试调用，不能以纯 helper 通过计 v2 ported。
- `secret_prompt.rs::tests::purpose_mismatch_consumes_and_zeroizes_entry`：Rust :219-229 的两个断言
  （purpose mismatch错误/entry不存在）保留在 TS :20-25，同样缺 live production 消费。
- Rust `decryptor_integration_available():17-19` 固定 false；submit :143-145 在校验及 :158 insert 前返回，
  consume :99 全仓未见生产 caller。TS `commands.ts:35-40` 只接 contains/discard 与永远拒绝的 submit，
  `secret-prompt.ts:12,19` 的 insert/consume 没有生产 caller。真实 kernel 测试仍验证固定不可用返回，
  不改变这条当前行为，也不为测试激活未来解密功能。
- C2 在 `migration/approvals.d/C2-platform.json` 的 `e4680aa8a` 批准 **dead-in-rust disabled-entry**，
  现已确认该提交为正常 main 祖先并合入本树，才更新两行。Rust :158 **仍有被固定 false 挡住的源码调用点**，
  不称整个模块零源码 caller。未复制审批、未改 Rust/原 TS 断言、不 skip、不启用禁用功能。
  审批不豁免四命令的拒绝顺序/status/discard/capabilities 或仍可达的 SecretValue::Drop，
  不授 JS 不可变字符串的物理清零等价。此为当时17 pending历史；最新12 pending见BLOCKERS，Value联合类型已由后续完整owner闭包解除，不回写为此审批的贡献。

F1 `app_version_is_injected_from_app_manifest` 已解除（main `e60e7a771` 包含 `1b3cedeaa`）：
- 目标：`merged:host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest`
  （main `host/kernel/connection.test.ts:130` 正式可见）。
- 断言：读取真实 `src-tauri/Cargo.toml` 的 `[package] version`，非空/≠ `"0.0.0"`；`serveHost`
  handshake 后 `runtime.app.version` 与 `ctx.app.version` 等于输入。C2 亲取 job
  `20261104072840-0fec1d` 4 tests exit 0，无 Errors。
- 不另测三 manifest 一致性，不恢复孤立 `APP_VERSION` 常量。

F4 已完成的部分：`fetch.rs` 5 个 SSRF 测试 → `net-policy/tests/fetch-policy.test.ts`；`qr.rs` → F1
`host/kernel/tests/plugins.test.ts`；`task_objects.rs` 16 个 → `util/tests/task-objects.test.ts`；
`token_budget.rs` 2 个 → F7 `native/tests/tokenizer.test.ts`；`events.rs` 1 个 →
`util/tests/shared-events.test.ts`；`model_special_tokens.rs` 17 个 →
`util/tests/model-special-tokens.test.ts`（F4 自有实现，经 `host/platform/util/model-special-tokens.ts` 生产代码）；
`utf8_stream.rs` 8 + `utils/sse_buffer.rs` 20 个 → `util/tests/sse-buffer.test.ts`
（F4 单一共享实现，经 `host/platform/util/sse-buffer.ts` 生产代码；L01/L02 待改用该平台入口）。
`extractStreamDataPayload` 按 Rust `trim_end_matches('\r')` 删除行尾全部 CR（单/多 CR、多行混合、
正文内部 CR 向量已加入测试）。SSE logger 已由生产 `dstu.platform.log` 插件在 apply 时绑定 target `dstu_util::utils::sse_buffer`
（`log/tests/sse-logger.test.ts`），不是仅测试注入。生产默认接线仍需 L02 在构造流式适配器时
注入 `create_model_wrap_token_filter`；L03 的 `identityWrapTokenFilter` 仅作禁用路由默认值
（跨 lane，F4 不改对方文件）。

## 接线说明（跨 lane）

`migration:wiring` 只扫描 `host/plugins/*/TESTMAP.md`，F4 是平台 lane（代码在 `host/platform/`），
因此该命令对本 lane 恒为 `ported 0`。F4 的插件入口已补齐：
`secrets/index.ts`、`settings/index.ts`、`settings/backup-commands.ts`、`log/index.ts`、`paths/index.ts`、
`diagnostics/index.ts`、`errors/index.ts`（云配置命令）。

生产 profile 已包含全部平台入口：`host/profiles/generate.ts` 现在先扫描
`host/platform/*/index.ts`，`host/profiles/desktop.json` 已列出 `dstu.platform.{diagnostics,cloud-config,log,native,paths,secrets,settings,storage}`；
F4 的 44 条命令随 profile 进入 Host 进程。

`dstu.platform.cloud-config` 插件（`errors/index.ts`）`inject: ['cloudConfig']`；L21 已在
`host/plugins/backup/index.ts:81` `ctx.provide('cloudConfig', …)`（接口见
`host/platform/errors/cloud-config-api.ts`，服务名/版本见 `host/plugins/backup/api.ts:116`），
4 条 `cloud_config_*` 命令在运行时可用。

设备身份接入（P06）：F4 已发布 `ctx.paths.dataSpaceDeviceId()`（`dstu-storage/data_space/device_id.rs`
底层语义）与 `ctx.paths.deviceId()`（commands_sync 旧根优先包装）两个入口，消费方不得复制身份算法。
main 旧树快照里 L11 `host/plugins/vfs-repos/index.ts:134`、L23
`host/plugins/sync-providers/index.ts:161,339` 仍调用 `deviceId()`；该快照**不再作为待办**：
L11 分支 `af77b9365` 已改用 `dataSpaceDeviceId()` 并删 fallback，L23 候选 `da290fd2e` 已直接消费
`paths.dataSpaceDeviceId()`（删除本地 fallback/mirror 桥），其正式消费由 R4 在审。后续不要再次
派 L11/L23 重写该接线；F4 跨 lane 文件不在本 lane 修改。

## obsolete（C2 已批准，ledger 按 B 计）

以下 7 个测试的 Rust 实现只有模块声明/`pub use`，在 `src-tauri` 中**零生产调用方**；
TS 侧移植后不会有生产接线，按 quality.md §3.3 不能计 A，按
`obsolete:zero-production-callers` 处理。C2 已于 2026-11-04 核实批准，批准记录在
`migration/approvals.d/C2-platform.json`；main 已聚合 `approvals.d/`，7 行已标
`obsolete:zero-production-callers`：

| Rust 测试 | 证据 |
|---|---|
| `dstu-core/src/error_recovery.rs::tests::{test_retry_success_after_failures,test_retry_all_failures}` | `RetryExecutor`/`ErrorHandlerConfig` 仅出现在本文件与 `dstu-core/src/lib.rs:19` 的 `pub mod` |
| `dstu-core/src/workflow_error_handler.rs::tests::{test_error_handler_retry,test_circuit_breaker}` | `WorkflowErrorHandler`/`workflow_error!` 仅出现在本文件、`dstu-core/src/lib.rs:35` 与 `src-tauri/src/lib.rs:218` 的 `pub use` |
| `dstu-util/src/utils/chat_query.rs::tests::{test_derive_latest_user_query_from_history,test_derive_latest_user_query_fallback,test_derive_mistake_query}` | `derive_latest_user_query`/`derive_mistake_query` 仅在本文件与其测试中调用；`dstu-util/src/utils/mod.rs:1` 只声明模块 |

**ledger 顺序注意**：`ledger.mjs` 先读业务 lane、后读 F lane 的 TESTMAP；F4 的 `pending`
行会覆盖同一测试 id 在其他 lane 的 `ported:`。上述测试由消费方 lane 移植后，需由协调者把
对应行移出 F4 的 TESTMAP（或让 F4 更新去向列），否则不会计入 A。

## 门禁说明（待共享基础设施修复）

`npm run migration:boundaries:strict` 的 `maySql` 只放行 `host/plugins/<lane>/repository/` 与
`host/platform/storage/`，因此会对 `host/platform/diagnostics/repository/debug.ts` 报 10 条
`sql-outside-repository`。该文件确实位于 `repository/` 且全是只读统计 SQL；为满足 strict 门禁，
每一处都加了理由属实的 `boundary-allow`（平台诊断只读统计，repository/）。等扫描器放宽到所有
`repository/` 目录后应删除这些豁免（F4 lane 无权修改 `scripts/`）。其余 strict 违规来自其他 lane。
