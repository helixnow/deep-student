# F1-kernel 测试去向（地基线；实现目录不归 scaffold 所有，去向同样由该 lane 填写）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane F1-kernel：89 行（真实测试 89）· obsolete 2 · pending 36 · ported 51
<!-- END GENERATED:testmap:header -->

## 测试

### WP-287 内部标签枚举入站首错（不新增 Rust inventory 行）

pending 前35→后35，ported52 / approved obsolete2 / merged0 不变；本包去向变更0。
`host/kernel/tests/cloud-config-inbound.test.ts` 补充真实 Host + F4/L21 生产插件接缝回归：
G3 原 camel 字段两次拒绝、snake_case false/true 两种入口成功、nested unknown、必填缺失、
输入字段反序与标签优先的精确首错；失败核零 settings.save 调用、已有值不变、无事件。
另核 anyOf/无 Rust 注解/adjacent 歧义、数字 Content 与序列保持 UNKNOWN。
依据为 `cloud_config_commands.rs:48-113` 及锁定 serde 的实际实现，详见同 lane SPEC WP-287；
不接管 L21/F4 原 Rust 测试去向，不以新增接缝用例增加 ported 数。

### WP-128 正式 profile 备份配置装配（不新增 Rust inventory 行）

pending 前35→后35，ported52 / approved obsolete2 / merged0 不变，本包去向变更0。
`host/kernel/tests/profile-backup-config.test.ts` 经正式39插件清单、真实 capabilities 和真实服务验证
`lib.rs:2219-2223` 五条命令可达；`backup_config.rs:74-90,116-187` 的默认/get/set、独立连接读提交值、
目录选择/取消/清除/默认路径及卸载撤销，状态命令保持 not-found。Shell 仅在外部窗口边界回答选择结果，
不替换 F4 处理器、settings 或 storage；不接管 F4 Rust 测试去向，真实窗口由 C2/X1 另验。
`profile-generate.test.ts` 保留既有断言并增补独立 backup-commands 入口；原 W13 排序用例继续保留。

### WP-193 Shell typed 错误传输（不新增 Rust inventory 行）

pending 前35→后35；ported52 / approved obsolete2 / merged0 不变；本包去向变更0。
`host/kernel/tests/shell-error-wire.test.ts` 通过真实 MessagePort→serveHost→ShellService 验证：
- `bridge.rs:77-105,114-148` → `retains code/message/details and the separate display string` 三例：
  嵌套 details、details 缺省、显式 null，三字段严格相等，显示文本独立保留，真实克隆而非对象直传。
  已全文审读 `parse_envelope_password_blocked`（:772-796）与
  `finish_script_result_maps_bridge_error_envelope`（:850-856）；此处补传输接缝，不接管 L19 原测试去向。
- 普通字符串错误（即使看似 Bridge Display）仍无数据；成功反序配对、未知/重复回复保持 settle 语义。
- 既有默认30000ms在29999ms不 settle、到期拒绝；迟到 typed 回复不改变原错误；实际关闭 MessagePort
  拒绝两个未决请求。每条路径检查 pending 与 timer 清零，成功/失败回调只调用一次。

### WP-182 工具结果预算 raw 数字原子回归（不新增 Rust inventory 行）

pending 前35→后35，新映射0；budget.rs 两条原测试（L125/L132）仍为 `ported:host/kernel/tests/agent-api.test.ts`，去向不变。
新增 `host/kernel/tests/tool-result-budget-raw.test.ts`（9例），标题沿用 Rust 名作补充回归，不改去向：
未超预算原样返回；对象/数组根收缩后达标保原子与 metadata（含 emoji 码点计数）；纯原子大数组、
收缩后仍超、根部超长原子三种 preview 均为原数字 token；chat registry.execute 默认预算三分支同验。

### WP-143 bigint-only 出站回归（不新增 Rust inventory 行）

pending 前35→后35；ported52 / approved obsolete2 / merged0 不变，原89条生成行去向未改。
新增 `host/kernel/tests/bigint-json-wire.test.ts`：
- serde_json 1.0.149 `ser.rs:108-151,1600-1661`、Tauri 2.11.5 `ipc/mod.rs:181-186,240-246`
  → `WP-143 bigint-only result/error/events retain integer tokens over MessagePort`（debug/release）：
  根bigint、数组/嵌套对象；相邻9007199254740992/3、i64两端、0，成功与CommandError逐字核json，
  投影逐值核JSON.parse；两个真实非空响应原文不同但number投影相同，内部整数不被改写。
- Tauri `event/mod.rs:125-131` → 同例的广播/Window定向事件：真实MessagePort收到完整payloadJson与
  payload/target，Host内部监听仍收原值；每次精确断言两条事件，不能以空数组或缺事件通过。
- Tauri `ipc/mod.rs:194-197` bytes原样body、既有ordinary路径
  → `WP-143 ordinary objects and bytes keep their existing wire shapes`（debug/release）：普通
  rawJSON同形对象的结果/错误/两种事件无原文字段，Uint8Array/ArrayBuffer字节及类型保持不变。
本包只补供方出口，不新增Rust原测试ported，不以供方绿签C。正式jobs及tip/base见WP-143交付报告。

