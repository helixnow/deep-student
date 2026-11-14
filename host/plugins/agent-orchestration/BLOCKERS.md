# L06-agent-orchestration 跨 lane 接口缺口与阻塞清单

> 核实时间 2026-11-04。本 lane 的 17 个 IPC 命令已全部在 `meta.commands` 声明（其中
> `chat_v2_super_deliver_inbox` 条件注册），TESTMAP 当前 236 ported、3 pending（X6-PR-0002/0003/0004）；本文件记录
> **无法由本 lane 单独完成**的接线点，以及已合入 main、已在本分支复验的消费面；每一条都给出
> 提供方、公开接口、Rust/TS 两侧证据与影响。没有用替身、mock 或静默降级冒充完成。

## 1. SPEC「服务发布与接线」现状（未勾选项与已合入消费面）

| # | 提供方 | 缺失的公开接口/能力 | 证据 | 影响 |
|---|---|---|---|---|
| B1 | ~~L04 chat-session~~ **已解除（W02 V01-02，2026-11-07）**：chat-pipeline 发布 | `chat.send@1`：`run_send_message_pipeline_owned`（Rust `chat_v2/handlers/send_message.rs`）的 Host 服务 | `chat-pipeline/index.ts` 无条件 `ctx.provide('chat.send@1', …)` 并在 `meta.provides` 声明；实现 `chat-pipeline/src/super-inbox-send.ts` 复用 `chatSession.createSendExecution({execute}, chatState).runSendMessage(window, request, registration)`（owned StreamGuard，`skipUserMessageSave` 为 null，用户消息由管线落库），收尾钩子用 `chatSession.createGoalRuntime`，目标窗口即投递窗口（Rust 把 `window` 传给 continuation）。消费接口改为三参数：`SendMessagePipeline.runSendMessage(window, request, registration): Promise<string>`（`src/super-inbox-drain.ts`），`deliverInbox` 把自己原子注册的 registration 和命令的 `call.source` 交给管线 | 官方 desktop profile 下命令注册、`agentSubagent.deliverInbox(request, window)` 为函数；`tests/super-inbox-delivery-profile.test.ts` 走真实 chat-pipeline + 本地 SSE 桩跑完整投递（用户消息含 `inboundOrigin`、assistant 消息落库、流释放）。chatState / backgroundTasks 在调用期解析，缺失时同步抛带服务名错误（投递回滚已 drain 的消息） |
| B2 | L03 chat-pipeline + L04 chat-session；高层归 L06 | 缺 L03 `executeWithEmitter(emitter, request, signal, state)` 的正常 main 发布，以及 L04 会话/消息 owner 方法。`runHeadlessTurn` / `runHeadlessAgentTurn` 与 `HeadlessTurnResult` / `HeadlessTurnOutcome` 由 L06 自己编排，不要求 L04 复制高层 runner，不走 Window 兼容入口 | Rust `headless.rs:1697–1771,1832–1975`：原子注册 token/generation → StreamGuard + headless emitter → 直接调用 L03。main 已公开 L04 StreamGuard/ChatV2Emitter；当前 main `879e0a56b` 的 `chat-pipeline/api.ts` 无 `executeWithEmitter`，L03 分支已有 `ChatPipelineExecution.executeWithEmitter` 候选。L04 候选见 §7 | 当前两个高层成员仍为 `undefined`；L06 的高层执行和收尾仍待实现、真实验证，不是只等一个高层 provider。自动化缺 runner 时以 `error` 收尾并发送失败通知；现有终态测试不签真实 headless 成功链 |
| B3 | L04 chat-session（+ F1 roster） | ~~`ToolExecutorRegistry` 运行时注册表~~ **已在 main，不再是阻塞（WP-155 订正，2026-11-06）** | main `136320e68`：`chat/api.ts:199–201` 发布 `createExecutorRegistry` / `assembleExecutorRegistry`；`chat/index.ts:124` 以 `agentTools.toolExecutors()` 作为 L04 registry 的贡献来源；L07 `agent-skills/api.ts:323–334` 发布 `registerToolExecutors`。F1 `host/kernel/agent-roster.ts:78–84` 把 `CustomAgentExecutor` 放在 workspace 组 | **WP-155 已接线 `CustomAgentExecutor`**：`index.ts` 在 `ctx.inject(['agentTools','agentWorkspace'])` 作用域内 `registerToolExecutors([new CustomAgentExecutor(agentWorkspace, logger.warn)])`，对应 roster.rs:98（仅有 coordinator 时加入）。生产调用链见下方。其余 L06 执行器（Attempt/Automation/Todo/Goal/Session/SelfInspect/RolePack/Subagent/SuperSession/CoordinatorSleep/AskUser/ToolPack）是**本 lane 自有未迁移项**，不是 registry 阻塞；各自仍缺的外域接口见 §2 |

