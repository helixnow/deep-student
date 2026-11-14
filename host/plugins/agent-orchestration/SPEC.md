# L06-agent-orchestration 行为规格（`host/plugins/agent-orchestration/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 17 个 · 发出事件 8 种 · 契约：`contracts/ipc/L06-agent-orchestration.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：命令结果统一输出 `null`（如 `next_trigger_at`/`last_run_at`）；持久化结构内部使用 `null`，序列化 schedule 时省略未设置字段（`serializeSchedule`，automations.rs 对应 serde `skip_serializing_if`）。
- [x] u64/i64 超过 2^53 的表示：TS 使用 number；`expectedVersion` 在仓储层按 i64 上界校验，超过 JS 安全整数时前端已在 JSON 解析阶段失精，未额外伪造 BigInt（契约本身为 integer）。
- [x] 字段顺序（serde_json preserve_order）：列表项按 Rust `json!` 的定义顺序构造对象；测试不依赖属性顺序做深比较。
- [x] f32 精度：本 lane 无 f32 字段。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：命令 reject 值为 JSON 字符串 `{code,message}`；OCC 冲突额外含 `errorType:'conflict'`、`automationId`、`expectedVersion`、`currentVersion`、`current`、`retryable`（automations.rs:120–201）。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：命令本身无 invoke 取消点；headless run 用 `ActiveAutomationRunGuard` 的 `AbortController`，`cancel_automation_run`/disable 触发 abort（automations.rs:3563–3698）。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：所有写路径使用 F3 `transaction(..., {behavior:'immediate'})`；进程内单飞用 `AgentAutomationRunGuard` Set；重试 claim 检查 live executor（automations.rs:5087–5100）。
- [x] 时间与 ID：生成方式、格式、时区：时间统一 `formatUtcRfc3339`（UTC `+00:00`，毫秒精度）；automation id 为 `auto_<epoch_ms>_<4位>`，run id 为 `run_<uuid>`；调度时区由 IANA/本地墙钟计算并按 DST gap 0..180 分钟回退。
- [x] 不对含 HashMap 的结构做序列化后比对：测试只比较结构化字段/数组，不比较 HashMap 序列化文本。

## 服务发布与接线（2026-11-04）

