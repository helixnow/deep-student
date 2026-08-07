# ACR 验收场景库（R1-20 · R3-05 终版小修）

> 本文是 R2/R3 的验收基准。工具名 / bridge command / onActivation action / AgentOp kind 均与 `DESIGN.md`（含 §8 实现偏差）+ `ROUND1.md` + 已落地 skill（`workbench-tools.ts` 等）对齐，**不凭空造接口**。
>
> 约定：
> - Workbench 工具 LLM 可见名：`builtin-workbench_*`（Rust strip 后短名 `workbench_*`）。
> - 域写入走既有领域工具；前端委托经桥 `probe` → `apply_ops`。
> - 回执字段以 DESIGN §2.2 `AcrReceipt` 为准。
> - chat 侧 workbench 工具卡块类型：`workbench_ops`。
> - 双闸：`tools.workbench_agent` + `desktop.workbenchAgentControl`（`off`/`background`/`follow`）；语义见 `ERRORS.md`（flag 硬闸 ≠ setting off 只读）。
> - pacing：`desktop.workbenchAgentPacing`（`fast`/`normal`/`demo`）。
> - 场景判定状态由 **R3-01** 回填（PASS / FAIL / BLOCKED）；本文件只定期望。
---

## 0. 工具与 action 速查（写作约束）

### 0.1 Workbench 工具（R1-02 / R1-08）

| LLM 名 | 桥 command | 敏感度 |
|--------|------------|--------|
| `builtin-workbench_list_windows` | `list_windows` | Low |
| `builtin-workbench_open_app` | `open_app` | Low |
| `builtin-workbench_app_command` | `app_command` | Medium |
| `builtin-workbench_close_window` | `close_window` | High |
| `builtin-workbench_query_state` | `query_state` | Low |

### 0.2 `app_command` / onActivation action（v1，与 R1-08 skill 描述一致）

| typeId | action | payload 要点 |
|--------|--------|--------------|
| `mindmap` | `focusNode` / `setView` | `{nodeId}` / `{view}` |
| `note` | `scrollToHeading` | `{heading, level?}`（ROUND1 R1-16 曾写 `scrollToAnchor`，以本表为准，见进度报告矛盾项） |
| `todo` | `showList` / `focusItem` | `{listId}` / `{itemId}` |
| `files` | `openFolder` / `reveal` | `{folderId}` / `{resourceId}` |
| `flashcards` | `startReview` | `{screen?, mode?, cardIds?}` 等 launch payload |
| `pomodoro` | `start` / `pause` / `resume` / `stop` | `{taskId?, taskTitle?}`（start） |
| `browser` | `navigate` / `focusAddress` / `takeOver` / `showContent` | `{url}` 等 |
| `chat` | `setInput` / `focusInput` / `scrollToMessage` | 既有 chat activate |
| `exam` | `focusQuestion`（R2-10 已接线 `qbank:focus-question`） | `{questionId}` |
| `textbook` / `file` | `scrollToHeading` 或 `page`（PDF 页锚） | `{heading?}` / `{page}` |
| `translation` / `essay` / `image` | `scrollToHeading` → **不支持** | 回执 `handled:false` + `UNSUPPORTED_ACTION` |

### 0.3 域工具（主路径写入）

| 域 | 代表工具 |
|----|----------|
| 笔记 | `builtin-note_append` / `builtin-note_replace` / `builtin-note_set` / `builtin-note_read` |
| 导图 | `builtin-mindmap_edit_nodes`（ops: `add_node`/`update_node`/`delete_node`/`move_node`）；`create`/`update` 不委托 |
| 用户待办 | `builtin-user_todo_create_item` / `builtin-user_todo_update_item` / `builtin-user_todo_complete_item` / `builtin-user_todo_list_*` |
| 题库 | `builtin-qbank_*`（写后 `qbank://changed`） |
| 闪卡 | `builtin-chatanki_*`（写后 `fsrs://changed`） |
| 浏览器 | `builtin-browser_open` / `navigate` / `click` / `type` / … |

### 0.4 委托 AgentOp kind

| 来源工具 | AgentOp.kind | destructive |
|----------|--------------|-------------|
| `note_append` | `note_insert` | false |
| `note_replace` | `note_replace` | true |
| `note_set` | `note_set` | true |
| `mindmap_edit_nodes` | 原 type（`add_node` 等） | delete/move 为 true |
| todo/finder 导航 | `todo_show_list` / `finder_open_folder`（driver 薄层） | false |
| pomodoro driver | `pomodoro_start` / `pomodoro_pause` / `pomodoro_resume` / `pomodoro_stop` | — |

---

## 1. 每应用主路径

### S-APP-NOTE-01 — 打开笔记并滚动到标题

