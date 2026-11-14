# X6 prod-reachable / assert-parity 分发清单（main 8d7b05d14）

生成：`node scripts/electron-migration/gate-checks/audit-scan.mjs prod-reachable|assert-parity`，在 main 8d7b05d14 + X6 账本否决提交上运行。只统计 ported 行；obsolete/pending 先过滤。ID 为 TESTMAP 原 ID，不重排。

## unreachable（测试 A 已否决）

处理二选一：真实接线使符号从 register/provide 可达；或把该行改回 `pending` 并写明缺什么。不允许无意义 export、只改清单。

### L02-llm-manager（13）

- `src/chat_v2/tools/settings_models_executor.rs::tests::exposes_exact_tool_surface_with_expected_risk` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`SettingsModelsToolExecutor` (host/plugins/llm/src/settings_models_executor.ts:52)
- `src/chat_v2/tools/settings_models_executor.rs::tests::profile_add_arguments_redact_api_key_before_crossing_boundaries` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`redactCredentialArguments` (host/plugins/llm/src/settings_models_arguments.ts:123)
- `src/chat_v2/tools/settings_models_executor.rs::tests::profile_add_fields_allow_api_key_but_nothing_else_sensitive` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`MODEL_PROFILE_ADD_FIELDS` (host/plugins/llm/src/settings_models_arguments.ts:26)，`SETTINGS_GET_FIELDS` (host/plugins/llm/src/settings_models_arguments.ts:21)，`argumentsObject` (host/plugins/llm/src/settings_models_arguments.ts:109)，`argumentsObjectAllowingCredentials` (host/plugins/llm/src/settings_models_arguments.ts:113)
- `src/chat_v2/tools/settings_models_executor.rs::tests::profile_add_validation_rules` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`profileCapabilityFlags` (host/plugins/llm/src/settings_models_arguments.ts:156)，`urlsSameOrigin` (host/plugins/llm/src/settings_models_arguments.ts:180)，`validateBaseUrl` (host/plugins/llm/src/settings_models_arguments.ts:168)，`validateProviderType` (host/plugins/llm/src/settings_models_arguments.ts:175)
- `src/chat_v2/tools/settings_models_executor.rs::tests::sensitive_names_are_separator_and_case_insensitive` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`containsSensitiveIdentifier` (host/plugins/llm/src/settings_models_arguments.ts:213)
- `src/chat_v2/tools/settings_models_executor.rs::tests::request_fields_and_database_rows_both_fail_closed` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`SETTINGS_GET_FIELDS` (host/plugins/llm/src/settings_models_arguments.ts:21)，`argumentsObject` (host/plugins/llm/src/settings_models_arguments.ts:109)，`isSafeSettingKey` (host/plugins/llm/src/settings_models_arguments.ts:230)
- `src/chat_v2/tools/settings_models_executor.rs::tests::settings_values_use_exact_types_and_ranges` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`validateSettingValue` (host/plugins/llm/src/settings_models_arguments.ts:231)
- `src/chat_v2/tools/settings_models_executor.rs::tests::assignment_args_require_explicit_nullable_occ_value` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`argumentsObject` (host/plugins/llm/src/settings_models_arguments.ts:109)，`MAX_MODEL_CONFIG_ID_CHARS` (host/plugins/llm/src/settings_models_arguments.ts:15)，`MODEL_ASSIGNMENTS_SET_FIELDS` (host/plugins/llm/src/settings_models_arguments.ts:24)，`parseAssignmentSlot` (host/plugins/llm/src/settings_models_assignments.ts:15)，`requiredNullableString` (host/plugins/llm/src/settings_models_arguments.ts:190)
- `src/chat_v2/tools/settings_models_executor.rs::tests::model_directory_pagination_is_bounded` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`MAX_USIZE` (host/plugins/llm/src/settings_models_arguments.ts:20)，`optionalPositiveInteger` (host/plugins/llm/src/settings_models_arguments.ts:200)
- `src/chat_v2/tools/settings_models_executor.rs::tests::model_capability_matrix_matches_runtime_consumers` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`validateModelForSlot` (host/plugins/llm/src/settings_models_assignments.ts:50)
- `src/chat_v2/tools/settings_models_executor.rs::tests::model_directory_projection_never_contains_runtime_secrets` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`safeModelJson` (host/plugins/llm/src/settings_models_assignments.ts:74)
- `src/chat_v2/tools/settings_models_executor.rs::tests::assignment_update_is_atomic_and_occ_guarded` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`updateModelAssignmentAtomic` (host/plugins/llm/src/settings_models_assignments.ts:105)
- `src/chat_v2/tools/settings_models_executor.rs::tests::all_tool_strings_are_unicode_bounded` — TS `host/plugins/llm/tests/settings_models_executor.test.ts`；不可达符号：`MAX_TOOL_STRING_CHARS` (host/plugins/llm/src/settings_models_arguments.ts:14)，`boundJsonStrings` (host/plugins/llm/src/settings_models_arguments.ts:267)，`boundedString` (host/plugins/llm/src/settings_models_arguments.ts:258)

### L03-chat-pipeline（1）

- `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs::tests::long_memory_flush_input_is_split_without_omitting_the_middle` — TS `host/plugins/chat-pipeline/tests/memory-flush.test.ts`；不可达符号：`MEMORY_FLUSH_SEGMENT_MAX_CHARS` (host/plugins/chat-pipeline/repository/memory-flush.ts:9)

### L06-agent-orchestration（3）

- `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs::tests::test_can_handle_with_and_without_prefix` — TS `host/plugins/agent-orchestration/tests/tool-schemas.test.ts`；不可达符号：`canHandleGoalTool` (host/plugins/agent-orchestration/src/goal-tools.ts:70)
- `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs::tests::test_schema_generation` — TS `host/plugins/agent-orchestration/tests/tool-schemas.test.ts`；不可达符号：`goalToolSchemas` (host/plugins/agent-orchestration/src/goal-tools.ts:66)
- `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs::tests::test_parse_token_budget` — TS `host/plugins/agent-orchestration/tests/tool-schemas.test.ts`；不可达符号：`parseGoalTokenBudget` (host/plugins/agent-orchestration/src/goal-tools.ts:76)

### L10-notes（1）

- `src/chat_v2/tools/user_todo_executor.rs::mfjs_schema_tests::mfjs_normalizes_real_rust_builtin_tool_schemas` — TS `host/plugins/notes/tests/user-todo-executor.test.ts`；不可达符号：`getUserTodoSchemas` (host/plugins/notes/src/user-todo-schemas.ts:39)

### L14-qbank（6）

- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::build_generation_user_prompt_includes_specs_and_hint` — TS `host/plugins/qbank/tests/generation-validation.test.ts`；不可达符号：`buildGenerationInstructions` (host/plugins/qbank/src/generation-prompt.ts:21)
- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::build_generation_user_prompt_includes_knowledge_points_and_references` — TS `host/plugins/qbank/tests/generation-validation.test.ts`；不可达符号：`buildGenerationInstructions` (host/plugins/qbank/src/generation-prompt.ts:21)
- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::build_generation_user_prompt_adds_media_source_rules_only_for_transcripts` — TS `host/plugins/qbank/tests/generation-validation.test.ts`；不可达符号：`buildGenerationInstructions` (host/plugins/qbank/src/generation-prompt.ts:21)
- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::generation_instructions_preserve_long_user_requirements` — TS `host/plugins/qbank/tests/generation-validation.test.ts`；不可达符号：`buildGenerationInstructions` (host/plugins/qbank/src/generation-prompt.ts:21)
- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::build_generation_user_prompt_includes_reference_images_section` — TS `host/plugins/qbank/tests/generation-validation.test.ts`；不可达符号：`buildGenerationInstructions` (host/plugins/qbank/src/generation-prompt.ts:21)
- `src/qbank_read/tests.rs::canonical_context_reads_current_questions_and_deduplicates_materials` — TS `host/plugins/qbank/tests/qbank-read.test.ts`；不可达符号：`contextText` (host/plugins/qbank/repository/qbank-read.ts:78)，`contextWithConn` (host/plugins/qbank/repository/qbank-read.ts:26)

### L17-memory-research（1）

- `crates/dstu-research/src/hpias/orchestrator.rs::tests::spawn_from_intent_skips_non_research_intent` — TS `host/plugins/memory/tests/hpias.test.ts`；不可达符号：`shouldStartResearchSession` (host/plugins/memory/src/hpias-research.ts:41)

## assertion-deficit（report-only，不按计数阻断）

逐条对照 Rust 断言补齐；循环/完整对象 `toEqual` 已等价覆盖的写明证据，确实不适用的写明理由。不要为凑数补重复 expect。

### L01-llm-providers（39）

- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_build_gemini_request_nonstream` — Rust 11 断言 / TS 9 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:26`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_build_gemini_request_stream` — Rust 3 断言 / TS 2 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:58`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_convert_gemini_nonstream_response` — Rust 6 断言 / TS 5 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:146`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_convert_with_tools` — Rust 5 断言 / TS 3 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:163`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_usage_robustness` — Rust 8 断言 / TS 6 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:200`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_tool_response_mapping` — Rust 7 断言 / TS 6 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:217`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_multiple_content_parts` — Rust 4 断言 / TS 2 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:242`
- `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_unknown_content_part_degrades_instead_of_failing` — Rust 3 断言 / TS 2 expect，`host/plugins/llm-providers/tests/gemini-converter.test.ts:417`
- `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_short_text` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/embedding-chunker.test.ts:17`
- `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_text_no_overlap_when_single_chunk` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/embedding-chunker.test.ts:53`
- `crates/dstu-llm/src/openai_codex/manager.rs::tests::status_never_exposes_tokens` — Rust 5 断言 / TS 2 expect，`host/plugins/llm-providers/tests/codex-manager.test.ts:260`
- `crates/dstu-llm/src/openai_codex/protocol.rs::tests::responses_body_is_sanitized_for_codex` — Rust 10 断言 / TS 5 expect，`host/plugins/llm-providers/tests/codex-protocol.test.ts:53`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_emits_usage_before_done_for_official_chunk_sequence` — Rust 7 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:40`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_bare_ndjson_finish_reason_completes_at_eof` — Rust 4 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:51`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_choice_completion_keeps_event_sequence_until_done_marker` — Rust 7 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:66`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_handles_content_block_arrays` — Rust 4 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:77`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_handles_reasoning_field_variants` — Rust 5 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:82`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_build_request_keeps_nested_tool_choice_shape` — Rust 3 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:93`
- `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_passes_through_non_function_tools` — Rust 3 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:98`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_maps_reasoning_effort_and_verbosity` — Rust 3 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:50`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_maps_runtime_off_to_reasoning_none` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:56`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_converts_tools_and_tool_choice` — Rust 9 断言 / TS 8 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:139`
- `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_filters_blank_and_duplicate_tool_names` — Rust 5 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:102`
- `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_drops_tools_with_blank_flat_names` — Rust 4 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:107`
- `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_normalizes_missing_or_null_parameters` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:120`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_build_request_sanitizes_invalid_tools` — Rust 3 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-chat.test.ts:126`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_falls_back_to_terminal_tool_calls_without_duplicates` — Rust 5 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:220`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_streams_added_and_argument_deltas` — Rust 9 断言 / TS 7 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:230`
- `crates/dstu-llm/src/providers/mod.rs::tests::model_supports_prompt_cache_breakpoint_parses_gpt_versions` — Rust 13 断言 / TS 2 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:347`
- `crates/dstu-llm/src/providers/mod.rs::tests::deepseek_responses_uses_reasoning_instead_of_chat_thinking_extensions` — Rust 3 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:373`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_reports_untyped_error_objects` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:391`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_adds_tools_and_system_tail_cache_breakpoints` — Rust 8 断言 / TS 6 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:89`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow` — Rust 6 断言 / TS 4 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:163`
- `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_assistant_output_parts` — Rust 5 断言 / TS 3 expect，`host/plugins/llm-providers/tests/openai-responses.test.ts:505`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_new_generation_rewrites_enabled_thinking_to_adaptive` — Rust 3 断言 / TS 2 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:241`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_old_generation_keeps_enabled_thinking_passthrough` — Rust 2 断言 / TS 1 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:250`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_assistant_thinking_blocks_keep_signature_and_redacted` — Rust 7 断言 / TS 3 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:363`
- `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_message_level_thought_signature_attaches_to_thinking_block` — Rust 6 断言 / TS 4 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:381`
- `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers` — Rust 6 断言 / TS 4 expect，`host/plugins/llm-providers/tests/anthropic.test.ts:585`

