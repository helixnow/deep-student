# R4-WI-13：tool_loop 钩子化第一刀（审批 + 审计迁出）

> 子代理：SA-R4-06  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-13（PipelineHook trait + 内置审批/审计钩子，tool_loop.rs 实质瘦身）

## 交付

| 项 | 结果 |
| --- | --- |
| 主提交 | `728472b4` refactor(chat_v2): extract pipeline hooks for approval and audit |
| 附带修复 | `8454faf9` fix(chat_v2): repair two pre-existing pipeline test failures |
| 新文件 | `src-tauri/src/chat_v2/pipeline/hooks.rs`（1612 行） |
| 设计文档 | `docs/dev/optimization0824/WI-13-hooks.md` |
| tool_loop.rs 行数 | **5507 → 4171（−1336 行，−24.3%）**，要求 ≥15% ✅ |
| 测试 | `cargo test --lib chat_v2::pipeline`：**246 passed / 0 failed**（含 parallel_exec_tests 21、tool_loop::tests 14、hooks::tests 3）✅ |

## 做了什么

1. **`PipelineHook` trait**（`pipeline/hooks.rs`）：`before_turn` /
   `before_tool` / `after_tool` / `before_compaction` 四个方法，全部对应
   `tool_loop.rs` 中的真实调用点（主循环迭代开头、`execute_single_tool`
   构建 ExecutionContext 前、executor Ok 分支、环内 `run_compaction` 前）。
   配套 `ToolHookContext`（只读调用上下文）、`ToolAdmission`（准入结论，
   贯穿 before_tool → ExecutionContext 注入 → after_tool）、
   `ToolGateOutcome::Block`（拦截即返回完整工具结果）。
2. **`ApprovalGateHook`**：把 `execute_single_tool` 内联的 684 行审批准入
   （Kill Switch → allowlist → trusted automation → 功能开关 → 灾难命令守卫 →
   用户命令规则 → 审批作用域绑定 → 敏感度 → AuthorityGate/plan_gate →
   ApprovalManager → 重绑定复核 → 执行前三重复核 → 计划批准原子消费）
   原样迁为 `before_tool`。顺序、日志、事件、fail-closed 语义零变化。
3. **`TaskAuditHook`**：external MCP 安全边界注记 + trusted automation
   预授权标记迁为 `after_tool`；`before_turn`/`before_compaction` 落
   `[ChatV2::audit]` 边界日志。
4. **默认注册**：`ChatV2Pipeline::new` 经 `default_pipeline_hooks()` 注册
   上述两个钩子（`hooks` 字段，Arc 链）；`with_pipeline_hook` 可追加。
5. **随迁**：`request_tool_approval`、`request_plan_gate`、
   `resolve_local_shell_approval_arguments`、`canonical_tool_short_name`、
   `tool_may_require_approval`、`approval_manager_required` 及其 3 个
   fail-closed spec 测试 → hooks.rs。

## 等价性验证

- 既有 AuthorityGate / C4 集成测试直接调用 `execute_single_tool`，未改动
  任何断言，全绿（Ask 硬拦截、Plan 单次消费、kill switch 覆盖、
  remembered 审批、headless ask 持久化等）。
- `parallel_exec_tests`（并发分段/回填/重试组合子）全绿——迁移未触碰
  并行执行组合子。
- 迁移为纯代码搬移 + 机械替换（`self`→`pipeline`、闭包→自由函数、
  `Ok(...)`→`ToolGateOutcome::Block(...)`），无逻辑改写。

## 附带修复（基线既有失败，非本重构引入）

在分支基线 `94d4e69d` 上复现确认后修复（`8454faf9`）：

1. `effective_history_token_budget(Some(0))` 返回 0，与文档注释和回归测试
   （回退 32K 默认值）不符 → 补 `v > 0` 过滤。
2. 裸名 `mcp_server_update/set_enabled/remove` 被
   `ToolExecutorRegistry::get_executor` 的外部 MCP 前缀早退路由到
   GeneralToolExecutor（会被当外部 MCP 调用转发，绕开 McpManageExecutor
   的 High/Medium 审批）→ 三个后端自有管理工具名豁免该早退。
   `chat_v2::tools::executor_registry` + `mcp_manage` 35 个测试全绿。

## 已知边界

- `chat_v2::tools` 下有 3 个与本任务无关的基线失败（
  `builtin_retrieval_executor::numbered_sources_use_type_local_citation_indexes`、
  `session_executor::session_import_creates_new_session_with_remapped_ids`、
  `skill_install_executor::install_success_narrative_routes_through_skill_trust_request`），
  在基线 `94d4e69d` 上同样失败（0 passed / 3 failed），不在 WI-13 范围，未动。
- 未触碰 `model2_pipeline` / `session_export`（任务红线）。
- 下一刀候选：live workspace injection 迁 `before_turn`、variant 适配层组合，
  见 WI-13-hooks.md §5。