### WP-133 入站精度回归（不新增 Rust inventory 行）

pending 前35→后35；ported52 / approved obsolete2 / merged0 不变。本包未改变任何生成行去向。
`host/kernel/tests/inbound-json.test.ts`：
- Tauri ipc/command.rs:62-68,84-104,134-144 + insight/handlers.rs:66-77 → 两种debug模式的真实
  MessagePort/serveHost/生产insight_list测试：相邻9007199254740992/3、i64两端、null/default、重复键/旧对象；
  断言处理器实际转给外部服务的精确值及次数，不以返回空数组单独证明精度。
- serde_json number.rs:592-598 / value/de.rs:705-728 → 整数越界、小数/指数精确invalid number、字符串仍拒绝，
  status→limit→offset签名错误先后，无处理器副作用。
- Tauri protocol.rs:522-532 → 完整原文语法错误可settle、无投影回填；既有ACL/not-found/bytes优先不变。
- 递归契约夹具→真实生产内核：Vec/$ref/struct/Option/map 的 i64/u64/i128/u128、递归 Value 原子与数值出站；
  tuple/union/上下界仍经AJV拒绝。该夹具不冒充其他lane业务或新增Rust原测试ported。
- 原 commands/binary-result/raw-json-wire 断言全部保留；首轮联合job `20261105175912-009bf1` 28pass，
  递归补测 `20261105180328-46011e` 5pass，均exit0、无Errors。最终jobs与精确tip见WP-133正式报告。

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-agent-api/src/budget.rs::tests::result_budget_is_noop_within_budget` | test | L125 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/budget.rs::tests::result_budget_shrinks_long_string_leaves_but_keeps_structure` | test | L132 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/descriptor.rs::tests::descriptor_names_include_primary_and_aliases_in_order` | test | L163 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/descriptor.rs::tests::descriptor_defaults_are_conservative` | test | L180 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::duplicate_tool_name_across_providers_fails_with_conflict` | test | L461 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::duplicate_alias_across_providers_fails_with_conflict` | test | L492 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::descriptor_without_executor_fails` | test | L517 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::executor_missing_from_roster_fails` | test | L541 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::undeclared_executor_in_non_catch_all_provider_fails` | test | L566 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::duplicate_catch_all_provider_fails` | test | L591 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::catch_all_provider_must_be_last` | test | L624 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::provider_order_and_roster_order_are_preserved` | test | L649 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::registry_resolves_names_aliases_and_catch_all` | test | L692 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::duplicate_provider_id_fails` | test | L736 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::empty_registry_fails` | test | L763 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::empty_descriptor_name_fails` | test | L769 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/registry.rs::tests::builder_does_not_require_concrete_executors` | test | L792 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/services.rs::tests::insert_get_and_require_round_trip` | test | L93 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/services.rs::tests::require_reports_missing_type_name` | test | L105 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-agent-api/src/services.rs::tests::insert_replaces_same_type_without_touching_others` | test | L113 | ported:host/kernel/tests/agent-api.test.ts |
| `crates/dstu-kernel/src/disposer.rs::tests::drop_runs_once` | test | L66 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/disposer.rs::tests::explicit_dispose_does_not_run_twice` | test | L78 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/hookset.rs::tests::registers_in_order_and_removes_by_disposer` | test | L128 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/hookset.rs::tests::snapshot_isolated_from_later_removals` | test | L144 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/hookset.rs::tests::callback_may_register_without_deadlock` | test | L160 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/hookset.rs::tests::poisoned_lock_recovers` | test | L190 | obsolete:rust-mutex-poisoning；D6 条件批准（C2 2026-11-04 approvals.d/C2-platform）。不变量由 ported:host/kernel/tests/primitives.test.ts 的 `throwing_visitor_leaves_hook_registry_usable`（visitor 抛错后注册表仍可 observe/注册）与 `callback_may_register_without_deadlock`（重入注册）覆盖 |
| `crates/dstu-kernel/src/kernel.rs::tests::kernel_band_always_runs_before_default_band` | test | L140 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/kernel.rs::tests::default_band_follows_registration_order_and_is_removable` | test | L152 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/kernel.rs::tests::gate_stops_at_first_block_and_skips_later_bands` | test | L166 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/kernel.rs::tests::waterfall_threads_context_in_band_order` | test | L210 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/kernel.rs::tests::gate_returns_none_when_empty` | test | L225 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::apply_is_idempotent_by_name` | test | L296 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::failed_apply_rolls_back_in_reverse_order_and_carries_plugin_name` | test | L312 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::unload_rolls_back_in_reverse_order` | test | L336 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::apply_all_keeps_explicit_order_and_stops_at_failure` | test | L352 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::duplicate_names_in_one_batch_apply_once` | test | L375 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/plugin.rs::tests::unload_all_uses_host_order_and_rolls_back_each_scope` | test | L410 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/slot.rs::tests::first_registration_wins` | test | L135 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/slot.rs::tests::dropping_disposer_frees_the_slot_for_a_new_provider` | test | L152 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/slot.rs::tests::replace_invalidates_the_old_disposer` | test | L165 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/slot.rs::tests::replace_disposer_clears_the_replacement` | test | L181 | ported:host/kernel/tests/primitives.test.ts |
| `crates/dstu-kernel/src/slot.rs::tests::poisoned_slot_recovers` | test | L190 | obsolete:rust-mutex-poisoning；D6 条件批准（C2 2026-11-04 approvals.d/C2-platform）。不变量由 ported:host/kernel/tests/primitives.test.ts 的 `first_registration_wins`（失败 provide 后原值仍为 1）、`dropping_disposer_frees_the_slot_for_a_new_provider`（dispose 后可重新 provide/get）与 `replace_invalidates_the_old_disposer`（旧 disposer 不破坏替换值）覆盖 |
| `src/agent_wiring/tests/command_surface_tests.rs::removed_cardforge_callback_stays_off_command_surfaces` | test | L11 | ported:host/kernel/tests/agent-wiring-command-surface.test.ts |
| `src/agent_wiring/tests/custom_agent_tests.rs::chatanki_readonly_tools_are_allowed_and_low_sensitivity` | test | L21 | ported:host/kernel/tests/agent-wiring-custom-agent.test.ts |
| `src/agent_wiring/tests/descriptor_tests.rs::every_descriptor_maps_to_a_specific_executor` | test | L240 | pending |
| `src/agent_wiring/tests/descriptor_tests.rs::independently_known_tools_all_have_descriptors` | test | L264 | pending |
| `src/agent_wiring/tests/descriptor_tests.rs::executor_roster_matches_pipeline_registration` | test | L284 | pending |
| `src/agent_wiring/tests/descriptor_tests.rs::descriptor_sensitivity_matches_executor_baseline` | test | L293 | pending |
| `src/agent_wiring/tests/headless_tests.rs::all_whitelisted_tools_are_low_sensitivity` | test | L47 | pending |
| `src/agent_wiring/tests/hooks_tests.rs::phase9_non_low_tools_enter_the_fail_closed_approval_path` | test | L13 | pending |
| `src/agent_wiring/tests/hooks_tests.rs::phase2_phase3_and_phase8_non_low_tools_fail_closed_without_approval_manager` | test | L66 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::oracle_new_registry_resolves_every_known_name_like_old_registry` | test | L83 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::oracle_holds_without_workspace_coordinator` | test | L104 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::roster_order_matches_old_registry_and_expected_roster` | test | L112 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::general_executor_stays_last_and_catches_unknown_names` | test | L125 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::projected_sensitivity_matches_executor_baseline` | test | L148 | pending |
| `src/agent_wiring/tests/legacy_tests.rs::conflicting_domain_provider_is_rejected` | test | L192 | ported:host/kernel/tests/agent-wiring-providers.test.ts |
| `src/agent_wiring/tests/legacy_tests.rs::second_catch_all_provider_is_rejected` | test | L212 | ported:host/kernel/tests/agent-wiring-providers.test.ts |
| `src/agent_wiring/tests/parallel_tests.rs::read_only_executors_declare_read_only_class` | test | L8 | pending |
| `src/agent_wiring/tests/roster_tests.rs::app_executor_roster_matches_expected_roster` | test | L74 | pending |
| `src/agent_wiring/tests/roster_tests.rs::app_executor_roster_without_workspace_omits_only_coordinator_group` | test | L83 | pending |
| `src/agent_wiring/tests/roster_tests.rs::core_executor_roster_is_ordered_subsequence_of_app_roster` | test | L101 | pending |
| `src/agent_wiring/tests/roster_tests.rs::roster_coverage_guard_flags_missing_domain_executors` | test | L127 | pending |
| `src/agent_wiring/tests/roster_tests.rs::executor_roster_injection_is_builder_order_independent` | test | L143 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_tool_pack_registered_before_general_executor` | test | L166 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_workspace_fs_registered_before_general_executor` | test | L180 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_code_navigation_registered_before_general_executor` | test | L193 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_lsp_navigation_registered_before_general_executor` | test | L207 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_external_mcp_workspace_name_bypasses_builtin_executor` | test | L223 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_attachment_stage_registered_before_general_executor` | test | L238 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_local_shell_preflight_registered_before_general_executor` | test | L251 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_self_inspect_registered_before_general_executor` | test | L264 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_skill_install_registered_before_general_executor` | test | L277 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_skill_market_tools_registered_before_general_executor` | test | L290 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_skill_workshop_registered_before_general_executor` | test | L312 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_skill_lifecycle_registered_before_general_executor` | test | L325 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_mcp_propose_registered_before_general_executor` | test | L344 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_mcp_manage_registered_before_general_executor` | test | L357 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_automation_registered_before_general_executor` | test | L381 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_runtime_root_request_registered_before_general_executor` | test | L394 | pending |
| `src/agent_wiring/tests/roster_tests.rs::test_local_shell_execute_registered_before_general_executor` | test | L407 | pending |
| `src/plugins/ilink_bot/client.rs::tests::wechat_uin_is_base64_of_decimal` | test | L353 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/client.rs::tests::chunk_text_splits` | test | L361 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/client.rs::tests::session_expired_detection` | test | L367 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/client.rs::tests::connection_failure_is_not_an_empty_success` | tokio::test | L374 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/client.rs::tests::outbound_chunks_preserve_unicode_and_order` | test | L402 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/guard.rs::tests::only_the_scanning_user_is_allowed` | test | L50 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/ilink_bot/guard.rs::tests::rate_limit_blocks` | test | L57 | ported:host/kernel/tests/plugins.test.ts |
| `src/plugins/types.rs::tests::plugin_state_defaults_to_stopped` | test | L165 | ported:host/kernel/tests/plugins.test.ts |
<!-- END GENERATED:testmap:rows -->

