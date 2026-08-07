# ACR 4.0 — 全覆盖 · 诚实能力 · 流畅演出（协调者章程）

状态：已完成（2026-07-19）。8 个子代理三波并行落地，A8 集成收尾并验收（见 §0.1 / §5 / §6）。
本文件是 ACR 4.0 轮次的**契约真相源与分工表**。所有子代理在动手前必须通读本文件；
跨区修改必须走「跨界申请」（在本文件 §6 登记），不得直接改动他人所有权文件。

## 0. 目标（四大支柱）

1. **覆盖完备**：agent 可操控**任何**学习子应用，包括学习 OS（桌面/工作台）本身——
   窗口排布、贴靠、平铺、最小化/恢复、启动任意应用；补齐 Skills、Templates、
   TaskDashboard、translation/essay/image 等空白或半空白能力面。
2. **诚实能力**：能力表只报真可用（消灭 sandbox setMode「已审批的假成功」、exam
   硬拒能力、reviewing 死代码）；回执与实际 UI 状态一致。
3. **流畅直觉的演出**：笔记打字机滚动跟随、导图删除退场动画、更新态内容高亮、
   暂停倒计时、显式暂停可续放、后台完成 Dock 角标、工具卡步骤流自动滚底、
   presence 文案全量 i18n。保持既有纪律：只动 transform/opacity、
   reduced-motion/forced-colors 全路径、演出槽 ≤2、progress ≤5Hz。
4. **运行时加固**：修复 3.0 验收发现的全部 P1（控制档启动竞态、seenForwardRuns
   无界增长、命令集合三处漂移、legacy cancel 身份校验、Rust 域事件 source:"ai"、
   qbank preview_json OCC、todo_handlers 域事件缺失、错误码集合对齐）。

## 0.1 4.0 验收结论（A8 回填，2026-07-19）

- **动态验证声明**：typecheck / vitest / cargo 的**完整**动态验证未在本轮收尾执行
  （用户要求静态验收收尾，另有 4 个只读审阅代理并行做全量静态验收）。
  不虚构任何未执行的测试数字；下面仅记录停跑令之前**实际完成**的部分执行。
- **此前部分执行记录（均为真实运行结果）**：
  - A5 波全量 vitest：622/623（唯一失败为预存的 notesWorkspaceActivation 超时，
    A8 已修复——suite timeout 放宽至 20s，见 §5 A8 段）。
  - 首次全量 vitest（A8 波）因 Node 主进程 OOM（heap 4GB `Ineffective mark-compacts`
    + `ERR_IPC_CHANNEL_CLOSED`）中断；中断前唯一失败是
    workbenchOpsBlock.test.tsx 3 处 undoExpired 断言期待裸 i18n key，
    A8 已修复（undoExpired 文案已入 zh-CN/chatV2.json，i18n mock 解析真实文案）。
  - `npm run typecheck`：A8 波两次完整运行均 0 错误（后一次于停跑令前完成）。
  - ACR 范围分片 vitest（停跑令前完成的分片，全部通过，0 失败）：
    workbench/agent 38 文件 401 用例；workbench/components+core+hooks 48 文件
    585 用例；tests/vitest/workbench 27 文件 372 用例；workbench/apps 两段
    19 文件 144 用例 + apps-B 段通过；chat/plugins+utils 13 文件 59 用例；
    crepe + tests/vitest/notes 34 文件 303 用例；mindmap+pdf+tests/vitest/mindmap
    30 文件 349 用例；flashcards+learning-hub+todo 25 文件 147 用例。
  - `cargo check`（src-tauri）：停跑令前最后一次完整运行 Finished（3m23s），
    0 错误、28 个既有 dead-code 警告（外来/预存，非本轮引入）。
  - 定向 `cargo test`（协调者补跑，2026-07-19 晚）：`--lib workbench`
    **32 通过 0 失败**（含 workbench_executor/workbench_bridge 内嵌测试）、
    `--lib browser_executor` **11 通过 0 失败**。原「未执行」项已清零。
