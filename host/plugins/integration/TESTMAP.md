# L22-app-commands 测试去向（`host/plugins/integration`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L22-app-commands：243 行（真实测试 243）· merged 4 · obsolete 53 · pending 29 · ported 157
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `src/commands.rs::tests::ollama_root_base_url_lists_models_under_v1` | test | L5346 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::compare_template_version_handles_semver_like_versions` | test | L5361 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::compare_template_version_tolerates_non_standard_versions` | test | L5372 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::builtin_import_skips_user_deleted_templates` | test | L5382 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::builtin_import_skips_user_modified_templates` | test | L5400 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::builtin_import_updates_untouched_templates_by_version` | test | L5410 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::extract_template_field_refs_handles_conditionals_filters_and_specials` | test | L5481 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::validate_template_request_rejects_cloze_without_placeholder` | test | L5497 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::validate_template_request_accepts_valid_cloze_and_basic_templates` | test | L5512 | ported:host/plugins/anki/tests/templates.test.ts |
| `src/commands.rs::tests::chat_probe_body_uses_completion_tokens_for_reasoning_models` | test | L5528 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::chat_probe_body_keeps_max_tokens_for_plain_models` | test | L5548 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::chat_probe_body_disables_thinking_for_qwen_reasoning` | test | L5563 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::chat_probe_body_respects_mimo_dialect` | test | L5583 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::chat_probe_body_routes_gpt5_official_to_responses_dialect` | test | L5602 | ported:host/plugins/llm/tests/connection_test.test.ts |
| `src/commands.rs::tests::classify_probe_http_failure_maps_status_codes` | test | L5631 | ported:host/plugins/llm/tests/connection_test.test.ts |
| `src/commands.rs::tests::classify_probe_http_failure_redacts_credentials_in_body` | test | L5653 | ported:host/plugins/llm/tests/connection_test.test.ts |
| `src/commands.rs::tests::probe_u32_field_reads_common_provider_shapes` | test | L5666 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::inspect_probe_buffer_judges_sse_events` | test | L5717 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::inspect_probe_buffer_judges_non_sse_responses` | test | L5774 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::test_model_kind_prefers_flags_then_heuristics` | test | L5795 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::asr_models_route_to_asr_probe` | test | L5832 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::chat_models_do_not_route_to_asr_probe` | test | L5856 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::asr_heuristic_excludes_tts_and_speech_synthesis` | test | L5878 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::build_asr_probe_wav_is_valid_mono_16k` | test | L5893 | ported:host/plugins/integration/tests/llm-probe-helpers.test.ts |
| `src/commands.rs::tests::codex_connection_test_prefers_persisted_vendor_authentication` | test | L5904 | ported:host/plugins/integration/tests/llm-codex-connection.test.ts |
| `src/commands.rs::tests::codex_connection_test_supports_unsaved_oauth_context` | test | L5932 | ported:host/plugins/integration/tests/llm-codex-connection.test.ts |
| `src/commands.rs::tests::temp_session_cap::under_cap_is_noop` | test | L5979 | ported:host/plugins/integration/tests/app-state.test.ts |
| `src/commands.rs::tests::temp_session_cap::evicts_oldest_by_created_at` | test | L5995 | ported:host/plugins/integration/tests/app-state.test.ts |
| `src/commands.rs::tests::temp_session_cap::evicts_multiple_when_far_over_cap` | test | L6011 | ported:host/plugins/integration/tests/app-state.test.ts |
| `src/commands.rs::tests::temp_session_cap::equal_timestamps_fall_back_to_lexicographic_id` | test | L6029 | ported:host/plugins/integration/tests/app-state.test.ts |
| `tests/app_command_acl.rs::app_acl_blocks_remote_browser_content_and_allows_local_main` | test | L29 | ported:host/plugins/integration/tests/app-command-acl.test.ts |
| `tests/generative_ui_executor_e2e.rs::hpias_event_channel_matches_frontend_contract` | test | L118 | merged:host/plugins/memory/tests/hpias.test.ts::channel_matches_frontend_contract |
| `tests/generative_ui_executor_e2e.rs::execute_with_default_backend_keeps_research_blocks_static` | tokio::test | L123 | pending |
| `tests/generative_ui_executor_e2e.rs::execute_with_research_session_emits_hpias_session_started` | tokio::test | L167 | pending |
| `tests/generative_ui_executor_e2e.rs::execute_hpias_stub_pipeline_emits_plan_generated` | tokio::test | L235 | pending |
| `tests/generative_ui_executor_e2e.rs::execute_emits_generative_ui_start_chunk_end_events` | tokio::test | L289 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/generative_ui_executor_e2e.rs::execute_v1_1_grid_layout_emits_generative_ui` | tokio::test | L360 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/generative_ui_executor_e2e.rs::execute_rejects_version_2` | tokio::test | L447 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/generative_ui_executor_e2e.rs::execute_rejects_unknown_block_type` | tokio::test | L493 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/generative_ui_executor_e2e.rs::execute_rejects_too_many_blocks` | tokio::test | L542 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/generative_ui_executor_e2e.rs::execute_with_note_edit_preserves_input_payload` | tokio::test | L594 | ported:host/plugins/integration/tests/generative-ui-executor-e2e.test.ts |
| `tests/mod.rs::integration::run_all_core_tests` | tokio::test | L14 | ported:host/plugins/integration/tests/tools-registry.test.ts |
| `tests/sync_r10_android.rs::content_uri_and_saf_paths_classify_as_virtual` | test | L59 | ported:host/plugins/integration/tests/android-saf.test.ts |
| `tests/sync_r10_android.rs::double_encoded_content_uri_is_not_classified_virtual` | test | L103 | ported:host/plugins/integration/tests/android-saf.test.ts |
| `tests/sync_r10_android.rs::rust_side_must_queue_content_uri_for_main_activity_persist` | test | L117 | ported:host/plugins/integration/tests/android-saf.test.ts |
| `tests/sync_r10_android.rs::saf_document_id_resolves_to_real_file_name_and_extension` | test | L138 | obsolete:mobile-only extract_extension 仅用于 ensure_local_path 的 Virtual/content:// 分支（src-tauri/crates/dstu-storage/src/unified_file_manager.rs:1079），F3 未发布该函数 |
| `tests/sync_r10_android.rs::opaque_document_ids_are_detected` | test | L164 | obsolete:mobile-only Android document ID 启发式（src-tauri/crates/dstu-storage/src/unified_file_manager.rs:991-1003；src-tauri/src/cmd/textbooks.rs:176），F3 未发布该函数 |
| `tests/sync_r10_android.rs::file_name_sanitization_replaces_unsafe_characters_only` | test | L182 | obsolete:mobile-only SAF 物化/落盘文件名清洗（src-tauri/crates/dstu-storage/src/unified_file_manager.rs:979-989,1024-1043），F3 未发布该函数 |
| `tests/sync_r10_android.rs::legacy_sanitizer_preserves_content_uri_encoding_but_decodes_local_paths` | test | L204 | ported:host/plugins/integration/tests/android-saf.test.ts |
| `tests/sync_r10_android.rs::zip_command_materialization_orchestration_is_anchored` | test | L239 | obsolete:mobile-only content:// ZIP 物化编排（src-tauri/src/data_governance/commands_zip.rs:1232-1234 的 is_virtual_uri 分支），真机 Window<Wry> 不可宿主执行 |
| `tests/sync_r10_android.rs::restart_command_shell_registration_and_ordering_are_anchored` | test | L361 | ported:host/plugins/integration/tests/restart-ordering.test.ts |
| `tests/sync_r10_android.rs::lease_activation_commit_requires_matching_backup_id_and_active_dir` | test | L406 | ported:host/plugins/integration/tests/data-space-cutover.test.ts |
| `tests/sync_r10_android.rs::rollback_trash_of_old_slot_survives_cutover_restart` | test | L481 | ported:host/plugins/integration/tests/data-space-cutover.test.ts |
| `tests/sync_r10_chaos_clock.rs::r10_chaos_slow_clock_update_loses_lww_and_lands_in_conflicts` | test | L156 | ported:host/plugins/integration/tests/sync-chaos-clock.test.ts |
| `tests/sync_r10_chaos_clock.rs::r10_chaos_clock_rollback_same_device_cannot_overwrite_newer_state` | test | L212 | ported:host/plugins/integration/tests/sync-chaos-clock.test.ts |
| `tests/sync_r10_chaos_clock.rs::r10_chaos_fast_clock_far_future_update_quarantined_not_applied` | test | L265 | ported:host/plugins/integration/tests/sync-chaos-clock.test.ts |
| `tests/sync_r10_chaos_clock.rs::r10_chaos_rollback_delete_loses_lww_and_tombstone_timestamp_validation` | test | L317 | ported:host/plugins/integration/tests/sync-chaos-clock.test.ts |
| `tests/sync_r10_chaos_idempotent.rs::r10_chaos_upload_retry_storm_collapses_before_apply` | tokio::test | L188 | ported:host/plugins/integration/tests/sync-chaos-idempotent.test.ts |
| `tests/sync_r10_chaos_idempotent.rs::r10_chaos_reapply_same_batch_after_crash_is_idempotent` | tokio::test | L259 | ported:host/plugins/integration/tests/sync-chaos-idempotent.test.ts |
| `tests/sync_r10_chaos_idempotent.rs::r10_chaos_committed_cursor_prevents_reconsumption` | tokio::test | L316 | ported:host/plugins/integration/tests/sync-chaos-idempotent.test.ts |
| `tests/sync_r10_chaos_lease.rs::r10_chaos_lease_pointing_at_inactive_slot_refuses_boot_and_keeps_lease` | test | L30 | ported:host/plugins/integration/tests/data-space-cutover.test.ts |
| `tests/sync_r10_chaos_lease.rs::r10_chaos_tampered_lease_backup_id_blocks_commit_and_release` | test | L85 | ported:host/plugins/integration/tests/data-space-cutover.test.ts |
| `tests/sync_r10_chaos_mixed_e2ee.rs::r10_chaos_midstream_plaintext_downgrade_fails_closed` | tokio::test | L252 | ported:host/plugins/integration/tests/sync-chaos-mixed-e2ee.test.ts |
| `tests/sync_r10_chaos_mixed_e2ee.rs::r10_chaos_no_password_client_stops_at_encrypted_shard` | tokio::test | L283 | ported:host/plugins/integration/tests/sync-chaos-mixed-e2ee.test.ts |
| `tests/sync_r10_chaos_mixed_e2ee.rs::r10_chaos_wrong_password_client_fails_closed_at_first_shard` | tokio::test | L307 | ported:host/plugins/integration/tests/sync-chaos-mixed-e2ee.test.ts |
| `tests/sync_r10_chaos_mixed_e2ee.rs::r10_chaos_removing_injected_plaintext_restores_full_consumption` | tokio::test | L334 | ported:host/plugins/integration/tests/sync-chaos-mixed-e2ee.test.ts |
| `tests/sync_r10_chaos_truncation.rs::r10_chaos_honest_list_truncation_flag_fails_closed` | tokio::test | L221 | ported:host/plugins/integration/tests/sync-chaos-truncation.test.ts |
| `tests/sync_r10_chaos_truncation.rs::r10_chaos_silent_truncation_hiding_earlier_seq_stops_at_safe_point` | tokio::test | L251 | ported:host/plugins/integration/tests/sync-chaos-truncation.test.ts |
| `tests/sync_r10_chaos_truncation.rs::r10_chaos_silent_truncation_hiding_tail_seq_does_not_lose_data` | tokio::test | L293 | ported:host/plugins/integration/tests/sync-chaos-truncation.test.ts |
| `tests/sync_r10_download.rs::get_file_without_checksum_rejects_half_package` | tokio::test | L256 | ported:host/plugins/integration/tests/sync-download-defaults.test.ts |
| `tests/sync_r10_download.rs::get_file_with_consistent_size_succeeds` | tokio::test | L277 | ported:host/plugins/integration/tests/sync-download-defaults.test.ts |
| `tests/sync_r10_download.rs::get_file_rejects_object_replaced_with_larger_version` | tokio::test | L295 | ported:host/plugins/integration/tests/sync-download-defaults.test.ts |
| `tests/sync_r10_download.rs::whole_file_download_path_fails_closed_on_half_package` | tokio::test | L319 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r10_download.rs::resumable_download_rejects_same_size_object_swap_via_sha256` | tokio::test | L355 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r10_download.rs::import_password_gate::every_import_entry_fails_early_without_password` | test | L478 | merged:host/plugins/backup/tests/portable-precheck.test.ts::no_password_is_left_to_existing_missing_password_gate |
| `tests/sync_r10_protocol_locks.rs::p2_2_structurally_invalid_kdf_params_fail_closed` | test | L68 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_protocol_locks.rs::p2_2_marker_kdf_params_are_honored_not_clamped_to_default` | test | L90 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_protocol_locks.rs::p2_2_kdf_cost_upper_bound_now_enforced` | test | L109 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_protocol_locks.rs::p2_3_resolve_fast_path_business_row_recheck_now_in_transaction_source_lock` | test | L152 | ported:host/plugins/integration/tests/sync-conflict-fast-path.test.ts |
| `tests/sync_r10_protocol_locks.rs::p2_1_marker_upgrade_unlock_guide_doc_lock` | test | L207 | ported:host/plugins/integration/tests/frontend-source-locks.test.ts |
| `tests/sync_r10_protocol_locks.rs::r01_p2_filename_length_is_clamped_fail_closed` | test | L232 | merged:host/plugins/sync/tests/asset-filenames.test.ts::segment_and_total_path_limits_fail_closed_without_truncation |
| `tests/sync_r10_provider_contract.rs::swapped_smaller_object_between_stat_and_get_fails_closed` | tokio::test | L195 | ported:host/plugins/integration/tests/webdav-contract.test.ts |
| `tests/sync_r10_provider_contract.rs::swapped_larger_object_between_stat_and_get_fails_closed` | tokio::test | L225 | ported:host/plugins/integration/tests/webdav-contract.test.ts |
| `tests/sync_r10_provider_contract.rs::truncated_stream_is_an_error_not_a_success` | tokio::test | L254 | ported:host/plugins/integration/tests/webdav-contract.test.ts |
| `tests/sync_r10_provider_contract.rs::consistent_download_succeeds_with_correct_bytes_and_checksum` | tokio::test | L283 | ported:host/plugins/integration/tests/webdav-contract.test.ts |
| `tests/sync_r10_verifier.rs::legal_default_params_still_pass` | test | L175 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_verifier.rs::legal_legacy_params_still_execute` | test | L190 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_verifier.rs::limits_cover_default_write_surface` | test | L199 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_verifier.rs::oversized_params_rejected_before_derivation` | test | L214 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_verifier.rs::dsbk_decrypt_rejects_oversized_kdf_params_before_derivation` | test | L248 | ported:host/plugins/integration/tests/crypto-verifier.test.ts |
| `tests/sync_r10_verifier.rs::upload_precheck_oversized_params_fails_closed_without_write` | tokio::test | L277 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r10_verifier.rs::deleted_marker_does_not_allow_plaintext_upload_from_this_machine` | tokio::test | L338 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r10_verifier.rs::deleted_marker_bool_policy_entry_also_rejected` | tokio::test | L403 | ported:host/plugins/integration/tests/sync-manager-extra.test.ts |
| `tests/sync_r10_verifier.rs::memory_is_scoped_per_cloud_root` | tokio::test | L424 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r10_verifier.rs::plaintext_rejection_backfills_local_memory` | tokio::test | L452 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_manual_mutex_try_acquire_fails_closed_and_recovers` | test | L47 | ported:host/plugins/integration/tests/sync-autosync-mutex.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_run_sync_commands_use_immediate_try_acquire` | test | L106 | ported:host/plugins/integration/tests/frontend-source-locks.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_failclose_markers_stay_in_sync_across_layers` | test | L135 | ported:host/plugins/integration/tests/frontend-source-locks.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_interval_tiers_and_default_off_are_pinned` | test | L183 | ported:host/plugins/integration/tests/frontend-source-locks.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_settings_ui_exposes_tiers_and_last_run_status` | test | L223 | ported:host/plugins/integration/tests/frontend-source-locks.test.ts |
| `tests/sync_r11_autosync.rs::r11_autosync_locale_zh_en_autosync_subtrees_are_aligned` | test | L266 | ported:host/plugins/integration/tests/frontend-contracts.test.ts |
| `tests/sync_r11_history.rs::r11_policy_override_snapshots_local_row_before_overwrite` | test | L236 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_local_win_does_not_snapshot` | test | L256 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_snapshot_dedup_within_batch_keeps_first_state` | test | L282 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_rollback_restores_record_and_leaves_pending_upload` | test | L321 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_rollback_not_reoverwritten_by_lww_replay_or_echo_suppression` | test | L382 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_rollback_beats_accepted_future_skewed_cloud_winner` | test | L438 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_delete_overwrite_rollback_resurrects_then_undo_deletes_again` | test | L552 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_retention_caps_batches_and_prunes_oldest` | test | L599 | ported:host/plugins/integration/tests/sync-history-behavior.test.ts |
| `tests/sync_r11_history.rs::r11_resolve_command_snapshots_and_new_commands_browse_and_rollback` | test | L711 | ported:host/plugins/integration/tests/sync-history-e2e.test.ts |
| `tests/sync_r11_lease.rs::concurrent_devices_elect_exactly_one_committed_holder` | tokio::test | L192 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::live_lease_returns_stable_code_and_retry_guidance` | tokio::test | L230 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::lease_left_by_this_device_reports_self_and_is_not_preempted` | tokio::test | L251 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::expired_committed_lease_is_reclaimed_before_acquire` | tokio::test | L273 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::crash_pending_residue_blocks_until_ttl_then_recovers` | tokio::test | L296 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::truncated_lease_listing_fails_closed` | tokio::test | L331 | ported:host/plugins/integration/tests/sync-lease.test.ts |
| `tests/sync_r11_lease.rs::remote_format_gate_rejects_future_version_before_lease_write` | tokio::test | L346 | ported:host/plugins/integration/tests/sync-format-gate.test.ts |
| `tests/sync_r11_lease.rs::lease_held_locale_keys_are_aligned` | test | L392 | ported:host/plugins/integration/tests/frontend-contracts.test.ts |
| `tests/sync_r11_repo_check.rs::healthy_plaintext_repo_reports_all_green` | tokio::test | L346 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::healthy_encrypted_repo_reports_all_green` | tokio::test | L365 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::missing_object_is_reported_with_version_id` | tokio::test | L388 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::corrupted_ciphertext_reports_checksum_and_header_problems` | tokio::test | L422 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::plaintext_object_in_encrypted_repo_is_reported` | tokio::test | L449 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::orphan_object_is_reported_and_check_stays_read_only` | tokio::test | L474 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::corrupt_manifest_is_reported_without_aborting_check` | tokio::test | L521 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::truncated_listing_never_reports_all_green` | tokio::test | L542 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::truncated_manifests_listing_suppresses_orphan_false_positives` | tokio::test | L568 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::resumable_provider_retries_from_partial_and_reports_green` | tokio::test | L591 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r11_repo_check.rs::exhausted_resumable_retries_stay_incomplete` | tokio::test | L608 | ported:host/plugins/integration/tests/repo-check.test.ts |
| `tests/sync_r12_backup_lease.rs::concurrent_devices_elect_exactly_one_committed_holder` | tokio::test | L210 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::live_lease_returns_stable_backup_code_and_retry_guidance` | tokio::test | L259 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::expired_committed_lease_is_reclaimed_before_acquire` | tokio::test | L279 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::crash_pending_residue_blocks_until_ttl_then_recovers` | tokio::test | L302 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::truncated_lease_listing_fails_closed_with_zero_locks` | tokio::test | L337 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::default_ttl_is_ten_minutes_and_namespaces_are_isolated` | test | L359 | ported:host/plugins/integration/tests/backup-lease.test.ts |
| `tests/sync_r12_backup_lease.rs::source_lock_backup_lease_has_zero_production_wiring` | test | L369 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_conflict_fast_path.rs::r12_fast_path_matching_state_still_marks_resolved` | test | L224 | ported:host/plugins/integration/tests/sync-conflict-fast-path.test.ts |
| `tests/sync_r12_conflict_fast_path.rs::r12_fast_path_concurrent_local_edit_is_rejected_in_transaction` | test | L269 | ported:host/plugins/integration/tests/sync-conflict-fast-path.test.ts |
| `tests/sync_r12_decoded_dead.rs::p2_1_get_file_decoded_is_gone_from_src` | test | L51 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_decoded_dead.rs::p2_1_tombstone_comment_survives` | test | L85 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_decoded_dead.rs::p2_1_download_file_object_keeps_antidowngrade_gate` | test | L102 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_delta_format.rs::r12_descriptor_roundtrip_is_lossless` | test | L53 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_repo_config_roundtrip_is_lossless` | test | L71 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_encoded_field_names_are_camel_case` | test | L79 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_future_format_version_is_rejected` | test | L106 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_wrong_format_string_is_rejected` | test | L130 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_parent_or_patch_fields_are_rejected_not_ignored` | test | L141 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_repo_config_refuses_key_material_and_zero_epoch` | test | L159 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_logical_path_traversal_is_rejected` | test | L182 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_object_key_traversal_is_rejected` | test | L203 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_file_count_over_limit_is_rejected` | test | L224 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_path_and_object_key_length_limits_reject_not_truncate` | test | L241 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_duplicate_logical_path_is_rejected` | test | L276 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_logical_size_mismatch_is_rejected` | test | L285 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_invalid_hex_digests_are_rejected` | test | L300 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_format.rs::r12_source_lock_sync_manager_still_uploads_whole_zip` | test | L330 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_delta_gc.rs::r12_gc_keeps_shared_objects_and_reclaims_pruned_snapshot_after_grace` | tokio::test | L398 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_orphan_needs_grace_and_first_seen_is_not_refreshed` | tokio::test | L475 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_truncated_listing_fails_closed` | tokio::test | L557 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_corrupt_descriptor_means_zero_deletes_and_zero_candidates` | tokio::test | L627 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_wrong_password_or_policy_mismatch_means_zero_deletes` | tokio::test | L676 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_held_lease_blocks_both_passes_with_zero_writes` | tokio::test | L730 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_rereferenced_candidate_is_dropped_without_deleting_object` | tokio::test | L776 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_gc_candidate_codec_rejects_unknown_fields_and_out_of_scope_keys` | test | L833 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_gc.rs::r12_source_lock_delta_gc_has_zero_production_wiring` | test | L924 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_delta_inventory.rs::r12_inventory_roundtrip_small_staging` | test | L116 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_zero_change_reuses_everything_except_manifest` | test | L165 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_sqlite_row_change_marks_only_that_file_upload_new` | test | L244 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_diff_marks_deleted_paths` | test | L284 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_logical_path_traversal_and_overlong_are_rejected` | test | L305 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_staging_with_backslash_filename_or_symlink_fails_closed` | test | L341 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_inventory.rs::r12_source_lock_inventory_has_no_production_callers` | test | L367 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_delta_restore.rs::r12_plaintext_roundtrip_restores_every_logical_file` | tokio::test | L383 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_blank_device_id_or_unknown_version_fails_closed` | tokio::test | L427 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_reused_object_version_restores_correctly` | tokio::test | L471 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_e2ee_roundtrip_and_wrong_password_fails_closed` | tokio::test | L533 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_cipher_on_plaintext_repo_fails_closed` | tokio::test | L571 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_missing_object_fails_closed_with_empty_dest` | tokio::test | L595 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_same_size_swapped_object_fails_closed` | tokio::test | L625 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_corrupted_descriptor_or_index_fails_closed` | tokio::test | L661 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_held_lease_blocks_restore_with_zero_storage_writes` | tokio::test | L712 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_compatible_zip_written_only_after_verification` | tokio::test | L746 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_compatible_zip_failure_leaves_no_partial_zip` | tokio::test | L785 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_restore.rs::r12_source_lock_delta_restore_has_zero_production_wiring` | test | L899 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_delta_upload.rs::r12_first_version_uploads_every_logical_file` | tokio::test | L337 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_blank_device_id_fails_closed_with_zero_writes` | tokio::test | L402 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_zero_change_second_version_reuses_all_data_objects` | tokio::test | L420 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_single_file_change_uploads_only_that_file_and_manifest` | tokio::test | L480 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_cross_device_never_reuses_other_devices_objects` | tokio::test | L523 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_index_put_failure_leaves_orphans_but_no_new_version` | tokio::test | L564 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_descriptor_put_failure_leaves_objects_but_no_new_version` | tokio::test | L593 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_held_lease_blocks_publish_with_zero_object_writes` | tokio::test | L621 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_corrupted_index_or_descriptor_fails_closed_without_new_objects` | tokio::test | L652 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_e2ee_encrypts_objects_and_descriptor_with_one_session` | tokio::test | L707 | obsolete:dead-in-rust experimental |
| `tests/sync_r12_delta_upload.rs::r12_source_lock_delta_upload_has_zero_production_wiring` | test | L815 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::new_upload_object_name_contains_no_time_or_device` | tokio::test | L170 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::new_client_downloads_legacy_timestamp_object` | tokio::test | L199 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::legacy_style_reader_can_fetch_new_object_by_manifest_id` | tokio::test | L223 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::mixed_directory_upload_download_prune_and_delete` | tokio::test | L253 | ported:host/plugins/integration/tests/sync-manager-extra.test.ts |
| `tests/sync_r12_neutral_names.rs::legacy_device_manifest_migrates_on_save` | tokio::test | L314 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::new_marker_created_by_device_is_short_hash` | tokio::test | L349 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_neutral_names.rs::upgrade_preserves_raw_legacy_created_by_device` | tokio::test | L358 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_record_path_names.rs::new_upload_uses_hashed_change_and_manifest_names` | tokio::test | L195 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::new_client_reads_legacy_raw_change_and_manifest` | tokio::test | L242 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::download_skips_own_hashed_change_and_manifest` | tokio::test | L270 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::upload_manifest_migrates_legacy_raw_name` | tokio::test | L311 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::mixed_raw_and_hashed_shards_are_one_device_stream` | tokio::test | L341 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::hashed_payload_device_id_still_full_and_readable` | tokio::test | L378 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_record_path_names.rs::upload_manifest_fails_when_reread_mismatches` | tokio::test | L435 | ported:host/plugins/integration/tests/sync-record-path-names.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_empty_root_v1_marker_still_upgrades_with_first_password` | tokio::test | L212 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_correct_password_upgrades_after_trial_decrypt_of_existing_backup` | tokio::test | L257 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_wrong_password_cannot_claim_root_with_existing_backups` | tokio::test | L305 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_backup_download_failure_keeps_v1_marker_untouched` | tokio::test | L358 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_truncated_backup_object_blocks_upgrade` | tokio::test | L399 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_plaintext_legacy_backup_blocks_upgrade` | tokio::test | L434 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_wrong_password_cannot_claim_markerless_v0944_encrypted_root` | tokio::test | L472 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r12_v1_marker_trust.rs::r12_markerless_plain_zip_can_start_new_encrypted_chain` | tokio::test | L510 | ported:host/plugins/integration/tests/sync-r12-locks.test.ts |
| `tests/sync_r13_migration_change_log_propagation.rs::v20260824_normalization_updates_enter_change_log_as_pending` | test | L87 | ported:host/plugins/integration/tests/sync-migration-change-log.test.ts |
| `tests/sync_r13_migration_change_log_propagation.rs::v20260824_null_source_tombstone_sweep_enters_change_log` | test | L202 | ported:host/plugins/integration/tests/sync-migration-change-log.test.ts |
| `tests/sync_r13_migration_change_log_propagation.rs::gap_v20260302_folder_items_normalization_never_entered_change_log` | test | L315 | ported:host/plugins/integration/tests/sync-migration-change-log.test.ts |
| `tests/tool_pack_integration_tests.rs::tool_pack_harness_constructs_execution_context` | tokio::test | L381 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths` | test | L394 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_executes_real_builtin_tools_and_returns_one_aggregate` | tokio::test | L442 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_mixed_success_failure_preserves_successful_results` | tokio::test | L494 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_vfs_write_load_does_not_surface_sqlite_busy_or_database_locked` | tokio::test | L535 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_repeated_vfs_write_load_remains_free_of_sqlite_lock_errors` | tokio::test | L569 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_rejects_empty_tools_array` | tokio::test | L600 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_rejects_unknown_specific_tool_before_execution` | tokio::test | L614 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_rejects_recursive_subtool` | tokio::test | L632 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_rejects_more_than_20_subtools` | tokio::test | L650 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_rejects_ask_user_no_timeout_subtool` | tokio::test | L667 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_executes_subtools_concurrently_and_respects_max_concurrency` | tokio::test | L691 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_deadline_cancels_only_unfinished_subtools` | tokio::test | L741 | pending |
| `tests/tool_pack_integration_tests.rs::tool_pack_parent_cancellation_preserves_completed_results` | tokio::test | L784 | pending |
| `tests/tools_integration_tests.rs::test_tool_registry_basic_operations` | tokio::test | L43 | ported:host/plugins/integration/tests/tools-registry.test.ts |
| `tests/tools_integration_tests.rs::test_tool_registry_namespace_functionality` | tokio::test | L57 | ported:host/plugins/integration/tests/tools-registry.test.ts |
| `tests/tools_integration_tests.rs::test_tool_timeout_handling` | tokio::test | L75 | ported:host/plugins/integration/tests/tools-registry.test.ts |
| `tests/tools_integration_tests.rs::test_web_search_tool_with_mock_server` | tokio::test | L89 | ported:host/plugins/integration/tests/tools-provider.test.ts |
| `tests/tools_integration_tests.rs::test_provider_strategies_functionality` | tokio::test | L149 | ported:host/plugins/integration/tests/tools-provider.test.ts |
| `tests/tools_integration_tests.rs::test_provider_strategy_retry_logic` | tokio::test | L169 | ported:host/plugins/integration/tests/tools-provider.test.ts |
| `tests/tools_integration_tests.rs::test_tool_error_details_generation` | tokio::test | L196 | pending |
| `tests/tools_integration_tests.rs::test_mock_http_error_responses` | tokio::test | L219 | merged:host/kernel/tests/error-details.test.ts::test_http_status_to_error_code |
| `tests/windows_shell_helper_e2e.rs::helper_consumes_only_fixed_root_payload_and_executes_with_rewritten_temp` | test | L34 | pending |
<!-- END GENERATED:testmap:rows -->
