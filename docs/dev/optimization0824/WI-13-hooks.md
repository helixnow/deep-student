# WI-13：Chat V2 PipelineHook（审批 / 审计钩子化）

> 状态：第一刀已落地（R4，SA-R4-06）  
> 代码：`src-tauri/src/chat_v2/pipeline/hooks.rs`（新增）、`pipeline/tool_loop.rs`（瘦身）、`pipeline.rs`（默认注册）

## 1. 动机

`pipeline/tool_loop.rs` 是 chat_v2 最大的单文件（5507 行）。其中
`execute_single_tool` 一个方法约 920 行，内联了两类横切关注点：

1. **审批准入**（约 680 行）：Kill Switch、运行时 allowlist、trusted
   automation 校验、memory/RAG/WebSearch 功能开关、不可覆盖灾难命令守卫、
   用户命令规则、本地终端审批作用域绑定、敏感度解析、AuthorityGate
   （Ask/Plan/Craft）、plan_gate 等待、ApprovalManager 人工审批
   （remembered / 请求-等待-超时）、审批后运行时绑定复核、执行前
   kill-switch/取消/权限三重复核、计划批准原子消费；
2. **审计记录**：external MCP 安全边界注记（`[ChatV2::audit]` 日志 +
   `external_mcp_security_boundary` 输出字段）、trusted automation
   预授权标记（`trusted_automation_preauthorized` 输出字段）。

这两类逻辑与「工具环编排」本体（LLM 轮次、块管理、并行执行、compaction
调度）没有数据耦合，只在固定切点交互，适合抽为钩子。

## 2. 设计

### 2.1 trait

```rust
#[async_trait::async_trait]
pub(crate) trait PipelineHook: Send + Sync {
    fn name(&self) -> &'static str;

    /// 工具环每轮迭代开头、本轮 LLM 调用前。返回 Err 可中止整轮。
    async fn before_turn(&self, pipeline, ctx: &PipelineContext, recursion_depth: u32)
        -> ChatV2Result<()>;

    /// 单个工具执行前。返回 Block(result) 时该结果直接作为工具结果回喂。
    async fn before_tool(&self, pipeline, tool_ctx: &ToolHookContext<'_>,
        admission: &mut ToolAdmission) -> ToolGateOutcome;

    /// executor 成功返回后、结果回喂/持久化前，可注记（改写）结果。
    async fn after_tool(&self, pipeline, tool_ctx: &ToolHookContext<'_>,
        admission: &ToolAdmission, result: &mut ToolResultInfo);

    /// 工具环内 compaction 真正执行前。
    async fn before_compaction(&self, pipeline, ctx: &PipelineContext, recursion_depth: u32);
}
```

四个切点都是 `tool_loop.rs` 中的真实调用点：

| 切点 | 调用位置 |
| --- | --- |
| `before_turn` | `execute_with_tools` 主循环每轮迭代开头（doom-loop/上限检查前） |
| `before_tool` | `execute_single_tool` 构建 `ExecutionContext` 之前 |
| `after_tool` | `execute_single_tool` 中 `executor_registry.execute` 的 `Ok` 分支 |
| `before_compaction` | `execute_with_tools` 环内 `run_compaction` 之前 |

### 2.2 数据流：`ToolHookContext` + `ToolAdmission`

- `ToolHookContext<'a>`：单次工具调用的只读上下文（tool_call、block_id、
  emitter、session/message/variant/round 标识、技能包根、运行时 allowlist、
  取消令牌、功能开关）。
- `ToolAdmission`：`before_tool` 链的可变产出，承载准入结论并向后传递：
  - `approval_arguments`：审批作用域绑定后的参数（shell 工具会注入
    runtime-root binding / env facts）；
  - `immutable_guard_asks / approval_required / approval_requirement_satisfied`：
    供 `shell_guard_admitted` 注入 `ExecutionContext`；
  - `is_external_mcp / trusted_automation_preauthorized`：供审计钩子；
  - `authority_admission`：执行前复核通过的 `(AuthorityMode, PermissionPreset)`，
    供 `with_shell_authority_admission` 与 external MCP 审计条件。