| 项 | 内容 |
|----|------|
| **编号** | S-APP-NOTE-01 |
| **前置** | OS 模式开；双闸开（flag + `background`）；存在笔记资源 `N1`，正文含二级标题「引言」；笔记窗未开 |
| **chat 指令** | 「打开笔记 N1，滚到『引言』那一节」 |
| **期望工具链** | `builtin-workbench_list_windows` → `builtin-workbench_open_app`（`typeId=note`, `instanceKey=N1`）→ `builtin-workbench_app_command`（`typeId=note`, `action=scrollToHeading`, `payload={heading:'引言'}`） |
| **期望视觉** | 笔记窗出现/聚焦；视口滚到「引言」；无 AgentStrip（纯导航，无 apply_ops run） |
| **期望回执** | open_app：`{windowId, created:true|false}`；app_command：`{handled:true}` |
| **判定** | 窗可见且标题区可见「引言」；工具卡为 `workbench_ops`；无领域写工具 |

### S-APP-NOTE-02 — clean 窗追加正文（前端委托演出）

| 项 | 内容 |
|----|------|
| **编号** | S-APP-NOTE-02 |
| **前置** | 笔记 `N1` 已开窗、未 dirty、光标不在目标节；pacing=`normal` |
| **chat 指令** | 「在笔记末尾追加一段：ACR 验收段落 A」 |
| **期望工具链** | （可选 list）→ `builtin-note_append` → Rust `probe` → `apply_ops`（ops: `kind=note_insert`, `anchor={position:'end'}`, `destructive=false`） |
| **期望视觉** | 目标窗 `data-agent-active` 光环；AgentStrip「AI 正在操作」；AI 光标 + `agent-inserted` 高亮；词级打字机；chat 域工具卡 progress ≤5Hz |
| **期望回执** | `status=completed`, `mode=frontend`, `applied≥1`, `entityIds` 含笔记相关 id，message 含「前端」/「实时应用」类说明 |
| **判定** | 正文末出现追加文本；用户 Ctrl+Z **不能**撤掉该段（不进用户 undo）；presence 结束后光环熄灭 |

### S-APP-NOTE-03 — 关闭笔记窗后再追加（后端回落）

| 项 | 内容 |
|----|------|
| **编号** | S-APP-NOTE-03 |
| **前置** | 笔记 `N1` 无开窗（probe→`closed`） |
| **chat 指令** | 「给笔记 N1 末尾追加：后端回落段落」 |
| **期望工具链** | `builtin-note_append` → `probe`→closed → 后端写盘 + `dstu:change`/`DstuWatchEvent`；**不**走成功 `apply_ops` |
| **期望视觉** | 无窗口光环；若随后用户打开该笔记，应看到新内容 |
| **期望回执** | `mode=backend`（或 message 明确「未打开/已直接写入」）；成功 |
| **判定** | 重新打开笔记可见追加；message 非静默降级 |

### S-APP-MM-01 — 打开导图并聚焦节点

| 项 | 内容 |
|----|------|
| **编号** | S-APP-MM-01 |
| **前置** | 导图 `M1` 含节点 `node-root`；双闸开 |
| **chat 指令** | 「打开导图 M1，聚焦到根节点」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=mindmap`, `instanceKey=M1`）→ `builtin-workbench_app_command`（`action=focusNode`, `payload={nodeId:'node-root'}`） |
| **期望视觉** | 导图窗聚焦；相机跟随根节点 |
| **期望回执** | `{handled:true}` |
| **判定** | 根节点在视口内；无 `mindmap_edit_nodes` |

### S-APP-MM-02 — clean 导图批量加节点（委托演出）

| 项 | 内容 |
|----|------|
| **编号** | S-APP-MM-02 |
| **前置** | `M1` 开窗 clean；非 editing 目标节点 |
| **chat 指令** | 「在导图根下加三个子节点：甲、乙、丙」 |
| **期望工具链** | `builtin-mindmap_edit_nodes`（operations 含 3×`add_node`）→ `probe`→clean → `apply_ops`（kind=`add_node`） |
| **期望视觉** | 光环 + AgentStrip；每 op `setFocusedNodeId` + `agent-entering`；progress 逐步「添加节点…」；大纲同步 entering |
| **期望回执** | `status=completed`, `mode=frontend`, `applied=3`, `done` 含三步中文 label，`entityIds` 含新节点 id |
| **判定** | 画布出现三节点；账本可 revert；用户 undo 栈不被污染 |

### S-APP-MM-03 — 导图整份更新不委托

| 项 | 内容 |
|----|------|
| **编号** | S-APP-MM-03 |
| **前置** | `M1` 可开可关 |
| **chat 指令** | 「用整份内容覆盖更新导图 M1」（触发 `mindmap_update` 路径） |
| **期望工具链** | `builtin-mindmap_update`（或 create）→ **不**调用 `apply_ops`；后端路径 |
| **期望视觉** | 若窗开着，靠域事件/刷新更新，无逐 op 演出 |
| **期望回执** | 后端成功；无 frontend mode |
| **判定** | 与 ROUND1 R1-05「create/update 不委托」一致 |

### S-APP-TODO-01 — 打开待办清单并聚焦条目

| 项 | 内容 |
|----|------|
| **编号** | S-APP-TODO-01 |
| **前置** | 清单 `L1`、条目 `I1` 存在 |
| **chat 指令** | 「打开待办清单 L1，并选中条目 I1」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=todo`, `payload={todoListId:L1}`）→ `builtin-workbench_app_command`（`action=showList` 或等价 payload 已切清单后 `action=focusItem`, `payload={itemId:I1}`） |
| **期望视觉** | todo 窗；`focusItem` 后行 `data-agent-entity` flash |
| **期望回执** | open/command handled |
| **判定** | 活动清单为 L1；I1 选中且闪一下 |

