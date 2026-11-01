# Super-agent 会话（实验）

日期：2026-11-01（同日重做）
状态：随本版本发布，默认关闭
来源：DeepSeek Harness 团队《Super-agent 设计探索》（用户提供的文章，未存入仓库）。
首版实现：会话 deep-student-c9（快照分支 `feat/super-agent-wip`，3eb84221），移植到 `wt/split-main` 后**整体重做**，见文末「与旧实现的关系」。

## 是什么

一个固定在会话列表顶部的「Super-agent」会话。它**就是一个普通 chat_v2 会话**：附件、引用、流式、思考、工具、审批、停止、编辑重发、重新生成、变体、继续、模型选择、排队、导出、分支、Goal、一键断电全部原生可用，体验与普通会话没有区别。

区别只在于它多了四个工具和一段 Router 提示词：用户可以随时提出多件事，Super-agent 会把耗时的事交给后台任务（Worker）并行处理；Worker 完成、失败或被中断时，结果进入它的收件箱，会话空闲时以一条「事件消息」投递进会话，开启一个普通的流式回合向用户汇报。

用户可见的约定（用户已确认）：

- 「设置 → 自动化 → Super-agent」是唯一开关；打开后桌面侧栏与移动端会话列表的置顶区最上面固定出现 Super-agent 会话。关闭后该会话隐藏，记录保留，重新打开即可恢复。
- 侧栏的 Super 行与普通会话行同一外观，同样显示「生成中」「等待继续」「未读」状态；带一个 `Super` 小徽标。
- 不可取消置顶、不可归档、不可移动分组；可以重命名、在新窗口打开、导出、**删除**。删除后后台任务停止，并自动新建一个空的 Super-agent 会话（删除确认里写明这一点）。

## 架构与数据流

### 会话标识

- 会话 metadata：`{"super_agent":{"active":true,"version":1,"workspace_id":"ws_…","hidden":false},"pinned":true}`，标题 `Super-agent`，`title_locked = true`。
- 退役（回收站恢复的旧 Super、分支出来的副本、被替换的）：`{"super_agent":{"active":false,"retired_at":"…"}}`，并去掉 `pinned`，此后按普通会话对待。
- 唯一性：`chat_v2_sessions` 中 `$.super_agent.active = 1` 且 persist_status 为 active 的最多一个；`ensure()` 发现多个时只留最新，其余退役。不另存指针。
- 开关与额外指令存主库 settings：`super_agent.enabled`、`super_agent.instructions`。

### 数据流

1. **用户消息**：普通 `chat_v2_send_message`。管线两个入口（`ChatV2Pipeline::execute` / `execute_with_emitter`）调用幂等的 `super_session::apply_turn_overrides`：仅当会话是活跃、启用且未隐藏的 Super 时生效——清空 `request.workspace_id`、写入内部字段 `SendOptions.super_session`（`#[serde(skip)]`，前端无法伪造）、有窗口时按名去重追加 4 个 Super 工具。系统提示词稳定段加 `<super_agent_router>`（Router 规则 + 用户额外指令），易变段加 Worker 名册。send / retry / edit / continue / 变体都经过同一钩子，行为一致。
2. **派发**：`builtin-super_dispatch_worker{title, task, context?, profile?, model?}` → `SuperSessionExecutor` 委托现有 `SubagentExecutor`：固定 `wait=false`、使用 Super 工作区、profile 默认 `explorer`（只读检索）。返回结构与 `subagent_call` 一致，前端渲染为同一张 Worker 卡片。`super_message_worker` 走 resume；`super_close_worker` 先取消再置 Closed；`super_list_workers` 汇总 agents + tasks。
3. **完成 / 失败 / 取消**：沿用 workspace 子代理的完成闭包，结果写入 Super 工作区收件箱并发 `workspace_agent_completion`。前端 `sendWake` 遇到父会话是 Super 时不走普通唤醒，交给 Super 投递控制器。
4. **外部事件**：后端 API `super_session::post_external_event(app, IncomingTrigger)` 过滤（来源策略、白名单、提及、空正文、去重与限速）后写入收件箱并发 `super_session_inbox_changed`。本版本未接任何事件源。
5. **投递**：前端常驻控制器（仅 main 窗口）在会话空闲（idle、无流、队列空、无阻塞交互、未暂停）时调用 store 的 `deliverSuperInbox()` → `chat_v2_super_deliver_inbox`。后端原子注册流 → 自动回合计数 → drain 收件箱（≤10 条，含未上报的中断）→ 格式化成一条**持久化的 user 消息**（`inboundOrigin` meta，正文经中和，Worker 输出包在 `<worker_output>`、外部正文包在 `<untrusted_event>`）→ 走普通发送管线开一个流式回合。管线启动前失败会把已 drain 的消息放回收件箱。
6. **排队**：Super 回合中到达的事件留在持久收件箱，回合结束后再投递；用户自己排队的消息优先。
7. **停止**：停止只停当前回合，Worker 继续；用户主动停止后暂停自动投递，直到下一条用户消息或用户点「继续处理 N 条待处理事件」。

