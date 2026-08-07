# ACR — Agent Collaborator Runtime 总体设计（v1.0 冻结）

> ACR 2.0 的 capability manifest、observe-act-verify、风险分层、持久撤销与
> 产品发现入口见 [`ACR-2.0.md`](./ACR-2.0.md)。本文继续作为 1.x driver、演出和
> 用户接管协议的冻结真相源。

> 目标：让 chat agent 完整操控 OS 模式（workbench）下所有子应用，操作在目标窗口**实时视觉演出**，与用户编辑**不冲突**，达到 SOTA 标准。
> 本文是三轮改造（R1×20 / R2×10 / R3×5）的唯一架构真相源。接口标注【冻结】的部分未经协调者批准不得更改。
> 配套文档：`STANDARDS.md`（工程规范）、`ROUND1/2/3.md`（任务卡）、`SCENARIOS.md`（验收场景，R1-20 产出）。

---

## 0. 核心决策（来自三轮调研的裁决）

1. **不引入 CRDT/Yjs**。用户与 agent 在同一进程写同一内存文档，只需要"串行化写入 + 来源标记 + 位置重映射"。（协作编辑调研裁决）
2. **agent 写入不进用户 undo 栈**。用户 Ctrl+Z 只撤自己的编辑；agent 修改记入独立 Run Ledger，整体可回滚。（ProseMirror/Yjs/BlockNote 共识）
3. **不做假鼠标**。用语义聚光灯：窗口光环 + 实体 flash + AI 光标 decoration + 侧边叙事（chat 工具卡）。（computer-use 产品调研裁决）
4. **传输用"批量委托 + 前端本地节奏"**，不做高频 IPC 流。ops 随一次桥请求整批到达前端，演出节奏由前端 pacing engine 本地控制；进度回报 ≤5Hz。Tauri Channel 保留为 R2 性能区的升级选项。
5. **复用而非新造**：桥复刻 mcp-bridge 模式（emit 请求 + emit 带 correlationId 响应 + oneshot + RAII 卸载监听）；工具卡复用 tool_call 事件 + 前端 remap（sleep/ask_user 先例）；破坏性笔记编辑复活既有 `canvas:ai-edit-request`→`AIDiffPanel` 路径。
6. **控制权三态互斥 + 暂停优先**：`acting | pausedByUser | userExclusive`。用户输入命中目标窗 → 暂停（非终止）；2s 无输入且锚点可重映射 → 续放；不可续 → 返回 partial + userPatch 给 LLM。（Operator/Devin/Claude Chrome 收敛模式）
7. **取消/部分结果协议**（对齐 MCP 精神）：工具终态 `completed | partial | cancelled | failed`，partial 必带 `done[] / undone[] / userPatch?`，绝不静默——否则 LLM 会重试造成双写。
8. **双闸权限**：feature flag `tools.workbench_agent` + 设置 `desktop.workbenchAgentControl`（off/background/follow）。破坏性操作走既有敏感度审批。

---

## 1. 总体架构

```
┌─ Rust (src-tauri) ─────────────────────────────────────────────┐
│ tool_loop ──► WorkbenchToolExecutor (workbench_* 工具)          │
│          ──► 域执行器改造点: mindmap_edit_nodes / note_append…  │
│                    │ probe/委托                                 │
│              workbench_bridge::acr_bridge_call()               │
│   emit "acr:bridge-request" ─────────────┐                     │
│   listen "acr:bridge-response:{corr}" ◄──┤  (oneshot+超时+RAII) │
│   listen "acr:bridge-progress:{corr}" ◄──┤  → emit_chunk 到工具卡│
└──────────────────────────────────────────┼─────────────────────┘
┌─ 前端 (src/features/workbench/agent/) ────▼─────────────────────┐
│ AgentBridge(全局挂 App 根；随 workbenchActive 启停) ─► StageManager │
│   ├ probe: windowStore + contentDirtyRegistry + gates          │
│   ├ apply_ops: 路由到 CollabDriver → pacing engine 逐 op 演出   │
│   ├ presenceStore: 窗口光环/AgentStrip/AI 光标 的真相源          │
│   ├ Run Ledger: runId → invert 句柄 → 撤销                      │
│   └ 仲裁状态机: 用户输入 → pause → resume/abort(partial)        │
│ Drivers: mindmap / note / todo / finder / fsrs / qbank / pomo  │
└────────────────────────────────────────────────────────────────┘
数据兜底面（资源未打开/OS 模式关闭时）:
  域执行器后端直写 + 域事件({domain}://changed / dstu:change) → 打开中的窗口刷新
```

