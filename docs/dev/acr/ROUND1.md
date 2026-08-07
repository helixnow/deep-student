# ACR 第一轮 — 20 个并行落地任务卡

> 前置（协调者在派发前完成，代号 R0.5）：脚手架 `src/features/workbench/agent/` 目录 —— `types.ts`（DESIGN §2 全部冻结契约）+ `stageManager.ts` / `presenceStore.ts` 最小可编译桩 + `workbench/index.ts` 导出追加。所有任务卡可假设这些 import 从第一分钟就可用。
> 每个任务：先读 `DESIGN.md` + `STANDARDS.md` + 本卡引用的调研模板文件，再动手。完成 = 名下文件写完 + typecheck/名下 vitest 全绿 + 进度报告落盘。

---

## Rust 组（R1-01 ~ R1-05）（注意：全组禁止 cargo，写完即止）

### R1-01 桥核心与共享常量
- **名下**：新建 `src-tauri/src/chat_v2/tools/workbench_bridge.rs`；`tools/mod.rs`（一次性加齐本轮全部新模块声明：`workbench_bridge`、`workbench_executor` 的 mod+pub use）；`events.rs`（如需）与 `types.rs` 的 `block_types::WORKBENCH_OPS` 常量；`lib.rs`（预计无需新 command，若需在 generate_handler 追加并注明）。
- **做什么**：实现 DESIGN §2.1 的 `acr_bridge_call`。完整照抄 `src-tauri/src/tools/mod.rs` L390-530 的 mcp-bridge 模式（oneshot + `Arc<Mutex<Option<Sender>>>` + 先 listen 后 emit + ListenerGuard RAII + timeout clamp）。增量：① 同时 listen `acr:bridge-progress:{corr}`，收到后 `ctx.emitter.emit_chunk(event_types::TOOL_CALL, &ctx.block_id, &message, None)` 转发到工具卡；② `tokio::select!` 加 `ctx.cancellation_token()` 分支，取消时 emit `acr:bridge-cancel {correlationId}` 并返回 `Err("cancelled")`；③ runId/sessionId 从 ctx 注入请求。附 `AcrBridgeRequest/Response` serde 结构体（camelCase）。
- **单测**：`#[cfg(test)]` 序列化 round-trip 测试（不跑，写好即可）。

### R1-02 WorkbenchToolExecutor（5 个工具）
- **名下**：新建 `src-tauri/src/chat_v2/tools/workbench_executor.rs`；`pipeline.rs` 注册区一行 push（GeneralToolExecutor 之前）；`executor_registry.rs` 超时表加 `workbench_apply/app_command=180s`。
- **做什么**：按 `user_todo_executor.rs` 模板（调研报告 R0-A §3）实现 `WorkbenchToolExecutor`：`can_handle` 匹配 strip 后的 `workbench_list_windows / workbench_open_app / workbench_app_command / workbench_close_window / workbench_query_state`。每个工具：`assert_workbench_agent_gates`（照抄 browser_executor L93-123，flag=`tools.workbench_agent`，setting=`desktop.workbenchAgentControl`，值 `off` 视为关）→ `acr_bridge_call(ctx, command, args, timeout)` → 结果转 `ToolResultInfo`。敏感度：close_window=High，app_command=Medium，其余 Low。错误结构化 `{code,message,hint,retryable}` 文本。桥未挂载/超时 → code `WORKBENCH_UNAVAILABLE` + hint "桌面模式未开启或未就绪，导航类操作不可用；数据修改请改用对应领域工具"。
- **注意**：工具 schema 的 Rust 侧无需注册（走前端 skill embeddedTools 注入）。

### R1-03 canvas 笔记执行器改造（断链修复 + 前端委托）
- **名下**：`src-tauri/src/chat_v2/tools/canvas_executor.rs`（独占）；`notes_manager.rs` 仅在需要返回 updated_at 时小改。
- **做什么**：① **断链修复**：`execute_write_backend` 成功写盘后补发 `emit_watch_event(&ctx.window, DstuWatchEvent::updated(...))`（模板见 builtin_resource_executor L2333-2338；path/node 由 note 查询组装）。② **委托分支**：`note_append/note_replace/note_set` 执行前 `acr_bridge_call(ctx,"probe",{target:{typeId:'note',resourceId}})`；probe∈{clean,dirty,hot} 且非 disabled → 组装 `AgentOp[]`（kind=note_insert/note_replace/note_set，anchor 含 section/position，destructive 按工具定）走 `apply_ops`，回执直接作为工具结果；probe∈{closed,frozen,disabled} 或桥错误 → 回落原后端路径（含 ①）。③ 委托与回落必须在结果 message 中说明所走平面。
- **保留**：既有 `execute_write_frontend`（canvas:ai-edit-request）代码原样保留，suggestion 模式由前端 `apply_ops` 内部触发，Rust 不直接调它。

