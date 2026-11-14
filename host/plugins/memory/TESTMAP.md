# L17-memory-research 测试去向（`host/plugins/memory`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L17-memory-research：168 行（真实测试 168）· pending 57 · ported 109
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_extract_json_array` | test | L495 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_extract_json_array_empty` | test | L503 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_parse_extraction_response_full_object_format` | test | L511 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_parse_extraction_response_full_legacy_array_format` | test | L520 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_parse_extraction_response_full_garbage` | test | L529 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_values_to_activities_filters` | test | L537 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_values_to_candidates_filters_long_content` | test | L548 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_sensitive_pattern_blocks_invisible_unicode` | test | L560 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_sensitive_pattern_blocks_private_key_material` | test | L584 | ported:host/plugins/memory/tests/auto-extractor.test.ts |
| `crates/dstu-memory/src/memory/category_manager.rs::tests::test_category_note_title` | test | L465 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/category_manager.rs::tests::test_category_key_roundtrip_normal_path` | test | L477 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/category_manager.rs::tests::test_category_key_roundtrip_with_fullwidth_slash` | test | L486 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/category_manager.rs::tests::test_category_key_legacy_compatibility` | test | L495 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/category_manager.rs::tests::test_member_tags_roundtrip` | test | L503 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_basic` | test | L345 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_with_noise_and_codeblock` | test | L355 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_empty_for_chitchat` | test | L363 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_garbage_returns_empty` | test | L370 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_filters_invalid_facts` | test | L377 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_parse_flush_response_caps_counts` | test | L395 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_extract_json_object_with_nested_braces_in_string` | test | L411 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/compaction_flush.rs::tests::test_truncate_head_tail` | test | L419 | ported:host/plugins/memory/tests/compaction-flush.test.ts |
| `crates/dstu-memory/src/memory/config.rs::tests::test_config_key_constants` | test | L542 | ported:host/plugins/memory/tests/config.test.ts |
| `crates/dstu-memory/src/memory/config.rs::tests::test_evolution_tuning_key_constants_and_defaults` | test | L552 | ported:host/plugins/memory/tests/config.test.ts |
| `crates/dstu-memory/src/memory/config.rs::tests::test_auto_extract_frequency` | test | L591 | ported:host/plugins/memory/tests/config.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::test_daily_log_note_title_and_parse` | test | L419 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::test_strip_entry_prefix` | test | L428 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::test_lines_contain_entry_ignores_timestamp` | test | L438 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::test_enforce_log_char_limit_drops_oldest` | test | L446 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::test_enforce_log_char_limit_keeps_single_oversize_line` | test | L460 | ported:host/plugins/memory/tests/pure-modules.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::concurrent_daily_log_appends_replay_after_cas_conflict` | test | L469 | ported:host/plugins/memory/tests/daily-log-db.test.ts |
| `crates/dstu-memory/src/memory/daily_log.rs::tests::concurrent_first_daily_log_appends_create_one_reserved_structure` | test | L515 | ported:host/plugins/memory/tests/daily-log-db.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_extract_hits` | test | L1178 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_extract_hits_missing` | test | L1188 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_extract_last_injected` | test | L1196 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_signal_within_days_dual_threshold` | test | L1210 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_days_since_best_signal_prefers_latest_and_falls_back` | test | L1241 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_build_promotion_prompt_includes_logs_and_profile` | test | L1284 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_build_promotion_prompt_empty_profile_placeholder` | test | L1304 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_parse_promotion_response_full_proposal` | test | L1310 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_parse_promotion_response_empty_and_garbage` | test | L1341 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/evolution.rs::tests::test_promotion_fingerprint_stable_and_sensitive` | test | L1348 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_upsert_weak_point_accumulates_evidence` | test | L1386 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_adds_new_weak_point_with_min_evidence` | test | L1403 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_remove_weak_point` | test | L1416 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_skips_blank_weak_point` | test | L1433 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_preferences_patch_is_field_level` | test | L1444 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_goals_dedup_and_remove` | test | L1466 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_merge_empty_update_no_change` | test | L1493 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_render_markdown_contains_all_sections` | test | L1501 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_enforce_char_limit_drops_low_evidence_first` | test | L1532 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_enforce_char_limit_noop_when_small` | test | L1554 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_json_roundtrip` | test | L1562 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::test_from_json_tolerates_missing_fields` | test | L1574 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::promotion_fingerprint_replay_is_exactly_once_and_repairs_history` | test | L1582 | ported:host/plugins/memory/tests/learner-profile-store.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::profile_history_dedup_keeps_last_entry_for_each_version` | test | L1659 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::concurrent_profile_updates_replay_after_cas_conflict` | test | L1686 | ported:host/plugins/memory/tests/learner-profile-store.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::concurrent_first_profile_updates_create_one_reserved_structure` | test | L1760 | ported:host/plugins/memory/tests/learner-profile-store.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::sync_merge_is_symmetric_and_keeps_both_sides_increments` | test | L1829 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::sync_merge_json_entry_rejects_non_profile_content` | test | L1902 | ported:host/plugins/memory/tests/evolution-profile.test.ts |
| `crates/dstu-memory/src/memory/learner_profile.rs::tests::cancellation_before_commit_leaves_profile_unchanged` | test | L1914 | ported:host/plugins/memory/tests/learner-profile-store.test.ts |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_memory_event_serde` | test | L284 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_extract_and_parse_clean_json` | test | L292 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_extract_json_from_surrounding_text` | test | L300 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_extract_json_with_think_tag` | test | L310 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_extract_json_markdown_with_text_before` | test | L320 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_extract_json_returns_none_for_no_json` | test | L330 | pending |
| `crates/dstu-memory/src/memory/llm_decision.rs::tests::test_memory_event_from_str` | test | L335 | pending |
| `crates/dstu-memory/src/memory/query_rewriter.rs::tests::test_no_rewrite_short_query` | test | L190 | obsolete:dead-in-rust（C1 批准，main migration/approvals.d/C1-app.json） |
| `crates/dstu-memory/src/memory/query_rewriter.rs::tests::test_parse_json` | test | L197 | obsolete:dead-in-rust（C1 批准，main migration/approvals.d/C1-app.json） |
| `crates/dstu-memory/src/memory/reranker.rs::tests::test_empty_results` | test | L117 | ported:host/plugins/memory/tests/chat-tools.test.ts |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_parse_dedup_response_merge` | test | L696 | pending |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_parse_dedup_response_keep_with_noise` | test | L706 | pending |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_parse_dedup_response_invalid_action` | test | L714 | pending |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_validate_merge_decision_guards` | test | L720 | pending |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_extract_tag_count_max_merge` | test | L768 | pending |
| `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::test_build_dedup_prompt_contains_both_notes` | test | L789 | pending |
| `crates/dstu-memory/src/memory/service.rs::tests::memory_search_uses_lexical_route_without_te_and_ignores_bare_vector` | tokio::test | L4604 | ported:host/plugins/memory/tests/search.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::normalize_folder_segments_strips_root_prefix_and_noise` | test | L4651 | ported:host/plugins/memory/tests/commands.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::reserved_folder_check_uses_normalized_separators` | test | L4676 | ported:host/plugins/memory/tests/commands.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::root_prefixed_folder_paths_reuse_existing_memory_folder` | test | L4687 | ported:host/plugins/memory/tests/commands.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::nested_duplicate_root_is_merged_back_on_first_root_lookup` | test | L4763 | ported:host/plugins/memory/tests/nested-root-repair.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::test_write_mode_from_str` | test | L4837 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::test_should_downgrade_smart_mutation` | test | L4850 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::relation_occ_is_atomic_and_advances_both_versions` | test | L4861 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::tag_and_move_occ_preserve_system_boundary_and_advance_versions` | test | L4946 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::stale_idempotency_lease_is_reclaimed_and_fences_previous_owner` | test | L5016 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::idempotent_note_mutation_rolls_back_when_receipt_write_is_interrupted` | test | L5078 | ported:host/plugins/memory/tests/idempotency-atomicity.test.ts |
| `crates/dstu-memory/src/memory/service.rs::tests::compaction_receipts_survive_normal_ttl_until_ledger_cleanup` | test | L5146 | ported:host/plugins/memory/tests/service-occ.test.ts |
| `crates/dstu-research/src/hpias/events.rs::tests::channel_matches_frontend_contract` | test | L50 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/events.rs::tests::build_session_started_payload_includes_question_when_present` | test | L55 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/events.rs::tests::build_session_started_payload_omits_blank_question` | test | L64 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/orchestrator.rs::tests::spawn_from_intent_skips_non_research_intent` | test | L85 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/orchestrator.rs::tests::pipeline_timeline_length_matches_style_lab_demo` | test | L93 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::intent_has_research_blocks_detects_research_plan` | test | L331 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::intent_has_research_blocks_rejects_text_only` | test | L339 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::extract_plan_queries_from_research_plan_steps` | test | L347 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::extract_plan_queries_deduplicates_and_caps_at_frontend_limit` | test | L366 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::build_pipeline_timeline_includes_lifecycle_events` | test | L385 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::build_pipeline_timeline_uses_intent_synthesis` | test | L399 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::build_pipeline_timeline_formats_stub_citation_ids` | test | L418 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/payloads.rs::tests::build_pipeline_timeline_covers_required_lifecycle` | test | L436 | ported:host/plugins/memory/tests/hpias.test.ts |
| `crates/dstu-research/src/hpias/retrieval_backend.rs::tests::summarize_hits_empty_returns_placeholder` | test | L279 | pending |
| `crates/dstu-research/src/hpias/retrieval_backend.rs::tests::build_synthesis_includes_question_heading` | test | L284 | pending |
| `crates/dstu-research/src/hpias/retrieval_backend.rs::tests::deps_can_run_retrieval_requires_vfs_and_llm` | test | L291 | pending |
| `crates/dstu-research/src/hpias/service.rs::tests::request_carries_session_and_intent` | test | L115 | pending |
| `crates/dstu-research/src/hpias/service.rs::tests::backend_kind_defaults_to_disabled` | test | L129 | pending |
| `crates/dstu-research/src/hpias/service.rs::tests::backend_kind_reads_env_stub` | test | L141 | pending |
| `crates/dstu-research/src/hpias/service.rs::tests::backend_kind_reads_env_retrieval` | test | L149 | pending |
| `crates/dstu-research/src/hpias/service.rs::tests::backend_kind_unknown_value_fails_closed` | test | L157 | pending |
| `crates/dstu-research/src/hpias/synthesis.rs::tests::build_synthesis_llm_prompt_includes_question_and_evidence` | test | L140 | pending |
| `crates/dstu-research/src/insight/disclosure.rs::tests::passive_silence_when_disabled` | test | L251 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/disclosure.rs::tests::passive_low_confidence_silence` | test | L264 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/disclosure.rs::tests::passive_budget_enforced` | test | L274 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/disclosure.rs::tests::existence_never_exposes_method` | test | L288 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/disclosure.rs::tests::escalation_one_rung_at_a_time` | test | L305 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_create_confirm_correct_delete_lifecycle` | test | L32 | ported:host/plugins/memory/tests/insight-service.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_self_reported_without_user_evidence_downgraded` | test | L112 | ported:host/plugins/memory/tests/insight-service.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_validation_and_feedback` | test | L127 | ported:host/plugins/memory/tests/insight-service.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_relation_scope_required_for_contradict` | test | L159 | ported:host/plugins/memory/tests/insight-service.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_recall_fts_and_like_fallback` | test | L191 | ported:host/plugins/memory/tests/insight-recall.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_recall_skips_cold_and_deleted` | test | L220 | ported:host/plugins/memory/tests/insight-recall.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_idempotent_event_and_mastery_write` | test | L238 | ported:host/plugins/memory/tests/insight-service.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_job_queue_enqueue_dedupe_and_lease_recovery` | test | L318 | ported:host/plugins/memory/tests/insight-jobs.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_srs_projection_materialize_and_regenerate` | test | L380 | ported:host/plugins/memory/tests/insight-worker.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_merge_proposal_creates_deduped_todo` | test | L496 | ported:host/plugins/memory/tests/insight-worker.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_principle_synthesis_requires_cases_and_counterexample` | test | L553 | ported:host/plugins/memory/tests/insight-worker.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_principle_review_todo_on_source_correction` | test | L603 | ported:host/plugins/memory/tests/insight-worker.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_internalization_discount_bounds` | test | L650 | ported:host/plugins/memory/tests/disclosure.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_calibrate_policy_from_ledger` | test | L662 | ported:host/plugins/memory/tests/insight-adaptive.test.ts |
| `crates/dstu-research/src/insight/tests.rs::test_cross_cluster_analogy_expansion` | test | L709 | ported:host/plugins/memory/tests/insight-recall.test.ts |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_can_handle` | test | L1020 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_sensitivity` | test | L1031 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::academic_sources_share_reply_citation_ledger` | test | L1044 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_parse_arxiv_atom_basic` | test | L1074 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_parse_arxiv_atom_empty` | test | L1106 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_reconstruct_abstract` | test | L1116 | pending |
| `src/chat_v2/tools/academic_search_executor.rs::tests::test_reconstruct_abstract_repeated_word` | test | L1130 | pending |
| `src/chat_v2/tools/knowledge_executor.rs::tests::test_can_handle` | test | L389 | pending |
| `src/chat_v2/tools/knowledge_executor.rs::tests::test_strip_namespace` | test | L403 | pending |
| `src/chat_v2/tools/knowledge_executor.rs::tests::test_sensitivity_level` | test | L411 | pending |
| `src/chat_v2/tools/knowledge_executor.rs::tests::test_parse_extraction_response` | test | L421 | pending |
| `src/chat_v2/tools/knowledge_executor.rs::tests::test_parse_empty_response` | test | L436 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::overview_defaults_to_seven_days_and_strict_pagination` | test | L1143 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::overview_requires_exact_bounded_past_date_range` | test | L1164 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::daily_parser_is_closed_and_bounded` | test | L1185 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::normal_aggregation_and_pagination_preserve_full_totals` | test | L1203 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::all_tools_are_low_sensitivity_read_only` | test | L1250 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::learning_activity_and_pomodoro_aggregate_real_migrated_rows` | test | L1265 | pending |
| `src/chat_v2/tools/learning_overview_executor.rs::tests::learning_activity_sql_failures_are_reported_as_partial_sources` | test | L1378 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::test_needs_root_bootstrap` | test | L2228 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::phase9_memory_tools_have_explicit_sensitivity_and_concurrency` | test | L2234 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::batch_move_parser_requires_complete_occ_map_and_enforces_limit` | test | L2272 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::export_pagination_and_content_are_bounded` | test | L2306 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::list_pagination_matches_global_read_limit` | test | L2325 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::export_page_returns_real_memory_content_and_has_more` | test | L2338 | pending |
| `src/chat_v2/tools/memory_executor.rs::tests::tags_are_trimmed_deduplicated_and_bounded` | test | L2370 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_can_handle` | test | L1373 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_sensitivity` | test | L1382 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::executor_failure_boundary_localizes_paper_errors` | test | L1395 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_sanitize_filename` | test | L1407 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_sanitize_filename_chinese_truncation` | test | L1420 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_format_bibtex` | test | L1430 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_format_gbt7714` | test | L1445 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_format_apa` | test | L1459 | pending |
| `src/chat_v2/tools/paper_save_executor.rs::tests::test_format_gbt7714_many_authors` | test | L1474 | pending |
| `src/quick_assistant.rs::tests::parses_valid_bounds` | test | L286 | ported:host/plugins/memory/tests/tools-pure.test.ts |
| `src/quick_assistant.rs::tests::rejects_malformed_bounds` | test | L291 | ported:host/plugins/memory/tests/tools-pure.test.ts |
<!-- END GENERATED:testmap:rows -->