### 前后端契约

| 类别 | 名称 |
|---|---|
| 命令 | `super_session_get_state` → `{enabled, sessionId, workspaceId, pendingInbox}`；`super_session_set_enabled(enabled)`；`super_session_ensure`；`super_session_get_settings` → `{instructions}`；`super_session_set_settings(settings)`；`chat_v2_super_deliver_inbox(request)` → `DeliverOutcome` |
| 事件 | `super_session_changed {enabled, sessionId}`；`super_session_inbox_changed {sessionId, pendingInbox}` |
| 前端 API | `src/features/chat/superSession/api.ts`（`getSuperSessionState` / `setSuperSessionEnabled` / `ensureSuperSession` / `getSuperSessionSettings` / `setSuperSessionSettings`） |
| 外壳镜像 | `src/stores/superAgentEnabledStore.ts`：`{enabled, sessionId}`，localStorage 缓存防闪烁、订阅 `super_session_changed`、开关成功后派发 `chat-v2:sessions-updated`。位于 platform 层，按分层规则直接 invoke 同名命令 |

### 前端落点

- `src/features/chat/superSession/`：判定（`isSuperSession`）、常驻控制器与投递、事件卡片、暂停提示条、侧栏入口数据 `useSuperSessionEntry`（按 id 拉取，分页后也不会丢）。
- 侧栏：`ModernSidebar`（桌面）与 `SessionSidebarContent` / `SessionItemRenderer`（移动端）在置顶区最上面单独渲染 Super 行，并从普通列表按 id 去重；`SessionRow` 的 `variant="super"` 隐藏置顶 / 归档 / 拖拽，删除确认换成专用文案。状态点复用 `useSessionSidebarIndicators`，靠常驻 store 的流状态变化驱动。
- 删除：`useSessionLifecycle.deleteSession` 与桌面侧栏删除后重新读取状态，若正停在被删的 Super 会话上就切到后端新建的那个。
- 独立的 `super-agent` 视图、页面与导航项已删除；历史记录 / 深链里的 `super-agent` 经 `canonicalView` 重定向到 `chat-v2`。

## 能力对等

| 能力 | Super 会话 | 说明 |
|---|---|---|
| 附件 / 引用 / 流式 / 思考 / 工具 / 审批 | 原生 | 同一管线 |
| 停止 / 继续 | 原生 | 停止后暂停自动投递 |
| 编辑重发 / 重新生成 / 变体 | 原生 | 会取消被替换消息里派发且仍在运行的 Worker；普通删除消息不取消 |
| 模型选择 / 排队 / 导出 / 分支 / Goal | 原生 | 分支出的副本剥掉 Super 标记 |
| 一键断电 | 原生 | 投递同样经过 `admit_or_block` |
| 记忆 | 用户回合按普通规则 | 事件回合 `auto_memory_extraction = false` |
| 编辑事件消息 | 不可 | 唯一差异：带 `inboundOrigin` 的消息不可编辑 |
| 置顶 / 归档 / 移动分组 | 不可 | 始终置顶；后端拒绝归档活跃 Super |

## 安全与隔离

