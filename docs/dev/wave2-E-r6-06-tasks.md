# Wave2-E 第 6 轮 — 任务台复核（06）

> 静态复核记录（未编译 / 未跑测试 / 未 commit，per 轮次约束）。
> 模型 claude-fable-5-thinking-high。独占：`src/features/anki-tasks/*`。
> 复核对象：r3 落地的 classify 混合态、list/stats 拆分、行内暂停/取消
> （上游锚定 `wave2-E-r1-09-tasks-block.md` §1/§2、`wave2-E-r3-05-tasks.md`）。

---

## 0. 回复主问题

**混合态是否仍短路 attention：否。**

`classify`（types.ts:62-66）现行优先级为
`activeTasks > 0 || pausedTasks > 0 → 'active'`，failed 判定排在其后：

```62:66:src/features/anki-tasks/types.ts
export function classify(s: DocumentSession): SessionGroup {
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  if (s.failedTasks > 0) return 'attention';
  return 'completed';
}
```

failed+running、failed+paused、三态并存均归 `'active'`，运行事实不丢。
r1-09 §1.3 列的四条连锁后果逐一复核确认已消除：

| r1-09 连锁后果 | 现状 |
|---|---|
| 轮询降频（5s→30s） | `load()` 的 `nextHasActive = s.some(classify(s)==='active')`，混合态计入 → 保持 5s |
| 防休眠误解除 | effect 依据 `groups.active.length`，混合态在 active 组 → 任务在跑不误调 `set_prevent_sleep(false)` |
| active tab 丢会话 | filter 走 classify → 混合态出现在「进行中」tab |
| 进度条无运行光带 | `isRunning = group==='active' && activeTasks>0` → 混合态点亮 `wb-at-row-running` + 流动光带 |

失败事实由正交的 `hasWarnings`（types.ts:76-79）以非阻断徽章
（`wb-at-warning-badge`，SessionRow 主行）叠加，纯 attention 会话不点亮
（状态标签已表达失败，避免双重告警）。展开区 active 状态行明示
`x 运行中 / y 已暂停 / z 失败` 计数。

契约锁定：`__tests__/classify.mixed.test.ts` 与 `classify.mixedState.test.ts`
双文件覆盖（含 failed+paused 归 active 的产品裁决断言、5s 轮询谓词回归锚、
hasWarnings 正交性、optional warning 字段前向兼容）；组件级断言在
`AnkiTasksApp.statsOnlyFailure.test.tsx` 混合态 describe（状态标签 +
徽章计数 + 纯失败不叠徽章）。本轮未跑（per 约束），静态核对与实现一致。

## 1. list/stats 拆分复核 — 无缺口

`load()`（AnkiTasksApp.tsx:226-258）为 `Promise.allSettled`，两请求各自结算：

- list 成功 → `setSessions` + 清 `loadError`，与 stats 结果无关；
- stats-only failure → 仅点亮 `statsError`（`anki-tasks-stats-error`，
  `role="status"` 非阻断 + 重试），列表照常渲染，不进 stale banner；
- list-only failure → 有旧数据走 stale banner、无数据走整页错误态
  （`role="alert"`），stats 成功照常写入；
- generation 守卫、`onLatestLoadSettledRef` 轮询节奏回调、`setLoading(false)`
  时序均与 r3 记录一致；`allSettled` 永不 reject，无残留 try/catch。

五个场景（stats-only 首载/刷新、错误条重试清除、list-only stale、
list 首载整页错误）在 `AnkiTasksApp.statsOnlyFailure.test.tsx` 均有断言，
与实现逐条对得上。

## 2. 行内暂停/取消复核 — 补 1 处 a11y 缺口

可见性矩阵复核（SessionRow 桌面行内簇 + 移动端展开区）：

| 按钮 | 条件 | failed+running | failed+paused |
|---|---|---|---|
| 暂停 | `group==='active' && activeTasks>0` | 可见 | 隐藏（无可暂停分段，正确） |
| 恢复 | `pausedTasks>0` | 按需 | 可见 |
| 取消 | `group==='active'` | 可见 | 可见 |
| 重试失败 | `failedTasks>0`（无附加条件） | 可见 | 可见 |