- [x] `agentAutomation`（`agent.automation@1` 更名，`api.ts` 导出 `agentAutomationService`）：17 个命令使用同一实现，`ctx.provide('agentAutomation', …)`。
- [x] `agentSubagent`（`agent.subagent@1` 更名，`api.ts` 导出 `agentSubagentService`）：状态/设置已提供；`deliverInbox` 仅在 `chat.send@1` 发布时可见，`runHeadlessTurn` / `runHeadlessAgentTurn` 仅在 `chatSession`/`chatPipeline` 暴露 headless 入口时可见；依赖缺失时这些成员为 `undefined`，不再发布固定抛错的占位实现（`api.ts` 的成员标注为可选，`index.ts` 用 getter 动态探测）。
- [x] `api.ts` 发布工具描述符面（供 L07 `agent-skills` 消费，稳定导出）：`BUILTIN_DESCRIPTORS`、`isPtcAllowed`，以及类型 `ToolDescriptor` / `ToolSensitivity` / `SideEffectClass` / `GrantsScopeHint`。来源 Rust `chat_v2/tool_descriptors.rs:46–725`；L07 用 `BUILTIN_DESCRIPTORS` 组装 legacy provider，用 `isPtcAllowed` 实现 `PtcDescriptorPolicy`，无需引用本 lane 实现文件。
- [x] `chatSession`（L04 已发布）：`host/plugins/chat/api.ts:123,128` 导出/声明 `chatSession`，`host/plugins/chat/index.ts:83` 以 `chatSessionService.name` provide；本 lane `index.ts` 的 `superSessionDeps()` 与 `resolveSuperInboxDeps()` 经 `ctx.get('chatSession')` 调用真实服务（测试用最小替身）。影响：`super_session_ensure/get_state/set_enabled`、`deliver_inbox` 的会话读写。
- [x] `agentWorkspace`（L05 已发布）：`host/plugins/agent-workspace/api.ts:192` 导出/声明 `agentWorkspace`，`host/plugins/agent-workspace/index.ts:91` provide；本 lane 经 `ctx.get('agentWorkspace')` 调用工作区/Agent/收件箱方法。`getTaskManager`/`getSleepManager`/`emitCoordinatorAwakened`/`HEADLESS_ALLOWED_TOOLS` 与 `SubagentTaskManager`/`SleepManager` 类型已随 `353a994fc` 合入 main；本分支合并 main `449676341` 后已复验：`src/super-inbox-drain.ts`、`src/super-state.ts`、`src/super-session-exec.ts` 调用的方法名与正式 `WorkspaceCoordinator` 面一致（`super-inbox` 缺 `getTaskManager` 时显式失败，`super-state`/`super-session-exec` 对旧 provider 保留可选探测），typecheck 与全 lane 测试通过。sleep 执行器本身仍等 L04 `ToolExecutorRegistry`，未用替身注册。
- [x] `chatState`（L04 已发布，新名）：`host/plugins/chat/api.ts:124,129` 与 `chat/index.ts:82`；本 lane 经 `ctx.get('chatState')` 调用 kill switch、`tryRegisterStreamOwned`、`removeStreamIfGeneration`、`spawnTracked`、`cancelStream`。服务缺失时按 Rust 语义 fail-closed 或跳过 Worker 取消。
- [ ] 待接线：`chat.send@1` —— 证据：该名字只出现在本 lane（`src/super-inbox-drain.ts:178`，最小消费接口 `SendMessagePipeline` 在 `:130–136`），`host/plugins/chat/api.ts:109–124` 未声明、全仓无 provider（`chat/index.ts:83–84` 只 provide `chatState`/`chatSession`）。当前行为：`ctx.inject(['chat.send@1'])` 未触发时**不注册** `chat_v2_super_deliver_inbox`，`agentSubagent.deliverInbox` 为 `undefined`（不发布固定抛错的能力）。影响：Super 收件箱发送管线。详见 [BLOCKERS.md](BLOCKERS.md) B1。
- [ ] 待接线：`chatSession.runHeadlessTurn` / `runHeadlessAgentTurn` —— 证据：`host/plugins/chat/api.ts` 无这两个符号，全仓检索只命中本 lane（`api.ts:154–155`）；Rust `headless.rs:1275/1381` 消费 L03 `ChatV2Pipeline`（`chat-pipeline/api.ts:202–478` 只有辅助方法，无执行入口）与 L04 会话仓储，L04 自身的 `chat_v2_send_message` 也尚未注册。当前行为：`agentSubagent` 的 headless 成员在 provider 缺失时为 `undefined`；自动化 `agent_turn` 在调度期探测 runner，缺失时 run 以 `error` 收尾并发送失败通知（spawn 阶段失败如单飞冲突仍走 `spawn_error`）。详见 [BLOCKERS.md](BLOCKERS.md) B2。
- [x] agent_turn 终态收尾：`src/automation-runtime.ts` 的 `executeAgentTurnAutomation` 按 Rust `automations.rs:3830–4130` 完成 headless 结果映射（`completed`→`success`/`heartbeat_ok`，其余保留 timeout/error）、named 会话回存（`updateAutomationAgentSessionId`）、终态落库（`completeRun`/`retryOrFinishRun`）、完成/失败 OS 通知与 `chat_v2_automation_run_completed`；心跳空转预检走纯 DB 查询并落 `heartbeat_ok`。`ActiveAutomationRunGuard` 的 `AbortSignal` 随请求传入 headless runner。
- [ ] 待接线：工具执行器事件 —— 证据：Rust 在 `session_executor.rs:2251`、`subagent_executor.rs:694`、`goal_executor.rs:154` 由执行器发事件；F1 只在 `host/kernel/agent-roster.ts:1–10` 保留执行器顺序，注释明确实例由 L04 registry/pipeline 注入。`ToolExecutorRegistry` 已在分支 `ds-mig/L04-chat-session`（`f47467e34`）的 `chat/api.ts` 导出并增加 `createExecutorRegistry`，但 **main 尚未合并**；main 的 `chat/api.ts` 只有 `ToolExecutor`/`ExecutionContext` 类型、无 provider。本 lane 已发布纯逻辑/schema，未注册占位执行器；事件需等 L04 注册表合入后按本 SPEC 发出。详见 [BLOCKERS.md](BLOCKERS.md) B3 与第 2 节（ask_user 回调表、sleep manager、goal 仓储等）。
- [x] `todo://changed`（VFS 待办）：经 L11 `vfsRepo`.todos 创建收件箱待办，回执写本 lane 的 `automation_todo_deliveries`（`repository/automation-todo.ts`），提交后广播 `{source:'automation',action:'create_item'}`；同一 run 重复投递不重复建项。
- [x] OS 通知：消费 F2 `systemNotification`（已合入 main 的 `electron/api.ts`，`e95356480` 引入；main 当前由 `dstu.shell` provide）的 `policy()`/`notificationsDisabled()`/`notify()`，策略与投递归 F2；窗口活跃判断按 Rust 顺序在 at-most-once 预约**之前**用公开 `plugin:window|is_focused|is_visible|is_minimized` 原语完成（F2 的 `notify()` 只在投递后返回 `window-active`，不能用于预约前决策），只有 `delivered:true` 才写 `notification` 回执；`suppressed` 清 pending 并撤销本 lane 的预约，`error` 释放预约并安排 5 分钟补投。provider 缺失时回退到 F2 shell 的 `plugin:notification|notify`，保留同一 Rust 策略/窗口/回执语义（`src/automation-notifications.ts`；`automations.rs:3086–3219,5296–5380`）。自动化 notify 的到点提醒不抑制；agent_turn 完成/失败通知在窗口活跃时抑制。
- [x] 启动恢复与后台调度：F3 发布 `storage.registerFinalizer` 时（branch `ds-mig/F3-storage`，`bf8f7b439`；**未合入 main**）把 legacy 迁移、孤儿 run 回收、心跳预置注册为启动收尾钩子（钩子只做初始化），**tick 循环等组合根在全部 finalizer 成功并 `startupGate.markStartupReady()` 后才启动**；注册被 F3 拒绝（同名重复、晚注册等）时只记 error 并保持 fail-closed，不提前初始化/启动。仅当平台完全没有该接缝时，才按 Rust 启动位置立即执行初始化并启动 tick。周期 tick 经 F4 `backgroundTasks.spawn` 接入生命周期，退出时等待在途 tick；服务缺失时退化为直接 Promise（`index.ts`）。
- [x] L21 共享操作许可：本 lane 没有备份/恢复/同步/删除传播等 `DataGovernanceOperationKind` 操作，Rust 自动化路径也不获取 `backup_common` 守卫，故不消费 `acquireOperation`。自定义人设文件锁是 Rust 进程级 `Mutex` 的等价物（同进程工具/Settings 入口共享），不是数据治理许可，不能改用 L21 全局锁。
- [ ] 待接线/阻塞：`SessionImportRepository`（L04 会话表所有权，D1 接缝）—— 解析/重映射与调用方事务已在本 lane 实现；调用方开启 `BEGIN IMMEDIATE`，把同一个 `SqlExecutor` 依次交给 L04 的 `createSessionWithConn` / `createMessageWithConn` / `createBlocksBatchWithConn`，不在本 lane 直接写 `chat_v2_sessions/messages/blocks`。但 L04 接口只在 branch `ds-mig/L04-chat-session`（`44a15ca22`）上，**未合入 main**；main 合并前没有真实提供方/生产调用方，测试中的 owner 适配器只是替身，不能据此关闭该接缝（`repository/session-tools.ts`、`src/session-tools.ts`）。

> 未勾选的 4 项是跨 lane 接口缺口，逐条证据、提供方与影响见 [BLOCKERS.md](BLOCKERS.md)；本 lane 未用替身
> 冒充完成。依赖缺失的注册能力按协调结论摘除（命令不注册、服务成员为 `undefined`），不保留固定抛错占位。

## 命令 `chat_v2_automation_cancel_run`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_cancel_run -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4657` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:632`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：runId: string
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_cancel_run -->

- [x] 输入：runId 原样传递，不 trim（automations.rs:4657–4664）。
- [x] 输出：`{success:true,runId}`（automations.rs:4668–4671）。
- [x] 错误：JSON `{code,message}`；非 queued/running/retrying 为 VALIDATION_ERROR / Run is not cancellable；SQL 失败 DATABASE_ERROR（automations.rs:4596–4639）。
- [x] 事件：成功后 `chat_v2://automations_changed {action:'cancel_run',automationId:''}`（automations.rs:4666–4667）。
- [x] DB 读写：automation_runs 状态置 cancelled、清 next_attempt_at/lease/retry_requested；prune 历史；once 定义收尾 disabled（automations.rs:4596–4638）。
- [x] 取消/并发：单 SQL 条件更新后 abort 活跃 headless token；无 invoke 取消点（automations.rs:4623–4630）。
- [x] 时间/ID：finished_at 与 updated_at 同一 UTC RFC3339 时间；run id 不变（automations.rs:4600–4607）。

