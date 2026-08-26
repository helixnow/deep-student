# Wave2-E 第 6 轮复核 · SOTA 三项（r6-10）

- 复核对象：第 5 轮落地的 SOTA 静态子集三项（复习 UX / FSRS 可视化 / 隔离队列）
- 模式：只读复核（本轮未产生补丁；未跑任何测试/编译；未 commit）
- 基线 tip：`35ea482a`（wip: Wave2-E round 5 i18n nullable options and SOTA subsets）
- 独占面：`src/features/flashcards/` 内本会话新增/改动的 SOTA 文件
  （`review/UndoNudge.tsx`、`components/FsrsParamsPanel.tsx`、`library/libraryView.ts` 分区 +
  `screens/LibraryScreen.tsx` 接线、`screens/ReviewSessionScreen.tsx` 计时 + `review/useSessionClock.ts`）

## 结论：三项全部仍在，接线完整，零阻断缺陷

| # | SOTA 项 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 复习 UX（UndoNudge + 逐卡用时显示封顶） | **仍在** | `ReviewSessionScreen.tsx:732-737` 渲染 UndoNudge；`:55` 显示封顶 60s；`:178` useNow |
| 2 | FSRS 可视化（FsrsParamsPanel 只读聚合） | **仍在** | `StatisticsScreen.tsx:487` 挂载；后端契约逐行核对通过 |
| 3 | 隔离队列（Library 未入队/已入队分区） | **仍在** | `libraryView.ts:49-56` 纯函数；`LibraryScreen.tsx:166-178` 接线 |

## 1. 复习 UX：UndoNudge + 计时

### UndoNudge（`review/UndoNudge.tsx`）

- 接线：`ReviewSessionScreen.tsx:732-737`，`receiptId={lastReview?.logId ?? null}`、
  `rating={lastReview?.rating ?? null}`，仅在 `!editing` 分支渲染（编辑态不打扰）。
- 回执契约核对：`fsrsReviewStore.ts` 的 `ReviewReceipt` 确有 `logId`（:77）与 `rating`；
  撤销成功后弹栈按 `logId` 剔除（:1396-1399），`lastReview` 回退到栈顶（:1408）→
  receiptId 变化触发提示条重置，语义与头注释一致。
- 挂载防打扰：`seenIdRef` 初始化为挂载时栈顶（:43），切 tab 回来不重复弹条 —— 设计意图落实。
- TTL 8s 定时器（:54-57）用函数式 setState 比对 `current === receiptId`，快速连评不误关新条；
  cleanup 清定时器，无泄漏。
- 文案：`session.again/hard/good/easy`、`session.undo` 在 zh-CN/en-US `flashcards.json`
  两侧均真实存在（zh-CN :193/:230-233）；`review.undoNudgeRated/undoNudgeGeneric` 走
  defaultValue（第 5 轮 locale 非独占的既定约束，非缺陷）。
- a11y：`role="status"`、按钮 `aria-keyshortcuts="Z"`、`<kbd>` aria-hidden、coarse 指针 44px 兜底 —— 在位。

### 计时（`review/useSessionClock.ts` + `ReviewSessionScreen.tsx:175-202`）

- `formatDuration`：`m:ss` / `h:mm:ss`，负值钳 0；`useNow(enabled)`：enabled 时秒级重渲染，
  disabled 冻结最后值（完成态定格用时）—— 与注释一致。
- 本卡用时：`cardShownAt` 依赖 `[cardKey, sessionRatedCount]` 重置（评分/换卡/撤销均重置）；
  显示封顶 `CARD_TIMER_DISPLAY_CAP_MS = 60_000` → 「1:00+」（:192-195），**仅 UI**；
  落库用时仍走 store 的 `MAX_ANSWER_DURATION_MS = 10 * 60_000`（fsrsReviewStore.ts:89，:1158
  实际钳制点），两条口径互不污染 —— 第 5 轮红线（显示封顶不影响统计）未回退。
- 本轮用时：`doneAt` 在 sessionDone 时一次性定格（:184-190），`sessionElapsedMs = (doneAt ?? now) - sessionStartedAtMs`；
  完成态传给 `SessionSummary`（:473），SessionSummary 复用同一 `formatDuration`（SessionSummary.tsx:16/:96）。