混合态下暂停/取消不再被 attention 分组藏住（r1-09 §1.4 的两处「藏住」
均消除）；移动端展开区同款条件同步。

**本轮补**：行内簇 icon-only 按钮缺可访问名称。`CommonTooltip` 只在气泡
可见时给触发器挂 `aria-describedby`，不构成 accessible name——暂停/恢复/
取消/快速导出/跳聊天/删除六个按钮对读屏用户是「空按钮」（同簇「重试失败」
r3 已带 `aria-label`，是既定模式）。已给六个按钮补 `aria-label`
（复用各自 tooltip 词条；删除按钮随确认态切换文案）。仅属性增量，
不改结构/条件/样式，既有测试无一断言这些按钮的 name（唯一按 name 查询的
是 retry/refresh，均已有 label），无破坏面。

## 3. i18n 词条对账

组件引用的词条逐一 grep 双语言包（zh-CN / en-US）：

- 已落齐：`statusPaused / templatesUsed(Hint) / windowApproxHint /
  statusTruncated / statusCancelled / loadingFailures / failedPanelTitle /
  retryAll / segmentLabel / noErrorMessage / showMoreFailures / pause /
  resume / paused / resumed / retryStarted / retryPartial / noStuckTasks /
  deleted / cancelled / cancelTask / noExportableCards / exported /
  recoveredCount / preventSleepUnsupported / errorCardsFound / errorReason /
  multipleTemplates` 等全部命中；
- **仍缺**（两语言包均无，靠组件内 `defaultValue` 兜底，英文界面显示中文）：
  `taskDashboard.statsLoadFailed`、`taskDashboard.sessionWarningsHint`。
  locale JSON 不在本轮独占清单（先例：r3-05 §5 同因未动），**不越界改**，
  仍记台账欠账（ledger「locale 部分 defaultValue」条目继续开放）。
  组件已按「locale 落词条后自动优先」写法，补词条时零组件改动。

## 4. paused 计入 active 组的轮询/防休眠语义 — 裁决保留

复核中评估过「paused-only（无运行分段）会话钉住 5s 轮询 + 防休眠不自动
解除」是否算缺口。裁决：**保留现状，不改**。理由：

- 恢复入口不止任务台——`controlDocumentTask` 同为聊天块共用门面，
  跨表面 resume 后任务台需在秒级感知（30s 空闲档会滞后半分钟）；
- 防休眠是用户显式 opt-in，暂停≠结束，自动解除会让「恢复后长跑」
  丢失用户已选的保护；「全部结束自动解除」语义（注释原文）不含暂停；
- 本地 invoke 5s 轮询成本可忽略，且视图隐藏/失活时本就暂停。

## 5. 其余复核点（无改动）

- agentSurface 快照：状态令牌口径与 `list_document_sessions` 一致；
  混合态 `status='active'` 且 `failedTasks` 令牌保留，观察方不丢失败事实；
  `focusedFailedTasks` 的 key（会话 id + 失败数 + 更新时间）防轮询重复拉取，
  loadError 诚实上报——均与 A45-2 契约一致。
- `FailedTasksPanel` / `retryFailedDocumentTasks` 失败口径
  （Failed/Truncated/Cancelled）与后端会话统计一致，`allSettled` 部分成功
  有 warning 通知。
- 「运行中置顶」stable partition 用 `activeTasks>0`（非 classify），
  paused-only 不误置顶，仅 all tab 生效——语义正确。

## 6. 边界自查

- 本轮 diff：`SessionRow.tsx`（6 个 `aria-label` + 1 条注释）+ 本文档；
  未触碰 types.ts / AnkiTasksApp.tsx / locale / 测试 / 独占区外任何文件；
- 未跑编译 / vitest，未 commit（per 轮次约束）。