## 命令 `chat_v2_automation_create`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_create -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4435` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:540`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：request: AutomationCreateCommandRequest
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_create -->

- [x] 输入：camelCase DTO；枚举接受字符串与 `{variant:null}` 两种形态；缺省 enabled=true、actionType=notify、catchUpPolicy=run_once、maxRetries=2、retryBackoff=60、timeout=600（automations.rs:4435–4465，`src/automation-request.ts`）。
- [x] 输出：`{success:true,automation:<列表项>}`（automations.rs:4466–4469）。
- [x] 错误：JSON `{code,message}`；字段/调度/上限/agent 专属字段校验为 VALIDATION_ERROR；SQL 失败 DATABASE_ERROR（automations.rs:1113–1218）。
- [x] 事件：成功后 `chat_v2://automations_changed {action:'create',automationId:id}`（automations.rs:4465）。
- [x] DB 读写：automation_definitions 单行 INSERT；事务内检查 20 条上限；trusted_profile seal 后落库（automations.rs:1113–1218）。
- [x] 取消/并发：IMMEDIATE 事务保证上限与插入原子；无取消点（automations.rs:1204–1216）。
- [x] 时间/ID：created_at/updated_at 为 UTC RFC3339；id `auto_<epoch_ms>_<4位>`；next_run_at 由调度器按 now 计算（automations.rs:1169–1183,1320）。

## 命令 `chat_v2_automation_delete`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_delete -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4816` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:553`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：automationId: string, expectedVersion: integer(u64)
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_delete -->

- [x] 输入：automationId 原样、expectedVersion ≥1；参数名走 Tauri camelCase（automations.rs:4816–4827）。
- [x] 输出：`{success:true,automationId,deleted:<列表项>,reversible:false}`（automations.rs:4829–4834）。
- [x] 错误：OCC 冲突 `{code:'AUTOMATION_VERSION_CONFLICT',...}`；内置心跳不可删除、存在活跃 run 时 VALIDATION_ERROR；SQL 失败 DATABASE_ERROR（automations.rs:1716–1773）。
- [x] 事件：成功后 `chat_v2://automations_changed {action:'delete',automationId}`（automations.rs:4828）。
- [x] DB 读写：automation_definitions 条件 DELETE；事务内先查版本/心跳/活跃 run（queued/running/retrying）（automations.rs:1733–1766）。
- [x] 取消/并发：IMMEDIATE 事务 + version CAS；无取消点（automations.rs:1732–1735）。
- [x] 时间/ID：仅使用传入 id；无新时间戳写库（automations.rs:1716–1773）。

## 命令 `chat_v2_automation_list`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_list -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4424` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:436`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：（无）
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_automation_list -->

- [x] 输入：无参数（automations.rs:4424–4432）。
- [x] 输出：`{count,max,automations:[列表项]}`；列表项含 schedule/action_type/session_mode/next_trigger_at 等 UI 全量字段（automations.rs:2370–2430,4429–4430）。
- [x] 错误：打开库/查询/解码失败均为 DATABASE_ERROR JSON 字符串（automations.rs:1270–1282）。
- [x] 事件：无（纯读）。
- [x] DB 读写：只读 automation_definitions，按 created_at ASC,id ASC；无心跳自动补齐（补齐由启动器单独调用）（automations.rs:1270–1282）。
- [x] 取消/并发：无锁写；读事务快照（automations.rs:1274–1281）。
- [x] 时间/ID：`next_trigger_at` 缺失时按当前 Local 计算；计算失败输出 `"unknown"`；once 已消耗输出 null（automations.rs:2370–2383）。

## 命令 `chat_v2_automation_retry_run`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_retry_run -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4641` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:627`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：runId: string
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_retry_run -->

- [x] 输入：runId 原样传递，不 trim（automations.rs:4642–4650）。
- [x] 输出：`{success:true,runId}`（automations.rs:4652）。
- [x] 错误：JSON 字符串 `{code,message}`；状态不允许时 VALIDATION_ERROR / Run is not retryable；SQL 失败 DATABASE_ERROR（automations.rs:4569–4593）。
- [x] 事件：更新成功后 `chat_v2://automations_changed {action:'retry',automationId:''}`（automations.rs:4651）。
- [x] DB 读写：automation_runs 单 UPDATE；四种终态允许重试；清空 error/finished_at/lease；agent_turn 清空 delivered_json；max_attempts 至少 attempt+1（automations.rs:4575–4586）。
- [x] 取消/并发：无 invoke 取消点；单 SQL 原子更新；这里只请求重试，不直接启动执行器（automations.rs:4569–4593）。
- [x] 时间/ID：next_attempt_at 与 updated_at 同一 UTC RFC3339 时间；沿用 run id（automations.rs:4573–4587）。

## 命令 `chat_v2_automation_run_now`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_run_now -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4959` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:567`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：automationId: string, expectedVersion: integer(u64)
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_run_now -->

> **已注册**：notify 路径完整迁移（claim run 后异步 `processDueAutomation`，OS 到点提醒经 F2 shell 投递，VFS 待办经 L11 服务真实交付）；agent_turn 路径在运行期探测 `chatSession`/`chatPipeline` 的 headless 入口，可用时执行并通过 `executeAgentTurnAutomation` 落终态、回存 named 会话、发完成事件；未发布时 run 以 `error` 收尾并发送失败通知，不静默成功。