- **默认关闭**，唯一开关在「设置 → 自动化」。
- **Worker 默认只读**：默认 profile `explorer`（workspace 收发 + 只读检索，无需审批）；工具 fail-closed、有 grant 与预算、600 秒硬超时，全局并发上限沿用 workspace 配置。
- **不可信内容中和**：Worker 输出与外部事件正文在进入会话前统一中和伪造的围栏与结束标签，外部正文包进 `<untrusted_event>`。
- **内部字段不可伪造**：`SendOptions.super_session`、`SendOptions.user_message_origin` 均为 `#[serde(skip)]`，只能由后端钩子设置。
- **连续自动回合上限 20**：自上一条用户消息以来的连续事件回合达到上限即暂停，需用户确认继续（`force`）。
- **事件回合不做记忆提取**，避免把事件正文和模型推断写进用户记忆。

## 生命周期

- **开启**：写 settings → `ensure()`（已有活跃会话则取消隐藏；没有则新建会话 + 工作区并把 Super 注册为 Coordinator）→ 发 `super_session_changed`。
- **关闭**：写 settings → 取消 Super 工作区所有活跃 Worker → `hidden = true` → 发事件；前端释放常驻 lease，正停在该会话时切走。
- **重启**：`super_session::init` 只读 settings 并在启用时 `ensure()`，不启动后台循环；前端常驻控制器加载会话、恢复执行、有待处理事件就投递。
- **删除**：软删 / 硬删成功后 `on_session_removed`：取消 Worker；硬删删工作区、软删关工作区；仍启用则新建空 Super 会话并广播新 id。
- **回收站恢复**：恢复出的旧 Super 若不是当前那个，立即退役。
- **多窗口**：控制器只在 main 窗口；投递靠原子流注册 + drain，重复触发只会得到 Busy / Empty。
- **托盘**：关窗只是隐藏，webview 存活，控制器照常；托盘驻留判断纳入 `super_session::is_enabled`。
- **无窗口**：`CompletionDispatcher` 对 Super 目标只标记已投递，不跑 headless 唤醒（结果仍在收件箱，下次打开投递）。

## 已知限制 / 后续

- 尚未接入任何外部事件源（iLink、复习到期、自动化钩子），`post_external_event` 已备好。
- 只在 main 窗口投递；main 窗口不存在时（纯无窗口）事件留在收件箱，直到下次打开。
- Super 会话长期增长，依赖管线自身的上下文压缩，未专门验证长时间运行。
- 侧栏 Super 行的摘要按 id 单独拉取，会话列表变化时刷新；与普通列表同页时优先用列表里的副本。

## 与旧实现的关系

首版是「独立页面 + 独立数据库」的形态：`src/features/super-agent/` 页面、`superagent.db`（事件、投递、Worker、订阅、回复、配置）、Router 用文本协议块下发决策、9 个 `superagent_*` 命令、后台 Watchdog 循环。它与普通会话是两套体验（不支持附件、编辑、变体等），重做后全部移除：

- 删除后端 `chat_v2/superagent/**` 与 9 个 `superagent_*` 命令；`IncomingTrigger` 与过滤器迁到 `super_session/inbound.rs`，中和逻辑迁到收件箱格式化。
- 删除前端独立页、`super-agent` 视图与导航项、Router / Worker 模型、并发度、Worker 上限、保留期等设置；设置页只保留开关与「额外指令」。
- 旧 `superagent.db`：首次启动只迁移开关状态到主库 settings，文件改名为 `.legacy`，不导入历史。旧 Router / Worker 内部会话继续按 metadata 的 `superagent` 键从会话列表与学习概览中隐藏。

## 验证

待集成后填写：

- Rust：super_session 模块测试数量与结果（state / inbound / inbox / 管线钩子 / 执行器 / repo 过滤 / dispatcher / persistence）——待集成后填写。
- 前端：vitest（常驻控制器、事件卡片、guards、toolCall、侧栏 Super 行、导航、设置开关）数量与结果——待集成后填写。
- 类型检查、eslint、前端分层校验、i18n 键集——待集成后填写。
- 真实模型端到端（派发、并行完成投递、停止暂停、删除重建、关闭隐藏 / 重新打开恢复）——待集成后填写。