## 2026-11-05 当前状态（覆盖历史统计与阻塞）

**main `10f987035` 更新**：L17 `createMemoryToolMetadata` 已公开并由生产 index 提供/登记；
下文“memory/api.ts 无出口、index.ts 无注册”仅描述较早基线。纯策略方面的L17等待已解除，
但parallel原例仍缺L13 BuiltinRetrieval/BuiltinResource公开并发入口；hooks phase9仍缺L14 EssayGrading /
L06 Subagent公共敏感度，hooks phase2/3/8仍缺L13 Dstu公共策略。其余32条仍需完整可执行registry/roster，
metadata不含execute不能替代。35条pending状态不变，精确新接口需求已交C1并记入BLOCKERS顶部。

实际行状态：52 ported、0 merged、2 已批准 obsolete、35 pending（生成表头不手改）。
`custom_agent_tests` 已使用 main 的 L05 `CHATANKI_READONLY_TOOLS/findCustomProfile/safeToolSet`
和 L24 `createChatAnkiExecutors`，后者正是 `chatanki/index.ts` 使用的真实工厂；Rust `:21-57`
全部断言保留，包括完整 allowedTools 顺序。job `20261105000803-708f42`：1 passed，exit 0，无 Errors。

L04 registry/descriptors/assembleExecutorRegistry 与 L07 legacy registry 均已正式发布，L04 组装已消费
F1 composePipelineExecutorRoster，旧“没有生产消费方”的等待解除。但完整生产花名册仍缺 L17
MemoryToolExecutor / AcademicSearchExecutor / LearningOverviewExecutor 等真实执行器公共入口与注册，
`memory/api.ts` 无这些导出，`memory/index.ts` 没有 registerToolExecutors；已通知 L17/C1。
所有剩余 pending 行的证据按原测试实际依赖归组如下（不拿同名替身计 ported）：