- [x] 输入：`automationId` 原样使用；`expectedVersion` 为 u64（automations.rs:4959–4966；`runAutomationNow`）。
- [x] 输出：agent_turn → `{status:'started',automationId,timeoutSecs}`；notify → `{status:'started',automationId,runId}`（automations.rs:4888–4956）。
- [x] 错误：调度暂停 `Automation dispatch is paused (AgentKillSwitch / scheduler pause). Resume agents and automations first.`；kill switch 文案；`Automation '{id}' not found`；版本冲突结构化错误；单飞 `Automation '{id}' is already running (single-flight)`（automations.rs:4848–4905,3751–3763）。
- [x] 事件：启动成功后 `chat_v2://automations_changed {action:'run_now',automationId}`（automations.rs:4955）。notify 的终态只发 `automations_changed('run_completed')`；`chat_v2_automation_run_completed` 仅由 agent_turn/heartbeat 路径发出（automations.rs:4100,4203）。
- [x] DB 读写：读 automation 定义；agent_turn 先 `create_manual_run` 再拉起 headless；notify 先 claim run，后台 `process_due_automation` 写 delivery 回执与终态（automations.rs:4888–4956）。
- [x] 取消/并发：`AgentAutomationRunGuard` 单飞；run 行 claim 互斥；notify 后台任务失败由 lease 过期回收（automations.rs:3751–3763,4912–4936）。
- [x] 时间/ID：agent_turn 返回 `timeout_seconds`；run 时间戳由 claim/终态函数按 UTC RFC3339 写入（automations.rs:4888–4897）。

## 命令 `chat_v2_automation_runs`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_runs -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4553` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:618`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：automationId?: string | null, limit?: integer(usize) | null
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_automation_runs -->

- [x] 输入：automationId 可选（null/缺省查全部）；limit 缺省 50，仓储钳制到 1..200（automations.rs:2020–2060,4553–4565）。
- [x] 输出：`{runs:[run],count}`；run 含 trigger_type/attempt/max_attempts/status/duration_ms 等（automations.rs:607–641,2020–2060）。
- [x] 错误：DATABASE_ERROR JSON 字符串（automations.rs:2025–2060）。
- [x] 事件：无。
- [x] DB 读写：只读 automation_runs，按 created_at DESC LIMIT；duration_ms 由 started_at/finished_at 派生不落库（automations.rs:2020–2060,648–657）。
- [x] 取消/并发：无写锁；只读查询（automations.rs:2025–2045）。
- [x] 时间/ID：duration_ms = max(0, finished-started)；缺失/不可解析为 null；沿用 run id（automations.rs:648–657）。

## 命令 `chat_v2_automation_set_background_enabled`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_set_background_enabled -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4794` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:661`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：enabled: boolean
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_set_background_enabled -->

- [x] 输入：enabled boolean（automations.rs:4795–4799）。
- [x] 输出：`{success:true,enabled}`（automations.rs:4811）。
- [x] 错误：DATABASE_ERROR JSON 字符串，message 前缀 Failed to persist background flag（automations.rs:4807–4809）。
- [x] 事件：保存后 `chat_v2://automations_changed {action:'background',automationId:''}`，发送失败只记日志（automations.rs:4810,1851–1862）。
- [x] DB 读写：主库 settings 的 chat_v2.automation_background_enabled 写 true/false 文本（automations.rs:4803–4806）。
- [x] 取消/并发：同步保存后发事件，无取消点（automations.rs:4802–4812）。
- [x] 时间/ID：updated_at 由 F4 SettingsStore.save 负责，无新 ID（automations.rs:4803）。

## 命令 `chat_v2_automation_set_enabled`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_set_enabled -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4474` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:476`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：automationId: string, expectedVersion: integer(u64), enabled: boolean
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_set_enabled -->

- [x] 输入：automationId/expectedVersion/enabled；已处于目标状态时幂等返回原版本（automations.rs:1377–1420）。
- [x] 输出：`{success:true,previous,current}`（automations.rs:4489–4493）。
- [x] 错误：OCC 冲突结构化载荷；not found/version 非法为 VALIDATION_ERROR；SQL 失败 DATABASE_ERROR（automations.rs:1346–1375）。
- [x] 事件：成功后 `chat_v2://automations_changed {action:'set_enabled',automationId}`（automations.rs:4488）。
- [x] DB 读写：更新 enabled/next_run_at/version；关闭时取消 queued/retrying、收集 running run id 并 abort token；不删除历史（automations.rs:1377–1420）。
- [x] 取消/并发：IMMEDIATE 事务 + version CAS；事务提交后 abort 活跃 token（automations.rs:1364–1375,3620–3668）。
- [x] 时间/ID：next_run_at 由当前 now 重算；once 已消耗则 null；updated_at 为 UTC RFC3339；version+1（automations.rs:1386–1419）。

## 命令 `chat_v2_automation_summary`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_summary -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4673` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:637`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：（无）
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_automation_summary -->

- [x] 输入：无（automations.rs:4674–4678）。
- [x] 输出：enabledCount/runningCount/failedCount/nextRunAt/backgroundEnabled/onceCompletedCount/lastFailedRunAt；无日期为 null（automations.rs:4768–4776）。
- [x] 错误：DATABASE_ERROR JSON 字符串；打开库与查询各保留对应前缀（automations.rs:4686–4690）。
- [x] 事件：无（automations.rs:4685–4777）。
- [x] DB 读写：六个只读聚合；失败限定 24 小时；retry_requested 允许 disabled 定义的显式重试参与 nextRunAt；once 完成要求 disabled、无 next_run_at、有 last_run_at（automations.rs:4691–4754）。
- [x] 取消/并发：完成 SQL 查询后再读 settings，避免递归数据库锁；读设置失败默认 backgroundEnabled=true（automations.rs:4765–4784）。
- [x] 时间/ID：两次独立读取当前 UTC 减 24h；无新 ID（automations.rs:4710,4751）。

## 命令 `chat_v2_automation_update`

<!-- BEGIN GENERATED:cmd:chat_v2_automation_update -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4498` · async
- 前端：app（1 处，例 `src/features/settings/components/automationSettingsApi.ts:509`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：request: AutomationUpdateCommandRequest
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_automation_update -->

- [x] 输入：automationId trim 后非空；缺省字段不改；`agentPrompt/sessionMode/modelId/trustedProfile` 显式 null 表示清除；至少一个可编辑字段（automations.rs:4506–4531,1450–1505）。
- [x] 输出：`{success:true,previous,current,next_trigger}`；已完成的 once 追加 `once_completed/once_completed_notice`（automations.rs:4534–4548）。
- [x] 错误：OCC 冲突结构化载荷；字段/调度校验 VALIDATION_ERROR；SQL 失败 DATABASE_ERROR（automations.rs:1422–1700）。
- [x] 事件：成功后 `chat_v2://automations_changed {action:'update',automationId}`（automations.rs:4533）。
- [x] DB 读写：单行 UPDATE 全字段 + version CAS；切换 notify 时清空 agent 专属字段；schedule 变化时重算 next_run_at（automations.rs:1440–1675）。
- [x] 取消/并发：IMMEDIATE 事务 + version CAS；不做活跃 run 取消（automations.rs:1490–1500）。
- [x] 时间/ID：updated_at 为 UTC RFC3339；version+1；无新 id（automations.rs:1663–1675）。