### R1-04 域事件还债 + OCC 补齐
- **名下**：`qbank_executor.rs`、`user_todo_executor.rs`、`cmd/fsrs_review.rs`、`chatanki_executor.rs`（仅 emit 处）、`vfs/todo_handlers.rs` + todo repo（OCC）。
- **做什么**：① 按 DESIGN §5.6 规范补域事件：qbank 写操作后 `window.emit("qbank://changed",{source:"ai",action,entityIds,runId?})`；fsrs 入队/评分与 chatanki 卡片写库后 `fsrs://changed`；`emit_todo_changed` 增补 `entityIds`（调用点顺手传 item id）。② todo OCC：`todo_update_item/todo_toggle_item/todo_reorder_items` 增加可选 `expected_updated_at` 参数（None 时保持旧行为，兼容存量前端），冲突返回错误码 `TODO_CONFLICT`。qbank OCC 若牵涉过广，写入进度报告遗留给 R2-01。
- **禁**：不碰 pipeline.rs / mod.rs（无新模块）。

### R1-05 mindmap 委托 + browser ControlMode 闭环
- **名下**：`builtin_resource_executor.rs`（仅 mindmap_* 函数段）；`browser_executor.rs`、`browser/service.rs`、`browser/session.rs`、`cmd/browser.rs`（browser 域独占）。
- **做什么**：① `mindmap_edit_nodes`：执行前 probe（target typeId='mindmap'）；可委托 → operations 原样转 `AgentOp[]`（kind=原 type，anchor=node_id，label 生成"添加节点 X"等中文步骤名）走 `apply_ops`；回落走原后端路径（原 OCC/版本逻辑不动）。`mindmap_create/update` 不委托（整份内容，保持后端）。② browser 闭环：`BrowserToolExecutor::execute` 分发前检查 `session.control_mode`——若为 User 且工具属于操作类（click/type/navigate），先 `service.set_agent_control()` 并 emit 状态事件；密码 BLOCKED 时调 `take_over()` + emit。前端 `sessionStore.navigate/back/forward` 的 forceUserControl 处补调 Rust `browser_take_over`（该前端文件 `src/features/browser/sessionStore.ts` 亦归本卡）。

---

## 前端核心组（R1-06 ~ R1-10, R1-19）

### R1-06 StageManager + 仲裁 + 账本 + 挂载
- **名下**：`agent/stageManager.ts`、`agent/arbitration.ts`、`agent/ledger.ts`、`agent/presenceStore.ts`（充实桩）、`WorkbenchDesktop.tsx`（挂载点：启动 effect L358-361 后 init/cleanup + JSX 与 `<WorkbenchEventBridge />` 并列挂 `<AgentBridge />`）、`workbench/index.ts`（末尾追加导出 `stageManager/usePresenceStore/agentFlash` 等）。
- **做什么**：实现 `StageManagerApi`（types.ts 冻结）。`handleBridgeRequest` 分发：probe→probe 模块（R1-07 提供）；apply_ops→查 driver 注册表→建 run（租约互斥：同 windowId 已有 run 则返回 busy 错误码 `WINDOW_BUSY`）→写 presence→`driver.apply`→清 presence→回执；list_windows/open_app/app_command/close_window→windowStore/workbenchBus 直接实现；query_state→provider 注册表；revert_run→ledger。仲裁状态机按 DESIGN §4.1：`notifyUserInput(windowId)` 命中活跃 run→置 pausedByUser + presence 更新；`checkPaused()` 返回挂起 Promise，2s 无输入自动 resume，15s 或显式停止→abort。账本：`record(runId, invert, label)` 栈式存储，`revertRun` 逆序执行 invert，容量 20 个 run LRU。监听 `acr:bridge-cancel`（hubListen）→ abort 对应 run。
- **单测**：仲裁状态机转换表测试（假 timer）。