- `descriptor_tests` 的4行、`roster_tests` 的22行、`legacy_tests` 的5行：每条都构造完整 app 花名册；
  原 `roster.rs:39-111` 包括上述缺失 L17 实例。L04 的真实 registry 已到位，但其当前组装测试使用
  foreign contribution 输入，只证明排序/缺失报错，不能代替这些完整执行器的 Rust 原断言。
- `headless_tests::all_whitelisted_tools_are_low_sensitivity`：原 `:19-37` whitelist_registry 包含
  LearningOverviewExecutor 和 MemoryToolExecutor，缺真实分类，不能仅拿 descriptor 表验证自身。
- `parallel_tests::read_only_executors_declare_read_only_class`：原 `:26-30,46-62` 断言真实
  AcademicSearchExecutor/MemoryToolExecutor 的并发级别，L17 未发布。
- `hooks_tests` 两行：phase9 原 `:16,25-42` 依赖 MemoryToolExecutor；phase2/3/8 原 `:168-181`
  依赖 LearningOverviewExecutor。L03 approvalManagerRequired 已公开，不能再把它列为缺失。

iLink 三命令整链、W13、F4 capability 原语及必需 finalizer 政策的独立阻塞见 `host/kernel/BLOCKERS.md`
顶部；它们不新增或虚增本表89条 Rust 测试数。

## 已裁定：Mutex poisoning（D6）

- `poisoned_lock_recovers`、`poisoned_slot_recovers`：2026-11-04 C2 依 D6 条件批准为
  `obsolete:rust-mutex-poisoning`，见 `migration/approvals.d/C2-platform.json`。不因“JS 没有 Mutex”裸批准：
  以下 TS 用例覆盖两条 Rust 测试保护的不变量，TESTMAP 去向保留这些映射。
  Host 侧 `HookSet`/`Slot` 是同步注册表，没有 Rust `std::sync::Mutex` 的 poisoning 状态，无法逐字复现
  “持锁线程 panic 后 `lock()` 返回 `PoisonError`”的路径。Host 实际提供的异常后可用性保证及等价验证入口：
  - `HookSet`/`HookKernel` 的注册表本身不执行用户代码；`observe`/`gate`/`waterfall` 的 visitor 抛错只向调用方
    传播，注册表内容不变，随后仍可继续 observe/gate 与注册。验证：`host/kernel/tests/primitives.test.ts`
    的 `throwing_visitor_leaves_hook_registry_usable`、`callback_may_register_without_deadlock`。
  - `Slot.provide` 在已占用时抛 `SlotOccupied`；捕获后原值仍可 `get()` 读取，原 disposer 释放后同一槽位可再次
    provide。验证：`primitives.test.ts` 的 `first_registration_wins`、`dropping_disposer_frees_the_slot_for_a_new_provider`。
  - 插件 `apply` 抛错时 `ScopedPluginHost.apply` 只回滚该插件自己的 scope，先前成功的插件保留；`extensions.ts`
    的 installer 失败也保留此前成功项并在下一次调用重试。验证：`primitives.test.ts` 的
    `failed_apply_rolls_back_in_reverse_order_and_carries_plugin_name`、`apply_all_keeps_explicit_order_and_stops_at_failure`，
    `extensions.test.ts` 的失败保留/重试用例，`profile-isolation.test.ts` 的插件级隔离用例。
  上述映射必须随 F1 测试保留；批准只覆盖 poisoning 状态本身，不豁免业务异常处理与恢复保证。
  main `2a2ba05b2` 已合入 C2 审批分片；在此基线上 `npm run migration:ledger -- --check --no-write`
  退出 0（`problems: commands 0, tests 0, orphan registrations 0`）。