**CustomAgentExecutor 生产调用链（WP-155）**：官方 profile 安装 `dstu.agent-orchestration` →
`index.ts` `ctx.inject(['agentTools','agentWorkspace'])` → `agentTools.registerToolExecutors`（L07）→
L04 `chat/index.ts:124` `toolExecutors()` → `assembleExecutorRegistry`/`createExecutorRegistry`（`executor-roster.ts` 按 F1 名单取 `CustomAgentExecutor`）→
`ToolExecutorRegistry.execute`（超时/取消/结果预算）→ `CustomAgentExecutor.execute`（`src/custom-agent-executor.ts`，Rust :1007–1071）→
`CustomAgentStore`（目录每次取自 `agentWorkspace.customAgentsDir()/customAgentsPendingDir()`，Rust :111–117）。
验证：`tests/custom-agent-executor.test.ts` 经 `loadStartupProfile(OFFICIAL_PROFILE_PATH)` 取 `agentTools` 中唯一的生产实例，
走 `chatSession.createExecutorRegistry` + L05 真实审批策略执行五个工具；X6-UD-0002 的 1e400 / 多余位置字段两条断言在该路径上复验。
完整 App `assembleExecutorRegistry(…, workspace=true)` 仍因其他 lane/本 lane 未迁移执行器报 `MissingExecutorError`，这是花名册完整性，不是本执行器的阻塞。
| B5 | F2 shell | `systemNotification` 正式服务面（`policy()` / `notificationsDisabled()` / `notify()`） | **已合入 main**：`e95356480` 的 `electron/index.ts` 由 `dstu.shell` provide `systemNotification`，`electron/api.ts` 公开请求/结果类型，`electron/system-notification.ts` 实现策略与投递结果。窗口查询方法未公开，F2 只在 `notify()` 返回 `window-active` | 本 lane 已按公开面写消费接口 `SystemNotificationPort`；策略与投递归 F2，窗口活跃判断在预约前用公开 `plugin:window|*` 原语完成（Rust 先判窗口后预约），只有 `delivered:true` 写 `notification` 回执，`suppressed` 清 pending，`error` 释放预约并补投。provider 缺失时回退 F2 shell 的 `plugin:notification|notify` 与同一窗口原语 |

## 2. 执行器实例化还缺的领域接口

即使 B3 的 registry 落地，下列执行器还各缺一个 **main 上**由对方 lane 发布的接口；标注「分支候选」的
接口已在对方分支存在但未合入，本 lane 不在 main 上声称已消费。本 lane 已发布可复用的纯逻辑，
但不会用替身把它们标成已接线。