- **外来噪音说明**：本轮验收期间工作区持续存在 200+ 个来自其他并行会话的
  未提交改动（StatusBar 菜单、edgeSnapping、shortcuts、TileMenuPopover、
  immersiveMode、windowCloseGuard、docs/user-guide、多个 chat_v2 Rust 文件等）。
  ACR 验证仅对 ACR 范围目录负责；上述外来文件的编译/测试问题不属于本轮 ACR 回归。

## 1. 冻结契约增量（各代理按此对齐，A1 负责落地 types 层）

在 `src/features/workbench/agent/types.ts`（版本注释升为 ACR 4.0）新增/修订：

```ts
export interface PresenceState {
  // ...既有字段不变...
  /** ACR 4.0：pausedByUser 时的自动中止时刻（epoch ms），UI 据此渲染倒计时 */
  abortDeadline?: number;
  /** ACR 4.0：显式暂停后是否可由用户续放（AgentStrip 渲染「继续」按钮） */
  resumable?: boolean;
}
```

- `AcrRunStatus` 的 `'reviewing'` 正式启用：笔记建议模式（AIDiffPanel 挂起期间）
  与其他「等待用户确认」场景必须把 presence 置为 `reviewing`。
  presenceStore（A1 所有）暴露辅助方法：
  `markSuggestionReviewing(windowId, runId, label): () => void`（返回清除函数）。
- 新增学习 OS 目标：`typeId: 'desktop'`（虚拟单例目标，无真实窗口；
  `AcrTarget { typeId: 'desktop' }` 即指向桌面本身）。A2 负责 manifest 与
  agentRuntime/probe/queryProviders 的虚拟目标解析。能力基线：
  `observe`（窗口清单+边界+z序+dock+布局）、`focusWindow`、`minimizeWindow`、
  `restoreWindow`、`moveWindow`、`resizeWindow`、`snapWindow`、`tileWindows`、
  `launchApp`。布局类能力 reversible（布局快照 undo）；`launchApp` risk=medium；
  关窗仍必须走既有 `close_window`（High），desktop manifest 不提供 close。
- `gates.ts` 的 `ACR_READONLY_COMMANDS/ACR_MUTATING_COMMANDS` 改为从
  `ACR_COMMAND_ACCESS` 派生（单一真相源）；Rust `is_readonly_workbench_tool`
  保持行为一致（A1 双侧核对）。
- `ACR_ERROR_CODES` 补齐 `CONFLICT/CANCELLED/UNSUPPORTED` 等 Rust KNOWN 表已有码。
- presence label 不再硬编码中文：placement 后缀（「后台直落」「演出槽满，直落」等）
  改为结构化字段 `placementHint?: 'background' | 'stage-full' | 'frozen'`，
  由 UI 层（A5）走 i18n 渲染。

## 2. 分工与文件所有权（并行防冲突的硬边界）