## 未接入说明（待其他 lane 发布生产入口）

**WP-016 核验（2026-11-05）**：生成表头及下文分组是历史说明，非当前行状态。
起点 main `967f43c75` 为 109 ported / 57 pending / 2 approved obsolete；合并后的分支
因旧检查点 `a80ba453c` 继承 47 行映射，实际为 154 ported / 2 merged / 10 pending / 2 obsolete。
本包只核 llm_decision/semantic_dedup 的 13 行：保留 6 条既有映射（不重复计新增），
7 条无生产调用点的映射纠正为 pending；结果为 147 ported / 2 merged / 17 pending / 2 obsolete。
另 36 条继承映射不在本包验收范围，未在此签收，包括 HPIAS request 对象测试。
逐条原断言、候选用例及生产调用证据见 `LANE.md` 的 WP-016 小节；其他精确缺口见 `BLOCKERS.md`。

**a80 污染纠正（2026-11-05，C1 授权）**：child 独有 36 条中剩余 29 条（7 条已由 WP-016 纠正）
与原 writer 的 `request_carries_session_and_intent`（测试字面量未绑定生产请求类型）恢复 a80 前的
pending。C2 抽检退回的 backendKindFromConfig / parseArxivAtom / parseBatchMoveArgs 三项已在此恢复 pending。

