# L19-mcp-browser 测试去向（`host/plugins/mcp`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L19-mcp-browser：100 行（真实测试 100）· ported 100
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-mcp/src/mcp/auth.rs::tests::test_api_key_auth` | tokio::test | L1260 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resource_origin_normalization_is_secure_and_stable` | test | L1273 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::bearer_token_is_bound_to_resource_origin` | tokio::test | L1286 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::test_oauth_token_expiration` | tokio::test | L1348 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::test_long_lived_token_generation` | tokio::test | L1361 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::rejects_exchange_on_state_mismatch` | tokio::test | L1370 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::rejects_exchange_when_pkce_verifier_missing` | tokio::test | L1401 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::hermetic_exchange_code_via_fake_http` | tokio::test | L1420 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::hermetic_persist_and_restore_session` | tokio::test | L1441 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::hermetic_auto_refresh_via_fake_http` | tokio::test | L1479 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::oauth_full_flow_state_mismatch_persist_and_refresh` | tokio::test | L1518 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::authorization_url_includes_pkce_s256_challenge` | tokio::test | L1606 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::hermetic_dcr_via_fake_http` | tokio::test | L1630 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::expired_without_refresh_token_requires_reauth` | tokio::test | L1659 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::near_expiry_without_refresh_token_degrades_to_current` | tokio::test | L1695 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::refresh_preserves_old_refresh_token_when_as_omits_it` | tokio::test | L1723 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::concurrent_refresh_no_deadlock` | tokio::test | L1746 | ported:host/plugins/mcp/tests/oauth-manager.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resolve_authorization_prefers_api_key_over_oauth` | tokio::test | L1814 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resolve_authorization_oauth_missing_token_requires_reauth` | tokio::test | L1824 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resolve_authorization_injects_oauth_bearer` | tokio::test | L1839 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resolve_authorization_oauth_without_server_id_errors` | tokio::test | L1853 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/auth.rs::tests::resolve_authorization_none_when_unconfigured` | tokio::test | L1862 | ported:host/plugins/mcp/tests/auth-token.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::standard_notification_is_not_swallowed_by_response_branch` | tokio::test | L2048 | ported:host/plugins/mcp/tests/client-dispatch.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::legacy_private_notification_names_still_map_to_events` | tokio::test | L2076 | ported:host/plugins/mcp/tests/client-dispatch.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::response_completes_pending_request_by_id` | tokio::test | L2102 | ported:host/plugins/mcp/tests/client-dispatch.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::server_request_is_not_treated_as_response_or_notification` | tokio::test | L2125 | ported:host/plugins/mcp/tests/client-dispatch.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::client_capabilities_none_experimental_is_omitted_not_null` | test | L2147 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::tool_deserializes_spec_camel_case_fields` | test | L2170 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::tool_result_and_capabilities_use_camel_case_wire_names` | test | L2185 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::resource_types_use_camel_case_wire_names` | test | L2203 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::test_client_initialization` | tokio::test | L2280 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::jsonrpc_request_omits_params_when_none` | test | L2317 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::jsonrpc_request_includes_params_when_some` | test | L2344 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::jsonrpc_request_deserializes_missing_params_as_none` | test | L2361 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/client.rs::tests::jsonrpc_notification_omits_params_when_none` | test | L2370 | ported:host/plugins/mcp/tests/client-protocol.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::normalize_command_path_strips_extended_length_prefixes` | test | L1015 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_format_content_length_frame_basic` | test | L1039 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_format_content_length_frame_empty` | test | L1047 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_format_content_length_frame_unicode` | test | L1055 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_format_content_length_frame_with_newlines` | test | L1067 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_default_framing_is_jsonl` | test | L1075 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_read_content_length_message_parses_frame` | tokio::test | L1084 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_read_content_length_message_falls_back_on_json_first_line` | tokio::test | L1095 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_run_content_length_loop_switches_to_jsonl_after_fallback` | tokio::test | L1109 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_spawn_failure_error_contains_diagnostics` | tokio::test | L1123 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_minimal_child_env_keys_includes_dev_toolchain_and_proxy` | test | L1162 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/global.rs::tests::test_minimal_child_env_keys_posix_includes_dev_toolchain_and_proxy` | test | L1209 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/http_transport.rs::tests::test_http_config` | tokio::test | L285 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/http_transport.rs::tests::http_auth_wiring_api_key_beats_oauth_flag` | tokio::test | L301 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/http_transport.rs::tests::http_auth_wiring_oauth_without_token_is_reauth` | tokio::test | L327 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/mod.rs::tests::loopback_endpoints_are_detected` | test | L64 | ported:host/plugins/mcp/tests/client-helpers.test.ts |
| `crates/dstu-mcp/src/mcp/mod.rs::tests::loopback_builder_disables_proxy` | test | L76 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/oauth_callback.rs::tests::rejects_state_mismatch` | tokio::test | L219 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/protocol_version.rs::tests::test_version_ordering` | test | L254 | ported:host/plugins/mcp/tests/protocol-version.test.ts |
| `crates/dstu-mcp/src/mcp/protocol_version.rs::tests::test_version_features` | test | L260 | ported:host/plugins/mcp/tests/protocol-version.test.ts |
| `crates/dstu-mcp/src/mcp/protocol_version.rs::tests::test_version_negotiation` | tokio::test | L271 | ported:host/plugins/mcp/tests/protocol-version.test.ts |
| `crates/dstu-mcp/src/mcp/protocol_version.rs::tests::test_transport_selection` | test | L297 | ported:host/plugins/mcp/tests/protocol-version.test.ts |
| `crates/dstu-mcp/src/mcp/protocol_version.rs::tests::test_compatibility_check` | test | L321 | ported:host/plugins/mcp/tests/protocol-version.test.ts |
| `crates/dstu-mcp/src/mcp/sse_transport.rs::tests::sse_receive_task_stops_after_transport_drop` | tokio::test | L492 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/sse_transport.rs::tests::test_sse_config` | tokio::test | L546 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/sse_transport.rs::tests::sse_auth_wiring_api_key_beats_oauth_flag` | tokio::test | L562 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/sse_transport.rs::tests::sse_auth_wiring_oauth_without_token_is_reauth` | tokio::test | L588 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `crates/dstu-mcp/src/mcp/stdio_proxy.rs::tests::mobile_stdio_rejection_message_is_stable` | test | L177 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/mcp/stdio_proxy.rs::tests::network_mcp_transport_variants_remain_available` | test | L186 | ported:host/plugins/mcp/tests/stdio-proxy.test.ts |
| `crates/dstu-mcp/src/tools/mod.rs::tests::resolve_frontend_mcp_tool_name_decodes_canonical_legacy_namespaces` | test | L546 | ported:host/plugins/mcp/tests/client-helpers.test.ts |
| `crates/dstu-mcp/src/tools/mod.rs::tests::resolve_frontend_mcp_tool_name_decodes_chat_pipeline_internal_names` | test | L559 | ported:host/plugins/mcp/tests/client-helpers.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_normalize_score` | test | L3474 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_redact_url_secrets` | test | L3480 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_strip_html` | test | L3496 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_truncate` | test | L3500 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_url_norm` | test | L3509 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_default_engine_is_keyless_bing_rss` | test | L3517 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_parse_bing_rss` | test | L3525 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_host_allowed_cn_whitelist` | test | L3541 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_query_operators` | test | L3560 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_parse_results` | test | L3583 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_error_mapping` | test | L3601 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_keys_and_strategy` | test | L3619 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_content_preferred_in_inject_text` | test | L3638 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_content_respects_snippet_budget` | test | L3690 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_non_deepseek_provider_ignores_content_field` | test | L3718 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_deepseek_content_survives_reranker_raw_wrapping` | test | L3745 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `crates/dstu-mcp/src/tools/web_search.rs::tests::t_provider_402_is_not_retryable` | test | L3774 | ported:host/plugins/mcp/tests/web-search.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::accepts_exact_match_of_enabled_entry` | test | L901 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::rejects_mismatched_args_and_disabled_entries` | test | L921 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::rejects_unconfigured_executable_used_by_connection_test_or_session_start` | test | L945 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::rejects_env_value_mismatch_missing_and_extra_keys` | test | L968 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::rejects_canonical_cwd_and_framing_mismatches` | test | L1006 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::normalizes_default_framing_and_cwd_aliases` | test | L1032 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::resolves_path_command_to_the_approved_canonical_executable` | test | L1097 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::rejects_same_basename_from_a_different_directory` | test | L1123 | ported:host/plugins/mcp/tests/stdio-validation.test.ts |
| `src/cmd/mcp.rs::stdio_start_validation_tests::stdio_probe_parses_spec_camel_case_tools` | tokio::test | L1164 | ported:host/plugins/mcp/tests/transport-auth.test.ts |
| `tests/mcpbench_integration.rs::test_modelscope_hosted_connection` | tokio::test | L54 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_protocol_version_negotiation` | tokio::test | L108 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_config_import_export` | tokio::test | L143 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_oauth_authentication` | tokio::test | L181 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_transport_selection` | tokio::test | L204 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_mcpbench_websearch_dataset` | tokio::test | L229 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_compatibility_matrix` | tokio::test | L298 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
| `tests/mcpbench_integration.rs::test_concurrent_connections` | tokio::test | L338 | ported:host/plugins/mcp/tests/mcpbench.test.ts |
<!-- END GENERATED:testmap:rows -->

## WP-014：供 L22 登记的跨 lane 证据（不改变本 lane 原测试去向）

- `tests/tools_integration_tests.rs::test_tool_error_details_generation`（Rust :196-216，归 L22）
  → `host/plugins/mcp/tests/tool-details.test.ts::test_tool_error_details_generation`。
  经真实 MCP/browser provider 调用 `ctx.mcp.registry.callToolWithDetails`：Rust :207 !ok、
  :208 error.is_some、:209 details.is_some、:212 ToolNotFound、:213 message 包含工具名、
  :214 suggestions 非空、:215 首项 action_type=settings，逐条保留；code 使用 serde 名
  `TOOL_NOT_FOUND`。另逐字段断言整个七元组与 ErrorDetails 的 null/建议 URL/中文消息。
- 本 lane pending 前后均为 MCP 0、browser 2；不改 L22 文件。L22 原 pending 行由其 owner
  在消费该 API 后登记。具体调用示例见 LANE.md 的 WP-014 小节。
