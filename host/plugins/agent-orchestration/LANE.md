# L06-agent-orchestration：编排

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L06-agent-orchestration（编排） |
| 目录 | `host/plugins/agent-orchestration/` |
| Rust 范围（lanes.md） | super_session、automations、headless，以及 subagent、goal、todo、ask_user、session 等工具 |
| 主要提供 | `agent.subagent@1`、`agent.automation@1` |
| 主要消费 | L03、L04 |
| 特别注意 | superagent.db；Worker 生命周期，取消后再关闭的顺序 |
| 规模（本目录） | 27432 行 · 23 个文件 · 17 个命令（前端调用 17） · 239 个测试 |
| 规模（整条 lane，inventory） | 27432 行 · 23 个文件 · 17 个命令（前端 17） · 239 个测试 |
| 契约 | [`contracts/ipc/L06-agent-orchestration.json`](../../../contracts/ipc/L06-agent-orchestration.json) |
| 服务草稿 | [`contracts/services/DRAFT-L06-agent-orchestration.md`](../../../contracts/services/DRAFT-L06-agent-orchestration.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs` | 7252 | 72 | 11 |
| `src-tauri/crates/dstu-agent/src/chat_v2/headless.rs` | 2870 | 28 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs` | 83 | 0 | 6 |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/inbound.rs` | 798 | 9 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/inbox.rs` | 1348 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/mod.rs` | 83 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/prompt.rs` | 298 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/state.rs` | 1541 | 17 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/super_session/tools_schema.rs` | 146 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs` | 298 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs` | 435 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` | 1774 | 25 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` | 1371 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` | 442 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` | 251 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` | 762 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/session_executor.rs` | 2785 | 15 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` | 530 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` | 1252 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` | 870 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` | 609 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/todo_executor.rs` | 860 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` | 774 | 5 |  |

### 命令（17）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `chat_v2_automation_cancel_run` | `crates/dstu-agent/src/chat_v2/automations.rs:4657` | async | app | src/features/settings/components/automationSettingsApi.ts:632 | (runId: string) → Value ! string |
| `chat_v2_automation_create` | `crates/dstu-agent/src/chat_v2/automations.rs:4435` | async | app | src/features/settings/components/automationSettingsApi.ts:540 | (request: AutomationCreateCommandRequest) → Value ! string |
| `chat_v2_automation_delete` | `crates/dstu-agent/src/chat_v2/automations.rs:4816` | async | app | src/features/settings/components/automationSettingsApi.ts:553 | (automationId: string, expectedVersion: integer(u64)) → Value ! string |
| `chat_v2_automation_list` | `crates/dstu-agent/src/chat_v2/automations.rs:4424` | async | app | src/features/settings/components/automationSettingsApi.ts:436 | (（无）) → Value ! string |
| `chat_v2_automation_retry_run` | `crates/dstu-agent/src/chat_v2/automations.rs:4641` | async | app | src/features/settings/components/automationSettingsApi.ts:627 | (runId: string) → Value ! string |
| `chat_v2_automation_run_now` | `crates/dstu-agent/src/chat_v2/automations.rs:4959` | async | app | src/features/settings/components/automationSettingsApi.ts:567 | (automationId: string, expectedVersion: integer(u64)) → Value ! string |
| `chat_v2_automation_runs` | `crates/dstu-agent/src/chat_v2/automations.rs:4553` | async | app | src/features/settings/components/automationSettingsApi.ts:618 | (automationId?: string \| null, limit?: integer(usize) \| null) → Value ! string |
| `chat_v2_automation_set_background_enabled` | `crates/dstu-agent/src/chat_v2/automations.rs:4794` | async | app | src/features/settings/components/automationSettingsApi.ts:661 | (enabled: boolean) → Value ! string |
| `chat_v2_automation_set_enabled` | `crates/dstu-agent/src/chat_v2/automations.rs:4474` | async | app | src/features/settings/components/automationSettingsApi.ts:476 | (automationId: string, expectedVersion: integer(u64), enabled: boolean) → Value ! string |
| `chat_v2_automation_summary` | `crates/dstu-agent/src/chat_v2/automations.rs:4673` | async | app | src/features/settings/components/automationSettingsApi.ts:637 | (（无）) → Value ! string |
| `chat_v2_automation_update` | `crates/dstu-agent/src/chat_v2/automations.rs:4498` | async | app | src/features/settings/components/automationSettingsApi.ts:509 | (request: AutomationUpdateCommandRequest) → Value ! string |
| `chat_v2_super_deliver_inbox` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:58` | async | app | src/features/chat/adapters/tauri/sendOperations.ts:329 | (request: DeliverInboxRequest) → DeliverOutcome ! string |
| `super_session_ensure` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:32` | async | app | src/features/chat/superSession/api.ts:77 | (（无）) → SuperSessionState ! string |
| `super_session_get_settings` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:42` | async | app | src/features/chat/superSession/api.ts:81<br>src/features/settings/components/SuperAgentConfigPanel.tsx:31 | (（无）) → SuperSessionSettings ! string |
| `super_session_get_state` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:17` | async | app | src/features/chat/superSession/api.ts:69<br>src/stores/superAgentEnabledStore.ts:37 | (（无）) → SuperSessionState ! string |
| `super_session_set_enabled` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:23` | async | app | src/features/chat/superSession/api.ts:73<br>src/stores/superAgentEnabledStore.ts:38 | (enabled: boolean) → SuperSessionState ! string |
| `super_session_set_settings` | `crates/dstu-agent/src/chat_v2/super_session/commands.rs:48` | async | app | src/features/chat/superSession/api.ts:86<br>src/features/settings/components/SuperAgentConfigPanel.tsx:32 | (settings: SuperSessionSettings__De) → null ! string |

### 发出的事件（8）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `chat_v2_automation_run_completed` | 字面量 | crates/dstu-agent/src/chat_v2/automations.rs:4100 (emit)<br>crates/dstu-agent/src/chat_v2/automations.rs:4203 (emit) |
| `chat_v2://automations_changed` | 常量 `AUTOMATIONS_CHANGED_EVENT` | crates/dstu-agent/src/chat_v2/automations.rs:1852 (emit) |
| `session_management_change` | 常量 `SESSION_MGMT_EVENT` | crates/dstu-agent/src/chat_v2/tools/session_executor.rs:2251 (emit) |
| `super_session_changed` | 常量 `EVENT_SUPER_SESSION_CHANGED` | crates/dstu-agent/src/chat_v2/super_session/state.rs:683 (emit) |
| `super_session_inbox_changed` | 常量 `EVENT_SUPER_SESSION_INBOX_CHANGED` | crates/dstu-agent/src/chat_v2/super_session/state.rs:705 (emit) |
| `todo://changed` | 字面量 | crates/dstu-agent/src/chat_v2/automations.rs:2606 (emit) |
| `workspace_worker_ready` | 常量 `WORKSPACE_WORKER_READY_EVENT` | crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:694 (emit) |
| `channel` | 动态（表达式） | crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:154 (emit) |

### 契约中的事件（8，`contracts/ipc/L06-agent-orchestration.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `chat_v2_session_{}` | 是 | object \| object \| Value | crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:154 (emit) |
| `workspace_worker_ready` | 否 | object \| object \| object \| object | crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:694 (emit) |
| `chat_v2://automations_changed` | 否 | object | crates/dstu-agent/src/chat_v2/automations.rs:1852 (emit) |
| `chat_v2_automation_run_completed` | 否 | object \| object | crates/dstu-agent/src/chat_v2/automations.rs:4100 (emit)<br>crates/dstu-agent/src/chat_v2/automations.rs:4203 (emit) |
| `session_management_change` | 否 | object | crates/dstu-agent/src/chat_v2/tools/session_executor.rs:2251 (emit) |
| `super_session_changed` | 否 | ChangedPayload | crates/dstu-agent/src/chat_v2/super_session/state.rs:683 (emit) |
| `super_session_inbox_changed` | 否 | InboxChangedPayload | crates/dstu-agent/src/chat_v2/super_session/state.rs:705 (emit) |
| `todo://changed` | 否 | object \| object \| object | crates/dstu-agent/src/chat_v2/automations.rs:2606 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

- 已声明命令（17/17）：automation summary/background/retry/list/create/update/set_enabled/delete/runs/cancel_run/run_now、super_session ensure/get_state/set_enabled/get_settings/set_settings、`chat_v2_super_deliver_inbox`。其中 `chat_v2_super_deliver_inbox` 仅在 `chat.send@1` 发布时注册（`ctx.inject`）；其余 16 个命令始终注册。
- 服务：`agentAutomation`、`agentSubagent` 均已 provide；`agentSubagent` 的 `deliverInbox` / `runHeadlessTurn` / `runHeadlessAgentTurn` 是条件成员（provider 缺失时为 `undefined`）。`api.ts` 另发布 `BUILTIN_DESCRIPTORS` / `isPtcAllowed`、工具描述符类型、L04 人设校验/原子写/文件锁、L19 `LEGACY_HEADLESS_ALLOWED_TOOLS`、F2 通知消费类型与 `SessionImportRepository`（D1 接缝）。
- 测试：TESTMAP 中本 lane 239 个 Rust 测试已移植 239（pending 0）；额外测试覆盖服务条件注册、PTC 导出、schedule 省略 null、逐步错误上下文、once_completed、OS 通知策略/补投、agent_turn 终态与心跳空转、kill-switch IPC 错误、session import 写入端口。
- 待接线（跨 lane）：`chat.send@1`、`chatSession.runHeadlessTurn` / `runHeadlessAgentTurn`、L04 `ToolExecutorRegistry`（含执行器事件）；逐条证据与提供方见 [BLOCKERS.md](BLOCKERS.md)，摘要见 [SPEC.md](SPEC.md)「服务发布与接线」。
- 工具执行器：本 lane 已发布判定/schema/纯逻辑面（`api.ts`），但 L04 的 `ToolExecutorRegistry`/roster 注入点尚未发布，执行器无法注册；ask_user 回调表、L05 sleep manager、L04 goal 仓储等接口缺口同样记录在 BLOCKERS.md 第 2 节。未注册占位执行器。
- chat_v2 仓储：session 工具的 list/page/tags/search 只读原语由本 lane `repository/session-tools.ts` 按 `repo.rs` 移植并以真实迁移库测试；`session_import` 写入按 D1 改为 L04 `*WithConn` 端口，调用方持有事务（BLOCKERS.md 第 3 节；L04 分支未合入 main）。
- notify 的 VFS 待办已接 L11 `vfsRepo`（`repository/automation-todo.ts`），含幂等回执与 `todo://changed`。
- OS 通知优先消费已合入 main 的 F2 `systemNotification`，provider 缺失时回退 F2 shell 原语；三档策略、预约前窗口抑制、at-most-once 回执与补投语义不变（`src/automation-notifications.ts`）。启动恢复在 F3 `registerFinalizer` 可用时走平台钩子（只做初始化），tick 等 F2 `startupGate` 标记启动完成后才启动；注册被拒（重复/晚注册等）保持 fail-closed、不自行启动，只有平台完全没有该接缝时才走立即启动的兼容分支；周期 tick 经 F4 `backgroundTasks` 跟踪。

## 当前状态与下一步（2026-11-04，续作会话）

已完成：

- 17/17 命令已注册（`chat_v2_super_deliver_inbox` 按 B1 条件注册），TESTMAP 239/239 `ported`、pending 0；`repository/automations.ts` 已按职责拆分（`dbbfd4c2c`，聚合出口 41 行）。
- R2 已复核关闭 O2–O5、O8；本分支当前代码对 R2 最新未决三项均为「已修」：
  - **O6 取消 once 额外 `once_completed`**：`4cbc09634` 把取消入口/仓储改为日志-only hooks（`repository/automation-runs.ts` `cancelAutomationRun` 只重建 `{info,warn}`），事件顺序测试 `cancel endpoints finalize once automations without emitting once_completed` 经真实 IPC 与公开 service 各取消一条 once，只见到两次 `cancel_run`。
  - **O1 通知预约/窗口抑制顺序与 retryAt 格式**：`bc965752a`/`6772ac1f0` 在 `deliverRunNotification` 中按 policy → 窗口预检 → reserve → notify 顺序执行（预约前不写 marker）；`4cbc09634` 的 `releaseAndScheduleRetry` 用 `formatTimestampMillis`（`+00:00`）写 `next_attempt_at`。测试 `prechecks window activity before reserving with the F2 service`、`does not attempt the delivery reservation while the window is active`、两条失败补投断言 `endsWith('+00:00')`。
  - **O7 legacy 迁移事务边界**：`db42e4ea4` 删除 WithConn 探测分支，恢复 Rust 顺序「settings 读取/解析 → IMMEDIATE 插入事务提交 → settings 保存 marker」（`repository/automation-legacy.ts`），测试 `legacy_json_migration_commits_definitions_before_saving_the_marker`、`legacy_json_migration_reads_before_the_transaction_and_saves_the_marker_after_commit`。
- 启动注册被拒不自启 tick（`d540b9166`）已由 C1 认可，不再改动。

剩余（真实跨 lane 阻塞，不在本 lane 自有范围）：

- O1 完整 headless 执行：L03/L04 的 `runHeadlessTurn` / `runHeadlessAgentTurn` 与 `chat.send@1` 未在 main 发布（BLOCKERS B1/B2）。
- O7 真实会话导入写入：L04 `SessionImportRepository`（`*WithConn`）仅在 `ds-mig/L04-chat-session`，main 无 provider/生产调用（BLOCKERS 第 3 节）。
- 必需 `registerFinalizer` 失败政策待 F3/架构师明确（BLOCKERS 第 5 节）；本 lane 保持 fail-closed，不自行定义成功降级。

本轮已执行：

1. 经 job 队列跑 typecheck（`20261104083606-488622`，退出 0）与全 lane 测试（`20261104083606-1345c3`，33 文件 / 335 用例通过，退出 0）。
2. SPEC.md 已新增「验收问题处理」小节，逐条写明 O1/O6/O7 的提交哈希、生产入口与测试证据，以及仍阻塞的 O1/O7 整项。
3. 提交 `63e3efe5a`（证据）、`9cfbcce8d`（L05 正式服务面复验）、`62c563ff1`（基线钉定）；交 R2 复核时以当前分支 HEAD 为准。本轮未动 O2–O5/O8，也未重做已认可的启动闸门修复。

## v2 接手盘点（2026-11-04，新会话）

本盘点以 `main` 合并后的源码为准；`ACCEPTANCE.md` 是复核快照，不把其中的旧路径描述当作当前实现证据。八类规则的结论如下，`待复核` 表示尚未以生产入口和 Rust 逐分支证据关闭，不能仅凭 TESTMAP 的 `ported` 计为完成。

| 命令/模块 | v2 §1 问题类型 | 当前结论与证据（文件:行） |
|---|---|---|
| `chat_v2_automation_list` | 1.1/1.3/1.4/1.5/1.6 | IPC 已从 `index.ts:176` 到 `automationListResponse`；列表 schedule 省略 `null` 由 `repository/automation-definitions.ts:27-48`；行解码仍需核对 malformed JSON 的 serde 严格性（`repository/automation-definitions.ts:50-72,75-116`），生产入口测试待补。 |
| `chat_v2_automation_create` | 1.2/1.3/1.4/1.6/1.7 | 生产入口 `index.ts:177-183`，只写 `automation_definitions`（`repository/automation-definitions.ts:119-132`），事务/错误分支在 `:201-229`；请求解码与未知字段、持久化 profile 解码仍待逐字段审计。 |
| `chat_v2_automation_set_enabled` | 1.3/1.4/1.6/1.7 | 入口 `index.ts:185-191`；CAS、after-commit 取消在 `repository/automation-definitions.ts:257-339`；`computeNextTrigger` 的异常分支仍有无日志 catch（`:282-288`），须与 Rust warn/error 逐条核对。 |
| `chat_v2_automation_update` | 1.3/1.4/1.6 | 入口 `index.ts:193-211`；Rust trim、CAS、提交后重载在 `repository/automation-definitions.ts:349-475`；错误上下文已有分层，但 profile/DTO 解码和每个 Rust 日志尚未完成审计。 |
| `chat_v2_automation_delete` | 1.2/1.4/1.6 | 入口 `index.ts:213-218`；只删除自有 automation 定义并在事务内检查 active runs（`repository/automation-definitions.ts:477-523`）；生产入口错误顺序和数据库失败文案需专门回归。 |
| `chat_v2_automation_runs` | 1.3/1.4/1.6 | 入口 `index.ts:220-224`，查询/时长映射在 `repository/automation-runs.ts`；`delivered_json` 多处 JSON 解码（`:26-68,121-168,531-533`）需改为显式 decoder，不能以 `JSON.parse` 结果直接当类型。 |
| `chat_v2_automation_cancel_run` | 1.4/1.6/1.7 | 入口 `index.ts:226-231`；取消后 prune、token、once 日志-only hooks 的顺序在 `repository/automation-runs.ts:225-263`；当前 Rust 的读取失败 warn/continue 与 TS 日志对应关系待补证。 |
| `chat_v2_automation_retry_run` | 1.3/1.4/1.6 | 入口 `index.ts:243-247`，状态更新在 `repository/automation-summary.ts:36-56`；retry payload 与 serde/整数边界、DB 错误上下文待生产入口复核。 |
| `chat_v2_automation_summary` | 1.3/1.4/1.6 | 入口 `index.ts:167-175`，聚合在 `repository/automation-summary.ts:1-56`；settings 读取的 Rust 默认值已有 best-effort 分支，但日志和错误逐项对照未完成。 |
| `chat_v2_automation_set_background_enabled` | 1.4/1.6 | 入口 `index.ts:233-241`；保存成功后才 emit，失败前缀保留；命令与公开 service 两条入口的错误形状需合并测试。 |
| `chat_v2_automation_run_now` | 1.1/1.4/1.6/1.7/1.8 | 入口 `index.ts:260-263`；kill-switch 普通异常已转 `CommandError`（`:267-280`），runtime 的 claim/AbortSignal/终态在 `src/automation-runtime.ts:240-338,404-579`；真实 headless provider 未在 main 发布，完整成功链阻塞 B2，不能用 fixture 签收。 |
| `super_session_get_settings` | 1.3/1.4 | 入口 `index.ts:564`，settings decoder/default 在 `src/settings.ts:27-32`；Rust 读取失败默认空字符串的日志语义需逐条确认。 |
| `super_session_set_settings` | 1.3/1.4 | 入口 `index.ts:630-638`，Unicode trim/截断/保存错误在 `src/settings.ts:35-41`；生产入口测试需覆盖错误传播。 |
| `super_session_get_state` | 1.1/1.4/1.6 | disabled 短路和启用失败 warn 在 `index.ts:610-619`；`super-state.ts` 的 fallback 分支、依赖缺失文案和事件顺序待真实组合复验。 |
| `super_session_ensure` | 1.1/1.4/1.6 | disabled 短路、ensure 后 changed 事件在 `index.ts:602-608`；启用链依赖 L04/L05 正式 provider，当前仅有测试 provider，需组合验收。 |
| `super_session_set_enabled` | 1.1/1.2/1.4/1.7 | 入口 `index.ts:627-628`；关闭取消 worker/隐藏 session 的顺序在 `src/super-state.ts:623-649`；真实 agentWorkspace/chatState 组合和错误传播待验。 |
| `chat_v2_super_deliver_inbox` | 1.1/1.4/1.6/1.7 | 仅在 `chat.send@1` 注入后注册（`index.ts:547-563`），入口日志保留；L04 未在 main 发布真实发送管线，B1 是真实阻塞，fixture 不能签收。 |
| `agentAutomation` / `agentSubagent` 服务 | 1.1/1.7/1.8 | `ctx.provide` 在 `index.ts:468-523,641-672`；headless/inbox 成员按 provider 动态可见；L04 ToolExecutorRegistry 未在 main 发布，工具执行器事件不能伪造（BLOCKERS B3）。 |
| automation 持久化 decoder | 1.3/1.4 | `repository/automation-definitions.ts:50-72,89-93` 使用 `JSON.parse` 后宽松过滤/类型断言，尤其 trusted profile 未调用 `normalizeTrustedProfile`；这是自有问题，第一阶段修复并补真实 repository/IPC 测试。 |
| automation scheduler / startup | 1.4/1.6/1.7 | once 成功/失败日志和 changed 事件在 `repository/automation-runs.ts:275-293`；F3 注册失败 fail-closed 在 `index.ts:438-460`，退出清理在 `:462-465`；真实 F3 registry/gate 仍待 main 接缝。 |
| session-tools / session import | 1.2/1.7 | 读取 SQL 在 `repository/session-tools.ts:224-315`；写入编排通过 `SessionImportRepository`（`src/session-tools.ts:1019-1068`），不直接写 L04 表；真实 L04 `*WithConn` provider 未在 main，B4/O7 接缝阻塞。 |
| automation todo / notification | 1.1/1.2/1.4/1.7 | `vfsRepo` 正式服务消费在 `index.ts:296-313`，回执表为本 lane 自有表；通知窗口预检/预约/补投在 `src/automation-notifications.ts:222-323`；真实组合 ensure-disabled、kill-switch、todo 验收尚未完成。 |

### 复核未勾选项处理计划

1. O1：保留已提交的通知顺序、agent_turn 终态、取消日志和启动 fail-closed 修复；先用真实 main provider 复验，B1/B2/B3 未解除前不以 fixture 关闭整项。
2. O6/O7：复核 once cancel 的日志-only 入口与 legacy 的「settings 读取 → 事务提交 → marker 保存」边界；若源码与 Rust 一致只补生产入口证据，不重做已提交修复。
3. 真实插件组合验收：补 ensure-disabled、kill-switch reject、todo 投递测试；测试必须经 `index.ts` 命令或公开 service，并断言错误/事件/数据库副作用。
4. 数据边界：先修持久化 schedule、trusted profile、delivered channels 的显式 decoder，再按 Rust 结构补 malformed/unknown/type 错误测试；不以宽松 JSON.parse 或类型断言代替 serde。
5. 长文件拆分仅在行为修复后处理；不得为了行数指标改变事务、日志或调用顺序。

### 真实跨 lane 阻塞

| 阻塞 | 提供方与证据 | 对本 lane 的影响 |
|---|---|---|
| B1 `chat.send@1` | L04 `chat/api.ts` 与 `chat/index.ts` 在 main 无 provider；需求与最小消费接口见 `BLOCKERS.md:B1` | inbox 命令只能条件注册，不能用 fixture 宣称完整发送链。 |
| B2 headless runner | L03/L04 main 无 `runHeadlessTurn` / `runHeadlessAgentTurn`；`BLOCKERS.md:B2` | agent_turn 只能显式失败收尾，无法签收真实成功链。 |
| B3 ToolExecutorRegistry | L04 `f47467e34` 只在未合入分支；main 无 registry provider，`BLOCKERS.md:B3` | 工具执行器及三个执行器事件没有生产注册点。 |
| D1 SessionImportRepository | L04 `44a15ca22` 的 `*WithConn` 未合入 main；`repository/session-tools.ts` 仅保留调用方事务编排 | session import 跨表原子写不能完成真实组合验收。 |
| F3 startup registration failure policy | `BLOCKERS.md:90-100` 的旧请求需缩小：协调者已裁定 run 失败不 ready、不 mark gate、HostFatal 退出 1、不自动重试；仅 register 失败政策未定 | 本 lane 保持注册失败 fail-closed；真实 F3 registry/gate 合入后验证。 |

接手检查：ledger 作业 `20261104103225-c5af3f` 退出 0（全仓 commands 1058，A 92% / B 5.9%；这是机械统计，不是本 lane 的 v2 签收）。合并后的最小 O1/O6/O7 与 Super 命令基线作业 `20261104104957-613c04`、typecheck `20261104104957-02bb8c` 已入队。

补充自有发现 **V2-01**：公开服务 `shouldKeepBackground`（`index.ts:515-516`）在 settings/automation 查询错误时抛错；Rust `automations.rs:4779-4791` 明确 settings 错误默认 true、load 错误默认 false。必须通过公开 service 测试修复，不能归为跨 lane 阻塞。盘点中的其他“待核对”不是已确认缺陷，例如 cancel 的 load 失败 Rust `if let Ok` 本就无日志，不能机械补 warn。

补充自有发现 **V2-02（O2 待办组合后继）**：`repository/automation-todo.ts:96-107` 在事务回调中捕获失败后返回 false，F3 会提交；Rust `automations.rs:2580-2603` 提前 return 会 Drop 回滚，尤其回执失败必须撤销已经创建的 todo。先加真实 L11 插件 + SQLite 触发器故障的 IPC 测试，再恢复回滚及分步日志。第二次 main 合并已带入 R2 更新的 ACCEPTANCE，O2/O3/O4/O5/O8 的签收已可直接从本地文件核实；O1/O6/O7 仍未勾选。

### 修复记录（2026-11-04 续）

- **X6-UD-L06-01（C1 返工）**：`rowToAutomation` 原以 `JSON.parse(profileJson) as TrustedAutomationProfile` 读取持久 profile。现改为 `src/trusted-profile.ts:decodePersistedTrustedProfile`，按 Rust `automations.rs:298-318` 的 serde derive（camelCase、`deny_unknown_fields`、10 个字段全部必填无默认、`AutomationRootAccess` 仅 `read_only`/`read_write`，含 `{"read_only":null}` 外部标签形式、u16/u32/u64 整数）解码：按 JSON 键序报 unknown field / invalid type / invalid value，结束后按声明顺序报 missing field；外层沿用 rusqlite `Conversion error from type Text at index: <字节长度>, …` 与原 `Failed to load automations` / `Failed to load automation` 上下文。与 Rust 一致不在读取时 `validate()`。生产入口测试：`tests/automation-crud-commands.test.ts` 的 `X6-UD-L06-01` 组（list 16 种非法输入 + update 先报读取错误后才判版本冲突 + 空白列为 None），作业 `20261104113053-b17b43` 40/40 通过。已知未复现：serde_json 的 ` at line L column C` 后缀、重复键（serde 报 duplicate field，JSON.parse 取后者）、`1.0` 形式整数、数组形式 struct、超过 2^53 的 u64 精度——均不由本 lane 写入路径产生。出站 `automationToListObject → JsonValue`（同文件 :150 附近）按 C1 指示不作为入站解码缺陷处理，未改。
- **V2-02**：`deliverAutomationTodo` 各步失败先记 Rust 同名 warn，再抛内部回滚标记让 F3 事务回滚（含已创建的 todo）；事务开始/提交失败分别记 `begin todo delivery failed` / `commit todo delivery failed`；事件仍只在提交后发。测试：`tests/real-plugin-composition.test.ts`（真实 L04/L05/L11/L13 插件，仅替换 OS 通知传输），用触发器让回执 INSERT 失败，断言 todo 数不变、无回执、无 `todo://changed`、run 终态 `error/Todo delivery failed`；成功用例以独立连接在事件发出瞬间确认回执已提交。
- **V2-01**：公开服务 `shouldKeepBackground` 按 `automations.rs:4779-4792`：settings 读取错误视为开启，定义读取错误返回 false（Rust 两处均无日志）。测试经 `agentAutomation` 服务：删 settings 表仍为 true，schedule_json 损坏后为 false。
- 另见待审：`src/custom-agent.ts:217` 的 `JSON.parse(text) as PersonaProposalMeta` 属同类入站断言，下一轮按 Rust 结构核对。
- **X6-UD-L06-01 第二轮（C1：不以写入器缩域）**：数字改走 L20 已发布的 `parseJsonLossless`（`host/plugins/sync/api.ts`），按 serde_json 词法分类：整数记号在 i64/u64 范围内为整数，带小数/指数的记号与超出 u64 的整数记号为 f64；f64 写入整数字段报 `invalid type: floating point \`1.0\`, expected u16`，浮点显示按 Rust `f64` Display + serde `WithDecimalPoint`（无指数）；超过 2^53 的整数精确比较范围；`1e400` 报 `number out of range`。测试同在 `X6-UD-L06-01` 组。
  **仍未决（不宣称完整解码已签）**：
  1. 重复字段：serde derive 报 `duplicate field \`x\``，`JSON.parse`/`parseJsonLossless` 取后者，TS 当前接受。
  2. 键顺序：JS 对象把整数样式键排到前面，多个错误同时存在时首个报错可能与 Rust 不同。
  3. serde_json 错误后缀 ` at line L column C` 未复现。
  4. 数组形式 struct（serde_json 接受 `[v1,…,v10]`），TS 报 invalid type。
  5. u64 在 2^53 到 u64::MAX 之间：Rust 接受，TS 因 profile 类型为 `number` 显式失败（不舍入）。
  1–4 需要带位置、保留重复键的 serde 精确读取器；仓内已有三份私有实现（`sync-providers/src/json_exact.ts`、`agent-workspace/src/runtime-root-records.ts`、`vfs/repository/json.ts`），均未在 api.ts 发布，本 lane 不复制，已在 BLOCKERS.md §6 请求发布共享面。5 需要把 profile 的 u64 字段改为 bigint 并改 hash/序列化，待裁定。
  **以上 1–5 已由 WP-031 关闭（见文末「WP-031」）**；本段保留为历史记录。

## v2 排雷清单（X6 基线 2ee9a9cbe 候选，按当前 SHA 逐条核验）

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。info/assert/log 计数只作人工线索，不按数量补 expect 或补日志。

### single-writer：0 条

### unchecked-decode
| 位置（基线） | 当前核验 | Rust 证据 | 对应 finding / 状态 |
|---|---|---|---|
| `repository/automation-definitions.ts:92` json-parse-assertion | 已改为 `decodePersistedTrustedProfile`（WP-031 起基于 F4 `JsonReader`） | `automations.rs:298-318,989-1003` | **X6-UD-L06-01**，WP-031 关闭「第二轮」1–5；签收归独立复核，本 lane 不自签 |
| `repository/automation-definitions.ts:150` double-assertion[info] | 出站 `automationToListObject → JsonValue`（构造 Conflict details），不是入站解码 | `automations.rs:automation_version_conflict_error` | C1 指示不算入站缺陷，不改 |
| `src/custom-agent.ts:217` json-parse-assertion | 原 `JSON.parse as PersonaProposalMeta`；读失败/解析失败也没有 Rust 的 `Failed to read PROPOSAL.json:` / `Invalid PROPOSAL.json:` 上下文；写出把 `previousSha256: null` 写进文件（Rust `skip_serializing_if`） | `custom_agent_executor.rs:64-81,439-451` | **X6-UD-L06-custom-agent-217**，已修：字段解码（未知字段忽略、`previousSha256` default/None、其余必填 String，JSON 键序报错、声明序报缺字段），两层错误上下文，写出按声明序并省略 None。测试 `tests/custom-agent.test.ts` 同名组（作业 20261104125444-d22f0b）。未决：重复字段、行列后缀（同 BLOCKERS §6）。入口仍是 `CustomAgentStore`：工具执行器注册受 B3 阻塞 |
| `src/subagent-args.ts:54` json-parse-assertion | `JSON.parse(content) as Json` 后立即做对象/字段检查；Rust 解析为 `serde_json::Value`（任意 JSON），`as Json` 不缩窄类型 | `subagent_executor.rs` is_own_agent_completion | 不是缺陷，不改 |
| `index.ts:446-513` double-assertion[info]（12 处） | 均为 `agentAutomation` 服务返回值的出站 `as unknown as Json`，不是入站解码 | — | 出站类型边界，不改业务 |
| `src/super-session-exec.ts:106` double-assertion[info] | 把已合并的 metadata 传给 L05 `updateAgentMetadata` 的参数类型断言，出站 | `super_session` close_worker | 出站，不改 |

### prod-reachable
| 位置 | 当前核验 | Rust 证据 | 状态 |
|---|---|---|---|
| `tests/legacy.test.ts` → `migrateLegacyDb` | 确认：生产代码没有调用方，启动时没有 `super_session::init` | `state.rs:1025-1062`，`lib.rs:1713` | **X6-PR-L06-legacy-1**，已修：注册 F3 finalizer `l06.superSessionStartup`，迁移旧 `<dataDir>/superagent/superagent.db` 开关，启用时 `ensure()`，不发事件，日志同 Rust。测试 `tests/super-commands.test.ts` 同名组（作业 20261104130021-c71a11） |
| `tests/tool-schemas.test.ts` → `canHandleGoalTool` / `goalToolSchemas` / `parseGoalTokenBudget` | 确认没有生产调用方；Rust 在 `tools/registry.rs:58,195` 注册进 ToolRegistry | `registry.rs:195-` | 阻塞 **B3**（L04 ToolExecutorRegistry 不在 main），不能伪造注册点 |

### assert-parity（13 条，人工线索）
已逐条对照，结果见下方 C2 ID 映射表（X6-AP-0001…0013）。作业 20261104134442-728b06、20261104140022-b049de。

### log-parity（17 条 info）
`src/{inbound,super-inbox-drain,attempt-completion,automation-tool-args,custom-agent,goal-tools,role-packs,self-inspect,subagent-args,super-session-exec,task-audit,todo,tool-pack}.ts`、`repository/session-tools.ts`、插件级汇总：只作线索，状态 **待核**。已知一处 TS 比 Rust 多日志：`custom-agent.ts countPendingProposals` 跳过损坏提案时 warn，Rust `if let Ok` 静默。

### owner 接口请求
- BLOCKERS §6：serde 精确 JSON 读取器（重复键/键序/行列/数组 struct）。
- B3：goal/custom-agent/其它工具执行器的注册点。

### C2 冻结报告稳定 ID 映射（0119143715c0，基线 2ee9a9cbe）

只做编号映射，不重编号、不重复修已修项。

| C2 ID | 本清单条目 | 状态 |
|---|---|---|
| X6-UD-0001 | `automation-definitions.ts:92`（= X6-UD-L06-01） | WP-031 迁 F4 JsonReader，未决 1–5 关闭（见文末「WP-031」）；待复核签收 |
| X6-UD-0002 | `custom-agent.ts:217`（= X6-UD-L06-custom-agent-217） | 已迁 F4 JsonReader，补重复字段/流式错误顺序/字节行列/数组结构；WP-145 后改调已发布的 `skipIgnoredValue`/`endArray`，33 pass、0 skipped；未签完整等价，生产执行器仍受 B3 阻塞 |
| X6-UD-0003 | `subagent-args.ts:54` | 核验不是缺陷：Rust 解析为 `serde_json::Value`，后面紧跟字段检查 |
| X6-PR-0001 | `legacy.test.ts` → `migrateLegacyDb`（= X6-PR-L06-legacy-1） | 已修 cb74679c0（启动 finalizer `l06.superSessionStartup`） |
| X6-PR-0002/0003/0004 | goal 工具 `canHandleGoalTool`/`goalToolSchemas`/`parseGoalTokenBudget` | 阻塞 B3（L04 ToolExecutorRegistry 不在 main）；按 C1 精确 TESTMAP 清单，三条 Rust testId 的去向均改为 pending，保留原 TS 测试，不改整文件其它用例 |
| X6-AP-0001 | `automation-repository.test.ts` action_type_serde_uses_snake_case | 真缺：Rust 还断言 `AutomationActionType::parse`（大小写/拒绝）。补经工具参数解析器的断言；同时修出 **X6-AP-0001-parse-msg**：Rust 报错回显 trim+ASCII 小写后的值（`other`），TS 回显原值，且用 Unicode `toLowerCase`；已修 action_type/catch_up_policy/session_mode/schedule.kind，`schedule.kind` 缺失或非字符串改报 `'schedule.kind' is required`（`automation_executor.rs:342-345`） |
| X6-AP-0002 | ensure_heartbeat_in_list_is_idempotent | 真缺：补 `validateSchedule(heartbeat.schedule)` 不抛 |
| X6-AP-0003 | active_run_guard_does_not_remove_a_newer_token | 真缺：补「第二次 register 后两枚 token 都未取消」 |
| X6-AP-0004 | full_update_can_clear_nullable_agent_fields | 真缺：Rust 先断言 UI DTO 的显式 null 解码为 Some(None)；补经 `updateFieldsFromRequest` 的断言，再把解码结果交给 `updateAutomationFull` |
| X6-AP-0005 | full_update_rejects_stale_version… | 部分：补序列化载荷 code/current.version（UI 命令路径 `automationCommandError`）；Rust 测试用 agent_facing=true（工具执行器，B3 阻塞），未覆盖截断字段 |
| X6-AP-0006 | headless execution_policy… | 等价：15 个 Rust 断言全由循环覆盖 |
| X6-AP-0007 | inbound default_config… | 等价：循环覆盖 manual/ilink/chat + 拒绝项 |
| X6-AP-0008 | retire_metadata_shapes… | 等价：缺的 `Value::Null` 情形在唯一调用方 `super-state.ts:280-285` 处理（非对象 metadata 不调用 retire、原样更新） |
| X6-AP-0009 | schemas_match_names_and_deserialize | 真缺：补 `serverId` 缺省断言（`types.rs:2133` skip_serializing_if） |
| X6-AP-0010 | parses_agent_fields_for_agent_turn | 等价：一个 `toEqual` 覆盖 3 个字段 |
| X6-AP-0011 | handles_expected_tool_names | 等价：循环覆盖 9 个名字 |
| X6-AP-0012 | test_is_session_tool | 等价：循环 + 两个否定 |
| X6-AP-0013 | parse_args_defaults_wait_true… | 等价：循环覆盖 6 个 is_none |
| X6-LP-0001…0017 | 见上文 log-parity 列表 | 待核：按分支/字段/时序对照；多数文件属执行器，注册受 B3 阻塞 |

### L04 X5 发送接口（2026-11-04 13:03 L04 通知）

L04 正在发布 `chat/api.ts` 的 `ChatSendExecution`（`chatSession.createSendExecution(pipeline, state)`）：
`runSendMessage(window, request, registration)` 对应 `send_message.rs:324-342`，`runHeadlessMessage(window, request, token)` 对应 `:301-322`，返回值只是 assistant 消息 ID。
当时 main 没有该导出，只在 L04 分支检查点 `76e1c96ee`。本 lane 的 `src/super-inbox-drain.ts:745` 仍是单参数草稿 `pipeline.runSendMessage(sendRequest)`，会丢掉调用方已持有的 window/registration/token。L04 发布已验证 hash 并进入 main 后，本 lane 改为消费三参数正式面，保留 `registration.token`，不让 L04 重新注册或重新取 generation；userMessage 响应/时间戳与 goal 轮末钩子仍由本 lane 的 inbox caller 负责。**此三参数面只用于 inbox；高层 headless 的无窗调用链见下方 G01-d 纠正，不使用 `runHeadlessMessage(window, …)`。**

### G01-d headless 调用链纠正（L04 后续精确化）

- 原证据：`headless.rs:1697-1771`，高层自己 `try_register_stream_owned`，持独立 token/generation，注册后安装 trusted profile guard；`StreamGuard::from_registered_token(state, session_id, &token)` 成功时才设置 `request.options.stream_generation`，构造 `ChatV2EventEmitter::new_headless(session_id).with_stream_generation(…)`，直接调用 L03 `execute_with_emitter(emitter, request, token, Some(state))`。**无 Window 参数、无二次注册、无重新查询 generation。**
- `send_message.rs:301-322` 的 `runHeadlessMessage(window, request, token)` 仅是旧的 Window 兼容入口，不用于 G01-d；本 lane 先前“基于它实现高层”的计划作废。
- 收尾仍由本 lane 负责（`headless.rs:1774-1975`）：`catch_unwind` 的结果分类、hard timeout / external cancel、仅取消内部 pipeline token、30s grace、先释放 StreamGuard 后 `finalize_overrun_pipeline`、按原 generation compare-and-remove。不把这些边界移交给 L04 兼容方法，也不把 JS 未结算 Promise 当作可 drop 的 Rust future。
- main 已发布 L04 `StreamGuard.fromRegisteredToken` 与 `ChatV2Emitter.newHeadless/withStreamGeneration`；L04 的发送低层候选 `23311b9db`、GoalRuntime/WithConn 候选 `b316d7426` 尚待正常合入。L03 `executeWithEmitter(emitter, request, signal, state)` 尚未出现在当前 main 的 `chat-pipeline/api.ts`，所以 B2 仍未闭合，**未签收真实 headless 成功链**。

### main 红灯（fulltest 16a254adf，14:02Z）诊断

`automation-commands.test.ts > starts immediately when the platform has no finalizer seam`：原因是合并时序。F3 的真实 `registerFinalizer` 已在 16a254adf 的 main 中，而本 lane 的修复 `9d4e6b0b8`（删掉无接缝回退分支，测试改为真实 `runStartupFinalizers` + 启动闸门后才 tick）当时还没进 main。`git merge-base --is-ancestor 9d4e6b0b8 16a254adf` 为否；当前 main 8d7b05d14 已包含该修复，测试文件 13/13 通过（作业 20261104141519-8990c3）。不是其他 lane 的接口错误，无需 escalate，也没有额外代码改动。

### L04 worker schema 公开面（架构师最高优先请求）

`api.ts` 公开 `headlessToolSchemas(): HeadlessToolSchema[]` 及类型，供 L04 的
workspace_run_agent / create_agent / restore_executions 注入 worker 工具；不依赖 Host、Window 或 runner。
对照 `headless.rs:664–1133` 与 `types.rs:2128–2142`：保留 33 个 schema 的原顺序、完整 description/inputSchema；
`serverId=None` 在输出中省略，不返回 null；每次调用返回独立的列表、条目和嵌套 schema（Rust 每次构造新 Vec）。
`tests/headless-schemas-api.test.ts` 从公开 api 调用，并从原 Rust literal 定义读取所有字段逐项严格对照；
另验证 L04 `McpToolSchema[]` 类型、Option 省略语义，以及调用方修改嵌套字段不污染后续 worker。
定向作业 `20261104150434-ecc00a`：新 API 测试 3 项 + 原 headless 测试 28 项，共 31/31 通过。

### C1 精确 TESTMAP handoff 核差（计算基线 8d7b05d14）

AP 13 条已在当前源码逐项核过（见上表与 `5882259ba`），本次不重做、不按 expect 数补断言。
仍不可达的是 X6-PR-0002/0003/0004：`goal_executor.rs::tests::{test_can_handle_with_and_without_prefix,test_schema_generation,test_parse_token_budget}`。
当前 main `879e0a56b` 的 `chat/api.ts` 仍无 `ToolExecutorRegistry` / `createExecutorRegistry` 与 goal owner CRUD，
Rust `tools/registry.rs:195` 的 GoalExecutor 注册路径尚未接入。三条精确去向如实改为 pending；
`tests/tool-schemas.test.ts` 的实现保留，没删混合用例、没新增假 export/无意义调用、没声称 Rust test-only。
因此当前 TESTMAP 236 ported / 3 pending；前文 239/0 是旧接手快照，不代表本轮生产接线验收。
owner 请求仍为 L04：发布执行器注册点与 `goalGetWithConn` / `goalInsertWithConn` / `goalUpdateStatusWithConn`，
本 lane 再按 Rust 注册 GoalExecutor 并通过生产执行入口验收，不以“函数已导出”恢复 ported。

### L04 continue_message：TodoList 读取与恢复公开面

对应 Rust `todo_executor.rs:265–349`，发布：

- `api.ts` 的 `loadPersistedTodoListWithConn(conn, sessionId)` 返回 `{list,messageId,variantId} | null`，
  SQL 与 Rust 相同，仅读 `session_id = ?1 AND is_all_done = 0`，不改查询、不另开连接、不提交调用方事务。
- `restoreTodoListFromDbWithConn(conn, sessionId)`，以及插件正式提供的 `ctx.agentTodo` 服务：
  `loadPersistedTodoList(sessionId)` / `restoreTodoListFromDb(sessionId)` / `getTodoList(sessionId)`。
  无参连接的服务方法每次解析 `storage.database('chat_v2')`，不额外包装数据库打开错误。
- 恢复使用 L06 单一会话 store（`src/todo-store.ts`），与公开 `getTodoList` 共用；返回和读取都与 Rust clone
  所有权一致。无行与读取失败不清空已有内存。L04 必须先原子注册流再恢复（`send_message.rs:2080–2107`）。
  todo_* 执行器注册仍受 B3 阻塞；没有声称该注册或 continue_message 完整链已完成。
- JSON 解码复用 F4 已发布 `JsonReader`，按 `TodoStep` serde 字段（required String/status/i64、Option、
  unknown 忽略、duplicate 拒绝、词法/顺序/字节行列）读取；支持状态外部标签与 positional struct；
  不用 `JSON.parse as`。SQL/列转换错误先于 JSON，分别保留 `Failed to load TodoList:` 与
  `Failed to deserialize steps:` 上下文；成功 service 记录 Rust 的 Loaded persisted TodoList info。
- `TodoTimestamp = number | bigint`：普通毫秒值保持 number，超过安全整数范围的历史 i64 保留 bigint；
  不舍入、不以当前写入器范围拒绝 Rust 合法历史值。此 API 返回内存对象，不直接 JSON.stringify 大整数。

定向 `tests/todo-persistence-api.test.ts` 经公开 api 与正式 `ctx.agentTodo`、真实迁移 SQLite 验证，
作业 `20261104152316-1d12ba` 19/19 通过（含原 todo 模型 4 项）；类型检查 `20261104152316-d2573b` 退出 0。

### L03 tool-round：TodoList 持久化供方（WP-169）

对应 Rust `todo_executor.rs:213–261`（调用方 `pipeline/tool_loop.rs:2204–2229`），发布：

- `ctx.agentTodo.persistTodoList(sessionId, messageId, variantId: string | null, list)`：每次解析
  `storage.database('chat_v2')`（= `db.get_conn()`，打开错误不加前缀）；`api.ts` 的
  `persistTodoListWithConn(conn, …)` 只在传入连接上执行，不另取连接、不开/提交事务。两者是同一个
  `repository/todo.ts` 实现，SQL 只在本 lane 仓储里，L03 不写 SQL。
- `INSERT OR REPLACE` 原九列；`steps_json` = `serde_json::to_string(&Vec<TodoStep>)`（紧凑、声明顺序、
  camelCase、`result`/`updatedAt` 为 None 时省略、i64 精确数字含 bigint）；`is_all_done` 用
  `todoIsAllDone`（空列表为 1）；created/updated 以 bigint 绑定为 SQLite integer。
- 错误：步骤编码失败 `Failed to serialize steps: …`，执行失败 `Failed to persist TodoList: …`；成功后
  记录 Rust 的 debug `[TodoListExecutor] Persisted TodoList … for session … (message: …)`。不改内存 store。
- 语义歧义：Rust 类型系统下序列化和 i64 绑定不会失败；TS 运行时若收到非法 `status` 或非 i64 时间戳，
  步骤内的归入 `Failed to serialize steps`，列表级的归入 `Failed to persist TodoList`（参数绑定阶段），不舍入不截断。

`tests/todo-persist-api.test.ts`（7 项）经正式 `ctx.agentTodo` 与公开 `persistTodoListWithConn`、真实迁移
chat_v2 库验证：列值/typeof、REPLACE 单行、nullable variant、2^63 边界、调用方回滚后无落盘且不调用
`storage.database`、原 load/restore 回读、FOREIGN KEY 与 no such table 真实 SQL 错误、debug 日志有无。

### ChatToolRuntime 的 L06 gate 面（L03 a27a04e7b 请求）

`api.ts` 发布 `trustedAutomationError`（Rust Result→原 message/null）、`trustedAutomationPreauthorized`
（共用原 `isTrustedAutomationPreauthorized`）、`executionPolicyAllows`（共用原 tool_policy 实现）及
`installTrustedAutomationSession`/guard，供 L04 聚合到 L03 的 gate；不另建 registry 或平行策略缓存。
核对 `headless.rs:82–109,173–305,351–408` 与 `automations.rs:505–515` 时修正：

- 安装 profile 时 clone，防止调用方修改 pinned profile；覆盖已安装 profile 时记 Rust 同字段 error。
- 显式网络目标递归保留原参数（含根数组），不先缩成对象丢掉检查。
- 写工具名单严格为 Rust 的 7 项，不把 `local_shell_preflight` 或任意 workspace_* 当作写工具。
- `root_id.or_else(rootId).and_then(as_str)` 保持先选值再验类型，失败后才尝试 receipt；
  不在 root_id 已有 null/非字符串时改取 rootId。
- 预授权拒绝原因/无回滚证据 warn、成功带 profile_hash 的 info 与 Rust 分支/字段一致；插件绑定 host logger。
- `tool_policy` 白名单条目使用 Rust trim，不能把 U+FEFF 当空白剥掉。

新 `tests/tool-runtime-policy-api.test.ts` 从公开 api 调用真实策略，验证不装 profile 不预授权、
合法/非法调用、域名与数组参数、profile clone、只读 preflight、root precedence、原日志及 builtin/MCP 源隔离。
定向作业 `20261104160239-e2a513` 33/33（包含 preflight/root precedence 断言）。
**未签完整 ChatToolRuntime**：`grantDenial` 的真实 registry/live provider 和 L05 shell 分析 owner 方法仍缺，
精确接口与请求见 BLOCKERS §8；不以无条件 null、假 grant store 或局部 shell 近似冒充闭合。

本轮合并 main 后，L13 `vfs/index.ts` 现在要求真实 `notes` / `vfsIndex`，旧组合测试安装失败
（`20261104160605-95f5f0`：399 项通过、4 项安装前跳过）。已在组合测试中增加真实 L10 notes、
L12 vfs-index 插件，不用替身、不改变原断言。定向复验 `20261104161319-29e590`：
todo persistence 15 + headless schema API 3 + 真实组合 4，共 22/22 通过。

### X6-UD-0002 续作：消费已发布的 F4 精确 reader

`readProposalMeta` 直接读取原 JSON 文本，不再先 `JSON.parse`，也不以 `Record as PersonaProposalMeta` 断言代替字段解码。
按 `custom_agent_executor.rs:64–81,439–443` 逐字段读取：unknown IgnoredAny、已知字段重复即失败（包括 Option 已为 null）、
JSON 键序的首个类型错误先于后续语法/缺字段错误、结束后按声明序报 missing、`previousSha256` None/default、
String 的数值/布尔/null 拒绝、serde 字节行列与原 `Invalid PROPOSAL.json:` 上下文。
`action` 在 Rust 是 String 而非 enum，TS 类型改为 string；合法历史 action 不因 TS 联合类型被缩域。
另外支持 derive 的 9 个位置字段序列；旧新增用例曾错误断言 `[]` 是 invalid type，现按 derive
`de.rs:451–505,805–835` 改为 invalid length 0，并增加完整序列成功用例，不改变 Rust 原测试方向。
重复键非法文件测试还验证了未写入目标 persona、保留原提案文件。

作业 `20261104164259-098bfc`：31 passed / **2 skipped**；`20261104164259-a2821e` 类型检查退出 0。
仍有两个精确原语缺口：未知字段 1e400 的 IgnoredAny 不能转 f64、定长数组额外项应使用 end_seq 的 peek_error 位置；
已给 F4 精确源码/输入/输出请求（BLOCKERS §6），回归完整保留为 pending，不把本小单元当作完整 serde 签收。

**WP-145（2026-11-06）**：上述两个缺口已由 F4 在 main 发布（`json-exact.ts` `skipIgnoredValue` :390 = de.rs:1102-1281，
`endArray` :368 = de.rs:1072-1086）。`decodeProposalMeta` 对应 Rust `PersonaProposalMeta` derive（`custom_agent_executor.rs:64-81`，
入口 `read_proposal_meta` :439-443）：未知字段改调 `skipIgnoredValue()`（不转 f64，`1e400` 被忽略）；位置式结构读满 9 字段后
改调 `endArray()`（多余元素在 extra token 开头报 `trailing characters`，原来是 `nextItem()` 吃掉元素后的 `error()` 位置）。
两条用例去掉 skip，原断言不变，补文件副作用断言（1e400 写出 persona；多余元素不写目标、保留 `persona.md`）。
作业 `20261105180249-1c9708`：33 passed / 0 skipped；`20261105180259-3f2e06` typecheck:host 退出 0。
这两条是 X6 自建用例，不是 Rust 原测试移植，TESTMAP 不变（236 ported / 3 pending）。

### WP-031：trusted_profile_json 改用 F4 JsonReader（X6-UD-0001）

- 解码：`src/trusted-profile.ts` `decodePersistedTrustedProfile` 用 F4 `JsonReader` 按 serde derive 流式读取
  `TrustedAutomationProfile` / `AutomationRuntimeRoot`（`automations.rs:291-318`）：map 按 JSON 键序处理，
  `deny_unknown_fields` 遇未知键立即报错，不读其值（`fieldError`：end_map 跳空白后的位置）；已知键重复报
  `duplicate field`；读完对象后按声明序报 `missing field`；也接受位置式 struct 序列（`invalid length N`，
  多余元素/尾逗号用 `endArray` 的 peek_error）；unit enum 走 `deserialize_enum`（`de.rs:1871-1901`）：
  字符串或 `{"v":null}`，其他首字节报 `expected value`；u16/u32/u64 宽度、f64 记号、`number out of range`、
  根值后 `trailing characters`、` at line L column C`（列为 UTF-8 字节数）。外层仍包
  `Conversion error from type Text at index: <字节长度>, …`，读取时不调用 `validate()`。
- u64：`timeoutSeconds` / `maxOutputBytes` 类型为 `TrustedU64 = number | bigint`，2^53 以上用 bigint 承载，
  不拒绝也不舍入。只在本结构必须经过的链路上保真：`serializeTrustedProfile`（serde 声明序、精确数字）
  同时用于 hash 输入与 `trusted_profile_json` 写库；Conflict 错误串
  （`automation-errors.ts`，对应 Rust `serde_json::to_string`）写出原数字；IPC 列表经 kernel `toWireJson`
  转 number（D3，与前端 `JSON.parse` Rust 输出的结果相同）；`effectiveLeaseTimeoutSeconds` 改为精确比较后再转 number
  （原 `Math.max(number, bigint)` 会抛 TypeError）。
- 浮点显示：WP-031 当时为 F4 的 `1e21` 补成 zmij 的 `1e+21`；WP-144 已修复共享读取器并合入 main，WP-173 撤掉本地补正，直接消费相同 serde/zmij 错误（BLOCKERS §6）。
- 已知差异（不在本包范围）：u64 >2^53 只能来自篡改过的库行。Rust 在 `lease_expires_at`
  （`automations.rs:2646-2651`，chrono Duration 溢出）会 panic，TS 不同；`friendlyAutomationError`
  （agent 执行器路径，B3 未接线）用 `JSON.parse` 重解析 Conflict 串，超过 2^53 时会丢精度。
- 被改动的既有用例：`1e21` 原断言 `1000000000000000000000.0`，`u64::MAX+1` 原断言 `1.8446744073709552e19`，与 Rust
  不符，改为 zmij 的 `1e+21` / `1.8446744073709552e+19`；原 “u64 above 2^53 (TS fail-closed)” 断言的是本 lane
  已知错误（Rust 接受），改为接受并精确保真；所有错误文本补上 serde 行列。这些都是 X6 自建用例，不是 Rust 原测试移植；TESTMAP 无变化。

### WP-173：直接消费 F4 typed 浮点错误显示

- 正常合并 main 后核实 `f1db06d99`（WP-144）已在历史中，`util/api.ts` 的 `JsonReader` 在
  `readUnsigned` 与 `readString → invalidType → jsonUnexpected` 两条生产路径共用 zmij 格式化。
  `decodePersistedTrustedProfile` 删除错误文本正指数 regex 和过时注释；保留原消息、UTF-8
  byte length、line/column 与 `Conversion error from type Text at index: …` 包装。
- 生产入口：`index.ts:203` 的 `chat_v2_automation_list` → `automationListResponse` →
  `loadAutomations` → `rowToAutomation` → `decodePersistedTrustedProfile`；更新入口仍先读取再判 OCC。
  复用 `tests/automation-crud-commands.test.ts:400-440` 的完整错误原断言（1e21、2.5e30、
  u64 溢出、负指数、定点、UTF-8 行列、错误顺序）及 `trusted-profile.test.ts`，未新增镜像用例。
- TESTMAP 去向不变：236 ported / 3 pending / 0 merged / 0 obsolete。Goal 三条仍为本 lane
  自有执行器待迁移项（WP-155 已核 registry/goal owner 接口在 main），不恢复旧资格。
- 本包是独立新语义消费；保全 WP-155/WP-169 历史。WP-169 原 RPC 红灯及 RUN016 raw1/Errors1
  仍按 BLOCKERS §6 保留，不以本包定向结果覆盖；最终 tip 的一次直接 lane-gate 结果另见 WP-173 报告。