**逐行实测（WP-102，2026-11-06，分支 `ec5aa627f` 之后）**：上段“117 / 2 / 47 / 2、10 行不同”已过时。
当前 168 行逐行为 109 ported / 0 merged / 57 pending / 2 obsolete，每行去向与 `967f43c75` 完全相同；
a80 改动的 47 行现全部为 pending（含原 10 条 writer 候选），不存在待验收的 a80 映射。本次只更正说明，未改任何行。

以下 57 个 Rust 测试已按原语义移植到 TS，但所测模块的生产调用方属于其他 lane 且尚未发布；
按 quality.md §3.3/§8 保持 `pending`，待对应 lane 接线后再改回 `ported:`。逐条证据见
[`BLOCKERS.md`](BLOCKERS.md)。统计：9（L13 真实检索后端/后端选择）+ 35（L04）+ 13（L02）= 57。
另有 2 条 `query_rewriter` 经 C1 批准为 `obsolete:dead-in-rust`（main 的审批分片，见
`migration/approvals.d/C1-app.json`）。

### L13 generative UI（`hpias.test.ts`，9 个待真实后端）

L17 已发布 `hpiasResearch`（L13 `GenerativeResearchPort`）：研究 intent 判断、350ms
后台时间线、`hpias_event` 发送与 `hpias-payloads` 生产调用已接线，`events/orchestrator/payloads`
共 13 条测试转 `ported`。剩余 9 条属于 `RetrievalHpiasResearchService`（真实 VFS 检索 + LLM
synthesis）与 backend-kind 选择；L13 `GenerativeUiExecutor` 消费方尚未合入 main，且真实检索后端
需 L12/LLM 依赖。L13 消费方现已在 main 的 `host/plugins/vfs/index.ts:219-220`，
不再以未合入 main 为阻塞；本包不核验旧检查点对这 9 行的映射。