- Rust Drop 对应显式 `dispose()` / `using`（Symbol.dispose），不得依赖 JS GC。

## 已实现但尚无消费方（保持 pending）

- `extensions.rs` 组合根与 `agent_wiring/roster.rs` 的 F1 自有部分已迁移：
  `host/kernel/extensions.ts`（13 条固定顺序、幂等、失败保留/重试、缺失 installer 上报）与
  `host/kernel/agent-roster.ts`（63 个核心执行器 + 5 个 coordinator 组 + L03 固定尾部，缺失一次性报错）。
  对应测试 `host/kernel/tests/extensions.test.ts`、`host/kernel/tests/agent-roster.test.ts` 用同名
  executor / installer 测试替身覆盖组合逻辑。
- `roster_tests` 的 `app_executor_roster_matches_expected_roster` 与
  `app_executor_roster_without_workspace_omits_only_coordinator_group` 两条因此已有等价 TS 用例；但按
  quality.md §三.3，L04 的 registry/pipeline 尚未消费该组合函数，TESTMAP 仍标 pending，待 L04 接入后
  改为 ported。
- `plugins.rs` 的 Canvas 读取与 Insight 被动提示算法属于 L10/L17，本 lane 不复制；只保留槽位注册位。

## 跨 lane 阻塞（36 个 agent_wiring 用例）

这 36 个用例断言的是 `src/agent_wiring` 对**其他 lane 执行器/流水线**的组装，不是 F1 自有的纯函数；
Host 侧这些服务尚未发布，按派发说明“其他 lane 的服务未发布”保留 pending，不用占位 executor 冒充。
L07 的 `registerToolExecutors` 注册入口已进 main，本 lane 不再把它列为缺失；X4 W02 的真实 roster 消费由
C1 统一协调，F1 不自行接入。当前仍缺的是 L04 的 registry/pipeline 与各 lane 的具体 executor 实现。
`legacy_tests` 中只依赖注册表构建器的 `conflicting_domain_provider_is_rejected` 与
`second_catch_all_provider_is_rejected` 已走生产 `ToolRegistryBuilder` 移植到
`host/kernel/tests/agent-wiring-providers.test.ts`（provider 输入与 Rust 的 `ConflictingProvider` /
`LegacyToolProvider` 同形；两条断言分别是重复工具名与第二个 catch-all 的报错字段）。

- `descriptor_tests`（4）、`headless_tests`（1）、`parallel_tests`（1）：
  需要 L04 的 `chat_v2::tool_descriptors::{BUILTIN_DESCRIPTORS,lookup}` 与
  `tools::executor_registry::ToolExecutorRegistry`，以及 L02/L03/L05/L06/L07/L10/L13/L14/L17/L18/L19/L21/L24
  的 71 个执行器实现（`AppExecutorRoster` 的构造目标）。
- `roster_tests`（22）：需要同一批执行器 + L03 的
  `pipeline::{assemble_registry,CoreExecutorRoster,ChatV2Pipeline}`（`with_executor_roster` /
  `with_workspace_coordinator` 的顺序无关性）与 L05 的 `WorkspaceCoordinator`。
- `legacy_tests`（5）：需要 L07 的 `tools::legacy_tool_provider::{LegacyToolProvider,LegacyExecutorAdapter,
  build_tool_registry}`（DRAFT-F1-kernel 将其列在 L07 名下）与 L04 的旧注册表；两条只依赖构建器的
  用例已移植，见上。
- `hooks_tests`（2）：需要 L03 的 `pipeline::hooks::approval_manager_required`、L05 的审批管理器，
  以及 L06/L14/L17/L19 的非 Low 执行器（Dstu/Session/Subagent/EssayGrading/IndexWebpage/LearningOverview/Memory）。
- `custom_agent_tests`（1）：需要 L05 的 `workspace::custom_agents::{CHATANKI_READONLY_TOOLS,
  find_custom_profile,safe_tool_set}` 与 L24 的 `ChatAnkiToolExecutor`。

## 跨层启动/退出边界（D2 已裁定，C2 06:38 明确组合根接点）

2026-11-04 架构裁定 D2 覆盖此前的 `startupCleanup` 装配建议；C2 06:38 进一步确认组合根接点：