| 执行器（Rust） | 提供方 | 缺失接口 | 证据 |
|---|---|---|---|
| `AskUserExecutor`（`tools/ask_user_executor.rs`） | L04 chat-session | 待答回调表 | **已在 main（WP-155 订正）**：`chat/api.ts:51` 导出 `registerAskUserCallback` / `handleAskUserResponse`。不再是外域阻塞，执行器为本 lane 未迁移项 |
| `CoordinatorSleepExecutor`（`tools/sleep_executor.rs`） | L05 agent-workspace | `getSleepManager` / `emitCoordinatorAwakened` 等 | 已在 main（`353a994fc`）；执行器为本 lane 未迁移项 |
| `CoordinatorSleepExecutor`（sleep 块预存） | L04 chat-session | 块写入与 `block_ids_json` 追加 | **已在 main（WP-155 订正）**：`chat/api.ts:60` `createBlockWithConn`、`:266` `appendBlockIdToMessageWithConn` |
| `GoalExecutor`（`tools/goal_executor.rs`） | L04 chat-session | goal 仓储 | **已在 main（WP-155 订正）**：`chat/api.ts:62` 导出 `goalGetWithConn` / `goalInsertWithConn` / `goalUpdateStatusWithConn`。TESTMAP X6-PR-0002/0003/0004 不再缺外域接口，待本 lane 迁移执行器 |
| `SubagentExecutor` / `SuperSessionExecutor` | L05 agent-workspace | `getTaskManager()` 等 | 已在 main（`353a994fc`）；执行器为本 lane 未迁移项 |
| `CustomAgentExecutor` | — | 无 | **WP-155 已注册**，见 B3 |

## 3. chat_v2 仓储读写（L04 表所有权）

本 lane 的 `session_executor.rs`（session_list/get/get_messages/search/export/import/group/tag）在 Rust 中直接调用
`ChatV2Repo`。Host 侧 L04 只发布了普通 CRUD（`chat/api.ts:109–124`），缺少以下仓储原语：

- `list_sessions_with_conn` / `count_sessions_with_conn`（status、group 过滤与分页）
- `get_session_with_conn` 原始记录（含 `persist_status`/`group_id`/`tags_hash` 等）
- `load_session_messages_page_with_conn`（role 过滤 + 该页块的窗口查询）
- `get_session_tags` / `get_tags_for_sessions`
- `search_content_with_date_range`
- group/tag 的 CRUD

只读原语当前由本 lane `repository/session-tools.ts` 按 `repo.rs` 的 SQL 逐条移植，并用真实迁移后的
chat_v2 库测试（`tests/session-tools-db.test.ts`），不是假数据；但按 `quality.md` §2.1「每张表只有一个
写入方」，这些读取应回到 L04。请 L04 发布上述原语后，本 lane 删除本地只读仓储并改调 `chatSession`。
同类只读访问见 `repository/super-inbox.ts`、`repository/super-session.ts`。

`session_import` 的**写入**已不再由本 lane 直接执行：解析/ID 重映射仍在本 lane，
调用方按 D1 开启 `BEGIN IMMEDIATE` 事务，把同一个 `SqlExecutor` 交给 L04 的
`SessionImportRepository`（`createSessionWithConn` / `createMessageWithConn` /
`createBlocksBatchWithConn`，`repository/session-tools.ts`、`src/session-tools.ts`）。
L04 的公开 `*WithConn` 目前只在 branch `ds-mig/L04-chat-session`（`44a15ca22`），
**未合入 main**；main 合并前 `session_import` 没有生产调用方（B3 的注册表也未落地），
本 lane 不声称该写入的生产消费已完成。`tests/session-tools-db.test.ts` 的 owner 适配器
与回滚断言只验证本 lane 的事务编排，不构成 L04 真实 provider 或同事务消费的验收证据。

## 3.1 启动/后台/许可接缝（D2）与分支候选