### L04 ToolExecutor 注册表（`chat-tools.test.ts` / `memory-executor.test.ts` / `learning-overview-db.test.ts` / `tools-pure.test.ts`，35 个）

`paper_save` / `academic_search` / `knowledge` / `insight_recall` / `learning_overview` / memory 工具
在 Rust 中经 `chat_v2::tools::executor_registry::ToolExecutorRegistry` 注册。L04 registry 与
L07 `registerToolExecutors` 均已在 main。本次只发布并注册实际复用既有策略的 metadata 对象，
没有可执行的完整工具实现；按 F1 续派指令保留这 35 行 pending，不以纯模块可达冒充执行接线。

### L03 chat pipeline 消费契约（已发布，11 条已转 ported）

`MemoryService` 已发布 `extractCompactionSegment`、`applyFlushExtraction`、
`flushSegment`、`queryFlushReceipts` / `getFlushReceipt`、`cleanupFlushReceipts`、
`extractMemoryCandidates`、`extractAndStoreMemory` 与 `spawnPostWriteMaintenance`，
逐项对应 `pipeline/compaction/memory_flush.rs` 与 `auto_extractor.rs` 的 Rust 调用。
L03 仍需完成自己的 ledger/worker 调用点；本 lane 的 11 条测试已因模块从 `index.ts`
可达而标 `ported`。

