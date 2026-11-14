# L19-mcp-browser 测试去向（`host/plugins/browser`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L19-mcp-browser：106 行（真实测试 106）· pending 2 · ported 104
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-browser/src/browser/bridge.rs::tests::init_script_is_nonempty_and_defines_global` | test | L723 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::session_init_script_keeps_input_capability_lexical` | test | L734 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::session_init_script_rejects_malformed_nonce` | test | L748 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::parse_envelope_ok` | test | L754 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::parse_envelope_double_encoded_string` | test | L762 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::parse_envelope_password_blocked` | test | L772 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::call_script_embeds_json_args_safely` | test | L799 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::type_script_builder_json_escapes_quotes` | test | L810 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::unsupported_message_mentions_platforms` | test | L818 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::finish_script_result_maps_eval_error` | test | L826 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::finish_script_result_maps_invalid_json` | test | L834 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::finish_script_result_parses_double_encoded_ok` | test | L842 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::finish_script_result_maps_bridge_error_envelope` | test | L850 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::timeout_error_is_explicit` | test | L859 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::default_eval_timeout_is_ten_seconds` | test | L868 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::eval_with_result_is_unsupported_off_win_mac_linux` | tokio::test | L874 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::macos_eval_with_result_roundtrip` | tokio::test | L887 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/bridge.rs::tests::linux_eval_with_result_roundtrip` | tokio::test | L899 | ported:host/plugins/browser/tests/bridge.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::new_does_not_create_file` | test | L258 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::ensure_open_creates_and_migrates` | test | L266 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::tables_exist_after_migrate` | test | L280 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::try_get_conn_before_open_fails` | test | L303 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::close_releases_pool` | test | L309 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/database.rs::tests::wal_mode_enabled` | test | L320 | ported:host/plugins/browser/tests/database.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::rejects_forbidden_schemes` | test | L121 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::allows_https` | test | L140 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::http_loopback_only_by_default` | test | L146 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::allow_insecure_http_permits_non_loopback` | test | L167 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::rejects_invalid_and_unknown_schemes` | test | L177 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::loopback_host_helpers` | test | L189 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::agent_blocks_private_and_loopback` | test | L202 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/policy.rs::tests::internal_ip_ipv4_and_ipv6` | test | L218 | ported:host/plugins/browser/tests/policy.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::upsert_get_active_and_close` | test | L648 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::push_and_truncate_history` | test | L683 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::push_truncates_forward_automatically` | test | L760 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::push_history_rebases_at_runtime_history_limit` | test | L814 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::navigation_and_current_entry_updates_survive_database_reopen` | test | L862 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::settings_get_set` | test | L964 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/repository.rs::tests::site_permissions_upsert_get` | test | L982 | ported:host/plugins/browser/tests/repository.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::truthy_parsing` | test | L2336 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::assert_settings_gates_open_missing_workbench_defaults_enabled` | test | L2347 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::workbench_mode_enabled_only_explicit_false_closes` | test | L2372 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::content_label_is_fixed` | test | L2382 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::agent_automation_capability_matches_platform` | test | L2387 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::http_allowance_depends_on_control_mode` | test | L2395 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_bounds_scale_css_coordinates_to_physical_pixels` | test | L2418 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_bounds_preserve_partially_overflowing_frames` | test | L2436 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_bounds_reject_non_finite_empty_and_offscreen_values` | test | L2470 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_bounds_round_outward_with_nonuniform_scale` | test | L2523 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_bounds_reject_unrepresentable_physical_frames` | test | L2541 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_occlusions_clip_to_the_native_viewport` | test | L2593 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_occlusions_merge_after_physical_rounding` | test | L2620 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_occlusions_reject_invalid_input_and_excessive_count` | test | L2647 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::surface_session_guard_rejects_stale_and_closed_sessions` | test | L2678 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::trusted_input_capability_is_session_bound_and_128_bit` | test | L2697 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::trusted_input_kinds_exclude_script_chosen_values` | test | L2713 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::direct_policy_rejection_never_commits_requested_url` | test | L2722 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::blocked_redirect_restores_current_url_and_forward_history` | test | L2751 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::download_filename_sanitization_removes_path_control` | test | L2784 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::download_hash_reports_sha256_and_size` | test | L2793 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::reused_session_download_owner_tracks_current_caller` | test | L2803 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::download_budgets_reserve_pending_and_count_completed_bytes` | test | L2833 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/service.rs::tests::bounded_download_hash_rejects_oversized_file` | test | L2856 | ported:host/plugins/browser/tests/service.test.ts |
| `crates/dstu-browser/src/browser/session.rs::tests::history_back_forward` | test | L313 | ported:host/plugins/browser/tests/session.test.ts |
| `crates/dstu-browser/src/browser/session.rs::tests::push_truncates_forward_stack` | test | L331 | ported:host/plugins/browser/tests/session.test.ts |
| `crates/dstu-browser/src/browser/session.rs::tests::user_takeover_blocks_then_clears_on_agent_claim` | test | L350 | ported:host/plugins/browser/tests/session.test.ts |
| `crates/dstu-browser/src/browser/session.rs::tests::takeover_notice_latch_survives_claim_until_consumed` | test | L378 | ported:host/plugins/browser/tests/session.test.ts |
| `crates/dstu-browser/src/browser/session.rs::tests::user_takeover_block_expires` | test | L406 | ported:host/plugins/browser/tests/session.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::native_webview_ready_wait_accepts_acknowledgement` | test | L820 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::native_webview_ready_wait_distinguishes_disconnect_and_timeout` | test | L832 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::navigation_policy_handle_is_shared_across_clones` | test | L848 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::macos_browser_user_agent_advertises_desktop_safari` | test | L866 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::resolved_agent_targets_reject_any_internal_address` | test | L873 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::agent_guard_blocks_literals_but_user_mode_keeps_local_navigation` | test | L887 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::public_http_policy_tracks_live_control_mode` | test | L901 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window.rs::tests::blocked_navigation_reports_url_and_reason` | test | L925 | ported:host/plugins/browser/tests/window-policy.test.ts |
| `crates/dstu-browser/src/browser/window/macos_surface_clip.rs::tests::clear_mask_signature_ignores_host_bounds` | test | L481 | ported:host/plugins/browser/tests/macos-surface-clip.test.ts |
| `crates/dstu-browser/src/browser/window/macos_surface_clip.rs::tests::shaped_mask_signature_tracks_bounds_and_occlusions` | test | L489 | ported:host/plugins/browser/tests/macos-surface-clip.test.ts |
| `crates/dstu-browser/src/cmd/browser.rs::tests::state_result_exposes_history_and_platform_capability` | test | L514 | ported:host/plugins/browser/tests/command-result.test.ts |
| `crates/dstu-browser/src/cmd/browser.rs::tests::unsupported_agent_service_error_has_bridge_code` | test | L534 | ported:host/plugins/browser/tests/command-result.test.ts |
| `crates/dstu-browser/src/cmd/browser.rs::tests::user_takeover_service_error_has_control_code` | test | L542 | ported:host/plugins/browser/tests/command-result.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::can_handle_browser_tools` | test | L1232 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::sensitivity_matrix` | test | L1250 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::concurrency_is_serial` | test | L1294 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::upload_root_allowlist_excludes_temp_and_skill_packages` | test | L1303 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::upload_mime_type_is_derived_from_safe_filename_only` | test | L1312 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::password_bridge_error_maps` | test | L1324 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::is_password_blocked_detects_reason` | test | L1335 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::mutating_tool_matrix` | test | L1352 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::control_claim_annotation` | test | L1368 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::user_takeover_err_is_structured_json` | test | L1406 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/browser_executor.rs::tests::not_in_headless_whitelist_names` | test | L1415 | ported:host/plugins/browser/tests/tool-executor.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::validates_only_http_urls_without_credentials` | test | L1227 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::index_and_webpage_arguments_are_closed_and_bounded` | test | L1238 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::webpage_markdown_contains_source_and_title` | test | L1265 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::yaml_scalar_escapes_newlines_quotes_and_control_characters` | test | L1273 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::bounded_text_is_utf8_safe_and_reports_truncation` | test | L1293 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::parses_legacy_and_object_ocr_pages` | test | L1300 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::sensitivity_and_routing_are_explicit` | test | L1309 | ported:host/plugins/browser/tests/index-webpage.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state` | test | L1328 | ported:host/plugins/browser/tests/index-status-wiring.test.ts |
| `src/chat_v2/tools/index_webpage_executor.rs::tests::rebuild_unit_test_boundary_stops_before_llm_lance_and_window_dependencies` | test | L1371 | ported:host/plugins/browser/tests/index-webpage-execute.test.ts |
| `src/cmd/web_search.rs::internal_setting_boundary_tests::blocks_internal_oauth_keys_from_generic_ipc` | test | L609 | ported:host/plugins/browser/tests/settings.test.ts |
| `src/cmd/web_search.rs::internal_setting_boundary_tests::leaves_normal_settings_available` | test | L617 | ported:host/plugins/browser/tests/settings.test.ts |
| `tests/bing_rss_search.rs::bing_rss_returns_search_citations_without_api_key` | tokio::test | L5 | ported:host/plugins/browser/tests/bing-rss.test.ts |
| `tests/browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema` | test | L24 | pending |
| `tests/browser_capability_contract.rs::embedded_browser_permissions_are_scoped_per_webview` | test | L45 | ported:host/plugins/browser/tests/capability-contract.test.ts |
<!-- END GENERATED:testmap:rows -->