### S-APP-TODO-02 — 创建待办 + 域事件 flash

| 项 | 内容 |
|----|------|
| **编号** | S-APP-TODO-02 |
| **前置** | todo 窗开着看 L1；双闸开 |
| **chat 指令** | 「在清单 L1 新建待办：写 ACR 场景库」 |
| **期望工具链** | `builtin-user_todo_create_item` → 后端写 → `todo://changed`（含 `entityIds`）→ 视图 reload + `agentFlash` |
| **期望视觉** | 新行出现并 flash；详情面板编辑中则延迟 reload |
| **期望回执** | 领域工具成功；payload 含新 item id |
| **判定** | 列表可见新项；DevPanel/日志可见 `entityIds` |

### S-APP-FILES-01 — 打开文件夹并揭示资源

| 项 | 内容 |
|----|------|
| **编号** | S-APP-FILES-01 |
| **前置** | 文件夹 `F1` 内有资源 `R1` |
| **chat 指令** | 「打开资料库文件夹 F1，并选中资源 R1」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=files`, `payload={folderId:F1}`）→ `builtin-workbench_app_command`（`action=reveal`, `payload={resourceId:R1}`）或先 `openFolder` 再 `reveal` |
| **期望视觉** | Finder 进入 F1；R1 选中 + flash |
| **期望回执** | `{handled:true}` |
| **判定** | 当前目录与选中 id 正确 |

### S-APP-FC-01 — 打开闪卡并开始复习

| 项 | 内容 |
|----|------|
| **编号** | S-APP-FC-01 |
| **前置** | 存在可复习卡片集合 `C[]` |
| **chat 指令** | 「打开闪卡，用这些卡片开始复习」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=flashcards`, `payload={screen,mode,cardIds}`）和/或 `builtin-workbench_app_command`（`action=startReview`, `payload=…`）→ onActivation `applyLaunchPayload` |
| **期望视觉** | flashcards 窗；进入复习 UI；当前卡稳定 |
| **期望回执** | handled / launch 成功 |
| **判定** | 进入 session；**未**错误调用会重置会话的 `startBatchSession` |

### S-APP-FC-02 — 复习中追加卡片（append-only）

| 项 | 内容 |
|----|------|
| **编号** | S-APP-FC-02 |
| **前置** | 复习 session 进行中；queueIndex=k；当前卡 K |
| **chat 指令** | 「再往复习队列加 2 张相关卡」（触发 chatanki/fsrs 写库） |
| **期望工具链** | 领域写卡工具 → `fsrs://changed` → driver `appendToQueue`（去重）+ toast「AI 添加了 N 张卡片」 |
| **期望视觉** | toast；当前卡 UI **不变**；队列变长 |
| **期望回执** | 写卡成功；事件含 `entityIds` |
| **判定** | queueIndex 仍为 k；当前卡仍为 K；已在 queue 的 id 不重复入队 |

### S-APP-EXAM-01 — 打开题库窗并刷新守卫

| 项 | 内容 |
|----|------|
| **编号** | S-APP-EXAM-01 |
| **前置** | exam 窗开着；用户正在答 `Q-cur`；行内编辑器关闭 |
| **chat 指令** | 「更新题库里某题干」（`builtin-qbank_update_question`） |
| **期望工具链** | `builtin-qbank_update_question` → `qbank://changed` → ExamContentView 刷新；守卫保持 `currentQuestionId` |
| **期望视觉** | 列表刷新；`entityIds` flash；答题中断不发生 |
| **期望回执** | 领域工具成功 |
| **判定** | 刷新后仍停在 `Q-cur`；对象引用替换不导致作答状态丢失 |

### S-APP-EXAM-02 — 聚焦题目

