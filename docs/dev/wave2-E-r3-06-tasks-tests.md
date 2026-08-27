# Wave2-E 第 3 轮 — 任务台独立降级测试（r3-06）

> 角色：0824 Wave2-E 第 3 轮「独立降级测试」（编号 06）。模型 `claude-fable-5-thinking-high`。
> 纪律自证：本轮**未跑任何测试/编译/CI**、**未 commit**、未触碰任何产品组件
> （`AnkiTasksApp.tsx` / `types.ts` 由第 3 轮另一角色修改，本角色仅读）。
> 两个测试文件均按「拆开后的」行为书写，**vitest 统一到第 8 轮执行**（文件头已注明）。

## 1. 交付物（3 个文件）

| 文件 | 内容 |
| --- | --- |
| `src/features/anki-tasks/__tests__/AnkiTasksApp.statsOnlyFailure.test.tsx` | list/stats 解耦（P1-3，r1-09 §2 / §7 插入点 6）+ 混合态呈现的组件级契约测试（合并版，见 §4） |
| `src/features/anki-tasks/__tests__/classify.mixed.test.ts` | classify 混合态（P1-3，r1-09 §1 / §7 插入点 5）的纯函数契约测试 |
| 本文件 | 契约锚点记录 + 轮内事件（同名文件碰撞与合并）+ 第 8 轮跟进项 |

mock 风格逐项对照既有 `AnkiTasksApp.loadError.test.tsx`：`vi.hoisted` 的 invoke 响应队列
（每次 load 消费一个，`Error` 表示该次调用失败）、真实 zh-CN 文案（缺 key 退化成 key 本身即失败）、
桌面断点 matchMedia、`document.hidden=false`。相对 loadError 测试的两处扩展：
`get_anki_stats` 独立响应队列（拆开前该命令恒成功，无法表达 stats-only failure）；
i18n mock 支持 `options.defaultValue`（statsLoadFailed 词条暂以组件内联 defaultValue 提供）。

## 2. 测试清单

### AnkiTasksApp.statsOnlyFailure.test.tsx

describe `AnkiTasksApp stats-only failure (load 拆分)`：

1. **get_anki_stats 单独失败时列表照常渲染，仅显示统计错误条** —— 首载 list 成功 + stats 失败：
   会话渲染；`anki-tasks-stats-error` 存在、`role="status"`、含底层错误文本、不渲染裸 i18n key；
   `anki-tasks-load-error` / `anki-tasks-stale-banner` / 空态均不出现。
2. **统计错误条的重试成功后清除错误条** —— 点错误条内重试（`taskDashboard.retry`），成功后条消失、列表保持。
3. **stats 失败的刷新仍然刷新列表：新数据落地、不退化成 stale** —— 刷新时 list 带新数据 + stats 失败：
   列表必须换成新数据（旧会话名从 DOM 消失）、无 stale banner、无整页错误。
4. **list 单独失败（stats 正常）仍走既有 stale banner 语义** —— 有旧数据时 list 刷新失败：
   stale banner + 旧数据保留，且不误报统计错误条。
5. **首次加载 list 失败（stats 正常）仍走整页错误态，不误报统计降级** —— 解耦不得反向弱化：
   无旧数据时整页 `anki-tasks-load-error`（role=alert + `taskDashboard.loadFailed` + 原始错误），不与空态混淆。

describe `AnkiTasksApp failed+running 混合态归 active`：

6. **混合态会话显示「进行中」状态标签并叠加非阻断警告徽章** —— 行内 `taskDashboard.statusActive`、
   无 `statusFailed`、`wb-at-warning-badge` 显示失败数。
7. **纯失败（无运行/暂停）会话仍显示「失败」标签且不叠加徽章**。
8. **「带警告完成」optional 字段：completed 分组 + 警告徽章** —— `warningTasks`（前向兼容字段）点亮徽章。

### classify.mixed.test.ts（describe: `classify mixed-state contract (P1-3 round-3 decoupling)`）