| 能力 | 提供方 / 分支提交 | main 状态 | 本 lane 行为 |
|---|---|---|---|
| `storage.registerFinalizer` / `runStartupFinalizers` | F3 `ds-mig/F3-storage` `bf8f7b439` | 未合入；main 的 `StorageService` 无此方法 | 运行时探测 `registerFinalizer`：存在则把 legacy 迁移/孤儿 run 回收/心跳预置注册为只做初始化的收尾钩子；tick 等 F2 `startupGate` 在全部 finalizer 成功后被标记 ready 才启动。“接口不存在”与“平台拒绝注册”分开处理：前者按 main 兼容分支立即初始化/启动；后者中的 `FINALIZER_DUPLICATE` / `FINALIZER_LATE_REGISTRATION`（重装）改为在 gate ready 后执行同一钩子（V09-P1-3），其余拒绝只记 error 并保持 fail-closed |
| `backgroundTasks.spawn` | F4 `host/platform/diagnostics`（main 已发布） | 可用 | tick 经 `spawn` 接入退出等待；服务缺失时退化为直接 Promise |
| `backup.acquireOperation` / `governance.acquireOperationGuard` | L21 `ds-mig/L21-backup-governance` `31ad462b2` | 未合入 | **不适用**：本 lane 没有备份/恢复/同步/删除传播操作，Rust `automations.rs`/`super_session` 不获取 `backup_common` 守卫。自定义人设文件锁是进程级 `Mutex` 等价物，不是数据治理许可 |
| L05 `getTaskManager` / `getSleepManager` / `emitCoordinatorAwakened` / `HEADLESS_ALLOWED_TOOLS` | L05 `ds-mig/L05-agent-workspace` `353a994fc`（文档 `55f709989`） | 已合入 main；本分支已合并 main `449676341` | 方法名/类型已与正式 `WorkspaceCoordinator` 面复验一致；本 lane 以可选最小接口访问（`src/super-session-exec.ts`），缺能力时显式失败 |
| F4 `SettingsWithConn`（`getWithConn` / `saveWithConn`） | F4 `ds-mig/F4-security` `7e063cfdd` | 已合入 main | **不使用**：Rust `automations.rs:1221–1268` 的 settings 读/解析与 marker 保存不在 automation 插入事务内。legacy 迁移保持 owner `get` 读 → 插入事务提交 → owner `save` marker（marker 失败不回滚已提交定义）；把 `*WithConn` 塞进同一事务会改变 Rust 边界 |
| L04 `createSessionWithConn` 等 | L04 `ds-mig/L04-chat-session` `44a15ca22` | 未合入 | 见第 3 节；main 合并前无生产调用方 |

## 4. 当前失败行为（不是静默降级）

- `chat_v2_super_deliver_inbox` / `agentSubagent.deliverInbox`：`chat.send@1`（chat-pipeline）未装载时命令不注册、成员为
  `undefined`；若在依赖中途消失（provider 卸载），调用路径仍抛 `resolveSuperInboxDeps` 的带服务名错误。
  回合结束的 goal 钩子抛错时只发 `super_inbox_goal_hook_failed` 告警，不留下未处理的 rejection。
- `agentSubagent.runHeadlessTurn` / `runHeadlessAgentTurn`：缺 B2 时成员为 `undefined`；自动化
  `agent_turn` 在 run 期探测 runner，缺失时 run 以 `error` 收尾并发送失败通知（spawn 阶段失败如单飞冲突落 `spawn_error`）。
- 自动化 agent_turn 的其它失败：headless 返回 `timeout`/`error` 时按 Rust 映射落终态（`retryOrFinishRun`），
  失败通知与 `chat_v2_automation_run_completed` 均按 Rust 语义发出；不会写成功终态。
- 自动化 notify 的 OS 渠道：优先走已合入 main 的 F2 `systemNotification`；provider 缺失时回退
  F2 shell 的 `plugin:notification|notify`。窗口活跃判断在预约前经公开 `plugin:window|*` 原语完成
  （Rust 先判窗口后写 at-most-once 预约）。`system-notification-policy=never`、窗口活跃抑制、
  投递失败均清 `notification_pending` 并按 Rust 语义补投或收尾；只有 `delivered:true` 写送达回执。
- 启动恢复：F3 `registerFinalizer` 可用时经平台启动钩子执行（钩子只做初始化），**tick 等 F2
  `startupGate` 在全部 finalizer 成功并被组合根标记 ready 后才启动**；注册失败只记 error 并保持
  fail-closed，不提前初始化/启动。main 未合并该接缝时立即完成初始化并启动 tick。周期 tick 经 F4
  `backgroundTasks` 跟踪在途任务。