### 1.1 三平面写入路由（Driver.probe 决定）

| probe 结果 | 追加类 op | 破坏类 op |
|-----------|----------|----------|
| `closed`（资源未开窗）/ `disabled`（OS 关/闸门关） | 后端直写 + 域事件 | 后端直写 + 域事件（High 审批） |
| `clean`（开窗、无脏） | 前端委托 + 演出 | 前端委托 + 演出 |
| `dirty`（开窗、有未保存编辑） | 前端委托 + 演出（语义锚点重映射） | 建议模式（AIDiffPanel / decoration 预览） |
| `hot`（用户焦点正在目标实体上） | 暂停等待或排队 | 建议模式 |
| `frozen`（窗口被调度器冻结） | 视同 `closed`（后端直写），或先 focus 唤醒（follow 档） | 同左 |

追加类：add_node、note_append、todo create、fsrs 入队。破坏类：delete_node/move_node（跨父）、note_replace/set、批量删除。

---

## 2. 协议【冻结】

### 2.1 桥 RPC（复刻 mcp-bridge，见 `src-tauri/src/tools/mod.rs` L390-530）

事件名与载荷：

```
Rust → FE : emit("acr:bridge-request", AcrBridgeRequest)
FE → Rust : emit("acr:bridge-response:{correlationId}", AcrBridgeResponse)
FE → Rust : emit("acr:bridge-progress:{correlationId}", AcrProgress)   // ≤5Hz
Rust → FE : emit("acr:bridge-cancel", { correlationId })               // 取消传播
```

```ts
interface AcrBridgeRequest {
  correlationId: string;
  command: 'probe' | 'apply_ops' | 'list_windows' | 'open_app'
         | 'app_command' | 'close_window' | 'query_state' | 'revert_run';
  args: unknown;            // 见 §2.3 各命令载荷
  timeoutMs: number;        // Rust 侧已 clamp
  runId: string;            // = toolCallId，贯穿工具卡/presence/账本
  sessionId: string;
}
interface AcrBridgeResponse {
  correlationId: string;
  ok: boolean;              // 桥层是否成功（业务失败也 ok:true，失败进 data.status）
  data?: AcrReceipt;
  error?: string;           // 桥层错误（超时/未挂载/闸门）
}
interface AcrProgress {
  correlationId: string;
  step: number; total?: number;
  message: string;          // 转发到工具卡 ToolProgress 流式区
  entityId?: string;
}
```

Rust 侧 `workbench_bridge.rs` 帮助函数【冻结签名】：

```rust
pub async fn acr_bridge_call(
    ctx: &ExecutionContext,   // 用 ctx.window / cancellation_token / emitter+block_id 转发进度
    command: &str,
    args: serde_json::Value,  // runId/sessionId 由 helper 从 ctx 注入
    timeout_ms: u64,
) -> Result<AcrBridgeResponse, String>
```

实现要点：先 `listen` 后 `emit`；`oneshot + Arc<Mutex<Option<Sender>>>`；`ListenerGuard` RAII 防泄漏；`tokio::select!` 同时等 响应 / 超时 / `ctx.cancellation_token()`（取消时 emit `acr:bridge-cancel` 再返回）；progress 监听转发为 `ctx.emitter.emit_chunk(event_types::TOOL_CALL, &ctx.block_id, message, None)`。

### 2.2 回执（工具终态，给 LLM 的权威结果）【冻结】

```ts
interface AcrReceipt {
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  mode: 'frontend' | 'backend' | 'suggestion';   // 实际执行平面
  applied: number; totalOps: number;
  entityIds: string[];                            // 受影响实体
  done: string[];                                 // 人类可读的已完成步骤
  undone: string[];                               // 未执行/已回滚步骤
  userPatch?: string;                             // 用户接管后其修改摘要（Devin 协议）
  suggestionPending?: boolean;                    // 走建议模式，等待用户 accept/reject
  message?: string;                               // 给 LLM 的补充指引
}
```

规则：`partial/cancelled` 必带 done/undone；`suggestion` 模式立即返回 `suggestionPending:true`，不阻塞 tool_loop 等用户点按（LLM 收到"已提交建议，用户稍后确认"）。