1. **classifies a failed+running mixed session as active — the running fact must win**（任务卡钦定契约）。
2. **stays active regardless of how many segments already failed, as long as one is still running**
   —— 失败 99 / 运行 1 仍 active；failed+active+paused 三态混合同理。
3. **classifies a failed+paused mixed session as active — resumable segments keep the session in the running group**
   （产品裁决后补入，见 §5-1）。
4. **keeps a purely failed (nothing running) session in attention**。
5. **keeps the pure single-state groups unchanged** —— 纯 active / 纯 paused ⇒ active；纯 completed 与全零 ⇒ completed。
6. **makes the fast-poll predicate see a failed+running session (regression anchor for 5s polling)**
   —— `sessions.some(s => classify(s) === 'active')` 对混合态为 true（load() 5s/30s 轮询判定的根因回归锚）。

## 3. 契约锚点（已与轮内落地实现核对一致）

本角色开工时产品改动尚未出现，锚点按既有先例独立钉下；产品实现随后落入共享工作区，
逐项核对**全部吻合**：

| 锚点 | 取值 | 实现核对 |
| --- | --- | --- |
| 统计降级提示 testid | `data-testid="anki-tasks-stats-error"` | ✅ AnkiTasksApp.tsx statsError 错误条 |
| 提示 role | `role="status"`（非阻断，对照 stale banner；整页错误才 alert） | ✅ |
| 错误透出 | 提示内包含 `getErrorMessage(err)` 原文 + 行内重试按钮 | ✅ |
| i18n | `t('taskDashboard.statsLoadFailed', { defaultValue: '统计数据加载失败，任务列表不受影响' })` | ✅（词条暂内联，见 §5-2） |
| stale banner 语义 | 只属于「list 刷新失败但有旧数据」；stats-only failure 不触发 | ✅（list/stats 各自结算） |
| 实现形态 | `Promise.allSettled`，两请求独立结算，generation 守卫语义不变 | ✅（测试仍只锁行为不锁实现） |
| classify | active/paused 判定整体先于 failed；`hasWarnings` 正交叠加徽章（`wb-at-warning-badge`） | ✅ types.ts / SessionRow |

## 4. 轮内事件：同名文件碰撞与合并

产品实现角色在共享工作区也写了一版 `AnkiTasksApp.statsOnlyFailure.test.tsx`（含实现对齐的
混合态渲染断言），覆盖了本角色先落盘的版本——该文件按任务卡属 r3-06 独占。处置：**合并而非回滚**——
保留其实现对齐断言（`wb-at-warning-badge` / `data-agent-entity` / 错误条内重试 / stale 语义回归 /
warningTasks 前向兼容），并入 r3-06 独有的两个降级场景（上表测试 3、5），补上任务卡要求的
「第 8 轮才跑 vitest」文件头。另外该角色还新建了 `classify.mixedState.test.ts`（含 hasWarnings 断言），
与本角色独占的 `classify.mixed.test.ts` 并存，覆盖面有重叠但断言互补（本文件多失败计数极端值与
轮询谓词回归锚；对方多 hasWarnings 真值表）。是否合并去重由第 8 轮裁决。

## 5. 第 8 轮跟进项

1. **失败+暂停混合态归组已裁决**：实现取「active/paused 先于 failed」⇒ failed+paused 归 `active`。
   本角色原留白待裁，现已按裁决补断言（classify 测试 3）。
2. **locale 词条未落盘**：`taskDashboard.statsLoadFailed` 目前只存在于组件 `defaultValue`，
   zh-CN / en-US anki.json 均无该 key（grep 全仓仅组件一处命中）。建议补对称词条；
   测试对此健壮（mock 支持 defaultValue，仅断言不渲染裸 key），落词条后无需改测试。
3. **执行**：本轮零测试执行。第 8 轮跑 vitest 时若混合态渲染断言红，先核对 SessionRow 的
   `data-agent-entity` / `wb-at-warning-badge` 是否保留，再核对 §3 锚点。