| 项 | 内容 |
|----|------|
| **编号** | S-APP-EXAM-02 |
| **前置** | exam 窗已开；题目 `Q2` 存在 |
| **chat 指令** | 「跳到题目 Q2」 |
| **期望工具链** | `builtin-workbench_app_command`（`typeId=exam`, `action=focusQuestion`, `payload={questionId:Q2}`） |
| **期望视觉** | 题目列表/内容滚到 Q2 + flash |
| **期望回执** | `{handled:true}`（R2-10 已接线）；失败时须可行动 hint，**不**假装成功 |
| **判定** | 与 DESIGN §5.4 / §8.4 对齐 |
### S-APP-POMO-01 — 番茄钟开始

| 项 | 内容 |
|----|------|
| **编号** | S-APP-POMO-01 |
| **前置** | 双闸开；番茄未运行 |
| **chat 指令** | 「开始番茄钟，任务叫写场景库」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=pomodoro`）→ `builtin-workbench_app_command`（`action=start`, `payload={taskTitle:'写场景库'}`）和/或 driver `pomodoro_start` |
| **期望视觉** | 番茄窗/投影出现；计时运行 |
| **期望回执** | `{handled:true}` 或 driver `completed` |
| **判定** | store 进入 running；任务标题可见 |

### S-APP-POMO-02 — 严格模式拒绝暂停

| 项 | 内容 |
|----|------|
| **编号** | S-APP-POMO-02 |
| **前置** | 番茄运行中且 `strictMode=true` |
| **chat 指令** | 「暂停番茄钟」 |
| **期望工具链** | `builtin-workbench_app_command`（`action=pause`）或 apply `pomodoro_pause` |
| **期望视觉** | 计时**不**停 |
| **期望回执** | `handled:false` 或 receipt `failed`/`undone`，message/JSON 含 `code:'STRICT_MODE'`, hint「严格模式下专注中不可暂停」 |
| **判定** | 与 R1-16 单测语义一致 |

### S-APP-BR-01 — 打开浏览器并导航

| 项 | 内容 |
|----|------|
| **编号** | S-APP-BR-01 |
| **前置** | 双闸开；browser agent 可用 |
| **chat 指令** | 「打开浏览器访问 https://example.com」 |
| **期望工具链** | `builtin-workbench_open_app`（`typeId=browser`, `payload={url}`）和/或 `builtin-browser_open` / `builtin-browser_navigate`；操作类工具前 `set_agent_control` |
| **期望视觉** | browser 窗；页面加载；Agent 控制态指示（既有 browser AgentBar） |
| **期望回执** | 导航成功 |
| **判定** | URL 正确；ControlMode 进入 Agent（非 User） |

### S-APP-CHAT-01 — 列表窗口与查询焦点

| 项 | 内容 |
|----|------|
| **编号** | S-APP-CHAT-01 |
| **前置** | 至少 2 个窗；其一 dirty |
| **chat 指令** | 「现在桌面有哪些窗口？焦点在哪？」 |
| **期望工具链** | `builtin-workbench_list_windows` →（可选）`builtin-workbench_query_state`（`scope=focused`） |
| **期望视觉** | 无演出；`workbench_ops` 卡展示摘要 |
| **期望回执** | `windows[]` 含 typeId/title/lifecycle/focused/dirty；focused 与 query 一致 |
| **判定** | dirty 标志正确；只读无副作用 |

### S-APP-CHAT-02 — 关闭窗口（High 审批）

| 项 | 内容 |
|----|------|
| **编号** | S-APP-CHAT-02 |
| **前置** | 存在可关窗 `W`；非唯一强制窗 |
| **chat 指令** | 「关掉窗口 W」 |
| **期望工具链** | `builtin-workbench_list_windows` → `builtin-workbench_close_window`（`windowId=W`）→ 用户审批通过 |
| **期望视觉** | 审批前应能看见审批 UI（必要时先 focus chat 窗）；通过后窗关闭 |
| **期望回执** | `{closed:true}`；拒绝 canClose 时 `closed:false` |
| **判定** | High 敏感度走审批；脏窗被 canClose 拦截时不丢数据 |

---

## 2. 跨应用编排（≥3）

### S-XAPP-01 — 笔记要点 → 闪卡 → 开始复习

| 项 | 内容 |
|----|------|
| **编号** | S-XAPP-01 |
| **前置** | 笔记 `N1` 开窗 clean；有可提炼要点；双闸 `follow` |
| **chat 指令** | 「把这篇笔记的要点做成闪卡并开始复习」 |
| **期望工具链** | `builtin-note_read`（或已有上下文）→ `builtin-chatanki_*`（制卡）→ `fsrs://changed` → `builtin-workbench_open_app`/`app_command`（`flashcards` + `startReview`） |
| **期望视觉** | 可选笔记侧只读；闪卡窗打开并进入复习；follow 档自动聚焦闪卡窗 |
| **期望回执** | 制卡成功 + startReview handled；跨工具 runId 各自独立 |
| **判定** | 新卡可复习；复习 session 启动；不重置无关会话 |