### 2.3 命令载荷

| command | args | data(AcrReceipt.data 扩展) |
|---------|------|---------------------------|
| `probe` | `{ target: AcrTarget }` | `{ state: 'closed'\|'clean'\|'dirty'\|'hot'\|'frozen'\|'disabled', windowId? }` |
| `apply_ops` | `{ target, ops: AgentOp[], pacing?: 'fast'\|'normal'\|'demo', destructive: boolean }` | AcrReceipt |
| `list_windows` | `{}` | `{ windows: WindowSummary[] , focused?: string }` |
| `open_app` | `{ typeId, instanceKey?, payload?, focus?: boolean }` | `{ windowId, created: boolean }` |
| `app_command` | `{ typeId, instanceKey?, action, payload? }` | `{ handled: boolean }`（转 `workbenchBus.activate`） |
| `close_window` | `{ windowId }` | `{ closed: boolean }`（走 canClose） |
| `query_state` | `{ scope: 'focused'\|'window', windowId? }` | 应用状态摘要（R1-19 provider） |
| `revert_run` | `{ runId }` | `{ reverted: boolean }` |

```ts
interface AcrTarget { typeId: string; resourceId?: string; }   // resourceId ≈ instanceKey
interface AgentOp {
  kind: string;              // 域内 op 名: 'add_node'|'update_node'|'move_node'|'delete_node'
                             //            |'note_insert'|'note_replace'|'todo_create'|...
  anchor?: unknown;          // 语义锚点: nodeId / {heading,offset} / itemId —— 前端 resolve
  payload: unknown;
  destructive: boolean;
  label: string;             // 人类可读步骤名（progress/done 列表用）
}
interface WindowSummary {
  windowId: string; typeId: string; instanceKey: string | null;
  title: string; lifecycle: string; focused: boolean; dirty: boolean;
}
```

### 2.4 前端契约（`src/features/workbench/agent/types.ts`，R0.5 由协调者脚手架）【冻结】

```ts
export type AcrRunStatus = 'acting' | 'pausedByUser' | 'reviewing' | 'done' | 'aborted';

export interface CollabDriver {
  typeId: string;
  probe(target: AcrTarget): AcrProbeState;                         // 同步，不许 await
  apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt>;  // 内部经 pacing 逐 op
  abort(runId: string): AcrReceipt;                                // 立即停止，返回 partial
  revert(runId: string): Promise<boolean>;                         // 账本回滚
}
export interface AcrRunContext {
  runId: string; sessionId: string; target: AcrTarget; windowId: string | null;
  pacing: PacingProfile;
  reportProgress(step: number, total: number, message: string, entityId?: string): void;
  checkPaused(): Promise<'resume' | 'abort'>;   // 每 op 之间调用；暂停时挂起
  ledger: RunLedger;
}
export interface RunLedger {
  record(runId: string, invert: () => Promise<void> | void, label: string): void;
}
export interface PresenceState {
  runId: string; windowId: string; typeId: string;
  status: AcrRunStatus; label: string; startedAt: number; ttlMs: number;
}
// StageManager 对外 API
export interface StageManagerApi {
  registerDriver(driver: CollabDriver): void;
  registerQueryProvider(scope: string, fn: (args: unknown) => unknown): void;
  handleBridgeRequest(req: AcrBridgeRequest): Promise<AcrBridgeResponse>; // AgentBridge 调
  revertRun(runId: string): Promise<boolean>;
  notifyUserInput(windowId: string): void;   // WindowShell/驱动挂 pointer/keydown
}
```

---

## 3. 工具面（`workbench-tools` Skill + WorkbenchToolExecutor）

设计遵循 SOTA 规范（见 STANDARDS.md §3）：任务对齐、strict schema、返回高信号状态、错误可行动。

| 工具（LLM 可见名） | 敏感度 | 语义 |
|---|---|---|
| `builtin-workbench_list_windows` | Low | 桌面窗口清单 + 焦点 + dirty（替代每轮 prompt 注入） |
| `builtin-workbench_open_app` | Low | 打开/聚焦应用窗，payload 语义化（文件夹/资源/复习会话/todo 清单/URL） |
| `builtin-workbench_app_command` | Medium | 对窗口发一次性指令（= activate action，见 §5 各应用表） |
| `builtin-workbench_close_window` | High（审批） | 关窗，走 canClose |
| `builtin-workbench_query_state` | Low | 查询焦点窗/指定窗应用状态摘要 |