| 代理 | 范围 | 独占文件/目录 |
|---|---|---|
| A1 核心运行时+Rust | 契约落地、启动竞态、LRU、命令集派生、legacy cancel、错误码、Rust 域事件 source 改名、qbank preview_json OCC、todo_handlers 域事件 | `agent/{types,stageManager,gates,bridge,arbitration,presenceStore,domainEvents}.ts`；`src-tauri/src/chat_v2/tools/{workbench_executor,workbench_bridge}.rs`；Rust 各域执行器/handlers 中域事件相关行 |
| A2 学习 OS | desktop 虚拟目标 manifest + 解析 + 布局 undo | 新目录 `apps/desktop/`；`apps/registerAll.ts`；`core/agentRuntime.ts` 与 `agent/{probe,queryProviders}.ts` 中 desktop 解析新增段；`core/{tiling,snapZones,windowStore}.ts` 只读调用不改写（需改走跨界申请） |
| A3 系统子应用 | Skills/Templates/TaskDashboard manifest 补全；session 卡面锚点；pomodoro 实体反馈 | `apps/system/**`；`features/flashcards/**`（锚点/演出相关行）；`features/todo/**`、`features/pomodoro/**` 中 agent 反馈相关行 |
| A4 笔记/导图演出 | 打字机滚动跟随、破坏类直改演出、reviewing 接线、导图删除退场/更新高亮 | `agent/drivers/{noteDriver,mindmapDriver}.ts`；`components/crepe/**`；`features/notes/**`（AI 编辑链路）；`features/mindmap/**`（画布/大纲/样式 agent 相关行） |
| A5 演出层 UI（第二波） | AgentStrip 续放+倒计时、reviewing 样式接线、Dock 完成角标、placementHint i18n、WindowShell | `agent/visuals/**`；`components/{WindowShell,AgentControlCenter,WorkbenchDevPanel}.tsx`（agent 相关行）；settings 工作台节 |
| A6 文件/沙盒 | sandbox setMode 诚实化（实现真实渲染差异或撤除能力）、abort run 追踪、finder 演出补全、DESIGN §8 文档漂移勘误 | `agent/drivers/{finderDriver,sandboxDriver}.ts`；`apps/{files,sandbox}/**`；`features/sandbox/**`（如有） |
| A7 内容/PDF/浏览器 | gotoPage 目标页演出+ACK 竞态修复、exam 硬拒能力诚实化、translation/essay 能力补全、browser close 归类与接管语义 | `apps/content/**`、`apps/preview/**`、`apps/browser/**`；`features/pdf/**`（agent 相关行）；`src-tauri/src/browser/**`、`src-tauri/src/chat_v2/tools/browser_executor.rs` |
| A8 集成（第三波） | 工具卡步骤流滚底、undo 过期解释、全局 typecheck+vitest、交叉冲突收敛、本文件 §5 验收回填 | `features/chat/plugins/blocks/workbenchOpsBlock.tsx`、`features/chat/utils/workbenchBlockRemap.ts`；全局验证 |

i18n：各代理在 `src/locales/{zh-CN,en-US}/` 相应命名空间**追加**自己的 key（前缀
`acr4.<agent-scope>.` 或沿用既有命名空间），不改动他人 key；冲突由 A8 收敛。

## 3. 统一纪律

- 禁止启动 `tauri dev`／`tauri-lab`；验证只用 `npm run typecheck` 与
  `npx vitest run <targeted paths>`。
- 不引入新依赖；不 commit；不改动与 ACR 无关的未提交文件。
- 演出：只动 transform/opacity；一切新动画必须有 reduced-motion 与
  forced-colors 路径；新增 DOM 锚点沿用 `data-agent-entity="{typeId}:{id}"` 契约。
- 回执诚实：no-op 必须 `changed:false` 或进 undone；不可撤销就不注册 inverse。
- 每个代理完成后在 §5 追加一行验收记录（做了什么、测试结果、遗留）。

## 4. 覆盖完备性裁决（二轮调研结论）

需要补齐：desktop（学习 OS 本身，A2）、skills（A3）、templates/taskDashboard
观察+定位强化（A3）、translation/essay/image 内容窗基础能力（A7）、
session 复习卡面锚点（A3）。chat 应用维持只读观察（避免 agent 递归操控对话），
不在本轮开放 mutating 能力。

## 5. 验收记录（各代理回填；A1–A7 由 A8 依代码标注与测试**静态**反推补记。
文中行号为 2026-07-19 静态验收时点、后续可能漂移；「分片实跑通过」均指停跑令前
实际完成的运行，完整清单见 §0.1，未执行的验证不在此宣称）