## 待接入说明（本 lane）

- WP-154 仅纠正 `test_web_search_connectivity` 桌面生产注册：原 Rust 没有对应专属测试，
  新增/恢复的 `search-commands.test.ts` 入口回归不替代任何 Rust 行，不改变本表去向或分母。
  实际 pending 前后均为 browser 1、MCP 0；表头生成统计不手改。

- `browser_executor` 的 10 个策略用例与 `index_webpage_executor` 的 7 个纯 helper 用例已接到
  `browserToolPolicy` / `webpageToolPolicy` 服务（`host/plugins/browser/api.ts`，由 `index.ts` provide），
  走生产代码路径。
- GENERATED 表目前为 1 行 pending（跨 lane 阻塞）；原第 2 行已登记去向：
  - `webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state`：L12 已发布公开
    `VfsIndexService.getStatusSummary`，同名测试位于
    `host/plugins/browser/tests/index-status-wiring.test.ts`，安装真实插件经生产注册执行器验证，
    Rust :1335/1336/1340/1341/1346/1356/1360/1366/1367 的原断言逐条对应；去向列已填 `ported:`。
  - `embedded_browser_capabilities_match_tauri_schema`：仓库中不存在
    `src-tauri/gen/schemas/desktop-schema.json`（Tauri 构建产物），Electron 侧也没有等价 schema；F2 未提供。