### L02 LLM memory decision（WP-016：6 条保留映射，7 条 pending）

- `llm_decision.rs`：六条解析/提取测试所测代码由命令入口 → write-store → fact-decision →
  parseDecisionResponse → extractFirstJsonObject 静态可达，保留既有映射；这不是实际模型角色已发布的证明。
  `test_memory_event_from_str` 的 helper 只有测试调用，纠正为 pending，不为过门禁人为接线。
- `semantic_dedup.rs`：六条候选确实调用纯模块，但纯模块没有生产调用；维护链
  `src/service.ts:525-526` 仅 warn 后跳过。因此全部 pending，既缺自有 pass 接线，也缺 L02 角色，
  不将自有执行体未迁移仅归因为上游阻塞。
- `query_rewriter.rs`（2 个，已批准 `obsolete:dead-in-rust`）：Rust 两个调用点
  （`memory_executor.rs:528/536`）都传 `use_query_rewrite=false`，该分支在生产中不可达；
  C1 的批准已落在 `migration/approvals.d/C1-app.json`，main 的 ledger loader 合并读取该分片。

`host/plugins/llm/api.ts` 的 `singleShotCompletion` 是底层单次调用，不等同于
`call_memory_decision_raw_prompt`（模型路由/响应/取消语义见 `BLOCKERS.md` §3）；
本 lane 已定义 `MemoryDecisionCompletion` 端口并等待 L02 发布该角色入口。

### 已接线（非阻塞）

- `quick_assistant_*`：经 F2 `ctx.shell` 的 `plugin:window|*` 实现 show/hide/apply_enabled、
  bounds v3 持久化、定位与 `quick-assistant://shown`；`global-shortcut://triggered` 仅在
  `state === "Pressed"` 且 `quick_assistant.enabled !== "false"` 时 toggle。
- `evolution.rs`：`run_throttled` 与 Phase 1-5 已接入 `MemoryServiceImpl.runPostWriteMaintenance`，
  `evolution-profile.test.ts` 的 10 条测试所测模块已从入口可达。
- `insight`：本插件 `provide('insight', …)`，L15 的 13 条 `insight_*` 命令通过 `ctx.get('insight')`
  调用；`insight_run_jobs` 走 `MemoryService.runInsightJobs` → `InsightJobWorker` → `recallFts`。
- `masteryProfileSink`：本插件 `provide('masteryProfileSink', …)`，review 掌握度回流调用
  `MemoryProfileStore.upsertWeakPointFromMastery` / `removeWeakPointFromMastery`。