- `ToolGateOutcome::Block(Box<ToolResultInfo>)`：拦截时的完整工具结果
  （事件已由钩子发射），`execute_single_tool` 原样返回，与迁移前的
  `return Ok(build_preflight_blocked_result(...))` 路径逐字节等价。

### 2.3 内置钩子（默认注册，顺序敏感）

`default_pipeline_hooks()` 在 `ChatV2Pipeline::new` 中注册：

1. **`ApprovalGateHook`**（`before_tool`）：上述审批准入全序列的原样迁移。
   检查顺序、日志、事件、错误文案与迁移前一致；fail-closed 语义
   （缺 ApprovalManager 拒绝非 Low 工具、权限读取失败拒绝等）不变。
2. **`TaskAuditHook`**（`before_turn` / `after_tool` / `before_compaction`）：
   - `before_turn`：`[ChatV2::audit] turn_start` debug 日志；
   - `after_tool`：external MCP 边界注记 + trusted automation 标记（原样迁移）；
   - `before_compaction`：`[ChatV2::audit] in_loop_compaction_start` 日志。

扩展：`ChatV2Pipeline::with_pipeline_hook(Arc<dyn PipelineHook>)` 追加自定义
钩子，内置两个钩子始终在链首。

### 2.4 行为等价性

- 钩子在与原内联代码完全相同的位置、以相同顺序执行，输入输出一致；
  既有测试（`tool_loop` 的 AuthorityGate/C4 系列直接调用
  `execute_single_tool`）不改一行全绿。
- 仅注册默认钩子时无行为差异；新增的两条审计日志（turn_start /
  in_loop_compaction_start）为纯日志。
- 零钩子（理论态，仅测试可构造）：`ToolAdmission` 默认值 =
  不要求审批、无权限注入，工具直接进入 executor —— 即「无准入门」语义。

## 3. 迁移清单（tool_loop.rs → hooks.rs）

| 内容 | 原位置（行） | 去向 |
| --- | --- | --- |
| 审批准入全序列 | `execute_single_tool` 2884–3567 | `ApprovalGateHook::before_tool` |
| `build_preflight_blocked_result` 闭包 | 2841–2881 | `preflight_blocked_result` 自由函数 |
| external MCP / trusted automation 审计 | 3648–3696 | `TaskAuditHook::after_tool` |
| `tool_may_require_approval` | 2502–2522 | `impl ChatV2Pipeline`（hooks.rs，pub(crate)） |
| `resolve_local_shell_approval_arguments` | 3733–3790 | 同上 |
| `canonical_tool_short_name` | 3792–3799 | 同上 |
| `request_tool_approval` | 3801–3962 | 同上 |
| `request_plan_gate` | 3964–4123 | 同上 |
| `approval_manager_required` + 3 个 fail-closed spec 测试 | 11–13、4427–4606 | hooks.rs（含 `mod tests`） |

## 4. 结果

- `tool_loop.rs`：5507 → 4171 行（**−1336 行，−24.3%**，要求 ≥15%）；
- `hooks.rs`：新增 1612 行（含迁移代码 + 3 个迁移测试）；
- `chat_v2::pipeline` 测试（含 `parallel_exec_tests` 21 个、
  `tool_loop::tests` 14 个、`hooks::tests` 3 个）：246 passed / 0 failed。

## 5. 后续刀口（非本轮）

- live workspace injection（`execute_with_tools` 内的注入检查点）可迁为
  `before_turn`/`after_tool` 钩子，进一步瘦身主循环；
- variant 适配层（`variant_adapter`）与 hook 链的组合；
- `before_compaction` 可扩展为可否决（返回 gate 结果），承接压缩策略实验。