### S-XAPP-02 — 导图节点 → 待办清单

| 项 | 内容 |
|----|------|
| **编号** | S-XAPP-02 |
| **前置** | 导图 `M1` 开；todo 清单 `L1` 存在 |
| **chat 指令** | 「把导图里『甲、乙、丙』三个节点做成待办，放到清单 L1，并打开待办选中第一项」 |
| **期望工具链** | （可选 mindmap 读/已有）→ 3×`builtin-user_todo_create_item` → `todo://changed` → `builtin-workbench_open_app`（todo）→ `app_command` `showList`/`focusItem` |
| **期望视觉** | todo 列表出现三项并 flash；聚焦第一项 |
| **期望回执** | 三项创建成功 + 导航 handled |
| **判定** | 清单内容与节点标题对应；导航落在正确 list/item |

### S-XAPP-03 — 笔记追加 + 番茄钟专注

| 项 | 内容 |
|----|------|
| **编号** | S-XAPP-03 |
| **前置** | 笔记开窗 clean；番茄空闲 |
| **chat 指令** | 「在笔记末尾写『开始专注』，然后开始 25 分钟番茄」 |
| **期望工具链** | `builtin-note_append`→`apply_ops`/`note_insert` → `builtin-workbench_app_command`（pomodoro `start`） |
| **期望视觉** | 笔记打字机演出结束后（或并行策略下租约不冲突）；番茄启动；同时演出窗 ≤2 |
| **期望回执** | note `completed`+frontend；pomo handled |
| **判定** | 正文含「开始专注」；番茄 running；无 `WINDOW_BUSY` 误伤不同 windowId |

### S-XAPP-04 — 资料库揭示 + 浏览器查阅

| 项 | 内容 |
|----|------|
| **编号** | S-XAPP-04 |
| **前置** | 资源 `R1` 在 `F1`；可外链查阅 |
| **chat 指令** | 「在资料库里找到 R1，并打开浏览器查一下相关资料 example.com」 |
| **期望工具链** | `open_app`/`app_command`（files `reveal`）→ `open_app`/`browser_navigate`（browser） |
| **期望视觉** | Finder 选中 R1；browser 加载 URL |
| **期望回执** | 两路均成功 |
| **判定** | 两窗最终均存在；焦点策略符合 follow/background |

---

## 3. 仲裁（暂停 / 续放 / 停止）

### S-ARB-01 — 演出中打字 → 暂停 → 2s 后续放

| 项 | 内容 |
|----|------|
| **编号** | S-ARB-01 |
| **前置** | 笔记长文 `note_append` 演出中（normal pacing）；目标窗聚焦 |
| **chat 指令** | （已在跑）用户在笔记内容区键入若干字符，然后停手 ≥2s |
| **期望工具链** | 进行中的 `apply_ops`；`notifyUserInput(windowId)` → pausedByUser → 2s 无输入且锚点可 resolve → resume |
| **期望视觉** | 光环转琥珀 `data-agent-paused`；AgentStrip 显示暂停；progress「已暂停」；续放后恢复主题色光环与打字机 |
| **期望回执** | 最终 `completed`（若未点停止）；`done` 覆盖全部批次 |
| **判定** | 暂停期间无新插入；续放后内容连续无双写；滚轮/点标题栏**不**触发暂停 |

### S-ARB-02 — 暂停后点停止 → partial + userPatch

| 项 | 内容 |
|----|------|
| **编号** | S-ARB-02 |
| **前置** | 同 S-ARB-01，已 pausedByUser；用户点 AgentStrip「停止」或持续输入至 15s 超时 |
| **期望工具链** | run abort → 桥回执 partial |
| **期望视觉** | 光环熄灭；工具卡展示 done/undone 两列 |
| **期望回执** | `status=partial`, `done[]`/`undone[]` 非空，`userPatch?` 有用户修改摘要（若可采集） |
| **判定** | LLM 可见 partial（禁止静默成功）；已插入部分保留；未执行步在 undone |

### S-ARB-03 — 同窗租约互斥 WINDOW_BUSY

| 项 | 内容 |
|----|------|
| **编号** | S-ARB-03 |
| **前置** | 同一 mindmap 窗已有 acting run |
| **chat 指令** | 第二条指令再对该窗 `mindmap_edit_nodes` |
| **期望工具链** | 第二次 `apply_ops` 被 StageManager 拒绝 |
| **期望视觉** | 仅第一 run 光环 |
| **期望回执** | 错误码 `WINDOW_BUSY`（或等价可行动错误）；hint 勿重试盲写 |
| **判定** | 无双写；第一 run 不受影响 |