- **F3 finalizer 注册点（现已进main）**：`host/platform/storage` 的 `StorageService` 原在
  `fe46369d8`/`9f8c77387` 发布 `registerFinalizer(name, fn, { after })`、`runStartupFinalizers()`、
  `finalizerNames()`；F3 只注册/排序/执行，不自动 run，也不 import 业务插件。该 API 此前仅在
  `ds-mig/F3-storage` 分支；现已随main `d84e29565`集成（包含`9900d8dda`）。
- **F1 组合根（已实现，已随 main 集成）**：`host/kernel/connection.ts::boot` 在 `loadStartupProfile` 返回后、
  发送 `HostReady` 前调用 `finishStartup`：
  - 正常启动：`await storage.runStartupFinalizers()`（存在时），全部成功后才
    `startupGate.markStartupReady()`；
  - 恢复模式：`dataSpace.status().recovery_required === true` 时跳过业务 finalizer，但仍标记 gate，
    等价 Rust `StartupReadyGuard` 在 `lib.rs:953-959` 恢复模式提前返回时的 drop；
  - 失败分支：finalizer / 恢复状态查询抛错 → `HostFatal`、退出 1，不发送 `HostReady`、不标记 gate；
  - kernel 只按服务名做结构化探测，不 import `host/platform/storage` 或 `electron/`。
- **测试**：`host/kernel/connection.test.ts` 走生产 `serveHost`，覆盖正常（finalizer 执行 → gate mark）、
  恢复（skip finalizer → gate mark）、失败（fatal / no ready / no gate mark），并经真实
  `frontend-event` 消息验证 `target` 路由。F3 合入 main 后无需改 kernel 即可自动执行 finalizer。
- **F1 保留的退出职责**：`HostRuntime.dispose()` 保持“按安装逆序停止插件 → 拒绝未决 shell 请求”的
  内核职责；全局退出编排（背景任务、storage.close 等）仍由外壳/组合根按 F3 的注册点调用，不在 kernel
  复制业务启动逻辑。具体业务清理实现仍归 F3/F4、L22 与 app 组合根。

### 真实 F3 registry 整链证据（历史取证与正式交付）

最新状态：F3 API已进main；按C2批准仅`cherry-pick -x 7fdd36afe`为`5d451e443`，
7个F1文件已进入责任分支。新增真实链四例的Node/Electron最小确认见LANE.md；以下保留原临时取证来源，
不再将F3 API进main列为阻塞。W13仍缺L20真实provider；必需finalizer注册失败政策仍待裁定。

F1 `1b3cedeaa` + 生产日志改动 `5d373dbf2` + F3 `9900d8dda`（其后 `ab794ce5c` 仅文档）的合并工作区（merge `a612c4496`，
测试提交 `7fdd36afe`，证据分支 `evidence/F1-F3-startup-real`）中的
`host/kernel/connection.startup-real.test.ts` 经生产 `serveHost` 安装真实 `StorageCordisService`
（内部真实 `StartupFinalizerRegistry`）与真实 F2 `createStartupGate`，不使用同义 registry 替身。
作业 `20261104075748-2c9c0f`：8 tests passed（真实链 4 个 + 组合根回归 4 个），exit 0。证据分支中的
F1 日志改动是 cherry-pick `df8e6206e`（内容同 F1 `5d373dbf2`）；测试依赖该改动。F1 已随 main 集成
（含 `5d373dbf2`），F3 合入 main 后执行 `git cherry-pick -x 7fdd36afe`。证据分支只用于取证，**不要整支合入**；
`7fdd36afe` 的 7 个文件全在 `host/kernel/` 且均为新增，可独立 cherry-pick（C2 2026-11-04 08:26 已接受；
main 缺 F3 时不强行带入以免破坏类型检查）。用例与契约：

| 用例 | 结果/输出 |
|---|---|
| 正常执行 | `migrate → restore → cleanup` 按 `after` 执行；执行期间 gate=false，全部成功后 mark，再发 `HostReady` |
| finalizer 抛错 | `HostFatal.message = startup finalizer failed: fixture.startup-real.restore`；日志含阶段、finalizer、completed、原始 cause；无 ready、gate=false、exit 1；失败钩子仅执行一次（无自动重试）；无 degraded 事件 |
| 恢复模式 | finalizer 已注册但全部跳过；gate=true；`HostReady` 正常 |
| 业务插件注册失败 | 真实 `FINALIZER_DUPLICATE`；插件 degraded（`host://plugins-degraded` + `plugin:host|status`），boot 仍 ready/gate；回滚前已注册的钩子仍会执行（F3 无注销句柄） |

- **执行失败输出**：`HostFatal` 只带 message/stack，因此 `connection.ts::logStartupFailure` 在抛错前把
  阶段（`recovery probe` / `runStartupFinalizers` / `startupGate.markStartupReady`）、F3
  `StartupFinalizerError` 的 `finalizer`/`completed`/`cause` 写入 Host 日志；`main.ts` 把 logger 输出到
  stderr。`connection.test.ts` 的失败用例也断言了该日志。没有新增线上事件/协议字段。
- **显式重试**：boot 不重试，失败即退出；F3 registry 的 `run()` 重入只跳过已完成项，由显式调用方触发。
  当前生产无调用方；L06 不得 catch 后自行启动或定时等待。未来进程内重试需外壳/恢复编排显式调用。