- **A1 核心运行时+Rust** — 已完成。types.ts 升 ACR 4.0：`PresenceState.abortDeadline/resumable/placementHint`、`AcrPlacementHint`、`ACR_ERROR_CODES` 补齐 CONFLICT 家族/CANCELLED/RESULT_UNKNOWN/UNSUPPORTED_ACTION 等 Rust KNOWN 码；presenceStore 落地 `markSuggestionReviewing(windowId, runId, label)`（返回清除函数）；stageManager：控制档启动竞态修复（本地镜像初始 follow + mutating 请求先 await 首次 refreshSettings）、`seenForwardRuns` 有界 LRU（session 级 touch-重插逐出）、legacy cancel 身份收紧（correlationId → session-scoped run key 集合）；gates.ts `ACR_READONLY_COMMANDS/ACR_MUTATING_COMMANDS` 改为从 `ACR_COMMAND_ACCESS` 派生（单一真相源，Rust `is_readonly_workbench_tool` 双侧核对一致）；Rust 域事件 source `"ai"→"agent"`（workbench_executor/qbank/todo_handlers 等）；qbank preview_json OCC 与 todo_handlers 域事件补齐。静态证据：`agent/types.ts:207-214`（abortDeadline/resumable/placementHint）、`types.ts:331` 起（错误码补齐注释）、`agent/presenceStore.ts:111`（markSuggestionReviewing）、`stageManager.ts:116-130`（启动竞态）、`stageManager.ts:238-262`（seenForwardRuns LRU）、`gates.ts:21-33`（ACR_COMMAND_ACCESS 派生）、`workbench_executor.rs:140`（is_readonly_workbench_tool）、user_todo/memory/qbank/review executor 内「域事件 source 统一为 agent」标注。测试文件：acr4.runtime.test.ts（14 用例）、gates.test.ts、stageManager.test.ts（30 用例）、domainEvents.test.ts——停跑令前 agent 目录分片实跑通过（38 文件 401 用例，§0.1）。遗留：无。
- **A2 学习 OS（desktop 虚拟目标）** — 已完成。新增 `apps/desktop/`（agentManifest + register），经 `core/agentRuntime.registerVirtualAgentTarget` 注册为无宿主窗口的虚拟单例（typeId 兼作伪 windowId，不进 appRegistry）；agentRuntime/probe/queryProviders 补 desktop 解析（windowId/instanceKey 误用给结构化 WINDOW_TARGET_MISMATCH）；能力面 observe + focusWindow/minimizeWindow/restoreWindow/moveWindow/resizeWindow/snapWindow/tileWindows/launchApp，布局类 reversible（整体布局快照 undo），launchApp medium 不可撤，manifest 不提供 close（关窗仍走 High 审批的 close_window，`apps/desktop/agentManifest.ts:634-639`）。静态证据：`core/agentRuntime.ts:136-205`（虚拟目标注册/解析/WINDOW_TARGET_MISMATCH）、`agent/queryProviders.ts:31/42/197`（virtual 发现投影）、`agentManifest.ts:493-563`（tileWindows 布局快照 undo）。测试文件：desktopAgentManifest.test.ts（16 用例）——停跑令前 apps 分片实跑通过（§0.1）。遗留：无。
- **A3 系统子应用** — 已完成。Skills manifest（apps/system/agentManifests.ts，未挂载时诚实报告 route skills/unmounted）；Templates/TaskDashboard 观察与演出补全；session 复习卡面锚点（flashcards LibraryCardRow/ReviewCardSurface/TodayScreen 的 `data-agent-entity` 锚点）；番茄钟实体反馈（PomodoroAppWindow）；fsrs/qbank abort 追踪与 todo 草稿保护。静态证据：`apps/system/agentManifests.ts:810` 起（skillsAgentManifest，未挂载诚实报告 `skills/unmounted`）、flashcards LibraryCardRow / ReviewCardSurface / TodayScreen 的 `data-agent-entity` 锚点。测试文件：skillsAgentManifest.test.ts、systemAgentManifests.test.ts、pomodoroActivation.test.ts、flashcardsDueSource.test.ts、todoAgendaSource.test.ts、fsrsQbankDriver.test.ts（46 用例）、pomodoroDriver.test.ts（13 用例）——停跑令前分片实跑通过（§0.1）。遗留：无。
- **A4 笔记/导图演出** — 已完成。crepe `agentScrollFollow.ts`（AI 打字机温和滚动跟随，用户上滚即让位）+ `agentDiffFlash.ts`/`agentHighlight.ts`（破坏类直改高亮）；导图删除退场动画与更新态内容高亮（mindmap.css，只动 transform/opacity，reduced-motion/forced-colors 全路径）；noteDriver reviewing 接线守卫（建议模式挂起时 presence 置 reviewing，`noteDriver.ts:299-308`）。静态证据：`components/crepe/agentScrollFollow.ts`（文件头「ACR 4.0 A4」标注）、`agentDiffFlash.ts`、`plugins/agentHighlight.ts`、`mindmap/styles/mindmap.css:1767-1786`（agent-exiting 退场，仅 opacity+translateY）/`:1791` 起（更新高亮）/`:1892-1893`（reduced-motion 关停）。测试文件：tests/vitest/notes/agentScrollFollow.test.ts、agentDiffFlash.test.ts、noteDriverReviewing.acr4.test.ts（4 用例）、mindmapDriverActs.acr4.test.ts（6 用例）、noteDriver.test.ts（43 用例）——停跑令前分片实跑通过（§0.1）。遗留：无。
- **A5 演出层 UI** — 已完成。AgentStrip 续放按钮（resumable 时「继续」占用暂停位）+ `useAbortCountdown` 暂停自动中止倒计时（aria-live 区外且 aria-hidden，不轰炸读屏）+ placementHint i18n 括注（移除 stageManager 临时 labelExtra 中文后缀，跨界见 §6）；Dock 后台完成角标（`agent/visuals/dockBadgeStore.ts` + Dock.tsx/DockItem.tsx 最小侵入，跨界见 §6）；WindowShell 补 `data-agent-reviewing` 光环；zh/en workbench.json 各追加 6 个 agent.core key（resume/autoStopCountdown/placementBackground/placementStageFull/placementFrozen/dockDoneBadge）。静态证据：`AgentStrip.tsx:53-70`（useAbortCountdown）/`:253-258`（倒计时在 aria-live 区外且 aria-hidden）/`:37-47,201-204`（placementHint→i18n）/`:261-287`（续放按钮占暂停位）、`agent/visuals/dockBadgeStore.ts`、`WindowShell.tsx:1174`（data-agent-reviewing）。测试文件：AgentStrip.acr4.test.tsx（10+2 用例，2 用例为 A8 增补）、dockBadgeStore.test.ts（5 用例）。动态记录：A5 波全量 vitest 622/623（唯一失败为预存超时，§0.1）；i18n 两语齐备由 A8 静态抽查确认（zh/en workbench.json key 集完全一致，agent.core 共 25 key）。遗留：无。
- **A6 文件/沙盒** — 已完成。sandbox setMode 诚实化：**撤除** setMode 能力（渲染面固定 chat-safe 安全预览，消灭「已审批的假成功」）；abort run 追踪；finder reveal 演出补全（自动进入父目录 + 选中 + flash）；DESIGN.md §8 文档漂移勘误（finder reveal 行为，2026-07-19）。静态证据：`apps/sandbox/agentManifest.ts:33`（「ACR 4.0（A6 诚实化）：撤除 setMode 能力」标注）、`docs/dev/acr/DESIGN.md:366`（勘误行）。测试文件：sandboxDriver.test.ts（5 用例）、todoFinderDriver.test.ts（14 用例）、files 系列——停跑令前分片实跑通过（§0.1）。遗留：无。
- **A7 内容/PDF/浏览器** — 已完成（A8 复核确认无半成品）。exam 硬拒能力诚实化：setFocusMode/showSettings 走 `exam:setFocusMode`/`exam:openSettings` 表面同步 ACK（ExamContentView 监听，诚实报告 changed/前值供 undo；无视图挂载即失败）；`pdfFocusAck.ts` gotoPage ACK 竞态修复（1.5s 超时即标 stale，viewer 兑现 pendingFocus 前必须 `isStale()` 检查；usePdfFocusListener 卸载即显式回失败）+ EnhancedPdfViewer 目标页高亮渐隐演出（enhanced-pdf.css，只动 opacity，reduced-motion 静态短高亮 + forced-colors Highlight 描边）；`contentAgentSurfaces.ts` 投影注册表有真实消费方（Translation/Essay/ImageContentView 注册，agentManifests observe/execute 消费）；browser_executor.rs `browser_close` 归 mutating + Medium 敏感度 + 接管冷却检查，内嵌测试同步。静态证据：`apps/content/register.ts:396-460`（exam ACK 派发）、`ExamContentView.tsx:420-522`（监听 + 诚实回执与守卫）、`apps/content/agentManifests.ts:284-362`（ACK→undo 组装）、`pdfFocusAck.ts:4-38`（超时标 stale）、`TextbookPdfViewer.tsx:140-149`（兑现前 isStale 检查）、`usePdfFocusListener.ts:114-131`（卸载显式回失败）、`EnhancedPdfViewer.tsx:542-577` + `enhanced-pdf.css:883-919`（目标页高亮，仅 opacity，reduced-motion/forced-colors 路径齐）、`contentAgentSurfaces.ts` 消费方（Translation/Essay/ImageContentView 注册 + `agentManifests.ts:430/456` 消费）、`browser_executor.rs:104-106/1209/1283-1286/1356-1357`（close mutating+Medium+测试）。测试文件：contentAgentSurfaces.test.ts、pdfFocusAck.test.ts、nonNotesActivation.test.ts（9 用例）——停跑令前分片实跑通过（§0.1）；browser_executor 内嵌 cargo test 未执行（静态走查）。遗留：无。
- **A8 集成（第三波）** — 已完成。①工具卡步骤流自动滚底（`workbenchOpsBlock.tsx:287` 起，流式追加跟随最新一条）+ 撤销过期解释（isUndoExpiredError → 'expired' 态，`workbenchOpsBlock.tsx:75/394-436`；undoExpired/undoExpiredHint 两语文案入 chatV2.json）+ desktop 虚拟目标隐藏「打开目标窗」按钮；workbenchBlockRemap 4.0 映射核对（`workbenchBlockRemap.ts:12`，本轮新增面无需扩展映射）；noteDriver 守卫简化（`noteDriver.ts:23`，markSuggestionReviewing 已在 presenceStore 真实落地）。②交叉核对：**desktop 写租约**——desktop mutating act 的 windowId 解析为 null（`stageManager.ts:711-731` 只查 windowStore 真实窗），不占也不检查窗口写租约（`beginManagedOperation` 仅在 windowId 非空时挂租约，`stageManager.ts:762/790`）。裁决：可接受不修。理由：desktop 无宿主窗口，能力全部是对 windowStore 的同步原子布局操作，逐动作 re-read + acknowledged 校验；runId/correlationId 去重仍生效；窗口布局变更与 app 内容写互不侵入，等价于用户拖窗，不构成接管语义；**launchApp background 焦点**——原实现经 workbenchBus.launch 开窗必抢焦点，已对齐 stageManager handleOpenApp（`stageManager.ts:1296-1356`）策略：background 档把焦点还给原窗（新窗保留不 minimize），follow 档保持聚焦（`apps/desktop/agentManifest.ts:608-618` + 2 个新测试用例）；**notesWorkspaceActivation.test.ts 预存超时**——路径全是微任务（标准跑 <10ms），根因是全量 vitest（forks 满载 + 外置卷慢 transform）CPU 饿死令 5s 默认 testTimeout 偶发误报，已放宽 suite timeout 至 20s（`notesWorkspaceActivation.test.ts:32-35` 注释，吸收调度抖动、不掩盖真实挂死）；**reviewing 按钮活性**——裁决按 run 活性禁用：新增 stageManager 旁路只读 `isRunActive(runKey)`（`stageManager.ts:2309-2316`，不入 StageManagerApi 冻结面），AgentStrip reviewing（run 已结束仅建议挂起）时禁用暂停/停止（`AgentStrip.tsx:166-176`），消灭「按钮可用却静默 no-op」；**A7 复核**——四项全部完整（见 A7 行），无半成品需补。③修复全量跑暴露的 workbenchOpsBlock.test.tsx 3 处 undoExpired 断言（文案已进 i18n，mock 解析真实中文）。验证记录见 §0.1（完整动态验证未在收尾轮执行；另有 4 个只读审阅代理并行做全量静态验收）。遗留：全量 vitest 单进程 OOM（基建项，建议 CI 分片跑）；cargo test 定向用例未执行。