---

## 4. 取消

### S-CAN-01 — chat 停止按钮中断 apply_ops

| 项 | 内容 |
|----|------|
| **编号** | S-CAN-01 |
| **前置** | 导图多 op 演出中 |
| **chat 指令** | （运行中）用户点 chat 停止 |
| **期望工具链** | Rust `cancellation_token` → emit `acr:bridge-cancel` → StageManager abort run |
| **期望回执** | `status=cancelled` 或 `partial`，必带 `done`/`undone`；工具卡 `onAbort:keep-content` |
| **期望视觉** | 光环立即；已应用节点保留；未应用不出现 |
| **判定** | 100ms 内出现取消反馈；无假死 >1s；LLM 不因静默而重试双写 |

### S-CAN-02 — 取消传播后桥层清理

| 项 | 内容 |
|----|------|
| **编号** | S-CAN-02 |
| **前置** | 同 S-CAN-01 |
| **chat 指令** | —（观测） |
| **期望工具链** | `acr_bridge_call` 返回 `Err("cancelled")` 或结构化取消；ListenerGuard 卸载 |
| **期望视觉** | presence 清除（TTL 内心跳停止） |
| **期望回执** | 与 S-CAN-01 一致 |
| **判定** | 无泄漏监听；随后新工具可正常跑 |

---

## 5. 降级

### S-DEG-01 — OS / workbenchBus 关闭

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-01 |
| **前置** | workbenchBus disabled / 非 OS 模式 |
| **chat 指令** | 「打开笔记 N1」 |
| **期望工具链** | `builtin-workbench_open_app` → 失败 |
| **期望回执** | `WORKBENCH_DISABLED`（或 `WORKBENCH_UNAVAILABLE`）+ hint：改用领域工具；`retryable` 合理 |
| **判定** | LLM 指引不重试导航；改 `note_*` 可写数据 |

### S-DEG-02 — 闸门 off / flag 关

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-02 |
| **前置** | 分两案：A）`desktop.workbenchAgentControl=off`（flag 开）；B）flag `tools.workbench_agent` 关 |
| **chat 指令** | A：「列出桌面窗口」再「打开笔记」；B：同左 |
| **期望工具链** | A：`list_windows`/`query_state` **允许**；`open_app` → `WORKBENCH_DISABLED`。B：含 list/query **全拒** → `WORKBENCH_DISABLED`（硬闸） |
| **期望回执** | 结构化错误；hint 指向开启设置/flag（见 `ERRORS.md`） |
| **判定** | 两案语义不同；设置面三态与 flag 独立可测 |
### S-DEG-03 — 窗口 frozen

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-03 |
| **前置** | 笔记窗 lifecycle=`frozen`；control=`background` |
| **chat 指令** | 「给该笔记追加一段」 |
| **期望工具链** | `note_append` → probe=`frozen` → **后端回落**（background）；follow 档可先 focus 再委托（若已实现） |
| **期望视觉** | background：无演出；数据已写 |
| **期望回执** | `mode=backend` + message 说明 frozen/回落 |
| **判定** | 非静默；follow 未实现时不得假称 frontend |

### S-DEG-04 — 资源不存在

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-04 |
| **前置** | 无笔记 id `N-missing` |
| **chat 指令** | 「打开笔记 N-missing 并追加文字」 |
| **期望工具链** | open_app 和/或 note_append 失败 |
| **期望回执** | 可行动错误（资源不存在）；非空 hint |
| **判定** | 不创建空壳脏数据；不重试死循环 |

### S-DEG-05 — 桥未挂载 / 超时

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-05 |
| **前置** | AgentBridge 未挂或人为阻塞响应 |
| **chat 指令** | 「列出窗口」 |
| **期望工具链** | `acr_bridge_call` 超时/未挂载 |
| **期望回执** | `WORKBENCH_UNAVAILABLE` + hint「桌面模式未开启或未就绪，导航类操作不可用；数据修改请改用对应领域工具」 |
| **判定** | 与 R1-02 文案一致；doom-loop 防护生效 |

### S-DEG-06 — mindmap 锚点失效单 op undone

| 项 | 内容 |
|----|------|
| **编号** | S-DEG-06 |
| **前置** | 导图开窗；ops 含不存在 `node_id` |
| **chat 指令** | 「给不存在的节点改标题」 |
| **期望工具链** | `mindmap_edit_nodes` → `apply_ops`；坏锚点 op → undone + progress 说明 |
| **期望回执** | `partial` 或 `completed` 且 `undone` 含该步；其余有效 op 可 applied |
| **判定** | 不整批静默失败；progress 有说明 |