## 命令 `chat_v2_super_deliver_inbox`

<!-- BEGIN GENERATED:cmd:chat_v2_super_deliver_inbox -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:58` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/sendOperations.ts:329`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：request: DeliverInboxRequest
  - 结果：DeliverOutcome · 错误：string · 注入：window, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_super_deliver_inbox -->

> **条件注册**：命令在 `ctx.inject(['chat.send@1'])` 触发时注册（与其他依赖同时可用时执行）；`chat.send@1` 未发布时命令不存在，前端调用得到 kernel 的 unknown command，而不是固定抛错的空壳。生产路径仍要求 `chatSession`、`agentWorkspace`、`chatState`、`storage`、`settings` 全部可用；`resolveSuperInboxDeps` 对缺失服务抛出带服务名的明确错误，不会返回假的 `started`。

- [x] 输入：`sessionId` 必须以 `sess_` 开头，否则 `Invalid session ID format: {session_id}`；`userMessageId`/`assistantMessageId` trim 后不得为空，否则 `userMessageId and assistantMessageId are required`（inbox.rs:829–839）。
- [x] 输出：`disabled` / `busy` / `paused{autoTurns}` / `empty` / `started{userMessage{id,content,timestampMs,inboundOrigin},assistantMessageId}`（inbox.rs:845–999）。
- [x] 错误：会话读取、`ensure_session_writable`、kill switch（`KILL_SWITCH_BLOCKED_MESSAGE`）、prepare 失败、管线同步启动失败原样上抛；预启动失败会回滚 drain 并释放流注册（inbox.rs:853–978）。
- [x] 事件：管线启动后发 `super_session_inbox_changed {sessionId,pendingInbox}`（inbox.rs:993）；预检告警经 `report_warning` 只记 warn，不另发事件。
- [x] DB 读写：读 chat_v2 session；ensure workspace 可能 `update_session_v2` 绑定 `workspace_id`；drain/回滚收件箱、提交 interrupt marks；用户消息与助手消息由发送管线持久化（inbox.rs:887–980）。
- [x] 取消/并发：`try_register_stream_owned` 原子注册，占用时返回 `busy`（kill switch 已触发则报 blocked）；kill switch 在 drain 前后各检查一次；管线在 `spawn_tracked` 中运行（inbox.rs:865–978）。
- [x] 时间/ID：`timestampMs = Utc::now()` 在启动管线时取；message id 使用调用方传入值并 trim（inbox.rs:974–999）。

## 命令 `super_session_ensure`

<!-- BEGIN GENERATED:cmd:super_session_ensure -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:32` · async
- 前端：app（1 处，例 `src/features/chat/superSession/api.ts:77`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：（无）
  - 结果：SuperSessionState · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:super_session_ensure -->

> **已注册（`index.ts:500`）**：未启用时直接返回 disabled 状态；启用时要求 `chatSession` 与 `agentWorkspace` 已发布，缺失时抛出 `ChatV2Database 未初始化` / `WorkspaceCoordinator 未初始化`（`superSessionDeps`），不会伪造会话或工作区。

- [x] 输入：无参数；未启用时不做 ensure，返回 `disabled_state()`（commands.rs:32–35）。
- [x] 输出：`{enabled:true,pendingInbox,sessionId,workspaceId}`（state.rs:712–733）。
- [x] 错误：chat_v2 DB / coordinator 缺失原样报 `ChatV2Database 未初始化` / `WorkspaceCoordinator 未初始化`；`ensure_core` 的会话/工作区错误向上抛（state.rs:712–716）。
- [x] 事件：ensure 成功后发 `super_session_changed {enabled:true,sessionId}`（commands.rs:37–38）。
- [x] DB 读写：列出活跃 Super，多个只留最新并退役其余（退役失败仅 warn）；去 hidden；无活跃会话时新建；工作区不存在/非 Active 时创建并注册 Coordinator，回写 session metadata（state.rs:376–470,448–470）。
- [x] 取消/并发：进程级 `ENSURE_LOCK` 串行化 ensure；TS 对应同步函数（同一事件循环内不可分割）（state.rs:376–385）。
- [x] 时间/ID：新会话/工作区 ID 由仓储生成；本函数不额外生成时间（state.rs:448–470）。

## 命令 `super_session_get_settings`

<!-- BEGIN GENERATED:cmd:super_session_get_settings -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:42` · async
- 前端：app（2 处，例 `src/features/chat/superSession/api.ts:81`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：（无）
  - 结果：SuperSessionSettings · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:super_session_get_settings -->

- [x] 输入：无参数（commands.rs:43）。
- [x] 输出：`{instructions:string}`；缺设置或读取失败返回空字符串（state.rs:244–251）。
- [x] 错误：主数据库依赖由 settings 注入；读取失败被吞并返回默认值（state.rs:246–250）。
- [x] 事件：无（commands.rs:43–46）。
- [x] DB 读写：主库 settings 的 `super_agent.instructions`，经 F4 SettingsStore.get（state.rs:247）。
- [x] 取消/并发：同步读，无取消点（state.rs:244）。
- [x] 时间/ID：无生成（state.rs:244–252）。

## 命令 `super_session_get_state`

<!-- BEGIN GENERATED:cmd:super_session_get_state -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:17` · async
- 前端：app（2 处，例 `src/features/chat/superSession/api.ts:69`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：（无）
  - 结果：SuperSessionState · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:super_session_get_state -->

> **已注册（`index.ts:503`）**：未启用只读 settings 返回 disabled；启用时调用 `ensure`，跨 lane 服务缺失会被 `get_state` 捕获并记录 `ensure failed in get_state`，随后尽量用 `current_super` 的会话/工作区填充返回（Rust 同款降级）。

- [x] 输入：无参数（commands.rs:17–20）。
- [x] 输出：未启用 → `disabled_state()`；启用 → `ensure()` 的完整状态（state.rs:736–757）。
- [x] 错误：命令本身不返回错误；`ensure` 失败只 `warn!`，返回 `enabled:true` 且尽量填充当前 Super 的 `sessionId`/`workspaceId`（state.rs:741–754）。
- [x] 事件：无（`get_state` 不调用 `emit_changed`；commands.rs:17–20）。
- [x] DB 读写：读 settings；启用时 ensure 可能写会话 hidden/工作区绑定；失败回退时只读 `current_super`（state.rs:736–754）。
- [x] 取消/并发：同步调用 ensure（内部 ENSURE_LOCK）；无 invoke 取消点（state.rs:736–757）。
- [x] 时间/ID：不生成时间/ID（state.rs:736–757）。

## 命令 `super_session_set_enabled`

<!-- BEGIN GENERATED:cmd:super_session_set_enabled -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:23` · async
- 前端：app（2 处，例 `src/features/chat/superSession/api.ts:73`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：enabled: boolean
  - 结果：SuperSessionState · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:super_session_set_enabled -->