### R1-07 AgentBridge + probe + pacing
- **名下**：`agent/AgentBridge.tsx`、`agent/bridge.ts`、`agent/probe.ts`、`agent/pacing.ts`。
- **做什么**：① bridge.ts：照抄 `mcpService.setupTauriBridge`（L1563-1630）——listen `acr:bridge-request` → `stageManager.handleBridgeRequest` → emit `acr:bridge-response:{correlationId}`（emit 回传，禁 invoke）；提供 `emitProgress(correlationId, step,total,message,entityId)`，内部节流 ≤5Hz（尾随合并）。AgentBridge.tsx 为 return null 组件，挂载注册/卸载注销。② probe.ts：`probeTarget(target): AcrProbeState`——`workbenchBus.isEnabled()` false→disabled；查 windowStore 找 typeId+instanceKey 窗（content 类 instanceKey=resourceId）；无窗→closed；lifecycle frozen→frozen；`isContentDirty(typeId,instanceKey)` 或 driver 自报 dirty→dirty；焦点窗且 driver 报 hot→hot；否则 clean。③ pacing.ts：`createPacer(profile)` token-bucket + rAF 合帧：`await pacer.tick(cost)`；档位参数按 DESIGN §4.3；`prefers-reduced-motion` 强制 fast；导出 `PacingProfile` 三档常量。
- **单测**：probe 判定矩阵；pacer 时序（fake rAF）。

### R1-08 workbench-tools Skill + 状态查询 provider
- **名下**：新建 `src/features/chat/skills/builtin-tools/workbench-tools.ts`；`builtin-tools/index.ts`（三处追加）；`src/locales/{zh-CN,en-US}/skills.json` 的 builtinNames/builtinDescriptions 加 `workbench-tools`；`agent/queryProviders.ts`。
- **做什么**：① 按调研模板（R0-B 报告末尾）写 skill：id `workbench-tools`，priority 8，5 个 embeddedTools 与 R1-02 的短名对齐（`builtin-workbench_*`），schema strict（additionalProperties:false + 枚举），描述遵守 STANDARDS §3（含"数据修改请用领域工具，本组只负责查看/导航/窗口指令"分工声明与每工具副作用说明）。content 正文写使用剧本（先 list_windows 再操作；open_app payload 字典：files→`{folderId}`、flashcards→`{screen,mode,cardIds}`、todo→`{todoListId}`、browser→`{url}`、note/mindmap→instanceKey=resourceId）。② queryProviders.ts：实现 `list_windows`（WindowSummary：经 getSortedWindows + lifecycles + isContentDirty）与 `query_state` 默认 provider（focused 窗 typeId + title + driver 可选扩展），注册到 stageManager。

### R1-09 chat 侧 workbench_ops 工具卡
- **名下**：`plugins/events/toolCall.ts`（remap 段一处）；新建 `plugins/blocks/workbenchOpsBlock.tsx`；`plugins/blocks/index.ts`（一行 import）；`core/types/common.ts` BlockType 加 `'workbench_ops'`；`src/locales/{zh-CN,en-US}/chatV2.json` `blocks.workbenchOps.*`。
- **做什么**：① remap：stripped toolName 以 `workbench_` 开头 → blockType `'workbench_ops'`（照 sleep/ask_user 分支写法）。② 块组件按调研骨架（R0-D 报告 §9）：读 `block.toolInput`（工具名/目标）+ `block.content`（progress 文本流，逐行渲染步骤）+ `block.toolOutput.result`（AcrReceipt：status/done/undone/entityIds）；按钮：跳转目标窗（`workbenchBus.activate` + fallbackLaunch）、撤销（`stageManager.revertRun(block.toolCallId)`，从 `@/features/workbench` import，成功后按钮置灰）；status partial/cancelled 时展示 done/undone 两列。注册 `onAbort:'keep-content'`。**不要**动 TIMELINE_BLOCK_TYPES。
- **单测**：块渲染三态（running/success/partial）。

### R1-10 视觉原语（光环 / AgentStrip / flash）
- **名下**：`WindowShell.tsx`（消费 presenceStore：目标窗加 `data-agent-active` 与 `data-agent-paused`，标题栏下插 `<AgentStrip windowId/>`）；新建 `agent/visuals/AgentStrip.tsx`、`agent/visuals/agentFlash.ts`、`agent/visuals/agent-visuals.css`；`workbench.json` `agent.core.*` 文案。
- **做什么**：① 光环：CSS 呼吸边框（box-shadow/outline 用 opacity 动画驱动，禁 layout 属性），acting=主题色、paused=琥珀；`prefers-reduced-motion` 静态描边。② AgentStrip：细条显示 `presence.label` + 暂停/停止/撤销按钮（调 stageManager `notifyUserInput` 语义的显式 pause / abort / revertRun）；仅 presence 存在时渲染。③ agentFlash(typeId, entityId)：`querySelector([data-agent-entity="${typeId}:${entityId}"])` → scrollIntoView({block:'nearest'}) + 设 `data-agent-flash`，动画结束移除；驱动器负责给列表行标 data-agent-entity。④ WindowShell 内容区挂 pointerdown/keydown 捕获 → `stageManager.notifyUserInput(windowId)`（滚轮/标题栏排除）。
- **单测**：agentFlash 对缺失元素安全 no-op。