域写入工具**保持既有归属**（canvas/mindmap/todo/qbank/fsrs 执行器），仅内部增加"probe→前端委托"分支。工具描述必须写明与域工具的分工（"改数据用域工具，本组只管看见/导航"）。

前端 remap：`toolCall.ts` 中 stripped 名以 `workbench_` 开头 → 块类型 `workbench_ops`（复用 tool_call 事件，模式同 sleep/ask_user）。域工具保持 `mcp_tool` 卡。

---

## 4. 仲裁状态机与视觉系统

### 4.1 状态机（StageManager 实现，全 driver 共用）

```
idle ──工具启动(租约)──► acting
acting ──pointer/keydown 命中目标窗内容区──► pausedByUser（op 队列冻结, presence 转琥珀, 进度上报"已暂停"）
pausedByUser ──2s 无输入 且 下一 op 锚点可 resolve──► acting（续放）
pausedByUser ──锚点失效 / 用户点停止 / 15s 仍活跃──► aborted → AcrReceipt(partial + userPatch)
acting ──destructive & probe∈{dirty,hot}──► suggestion（提交预览, 立即回执 suggestionPending）
任意 ──Rust acr:bridge-cancel / chat 取消──► aborted(partial)
done ──(账本保留)──► 可 revert
```

规则：滚动、切窗、点击标题栏**不算**打断（沿用浏览器设计"纯滚动不打断"）；同一窗口同时只允许一个 run（租约互斥）；租约带 TTL 心跳（presence ttlMs=8000，StageManager 每 3s 续），run 挂死光环自动熄灭。

### 4.2 视觉原语（R1-10）

| 原语 | 实现 | 数据源 |
|---|---|---|
| 窗口光环 | `WindowShell` 加 `data-agent-active`，CSS 呼吸边框（transform/opacity only） | presenceStore |
| AgentStrip | 窗口顶部细条："AI 正在操作：{label} · [暂停] [停止] [撤销]"（复用 browser AgentBar 样式思路 `.wb-browser-agent.is-agent`） | presenceStore + ledger |
| 实体 flash | `agentFlash(el)`：scrollIntoView + `data-agent-flash` 属性，CSS 600-900ms 渐隐 | 各 driver / 域事件 entityIds |
| AI 光标（笔记） | `agentHighlight.ts` PM 插件：Decoration.widget 光标 + Decoration.inline 新增区高亮渐隐（克隆 `searchHighlight.ts`） | noteDriver |
| 节点入场（导图） | RF node className `agent-entering` + CSS（复用大纲 `entering`/`nodeSlideIn`）；相机 `setFocusedNodeId` 触发 ensureNodeVisible | mindmapDriver |
| chat 工具卡 | `workbench_ops` 块（步骤列表 + 跳转 + 状态）；域工具卡进度走 tool_call chunk 文本 | 桥 progress |

`prefers-reduced-motion` 或 pacing=fast：全部直落终态，仅保留 flash。

### 4.3 pacing 档位（performance 调研数值）

| 档位 | 导图 | 笔记 | 列表 |
|---|---|---|---|
| fast | 直落终态 + flash | 整段插入 + 高亮 | flash |
| normal(默认) | ~300ms/op；setCenter 每 3-5 op 节流；结束一次 fitView | 词级 8-40 字符/批，rAF 30-60Hz | 逐条 150ms |
| demo | 600ms/op | 15-30Hz | 300ms |

演出前置检查：目标窗 `focused/visible` 才演出；`background` 直落终态 + Dock 角标；演出期间 `reportSchedulerActivity('stream')` + `requestWakePrefetch(windowId)` 每 3s 心跳；同时演出窗口 ≤2；perfMonitor 连续帧 >33ms → 自动降 fast。

---

## 5. 逐应用 Driver 规范

（接口手册见调研报告；此处定 op 词汇与关键策略。register.ts 的 onActivation 与 app_command 的 action 一一对应。）