---

## 6. 建议模式

### S-SUG-01 — dirty 笔记 replace → AIDiffPanel accept

| 项 | 内容 |
|----|------|
| **编号** | S-SUG-01 |
| **前置** | 笔记开窗 **dirty**；用户有未保存编辑 |
| **chat 指令** | 「把某段替换成新文案」（`builtin-note_replace`） |
| **期望工具链** | probe=`dirty` → driver 派发 `canvas:ai-edit-request` → **立即**回执；用户在 AIDiffPanel **Accept** → setMarkdown+保存 |
| **期望视觉** | AIDiffPanel 出现；无直接破坏性打字机覆盖 |
| **期望回执** | `status=completed`（或等价）, `mode=suggestion`, `suggestionPending=true`，message 告知用户稍后确认；**不**阻塞 tool_loop |
| **判定** | Accept 后正文为新文案且 dirty 处理符合既有保存链路 |

### S-SUG-02 — dirty 笔记 replace → reject

| 项 | 内容 |
|----|------|
| **编号** | S-SUG-02 |
| **前置** | 同 S-SUG-01 |
| **chat 指令** | 同 S-SUG-01；用户 **Reject** |
| **期望工具链** | 同建议提交；Reject 不写盘 |
| **期望视觉** | Panel 关闭；用户未保存编辑保留 |
| **期望回执** | 工具侧已返回 suggestionPending；Reject 后文档保持 reject 前状态 |
| **判定** | 无静默覆盖；用户编辑不丢 |

### S-SUG-03 — dirty/hot 导图破坏性 op → 拒绝建议（v1）

| 项 | 内容 |
|----|------|
| **编号** | S-SUG-03 |
| **前置** | 导图 dirty 或 `editingNodeId` 命中目标（hot） |
| **chat 指令** | 「删除节点 X」（destructive） |
| **期望工具链** | `mindmap_edit_nodes` → probe dirty/hot → **不改文档**；回执 suggestionPending + message「存在未保存编辑…」（v1 无 diff 预览） |
| **期望视觉** | 无节点删除演出 |
| **期望回执** | `mode=suggestion`, `suggestionPending=true`，说明等待空闲或改后端路径 |
| **判定** | 与 R1-11 v1 简化一致；R2-02 再评估 diff |

### S-SUG-04 — hot 笔记追加 → 暂停等待

| 项 | 内容 |
|----|------|
| **编号** | S-SUG-04 |
| **前置** | 用户在目标笔记窗内容区持续输入（仲裁 pausedByUser）；追加类 op 进行中或即将续放 |
| **chat 指令** | 「在当前这一节后面追加一句」 |
| **期望工具链** | `note_append` → 编辑器真实 `hasFocus()` 时 probe=`hot` 或演出中 `notifyUserInput` → 暂停；失焦后恢复。历史 selection 不得单独判 hot |
| **期望视觉** | 琥珀暂停或等待；用户切换焦点，或演出中停止输入 ≥2s 且锚点可 resolve 后续放 |
| **期望回执** | 最终 completed 或因超时/停止 partial |
| **判定** | 不与用户光标争抢破坏性覆盖；与 S-ARB-01 同源机制 |
---

## 7. 撤销

### S-REV-01 — workbench_ops / 域工具卡撤销按钮

| 项 | 内容 |
|----|------|
| **编号** | S-REV-01 |
| **前置** | S-APP-NOTE-02 或 S-APP-MM-02 刚完成；账本有 invert |
| **chat 指令** | （UI）点工具卡「撤销」→ `stageManager.revertRun(toolCallId)` |
| **期望工具链** | 桥可选 `revert_run`；ledger 逆序执行 invert |
| **期望视觉** | 插入消失/节点删除回滚；按钮置灰 |
| **期望回执** | `{reverted:true}`；二次点击无效 |
| **判定** | 数据回到 run 前；runId=toolCallId |

### S-REV-02 — AgentStrip 撤销

| 项 | 内容 |
|----|------|
| **编号** | S-REV-02 |
| **前置** | run 刚 done，Strip 仍可点撤销（或完成后短时） |
| **chat 指令** | （UI）AgentStrip「撤销」 |
| **期望工具链** | 同 `revertRun` |
| **期望视觉** | 光环/Strip 清理；内容回滚 |
| **期望回执** | reverted true |
| **判定** | 与 S-REV-01 数据一致 |

### S-REV-03 — 账本 LRU 容量

| 项 | 内容 |
|----|------|
| **编号** | S-REV-03 |
| **前置** | 连续 >20 个可 revert run |
| **chat 指令** | 尝试撤销最早的 run |
| **期望工具链** | ledger 容量 20 LRU |
| **期望回执** | 最早 run `reverted:false` 或不可用 |
| **判定** | 最近 20 个仍可撤；与 DESIGN R1-06 一致 |