### R1-19 ACR 核心单测套件
- **名下**：`agent/__tests__/`（arbitration.test.ts、pacing.test.ts、ledger.test.ts、probe.test.ts、bridgeRouting.test.ts）。
- **做什么**：用 fake timers + mock driver 覆盖：暂停→续放→abort 全路径；partial 回执 done/undone 正确性；账本 revert 顺序与 LRU；probe 六态矩阵；bridge request→response correlation 与 5Hz 进度节流。mock Tauri 按 `vi.mock('@tauri-apps/api/event')` 惯例。与 R1-06/07 并行开发：以 types.ts 冻结契约为准写测试，接口即规格。

---

## Driver 组（R1-11 ~ R1-16）

### R1-11 mindmap Driver（标杆）
- **名下**：新建 `agent/drivers/mindmapDriver.ts`；`apps/mindmap/register.ts`（onActivation：focusNode/setView）；`features/mindmap` 内仅允许：`MindMapCanvas.tsx` 给 RF node 注入 `agent-entering` className 的通道（读 store 新增瞬态集合）与 `mindmapStore.ts` 追加瞬态字段 `agentEnteringIds:Set<string>`（不进持久化/快照）；`mindmap.css` 复用 nodeSlideIn 增加画布节点动画。
- **做什么**：driver.apply 逐 op：resolve 锚点（node_id 不存在→该 op 进 undone 并 reportProgress 说明）→ 调 store 公开 action（add/update/delete/moveNode；agent 路径全部带 skipHistory 变体——若现有 action 不支持 options，通过 `applyMutation` 等价组合实现，禁止改 action 既有语义）→ 账本记逆操作（delete 前深拷贝子树快照）→ `setFocusedNodeId(newId)`（触发视口跟随）→ 标 agentEnteringIds → `pacer.tick()` + `checkPaused()`。destructive（delete/move）在 probe=dirty/hot 时整批转 suggestion：不改文档，回执 suggestionPending + message"存在未保存编辑，建议改用后端路径或等待用户空闲"（v1 简化：mindmap 无 diff 预览，直接拒绝并说明，R2-02 再评估）。probe hot 判定：`editingNodeId` 命中目标节点。单窗约束：StageManager 租约已保证。
- **单测**：ops 应用与逆操作 round-trip（直接驱动真实 mindmapStore）。

### R1-12 note Driver（流式插入 + AI 光标）
- **名下**：新建 `agent/drivers/noteDriver.ts`；新建 `src/components/crepe/plugins/agentHighlight.ts`；`crepe/plugins/index.ts`（applyCrepePlugins 加一行 use）；`crepe/types.ts` + `CrepeEditor.tsx` 扩展 `agentInsert` API；`apps/content/register.ts` note 的 onActivation（scrollToHeading）。
- **做什么**：① agentHighlight.ts 克隆 searchHighlight.ts：meta 驱动，维护 AI 光标 widget（带 "AI" 标签的竖线）+ 插入区间 inline decoration（class `agent-inserted`，run 结束后 3s 渐隐清除；mapping 用 `DecorationSet.map`）。② `agentInsert(chunk, anchorPos)`：`editor.action` 拿 view，`tr.insertText(chunk, pos).setMeta('addToHistory',false).setMeta(agentHighlightKey,{...})`；不 focus 编辑器（不抢用户焦点）。③ noteDriver：锚点 resolve（section 标题→PM 文档位置；end→doc.content.size-1）；词级分批（8-40 字符）循环：`pacer.tick` → `checkPaused` → agentInsert → 每批后由 agentHighlight 插件内部 map 维护位置（driver 持有 mapping 偏移）。账本：记录 [from,to) 区间（经 mapping 持续更新），revert=delete 区间。dirty 场景允许（串行 dispatch 天然安全），hot（用户光标在目标 section 内）→ 暂停等待。窗口未挂载 editorApi（frozen 等）→ 返回可行动错误让 Rust 回落。
- **获取 editorApi**：经 driver 注册表由 NoteContentView 挂载时注册（`registerNoteEditor(resourceId, api)`，放 noteDriver 模块内，R1-13 负责在视图侧调用）。
- **单测**：锚点 resolve 与分批切词。