### 5.1 mindmap（R1-11）——标杆
- **ops**：复用后端 `mindmap_edit_nodes` 词汇 `update_node/add_node/delete_node/move_node`（schema 见 `mindmap-tools.ts` L410-572），前端逐条经 `useMindMapStore` 公开 action 应用。
- **历史策略**：agent op 用 `{ skipHistory: true }` 变体 + 账本记逆操作（add→delete；update→旧 patch；delete→子树快照重插；move→原位置）。禁止污染用户 undo 栈。
- **保存**：靠 store 既有 debounceSave(1.5s)+OCC；工具回执注明"已应用（自动保存）"。
- **演出**：每 op 后 `setFocusedNodeId(id)`（触发 canvas ensureNodeVisible）+ entering class；大纲免费获得 `enteringNodeIds` 动画。
- **onActivation**：`focusNode {nodeId}` / `setView {view}`。
- **约束**：单例 store——StageManager 保证同一时刻只驱动一个 mindmap 窗。

### 5.2 note（R1-12/13）——体验上限
- **追加/插入**（append/insert）：委托前端 → `agentInsert(text, anchor)`：Milkdown `editor.action(ctx)` 拿 `editorViewCtx`，`tr.insertText` 词级分批 + `setMeta('addToHistory', false)` + `setMeta(agentHighlightKey, ...)`；打字机 rAF 30-60Hz；写完让 Crepe onChange→queueSave 自然落盘（勿标记 programmatic）。
- **破坏类**（replace/set）且 dirty/hot：走既有 `execute_write_frontend`（Rust canvas_executor 已有）→ `canvas:ai-edit-request` → `AIDiffPanel` accept/reject；**R1-13 把该监听接到 workbench 的 NoteContentView**（现在只挂在 NotesContext）。
- **绑定**：note 窗聚焦 → 同步 canvasNoteId 到当前会话（`agent/noteBinding.ts`），agent 才知道"当前笔记"。
- **锚点**：`{heading?: string, position: 'end'|'afterHeading'|'offset', offset?: number}`，写前 resolve，dirty 时按标题文本重新定位，失败→该 op 作废进 undone。
- **账本**：run 开始记 `captureSelection` + 插入区间；revert = 删除插入区间（经 PM mapping）。

### 5.3 todo / finder（R1-14）
- 数据面走后端（既有 user_todo 工具）；driver 消费增强域事件 `todo://changed {entityIds}` → `selectItem` + flash + 滚动。
- 守卫：`inlineEdit`/拖拽中跳过整表 reload（finder silent refresh 已保留选中，补 editingId 守卫）。
- onActivation：todo `showList {listId}` / `focusItem {itemId}`；files `openFolder {folderId}`（`useFinderStore.enterFolder`）/ `reveal {resourceId}`。

### 5.4 flashcards / qbank（R1-15）
- 新域事件 `fsrs://changed`、`qbank://changed`（R1-02 发射）→ driver 刷新 library/题目列表，flash。
- **铁律**：复习 session 进行中只允许 append-only 入队（新 action `appendToQueue(cards)`），绝不 `startBatchSession` 重置；当前题/当前卡不因刷新变化。
- onActivation：flashcards `startReview {payload}`（收编 ankiCardsBlock 的 workaround）；exam 窗 `focusQuestion {questionId}`。

### 5.5 pomodoro / browser（R1-16 / R1-05）
- pomodoro：纯前端 driver，app_command → `usePomodoroStore.start/pause/resume/stop`；strictMode 拒绝 pause 时回执 failed+hint。投影自动开窗即演出。
- browser：补完 ControlMode 闭环（Rust）——`BrowserToolExecutor.execute` 前检查 `control_mode`，工具开始 `set_agent_control()`，用户 navigate/takeOver 前端同步调 Rust `take_over`；密码框 BLOCKED → 强制 take_over + 事件。

### 5.6 域事件规范【冻结】
`{domain}://changed`，payload：`{ source: 'agent'|'user', action: string, entityIds: string[], runId?: string }`。消费统一经 `hubListen`（禁止每窗自 listen）。现有 `todo://changed` 增补 entityIds；新增 `qbank://changed`、`fsrs://changed`；资源类走 `dstu:change`（canvas 后端写补发——当前断链）。

---

## 6. 权限、边界与降级