### L02-llm-manager（16）

- `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs::tests::test_claude_generation_new_models_are_adaptive` — Rust 8 断言 / TS 1 expect，`host/plugins/llm/tests/anthropic.test.ts:12`
- `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs::tests::test_claude_generation_legacy_models_are_manual` — Rust 10 断言 / TS 3 expect，`host/plugins/llm/tests/anthropic.test.ts:22`
- `crates/dstu-llm/src/llm_manager/adapters/ernie.rs::tests::test_is_thinking_model` — Rust 6 断言 / TS 2 expect，`host/plugins/llm/tests/ernie.test.ts:90`
- `crates/dstu-llm/src/llm_manager/adapters/moonshot.rs::tests::test_k25_model_detection` — Rust 15 断言 / TS 6 expect，`host/plugins/llm/tests/moonshot.test.ts:51`
- `crates/dstu-llm/src/llm_manager/adapters/zhipu.rs::tests::test_supports_thinking` — Rust 15 断言 / TS 2 expect，`host/plugins/llm/tests/zhipu.test.ts:47`
- `crates/dstu-llm/src/llm_manager/adapters/zhipu.rs::tests::test_supports_reasoning_effort` — Rust 7 断言 / TS 2 expect，`host/plugins/llm/tests/zhipu.test.ts:67`
- `crates/dstu-llm/src/llm_manager/exam_engine.rs::tests::cancelled_hedge_engine_drops_its_stream` — Rust 4 断言 / TS 2 expect，`host/plugins/llm/tests/exam_engine.test.ts:89`
- `crates/dstu-llm/src/llm_manager/mod.rs::tests::auth_mode_defaults_for_legacy_serialized_configs` — Rust 2 断言 / TS 1 expect，`host/plugins/llm/tests/config_store.test.ts:433`
- `crates/dstu-llm/src/llm_manager/mod.rs::tests::reasoning_scope_baseline::non_reasoning_fields_stay_byte_identical_across_matrix` — Rust 2 断言 / TS 1 expect，`host/plugins/llm/tests/llm_manager_reasoning.test.ts:298`
- `crates/dstu-llm/src/llm_manager/model2_pipeline.rs::tests::deepseek_v41_image_budget_is_scoped_to_official_vision_models` — Rust 2 断言 / TS 1 expect，`host/plugins/llm/tests/model2_pipeline_input_guard.test.ts:202`
- `crates/dstu-llm/src/llm_manager/model2_pipeline.rs::tests::deepseek_chat_audit_toggle_does_not_change_the_final_request` — Rust 6 断言 / TS 5 expect，`host/plugins/llm/tests/unified_stream.test.ts:69`
- `crates/dstu-llm/src/llm_manager/model2_pipeline.rs::tests::numbered_web_search_sources_aligns_with_retrieval_block_schema` — Rust 7 断言 / TS 2 expect，`host/plugins/llm/tests/model2_pipeline_generation.test.ts:19`
- `crates/dstu-llm/src/llm_manager/routing.rs::tests::provider_body_context_window_detection` — Rust 5 断言 / TS 2 expect，`host/plugins/llm/tests/routing.test.ts:40`
- `crates/dstu-llm/src/llm_manager/routing.rs::tests::text_requests_allow_multimodal_fallbacks_but_images_require_them` — Rust 6 断言 / TS 3 expect，`host/plugins/llm/tests/routing.test.ts:80`
- `crates/dstu-llm/src/llm_manager/routing.rs::tests::purpose_model_resolution` — Rust 7 断言 / TS 5 expect，`host/plugins/llm/tests/routing.test.ts:71`
- `crates/dstu-llm/src/llm_manager/routing.rs::tests::auth_failed_only_rotates_keys_within_same_model` — Rust 6 断言 / TS 4 expect，`host/plugins/llm/tests/routing.test.ts:118`

### L03-chat-pipeline（23）

- `crates/dstu-agent/src/chat_v2/context.rs::citation_tests::sanitize_strips_local_paths_and_diagnostics_but_keeps_web_urls` — Rust 11 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/context.test.ts:41`
- `crates/dstu-agent/src/chat_v2/finalizer.rs::tests::verdict_serializes_snake_case` — Rust 6 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/finalizer.test.ts:301`
- `crates/dstu-agent/src/chat_v2/finalizer.rs::tests::g07b_try_finalize_collects_batch_manifest_from_tool_outputs` — Rust 6 断言 / TS 5 expect，`host/plugins/chat-pipeline/tests/finalizer.test.ts:454`
- `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs::tests::compaction_outcome_status_and_reason_codes` — Rust 19 断言 / TS 14 expect，`host/plugins/chat-pipeline/tests/compaction-outcome.test.ts:63`
- `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/preprocess.rs::tests::unavailable_visual_placeholder_is_never_a_reusable_artifact` — Rust 4 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/preprocess.test.ts:6`
- `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs::tests::test_p1_8_in_loop_skills_insert_after_round_last_tool_result` — Rust 10 断言 / TS 8 expect，`host/plugins/chat-pipeline/tests/skill-injection.test.ts:180`
- `crates/dstu-agent/src/chat_v2/pipeline/history.rs::skill_replay_gate_tests::gate_signal_collects_only_digest_mismatches_deduped` — Rust 8 断言 / TS 5 expect，`host/plugins/chat-pipeline/tests/skill-injection.test.ts:263`
- `crates/dstu-agent/src/chat_v2/pipeline/parallel_exec_tests.rs::cancelled_errors_are_never_retryable` — Rust 6 断言 / TS 1 expect，`host/plugins/chat-pipeline/tests/parallel-exec.test.ts:95`
- `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs::tests::failed_round_without_reported_usage_does_not_change_totals` — Rust 4 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:323`
- `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs::tests::retains_incremental_variant_text_when_adapter_drops_before_complete` — Rust 6 断言 / TS 5 expect，`host/plugins/chat-pipeline/tests/variant-adapter.test.ts:25`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_content_block_filter` — Rust 2 断言 / TS 1 expect，`host/plugins/chat-pipeline/tests/history.test.ts:29`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_adapter_tool_call_collection` — Rust 5 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/llm-adapter.test.ts:272`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_tool_call_conversion_from_message` — Rust 4 断言 / TS 3 expect，`host/plugins/chat-pipeline/tests/llm-adapter.test.ts:293`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_tool_result_info_with_duration` — Rust 3 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/pipeline-contract.test.ts:87`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_tool_results_to_messages_format` — Rust 5 断言 / TS 4 expect，`host/plugins/chat-pipeline/tests/history.test.ts:48`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_truncate_text` — Rust 4 断言 / TS 3 expect，`host/plugins/chat-pipeline/tests/pipeline-unit.test.ts:81`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_parse_api_usage_openai_format` — Rust 7 断言 / TS 6 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:19`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_parse_api_usage_deepseek_format` — Rust 6 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:38`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_parse_api_usage_partial_openai` — Rust 3 断言 / TS 2 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:46`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_parse_api_usage_anthropic_cache_read` — Rust 2 断言 / TS 1 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:51`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_parse_api_usage_responses_format` — Rust 6 断言 / TS 5 expect，`host/plugins/chat-pipeline/tests/tool-face.test.ts:54`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_runtime_facts_describes_non_interactive_shell_limits` — Rust 12 断言 / TS 10 expect，`host/plugins/chat-pipeline/tests/context.test.ts:204`
- `crates/dstu-agent/src/chat_v2/pipeline_tests.rs::test_runtime_facts_platform_contract_covers_desktop_platforms` — Rust 12 断言 / TS 4 expect，`host/plugins/chat-pipeline/tests/context.test.ts:70`