> **已注册（`index.ts:506`）**：开启依赖 `ensure`（`chatSession`/`agentWorkspace`）；关闭依赖 `chatState` 取消活跃 Worker 与 `agentWorkspace` 隐藏会话。服务缺失时按 Rust 文案显式失败，不跳过关闭副作用。

- [x] 输入：`enabled:boolean`（commands.rs:23–26）。
- [x] 输出：开启 → ensure 的完整状态；关闭 → `disabled_state()`（state.rs:760–794）。
- [x] 错误：主库未初始化 `主数据库未初始化`；写 settings 失败 `保存 super_agent.enabled 失败: {e}`；ensure 错误向上抛（commands.rs:23–29；state.rs:238–242,760–772）。
- [x] 事件：开启 ensure 后、关闭清理后各发一次 `super_session_changed {enabled,sessionId}`；关闭时 `sessionId:null`（state.rs:771–793）。
- [x] DB 读写：先写 settings `super_agent.enabled`；关闭时读 `current_super`、取消活跃 Worker、`set_hidden(true)`（失败仅 warn）（state.rs:760–793）。
- [x] 取消/并发：关闭时取消该工作区的活跃 Worker 并记 info 数量；无 invoke 取消点（state.rs:775–790）。
- [x] 时间/ID：不生成时间/ID；settings 时间戳由 SettingsStore 负责（state.rs:760–794）。

## 命令 `super_session_set_settings`

<!-- BEGIN GENERATED:cmd:super_session_set_settings -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:48` · async
- 前端：app（2 处，例 `src/features/chat/superSession/api.ts:86`）
- 契约：`contracts/ipc/L06-agent-orchestration.json`
  - 参数：settings: SuperSessionSettings__De
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:super_session_set_settings -->

- [x] 输入：settings.instructions 默认空字符串，Unicode White_Space trim 后取前 4000 个 Unicode 标量（state.rs:70–74,254–256）。
- [x] 输出：null（Rust unit；commands.rs:52–54）。
- [x] 错误：写失败字符串 `保存 super_agent.instructions 失败: {e}`（state.rs:259）。
- [x] 事件：无（commands.rs:49–55）。
- [x] DB 读写：主库 settings 的 `super_agent.instructions`，经 F4 SettingsStore.save（state.rs:257–259）。
- [x] 取消/并发：同步写，无取消点（state.rs:254）。
- [x] 时间/ID：settings.updated_at 由 F4 SettingsStore.save 负责（state.rs:258）。

## 事件 `chat_v2_automation_run_completed`

<!-- BEGIN GENERATED:event:chat_v2_automation_run_completed -->
- 事件名 `chat_v2_automation_run_completed`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4100`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:4203`（emit）
<!-- END GENERATED:event:chat_v2_automation_run_completed -->

- [x] 载荷：`{automationId, automationName, sessionId, runId, attempt, status, summary, heartbeat, osNotificationDelivered}`；心跳空转路径 `sessionId:null`、`status:'heartbeat_ok'`、`summary:'HEARTBEAT_OK'`（automations.rs:4099–4116,4202–4217）。
- [x] 触发时机与顺序：agent_turn 终态落库、完成通知投递后先发本事件，再发 `automations_changed('run_completed')`（automations.rs:4100–4123）；spawn_error 终态不经过本事件（automations.rs:3421–3423）。
- [x] 节流/合并：无节流、不合并；每个终态一次；emit 失败只 `warn!`（automations.rs:4117–4121）。
- [x] 是否在事务提交后：是，`complete_run`/`retry_or_finish_run` 与 `finalize_once_automation` 之后（automations.rs:3987–4100）。
- [x] 目标窗口（emit / emit_to / emit_filter）：应用级广播 `app_handle.emit` → `ctx.backendEvents.emit('chat_v2_automation_run_completed', payload)`；agent_turn 成功/失败/心跳空转终态在 headless runner 可用时发出（`src/automation-runtime.ts` `emitRunCompleted`），runner 未发布时 run 以 `error` 收尾（spawn 阶段失败为 `spawn_error`），按 Rust 语义不发本事件。

## 事件 `chat_v2://automations_changed`

<!-- BEGIN GENERATED:event:chat_v2://automations_changed -->
- 事件名 `chat_v2://automations_changed`，常量 `AUTOMATIONS_CHANGED_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:1852`（emit）
<!-- END GENERATED:event:chat_v2://automations_changed -->

- [x] 载荷：`{action:string, automationId:string}`；action 取值 create/update/delete/set_enabled/background/retry/cancel_run/run_now/run_completed（automations.rs:1851–1857,3549,4123,4224,4950）。
- [x] 触发时机与顺序：对应命令完成数据库写入后立即 emit；同一命令只发一次（automations.rs:4465,4488,4533,4828,4666–4667）。
- [x] 节流/合并：无节流、不合并；失败只记日志不影响命令结果（automations.rs:1851–1862）。
- [x] 是否在事务提交后：是，仓储事务返回后才 emit（automations.rs:1840–1857；`index.ts` 在仓储调用之后 `emitChanged`）。
- [x] 目标窗口（emit / emit_to / emit_filter）：应用级广播（`ctx.backendEvents.emit`，对应 Rust `app_handle.emit`）。

## 事件 `session_management_change`

<!-- BEGIN GENERATED:event:session_management_change -->
- 事件名 `session_management_change`，常量 `SESSION_MGMT_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/session_executor.rs:2251`（emit）
<!-- END GENERATED:event:session_management_change -->