- **双闸**：`tools.workbench_agent`（feature_flags.rs；键缺失时默认 `Enabled`，已持久化的显式 `Disabled` 必须保留）+ `desktop.workbenchAgentControl`（'off'|'background'|'follow'，**未设置默认 'follow'**）。Rust `assert_workbench_agent_gates`。`background`=不抢焦点；`follow`=自动开窗聚焦跟随。用户可用 control=`off` 停用操控，也可用 feature flag 硬关闭全部 workbench 工具。
- **OS 模式关闭 / workbenchBus disabled**：全局 AgentBridge 仍可立即应答；probe 返回 `disabled`，`list_windows/query_state` 仅做本地只读查询，`open_app/app_command/close_window/apply_ops/revert_run` 返回可行动错误 `WORKBENCH_DISABLED`，避免等待桥超时。域执行器可依据 probe 结果改走后端数据面并发域事件。
- **桥启停顺序**：启用时先 `StageManager.start()` 再开放 bus；停用时先关闭 bus 再 `StageManager.stop()`，避免请求落入半初始化或半停止窗口。
- **停用/取消排空**：`stop()` abort 活跃请求但保留 run、correlation 与窗口租约，等待原 apply 的 `finally` 结算；最多等待 15 秒，超时生成明确的 `partial/orphan` Receipt、封账并释放租约。迟到 finally 不得覆盖该终态或清理复用同 ID 的新 run。
- **frozen 窗**：probe=frozen；follow 档先 `focusWindow` 唤醒再委托；background 档走后端。演出期间 `requestWakePrefetch` 心跳防冻结。
- **审批可见性**：High 工具审批前先 `focusWindow` 会话所属 chat 窗（否则审批栏不可见——生命周期调研 #12）。
- **重启/崩溃**：账本内存级，重启即失效；未完成 run 不承诺续跑（与 tool_loop 现状一致）。
- **超时**：probe 3s；apply_ops = 30s + N×pacing 预算，clamp ≤120s；executor_registry 超时表登记 workbench 工具 180s。
- **doom-loop 防护**：桥层错误（未挂载/超时/闸门）返回明确错误码 + hint，工具结果指引 LLM 改走数据面而非重试。

## 7. 性能预算【验收硬指标】

| 项 | 预算 |
|---|---|
| 演出期间用户交互 | p75 INP ≤200ms；无 >100ms 输入阻塞长任务 |
| presence/flash 动画 | 60fps，掉帧率 <5%；只用 transform/opacity |
| 打字机 | 词级批（8-40 字符），rAF 合帧，禁每字符 dispatch；流式中 addToHistory:false |
| 导图 | 禁每 op fitView；setCenter 节流；edges 禁 animated |
| IPC | 桥请求/响应低频；progress ≤5Hz；单消息 <8KB |
| 多窗 | 同时演出 ≤2；background 直落终态；visible 非焦点降 10-15Hz |
| 工具反馈 | >300ms 的工具 100ms 内出现进度/presence，无假死 >1s |

验收工具：DevPanel（`desktop.workbenchDevPanel`）+ `perfMonitor`（fps/droppedFrames/longTasks）。

---

## 8. 实现偏差（R3-05 终版勘误，不重写上文历史）

> 本节记录相对 §0–§7 冻结设计的**最终落地差异**。上文保留派发时原文；验收以本节 + `ERRORS.md` + `SCENARIOS.md` + `ACCEPTANCE.md` 为准。

### 8.1 协议与桥

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| `runId` | = `toolCallId` 贯穿 | R2-01：`ExecutionContext.tool_call_id` + `ctx.run_id()`；缺省回退 `block_id`。前端撤销用 `resolveWorkbenchRunId` 双候选（`toolCallId` / `block.id`） |
| Channel | §0.4 保留为 R2 升级选项 | R2-07 **书面否决暂不实施**；触发条件见 `progress/R2-07.md`（待 R3-02 实测复核） |
| `AcrReceipt` Rust 侧 | 强类型 | 仍用 `serde_json::Value`（P2） |
| 取消回落 | 未写死 | R2-01：**取消后禁止域执行器回落后端**，避免双写 |

### 8.2 权限与闸门

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| `desktop.workbenchAgentControl=off` | §6「双闸」偏笼统 | R2-08 / `ERRORS.md`：**list/query 只读允许**；写与导航拒 `WORKBENCH_DISABLED`。**未设置默认 `follow`（开箱可用）** |
| Feature flag `tools.workbench_agent` 关 | 与 setting 易混 | **硬闸**：含 list/query 全拒（与 setting `off` 不同）。键缺失时默认 Enabled；显式 Disabled 持久保留 |
| OS / control 热关 | 活跃 run 处理未细写 | abort 后保留 run/租约等待结算；15 秒超时收敛为 `partial/orphan`，迟到 finally 隔离 |

