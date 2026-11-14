# L01-llm-providers 测试去向（`host/plugins/llm-providers`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L01-llm-providers：246 行（真实测试 246）· pending 8 · ported 238
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_build_gemini_request_nonstream` | test | L2056 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_build_gemini_request_stream` | test | L2103 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_content` | test | L2131 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_accepts_bare_ndjson` | test | L2144 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_event_and_data_block` | test | L2156 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_done` | test | L2171 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_function_call` | test | L2181 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_usage` | test | L2200 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_usage_lifts_cached_tokens` | test | L2216 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_gemini_stream_line_usage_without_cache_omits_cached_tokens` | test | L2236 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_convert_gemini_nonstream_response` | test | L2252 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_convert_with_tools` | test | L2293 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_error_handling_invalid_json` | test | L2337 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_parse_invalid_stream_line` | test | L2357 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_usage_robustness` | test | L2370 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_tool_response_mapping` | test | L2419 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_multiple_content_parts` | test | L2467 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_topk_injection_from_openai_body` | test | L2499 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_thinking_forces_v1beta_when_no_version_specified` | test | L2521 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_gemini_25_explicit_thinking_budget_overrides_reasoning_effort` | test | L2542 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_gemini_25_reasoning_effort_supplies_budget_without_explicit_config` | test | L2589 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_stream_function_call_preserves_native_id` | test | L2613 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_stream_function_call_without_id_falls_back_to_uuid` | test | L2629 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_stream_late_native_id_replaces_synthetic` | test | L2650 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_nonstream_function_call_preserves_native_id` | test | L2666 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_native_id_round_trip_into_function_call_and_response` | test | L2688 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_synthetic_id_not_sent_back_to_api` | test | L2732 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_unknown_content_part_degrades_instead_of_failing` | test | L2770 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_is_synthetic_tool_call_id` | test | L2804 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/adapters/gemini-openai-converter.rs::tests::test_penalties_flow_into_generation_config` | test | L2816 | ported:host/plugins/llm-providers/tests/gemini-converter.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_estimate_tokens_chinese` | test | L600 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_estimate_tokens_english` | test | L608 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_estimate_tokens_mixed` | test | L616 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_short_text` | test | L623 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_long_text` | test | L632 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_hard_chunk_utf8_safe` | test | L640 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_aggregate_mean_pooling` | test | L654 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_tail_text_by_tokens` | test | L665 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_text_overlap` | test | L677 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_text_overlap_respects_token_budget` | test | L697 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_chunk_text_no_overlap_when_single_chunk` | test | L714 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_chunker.rs::tests::test_token_limits` | test | L723 | ported:host/plugins/llm-providers/tests/embedding-chunker.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_service.rs::tests::test_embedding_service_config_default` | test | L1084 | ported:host/plugins/llm-providers/tests/embedding-service.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_service.rs::tests::test_prepare_inputs_with_fallback_valid_image` | test | L1091 | ported:host/plugins/llm-providers/tests/embedding-service.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_service.rs::tests::test_looks_like_valid_base64` | test | L1101 | ported:host/plugins/llm-providers/tests/embedding-service.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_service.rs::tests::test_is_transient_embedding_error` | test | L1114 | ported:host/plugins/llm-providers/tests/embedding-service.test.ts |
| `crates/dstu-llm/src/multimodal/embedding_service.rs::tests::test_vl_embed_backoff_delay_capped` | test | L1133 | ported:host/plugins/llm-providers/tests/embedding-service.test.ts |
| `crates/dstu-llm/src/multimodal/page_indexer.rs::tests::test_textbook_preview_camel_case_parsing` | test | L63 | ported:host/plugins/llm-providers/tests/page-indexer.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_multimodal_input_text_only` | test | L366 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_multimodal_input_image_only` | test | L375 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_multimodal_input_mixed` | test | L383 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_multimodal_input_with_instruction` | test | L391 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_vl_embedding_input_conversion` | test | L397 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/multimodal/types.rs::tests::test_indexing_mode_roundtrip` | test | L408 | ported:host/plugins/llm-providers/tests/multimodal-types.test.ts |
| `crates/dstu-llm/src/ocr_adapters/deepseek.rs::tests::test_deepseek_adapter_prompt` | test | L383 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/deepseek.rs::tests::test_parse_grounding` | test | L394 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/deepseek.rs::tests::test_parse_response` | test | L404 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/deepseek.rs::tests::test_parse_grounding_malformed_markers` | test | L419 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/deepseek.rs::tests::test_extract_markdown` | test | L442 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/factory.rs::tests::test_create_adapters` | test | L208 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/factory.rs::tests::test_create_from_str` | test | L223 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/factory.rs::tests::test_validate_model` | test | L232 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/factory.rs::tests::test_infer_engine` | test | L266 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/mod.rs::tests::test_generic_vlm_adapter` | test | L326 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/paddle.rs::tests::test_paddle_adapter_prompt` | test | L406 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/paddle.rs::tests::test_repetition_penalty` | test | L427 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/paddle.rs::tests::test_parse_json_response` | test | L435 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/paddle.rs::tests::test_extract_json` | test | L456 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/paddle.rs::tests::test_parse_free_ocr_response` | test | L467 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/types.rs::tests::test_engine_type_parsing` | test | L358 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/ocr_adapters/types.rs::tests::test_image_source_to_data_url` | test | L394 | ported:host/plugins/llm-providers/tests/ocr-adapters.test.ts |
| `crates/dstu-llm/src/openai_codex/error.rs::tests::permanent_refresh_errors_require_reauthentication` | test | L126 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/error.rs::tests::network_errors_are_transient` | test | L138 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::pkce_uses_s256_and_rfc_length_verifier` | test | L2159 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::jwt_claims_use_root_then_namespaced_then_organization` | test | L2170 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::malformed_jwt_is_rejected` | test | L2195 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::initial_tokens_require_account_id` | test | L2201 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::refresh_merge_retains_rotating_fields_when_omitted` | test | L2218 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::refresh_merge_rejects_account_switch` | test | L2245 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::refresh_commit_rejects_live_account_change_or_missing_identity` | test | L2268 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::nested_usage_limit_error_is_safely_mapped_as_transient` | test | L2285 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::authorization_url_contains_exact_openai_flow_fields` | test | L2306 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::device_user_code_accepts_both_server_spellings` | test | L2325 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::cancelled_or_failed_reauthentication_login_preserves_required_phase` | tokio::test | L2347 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::authorizing_status_reports_if_the_existing_session_remains_usable` | tokio::test | L2399 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::stale_cancel_id_does_not_cancel_new_attempt` | tokio::test | L2428 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::completed_save_wins_over_concurrent_cancel` | tokio::test | L2450 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::dropped_persist_waiter_still_cleans_up_a_failed_save` | tokio::test | L2514 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::failed_logout_delete_preserves_memory_and_persisted_session` | tokio::test | L2562 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::logout_cancels_attempt_installed_before_transaction_gets_gate` | tokio::test | L2593 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::logout_cancels_attempt_installed_while_delete_is_blocked` | tokio::test | L2617 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::logout_holds_commit_gate_until_old_token_revocation_finishes` | tokio::test | L2648 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::stale_reauthentication_signal_cannot_poison_newer_session` | tokio::test | L2728 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::cancel_winning_refresh_gate_prevents_persistence` | tokio::test | L2770 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::successful_install_is_atomic_and_finish_success_is_idempotent` | tokio::test | L2809 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::device_start_cancelled_during_initial_request_does_not_resurrect_attempt` | tokio::test | L2841 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::refresh_generation_is_rechecked_before_persisting_tokens` | tokio::test | L2893 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::dropped_refresh_waiter_still_commits_without_hiding_active_login` | tokio::test | L2971 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::failed_refresh_persistence_requires_reauth_without_hiding_active_login` | tokio::test | L3071 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::status_never_exposes_tokens` | tokio::test | L3162 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::usage_fixture_is_parsed_into_frontend_shape` | test | L3191 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::usage_snapshot_uses_oauth_headers_over_http` | tokio::test | L3240 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::usage_second_unauthorized_marks_the_refreshed_generation` | tokio::test | L3309 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/manager.rs::tests::usage_snapshot_rejects_oversized_body` | tokio::test | L3391 | ported:host/plugins/llm-providers/tests/codex-manager.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::endpoint_config_can_be_overridden_for_http_tests` | test | L515 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::request_headers_contain_codex_auth_without_debuggable_dto_tokens` | test | L532 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::request_headers_reject_missing_account_id` | test | L558 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::responses_body_is_sanitized_for_codex` | test | L579 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::sse_bridge_aggregates_text_reasoning_tools_and_usage` | test | L612 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/protocol.rs::tests::sse_bridge_prefers_terminal_response_and_canonicalizes_errors` | test | L646 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/types.rs::tests::request_auth_debug_is_redacted` | test | L244 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/types.rs::tests::stored_session_debug_is_redacted` | test | L264 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/openai_codex/types.rs::tests::stored_session_requires_account_id` | test | L284 | ported:host/plugins/llm-providers/tests/codex-protocol.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_http_stream_consumes_trailing_usage_before_failure` | tokio::test | L11 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_failure_at_eof_and_request_reuse_are_isolated` | test | L71 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_request_modes_survive_both_transports` | test | L91 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_responses_replays_chat_cot_without_duplicating_native_items` | test | L151 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_system_update_keeps_history_position` | test | L192 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_failed_finish_is_not_successful_partial_output` | test | L213 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_nonofficial_transports_keep_existing_behavior` | test | L249 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::deepseek_harness_hosted_xhigh_keeps_legacy_max_mapping` | test | L294 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_official_openai` | test | L329 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_official_gpt6_responses` | test | L359 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_relay_passthrough` | test | L389 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_official_deepseek` | test | L421 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_glm53_and_kimi_k3` | test | L444 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/deepseek_harness_tests.rs::unified_five_levels_reach_the_wire_for_gemini_low` | test | L473 | ported:host/plugins/llm-providers/tests/deepseek-harness.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::ollama_root_base_url_routes_chat_under_v1` | test | L3926 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::stream_completion_requirement_matches_adapter_protocols` | test | L3953 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_tool_delta_filter_skips_empty_fragments` | test | L3963 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_keeps_argument_deltas_and_skips_empty_tool_fragments` | test | L3977 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_preserves_empty_reasoning_content` | test | L3992 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_accepts_data_prefix_without_space` | test | L4004 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_accepts_bare_ndjson` | test | L4016 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_emits_usage_before_done_for_official_chunk_sequence` | test | L4027 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_bare_ndjson_finish_reason_completes_at_eof` | test | L4056 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_finish_reason_ignores_empty_and_partial_multi_choice_completion` | test | L4077 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_choice_completion_keeps_event_sequence_until_done_marker` | test | L4123 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_handles_content_block_arrays` | test | L4159 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_handles_reasoning_field_variants` | test | L4187 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_parse_stream_reports_injected_error_objects` | test | L4215 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_build_request_keeps_nested_tool_choice_shape` | test | L4232 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapters_do_not_duplicate_complete_endpoint_paths` | test | L4272 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapters_insert_endpoint_before_query_and_fragment` | test | L4308 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapters_replace_cross_protocol_endpoints_and_preserve_url_tail` | test | L4337 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_passes_through_non_function_tools` | test | L4366 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_converts_messages_and_reasoning` | test | L4392 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_maps_reasoning_effort_and_verbosity` | test | L4426 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_maps_runtime_off_to_reasoning_none` | test | L4441 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_known_provider_thinking_extensions` | test | L4454 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_drops_provider_thinking_extensions_for_openai` | test | L4494 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_extensions_for_provider_deployment_alias` | test | L4520 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_extensions_for_dashscope_intl` | test | L4538 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_extensions_for_qwen_workspace_maas` | test | L4556 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_drops_extensions_for_openrouter_qwen` | test | L4579 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_respects_stream_and_store_from_body` | test | L4597 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_flattens_json_schema_response_format` | test | L4620 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_converts_tools_and_tool_choice` | test | L4657 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_passes_through_strict_and_non_function_tools` | test | L4692 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_filters_blank_and_duplicate_tool_names` | test | L4719 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_drops_tools_with_blank_flat_names` | test | L4771 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_drops_all_blank_tools_and_clears_tools_field` | test | L4832 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_normalizes_missing_or_null_parameters` | test | L4847 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::sanitize_openai_request_body_drops_invalid_tool_choice_when_tool_missing` | test | L4873 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_build_request_sanitizes_invalid_tools` | test | L4897 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_build_request_sanitizes_invalid_tools` | test | L4944 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_parses_stream_events` | test | L4988 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_accepts_bare_ndjson` | test | L5017 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_parses_event_and_data_sse_blocks` | test | L5028 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_parses_buffered_event_only_type` | test | L5040 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_chat_adapter_accepts_event_and_data_sse_blocks` | test | L5057 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_falls_back_to_terminal_tool_calls_without_duplicates` | test | L5069 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_streams_added_and_argument_deltas` | test | L5100 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_output_item_done_uses_accumulated_argument_deltas` | test | L5167 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_emits_server_side_web_search_progress_events` | test | L5188 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_web_search_in_progress_stage_is_not_searching` | test | L5216 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_attaches_full_web_search_item_for_replay` | test | L5251 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_replays_web_search_items_from_assistant_meta` | test | L5300 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated` | test | L5344 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_prompt_cache_breakpoint_gate_covers_endpoint_variants` | test | L5428 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::model_supports_prompt_cache_breakpoint_parses_gpt_versions` | test | L5467 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_extracts_web_search_from_output_item_done` | test | L5491 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_terminal_fallback_extracts_annotations_without_duplicating` | test | L5506 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::deepseek_responses_uses_reasoning_instead_of_chat_thinking_extensions` | test | L5543 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_accepts_deepseek_web_search_sources_shape` | test | L5562 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_reports_untyped_error_objects` | test | L5591 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_incomplete_output_without_marking_done` | test | L5608 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_uses_output_text_fallbacks_without_duplication` | test | L5633 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_extracts_reasoning_from_completed_event` | test | L5681 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_does_not_duplicate_reasoning_after_deltas` | test | L5703 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_uses_done_event_as_fallback_without_deltas` | test | L5736 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_uses_output_config_format_for_structured_output` | test | L5759 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_thinking_with_tools_forces_auto_tool_choice` | test | L5779 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_preserves_inline_tool_use_blocks_from_assistant_content` | test | L5800 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_adds_tools_and_system_tail_cache_breakpoints` | test | L5835 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_preserves_caller_block_level_system_cache_control` | test | L5882 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint` | test | L5917 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_cache_breakpoint_budget_keeps_full_four_slots` | test | L5947 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow` | test | L5995 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_encodes_tool_history` | test | L6055 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_completed_fallback_interleaves_reasoning_and_tool_calls` | test | L6110 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_completed_dedupes_streamed_reasoning_items_by_id` | test | L6153 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_replays_reasoning_item_before_plain_assistant_message` | test | L6202 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_encodes_assistant_history_as_output_text` | test | L6240 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_responses_adapter_preserves_assistant_output_parts` | test | L6258 | ported:host/plugins/llm-providers/tests/openai-responses.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_build_usage_event_collects_cached_tokens` | test | L6285 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_new_generation_strips_sampling_params_unconditionally` | test | L6300 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_new_generation_rewrites_enabled_thinking_to_adaptive` | test | L6323 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_old_generation_keeps_enabled_thinking_passthrough` | test | L6343 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_accumulates_signature_delta` | test | L6357 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_accepts_event_and_data_sse_blocks` | test | L6383 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_accepts_bare_ndjson` | test | L6397 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_merges_input_tokens_from_message_start` | test | L6409 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_merges_cache_fields_from_message_start` | test | L6432 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_merged_usage_prefers_terminal_nonzero_fields` | test | L6471 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::build_usage_event_reads_responses_details` | test | L6489 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::build_usage_event_preserves_observed_zero_cache_values` | test | L6509 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::convert_anthropic_response_passes_cache_fields` | test | L6529 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_gates_stream_options_include_usage_by_endpoint` | test | L6554 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::openai_adapter_stream_options_gate_pins_official_host_variants` | test | L6611 | ported:host/plugins/llm-providers/tests/openai-chat.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_surfaces_error_event` | test | L6653 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_parse_stream_maps_new_stop_reasons` | test | L6666 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_assistant_thinking_blocks_keep_signature_and_redacted` | test | L6693 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_message_level_thought_signature_attaches_to_thinking_block` | test | L6725 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_beta_headers_cleaned_up` | test | L6773 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/mod.rs::tests::anthropic_json_schema_output_uses_ga_schema_field` | test | L6826 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::budget_constant_matches_anthropic_hard_limit` | test | L88 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_noop_when_block_markers_within_budget` | test | L95 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_without_tools_keeps_system_markers_within_budget` | test | L118 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_without_tools_strips_earliest_system_markers_on_overflow` | test | L133 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_strips_earliest_tool_markers_and_leaves_no_null_on_serialize` | test | L155 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_overflow_crosses_from_tools_into_system` | test | L183 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_preserves_surviving_marker_payload_verbatim` | test | L211 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::guard_handles_empty_inputs_without_panic` | test | L233 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_tool_marker_passthrough_keeps_position_and_payload` | test | L251 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_marker_nested_in_function_object_is_not_a_tool_marker` | test | L293 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_dropped_tool_entry_marker_has_no_side_effects` | test | L323 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_all_invalid_tools_yield_no_tools_key` | test | L357 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers` | test | L389 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs::anthropic_passthrough_marker_survives_budget_guard_within_budget` | test | L448 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::openai_chat_prefix_segments_byte_identical_across_consecutive_requests` | test | L157 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::openai_responses_developer_breakpoint_prefix_byte_identical_across_consecutive_requests` | test | L205 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::anthropic_system_and_tools_prefix_byte_identical_across_consecutive_requests` | test | L252 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::deepseek_chat_prefix_segments_byte_identical_across_consecutive_requests` | test | L298 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::deepseek_responses_instructions_prefix_byte_identical_across_consecutive_requests` | test | L338 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
| `crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs::reconverting_identical_body_is_fully_byte_deterministic_for_all_three_providers` | test | L380 | ported:host/plugins/llm-providers/tests/anthropic.test.ts |
<!-- END GENERATED:testmap:rows -->

## frozen 差分 oracle 副本（WP-034 证据；12 行未登记，仍 pending）

`src-tauri/crates/dstu-differential/src/frozen/embedding_chunker.rs` 与本 lane 的
`crates/dstu-llm/src/multimodal/embedding_chunker.rs` 字节一致（`cmp` 无差异；`origin.json` 源 2ee9a9cbe，
其后两文件、TS 测试与 `src/multimodal/embedding-chunker.ts` 均无 diff）。inventory `LANE_RULES` 不匹配
`crates/dstu-differential/`，ledger 中这 12 行 lane 为 null、无任何 TESTMAP 行（作业 `20261105172125-160c20`）。
frozen 副本的生产调用方是差分 oracle `dstu-differential/src/main.rs:7-8,78-80`（estimate/chunk/limit），
TS 侧 `host/e2e/differential/ts-adapter.mjs:29-34` 调用同一 `embedding-chunker.ts`。Host 生产路径：
`index.ts:61` `ctx.provide('llmMultimodal')` → `src/multimodal/service.ts:26` `createChunker`；
`src/multimodal/embedding-service.ts:451-464,491-515,616`（getLimit / batchChunkTexts→chunkText / aggregateEmbeddings）；
hardChunk 经 chunkParagraph（`embedding-chunker.ts:141,149`），tailTextByTokens 经 chunkText 重叠（`:115,120`）。
目前没有 L01 以外的 Host 插件调用 `llmMultimodal`（见 BLOCKERS.md Multimodal runtime）。

逐断言对照（frozen Rust 断言行 → `tests/embedding-chunker.test.ts` 断言行，同名用例）：
chinese L604→6-7；english L612→11-12；mixed L619→15；short_text L627-628→18（`toEqual` 同钉长度与内容）；
long_text L636→21；hard_chunk_utf8_safe L647（L649 非断言）→25-26；mean_pooling L660-661→31-32；
tail_text L668-673→37-40（含 target0/空串边界）；overlap L683,686-689,692→44-46；
overlap_budget L703,705→50-51；single_chunk L718-719→54；token_limits L726-734→58-60（460/7372/29491）。
12 条均无 Err/panic 失败路径。断言层面 12/12 等价；`test_token_limits` 孪生在 X6 `prod-reachable.json`
为 `unknown`，按其 policy 不发新 A 证书，即使登记也应保持 pending。

未登记原因：在本文件补这 12 行后 `scaffold.mjs --check` 退出 1（structural drift，作业
`20261105172438-e26e04`），因为 scaffold 把不属于本 lane 生成行集的 id 判为孤儿；CI
`.github/workflows/electron-migration.yml:69` 跑该检查。需 inventory/scaffold 所有者（架构）二选一：
在 `LANE_RULES` 把该 frozen 文件归 L01，或让 scaffold 孤儿判定按全部 Rust 行而非 lane 行。之后再登记。

## 未移植测试的阻塞说明

无。原 `providers/deepseek_harness_tests.rs` 的 8 条配置归一层端到端用例已随 L02 发布
`applyReasoningConfig` / `applyGenerationParams` / `resolveQuirks` /
`applyOfficialDeepseekGenerationParams` 后全部移植到
`tests/deepseek-harness.test.ts`：测试从 `host/plugins/llm/api.ts` 取用 L02 的纯函数，
再经本 lane 的 `OpenAIAdapter` / `OpenAIResponsesAdapter` 断言最终线上 body，
未复制 L02 的配置逻辑。

## v2 额外回归（不计入原 Rust 测试行统计）

- **WP-017 已恢复活动并通过 — V2-03 / X6-UD-0040：预览未知字段 depth128 应接受**。
  `tests/codex-integer-width.test.ts` 的 `preview accepts the corrected pending unknown-field depth 128 vector`
  经真实 `ctx.llmMultimodal.parseAttachmentPreviewJson`；原127接受、typed -0拒绝和Value深度断言保留。
  源码依据、完整向量及先红后绿作业见 [PENDING.md](PENDING.md)。作业
  `20261105141327-8880db` 三文件48 passed / 0 failed / 0 skipped，exit0，无Errors报告。
  补充pending 1 → 0；独立复验及L12接入未据此签收。
- 原Rust测试行实际仍为246 ported / 0 pending（生成表头是历史统计，本包不手改）。
  `page_indexer.rs::tests::test_textbook_preview_camel_case_parsing`（Rust L63）去向未变，
  但 `tests/page-indexer.test.ts` 改走真实插件文本入口；Rust L77-89 的成功、两页、
  页索引0/1、blob abc123、dpi150、page_count2断言全部保留，附加legacy/rendered_at断言也保留。
  其余245行去向未改；本包不处理frozen12映射。
- **D4 llm-replay（无 Rust 对应，不计入原 Rust 测试行）**：`tests/llm-replay.test.ts` 26 例（渲染、轮次、旁车游标、
  全部失败路径、hold 中止/取消、stop、内部异常不回落网络、脚本校验、插件挂载卸载；内置脚本缺省、embeddings、音频转写
  及其失败、`w0.directive` 与推导脚本校验）；接入与真实命令/服务见
  `host/plugins/llm/tests/replay_fetch.test.ts`；与 llm-service.ts 对拍及真实聊天管线端到端见
  `host/e2e/streaming/wave0/llm-replay.test.ts`。规格见 SPEC.md「D4」。