- [x] 载荷：`{tool:string, sessionId:string}`（session_executor.rs:2251–2253）。
- [x] 触发时机与顺序：工具执行成功后、构造 tool result 之前；只对写操作发一次，只读名单（session_list/search/get/get_messages/export/group_list/tag_list_all/session_stats）跳过（session_executor.rs:2240–2254）。
- [x] 节流/合并：无节流；每次写操作一次；emit 结果被 `let _ =` 丢弃（Rust 无日志）。
- [x] 是否在事务提交后：是，工具自身 DB 写入完成并拿到 output 之后（session_executor.rs:2235–2255）。
- [x] 目标窗口（emit / emit_to / emit_filter）：发起工具调用的窗口（`ctx.window_ref().emit`）。TS 本 lane 发布 session 工具的纯逻辑；执行器由 L04 `ToolExecutorRegistry` 组装，事件接线见「待接线」。

## 事件 `super_session_changed`

<!-- BEGIN GENERATED:event:super_session_changed -->
- 事件名 `super_session_changed`，常量 `EVENT_SUPER_SESSION_CHANGED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/state.rs:683`（emit）
<!-- END GENERATED:event:super_session_changed -->

- [x] 载荷：`{enabled:boolean, sessionId:string|null}`（state.rs:673–681）。
- [x] 触发时机与顺序：`super_session_ensure` 成功后、`set_enabled` 开启/关闭完成后、`on_session_removed` 处理后各发一次；关闭/移除且未启用时 `sessionId:null`（commands.rs:37–38；state.rs:771–793,842–849）。
- [x] 节流/合并：无节流、不合并；emit 失败只 `warn!`（state.rs:682–691）。
- [x] 是否在事务提交后：是，ensure/设置写入/隐藏完成之后（state.rs:682–691）。
- [x] 目标窗口（emit / emit_to / emit_filter）：应用级广播 `app_handle.emit`；TS 经 `ctx.backendEvents.emit('super_session_changed', …)`（index.ts:460）。

## 事件 `super_session_inbox_changed`

<!-- BEGIN GENERATED:event:super_session_inbox_changed -->
- 事件名 `super_session_inbox_changed`，常量 `EVENT_SUPER_SESSION_INBOX_CHANGED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/super_session/state.rs:705`（emit）
<!-- END GENERATED:event:super_session_inbox_changed -->

- [x] 载荷：`{sessionId:string, pendingInbox:number}`，pendingInbox 为工作区该会话的收件箱计数（state.rs:694–707）。
- [x] 触发时机与顺序：`deliver_inbox` 成功注册流、drain、启动管线之后发一次（inbox.rs:993）；`set_enabled` 等路径不额外发（计数变化由投递路径负责）。
- [x] 节流/合并：无节流；每次投递一次；emit 失败只 `warn!`（state.rs:706–707）。
- [x] 是否在事务提交后：是，drain/回滚与流注册完成后（inbox.rs:978–993）。
- [x] 目标窗口（emit / emit_to / emit_filter）：应用级广播 `app_handle.emit`；TS 经 `ctx.backendEvents.emit('super_session_inbox_changed', …)`（index.ts:412,464）。

## 事件 `todo://changed`

<!-- BEGIN GENERATED:event:todo://changed -->
- 事件名 `todo://changed`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:2606`（emit）
<!-- END GENERATED:event:todo://changed -->

- [x] 载荷：`{source:'automation', action:'create_item'}`（automations.rs:2604–2606）。
- [x] 触发时机与顺序：自动化 notify 创建 VFS 待办并写投递回执成功后发一次；创建/回执/提交任一步失败返回 false，不发事件（automations.rs:2580–2607）。
- [x] 节流/合并：无节流；每次创建待办一次；`let _ = emit` 忽略错误（Rust 无日志）。
- [x] 是否在事务提交后：是，`tx.commit()` 成功之后（automations.rs:2595–2606）。
- [x] 目标窗口（emit / emit_to / emit_filter）：应用级广播 `app_handle.emit`；TS 经 `ctx.backendEvents.emit('todo://changed', …)`（`repository/automation-todo.ts` 提交后回调，`index.ts` 注入）。

## 事件 `workspace_worker_ready`

<!-- BEGIN GENERATED:event:workspace_worker_ready -->
- 事件名 `workspace_worker_ready`，常量 `WORKSPACE_WORKER_READY_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:694`（emit）
<!-- END GENERATED:event:workspace_worker_ready -->

- [x] 载荷：`{workspace_id, agent_session_id, skill_id, runtime_managed:true}`（subagent_executor.rs:682–688）。
- [x] 触发时机与顺序：后端 `dispatch_agent_run` 成功之后、返回 `agent_session_id` 之前；仅作兼容观察信号，执行不依赖前端监听（subagent_executor.rs:689–700）。
- [x] 节流/合并：无节流；每次 subagent 启动一次；emit 失败只 `warn!`（subagent_executor.rs:695–701）。
- [x] 是否在事务提交后：是，任务消息持久化与后端 dispatch 完成后（subagent_executor.rs:675–694）。
- [x] 目标窗口（emit / emit_to / emit_filter）：发起工具调用的窗口（`ctx.window_ref().emit`）。TS 本 lane 发布 subagent 参数/描述纯逻辑；执行器由 L04 `ToolExecutorRegistry` 组装，事件接线见「待接线」。

## 事件 `channel`

<!-- BEGIN GENERATED:event:expr:channel -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:154`（emit）
<!-- END GENERATED:event:expr:channel -->

- [x] 载荷：`goal_updated` 事件体（`build_goal_updated_payload`，含 sessionId 与 goal/null）（goal_executor.rs:147–153）。
- [x] 触发时机与顺序：goal 工具每次更新目标后发一次；无窗口（headless/测试）直接跳过，轮末由 goal 运行时补发权威状态（goal_executor.rs:144–155）。
- [x] 节流/合并：无节流；emit 失败只 `warn!`（goal_executor.rs:154–155）。
- [x] 是否在事务提交后：是，goal DB 写入完成之后（goal_executor.rs:145–153）。
- [x] 目标窗口（emit / emit_to / emit_filter）：会话级通道 `chat_v2_session_{session_id}`，经窗口 emit。TS 本 lane 发布 goal 工具的 schema/纯逻辑；执行器与事件由 L04（`host/plugins/chat/src/events.ts` 的 `GOAL_UPDATED`）组装，接线见「待接线」。

## 验收问题处理（R2 ACCEPTANCE，2026-11-04 续作核对）