- 学习步提前复习提示复用 now（`learningWaitMs`，:200-202），无额外定时器。

## 2. FSRS 可视化：FsrsParamsPanel

- 挂载：`StatisticsScreen.tsx:487`。刷新接线：`FSRS_STATS_REFRESH_EVENT` + `subscribeFlashcardsDueRefresh`
  （events.ts:3/:11），卸载时移除监听并 `requestIdRef` 递增作废在途请求 —— 竞态防护完整。
- 后端契约逐行核对（本轮新验证）：
  - `fsrs_get_due(limit: Option<u32>)`（cmd/fsrs_review.rs:179-182）参数名 `limit` 与前端
    invoke `{ limit: DUE_SAMPLE_LIMIT }` 匹配；
  - `get_due_inner` 钳制 `limit.unwrap_or(50).min(500)`（fsrs_review_service.rs:1454），
    与面板 `DUE_SAMPLE_LIMIT = 500` 及「打满标注仅统计前 500」文案一致；
  - `FsrsDueCard` `#[serde(flatten)] state: FsrsCardState` + camelCase（fsrs_review_service.rs:135-139），
    `stability/difficulty: Option<f64>`（:113-114）落在顶层 —— `parseDueParamsRows` 读
    `row['stability']/row['difficulty']` 正确。
- 只读红线：全文件仅一处 invoke（`fsrs_get_due`），零写命令、零上传；FSRS opt-in 未动 —— 未回退。
- 诚实计数：新卡 null 参数归「暂无参数」不编造默认值；`unavailable` 态兜底 invoke 失败与形状异常。
- 非阻断观察（不出补丁）：`withParams = min(stab, diff)`、`withoutParams = sampled - max(stab, diff)`，
  若出现「只有一个参数」的半残行则两计数之和 < sampled。实际不会发生 —— 后端评分写库时
  stability/difficulty 恒成对写入（fsrs_review_service.rs:1709-1731 等），该式属防御性写法，留档即可。

## 3. 隔离队列：Library 分区

- 纯函数 `partitionLibraryQueues`（libraryView.ts:49-56）：按 `card.enqueued` 单趟稳定分区，
  组内保序（筛选/排序在调用方先做）—— 与 JSDoc 一致。
- 接线（LibraryScreen.tsx:166-178）：filter（`matchesStatusFilter`）→ `sortLibraryCards` → 分区；
  `visibleItems = [...inbox, ...scheduled]` 与渲染顺序（inbox 区在前，:822/:861）一致，
  键盘导航 / shift 连选 / 全选口径均基于 visibleItems —— 顺序契约成立。
- 区头「整批入队」`handleEnqueueInbox`（:350-353）复用既有 `bulkEnqueue` 链路，未新开后端命令 ——
  第 5 轮「enqueue 复用现路径」承诺兑现。
- `scheduledDueCount` 只统计已入队区（:178，`countDueCards` 排除 suspended），
  未入队卡不会虚报到期数。
- 分区区头文案 `library.queue.*` 走 defaultValue（同 locale 非独占约束）；
  `library.css` 的 `data-queue='inbox'/'scheduled'` 视觉隔离样式在位（:203-261）。
- 筛选交互边界：状态筛选先于分区，如筛「到期」时 inbox 区自然为空并整区隐藏（:822 条件渲染），无空壳区头。

## 红线自证（本轮）

1. 未改 workbench 壳、preview、coordinator、tool_loop —— 本轮零代码改动（只读复核）。
2. 未跑任何测试/编译/npm/cargo。
3. 显示封顶不影响落库统计、FSRS opt-in 未动、面板只读零写 —— 三条第 5 轮红线复核均未回退。

## 已验证 / 未验证

- 已验证（静态）：三项组件的挂载点、store/后端契约（logId 回执、fsrs_get_due 形状与钳制、
  bulkEnqueue 复用）、locale 键真实性、a11y 属性、渲染顺序契约。
- 未验证：运行时行为（TTL 定时器实际表现、500 上限实际打满、分区在真实分页数据下的滚动表现）；
  相关 vitest 套件未跑（本轮禁令）。