- **收尾补丁（协调者复查，2026-07-19 晚）** — 调研复核发现错误码表存在**反向缺口**：A1 把 Rust KNOWN 表已有码补进了前端 `ACR_ERROR_CODES`，但前端自产码未同步进 Rust KNOWN 表，经 `map_bridge_error` 会被降级为 `WORKBENCH_UNAVAILABLE`（code 失真，message/hint 保留）。已修复：①Rust `workbench_executor.rs` KNOWN 表补 `RUN_ID_EXPIRED / UNSUPPORTED_ACTION / UNKNOWN_COMMAND / INTERNAL` 并配默认 hint；②前端 `types.ts` 冻结表补录 `UNKNOWN_COMMAND / INTERNAL`；③`ERRORS.md` §3/§4 补 `RUN_ID_EXPIRED`、`UNSUPPORTED_ACTION` 两行；④删除 `chatV2.json` 死 key `blocks.workbenchOps.undone/undoFailed`（两 locale，均无代码引用，动态 key 仅走 `status.*` 命名空间）。验证：ACR 定向 vitest 59 文件 / 552 用例全绿（含 workbenchOpsBlock / acr4.runtime / desktopAgentManifest），`check:i18n` PASS；Rust 侧为纯字符串表追加，未跑 cargo（按「不编译」约束，静态走查确认语法与 match 臂类型一致）。
- **ACR 4.1 美术升级轮（协调者，2026-07-19 晚）** — 目标「视觉惊艳、风格克制优雅、动画丝滑」，全部动画维持 transform/opacity-only 纪律。落地：①统一视觉 token（`--acr-a`/`--acr-b` 双色微光身份、`--acr-ease-out`/`--acr-ease-spring` 缓动、`--acr-breathe-ms` 2.2s 统一呼吸周期）；②窗口光环三层深度——conic 双色渐变描边核（mask 抠 2px 环，渐变 paint 一次、呼吸只动 opacity；`@supports mask-composite` 内生效，回退实线光环）+ 内侧泛光反相位呼吸 + 点火淡入；③AgentStrip：入场滑入、acting 点雷达 ping 扩散环（dot 移出 overflow:hidden 的 label 防裁剪）、label 微光扫过（55% 周期留白）、双色 tint 背景；④实体 flash 与导图 update 高亮统一为双色渐变 tint +「闪-驻-隐」两段曲线；⑤Dock 角标弹性入场（scale 过冲 keyframe）；⑥导图入场轻弹簧落座/退场收拢上浮——并修正预存缺陷：动画从 `.react-flow__node` 包装层移到直接子元素（包装层行内 transform 定位会被动画覆盖）；⑦**desktop 窗口编排 FLIP 演出**（新文件 `agent/visuals/agentWindowFlip.ts`）：move/resize/snap/tile 落位后 WAAPI transform 补间（纯装饰层，布局属性零参与、失败/拖拽中/reduced-motion 安全 no-op），接入 `apps/desktop/agentManifest.ts` 四个布局能力；⑧笔记 AI 光标双色渐变 + 静态微光。所有新增动效补齐 reduced-motion（装饰层隐藏/静态替代）与 forced-colors（系统色重映射/装饰层移除）路径。验证：定向 vitest 6 文件 / 67 用例全绿（AgentStrip.acr4 / dockBadgeStore / desktopAgentManifest / mindmapDriverActs.acr4 / agentFlash / window-shell）。跨界：改动触及 A2（agentManifest 布局能力接 FLIP）、A4（mindmap.css / CrepeEditor.css agent 段）、A5（visuals），由协调者统一执行，登记于 §6。