---

## 8. 性能（对照 DESIGN §7）

### S-PERF-01 — 双窗并发演出上限

| 项 | 内容 |
|----|------|
| **编号** | S-PERF-01 |
| **前置** | DevPanel 开（`desktop.workbenchDevPanel`）；两笔记/导图窗可见；pacing normal |
| **chat 指令** | 同时对窗 A、B 发起长演出；再尝试第三窗 |
| **期望工具链** | 两路 `apply_ops` 占演出槽；第三路 **直落终态**（`forcePacerInstant`，非拒绝卡死；DESIGN §8.3） |
| **期望视觉** | ≤2 窗有呼吸光环；第三路可无完整演出；DevPanel 活跃 staging ≤2 |
| **期望回执** | 第三路仍 completed（或明确直落说明），非卡死 |
| **判定** | DevPanel：活跃 run 数、presence 列表、最近回执；无 >1s 假死 |
### S-PERF-02 — progress ≤5Hz 与 INP

| 项 | 内容 |
|----|------|
| **编号** | S-PERF-02 |
| **前置** | 长笔记打字机；perfMonitor 开 |
| **chat 指令** | 长文 append；演出中用户在**非目标**窗点击 |
| **期望工具链** | progress 尾随合并 ≤5Hz；单消息 <8KB |
| **期望视觉** | 打字机词级批 8–40 字；动画仅 transform/opacity |
| **期望回执** | completed |
| **判定** | p75 INP ≤200ms；掉帧率 <5%；连续长任务 >33ms 触发自动降 fast（若实现） |

### S-PERF-03 — background 直落终态

| 项 | 内容 |
|----|------|
| **编号** | S-PERF-03 |
| **前置** | `agentControl=background`；目标窗未聚焦 |
| **chat 指令** | 「给后台笔记追加一段」 |
| **期望工具链** | 委托或直落；**不**抢焦点 |
| **期望视觉** | 无完整打字机或仅 Dock 角标；直落终态 + 可选 flash |
| **期望回执** | completed；mode 注明 |
| **判定** | 焦点窗不变；内容已写入 |

### S-PERF-04 — reduced-motion / pacing=fast

| 项 | 内容 |
|----|------|
| **编号** | S-PERF-04 |
| **前置** | OS `prefers-reduced-motion` 或设置 pacing=`fast` |
| **chat 指令** | 导图加多节点 / 笔记追加 |
| **期望工具链** | pacer 强制 fast |
| **期望视觉** | 直落终态；静态描边；保留 flash |
| **期望回执** | completed，耗时显著低于 normal |
| **判定** | 无呼吸动画；功能正确 |

---

## 9. 覆盖矩阵（自检）

| 类别 | 场景编号 | 条数 |
|------|----------|------|
| 每应用主路径 | S-APP-NOTE-01..03, MM-01..03, TODO-01..02, FILES-01, FC-01..02, EXAM-01..02, POMO-01..02, BR-01, CHAT-01..02 | 18 |
| 跨应用 | S-XAPP-01..04 | 4 |
| 仲裁 | S-ARB-01..03 | 3 |
| 取消 | S-CAN-01..02 | 2 |
| 降级 | S-DEG-01..06 | 6 |
| 建议模式 | S-SUG-01..04 | 4 |
| 撤销 | S-REV-01..03 | 3 |
| 性能 | S-PERF-01..04 | 4 |
| **合计** | | **44** |

---

## 10. 冒烟抽检建议（协调者）

R1 结束抽 5 条：`S-APP-NOTE-02`、`S-APP-MM-02`、`S-ARB-01`、`S-DEG-02`、`S-SUG-01`。  
R3 终验抽 10 条：上列 + `S-XAPP-01`、`S-CAN-01`、`S-REV-01`、`S-PERF-01`、`S-DEG-01`。

## 11. 终版一致性注记（R3-05）

| 主题 | 终版口径 |
|------|----------|
| S-DEG-02 | setting `off` 允许 list/query；flag 关全拒 |
| S-APP-EXAM-02 | R2-10 已接线，期望 `handled:true` |
| S-SUG-03 | 导图 dirty 破坏类维持拒绝式 suggestion（无预览） |
| S-SUG-04 | 依赖仲裁暂停；note 仅在编辑器真实持焦时 probe=`hot`，历史 selection 不算 hot |
| S-PERF-01 | 第 3 路直落，不拒 |
| 域事件 source | 场景叙述用 `agent`；Rust 可能仍发 `ai`（前端归一） |
| 判定勾选 | → `ACCEPTANCE.md` + R3-01 报告 |