- **政策缺口（待架构师裁定）**：可选插件 apply 失败仍按既有 degraded 隔离，boot 可继续 ready；若该插件
  本应提供必需的恢复/清理钩子，当前会把“启动不完整”呈现为“可选插件降级”。必需钩子的声明/失败传播
  方式未定，F1 不擅自把全部 apply 错误改为 fatal。F3 的注册失败也没有注销已注册钩子的句柄，部分注册
  会在插件回滚后继续执行；该点需 F3/架构师一并处理。
- F3 `ab794ce5c` 的 `API.md` §9 / `STARTUP-WIRING.md` §5 仍写“F1 真实 registry 验证待完成”；本证据
  分支完成后需 F3 在合入前同步该结论（F1 不修改 F3 文件）。

## 其他 lane 的接续事项

- D3 IPC 大整数边界已集成 main（`54156058e` 合入 F1 分支）：`host/kernel/json.ts::toWireJson` 在命令结果/错误、事件载荷、
  `plugin:host|call` 参数与返回值的线上边界把 BigInt 复制为 JSON number；`findNonJson` 不再拒绝 BigInt。
  内部值不被改写（`commands.test.ts` 断言插件返回对象仍是 BigInt）。对应测试经生产入口
  `commands.test.ts`、`services.test.ts`、`tests/ui-bridge.test.ts`。
- C2 04:45 窗口定向监听接口原实现已随 `54156058e` 合入 main；C2 05:49 按 Tauri 2.11.5 源码纠正
  target 语义的修正已随 main 集成（`902d86ee3`）：`ctx.backendEvents.listenWindow(window, event, receive): () => void`
  （`host/kernel/api.ts`、`host/kernel/events.ts`）。订阅登记为
  `EventTarget::Window { label }`，投递按 `match_any_or_filter(listener.target, emitToFilter(event.target))`
  判定：后端 `emit` 广播会送达窗口监听者，`emitTo(Window/AnyLabel)` 只送达目标窗口；`source` 只是发出者，
  不参与接收范围。返回幂等 disposer，插件卸载经 `ctx.effect` 撤销；L02 的 `McpFrontendBridge` 可直接用
  `ctx.backendEvents` 满足。`host/kernel/services.test.ts` 覆盖广播→窗口、`emitTo` 目标隔离、
  source 不同但 target 匹配（quick 发出、target=main 被 main 接收）、App 目标不误投窗口、注销后无回调、
  插件卸载撤销；`host/kernel/tests/event-target.test.ts` 按 Tauri `filter_target` 矩阵覆盖 Any/Window/
  AnyLabel/Webview/WebviewWindow/App；`host/kernel/connection.test.ts` 经真实 `frontend-event` 消息验证
  `connection.ts` 把 target 透传到 `listenWindow`（广播与 target=main 命中，target=quick 不命中）。
  另用 main 的 L02 `createMcpToolsService` 接 `host.ctx.backendEvents` 冒烟（响应按 target 发送，
  source=quick / target=main 被接受），验证真实服务类可消费；L02 `index.ts` 的生产实例化仍待其接入。
- X2-R05 Host 二进制结果边界已随 main 集成（`0f3c8ef7f`）：`result.x-binary === true` 的契约
  （Rust `tauri::ipc::Response`）允许处理函数返回 `Uint8Array`（含 `Buffer`）或 `ArrayBuffer`；
  `host/kernel/commands.ts::_dispatch` 跳过 `toWireJson`/`findNonJson`，字节经 structured clone 直达 main，
  由 `ShellRuntime.encodeBody` 作为 raw body 回写，前端收到 `ArrayBuffer`。F2 现有的
  `{ "__dstuRawBytes": "<base64>" }` 信封仍是合法值（`read_file_bytes` 不需要改）；纯 JSON 传输继续靠它。
  debug 下 x-binary 只接受原始字节或信封，非 x-binary 命令返回二进制仍被拒绝。测试：
  `host/kernel/binary-result.test.ts`（生产 `createTestHost`/`CommandService._dispatch`，覆盖 Uint8Array、
  ArrayBuffer、信封、非 binary 契约拒绝，以及真实 `convert_heic_to_jpeg` 契约的 raw `Request` 输入/字节输出）
  与 `host/kernel/e2e.test.ts`（真实 Host 子进程 + advanced serialization，覆盖 Uint8Array 结果与
  raw body 输入）。media 插件尚未注册 `convert_heic_to_jpeg`，
  Android/macOS/Windows 运行时与真实 HEIC 成功 invoke 均未验证，不签收跨平台等价；前端 raw-byte 调用与
  F5 `x-binary` 契约保持不变。
- F4 的 `crates/dstu-core/src/lib.rs::tests::app_version_is_injected_from_app_manifest` 已有同义测试，
  精确目标：`ported:host/kernel/connection.test.ts`（用例标题 `app_version_is_injected_from_app_manifest`）。
  该用例经生产 `serveHost` 握手把真实 `src-tauri/Cargo.toml` `[package] version` 送入 `ctx.app.version`，
  覆盖 Rust 原断言的非空/非 `0.0.0` 语义；版本一致性仍由 `build.rs` 既有规则保证，未新增 APP_VERSION
  常量或只查文本的测试。请 F4 在自身 TESTMAP 中指向该目标。