### 8.3 仲裁 / presence / 账本

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| `userPatch` | CollabDriver 契约内 | 旁路 `registerUserPatchSummarizer` + `withUserPatch`（未扩冻结 `types.ts`） |
| `disposeAllDrivers` | 隐含于 stop | R2-06：`stageManager.stop` 已调用 |
| 演出槽超限 | §4.3「同时演出 ≤2」 | 第 3 路 **直落终态**（不拒、不卡死），presence 标「演出槽满」 |
| 慢帧降级 | 连续帧 >33ms → fast | `perfMonitor` 连续 **3** 帧 >33ms → `forcePacerInstant` |
| 输入打断过滤 | 滚轮/标题栏不算 | R2-06：`inputProbe` + Strip `stopPropagation` |

### 8.4 各应用 Driver

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| 笔记破坏类 | dirty/hot → 建议 | **仅 dirty** 走 `AIDiffPanel`；**clean 窗** `note_replace`/`note_set` 直写 `setMarkdown`（R2-03 纠正） |
| 笔记 `hot` | probe hot → 暂停 | R3-01：`captureSelection` 非空 → probe `hot`；追加类 `waitWhileNoteHot` 暂停/续放（略宽于「仅目标节」） |
| 导图 dirty 破坏类 | §4.1 suggestion | **维持拒绝式** `suggestionPending`，无树 diff 预览（R2-02 定稿） |
| 导图视口 | 每 3–5 op | `VIEWPORT_FOLLOW_EVERY = 5`（R3-02）；结束一次 fitView（fast 不 fit） |
| exam `focusQuestion` | §5.4 | R2-10 已接线 `qbank:focus-question` |
| content `scrollToHeading` | note | note 真实现；textbook/file 用 `page`；translation/essay/image → `UNSUPPORTED_ACTION` |
| finder `reveal` | 揭示资源 | **自动进入父目录**（`getResourceLocation` + `enterFolder`）+ 选中 + flash；目标行不在可视区/当前页时回执 message 注明未定位。~~不自动进入父目录~~ 为文档漂移，勘误于 2026-07-19（ACR 4.0 A6） |
| ankiCardsBlock | 旧 workaround | R2-04 收编为 `activate(startReview)` |
| browser ControlMode | §5.5 | Rust 权威事件 + 前端 `controlModeSync` 镜像；agent navigate 不打接管闩锁 |

### 8.5 域事件与 OCC

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| `source` | `'agent'\|'user'` | Rust 工具路径仍多发 `"ai"`；前端 `normalizeDomainPayload` **`ai`→`agent`**（待全量改 emit 为 P1） |
| qbank OCC | 冲突码 | questions 表路径已有 `QBANK_CONFLICT`；**preview_json 回落无 OCC**（P1） |
| todo 用户侧写 | 域事件 | AI executor 已 emit；**用户侧 `todo_handlers` create 等仍可能不 emit**（P1） |

### 8.6 chat 呈现

| 项 | 设计原文 | 最终实现 |
|----|----------|----------|
| `workbench_ops` 持久化 | 前端 remap | R2-05：Rust 写 `block_type=workbench_ops` + 恢复 remap 兜底 |
| 域委托写工具块类型 | §3「域工具保持 `mcp_tool`」 | R3-01（S-REV-01）：产出前端 `AcrReceipt` 的 `note_*` / `mindmap_edit_nodes` 等亦 remap/持久化为 `workbench_ops`，否则撤销 chrome 不可达 |
| AgentTaskPanel 增列 | 未要求 | **书面否决**（专用工具卡 + AgentStrip 已够） |
| 账本跨进程 | 内存级 | 重启后撤销按钮 `undoExpired`（预期）；完成后 Strip presence 保留 **4s** 可撤（R3-01） |

### 8.7 R3 姐妹卡结论（协调者回填）

| 卡 | 结论钩子 |
|----|----------|
| R3-01 | `progress/R3-01.md`：39 PASS / 3 已修 / 5 运行时 BLOCKED |
| R3-02 | `PERF-REPORT.md`：审计 PASS；Channel 仍否决；运行时采样待 |
| R3-03 | `progress/R3-03.md`：时序/a11y/HAX |
| R3-04 | `progress/R3-04.md`：混沌×1000；apply 异常→failed |
| 统一验收 | `progress/R3-ACCEPTANCE.md` + 本文件配套的 `ACCEPTANCE.md` |
