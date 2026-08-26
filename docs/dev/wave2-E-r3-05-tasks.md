# Wave2-E 第 3 轮 — 任务台混合态（05）

> 静态改动记录（未编译 / 未跑测试 / 未 commit，per 轮次约束）。
> 上游锚定：`docs/dev/wave2-E-r1-09-tasks-block.md` §1（互斥分类）、§2（list/stats 绑死）。
> 改动面：`src/features/anki-tasks/{types.ts, AnkiTasksApp.tsx, components/SessionRow.tsx}` +
> `__tests__` 新增两个测试文件。未触碰 streaming / TauriAdapter / ankiCardsBlock / locale。

---

## 1. classify 互斥分类修复（types.ts）

### 新优先级

```ts
export function classify(s: DocumentSession): SessionGroup {
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  if (s.failedTasks > 0) return 'attention';
  return 'completed';
}
```

1. **activeTasks > 0 或 pausedTasks > 0 → `active`**：只要还有分段在跑或可恢复
   就归运行组。failed+running / failed+paused 混合态不再被 `failedTasks > 0`
   短路吞掉。
2. 否则 **failedTasks > 0 → `attention`**：全部停止且有失败，需要处理。
3. 否则 **`completed`**。

函数头部文档注释写明互斥分类已修及旧实现的连锁后果（r1-09 §1.3：轮询降频、
防休眠误解除、active tab 丢会话、行内暂停/取消被藏）。

### 自动被修好的下游读点（零额外改动，全部经 classify 传导）

| 读点 | 混合态修复后行为 |
|---|---|
| `load()` 的 `nextHasActive`（AnkiTasksApp） | 混合态算 active → 轮询保持 5s，不再掉 30s |
| 防休眠 effect（`groups.active.length`） | 混合态在 active 组 → 任务在跑时不再误调 `set_prevent_sleep(false)` |
| filter tab（`classify(s) === filter`） | 混合态出现在「进行中」tab |
| 环形图 donutData | 混合态计入运行扇区 |
| `SessionRow.isRunning`（`group === 'active' && activeTasks > 0`） | 混合态为 true → 进度条流动光带 + 行运行高亮 |
| SessionRow 行内暂停（`group === 'active' && activeTasks > 0`）/ 取消（`group === 'active'`） | **混合态下重新可见**，展开区移动端同款条件同步恢复 |
| agentSurface 快照 `status` | Agent 观察面看到的分组同步修正 |

### hasWarnings 正交标记（不改变分组）

```ts
export function hasWarnings(s: DocumentSession): boolean {
  if ((s.warningTasks ?? 0) > 0 || s.completedWithWarnings === true) return true;
  return s.failedTasks > 0 && (s.activeTasks > 0 || s.pausedTasks > 0);
}
```

- 混合态（active 组 + 失败分段）点亮；
- 「带警告完成」（optional 后端字段，见 §3）点亮；
- 纯 attention 会话**不**点亮——状态标签本身已表达失败，避免双重告警。

## 2. load() 拆分（AnkiTasksApp.tsx）

**是，已拆分。** `Promise.all`（快速失败绑死）改为 `Promise.allSettled`，
list 与 stats 各自结算：

- `list_document_sessions` 成功 → `setSessions` + 清 `loadError`，列表照常渲染；
- `get_anki_stats` 单独失败 → 新增 `statsError` state 点亮统计错误条
  （`data-testid="anki-tasks-stats-error"`，`role="status"` 非阻断，带重试按钮），
  列表与上一次 stats 数据均保留（`metrics` 对 `stats: null` 本就有 `?? 0` 兜底）；
- list 单独失败 → 维持既有语义（有旧数据 → stale banner；无数据 → 整页错误态），
  stats 成功照常写入；
- generation 守卫、`onLatestLoadSettledRef`（轮询节奏回调）、`setLoading(false)`
  时序均不变；`allSettled` 永不 reject，故删除 try/catch，`finally` 语义内联。

统计错误条文案走 `t('taskDashboard.statsLoadFailed', { defaultValue: ... })`——
locale 文件不在本轮独占清单内，用 i18next defaultValue 兜底（先例：
AnkiTasksApp 里 `t('common:clear', { defaultValue: 'Clear' })`），后续补词条时
无需改组件。

## 3. 「带警告完成」前向兼容（types.ts + SessionRow.tsx)

后端 `list_document_sessions` 当前不下发 warning 字段，先吃 optional：

```ts
interface DocumentSession {
  // ...既有字段不变...
  warningTasks?: number;           // 将来 warning 计数
  completedWithWarnings?: boolean; // 将来 completed_with_warnings 标记
}
```

SessionRow 主行文档名右侧新增**非阻断警告徽章**
（`data-testid="wb-at-warning-badge"`，warning 色小标 + 计数，title 提示，
文案同样 defaultValue 兜底）：

- 混合态 → 计数显示 `failedTasks`（+ 将来的 `warningTasks`）；
- 「带警告完成」→ 后端补字段后自动点亮，前端零改动；
- 徽章只叠加提示，不改状态标签、不改分组、不拦任何操作。

展开区 active 状态行补失败分段计数（`x 运行中 / y 已暂停 / z 失败`），
混合态下失败事实在详情里也不静默（重试入口本就常显，Step 22 前置修复）。

## 4. 新增测试（只写不跑，per 轮次约束）

| 文件 | 覆盖 |
|---|---|
| `__tests__/classify.mixedState.test.ts` | 纯函数：failed+running / failed+paused / 三态并存归 active；纯失败归 attention；hasWarnings 正交性（混合态点亮、attention 不点亮、optional 字段点亮且分组不变、字段缺省无警告） |
| `__tests__/AnkiTasksApp.statsOnlyFailure.test.tsx` | 组件级（mock 结构对齐既有 loadError 测试）：stats-only failure 列表仍在 + 统计错误条可见 + 不进整页错误态/stale banner；错误条重试成功后清除；list-only failure 维持 stale banner 且无统计错误条；混合态行显示「进行中」标签 + 警告徽章；纯失败行无徽章；warningTasks 会话 completed 标签 + 徽章 |

既有 `AnkiTasksApp.loadError.test.tsx` / `AnkiTasksApp.polling.test.tsx` 的契约
（generation 守卫、settle 回调次数、stale banner 语义）在 load 重写中逐条保留，
静态核对无破坏。

## 5. 边界自查

- 未改 `streaming_anki_service` / `TauriAdapter` / `ankiCardsBlock`（grep 本轮
  diff 仅命中 anki-tasks 三文件 + 新测试 + 本文档）；
- 未改 locale JSON（新文案全部 defaultValue 兜底）；
- 未改缓存段 / reconcile（归 A 组）；
- 未跑编译 / 测试 / CI，未 commit。