- 工具执行器：只注册已迁移完成的执行器（当前 `CustomAgentExecutor`），未迁移的不注册占位 executor；对应事件不伪造。
- F3 注册被拒绝：`FINALIZER_DUPLICATE`（上一实例卸载后名字仍在 registry）与 `FINALIZER_LATE_REGISTRATION`
  （F3 已开跑后的重装）不再永久停摆（V09-P1-3，W02 `6f7c442e`）：钩子改为等 `startupGate` ready 后执行，
  gate 之前仍不初始化、不 tick；其它拒绝（非法参数等）只记 error、保持 fail-closed。注册带 `late: 'run'` 与
  AbortSignal，W10/W14 的新 registry 接口合入后可直接使用其 unregister。`tests/automation-commands.test.ts`
  覆盖重复名、晚注册与 install → runStartupFinalizers → unload → install。

## 5. 需协调者裁定

- `chat_v2_super_deliver_inbox` 在 B1 落地前的注册策略：R2 协调结论为「依赖缺失的能力不注册，contract
  保持不变」。实现按此执行——命令经 `ctx.inject(['chat.send@1'])` 条件注册，`agentSubagent` 的
  `deliverInbox`/`runHeadlessTurn`/`runHeadlessAgentTurn` 为条件成员（provider 缺失时 `undefined`）。
  命令清单 `meta.commands` 仍声明 17 个，契约不动。
- 本 lane 没有申请 obsolete 的测试；TESTMAP 三条 goal 用例 pending（X6-PR-0002/0003/0004，B3 与 GoalExecutor owner 接口未在 main 发布）。
- **F3 启动失败规则（已缩小，2026-11-04）**：run 失败部分已由协调者裁定（失败不 ready、不 mark gate、
  HostFatal 退出 1、不自动重试），本 lane 不再就此请求。仍待裁定的只有：`registerFinalizer` 被拒绝
  （重复/晚注册/非法参数）时是否中止整个启动。裁定前本 lane 保持 fail-closed（只记 error，不初始化、
  不启动 tick），不自行定义成功降级语义；真实 F3 registry + gate 合入 main 后再做组合验证。

## 6. 共享 serde 精确 JSON 读取器（X6-UD-L06-01 / X6-UD-0002）

F4 已在 main 的 `host/platform/util/api.ts` 发布 `JsonReader`（键序/重复字段/数字原文/字节行列）。
本 lane 已用于 todo 持久化、X6-UD-0002 的 PROPOSAL.json，以及（WP-031）X6-UD-0001 的
`trusted_profile_json`（`src/trusted-profile.ts` `decodePersistedTrustedProfile`）。
u64 >2^53 按 D3 以 bigint 承载，序列化/hash 保留原数字（见 LANE.md「WP-031」）。

**已过时（2026-11-06 订正）**：原文称 F4 缺 `skipValue` 的 IgnoredAny 语义与公开 `endArray()`。
main 的 `json-exact.ts` 已公开 `skipIgnoredValue()`（:390，de.rs:1102-1281）、`endArray()`（:368，
de.rs:1072-1086）与 `readEnumVariant()`（:322），F4 侧这两个缺口已不存在。
`tests/custom-agent.test.ts` 原 229/233 两条 skip（X6-UD-0002，PROPOSAL.json）已由 WP-145 启用：
`src/custom-agent.ts` `decodeProposalMeta` 的未知字段改调 `skipIgnoredValue()`，位置式结构读满 9 字段后改调
`endArray()`，两条用例经 `executeApply` 真实文件路径通过，本 lane 不再有该项等待。