### L04-chat-session（17）

- `crates/dstu-agent/src/chat_v2/database.rs::tests::test_migrations_idempotent` — Rust 4 断言 / TS 3 expect，`host/plugins/chat/tests/database-service.test.ts:28`
- `crates/dstu-agent/src/chat_v2/database.rs::tests::test_get_statistics` — Rust 5 断言 / TS 1 expect，`host/plugins/chat/tests/database-service.test.ts:59`
- `crates/dstu-agent/src/chat_v2/error.rs::tests::test_error_to_string_conversion` — Rust 2 断言 / TS 1 expect，`host/plugins/chat/tests/error.test.ts:18`
- `crates/dstu-agent/src/chat_v2/events.rs::tests::chunk_batching_flush_holds_ordering_lock_through_delivery` — Rust 5 断言 / TS 3 expect，`host/plugins/chat/tests/events.test.ts:712`
- `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs::tests::test_block_id_validation` — Rust 4 断言 / TS 3 expect，`host/plugins/chat/tests/session-commands.test.ts:276`
- `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs::tests::test_message_id_validation` — Rust 4 断言 / TS 3 expect，`host/plugins/chat/tests/session-commands.test.ts:283`
- `crates/dstu-agent/src/chat_v2/handlers/load_session.rs::tests::test_session_id_validation` — Rust 6 断言 / TS 5 expect，`host/plugins/chat/tests/session-commands.test.ts:377`
- `crates/dstu-agent/src/chat_v2/handlers/load_session.rs::tests::loading_session_persists_retired_authority_mode_as_craft` — Rust 3 断言 / TS 2 expect，`host/plugins/chat/tests/session-commands.test.ts:387`
- `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::settings_patch_preserves_runtime_metadata_against_stale_snapshot` — Rust 12 断言 / TS 3 expect，`host/plugins/chat/tests/session-commands.test.ts:570`
- `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_session_id_format_validation` — Rust 4 断言 / TS 3 expect，`host/plugins/chat/tests/session-commands.test.ts:189`
- `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs::tests::test_remap_ids_in_value_remaps_only_exact_string_matches` — Rust 8 断言 / TS 7 expect，`host/plugins/chat/tests/snapshot.test.ts:184`
- `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_crud` — Rust 7 断言 / TS 6 expect，`host/plugins/chat/tests/sessions.test.ts:12`
- `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_session_title_locked_persists_through_update` — Rust 3 断言 / TS 2 expect，`host/plugins/chat/tests/sessions.test.ts:55`
- `crates/dstu-agent/src/chat_v2/repo.rs::tests::test_load_session_messages_page_with_role_filter` — Rust 9 断言 / TS 8 expect，`host/plugins/chat/tests/messages.test.ts:100`
- `crates/dstu-agent/src/chat_v2/repo.rs::goal_tests::goal_add_usage_accumulates` — Rust 4 断言 / TS 2 expect，`host/plugins/chat/tests/goals.test.ts:36`
- `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_line_order_and_footer_counts` — Rust 25 断言 / TS 18 expect，`host/plugins/chat/tests/session-export.test.ts:138`
- `crates/dstu-agent/src/chat_v2/session_export.rs::tests::export_empty_session_writes_header_and_zero_count_footer` — Rust 16 断言 / TS 9 expect，`host/plugins/chat/tests/session-export.test.ts:182`

### L05-agent-workspace（7）

- `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::rejects_runtime_relative_path_escapes` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/runtime-paths.test.ts:52`
- `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::restore_rejects_backup_refs_outside_backup_area` — Rust 6 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/runtime-roots.test.ts:271`
- `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::persisted_root_identity_deserializes_across_operating_systems` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/runtime-roots.test.ts:288`
- `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::assesses_windows_authorized_root_risk` — Rust 7 断言 / TS 3 expect，`host/plugins/agent-workspace/tests/runtime-paths.test.ts:67`
- `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_root_kinds_serialize_for_frontend_contract` — Rust 6 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/runtime-roots.test.ts:364`
- `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_resolve_question_image_blob_from_hash_field` — Rust 2 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/vfs-resolver.test.ts:135`
- `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_resolve_question_image_blob_from_file_id` — Rust 2 断言 / TS 1 expect，`host/plugins/agent-workspace/tests/vfs-resolver.test.ts:142`

### L06-agent-orchestration（13）

- `crates/dstu-agent/src/chat_v2/automations.rs::tests::action_type_serde_uses_snake_case` — Rust 5 断言 / TS 2 expect，`host/plugins/agent-orchestration/tests/automation-repository.test.ts:149`
- `crates/dstu-agent/src/chat_v2/automations.rs::tests::ensure_heartbeat_in_list_is_idempotent` — Rust 9 断言 / TS 8 expect，`host/plugins/agent-orchestration/tests/automation-repository.test.ts:293`
- `crates/dstu-agent/src/chat_v2/automations.rs::tests::active_run_guard_does_not_remove_a_newer_token` — Rust 5 断言 / TS 4 expect，`host/plugins/agent-orchestration/tests/automation-repository.test.ts:439`
- `crates/dstu-agent/src/chat_v2/automations.rs::tests::full_update_can_clear_nullable_agent_fields` — Rust 8 断言 / TS 5 expect，`host/plugins/agent-orchestration/tests/automation-repository.test.ts:313`
- `crates/dstu-agent/src/chat_v2/automations.rs::tests::full_update_rejects_stale_version_without_overwriting_current_value` — Rust 11 断言 / TS 9 expect，`host/plugins/agent-orchestration/tests/automation-repository.test.ts:332`
- `crates/dstu-agent/src/chat_v2/headless.rs::tests::execution_policy_blocks_non_whitelisted_calls_fail_closed` — Rust 15 断言 / TS 4 expect，`host/plugins/agent-orchestration/tests/headless.test.ts:227`
- `crates/dstu-agent/src/chat_v2/super_session/inbound.rs::tests::default_config_treats_manual_and_ilink_as_requests` — Rust 4 断言 / TS 2 expect，`host/plugins/agent-orchestration/tests/inbound.test.ts:46`
- `crates/dstu-agent/src/chat_v2/super_session/state.rs::tests::retire_metadata_shapes_and_ignores_plain_sessions` — Rust 7 断言 / TS 6 expect，`host/plugins/agent-orchestration/tests/super-session.test.ts:196`
- `crates/dstu-agent/src/chat_v2/super_session/tools_schema.rs::tests::schemas_match_names_and_deserialize` — Rust 6 断言 / TS 5 expect，`host/plugins/agent-orchestration/tests/super-session.test.ts:67`
- `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs::tests::parses_agent_fields_for_agent_turn` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-orchestration/tests/automation-tool-args.test.ts:143`
- `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs::tests::handles_expected_tool_names` — Rust 9 断言 / TS 2 expect，`host/plugins/agent-orchestration/tests/automation-tool-args.test.ts:187`
- `crates/dstu-agent/src/chat_v2/tools/session_executor.rs::tests::test_is_session_tool` — Rust 9 断言 / TS 3 expect，`host/plugins/agent-orchestration/tests/session-tools.test.ts:26`
- `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs::tests::parse_args_defaults_wait_true_and_all_fields_optional` — Rust 8 断言 / TS 3 expect，`host/plugins/agent-orchestration/tests/subagent-args.test.ts:10`

### L07-agent-skills-ptc（11）

- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::parse_top_level_requires_lists` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/requires.test.ts:14`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::parse_top_level_requires_inline_arrays` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/requires.test.ts:31`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::parse_missing_frontmatter_returns_empty` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/requires.test.ts:42`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::parses_flow_map_and_openclaw_nested_requires` — Rust 6 断言 / TS 2 expect，`host/plugins/agent-skills/tests/requires.test.ts:51`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::python_import_name_maps_common_packages` — Rust 6 断言 / TS 1 expect，`host/plugins/agent-skills/tests/requires.test.ts:57`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::partition_rejects_invalid_bin_names` — Rust 4 断言 / TS 2 expect，`host/plugins/agent-skills/tests/requires.test.ts:82`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::probe_python_packages_reports_missing_and_stdlib_found` — Rust 5 断言 / TS 3 expect，`host/plugins/agent-skills/tests/requires.test.ts:107`
- `crates/dstu-agent/src/chat_v2/skill_requires.rs::tests::format_hints_for_missing_python_packages` — Rust 6 断言 / TS 2 expect，`host/plugins/agent-skills/tests/requires.test.ts:125`
- `crates/dstu-agent/src/chat_v2/skills.rs::tests::skills_dir_deny_matches_windows_backslash_paths` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/files.test.ts:14`
- `crates/dstu-agent/src/chat_v2/skills.rs::tests::skills_dir_deny_matches_forward_slash_and_tilde_paths` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/files.test.ts:17`
- `crates/dstu-agent/src/chat_v2/skills.rs::tests::skills_dir_deny_ignores_unrelated_commands` — Rust 3 断言 / TS 1 expect，`host/plugins/agent-skills/tests/files.test.ts:32`