- `error_details_tests` 的 14 行已由 F4 在 `migration/testmap/F4-security.md` 指向
  `host/platform/errors/tests/errors.test.ts`；`host/kernel/tests/error-details.test.ts` 是同一契约的副本，
  不作为本 lane 的 TESTMAP 去向。
- 官方 profile 生成已恢复并覆盖平台插件与 F2 外壳：`node host/profiles/generate.ts` 生成 36 条——`dstu.plugins` 固定首条，
  随后是 `host/platform/<name>/index.ts` 中默认导出插件的平台服务（F3/F4），然后是 `electron/index.ts` 的
  `dstu.shell`（提供 `startupGate`、注册 23 个 F2 命令），最后按目录名排序收集业务插件；
  `--check` 与磁盘不一致时退出 1。`node scripts/electron-migration/importable.mjs host/kernel/plugins.ts` 通过
  （F1 入口可被 Node 原生类型擦除加载）。
- profile 装载改为按插件隔离：缺服务的条目 inactive 并级联下游，`apply` 失败只撤销自身；汇总结果逐条 warn、
  广播 `host://plugins-degraded`、由 `plugin:host|status` 返回。只有内核错误、profile 文件无效、平台核心服务
  `storage`/`paths`/`log` 缺失仍是 `HostFatal`。用户 profile 只在文件自身无效时回退官方 profile。
  历史冒烟结果（当时的 `host/kernel/tests/profile-isolation.test.ts` 装载 `desktop.json`，不是当前main阻塞清单）：36 条清单中 34 个插件安装
  （含 `dstu.shell`），2 个 inactive：`dstu.chatanki` — `missing service "anki@1"`（L24 仍注入旧服务名，
  L16 已提供 `anki`，属跨 lane 待协调项）；`dstu.memory` — `cannot get property "log" without inject`
  （L17 `host/plugins/memory/index.ts:67` 未 inject `log`，而 `src/quick-assistant.ts:358` 访问 `ctx.log`；
  去掉 `dstu.shell` 的对照清单同样 2 条 inactive，证明与本 lane 的 shell 集成无关）。
  冒烟同时断言 `startupGate` 服务存在、shell 的 23 个命令真实注册，并核对官方清单每个条目都落在
  installed 或 degraded。
- 接线检查：F1 没有 `host/plugins/<dir>`，`npm run migration:wiring -- --lane kernel` 不会扫描 `host/kernel`。
  按该脚本同一算法以 `host/kernel/main.ts` + 全部插件 `index.ts` 为根做等价核对：`agent-api.test.ts`、
  `primitives.test.ts`、`plugins.test.ts` 的被测模块均可达；`plugins.ts` 本身即 F1 的插件入口（等价 `index.ts`），
  已由 `generate.ts` 固定加入官方 profile。`extensions.ts` / `agent-roster.ts` 已从 `api.ts` 导出，
  但尚无生产消费方，对应 TESTMAP 行保持 pending（待 L04 pipeline / 外壳组合根接入）。
- F2 的 invoke source origin 已闭环（C2 2026-11-04 订正）：main 的 `electron/main.ts:325-327` 只从 main 持有的
  `WebFrameMain`/`WebContents` 读取真实 frame URL；`electron/shell/runtime.ts:240-253,298` 用该 URL 构造
  `WindowRef.source.origin`，不信任 renderer 自报的 `message.headers.origin`；
  `browser-surface-host.test.ts` 已断言伪造 `headers.origin` 不污染 source。F1 侧 `acl.ts` 已支持 origin；
  当前没有需要 F2 重复实现的具体 Host ACL 差异。若以后发现差异，须附真实 source/target/调用证据单独立项。

## v2 回归（不新增或虚增 Rust TESTMAP 行）

- `plugins-v2.test.ts`：真实 plugin_* 命令/公开 manager，覆盖 u64/usize、单调登录时钟、完成 sleep 的监听释放、
  bootstrap 读错继续。settings/HTTP 是外部输入，PluginManager/IlinkBotPlugin 保持真实。
- `ilink-decoding.test.ts`：本地真实 HTTP server→生产 IlinkClient，覆盖 i64/u64 精度、default Vec与null、
  整数/浮点区别、重复字段、serde错误位置、sendmessage Value::as_i64与错误JSON。
- `file-decoding.test.ts`：生产 CapabilityAcl/ContractSet.fromDirectory，覆盖真实契约和非法文件；
  `capability_file_de` 对应 Tauri 依赖库的同名用例，不属于本 lane 的89条inventory，不另计ported。
- 原 `plugins.test.ts` 的5条自建诊断断言修正为带 reqwest 前缀、serde类型与行列的精确消息；
  原 Rust 8 条 ilink/types 测试标题与断言没有删除、跳过或弱化。
- `plugin_start`、`plugin_set_enabled`、`plugin_begin_login` 的远程任务整链仍受 BLOCKERS.md F1-V2-04 阻塞；
  已撤销 SPEC 输出完成勾选。ledger 静态注册 A 不能代表 v2 验收。