### R1-13 note 接线（建议模式 + dirty + 绑定）
- **名下**：`features/learning-hub/apps/views/NoteContentView.tsx`（独占）；`features/notes/NotesCrepeEditor.tsx`（独占）；新建 `agent/noteBinding.ts`；`apps/content/createContentApp.tsx` 若需传参微调。
- **做什么**：① NotesCrepeEditor 的真实 isDirty 接入 `contentDirtyRegistry`（registerContentDirtyChecker('note', resourceId, isCurrentNoteDirty)，挂载注册/卸载注销——需要从 NoteContentView 传 resourceId）。② 把 `useCanvasAIEditHandler`（canvas:ai-edit-request → AIDiffPanel）在 workbench DSTU 模式下同样生效：确认其 enabled 条件覆盖 NoteContentView 场景，accept 后走既有 setMarkdown+保存链路；suggestion 由 noteDriver 触发：destructive op 且 dirty/hot 时 driver 派发同格式 `canvas:ai-edit-request` CustomEvent 并立即回执 suggestionPending。③ noteBinding.ts：note 窗 isActive 变化 → 将 resourceId 写入当前聚焦 chat 会话的 modeState.canvasNoteId（复用 NotesContext 既有 setter 或 sessionManager API，查明后选一，报告中记录选择）。④ NoteContentView 挂载时向 noteDriver 注册 editorApi（R1-12 提供的 registerNoteEditor）。
- **单测**：dirty checker 注册/注销。

### R1-14 todo + finder Driver
- **名下**：新建 `agent/drivers/todoDriver.ts`、`agent/drivers/finderDriver.ts`；`apps/system/register.tsx` 中 todo/files 两个 AppDefinition 加 onActivation；`features/todo/components/TodoContentView.tsx`（独占：改造 todo://changed 消费 + 行 data-agent-entity + 守卫）；`features/learning-hub` 内 `LearningHubSidebar.tsx`/`FinderFileList.tsx` 仅允许：行元素加 `data-agent-entity`、暴露 flash 所需 props、inlineEdit 期间跳过 silent refresh 的守卫。
- **做什么**：driver 本身薄（数据面在后端）：`apply` 仅处理导航类 op（todo_show_list/finder_open_folder），其余返回不支持。重点：① onActivation——todo `showList {listId}`（setActiveList）/`focusItem {itemId}`（selectItem+flash）；files `openFolder {folderId}`（enterFolder）/`reveal {resourceId}`（enterFolder 父目录+setSelectedIds+flash）。② TodoContentView 消费增强事件：payload.entityIds 存在→reload 后逐个 agentFlash；详情面板编辑中（本地草稿 state）→延迟 reload 至 blur。③ finder：`registerDomainListener('dstu:change', ...)`（R1-18 API）后对 agent 来源变更 flash 对应行；inlineEdit.editingId 非空时跳过本次 silent refresh。
- **单测**：onActivation 分发。

### R1-15 flashcards + qbank Driver
- **名下**：新建 `agent/drivers/fsrsDriver.ts`、`agent/drivers/qbankDriver.ts`；`features/flashcards/store/fsrsReviewStore.ts`（追加 `appendToQueue(cards: ReviewCard[])` action，唯一改动）；`apps/system/register.tsx` flashcards 段 onActivation；`features/learning-hub/apps/views/ExamContentView.tsx`（独占：消费 qbank://changed + 守卫 + data-agent-entity）；flashcards 相关视图行标 data-agent-entity。
- **做什么**：① fsrs：onActivation `startReview {payload}` = `applyLaunchPayload`（收编 ankiCardsBlock workaround——本卡不改 ankiCardsBlock，记录遗留给 R2-04 统一）；`registerDomainListener('fsrs://changed')` → screen=today/library 时刷新（loadDue/重查库），session 进行中仅 `appendToQueue`（去重：已在 queue 的 cardId 忽略）+ toast "AI 添加了 N 张卡片"。appendToQueue 铁律：不动 queueIndex、不动当前卡。② qbank：`registerDomainListener('qbank://changed')` → ExamContentView 刷新列表；守卫：`currentQuestionId` 对应题目不因刷新替换对象引用导致答题中断（刷新后 setCurrentQuestion 保持）；行内编辑器打开时延迟刷新；entityIds flash。
- **单测**：appendToQueue 不重置会话；qbank 刷新守卫。