### L10-notes（12）

- `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::rejects_windows_drive_and_absolute` — Rust 4 断言 / TS 1 expect，`host/plugins/notes/tests/exporter.test.ts:360`
- `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_get_heading_level` — Rust 9 断言 / TS 1 expect，`host/plugins/notes/tests/markdown.test.ts:9`
- `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_extract_note_links_skips_code_regions` — Rust 7 断言 / TS 4 expect，`host/plugins/notes/tests/notes-repo.test.ts:230`
- `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_create_note_maintains_links_in_repo_layer` — Rust 4 断言 / TS 3 expect，`host/plugins/notes/tests/notes-repo.test.ts:317`
- `crates/dstu-vfs/src/vfs/repos/note_review_tests.rs::save_as_receipt_failure_rolls_back_copy_folder_history_and_identity` — Rust 5 断言 / TS 4 expect，`host/plugins/notes/tests/note-storage.test.ts:340`
- `src/chat_v2/tools/canvas_executor.rs::tests::test_can_handle` — Rust 17 断言 / TS 2 expect，`host/plugins/notes/tests/canvas-executor.test.ts:97`
- `src/cmd/notes.rs::tests::decode_markdown_bytes_strips_utf8_bom` — Rust 2 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:15`
- `src/cmd/notes.rs::tests::decode_markdown_bytes_supports_utf16le` — Rust 2 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:18`
- `src/cmd/notes.rs::tests::split_leading_heading_requires_leading_h1` — Rust 4 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:32`
- `src/cmd/notes.rs::tests::is_generic_note_title_detects_placeholder` — Rust 4 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:46`
- `src/cmd/notes.rs::tests::is_generic_note_title_detects_opaque_document_ids` — Rust 5 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:49`
- `src/cmd/notes.rs::tests::is_generic_note_title_allows_real_names` — Rust 4 断言 / TS 1 expect，`host/plugins/notes/tests/import-markdown.test.ts:54`

### L11-vfs-repos（4）

- `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_folder_depth_limit` — Rust 2 断言 / TS 1 expect，`host/plugins/vfs-repos/tests/folders.test.ts:106`
- `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_stats` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs-repos/tests/path-cache.test.ts:72`
- `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::list_and_single_reads_hydrate_group_materials_without_duplicating_membership` — Rust 10 断言 / TS 8 expect，`host/plugins/vfs-repos/tests/questions.test.ts:157`
- `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_concurrent_create_same_hash` — Rust 6 断言 / TS 5 expect，`host/plugins/vfs-repos/tests/resources.test.ts:98`

### L12-vfs-index（3）

- `crates/dstu-vfs/src/lance_vector_store.rs::tests::rows_to_retrieved_input_dedup_semantics` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs-index/tests/lance-vector-store.test.ts:114`
- `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::rrf_fuses_same_unit_without_comparing_raw_scores` — Rust 4 断言 / TS 3 expect，`host/plugins/vfs-index/tests/retrieval-planner.test.ts:116`
- `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::mmr_diversifies_across_resources` — Rust 4 断言 / TS 3 expect，`host/plugins/vfs-index/tests/retrieval-planner.test.ts:157`

### L13-vfs-api（20）

- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_normalize_path` — Rust 6 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:16`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_parent_path` — Rust 9 断言 / TS 2 expect，`host/plugins/vfs/tests/paths.test.ts:19`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_path_name` — Rust 4 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:29`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_normal` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:90`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_traversal_attack` — Rust 7 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:95`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_resource_type_all_prefixes` — Rust 9 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:106`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_resource_type_invalid` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:109`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_resource_id_true` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:110`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_resource_id_false` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/paths.test.ts:111`
- `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_resource_id_length_limit` — Rust 4 断言 / TS 2 expect，`host/plugins/vfs/tests/paths.test.ts:112`
- `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_get_resource_type_from_id` — Rust 8 断言 / TS 3 expect，`host/plugins/vfs/tests/paths.test.ts:134`
- `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_is_valid_resource_id` — Rust 5 断言 / TS 2 expect，`host/plugins/vfs/tests/paths.test.ts:138`
- `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_is_virtual_path_type` — Rust 7 断言 / TS 2 expect，`host/plugins/vfs/tests/paths.test.ts:147`
- `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_serialization` — Rust 6 断言 / TS 3 expect，`host/plugins/vfs/tests/paths.test.ts:155`
- `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_serialization` — Rust 8 断言 / TS 1 expect，`host/plugins/vfs/tests/dstu-types.test.ts:16`
- `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_deserialization` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/dstu-types.test.ts:22`
- `crates/dstu-vfs/src/vfs/database.rs::tests::test_get_statistics` — Rust 8 断言 / TS 1 expect，`host/plugins/vfs/tests/database.test.ts:68`
- `crates/dstu-vfs/src/vfs/database.rs::tests::test_folders_indexes_created` — Rust 2 断言 / TS 1 expect，`host/plugins/vfs/tests/database.test.ts:107`
- `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_subject_columns_removed` — Rust 3 断言 / TS 1 expect，`host/plugins/vfs/tests/database.test.ts:139`
- `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_009_path_cache_table` — Rust 8 断言 / TS 4 expect，`host/plugins/vfs/tests/database.test.ts:142`

### L14-qbank（22）

- `crates/dstu-qbank/src/qbank_authoring_service/tests.rs::selected_source_ranges_merge_page_evidence_without_losing_earlier_pages` — Rust 3 断言 / TS 2 expect，`host/plugins/qbank/tests/authoring.test.ts:203`
- `crates/dstu-qbank/src/qbank_generation/types.rs::tests::normalize_escaped_text_keeps_latex_commands` — Rust 4 断言 / TS 1 expect，`host/plugins/qbank/tests/generation-validation.test.ts:86`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::test_parse_verdict_and_score` — Rust 4 断言 / TS 2 expect，`host/plugins/qbank/tests/grading-prompts.test.ts:180`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::test_parse_verdict_and_score_takes_last_match` — Rust 2 断言 / TS 1 expect，`host/plugins/qbank/tests/grading-prompts.test.ts:189`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::persist_grade_first_verdict_null_to_true_counts_once` — Rust 9 断言 / TS 7 expect，`host/plugins/qbank/tests/grading-pipeline.test.ts:256`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::persist_grade_false_to_true_increments_correct_count` — Rust 11 断言 / TS 7 expect，`host/plugins/qbank/tests/grading-pipeline.test.ts:283`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::persist_grade_true_to_false_decrements_correct_count` — Rust 11 断言 / TS 7 expect，`host/plugins/qbank/tests/grading-pipeline.test.ts:308`
- `crates/dstu-qbank/src/qbank_grading/pipeline.rs::tests::n13_draft_feedback_preserves_score_counters_and_mastery` — Rust 12 断言 / TS 8 expect，`host/plugins/qbank/tests/grading-pipeline.test.ts:333`
- `crates/dstu-qbank/src/qbank_legacy_reconcile.rs::tests::all_deleted_canonical_marker_never_recreates_preview_cards` — Rust 11 断言 / TS 9 expect，`host/plugins/qbank/tests/legacy.test.ts:76`
- `crates/dstu-qbank/src/qbank_legacy_reconcile.rs::tests::selected_migration_is_idempotent_and_preserves_page_assets` — Rust 14 断言 / TS 13 expect，`host/plugins/qbank/tests/legacy.test.ts:145`
- `crates/dstu-qbank/src/qbank_management/tests.rs::list_structure_exposes_versions_and_canonical_member_order` — Rust 14 断言 / TS 3 expect，`host/plugins/qbank/tests/management.test.ts:74`
- `crates/dstu-qbank/src/qbank_management/tests.rs::delete_unused_materials_is_reference_safe_occ_and_atomic` — Rust 11 断言 / TS 7 expect，`host/plugins/qbank/tests/management.test.ts:225`
- `crates/dstu-qbank/src/qbank_practice.rs::tests::grading_uses_frozen_answer_even_after_source_changes_or_is_deleted` — Rust 3 断言 / TS 2 expect，`host/plugins/qbank/tests/practice.test.ts:383`
- `crates/dstu-qbank/src/question_bank_service.rs::tests::test_compute_streak_days` — Rust 6 断言 / TS 5 expect，`host/plugins/qbank/tests/statistics.test.ts:86`
- `crates/dstu-qbank/src/question_bank_service.rs::tests::regrade_submission_flips_latest_without_double_counting` — Rust 14 断言 / TS 11 expect，`host/plugins/qbank/tests/questions.test.ts:305`
- `crates/dstu-qbank/src/question_bank_service.rs::tests::apply_submission_verdict_counts_and_rowsync` — Rust 35 断言 / TS 17 expect，`host/plugins/qbank/tests/questions.test.ts:409`
- `src/qbank_grading/image_answer/tests.rs::reads_synced_image_answer_after_file_id_deduplication` — Rust 10 断言 / TS 9 expect，`host/plugins/qbank/tests/grading-images.test.ts:67`
- `tests/mastery_qbank_correction.rs::compensation_entry_interops_with_product_written_verdict_chain` — Rust 13 断言 / TS 12 expect，`host/plugins/qbank/tests/questions.test.ts:472`
- `tests/qbank_verdict_three_paths.rs::legacy_question_without_submission_rows_still_counts_into_daily` — Rust 8 断言 / TS 7 expect，`host/plugins/qbank/tests/verdict-three-paths.test.ts:232`
- `tests/qbank_verdict_three_paths.rs::ai_decided_verdict_manual_flip_converges_to_manual_method` — Rust 9 断言 / TS 8 expect，`host/plugins/qbank/tests/verdict-three-paths.test.ts:327`
- `tests/qbank_verdict_three_paths.rs::true_to_false_regrade_clamps_correct_count_at_zero` — Rust 5 断言 / TS 4 expect，`host/plugins/qbank/tests/verdict-three-paths.test.ts:352`
- `tests/qbank_verdict_three_paths.rs::regrade_guard_rejects_stale_or_unknown_submission_without_side_effects` — Rust 10 断言 / TS 9 expect，`host/plugins/qbank/tests/verdict-three-paths.test.ts:384`