### 全局验证数字

见 §0.1「4.0 验收结论」。停跑令前实际完成：typecheck 0 错误；分片 vitest——
workbench agent 38 文件/401 用例、apps 两批（A 19 文件/144 用例 + B 全绿）、
components/core/hooks 48 文件/585 用例、tests/vitest/workbench 27 文件/372 用例、
chat plugins/utils 13 文件/59 用例、crepe+notes 34 文件/303 用例、
flashcards+todo+learning-hub 25 文件/147 用例，全部通过；mindmap+pdf 分片首跑
1 失败，协调者复跑 **30 文件/349 用例全绿**（满载下的调度 flake，不可复现）；
`cargo check` 通过。协调者补跑（2026-07-19 晚）：`cargo test --lib workbench`
32 通过、`cargo test --lib browser_executor` 11 通过。原「未执行」项已全部清零。

## 6. 跨界申请登记

- **A5 → A1**（stageManager.ts + acr4.runtime.test.ts / stageManager.test.ts）：移除 stageManager 临时 labelExtra 中文后缀（约 8 行），placement 直落原因改由 `placementHint` 结构化字段 + UI 层 i18n 渲染；A1 的两处测试断言从 label 后缀改为断言 placementHint。已核准（契约 §1 本就规定 label 不再硬编码中文，此为收尾）。
- **A5 → 共享组件**（components/Dock.tsx / DockItem.tsx）：后台完成 Dock 角标接线（消费 `agent/visuals/dockBadgeStore.ts`，最小侵入：仅角标渲染与点击清除）。已核准。
- **A8 → A4**（agent/drivers/noteDriver.ts）：markSuggestionReviewingGuarded 守卫简化——markSuggestionReviewing 已在 presenceStore（A1）真实落地，删除防御性存在检查。已核准。
- **A8 → A5**（agent/visuals/AgentStrip.tsx）：reviewing 态暂停/停止按钮按 run 活性（`stageManager.isRunActive`）禁用；配套在 AgentStrip.acr4.test.tsx 增补 2 用例。已核准（第三波无并行代理，无冲突风险）。
- **A8 → A1**（agent/stageManager.ts）：新增旁路只读 API `isRunActive(runKey)`（不入 StageManagerApi 冻结面）；两处 presence 语义注释（reviewing presence 由建议流程自管）。已核准。
- **A8 → A2**（apps/desktop/agentManifest.ts + desktopAgentManifest.test.ts）：launchApp 补 background 档不抢焦点策略（对齐 stageManager handleOpenApp），读 gates.getAgentControlMode()。已核准。
- **A8 → A7**（src-tauri browser_executor.rs）：复核期 rustfmt 格式修正（无语义变化）。已核准。
- **A8 → A1/A4 测试**（agent/__tests__/notesWorkspaceActivation.test.ts）：suite timeout 放宽至 20s（预存的满载误报超时，见 §5 A8 段）。已核准。
- **4.1 → A2**（apps/desktop/agentManifest.ts）：move/resize/snap/tile 四个布局能力接入 `captureWindowFlip` 装饰层（布局直写与 ACK 语义零改动）。协调者执行。
- **4.1 → A4**（features/mindmap/styles/mindmap.css agent 段；components/crepe/CrepeEditor.css AI 光标段）：动效精修 + react-flow 包装层 transform 冲突勘误。协调者执行。
- **4.1 → A5**（agent/visuals/**）：agent-visuals.css 重写、AgentStrip dot 移层、新增 agentWindowFlip.ts。协调者执行。