**已解除（WP-173 消费 WP-144）**：WP-031 发现的 F4 浮点显示缺口已由 `f1db06d99` 随
main `6e2936bac` 合入。`host/platform/util/api.ts` 公开的 `JsonReader` 经 `json-exact.ts:82-96`
同一 `ryuFormat`（沿用导出名，实际为 zmij）生成 `1e+21`、`1.8446744073709552e+19`；依据
serde_json 1.0.149 `error.rs:471-475`、zmij 1.0.21 `lib.rs:1064-1135`。本 lane 撤掉
`decodePersistedTrustedProfile` 的正指数 regex 补正，直接保留 reader 错误消息与位置，外层仍按
`automations.rs:989-1003` 包装 UTF-8 字节长度及 `FromSqlConversionFailure` 文案。
此消费不解除 WP-169 原 job `20261105195225-c8a942` 的 raw exit 1 / 482 passed / Errors 1；
RUN016 唯一复验 `20261105200637-9f3d37` 仍 raw exit 1 / 709 passed / 2 skipped / Errors 1，
`[vitest-worker]: Timeout calling "onTaskUpdate"` 根因未定，不授负载豁免，原候选仍不签全绿。

## 7. B1/B2 接口更新（L04 X5，2026-11-04）

L04 将发布 `ChatSendExecution`（`createSendExecution(pipeline, state)`，`runSendMessage(window, request, registration)` / `runHeadlessMessage(window, request, token)`，只返回 assistant ID）。等它进入 main：
B1 `chat_v2_super_deliver_inbox` 改为消费三参数 `runSendMessage`，并保留调用方的 registration（**已完成**，见 §1 B1）；
B2 的高层 **不走** `runHeadlessMessage(window, …)`：该方法只对应 `send_message.rs:301-322` 的 Window 兼容路径。
按 `headless.rs:1697-1771`，本 lane 自持原子注册的 token/generation、L04 已公开的 `StreamGuard` 与
`ChatV2Emitter.newHeadless/withStreamGeneration`，直接消费 L03 `executeWithEmitter(emitter, request, signal, state)`。
hard timeout / catch_unwind / grace / finalize_overrun 仍归本 lane，且不能为无窗执行引入 Window、重注册或重取 generation。
当前 main 的 `chat-pipeline/api.ts` 尚无该执行接口；L04 已验证低层候选 `23311b9db`、GoalRuntime/WithConn 候选
`b316d7426` 也尚待正常 main。正式 `chat.send@1`/IPC provider 仍依赖 L03 execute；不把候选接口视作生产完整 headless。

## 8. ChatToolRuntime 聚合（L03 a27a04e7b）

L06 已发布 `trustedAutomationError(sessionId, toolName, args): string | null`、
`trustedAutomationPreauthorized(sessionId, toolName, args): boolean`、
`executionPolicyAllows(toolName, args, allowedTools): boolean`，以及共用 trusted session guard。
由 L04 聚合到 `ChatToolRuntime.gate`，L06 不另建 registry，不在缺能力时提供空 gate。

仍未闭合的 owner 面：

- `grantDenial`：Rust `hooks.rs:340–349` 要求 `lookup_grant_for_session` 后对真实已签发 grant
  执行 `ensure_live`（revoked 优先于 expired），并用 `denial.message(grant_id, tool_name)` 输出错误。
  main 未见 registry/lookup/live API，L05 仅有私有 ToolScope/effectiveTools 子集；
  `revocation_epochs` 归 L04（C2 owner 裁定），不得在本 lane 复制 SQL 或建与 worker 签发脱节的 Map。
  请求明确 registry/epoch 运行时 owner，并公开 `lookupGrantForSession(sessionId)` 与等价 live/原错误面。
  已上报架构师；未提供假的 `grantDenial() => null`。
- trusted shell 校验：本 lane 旧 `headless.ts` 的局部 shell 分析只是近似，不足签收 Rust 的
  `approval_scope::analyze_shell_command`（`headless.rs:252–258`）。请求 L05 公开
  `analyzeShellCommand(command) -> { hasShellOperators, usesScriptRunner, writeCapable, networkCapable }`；
  当前 main 的 `agent-workspace/api.ts` 无此导出，已向 L05 请求。发布后删除近似实现并消费 owner 方法；
  在此之前不签完整 trusted shell 分支，不把只读/非 shell 用例通过扩大为完整 gate 已接通。