### L15-review-analytics（8）

- `crates/dstu-anki/src/fsrs_review_service.rs::tests::enqueue_result_and_event_cards_distinguish_new_from_skipped_states` — Rust 36 断言 / TS 33 expect，`host/plugins/review/tests/fsrs-review.test.ts:648`
- `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_rejects_card_that_became_diagnostic_without_mutating_state_or_logs` — Rust 7 断言 / TS 6 expect，`host/plugins/review/tests/fsrs-review.test.ts:794`
- `crates/dstu-anki/src/fsrs_review_service.rs::tests::due_and_enqueue_serialize_complete_template_metadata_with_legacy_defaults` — Rust 22 断言 / TS 16 expect，`host/plugins/review/tests/fsrs-review.test.ts:1289`
- `crates/dstu-learning/src/study_loop/study_time.rs::tests::validation_rejects_bad_seconds_and_far_dates` — Rust 9 断言 / TS 5 expect，`host/plugins/review/tests/study-time.test.ts:32`
- `src/cmd/fsrs_review.rs::tests::enqueue_changed_payload_contains_only_new_state_with_card_content` — Rust 6 断言 / TS 5 expect，`host/plugins/review/tests/fsrs-events.test.ts:59`
- `src/mastery/service/tests.rs::qbank_verdict_correction_false_to_true_recomputes_state` — Rust 11 断言 / TS 9 expect，`host/plugins/review/tests/mastery.test.ts:68`
- `src/mastery/service/tests.rs::qbank_verdict_correction_is_idempotent_and_supports_reflip` — Rust 11 断言 / TS 10 expect，`host/plugins/review/tests/mastery.test.ts:83`
- `src/mastery/service/tests.rs::remote_tombstones_rebuild_zero_state_and_remove_weak_point` — Rust 4 断言 / TS 3 expect，`host/plugins/review/tests/mastery.test.ts:32`

### L16-anki（18）

- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_duplicate_cloze_index_allowed_and_label_truncated` — Rust 3 断言 / TS 2 expect，`host/plugins/anki/tests/image-occlusion.test.ts:51`
- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_to_pixel_boxes_exact_conversion` — Rust 3 断言 / TS 2 expect，`host/plugins/anki/tests/image-occlusion.test.ts:61`
- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_build_card_fields_cloze_text_and_occlusion_json` — Rust 7 断言 / TS 6 expect，`host/plugins/anki/tests/image-occlusion.test.ts:72`
- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_occlusion_image_ref_from_fields_missing_or_invalid` — Rust 3 断言 / TS 1 expect，`host/plugins/anki/tests/image-occlusion.test.ts:93`
- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_occlusion_image_ref_from_fields_rejects_vlm_pending_placeholder` — Rust 3 断言 / TS 2 expect，`host/plugins/anki/tests/image-occlusion.test.ts:97`
- `crates/dstu-anki/src/anki_image_occlusion.rs::tests::test_parse_vlm_occlusion_boxes_valid_json` — Rust 6 断言 / TS 5 expect，`host/plugins/anki/tests/image-occlusion.test.ts:108`
- `crates/dstu-anki/src/apkg_importer_service.rs::tests::external_apkg_env_smoke` — Rust 55 断言 / TS 10 expect，`host/plugins/anki/tests/apkg-importer.test.ts:1947`
- `crates/dstu-anki/src/streaming_anki_service.rs::tests::extract_fields_required_missing_without_default_is_validation_error` — Rust 2 断言 / TS 1 expect，`host/plugins/anki/tests/streaming-anki.test.ts:315`
- `crates/dstu-anki/src/streaming_anki_service.rs::tests::expand_wrapper_payloads_expands_wrapper_and_repairs_truncation` — Rust 13 断言 / TS 9 expect，`host/plugins/anki/tests/streaming-anki.test.ts:789`
- `crates/dstu-anki/src/streaming_anki_service.rs::tests::response_format_injection_matrix_for_service_options` — Rust 4 断言 / TS 3 expect，`host/plugins/anki/tests/streaming-anki.test.ts:819`
- `src/cmd/anki_connect.rs::save_anki_cards_semantics_tests::real_id_collision_cannot_overwrite_card_from_another_document` — Rust 5 断言 / TS 2 expect，`host/plugins/anki/tests/save-anki-cards.test.ts:105`
- `src/cmd/anki_connect.rs::save_anki_cards_semantics_tests::save_response_serializes_camel_case` — Rust 9 断言 / TS 6 expect，`host/plugins/anki/tests/save-anki-cards.test.ts:251`
- `src/cmd/anki_connect.rs::save_anki_cards_semantics_tests::save_changed_payload_uses_persisted_ids_in_stable_deduplicated_order` — Rust 3 断言 / TS 1 expect，`host/plugins/anki/tests/save-anki-cards.test.ts:270`
- `src/cmd/apkg_import.rs::tests::rejects_blank_path_as_structured_validation_error` — Rust 2 断言 / TS 1 expect，`host/plugins/anki/tests/media.test.ts:61`
- `src/cmd/apkg_import.rs::tests::rejects_missing_path_as_structured_not_found_error` — Rust 2 断言 / TS 1 expect，`host/plugins/anki/tests/media.test.ts:64`
- `src/cmd/apkg_import.rs::tests::rejects_directory_as_structured_validation_error` — Rust 2 断言 / TS 1 expect，`host/plugins/anki/tests/media.test.ts:67`
- `tests/anki_ai_native_integration.rs::route_decision_priority_chain_is_forced_then_llm_then_heuristic` — Rust 11 断言 / TS 10 expect，`host/plugins/anki/tests/anki-ai-native-chatanki-integration.test.ts:399`
- `tests/anki_ai_native_integration.rs::retemplate_strategy_parses_fill_missing_llm_and_rejects_unknown` — Rust 3 断言 / TS 2 expect，`host/plugins/anki/tests/anki-ai-native-chatanki-integration.test.ts:479`

### L17-memory-research（4）

- `crates/dstu-memory/src/memory/auto_extractor.rs::tests::test_parse_extraction_response_full_garbage` — Rust 2 断言 / TS 1 expect，`host/plugins/memory/tests/auto-extractor.test.ts:33`
- `crates/dstu-memory/src/memory/config.rs::tests::test_evolution_tuning_key_constants_and_defaults` — Rust 13 断言 / TS 7 expect，`host/plugins/memory/tests/config.test.ts:50`
- `crates/dstu-memory/src/memory/config.rs::tests::test_auto_extract_frequency` — Rust 12 断言 / TS 11 expect，`host/plugins/memory/tests/config.test.ts:62`
- `crates/dstu-research/src/hpias/payloads.rs::tests::build_pipeline_timeline_includes_lifecycle_events` — Rust 5 断言 / TS 1 expect，`host/plugins/memory/tests/hpias.test.ts:83`

### L18-media-docs（31）

- `crates/dstu-docs/src/document_parser.rs::tests::test_txt_support` — Rust 2 断言 / TS 1 expect，`host/plugins/media/tests/document-parser.test.ts:31`
- `crates/dstu-docs/src/document_parser.rs::tests::test_txt_with_unicode` — Rust 2 断言 / TS 1 expect，`host/plugins/media/tests/document-parser.test.ts:37`
- `crates/dstu-docs/src/document_parser.rs::tests::test_md_support` — Rust 2 断言 / TS 1 expect，`host/plugins/media/tests/document-parser.test.ts:43`
- `crates/dstu-docs/src/document_parser.rs::tests::test_epub_extract_text_from_bytes` — Rust 4 断言 / TS 3 expect，`host/plugins/media/tests/document-parser.test.ts:306`
- `crates/dstu-docs/src/document_parser.rs::tests::test_epub_extension_case_insensitive` — Rust 2 断言 / TS 1 expect，`host/plugins/media/tests/document-parser.test.ts:325`
- `crates/dstu-media/src/media/bilibili.rs::tests::link_items_are_created_reused_and_never_decoded` — Rust 17 断言 / TS 16 expect，`host/plugins/media/tests/bilibili-link-items.test.ts:110`
- `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::stream_ack_sequence_limit_and_drop_cancellation` — Rust 9 断言 / TS 8 expect，`host/plugins/media/tests/bilibili-bridge-hub.test.ts:121`
- `crates/dstu-media/src/media/ledger.rs::tests::tallies_questions_by_resource_ids_and_assembles_in_request_order` — Rust 14 断言 / TS 9 expect，`host/plugins/media/tests/media-ledger.test.ts:67`
- `crates/dstu-media/src/media/library.rs::tests::lists_only_live_audio_video_files` — Rust 15 断言 / TS 14 expect，`host/plugins/media/tests/media-library.test.ts:75`
- `crates/dstu-media/src/voice_input.rs::tests::protocol_follows_model_family` — Rust 7 断言 / TS 5 expect，`host/plugins/media/tests/asr-models.test.ts:18`
- `src/chat_v2/tools/docx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:49`
- `src/chat_v2/tools/docx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:60`
- `src/chat_v2/tools/docx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:71`
- `src/chat_v2/tools/docx_executor.rs::tests::test_sensitivity_level` — Rust 4 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:82`
- `src/chat_v2/tools/docx_executor.rs::tests::test_sensitivity_level` — Rust 4 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:93`
- `src/chat_v2/tools/docx_executor.rs::tests::test_sensitivity_level` — Rust 4 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:104`
- `src/chat_v2/tools/office_fidelity_executor.rs::tests::preflight_for_edit_plain_xlsx_has_no_gate_features` — Rust 4 断言 / TS 3 expect，`host/plugins/media/tests/office-fidelity.test.ts:121`
- `src/chat_v2/tools/office_output.rs::tests::edit_cells_operation_uses_edit_semantics_not_create` — Rust 3 断言 / TS 2 expect，`host/plugins/media/tests/office-output.test.ts:36`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:49`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:60`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_can_handle` — Rust 8 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:71`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_sensitivity_level` — Rust 5 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:82`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_sensitivity_level` — Rust 5 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:93`
- `src/chat_v2/tools/pptx_executor.rs::tests::test_sensitivity_level` — Rust 5 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:104`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_can_handle` — Rust 9 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:49`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_can_handle` — Rust 9 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:60`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_can_handle` — Rust 9 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:71`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_sensitivity_level` — Rust 6 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:82`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_sensitivity_level` — Rust 6 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:93`
- `src/chat_v2/tools/xlsx_executor.rs::tests::test_sensitivity_level` — Rust 6 断言 / TS 2 expect，`host/plugins/media/tests/office-executors.test.ts:104`
- `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_preflight_blocks_macro_workbook` — Rust 4 断言 / TS 3 expect，`host/plugins/media/tests/office-executors.test.ts:208`

### L20-sync（15）

- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::decode_payload_accepts_plaintext_when_encryption_disabled` — Rust 3 断言 / TS 2 expect，`host/plugins/sync/tests/payload.test.ts:23`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::sequence_gap_download_allows_publication_after_listing` — Rust 4 断言 / TS 3 expect，`host/plugins/sync/tests/remote-protocol.test.ts:358`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::regression_c4_dedupe_distinct_kept` — Rust 4 断言 / TS 2 expect，`host/plugins/sync/tests/remote-protocol.test.ts:282`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_parse_version_from_key_invalid` — Rust 4 断言 / TS 1 expect，`host/plugins/sync/tests/remote-protocol.test.ts:309`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_reset_sync_baseline_after_restore` — Rust 7 断言 / TS 5 expect，`host/plugins/sync/tests/change-log.test.ts:144`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::remote_resource_apply_strips_and_resets_local_vector_index_lifecycle` — Rust 11 断言 / TS 10 expect，`host/plugins/sync/tests/apply.test.ts:1655`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::remote_business_rows_keep_multimodal_index_fields_local` — Rust 3 断言 / TS 2 expect，`host/plugins/sync/tests/apply.test.ts:1728`
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::test_get_change_log_stats` — Rust 3 断言 / TS 1 expect，`host/plugins/sync/tests/change-log.test.ts:210`
- `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_progress_builders` — Rust 11 断言 / TS 6 expect，`host/plugins/sync/tests/progress.test.ts:16`
- `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_sync_progress_with_methods` — Rust 4 断言 / TS 1 expect，`host/plugins/sync/tests/progress.test.ts:31`
- `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_progress_tracker` — Rust 4 断言 / TS 2 expect，`host/plugins/sync/tests/progress.test.ts:67`
- `crates/dstu-sync/src/data_governance/sync/progress.rs::tests::test_progress_tracker_fail` — Rust 2 断言 / TS 1 expect，`host/plugins/sync/tests/progress.test.ts:75`
- `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::bad_or_future_deleted_at_is_skipped_and_never_advances_watermark` — Rust 7 断言 / TS 5 expect，`host/plugins/sync-support/tests/tombstone.test.ts:359`
- `src/data_governance/commands_sync.rs::tests::count_unresolved_conflicts_reports_groups_and_rows` — Rust 2 断言 / TS 1 expect，`host/plugins/sync/tests/conflicts.test.ts:50`
- `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::bad_or_future_deleted_at_is_skipped_and_never_advances_watermark` — Rust 7 断言 / TS 5 expect，`host/plugins/sync-support/tests/tombstone.test.ts:359`

### L21-backup-governance（79）

- `crates/dstu-sync/src/backup_job_manager.rs::tests::incremental_disabled_message_is_english_and_aligned` — Rust 3(+1 cfg) 断言 / TS 2 expect，`host/plugins/backup/tests/jobs.test.ts:46`（差额仅来自 #[cfg] 门控断言）
- `crates/dstu-sync/src/cloud_config_commands.rs::tests::ftp_platform_error_has_stable_code_and_shared_diagnostic` — Rust 6 断言 / TS 5 expect，`host/plugins/backup/tests/cloud-config.test.ts:114`
- `crates/dstu-sync/src/cloud_config_commands.rs::tests::s3_platform_error_has_stable_code_independent_of_message` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/cloud-config.test.ts:127`
- `crates/dstu-sync/src/cloud_config_commands.rs::tests::android_rejects_ftp_on_save_and_persists_nothing` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/cloud-config.test.ts:144`
- `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_is_sensitive_file` — Rust 6 断言 / TS 2 expect，`host/plugins/backup/tests/assets.test.ts:39`
- `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::test_restore_assets_with_progress_skips_untrusted_executable_assets` — Rust 6 断言 / TS 4 expect，`host/plugins/backup/tests/assets.test.ts:234`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::backup_incremental_create_returns_removed_error` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/mod-behavior.test.ts:35`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::restore_rejects_legacy_incremental_manifest` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/mod-behavior.test.ts:46`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::backup_crypto_keys_excludes_codex_oauth_session` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/backup-manager.test.ts:72`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::root_crypto_and_audit_are_found_when_manager_receives_active_slot` — Rust 5 断言 / TS 2 expect，`host/plugins/backup/tests/backup-manager.test.ts:89`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_list_backups_overrides_manifest_backup_id_with_dir_name` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/manifest.test.ts:49`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_backup_and_restore_single_database` — Rust 5 断言 / TS 4 expect，`host/plugins/backup/tests/backup-manager.test.ts:108`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_backup_full_rejects_missing_core_database` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/mod-behavior.test.ts:95`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::persistent_registry_marks_user_skills_untrusted_executable` — Rust 5 断言 / TS 1 expect，`host/plugins/backup/tests/manifest.test.ts:95`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::active_data_space_settings_are_manifested_with_restore_scope` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/manifest.test.ts:113`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::crypto_tamper_fails_even_if_manifest_hash_is_rewritten` — Rust 4 断言 / TS 2 expect，`host/plugins/backup/tests/backup-manager.test.ts:234`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::corrupted_audit_database_fails_integrity_after_hash_rewrite` — Rust 6 断言 / TS 2 expect，`host/plugins/backup/tests/backup-manager.test.ts:267`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_reverts_data_to_backup_state` — Rust 6 断言 / TS 2 expect，`host/plugins/backup/tests/backup-manager.test.ts:315`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_integrity_check_passes_on_restored_db` — Rust 5 断言 / TS 4 expect，`host/plugins/backup/tests/backup-manager.test.ts:329`
- `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::test_restore_schema_version_matches_backup_metadata` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/backup-manager.test.ts:282`
- `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::import_sealed_zip_with_wrong_password_fails_before_touching_target` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/portable-precheck.test.ts:135`
- `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::untrusted_user_skills_are_quarantined_not_written_to_restore_target` — Rust 7 断言 / TS 6 expect，`host/plugins/backup/tests/restore-plan.test.ts:73`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_excludes_crypto_secrets` — Rust 9 断言 / TS 7 expect，`host/plugins/backup/tests/zip.test.ts:66`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_unencrypted_export_excludes_user_skills` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/zip.test.ts:95`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_nonexistent_dir` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/zip.test.ts:132`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_invalid_compression_level` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/zip.test.ts:139`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_from_zip` — Rust 10 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:147`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_never_skips_manifest_json` — Rust 3 断言 / TS 1 expect，`host/plugins/backup/tests/zip.test.ts:358`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_encrypted_zip_requires_password_before_touching_target` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:485`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct` — Rust 6 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:233`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_non_resumable_import_encrypted_zip_fails_early_without_password` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:215`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_non_resumable_progress_import_encrypted_zip_fails_early_without_password` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/zip.test.ts:555`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_export_cancel_token_set_midway_stops_export` — Rust 4 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:254`
- `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::test_import_cancel_midway_extract_leaves_no_partial_files` — Rust 5 断言 / TS 2 expect，`host/plugins/backup/tests/zip.test.ts:301`
- `src/data_governance/commands.rs::tests::resolve_target_and_pending_returns_zero_when_latest_reached` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/paths.test.ts:58`
- `src/data_governance/commands.rs::tests::resolve_target_and_pending_prefers_status_target_version` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/paths.test.ts:65`
- `src/data_governance/commands.rs::tests::test_infer_database_mistakes` — Rust 6 断言 / TS 1 expect，`host/plugins/backup/tests/paths.test.ts:88`
- `src/data_governance/commands.rs::tests::test_infer_database_vfs` — Rust 7 断言 / TS 1 expect，`host/plugins/backup/tests/paths.test.ts:94`
- `src/data_governance/commands_restore.rs::tests::pre_cutover_interruption_is_retryable_and_second_publish_commits_lease` — Rust 16 断言 / TS 14 expect，`host/plugins/backup/tests/restore.test.ts:221`
- `src/data_governance/commands_restore.rs::tests::post_cutover_failure_audit_details_carry_cutover_committed_and_close_started_row` — Rust 7 断言 / TS 4 expect，`host/plugins/backup/tests/restore.test.ts:258`
- `src/data_governance/commands_restore.rs::tests::terminal_restore_job_can_never_flip_to_success` — Rust 10 断言 / TS 4 expect，`host/plugins/backup/tests/restore.test.ts:300`
- `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue1_restore_old_backup_then_migrate_reaches_latest` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1102`
- `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue6_incremental_create_returns_removed_error` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1320`
- `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue6_incremental_restore_silently_restores_nothing` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1333`
- `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_issue10_checkpoint_then_write_then_backup_may_lose_data` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1403`
- `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_initialization_preserves_existing_data` — Rust 3 断言 / TS 1 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1554`
- `src/data_governance/migration_tests.rs::tests::test_full_migration_from_empty_database` — Rust 10 断言 / TS 9 expect，`host/plugins/backup/tests/migration-behavior.test.ts:388`
- `src/data_governance/migration_tests.rs::tests::test_vfs_database_full_migration` — Rust 7 断言 / TS 6 expect，`host/plugins/backup/tests/migration-behavior.test.ts:406`
- `src/data_governance/migration_tests.rs::tests::test_chat_v2_database_full_migration` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:418`
- `src/data_governance/migration_tests.rs::tests::test_llm_usage_database_full_migration` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:429`
- `src/data_governance/migration_tests.rs::tests::test_mistakes_database_full_migration` — Rust 5 断言 / TS 4 expect，`host/plugins/backup/tests/migration-behavior.test.ts:438`
- `src/data_governance/migration_tests.rs::tests::test_run_all_idempotency` — Rust 6 断言 / TS 4 expect，`host/plugins/backup/tests/migration-behavior.test.ts:459`
- `src/data_governance/migration_tests.rs::tests::test_run_all_stops_on_dependency_failure` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:471`
- `src/data_governance/migration_tests.rs::tests::test_dependency_not_satisfied_error` — Rust 3 断言 / TS 1 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:121`
- `src/data_governance/migration_tests.rs::tests::test_full_dependency_chain_migration` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/migration-behavior.test.ts:553`
- `src/data_governance/migration_tests.rs::tests::test_audit_log_table_initialization` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:558`
- `src/data_governance/migration_tests.rs::tests::test_audit_log_records_migration_complete` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:567`
- `src/data_governance/migration_tests.rs::tests::test_audit_log_records_migration_failed` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:579`
- `src/data_governance/migration_tests.rs::tests::test_schema_registry_aggregation_after_migration` — Rust 5 断言 / TS 2 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:174`
- `src/data_governance/migration_tests.rs::tests::test_complete_initialization_flow` — Rust 6 断言 / TS 5 expect，`host/plugins/backup/tests/migration-behavior.test.ts:626`
- `src/data_governance/migration_tests.rs::tests::test_migration_set_properties` — Rust 8 断言 / TS 6 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:63`
- `src/data_governance/tests.rs::integration_tests::test_vfs_full_migration` — Rust 8 断言 / TS 7 expect，`host/plugins/backup/tests/migration-behavior.test.ts:830`
- `src/data_governance/tests.rs::integration_tests::test_chat_v2_full_migration` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/migration-behavior.test.ts:843`
- `src/data_governance/tests.rs::integration_tests::test_mistakes_full_migration` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:853`
- `src/data_governance/tests.rs::integration_tests::test_llm_usage_full_migration` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:864`
- `src/data_governance/tests.rs::integration_tests::test_run_all_migrations` — Rust 9 断言 / TS 5 expect，`host/plugins/backup/tests/migration-behavior.test.ts:873`
- `src/data_governance/tests.rs::integration_tests::test_dependency_not_satisfied_error` — Rust 3 断言 / TS 1 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:121`
- `src/data_governance/tests.rs::integration_tests::test_full_dependency_chain_migration` — Rust 3 断言 / TS 1 expect，`host/plugins/backup/tests/migration-behavior.test.ts:553`
- `src/data_governance/tests.rs::integration_tests::test_migration_report_content` — Rust 5 断言 / TS 4 expect，`host/plugins/backup/tests/migration-behavior.test.ts:996`
- `src/data_governance/tests.rs::integration_tests::test_schema_registry_aggregation` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:162`
- `src/data_governance/tests.rs::integration_tests::test_full_initialization` — Rust 6 断言 / TS 5 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1011`
- `src/data_governance/tests.rs::integration_tests::test_audit_log_initialization` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1027`
- `src/data_governance/tests.rs::integration_tests::test_audit_log_migration_record` — Rust 2 断言 / TS 1 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1035`
- `src/data_governance/tests.rs::integration_tests::test_migration_idempotency` — Rust 5 断言 / TS 3 expect，`host/plugins/backup/tests/migration-behavior.test.ts:1055`
- `src/data_governance/tests.rs::integration_tests::test_migration_set_properties` — Rust 12 断言 / TS 6 expect，`host/plugins/backup/tests/migrations-metadata.test.ts:63`
- `tests/restore_domain_plan_tests.rs::audit_complete_domain_restores_via_manifest_plan_consumer` — Rust 3 断言 / TS 2 expect，`host/plugins/backup/tests/restore-domain-plan.test.ts:172`
- `tests/restore_domain_plan_tests.rs::r7_cancelled_restore_before_cutover_leaves_no_lease_and_full_retry_succeeds` — Rust 12 断言 / TS 8 expect，`host/plugins/backup/tests/restore-domain-plan.test.ts:277`
- `tests/zip_export_import_restore_tests.rs::encrypted_zip_wrong_password_never_touches_target_slot` — Rust 4 断言 / TS 3 expect，`host/plugins/backup/tests/zip-integration.test.ts:87`
- `tests/zip_export_import_restore_tests.rs::stored_password_resolution_selects_portable_or_encrypted_export` — Rust 11 断言 / TS 8 expect，`host/plugins/backup/tests/zip-integration.test.ts:187`

### L22-app-commands（10）

- `tests/sync_r10_android.rs::lease_activation_commit_requires_matching_backup_id_and_active_dir` — Rust 8 断言 / TS 7 expect，`host/plugins/integration/tests/data-space-cutover.test.ts:99`
- `tests/sync_r11_repo_check.rs::resumable_provider_retries_from_partial_and_reports_green` — Rust 5 断言 / TS 3 expect，`host/plugins/integration/tests/repo-check.test.ts:244`
- `tests/sync_r11_repo_check.rs::exhausted_resumable_retries_stay_incomplete` — Rust 5 断言 / TS 4 expect，`host/plugins/integration/tests/repo-check.test.ts:259`
- `tests/sync_r12_backup_lease.rs::concurrent_devices_elect_exactly_one_committed_holder` — Rust 7 断言 / TS 6 expect，`host/plugins/integration/tests/backup-lease.test.ts:84`
- `tests/sync_r12_backup_lease.rs::source_lock_backup_lease_has_zero_production_wiring` — Rust 13 断言 / TS 11 expect，`host/plugins/integration/tests/sync-r12-locks.test.ts:270`
- `tests/sync_r12_delta_gc.rs::r12_source_lock_delta_gc_has_zero_production_wiring` — Rust 19 断言 / TS 11 expect，`host/plugins/integration/tests/sync-r12-locks.test.ts:155`
- `tests/sync_r12_delta_inventory.rs::r12_source_lock_inventory_has_no_production_callers` — Rust 9 断言 / TS 7 expect，`host/plugins/integration/tests/sync-r12-locks.test.ts:186`
- `tests/sync_r12_delta_restore.rs::r12_source_lock_delta_restore_has_zero_production_wiring` — Rust 24 断言 / TS 12 expect，`host/plugins/integration/tests/sync-r12-locks.test.ts:207`
- `tests/sync_r12_delta_upload.rs::r12_source_lock_delta_upload_has_zero_production_wiring` — Rust 13 断言 / TS 10 expect，`host/plugins/integration/tests/sync-r12-locks.test.ts:243`
- `tests/tools_integration_tests.rs::test_mock_http_error_responses` — Rust 2 断言 / TS 1 expect，`host/kernel/tests/error-details.test.ts:36`

### L23-sync-providers（19）

- `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_config_validation` — Rust 4 断言 / TS 1 expect，`host/plugins/sync-providers/tests/config.test.ts:101`
- `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_https_enforcement_webdav` — Rust 5 断言 / TS 4 expect，`host/plugins/sync-providers/tests/config.test.ts:27`
- `crates/dstu-sync/src/cloud_storage/config.rs::tests::test_is_local_endpoint` — Rust 8 断言 / TS 2 expect，`host/plugins/sync-providers/tests/config.test.ts:57`
- `crates/dstu-sync/src/cloud_storage/ftp.rs::tests::ftp_contract_source_guards` — Rust 24 断言 / TS 8 expect，`host/plugins/sync-providers/tests/ftp.test.ts:206`
- `crates/dstu-sync/src/cloud_storage/s3.rs::tests::put_file_source_guards_remote_size_check` — Rust 15 断言 / TS 4 expect，`host/plugins/sync-providers/tests/s3.test.ts:32`
- `crates/dstu-sync/src/cloud_storage/webdav.rs::tests::webdav_contract_source_guards` — Rust 13 断言 / TS 3 expect，`host/plugins/sync-providers/tests/webdav.test.ts:609`
- `tests/sync_android_restart.rs::restore_writes_inactive_slot_and_switch_happens_only_after_restart` — Rust 16 断言 / TS 15 expect，`host/plugins/sync-providers/tests/data_space_cutover.test.ts:47`
- `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_touches_local_version` — Rust 5 断言 / TS 4 expect，`host/plugins/sync-providers/tests/comprehensive_sync.test.ts:131`
- `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_multiple_tables` — Rust 5 断言 / TS 4 expect，`host/plugins/sync-providers/tests/comprehensive_sync.test.ts:158`
- `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_table_without_local_version_is_skipped` — Rust 3 断言 / TS 2 expect，`host/plugins/sync-providers/tests/comprehensive_sync.test.ts:202`
- `tests/sync_comprehensive_tests.rs::tests::restore_baseline_tests::test_reset_baseline_empty_db_does_not_panic` — Rust 3 断言 / TS 1 expect，`host/plugins/sync-providers/tests/comprehensive_sync.test.ts:222`
- `tests/sync_provider_contract_tests.rs::webdav_bad_credentials_rejected` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/sync_provider_contract.test.ts:313`
- `tests/sync_provider_contract_tests.rs::s3_bad_credentials_rejected` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/sync_provider_contract.test.ts:338`。AP0425 来源修正：Rust `:2293` 为 `#[cfg(feature = "cloud_storage_s3")]`、`:2295` 为 `#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]`，函数始于 `:2296`。两断言中一条检查 Docker 开关；保原门控，人工核等价，不新增 skip、不视为平台待裁定，未执行不记 pass。
- `tests/sync_provider_contract_tests.rs::ftp_bad_credentials_rejected` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/sync_provider_contract.test.ts:371`
- `tests/sync_r02_hardening_tests.rs::r02x_two_device_tag_union_converges_when_both_sides_have_pending` — Rust 17 断言 / TS 16 expect，`host/plugins/sync-providers/tests/hardening_sync.test.ts:223`
- `tests/sync_realistic_scenarios.rs::s61_empty_change_log_on_one_device` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/realistic_scenarios_vfs_advanced_sync.test.ts:339`
- `tests/sync_realistic_scenarios.rs::s93_sync_with_no_changes_zero_op_cycle` — Rust 4 断言 / TS 2 expect，`host/plugins/sync-providers/tests/realistic_scenarios_recovery_sync.test.ts:351`
- `tests/sync_regression_tests.rs::r06_reset_baseline_on_empty_db` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/regression_sync.test.ts:236`
- `tests/sync_weird_tests.rs::w50_hlc_compare_strings_edge` — Rust 2 断言 / TS 1 expect，`host/plugins/sync-providers/tests/weird_sync.test.ts:581`

### L24-chatanki（46）

- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_get_cards_owned_snapshot_page_boundaries_and_filters` — Rust 16 断言 / TS 9 expect，`host/plugins/chatanki/tests/executor-args.test.ts:399`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_library_list_arguments_normalize_and_cap_page_size` — Rust 14 断言 / TS 12 expect，`host/plugins/chatanki/tests/executor-args.test.ts:107`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_workspace_card_read_scope_never_relaxes_write_paths` — Rust 6 断言 / TS 5 expect，`host/plugins/chatanki/tests/workspace-read-scope.test.ts:75`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_mutation_without_current_session_block_executes_without_ui_event` — Rust 8 断言 / TS 5 expect，`host/plugins/chatanki/tests/mutation-ui-sync.test.ts:76`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_mutation_requeries_block_created_after_preflight` — Rust 8 断言 / TS 6 expect，`host/plugins/chatanki/tests/mutation-ui-sync.test.ts:112`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_postwrite_lookup_failures_are_partial_without_emit` — Rust 12 断言 / TS 8 expect，`host/plugins/chatanki/tests/mutation-ui-sync.test.ts:191`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_late_block_validation_failure_does_not_emit` — Rust 8 断言 / TS 5 expect，`host/plugins/chatanki/tests/mutation-ui-sync.test.ts:230`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_ui_sync_failure_is_structured_partial_receipt` — Rust 7 断言 / TS 5 expect，`host/plugins/chatanki/tests/mutation-ui-sync.test.ts:378`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_field_limit_warnings_flag_prose_stuffed_into_formula` — Rust 7 断言 / TS 5 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:407`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_list_templates_filters_before_paginating_all_page_boundaries` — Rust 13 断言 / TS 8 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:457`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_retemplate_strategy_parses_fill_missing_llm` — Rust 3 断言 / TS 2 expect，`host/plugins/chatanki/tests/executor-args.test.ts:390`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_can_handle` — Rust 31 断言 / TS 2 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:108`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_derive_status_snapshot_not_found` — Rust 3 断言 / TS 1 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:691`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_derive_status_snapshot_running_and_completed_with_errors` — Rust 9 断言 / TS 3 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:697`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_derive_status_snapshot_cancelled` — Rust 3 断言 / TS 1 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:785`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_derive_status_snapshot_limit_cancelled_is_completed` — Rust 8 断言 / TS 6 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:791`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_derive_status_snapshot_paused` — Rust 3 断言 / TS 1 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:814`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_decide_wait_timeout_status_variants` — Rust 6 断言 / TS 3 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:156`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_resolve_route_decision_priority_and_source` — Rust 19 断言 / TS 16 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:233`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_build_route_plan_prompt_contains_context` — Rust 10 断言 / TS 6 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:268`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_vlm_full_prompt_requests_optional_normalized_occlusion_boxes` — Rust 8 断言 / TS 1 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:351`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_multiple_with_one_template_id_matches_single_mode_options` — Rust 10 断言 / TS 9 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:520`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_chatanki_import_apkg_original_only_requires_recorded_sha256_match` — Rust 3 断言 / TS 2 expect，`host/plugins/chatanki/tests/apkg-import.test.ts:101`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_unsupported_chatanki_resource_message_allows_file_like_ids` — Rust 4 断言 / TS 1 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:674`
- `src/chat_v2/tools/chatanki_executor.rs::tests::test_decide_pipeline_timeout_idle_semantics` — Rust 6 断言 / TS 4 expect，`host/plugins/chatanki/tests/executor-helpers.test.ts:166`
- `src/chat_v2/tools/chatanki_transform.rs::tests::normalize_script_mode_carries_language_code_and_default_timeout` — Rust 4 断言 / TS 3 expect，`host/plugins/chatanki/tests/transform.test.ts:41`
- `src/chat_v2/tools/chatanki_transform.rs::tests::default_selection_excludes_error_cards` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/transform.test.ts:325`
- `src/chat_v2/tools/chatanki_transform.rs::tests::filter_selection_matches_get_cards_semantics` — Rust 5 断言 / TS 3 expect，`host/plugins/chatanki/tests/transform.test.ts:331`
- `src/chat_v2/tools/template_executor.rs::tests::test_can_handle_builtin_prefix` — Rust 8 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:18`
- `src/chat_v2/tools/template_executor.rs::tests::test_can_handle_bare_name` — Rust 3 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:27`
- `src/chat_v2/tools/template_executor.rs::tests::test_can_handle_unrelated_tools` — Rust 4 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:30`
- `src/chat_v2/tools/template_executor.rs::tests::test_validate_success` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:33`
- `src/chat_v2/tools/template_executor.rs::tests::test_validate_empty_name_and_fields` — Rust 6 断言 / TS 2 expect，`host/plugins/chatanki/tests/template.test.ts:36`
- `src/chat_v2/tools/template_executor.rs::tests::test_sensitivity_levels` — Rust 9 断言 / TS 3 expect，`host/plugins/chatanki/tests/template.test.ts:86`
- `src/chat_v2/tools/template_executor.rs::tests::test_list_args_defaults` — Rust 4 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:102`
- `src/chat_v2/tools/template_executor.rs::tests::test_list_args_query` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:108`
- `src/chat_v2/tools/template_executor.rs::tests::test_parse_update_request_camel_case` — Rust 9 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:111`
- `src/chat_v2/tools/template_executor.rs::tests::test_parse_update_request_snake_case` — Rust 3 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:119`
- `src/chat_v2/tools/template_executor.rs::tests::test_create_fields_with_non_string_elements_fails` — Rust 3 断言 / TS 2 expect，`host/plugins/chatanki/tests/template.test.ts:174`
- `src/chat_v2/tools/template_executor.rs::tests::test_update_fields_with_non_string_elements_fails` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:178`
- `src/chat_v2/tools/template_executor.rs::tests::test_update_fields_not_array_fails` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:181`
- `src/chat_v2/tools/template_executor.rs::tests::test_update_name_wrong_type_fails` — Rust 3 断言 / TS 2 expect，`host/plugins/chatanki/tests/template.test.ts:184`
- `src/chat_v2/tools/template_executor.rs::tests::test_update_is_active_wrong_type_fails` — Rust 3 断言 / TS 2 expect，`host/plugins/chatanki/tests/template.test.ts:188`
- `src/chat_v2/tools/template_executor.rs::tests::test_update_expected_version_wrong_type_fails` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:192`
- `src/chat_v2/tools/template_executor.rs::tests::test_create_note_type_wrong_type_fails` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:204`
- `src/chat_v2/tools/template_executor.rs::tests::test_create_is_active_wrong_type_fails` — Rust 2 断言 / TS 1 expect，`host/plugins/chatanki/tests/template.test.ts:207`