> 本节对应复核人 `ACCEPTANCE.md` 的「必须修复」项。只核对 R2 最新未决的 O1 通知子项、O6、O7
> 三项自有代码；已由 R2 关闭的 O2–O5/O8 与已获 C1 认可的 `d540b9166` 启动拒绝行为不再改动。
> 下列「当前状态」以本分支合并 main `449676341` 后的源码为准（修复提交 `4cbc09634`、
> `bc965752a`、`6772ac1f0`、`db42e4ea4`），测试证据来自
> 全局作业队列：typecheck `20261104083606-488622` 退出 0；全 lane 测试 `20261104083606-1345c3`
> 33 文件 / 335 用例全部通过、退出 0。

### O6：取消 once 时额外发 `once_completed` —— 已修

- 修复提交：`4cbc09634`（取消入口与仓储改为日志-only hooks）。
- 生产入口：`index.ts:123-126` 的 `onceFinalizeLogHooks()` 只含 `info`/`warn`；IPC `index.ts:228` 与
  `agentAutomation.cancelRun`（`index.ts:505`）都只传该对象；`repository/automation-runs.ts:256-262`
  的 `cancelAutomationRun` 在调用 `finalizeOnceAutomation` 前显式重建 `{info, warn}`，因此运行时
  不会转发意外的 `emitChanged`。普通调度路径仍可传完整 hooks（同文件 `:270-291`）。
- Rust 对照：`automations.rs:4635` 的取消路径 `finalize_once_automation(db, None, ...)` 不持
  `AppHandle`，`:4666-4667` 只发 `cancel_run`；本 lane 的 `info`/`warn` 与 changed=1 日志保留。
- 测试证据：`tests/automation-commands.test.ts:212` `cancel endpoints finalize once automations without emitting once_completed`，
  经真实 IPC 与公开 service 各取消一条 once，断言定义均 disabled 且事件总线只有两条
  `{action:'cancel_run', automationId:''}`。全 lane 作业输出含该用例通过（日志第 62 行）。

### O1：通知「窗口抑制先于预约」与 retryAt 时间格式 —— 已修

- 修复提交：`bc965752a`、`6772ac1f0`（预约前窗口预检）、`4cbc09634`（retryAt 平台 RFC3339）。
- 生产入口：`src/automation-notifications.ts:255` 先读 F2 `notificationsDisabled()`，`:264` 在写
  at-most-once 预约前用公开 `plugin:window|is_focused|is_visible|is_minimized` 预检窗口，`:270`
  才 `setRunDeliveryMarker(..., 'notification', true)`，`:280` 才调用 F2 `notify()`；传给 F2 的
  `suppressIfWindowActive` 固定为 `false`，避免 F2 二次窗口查询把 Rust 的「查询失败按不活跃继续」
  改写成投递失败。`:222-231` 的 `releaseAndScheduleRetry` 用 `formatTimestampMillis`（chrono
  `to_rfc3339`，UTC `+00:00`）写 `next_attempt_at`，不再用 `toISOString` 的 `Z`。
- Rust 对照：`automations.rs:3131-3147` 窗口判断在 `:3153` 预约之前；失败分支 `:3186-3207`
  先释放预约，再用 `(Utc::now() + 5min).to_rfc3339()` 写补投时间。
- 测试证据：`tests/automation-notifications.test.ts` 的
  `prechecks window activity before reserving with the F2 service`（窗口活跃时 F2 `notify` 零调用、
  只发三个窗口查询、无 marker/retry）、`does not attempt the delivery reservation while the window is active`
  （用 Proxy 让 `transaction` 抛错，证明抑制路径不进入预约写入）、
  `a failed OS delivery releases the reservation and schedules a retry` 与
  `releases the F2 reservation and schedules a retry when delivery reports an error`（两条失败路径都断言
  `next_attempt_at.endsWith('+00:00')` 且时间约为 now+5min）。全 lane 作业输出含上述用例通过
  （日志第 80-81 行等）。
- 仍未闭合（不属于本次三项自有代码）：真实 L03/L04 headless runner 与 `chat.send@1` 未在 main 发布，
  O1 整项保持未关闭；见 [BLOCKERS.md](BLOCKERS.md) B1/B2。

### O7：legacy 迁移把 settings 读取/marker 保存挪进事务 —— 已修（整项仍待真实 L04 provider）

- 修复提交：`db42e4ea4`（恢复 Rust 原事务边界，删除 F4 `WithConn` 探测分支）。
- 生产入口：`repository/automation-legacy.ts:137-151` 的 `migrateLegacyAutomations`：
  `settings.get(marker)` → `settings.get(AUTOMATIONS_KEY)` 并解析 → `db.transaction(..., {behavior:'immediate'})`
  插入定义并提交 → `settings.save(marker, 'true')`。marker 保存失败会向上抛，但已提交的定义保留；
  不会因 `WithConn` 可用而扩大事务。
- Rust 对照：`automations.rs:1223-1234` 先读/解析 settings，`:1236-1241` 开 IMMEDIATE 事务，
  `:1263-1266` 提交后 `drop(conn)` 再 `save_setting` marker。
- 测试证据：`tests/automation-repository.test.ts` 的
  `legacy_json_migration_commits_definitions_before_saving_the_marker`（marker 保存抛错后定义仍有 1 条、
  marker 未写）、`legacy_json_migration_reads before the transaction and saves the marker after commit`
  （顺序断言 read(marker) → read(automations) → transaction → insert → save(marker)）、
  `legacy_json_migration_reads_the_marker_before_parsing`（marker=true 时坏 JSON 不解析）。
  全 lane 作业输出含这些用例通过（日志第 56 行等）。
- 仍未闭合（不属于本次事务边界修复）：L04 `SessionImportRepository`（`createSessionWithConn` /
  `createMessageWithConn` / `createBlocksBatchWithConn`）只存在于 `ds-mig/L04-chat-session`，main 无
  provider/生产调用方；本 lane 的 owner 适配器仅用于测试，不据此签收 O7 整项。见
  [BLOCKERS.md](BLOCKERS.md) 第 3 节。

### 保持现状的项

- `d540b9166` 的注册拒绝 fail-closed（只记 error、不初始化/不启动 tick）已由 C1 认可，本轮不复改。
- 真实 F3 `registerFinalizer` + `startupGate` 组合根、`runStartupFinalizers` 失败传播规则仍未在
  main 落地；本 lane 继续按 BLOCKERS 第 5 节等待架构师/F3 规则，不用模拟 fixture 签收整体装配。
