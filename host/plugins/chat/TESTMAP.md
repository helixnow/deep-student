# L04-chat-session 测试去向（`host/plugins/chat`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L04-chat-session：527 行（真实测试 527）· pending 174 · ported 334 · obsolete 19（C1 已批准）
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::sanitize_strips_html_comments_and_scripts` | test | L255 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::truncate_applies_6k_budget` | test | L269 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::load_from_temp_workspace_and_budget_truncate` | test | L280 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::out_of_bounds_path_is_rejected` | test | L300 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::missing_agents_md_silently_skipped` | test | L323 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/agents_md.rs::tests::resolve_prefers_workspace_over_global_when_present` | test | L335 | ported:host/plugins/chat/tests/agents-md.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_dedup_hit_converges_to_delivered_without_redelivery` | test | L883 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_missing_workspace_db_and_missing_parent_expire` | test | L918 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_attempt_cap_expires` | test | L977 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_missing_inbox_message_requires_redelivery` | test | L1008 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::no_window_skips_headless_wake_for_active_super_session` | test | L1031 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_envelope_status_mapping` | test | L1153 | ported:host/plugins/chat/tests/completion-dispatcher.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_migration_creates_connector_operations_table` | test | L586 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_system_idempotency_key_is_deterministic_and_binding` | test | L618 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_insert_and_read_roundtrip` | test | L636 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_state_machine_legal_chain` | test | L670 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_state_machine_rejects_illegal_transitions` | test | L707 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_failed_is_terminal` | test | L749 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_reconcile_converts_submitting_to_outcome_unknown` | test | L767 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_outcome_unknown_is_not_committable_in_p0` | test | L816 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_list_pending_reconcile_returns_submitting_and_outcome_unknown` | test | L840 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g04_mark_outcome_unknown_only_from_submitting` | test | L895 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_ledger.rs::tests::g07b_session_side_effect_summary_scopes_pending_by_session` | test | L925 | ported:host/plugins/chat/tests/connector-ledger.test.ts |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_hmac_sha256_matches_rfc4231` | test | L441 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_endpoint_requires_https_except_localhost` | test | L474 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_host_whitelist_is_exact_and_case_insensitive` | test | L486 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_config_is_fail_closed_when_settings_missing` | test | L624 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_submit_success_signs_and_parses_receipt` | tokio::test | L660 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_submit_classifies_status_codes` | tokio::test | L686 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_submit_409_is_dedup_success` | tokio::test | L709 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_submit_oversized_or_non_json_2xx_is_unknown` | tokio::test | L725 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_lookup_three_way_contract` | tokio::test | L750 | pending |
| `crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs::tests::g04_provider_debug_and_errors_never_leak_secret` | tokio::test | L793 | pending |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_database_creation` | test | L420 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_migrations_idempotent` | test | L432 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_get_conn_rejects_maintenance_mode` | test | L475 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_foreign_keys_enabled` | test | L498 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_get_connection` | test | L508 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_get_statistics` | test | L525 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_tables_created` | test | L539 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_session_mistakes_table` | test | L566 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_attachments_block_id_column` | test | L607 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_session_state_extended_columns` | test | L634 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/database.rs::tests::test_cascade_delete` | test | L683 | ported:host/plugins/chat/tests/database-service.test.ts |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::capture_produces_complete_manifest` | test | L686 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::capture_normalizes_multivalue_fields` | test | L714 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::fingerprint_is_deterministic_across_captures` | test | L740 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::fingerprint_ignores_captured_at` | test | L747 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::tool_schema_fingerprint_is_stable_across_calls` | test | L755 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::tool_schema_fingerprint_reacts_to_table_changes` | test | L763 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::diff_detects_each_field_drift` | test | L808 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::skills_diff_reports_added_removed_and_changed` | test | L856 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::set_diff_reports_added_and_removed_deterministically` | test | L888 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::replay_compatibility_passes_when_no_drift` | test | L905 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::replay_compatibility_reports_all_drifts` | test | L914 | pending |
| `crates/dstu-agent/src/chat_v2/environment_manifest.rs::tests::manifest_serializes_camel_case` | test | L938 | pending |
| `crates/dstu-agent/src/chat_v2/error.rs::tests::test_error_display` | test | L184 | ported:host/plugins/chat/tests/error.test.ts |
| `crates/dstu-agent/src/chat_v2/error.rs::tests::test_variant_error_display` | test | L199 | ported:host/plugins/chat/tests/error.test.ts |
| `crates/dstu-agent/src/chat_v2/error.rs::tests::test_error_to_string_conversion` | test | L220 | ported:host/plugins/chat/tests/error.test.ts |
| `crates/dstu-agent/src/chat_v2/error.rs::tests::test_command_error_code_stability` | test | L231 | ported:host/plugins/chat/tests/error.test.ts |
| `crates/dstu-agent/src/chat_v2/error.rs::tests::test_timeout_error` | test | L257 | ported:host/plugins/chat/tests/error.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_serialization` | test | L1906 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_start_creation` | test | L1947 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_start_with_variant` | test | L1967 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_chunk_creation` | test | L1982 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_chunk_with_variant` | test | L1995 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_end_creation` | test | L2004 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_error_creation` | test | L2019 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_variant_start` | test | L2030 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_variant_end_success` | test | L2044 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_variant_end_error` | test | L2058 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_variant_end_with_usage` | test | L2069 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_serialization` | test | L2085 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::lifecycle_events_keep_one_stream_generation_contract` | test | L2122 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_stream_start` | test | L2142 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_stream_complete` | test | L2160 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_stream_complete_with_usage` | test | L2169 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_with_usage_serialization` | test | L2196 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_stream_error` | test | L2242 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_stream_cancelled` | test | L2250 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_save_complete` | test | L2258 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::compaction_progress_events_have_stable_session_contracts` | test | L2266 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_compaction_failed_contract` | test | L2282 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_compaction_completed_contract` | test | L2294 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_context_trimmed_contract` | test | L2312 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_payload_absent_for_legacy_events` | test | L2329 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_save_error` | test | L2340 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_event_phase_constants` | test | L2348 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_event_types_constants` | test | L2356 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_type_constants` | test | L2372 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_deserialization` | test | L2382 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_backend_event_deserialization_with_variant` | test | L2403 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_session_event_deserialization` | test | L2420 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_sequence_id_strictly_increasing` | test | L2439 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::test_variant_event_serialization` | test | L2459 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::noop_sink_emitter_all_paths_do_not_panic` | test | L2513 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::noop_sink_window_accessors` | test | L2596 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::noop_sink_window_panics_on_window` | test | L2605 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::noop_sink_does_not_increment_failure_count` | test | L2613 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::noop_sink_sequence_ids_still_advance` | test | L2624 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::recording_sink_captures_block_events` | test | L2635 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::recording_sink_captures_session_events` | test | L2667 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_merges_and_end_flushes_in_order` | test | L2733 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_key_switch_flushes_previous_pending` | test | L2755 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_key_switch_expiry_opens_next_window` | test | L2786 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_empty_window_expiry_opens_next_window` | test | L2809 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_interleaved_variants_coalesce_independently` | test | L2829 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_concurrent_variants_preserve_every_delta` | test | L2857 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_flush_holds_ordering_lock_through_delivery` | test | L2898 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_preparing_and_variant_start_are_barriers` | test | L2961 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_start_event_flushes_pending` | test | L3002 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_session_event_flushes_pending` | test | L3017 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_cancel_delivers_all_variants_before_terminal_event` | test | L3030 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_drop_flushes_pending_tail` | test | L3075 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_non_batchable_type_passes_through_immediately` | test | L3098 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_window_expiry_flushes` | tokio::test | L3114 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_coalesces_many_deltas_into_one` | test | L3129 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_size_cap_flushes_immediately` | test | L3146 | ported:host/plugins/chat/tests/events.test.ts |
| `crates/dstu-agent/src/chat_v2/goal/steering.rs::tests::steering_contains_objective_budget_and_waiting_user` | test | L72 | pending |
| `crates/dstu-agent/src/chat_v2/goal/steering.rs::tests::steering_without_budget_shows_unlimited` | test | L89 | pending |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::builtin_profiles_map_losslessly_to_grant_scopes` | test | L727 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::effective_tools_computes_intersection` | test | L767 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::scopes_respect_source_isolation` | test | L795 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::registry_driven_scope_derivation_matches_legacy_rules` | test | L841 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::expiry_gates_liveness` | test | L916 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::epoch_liveness_is_monotonic` | test | L938 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::global_revocation_epoch_gates_registered_grants` | test | L955 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::denial_messages_are_explicit` | test | L1072 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::epoch_persistence_roundtrip` | test | L1084 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::epoch_reload_keeps_revocation_effective` | test | L1120 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::revoke_fails_closed_when_db_write_fails` | test | L1165 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::restore_installs_loaded_epochs_with_max_semantics` | test | L1192 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/grants.rs::tests::restore_tolerates_missing_table` | test | L1214 | ported:host/plugins/chat/tests/grants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs::tests::streaming_upsert_preserves_first_timestamps` | test | L1044 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs::tests::test_block_id_validation` | test | L1084 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs::tests::test_message_id_validation` | test | L1092 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/load_session.rs::tests::test_session_id_validation` | test | L107 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/load_session.rs::tests::loading_session_persists_retired_authority_mode_as_craft` | test | L120 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::branch_preserves_summary_only_compaction_boundaries` | test | L2223 | ported:host/plugins/chat/tests/branch.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::archive_rejects_active_super_session_but_allows_regular_ones` | test | L2318 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::restore_retires_old_super_session_when_another_active_super_exists` | test | L2338 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::restore_keeps_super_marker_when_no_other_active_super_exists` | test | L2365 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::branch_from_super_session_strips_super_marker_and_pin` | test | L2375 | ported:host/plugins/chat/tests/branch.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::settings_patch_cannot_strip_super_marker` | test | L2404 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::settings_patch_preserves_runtime_metadata_against_stale_snapshot` | test | L2416 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::settings_patch_leaves_487_compaction_boundaries_unchanged` | test | L2516 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::settings_metadata_replaces_normal_fields_and_preserves_runtime_keys` | test | L2600 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_valid_modes` | test | L2663 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_session_id_generation` | test | L2681 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_session_id_format_validation` | test | L2691 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_resolve_message_skill_snapshot_prefers_active_variant_snapshot` | test | L2702 | ported:host/plugins/chat/tests/deletion.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_remap_ids_in_value_remaps_only_exact_string_matches` | test | L2746 | ported:host/plugins/chat/tests/snapshot.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_clear_branch_local_skill_state_removes_only_branch_local` | test | L2816 | ported:host/plugins/chat/tests/deletion.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_fallback_skill_state_after_history_rebuild_clears_agentic_state` | test | L2834 | ported:host/plugins/chat/tests/deletion.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::referencing_tests::finds_sessions_by_context_ref_and_pdf_marker_and_skips_deleted` | test | L2958 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_message_id_generation` | test | L2247 | pending |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::build_wake_request_forces_ephemeral_user_content` | test | L2257 | pending |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_block_id_generation` | test | L2274 | pending |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_filter_path_map_for_send_refs_returns_none_when_path_map_missing` | test | L2295 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_filter_path_map_for_send_refs_returns_none_when_refs_missing_or_empty` | test | L2302 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_filter_path_map_for_send_refs_keeps_only_matched_resource_ids` | test | L2316 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_filter_path_map_for_send_refs_returns_none_when_no_match` | test | L2339 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_restores_manual_pins_only` | test | L2349 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_restores_runtime_skill_payload` | test | L2376 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_preserves_current_admission_projection` | test | L2447 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_keeps_current_replay_unchanged` | test | L2496 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_prefers_preferred_meta_over_fallback` | test | L2518 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_preserves_explicit_empty_execution_allowed_tools` | test | L2547 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/send_message.rs::tests::test_apply_original_skill_snapshot_overrides_does_not_invent_empty_policy_for_legacy_meta` | test | L2568 | ported:host/plugins/chat/tests/retry-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_variant_can_activate` | test | L1337 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_variant_can_retry` | test | L1349 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_get_variant` | test | L1361 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_delete_variant_result_serialization` | test | L1370 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_session_skill_state_from_snapshot_drops_branch_local_without_promoting` | test | L1384 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_variant_streaming_status` | test | L1412 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_variant_cancelled_status` | test | L1435 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_variant_pending_status` | test | L1456 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_resolve_retry_options_prefers_frontend_and_keeps_tool_settings` | test | L1477 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs::tests::test_resolve_retry_options_fallback_to_saved_params` | test | L1521 | ported:host/plugins/chat/tests/variants.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs::runtime_completion_tests::completion_envelope_uses_stable_runtime_protocol_fields` | test | L2816 | ported:host/plugins/chat/tests/workspace-run-agent.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs::runtime_completion_tests::failed_completion_omits_output_and_carries_error` | test | L2855 | ported:host/plugins/chat/tests/workspace-run-agent.test.ts |
| `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs::runtime_completion_tests::profile_skill_snapshot_selects_declared_ids_and_rejects_missing` | test | L2883 | ported:host/plugins/chat/tests/workspace-run-agent.test.ts |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::trip_rejects_register_stream` | test | L340 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::trip_blocks_headless_admission_with_explicit_error` | test | L355 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::trip_pauses_automation_dispatch_gate` | test | L368 | pending |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::cancel_all_streams_cancels_active_tokens` | test | L399 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::emergency_stop_path_marks_active_workers_cancelled` | test | L414 | pending |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::status_snapshot_reports_trip_metadata` | test | L497 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/kill_switch.rs::tests::status_serializes_independent_pause_and_trip_fields` | test | L517 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::startup_reconcile_finishes_streamed_text_and_interrupts_the_rest` | test | L4813 | ported:host/plugins/chat/tests/startup.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_crud` | test | L4861 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::superagent_internal_sessions_are_hidden_from_regular_session_views` | test | L4903 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::hidden_super_session_is_hidden_from_regular_session_views` | test | L4951 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::frozen_tool_schema_order_survives_process_restart_via_session_metadata` | test | L5012 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::frozen_tool_schema_order_metadata_merge_is_append_only` | test | L5040 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::frozen_tool_schema_order_merge_preserves_other_session_metadata` | test | L5081 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::frozen_tool_schema_order_missing_key_defaults_to_fresh_baseline` | test | L5146 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::tool_face_prefix_missing_generation_key_falls_back_to_generation_zero` | test | L5160 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::tool_face_prefix_advance_does_not_touch_updated_at` | test | L5196 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::tool_face_prefix_advance_writes_generation_and_order_atomically` | test | L5236 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_survives_process_restart_via_session_metadata` | test | L5323 | ported:host/plugins/chat/tests/metadata-freeze.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_freeze_is_first_write_wins` | test | L5358 | ported:host/plugins/chat/tests/metadata-freeze.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_freeze_preserves_other_session_metadata` | test | L5411 | ported:host/plugins/chat/tests/metadata-freeze.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_explicit_generation_bump_via_compaction_marker` | test | L5462 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_stale_marker_is_noop_when_never_frozen` | test | L5572 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::available_skills_snapshot_empty_freeze_then_compaction_marker_allows_catalog` | test | L5630 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::microcompact_anchor_survives_process_restart_via_session_metadata` | test | L5675 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::microcompact_anchor_lineage_none_roundtrips_and_preserves_metadata` | test | L5727 | ported:host/plugins/chat/tests/session-runtime-metadata.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_title_locked_default_false` | test | L5771 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_title_locked_persists_through_update` | test | L5787 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_set_title_locked_helper` | test | L5812 | ported:host/plugins/chat/tests/sessions.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_group_preferred_runtime_root_crud` | test | L5861 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_archive_group_preserves_group_id_and_restore_marker` | test | L5915 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_restore_group_restores_only_group_archived_sessions` | test | L5954 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_restore_group_reattaches_marker_sessions_with_cleared_group_id` | test | L6004 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_permanently_delete_group_deletes_topic_sessions_without_ungrouping` | test | L6040 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_permanently_delete_group_deletes_marker_orphan_sessions` | test | L6072 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_permanently_delete_group_rejects_active_topic` | test | L6112 | ported:host/plugins/chat/tests/repo-groups.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_soft_delete_group_is_the_only_group_flow_that_ungroups_sessions` | test | L6127 | obsolete:dead-in-rust C1-app.json 已批准；repo.rs:1080/6137 只有定义与测试，无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_message_crud` | test | L6151 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_history_window_batch_preserves_key_order_metadata_and_replay` | test | L6181 | ported:host/plugins/chat/tests/history-window.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_history_batch_without_replay_columns_keeps_blocks` | test | L6268 | ported:host/plugins/chat/tests/history-window.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_session_messages_page_with_role_filter` | test | L6295 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_issue469_meta_write_collapses_duplicate_runtime_and_slims_tool_results` | test | L6410 | ported:host/plugins/chat/tests/repo-payload.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_issue469_legacy_duplicated_meta_row_reads_back_slim_and_replayable` | test | L6481 | ported:host/plugins/chat/tests/repo-payload.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_issue469_tail_window_is_capped_by_payload_budget` | test | L6568 | ported:host/plugins/chat/tests/repo-payload.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_issue469_light_session_tail_unchanged` | test | L6626 | ported:host/plugins/chat/tests/repo-payload.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_search_content_date_range_preserves_legacy_search` | test | L6645 | ported:host/plugins/chat/tests/search.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_fts_triggers_cover_block_type_changes` | test | L6690 | ported:host/plugins/chat/tests/search.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_create_blocks_batch_atomic` | test | L6742 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_block_replay_sidecar_roundtrip_and_copy` | test | L6819 | ported:host/plugins/chat/tests/block-replay.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_update_block_invalidates_llm_content_on_content_change` | test | L6902 | ported:host/plugins/chat/tests/block-replay.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_update_block_fallback_without_replay_columns` | test | L7005 | ported:host/plugins/chat/tests/block-replay.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_block_replay_sidecar_fallback_without_columns` | test | L7039 | ported:host/plugins/chat/tests/block-replay.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_insert_or_replace_message_cascades_blocks` | test | L7075 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_block_crud` | test | L7123 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_retry_block_upsert_reloads_one_final_logical_block` | test | L7169 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_cascade_delete` | test | L7221 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_session_full` | test | L7286 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_state_upsert` | test | L7343 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_pending_context_refs_json_persistence` | test | L7412 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_pending_context_refs_json_empty_array` | test | L7454 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_pending_context_refs_json_none` | test | L7495 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_save_results_basic` | test | L7535 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_chat_history_basic` | test | L7614 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_chat_history_context_limit` | test | L7666 | pending |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_chat_history_content_only` | test | L7731 | ported:host/plugins/chat/tests/message-persistence.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_block_index_correct` | test | L7797 | ported:host/plugins/chat/tests/messages.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_variant_crud` | test | L7847 | obsolete:dead-in-rust C1-app.json 已批准；repo.rs:3755-4359 旧变体仓储无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_variant_status_update` | test | L7891 | obsolete:dead-in-rust C1-app.json 已批准；旧 update_variant_status 仅定义/包装/测试 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_delete_variant_cascade` | test | L7937 | obsolete:dead-in-rust C1-app.json 已批准；旧 delete_variant_with_conn 无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_delete_last_variant_deletes_message` | test | L8018 | obsolete:dead-in-rust C1-app.json 已批准；旧 delete_variant_with_conn 无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_add_block_to_variant` | test | L8058 | obsolete:dead-in-rust C1-app.json 已批准；旧 add_block_to_variant 无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_shared_context_update` | test | L8108 | obsolete:dead-in-rust C1-app.json 已批准；旧 update_message_shared_context 无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_message_variant_helpers` | test | L8158 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_repair_variant_status` | test | L8190 | obsolete:dead-in-rust C1-app.json 已批准；旧 repair_message_variant_status 无生产调用 |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_enforce_variants_json_size_limit_warn_path_does_not_truncate` | test | L8242 | ported:host/plugins/chat/tests/variants-limit.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_enforce_variants_json_size_limit_hard_truncates_oldest` | test | L8263 | ported:host/plugins/chat/tests/variants-limit.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_crud_roundtrip` | test | L8846 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_update_status_optimistic_concurrency` | test | L8895 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_add_usage_accumulates` | test | L8917 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_claim_continuation_counts` | test | L8940 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_claim_continuation_rejects_stale_or_exhausted_goal` | test | L8969 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_status_check_constraint_enforced` | test | L9011 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_record_serializes_camel_case` | test | L9019 | ported:host/plugins/chat/tests/goals.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_create_or_reuse_new_resource` | test | L532 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_create_or_reuse_dedup` | test | L553 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_get_resource` | test | L586 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_increment_decrement_ref` | test | L610 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_get_versions_by_source` | test | L651 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_get_latest_resource` | test | L678 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_resource_exists` | test | L701 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_find_by_hash` | test | L726 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_increment_refs_atomic_rollback` | test | L753 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_create_or_reuse_conflict_insert_reuses_existing` | test | L788 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_repo.rs::tests::test_calculate_hash_consistency` | test | L831 | obsolete:dead-in-rust C1-app.json 已批准；resource_repo.rs:1-16 废弃且无生产调用 |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_resource_type_serialization` | test | L417 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_resource_type_deserialization` | test | L462 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_create_resource_result_camel_case` | test | L475 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_content_block_text_serialization` | test | L490 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_content_block_image_serialization` | test | L499 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_context_ref_serialization` | test | L509 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_send_context_ref_serialization` | test | L520 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_context_snapshot_serialization` | test | L536 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_context_snapshot_empty_skip` | test | L548 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_resource_serialization` | test | L557 | pending |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_context_snapshot_all_resource_ids` | test | L577 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_send_context_ref_conversion` | test | L592 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/resource_types.rs::tests::test_create_resource_params_serialization` | test | L609 | pending |
| `crates/dstu-agent/src/chat_v2/role_packs.rs::tests::registry_covers_all_required_domains_and_contract_fields` | test | L366 | pending |
| `crates/dstu-agent/src/chat_v2/role_packs.rs::tests::explicit_old_version_remains_selectable_and_latest_is_newest` | test | L401 | pending |
| `crates/dstu-agent/src/chat_v2/role_packs.rs::tests::registry_covers_required_composable_workflows_with_human_review` | test | L415 | pending |
| `crates/dstu-agent/src/chat_v2/role_packs.rs::tests::schema_validation_reports_missing_inputs` | test | L434 | pending |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::default_options_match_spec_defaults` | test | L331 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::options_deserialize_from_partial_camel_case_json` | test | L342 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_line_order_and_footer_counts` | test | L538 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_empty_session_writes_header_and_zero_count_footer` | test | L609 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_round_trips_against_load_session_full` | test | L645 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_redacts_secrets_by_default` | test | L702 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_active_variant_only_prunes_variants_and_blocks` | test | L750 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_missing_session_returns_session_not_found` | test | L784 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_skips_missing_referenced_blocks` | test | L806 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_honors_state_and_compaction_toggles` | test | L838 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_write_failure_maps_to_io_error` | test | L860 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::invalid_json_and_empty_rule_fail_closed` | test | L343 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::deny_wins_over_ask_and_allow` | test | L360 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::prefix_requires_token_boundary` | test | L372 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::safe_local_allow_does_not_cross_external_or_effectful_boundaries` | test | L387 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::allow_never_downgrades_path_shadowable_or_subprocess_capable_commands` | test | L451 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::executable_rules_match_auditable_basename_case_insensitively` | test | L500 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::ask_forces_low_executor_to_medium_and_default_deny_blocks` | test | L511 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/shell_command_policy.rs::tests::prefix_does_not_match_a_longer_partial_token` | test | L531 | ported:host/plugins/chat/tests/shell-command-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_register_and_cancel_stream` | test | L577 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_cancel_nonexistent_stream` | test | L593 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_remove_stream` | test | L602 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_active_stream_count` | test | L615 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_try_register_stream_success` | test | L634 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_try_register_stream_reject_duplicate` | test | L643 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_stream_guard_cleanup_on_normal_drop` | test | L654 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_stream_guard_idempotent_double_cleanup` | test | L670 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::test_stream_guard_cleanup_on_panic` | test | L686 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::stale_guard_cannot_remove_immediate_retry_generation` | test | L708 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::stale_guard_cannot_remove_replacement_after_early_cleanup` | test | L731 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/state.rs::tests::stale_variant_child_guard_cannot_remove_retry_token` | test | L749 | ported:host/plugins/chat/tests/state.test.ts |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::g08_environment_manifest_is_embedded_with_matching_hash` | test | L316 | pending |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::secx_01_export_recursively_redacts_secret_values` | test | L366 | ported:host/plugins/chat/tests/session-export.test.ts |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::col_06_incomplete_coverage_is_never_reported_complete` | test | L387 | pending |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::col_08_rollback_claim_requires_verification` | test | L404 | pending |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::col_08_caller_supplied_manifest_is_never_authoritative` | test | L419 | pending |
| `crates/dstu-agent/src/chat_v2/task_audit.rs::tests::backend_verified_manifest_becomes_authoritative_only_with_full_coverage` | test | L468 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::parses_five_command_families` | test | L995 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::create_produces_task_record_with_full_binding` | test | L1059 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::duplicate_message_id_is_idempotent` | test | L1081 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::generation_increments_per_accepted_message` | test | L1096 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::stop_marks_cancelled_immediately_and_aborts_unattached_launch` | test | L1116 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::stop_with_attached_session_returns_session_for_stream_cancel` | test | L1138 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::stale_generation_cannot_finish_a_new_turn` | test | L1156 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::stop_without_running_task_replies_guidance` | test | L1188 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::cross_thread_and_cross_account_isolation` | test | L1197 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::steer_after_completion_reuses_same_session` | test | L1234 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::busy_while_running` | test | L1255 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::approve_returns_desktop_guidance_only` | test | L1266 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::remote_tool_surface_is_headless_readonly_whitelist` | test | L1279 | pending |
| `crates/dstu-agent/src/chat_v2/task_command.rs::tests::binding_and_command_serde_roundtrip` | test | L1311 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::derives_stable_source_and_domain` | test | L166 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::source_scoped_tool_rule_isolated_between_servers` | test | L187 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::resolves_rules_from_most_specific_to_global` | test | L210 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::invalid_specific_rule_falls_through_to_group_rule` | test | L241 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::precise_approval_tools_cannot_be_lowered_by_group_or_global_rules` | test | L258 | pending |
| `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs::tests::explicit_group_rule_can_raise_a_low_risk_tool` | test | L290 | pending |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::table_is_wellformed` | test | L748 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::headless_flag_matches_headless_whitelist` | test | L777 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::headless_tools_are_low_sensitivity` | test | L797 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::ptc_flag_matches_ptc_whitelist` | test | L811 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::ptc_tools_are_low_sensitivity` | test | L831 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::lookup_is_exact_bare_name_match` | test | L844 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::headless_and_ptc_queries_accept_both_name_forms` | test | L852 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_descriptors.rs::tests::grants_scope_hint_marks_shell_family` | test | L871 | ported:host/plugins/chat/tests/tool-descriptors.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_allows_exact_and_canonical_builtin_names` | test | L141 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_empty_list_blocks_business_tools_but_allows_control_tools` | test | L161 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_does_not_exempt_mcp_namespaced_control_tools` | test | L188 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_does_not_treat_mcp_prefixed_sleep_as_control_tool` | test | L229 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_matches_server_scoped_tools` | test | L249 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_builtin_entry_does_not_allow_mcp_tools` | test | L265 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_bare_entry_does_not_allow_mcp_sourced_calls` | test | L297 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tool_policy.rs::tests::execution_policy_mcp_entry_matches_only_mcp_namespace` | test | L320 | ported:host/plugins/chat/tests/tool-policy.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::corpus_ceiling_covers_first_page` | test | L2029 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::test_can_handle` | test | L2036 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::test_sensitivity_level` | test | L2047 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::stage_failure_maps_args_schema_and_not_found` | test | L2062 | ported:host/plugins/chat/tests/attachment-errors.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::resolves_legacy_attachment_from_chat_v2_database` | test | L2111 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::resolves_legacy_text_content_from_vfs_data_column` | test | L2156 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::sanitizes_illegal_characters_and_separators` | test | L2206 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::sanitizes_empty_and_dot_only_names_to_fallback` | test | L2216 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::truncates_overlong_names_preserving_extension` | test | L2224 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::rejects_oversized_payloads` | test | L2232 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::zip_scan_returns_bounded_safe_manifest` | test | L2252 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::zip_scan_rejects_parent_traversal` | test | L2269 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::rar_and_7z_are_signature_checked_but_not_claimed_as_scanned` | test | L2279 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::rejected_new_archive_is_removed_with_its_index_entry` | test | L2297 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::stages_bytes_under_attachments_subdir_with_forward_slashes` | test | L2313 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::dedupes_same_content_even_with_different_requested_name` | test | L2328 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::same_name_different_content_gets_numeric_suffix` | test | L2339 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::same_name_same_content_reuses_existing_file_without_index` | test | L2356 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::escape_attempts_stay_inside_temp_root` | test | L2367 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::decodes_data_urls_and_plain_base64` | test | L2389 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::stages_disk_file_via_copy` | test | L2402 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::rejects_oversized_sparse_disk_source_before_copying` | test | L2418 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::index_hit_revalidates_same_length_file_hash` | test | L2437 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::extract_zip_writes_files_under_extracted_subdir` | test | L2454 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::extract_rejects_traversal_and_cleans_up_partial_output` | test | L2482 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::extract_rejects_non_zip_formats_with_structured_error` | test | L2502 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::extract_rejects_paths_outside_temp_root` | test | L2513 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::extract_dir_names_get_numeric_suffix_on_conflict` | test | L2520 | pending |
| `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs::tests::stage_index_rejects_non_plain_file_names` | test | L2529 | ported:host/plugins/chat/tests/stage-context-attachments.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::test_tool_sensitivity_default` | test | L906 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::test_tool_concurrency_default_is_serial` | test | L911 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::result_budget_is_noop_within_budget` | test | L916 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::result_budget_shrinks_long_string_leaves_but_keeps_structure` | test | L923 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::result_budget_falls_back_to_preview_for_huge_arrays` | test | L957 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor.rs::tests::result_budget_enforces_minimum_budget` | test | L977 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::test_registry_creation` | test | L606 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::test_register_executor` | test | L613 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::test_executor_priority` | test | L626 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::test_get_sensitivity` | test | L649 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::risk_snapshot_uses_concrete_call_ssot_and_exposes_policy_guards` | test | L674 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::test_get_concurrency_class_defaults_to_serial` | test | L713 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::image_generation_tool_uses_five_minute_timeout` | test | L738 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::external_mcp_namespaces_use_three_minute_timeout` | test | L744 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::ask_user_tool_is_not_subject_to_global_timeout` | test | L750 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::ask_user_is_no_timeout_tool_for_pack_validation` | test | L756 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::tool_pack_uses_ten_minute_timeout` | test | L765 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::index_rebuild_and_webpage_save_use_dedicated_long_timeouts` | test | L771 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::registry_errors_are_structured_and_keep_retry_keywords` | test | L784 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::translation_uses_ten_minute_timeout` | test | L810 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::local_shell_registry_watchdog_is_disabled_for_authoritative_cleanup` | test | L817 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::blocking_collaboration_tools_are_exempt_from_registry_watchdog` | test | L825 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::acr_capable_executors_outlive_the_full_bridge_transaction_budget` | test | L849 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs::tests::timeout_migration_matches_legacy_mapping_for_every_tool` | test | L927 | ported:host/plugins/chat/tests/executor-registry.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/mod.rs::tests::test_is_canvas_tool` | test | L216 | pending |
| `crates/dstu-agent/src/chat_v2/tools/mod.rs::tests::test_strip_canvas_builtin_prefix` | test | L246 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_registry_creation` | test | L239 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_registry_with_builtin_tools` | test | L245 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_get_schemas` | test | L261 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_get_schemas_with_invalid_id` | test | L272 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_get_tools_for_context_type` | test | L283 | pending |
| `crates/dstu-agent/src/chat_v2/tools/registry.rs::tests::test_get_tools_by_category` | test | L290 | pending |
| `crates/dstu-agent/src/chat_v2/tools/types.rs::tests::test_tool_definition_creation` | test | L196 | pending |
| `crates/dstu-agent/src/chat_v2/tools/types.rs::tests::test_tool_definition_with_context_types` | test | L224 | pending |
| `crates/dstu-agent/src/chat_v2/tools/types.rs::tests::test_execution_result_success` | test | L239 | pending |
| `crates/dstu-agent/src/chat_v2/tools/types.rs::tests::test_execution_result_failure` | test | L247 | pending |
| `crates/dstu-agent/src/chat_v2/tools/types.rs::tests::test_external_mcp_namespace_detection_preserves_source` | test | L255 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::feature_flags::tests::test_default_multi_variant_enabled` | test | L64 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::super_session_internal_fields_are_not_deserializable_from_frontend` | test | L2932 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::message_meta_inbound_origin_uses_camel_case_key_and_is_optional` | test | L2964 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_panel_states_accepts_v0944_shape_missing_skill` | test | L2983 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_panel_states_round_trips_current_skill_panel` | test | L3001 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_send_options_preserves_runtime_reasoning_overrides` | test | L3016 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_block_serialization` | test | L3034 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_serialization` | test | L3091 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_session_serialization` | test | L3159 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_send_options_serialization` | test | L3185 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_send_options_execution_allowed_tools_is_backend_only` | test | L3222 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_block_id_generation` | test | L3242 | ported:host/plugins/chat/tests/message-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_id_generation` | test | L3263 | ported:host/plugins/chat/tests/message-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_session_id_generation` | test | L3279 | ported:host/plugins/chat/tests/session-commands.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_block_state_transitions` | test | L3295 | ported:host/plugins/chat/tests/message-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_block_error_state` | test | L3316 | ported:host/plugins/chat/tests/message-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_block_content_append` | test | L3328 | ported:host/plugins/chat/tests/message-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_citation_serialization` | test | L3341 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_persist_status_serialization` | test | L3361 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_role_serialization` | test | L3376 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_load_session_response_serialization` | test | L3387 | ported:host/plugins/chat/tests/wire-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_deserialization_from_frontend` | test | L3421 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_serialization_camel_case` | test | L3448 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_id_generation` | test | L3489 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_state_transitions` | test | L3505 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_error_state` | test | L3526 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_cancelled_state` | test | L3538 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_shared_context_serialization` | test | L3549 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_shared_context_has_sources` | test | L3587 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_is_multi_variant` | test | L3605 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_get_active_block_ids_fallback` | test | L3625 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_select_best_active_variant` | test | L3658 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_select_best_active_variant_fallback` | test | L3678 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_select_best_active_variant_all_error` | test | L3695 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_add_and_remove_variant` | test | L3712 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_send_options_parallel_model_ids` | test | L3737 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_chat_message_with_variants_serialization` | test | L3760 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_source_serialization` | test | L3797 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_source_default` | test | L3817 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_source_display` | test | L3823 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_serialization_camel_case` | test | L3831 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_from_api` | test | L3884 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_from_api_with_cache` | test | L3896 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_from_estimate_tiktoken` | test | L3908 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_from_estimate_heuristic` | test | L3918 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_accumulate_same_source` | test | L3928 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_accumulate_mixed_source` | test | L3942 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_accumulate_reasoning_tokens` | test | L3955 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_accumulate_cached_tokens` | test | L3965 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_has_tokens` | test | L3975 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_zero` | test | L3984 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_meta_with_usage` | test | L3993 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_meta_web_search_items_serde_key` | test | L4018 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_meta_without_usage` | test | L4048 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_with_usage_builder` | test | L4066 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_set_usage` | test | L4078 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_serialization_with_usage` | test | L4090 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_variant_serialization_without_usage` | test | L4115 | ported:host/plugins/chat/tests/variant-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_token_usage_deserialization` | test | L4129 | ported:host/plugins/chat/tests/token-usage.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_session_skill_state_without_branch_local_skills` | test | L4150 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_replay_skill_payload_snapshot_without_skill_contents_keeps_light_metadata` | test | L4168 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_skill_injection_anchors_old_json_without_digest_fields_still_parses` | test | L4202 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_skill_injection_anchors_digest_fields_skip_when_empty` | test | L4221 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_skill_injection_anchors_digest_fields_roundtrip` | test | L4242 | pending |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_skill_body_digest_stable_and_separator_safe` | test | L4264 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_replay_skill_payload_snapshot_preserves_explicit_empty_policy` | test | L4286 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_replay_skill_payload_snapshot_drops_legacy_skill_allowlist` | test | L4306 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::test_message_and_variant_meta_without_skill_runtime_contents_strip_private_text` | test | L4318 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/types.rs::tests::canonical_multiple_images_preserve_distinct_identity_and_names` | test | L4352 | ported:host/plugins/chat/tests/replay-skill-values.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_build_user_message_minimal` | test | L328 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_build_user_message_with_id` | test | L341 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_convert_attachment_image` | test | L353 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_convert_attachment_document` | test | L374 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_convert_attachment_audio` | test | L390 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_convert_attachment_video` | test | L405 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_extract_user_refs_snapshot_empty` | test | L420 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_extract_user_refs_snapshot_with_refs` | test | L427 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::test_build_user_message_with_context_snapshot` | test | L440 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/user_message_builder.rs::tests::multi_variant_user_can_persist_canonical_refs_without_claiming_a_model_snapshot` | test | L460 | ported:host/plugins/chat/tests/user-message-builder.test.ts |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_variant_id_generation` | test | L1214 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_cancel_token_cascade` | test | L1220 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_child_cancel_not_affect_parent` | test | L1236 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_parallel_manager_basic` | test | L1249 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_parallel_manager_cancel_all` | test | L1258 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_get_first_success_empty` | test | L1268 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_shared_context` | test | L1275 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_block_auto_attribution` | test | L1300 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_block_id_no_duplicate` | test | L1324 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_created_at_consistency` | test | L1350 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_token_usage_default` | test | L1366 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_token_usage_from_api` | test | L1378 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_token_usage_mutex` | test | L1389 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_variant_with_usage` | test | L1416 | pending |
| `crates/dstu-agent/src/chat_v2/variant_context.rs::tests::test_variant_set_usage` | test | L1432 | pending |
| `crates/dstu-agent/src/system_notification.rs::tests::parses_policy_with_background_default` | test | L60 | ported:host/plugins/chat/tests/emergency-hooks.test.ts |
<!-- END GENERATED:testmap:rows -->

