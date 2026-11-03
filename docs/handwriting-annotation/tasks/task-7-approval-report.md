# Task7 权限测试报告

状态：`POLICY_IMPLEMENTED_HOOK_RED_PENDING`。主 agent 报告首批 `--lib ink_` 测试中 6 项行为断言按预期失败、非破坏性项通过；已据此实现 permission policy/scope。当前 worker 未运行任何 tests/build/install；等待主 agent 运行策略绿灯并再由新批次验证真实 hook 红灯。

## 当前变更

- `src-tauri/crates/dstu-agent/src/chat_v2/approval_scope.rs`
  - `requires_destructive_ink_confirmation(tool_name, args)` 现在按参数识别破坏性调用；兼容裸名、`builtin-` 与 `builtin:` 名称。缺 document/revision/ops、未知 op 或坏结构均 fail closed；`update_object` / `remove_object` 触发一次性强制审批。
  - 破坏性调用的 v2 scope 将 `document_id`、`expected_revision` 与完整有序 ops canonicalize 后哈希；不在 key 中暴露参数。非破坏性 ink 走既有普通审批策略，不加入强制确认或 never-remember。
  - 破坏性/格式错误 ink 由参数感知的 `never_remember_approval_for_args` 与 `ignores_broad_approval_bypass_for_args` 保护，不对整个工具名无条件禁 remember。
- `src-tauri/crates/dstu-agent/src/chat_v2/tool_approval_policy.rs`
  - 破坏性/格式错误 ink 的有效敏感度固定为 High，Low global/domain/source/per-tool 设置不能降低。
- 测试由主 agent 报告已验证为预期红灯；本 worker 未运行测试，策略绿灯仍待主 agent 运行。

## 策略验证选择器

```bash
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml destructive_ink
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml malformed_ink_ops_cannot_be_downgraded_to_low_approval
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml non_destructive_ink_ops_do_not_force_one_shot_confirmation
```

关键 selector：

- `approval_scope::tests::destructive_ink_ops_have_an_opaque_ordered_scope_bound_to_all_inputs`
- `approval_scope::tests::destructive_ink_ops_require_one_shot_approval_independent_of_declared_author`
- `approval_scope::tests::destructive_ink_ops_are_never_remembered`
- `approval_scope::tests::destructive_ink_ops_ignore_broad_approval_bypass`
- `approval_scope::tests::malformed_ink_ops_cannot_be_downgraded_to_low_approval`
- `approval_scope::tests::non_destructive_ink_ops_do_not_force_one_shot_confirmation`
- `tool_approval_policy::tests::destructive_ink_confirmation_survives_tool_group_and_global_low_overrides`

## 下一批真实 hook 门禁

本批未修改 `pipeline/hooks.rs`，也未添加 hook 测试，遵照 coordinator 收敛要求。应从真实 `ApprovalGateHook::before_tool` 行为确认 FullAccess、DangerFullAccess、活动 Plan binding 和 trusted automation 不跳过 destructive ink 的一次性 ApprovalManager，以及 manager 缺失时 fail closed；需断言 pending approval / Block 等真实效果，而非只测 enum/helper。

可复用的真实 hook 测试搭建入口：`ChatV2Database::new` + `MigrationCoordinator::migrate_single(DatabaseId::ChatV2)`、`ChatSession`/`ChatV2Repo::create_session_v2`、`ChatV2Pipeline::new`、`ApprovalManager::new().with_timeout(...)`、`ChatV2EventEmitter::new_windowless_for_test`，直接构造 `ToolHookContext` 并调用 `ApprovalGateHook.before_tool`。现有完整 authority integration fixture 在 `pipeline/tool_loop.rs` 的私有测试模块内，hook sibling 测试不能直接复用该私有 helper。

trusted automation 的真实 hook 正向 bypass setup 暂有阻塞：`headless::TrustedAutomationSessionGuard::install` 是私有项，profile 只由 `run_headless_turn` / `run_headless_agent_turn` 安装；`TrustedAutomationProfile::validate` 的支持工具列表也不包含 ink。不要改测试去只断言 trusted predicate。新批次需从可支持的受控入口构造可信 profile 调用；否则把阻塞报告主 agent，不要放宽 profile 或仅测 helper。

## 主 agent 验证选择器

先单独检查编译，确认不是编译错误造成的红灯：

```bash
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml destructive_ink --no-run
```

再运行行为测试并确认预期失败：

```bash
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml destructive_ink
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml malformed_ink_ops_cannot_be_downgraded_to_low_approval
cargo test --manifest-path src-tauri/crates/dstu-agent/Cargo.toml non_destructive_ink_ops_do_not_force_one_shot_confirmation
```

应由行为断言失败，而不是编译失败。最关键的选择器：

- `approval_scope::tests::destructive_ink_ops_have_an_opaque_ordered_scope_bound_to_all_inputs`
- `approval_scope::tests::destructive_ink_ops_require_one_shot_approval_independent_of_declared_author`
- `approval_scope::tests::destructive_ink_ops_are_never_remembered`
- `approval_scope::tests::destructive_ink_ops_ignore_broad_approval_bypass`
- `approval_scope::tests::malformed_ink_ops_cannot_be_downgraded_to_low_approval`
- `approval_scope::tests::non_destructive_ink_ops_do_not_force_one_shot_confirmation`
- `tool_approval_policy::tests::destructive_ink_confirmation_survives_tool_group_and_global_low_overrides`

## 已有接口与后续门禁

本批复用 `approval_scope::{make_runtime_scope_key_v2, never_remember_approval_for_args, ignores_broad_approval_bypass_for_args}` 和 `tool_approval_policy::resolve_effective_sensitivity`；新 predicate 为 `approval_scope::requires_destructive_ink_confirmation`。

真实 hook 的 FullAccess、DangerFullAccess、Plan binding 与 trusted automation 一次性 ApprovalManager 行为未在本批覆盖（依 coordinator 指示留待下一批），`pipeline/hooks.rs` 未修改。后续必须覆盖该真实准入路径及 manager 缺失时 fail-closed；不得以 enum/string 源码断言代替行为测试。另需确认日志路径不会输出完整 ink 参数；本批只验证 scope key 不含可读文档 ID 或 payload，不等同于日志脱敏证明。