### R1-16 pomodoro Driver + 通用 content 指令
- **名下**：新建 `agent/drivers/pomodoroDriver.ts`；`apps/system/register.tsx` pomodoro 段 onActivation；`apps/content/register.ts` 其余类型（textbook/exam/translation/essay）补统一 onActivation `scrollToAnchor`（可选实现，不通则回执 handled:false）；`agent/drivers/index.ts`（汇总注册所有 driver 到 stageManager，被 R1-06 挂载调用）。
- **做什么**：pomodoro app_command：`start {taskId?,taskTitle?}` / `pause` / `resume` / `stop`——直调 usePomodoroStore；strictMode 拒绝 pause 时返回 `{handled:false, code:'STRICT_MODE', hint:'严格模式下专注中不可暂停'}`；投影系统自动开窗即演出，无需额外视觉。drivers/index.ts：导出 `registerAllDrivers(stageManager)`，逐个 registerDriver + registerDomainListener 接线（各 driver 文件自带注册函数，此处只汇总——注意与各 driver 卡的文件边界：index.ts 归本卡）。
- **单测**：strictMode 分支。

---

## 支撑组（R1-17, R1-18, R1-20）

### R1-17 权限双闸与设置面
- **名下**：`src-tauri/src/feature_flags.rs`（default_flags 数组追加 `tools.workbench_agent`，disable 默认，无依赖，描述"ChatV2 Agent 操控学习桌面"）；`WorkbenchSettingsSection.tsx`（WORKBENCH_SETTING_KEYS 加 `agentControl:'desktop.workbenchAgentControl'` 与 `agentPacing:'desktop.workbenchAgentPacing'`；UI：三态 Select（off/background/follow，默认 background）+ pacing 三态（fast/normal/demo，默认 normal），照抄 browserAgentControl 的加载/persist/dispatchSettingsChanged 模式）；`workbench.json` `settings.agentControl.*` 双语。
- **做什么**：见上。另：StageManager 读这两个设置的逻辑归 R1-06，本卡只负责存取面与 flag；确保 `workbench:settings-changed` 派发 key 正确。

### R1-18 域事件订阅基建 + DevPanel 指示
- **名下**：新建 `agent/domainEvents.ts`；`components/WorkbenchDevPanel.tsx`（追加 ACR 小节：活跃 run 数/presence 列表/最近回执状态）。
- **做什么**：domainEvents.ts：`registerDomainListener(eventName, handler): () => void`——内部经 `hubListen` 统一订阅（每事件名全局一个 listener），handler 收 DESIGN §5.6 载荷；对 `dstu:change` 设 key extractor 兼容。导出给 drivers 用（接口写进 types.ts 的注释区，实现归本卡）。DevPanel：订阅 presenceStore + ledger 概要，纯只读展示。
- **单测**：多 handler 注册/注销与 payload 透传。

### R1-20 验收场景库 SCENARIOS.md
- **名下**：新建 `docs/dev/acr/SCENARIOS.md`。
- **做什么**：产出可执行验收场景表（≥35 条），每条：编号 / 前置状态 / chat 指令原文 / 期望工具链 / 期望视觉演出 / 期望回执 / 判定标准。必须覆盖：① 每应用主路径（打开→定位→编辑→确认）；② 跨应用编排 ≥3 条（如"把这篇笔记的要点做成闪卡并开始复习"）；③ 仲裁：演出中打字→暂停→续放；打字后停止→partial+userPatch；④ 取消：chat 停止按钮中断 apply_ops；⑤ 降级：OS 模式关 / 闸门关 / 窗口 frozen / 资源不存在；⑥ 建议模式：dirty 笔记的 replace → AIDiffPanel accept 与 reject；⑦ 撤销：工具卡撤销按钮 + 数据校验；⑧ 性能场景：双窗并发演出 + DevPanel 指标读数判定（对照 DESIGN §7）。写作时逐条核对代码可达性（工具名/action 名与任务卡一致），不可凭空造接口。此文档是 R2/R3 的验收基准。

---

## 派发与验收

- 20 个任务全部并行派发（grok 4.5 fast）；R1-06/07 是多数任务的运行时依赖，但因 R0.5 脚手架冻结契约，各卡可独立开发与 typecheck。
- 协调者验收序：cargo check → typecheck → lint → vitest 全量 → check:i18n → 冒烟（SCENARIOS 抽 5 条）→ 汇总返工/遗留 → 生成 R2 任务卡最终版。