## WP-018 核验（2026-11-05）

逐行统计：527 条，ported 386 → 394、pending 122 → 114、obsolete 19 不变。生成表头的旧统计不作为本包基线。

以下 Rust 位置均为 `crates/dstu-agent/src/chat_v2/shell_command_policy.rs`，TS 为 `host/plugins/chat/tests/shell-command-policy.test.ts`；测试标题保留同名函数。

| Rust 行 / 测试名 | TS 行 | 全部原断言对应（Linux 展开循环后数量） |
|---|---|---|
| 343 / invalid_json_and_empty_rule_fail_closed | 15 | 4→4：坏 JSON Ask、config_valid=false；empty 解析失败经公开 enforce 的 config_valid=false 观察；empty Ask |
| 360 / deny_wins_over_ask_and_allow | 27 | 2→2：三个重叠规则仍由 deny 获胜，精确 matched_rule_id |
| 372 / prefix_requires_token_boundary | 38 | 2→2：rm -f x Deny，rmdir x Ask |
| 387 / safe_local_allow_does_not_cross_external_or_effectful_boundaries | 46 | 19→19：7条规则、原14个非Allow向量、裸ls/外部echo/git Ask，本地echo及非Windows /bin/ls Allow |
| 451 / allow_never_downgrades_path_shadowable_or_subprocess_capable_commands | 84 | 12→12：4个PATH、6个subprocess均Ask，echo与非Windows绝对grep Allow |
| 500 / executable_rules_match_auditable_basename_case_insensitively | 107 | 1→1：GIT规则拒绝/usr/bin/git status |
| 511 / ask_forces_low_executor_to_medium_and_default_deny_blocks | 114 | 2→6：无配置ls使Low升Medium；默认Deny；追加具体调用API的设置键/deny/敏感度断言 |
| 531 / prefix_does_not_match_a_longer_partial_token | 133 | 2→2：git stat --short Deny，git status --short Ask |

全部经 L05 `api.ts:24-26` 的真实策略入口；生产调用点为其 `index.ts:119-125` → `src/tools/executors.ts:74-75` → `shell-execute.ts:102,200` / `shell-preflight.ts:570,419`。没有新增注册或策略副本。证据 job `20261105140913-342942`：8 passed / 0 failed / 0 skipped，Errors 0（无 Errors 行），exit 0。额外 L05 serde/Unicode 差异见 BLOCKERS，不扩大这8条原测试的证明范围。
