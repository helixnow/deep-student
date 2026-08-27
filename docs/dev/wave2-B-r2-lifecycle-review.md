# 0824 Wave2-B 第 2 轮 — 生命周期审阅（审阅员-生命周期）

- 角色边界：只读第 2 轮未提交 diff 逐行审 React 卸载顺序与竞态；不跑 npm/cargo/vitest，不 commit/push。
- 审阅基线：`cursor/0824-wave2-desktop-subapps-a875` 工作区未提交改动（15 个修改文件 + 4 个新文件），
  含实现员并行产出 `deactivationTransaction.ts` / `closeTabGate.ts`（快照契约文档 §6 撰写时刻尚不存在，本轮已到位）。
- 本轮打了 **2 个补丁**（见 §8）；其余全部为静态读码结论。

---

## 1. 停用事务是否两阶段（全预检再卸壳）——通过，但发现并已修复一个旁路

### 1.1 事务本体（`deactivationTransaction.ts`）：正确的两阶段

- phase 1 只做预检：枚举一次 `windowStore` 全部窗口 id，**顺序** `await confirmWindowClose(id)`
  （顺序而非并行，避免多个未保存确认对话框互相遮挡）。任一取消 → `{ ok: false }`，
  **不关闭任何窗口**（包括已确认过的），无任何副作用。
- phase 2（真正卸壳）完全在调用方：settings `handleModeChange` 在 `ok` 之前
  不 `setMode(false)`、不 `persist`、不 `workbenchBus.setEnabled(false)`、不派发
  `WORKBENCH_MODE_CHANGED`——取消路径上 persist/bus/event 均不可达 ✓。
- single-flight（模块级 `inFlight`）：模式开关连点 / 退出与开关同时触发共享同一轮确认 ✓。
- 快照契约合规：取消路径不碰 `flushSnapshot`（契约 §2.2）；成功路径的 flush 是
  「成功路径最后一步」的提前落盘（契约 §2.1 T1 允许），且 `catch` 吞错不阻塞停用 ✓。

### 1.2 【已修复 · 补丁 1】三个模式开关入口完全绕过事务

`persistWorkbenchModeEnabled(false)`（`src/features/settings/components/workbenchMode.ts`）
是设置页之外所有模式开关入口的唯一写通道，此前**直接** persist → `bus.setEnabled(false)`
→ App 卸载 `WorkbenchDesktop`，逐窗 canClose 一次都不问。受影响入口：

1. `src/components/ModernSidebar.tsx:516`（侧边栏快捷开关）；
2. `src/components/WorkbenchModeSwitchRow.tsx:48`（legacy 侧边栏开关行）；
3. `src/features/workbench/components/StatusBarBrandMenu.tsx:85`（品牌菜单「退出学习桌面」）。

任一入口点一下，脏窗未保存内存态随 React 子树卸载静默丢失——与缝一要修的
原缺陷同型，属确定性数据丢失。修复：在 `persistWorkbenchModeEnabled` 内、
`enabled === false` 时先 `await runWorkbenchDeactivationTransaction('mode-off')`，
取消即返回 `false`（三个调用方本就按「返回 false = 回滚乐观 UI」处理，语义无缝）。
事务 single-flight 保证与设置页开关并发时不叠加弹框。依赖方向
settings → workbench/core 单向，无环；App.tsx 已静态引入同一模块，不新增首屏体积。

已知小瑕疵（不修）：侧边栏两个入口是乐观更新，事务对话框未决期间开关短暂显示
「关」，取消后回弹；设置页做法（UI 不离开 true）更优，但改造两个入口的状态机
超出最小改动，纯视觉、无数据风险。

### 1.3 【已修复 · 补丁 2】设置页取消路径双 toast + 死代码

- 事务本体取消时已 `showGlobalNotification('info', t('deactivation.cancelled'))`；
  `handleModeChange` 在 `!outcome.ok` 时又弹同一条（两处解析到同一 locale 串，
  `UnifiedNotification` 无去重）→ 确定性双 toast。
- `outcome.reason === 'dirty' | 'dirty-blocked' | 'dirtyBlocked'` 是死代码：
  `WorkbenchDeactivationResult` 只有 `{ ok }`，reason 永为 undefined，
  `dirtyBlocked` 分支永不可达。
- 修复：正常取消路径不再重复通知（由事务统一发出）；仅在事务 promise
  意外 reject（事务内部无提示）时兜底弹 `deactivation.cancelled`。
  `workbench:deactivation.dirtyBlocked` 键仍被 App.tsx beforeunload `returnValue`
  使用，locale 不删。

### 1.4 已知竞态（记录，不修）

phase 1 通过到 phase 2 卸壳之间有一个异步间隙（`persist` 的 Tauri invoke +
`closeBrowserForDisabledGate`），期间用户理论上可再次编辑已确认的窗口或新开窗；
事务头注明确「事务期间新开的窗不参与本次停用决策」，属有意取舍，窗口极小。
另：mode-off 成功后壳卸载但 `windowStore` 不清空，重开模式窗口按 store 复原
（内容从落库态重建）——保守方向，无数据风险。

## 2. confirmWindowClose 是否会真的关掉窗口——不会，预检安全

- `windowCloseGuard.confirmWindowClose`（69-82）：只解析
  `appRegistry.get(win.typeId)?.canClose` 并做同窗 single-flight，**没有任何
  `closeWindow` / store 写入**；窗不存在或无 canClose → resolve(true)。
- 逐个核对 canClose 实现均无关窗副作用：
  - `createContentApp.canClose`：查 dirty → 弹三态确认 →「保存」分支
    `saveContentNow`（只保存，窗保持打开）→ 返回 boolean；
  - `notes/register.ts` `canCloseNotesWorkspace`：查 `hasUnsavedNotesWorkspaceChanges`
    → `requestContentCloseConfirmation`，宿主异常按 false（保窗）fail-closed。
- 同窗 single-flight 与用户手动关窗并发：两条路径 await 同一个确认 promise，
  用户路径负责真正关窗，事务对已消失的窗按「窗不存在 = 可关」放行，无双弹框、无竞态。

## 3. scheduler skip 是否在 used -= weight 之前——是，预算记账正确

`scheduler.ts:582-596` 冻结候选循环内顺序为：

1. `used <= budget` 提前退出（583）；
2. 预取豁免 `continue`（584）；
3. **`if (isWindowDirty(win.id) || !canSuspendNow(win)) continue;`（585）**；
4. `selected.add`（586）→ `freezeCandidateSince` 记账（587-588）→ 冻结/宽限（589-593）
   → `used -= memoryWeightOf(win)`（595）。

脏窗在 3 处被跳过：不进 `selected`、不进 `freezeCandidateSince`、**不扣 used 预算**
——继续占预算，压力顺延到更旧的干净窗（「宁可多冻干净窗，绝不冻脏窗」），
与 anchor §3.2 S2 警告一致。`canSuspendNow`（140-147）不 await：返回 Promise
按可冻（契约约定 dirty 查询必须同步），回调抛异常按**不可冻**（fail-closed）。
与 `hasDirtyWorkbenchWindows` 的方向一致（那边抛异常按脏）。调度器绝不自动
`prepareSuspend` ✓（该字段仅类型声明 + 注释，热路径零引用）。

## 4. Learning Hub LRU / keepalive 是否跳过脏标签——是

- **LRU 淘汰**（`LearningHubPage.openTab`，~268 行）：淘汰候选过滤
  `!isPinned && tabId !== active && !isTabDirty(t)`；候选全脏时放弃淘汰、
  允许暂超 `MAX_TABS`——不弹框也不静默丢草稿 ✓。
- **保活淘汰**（`TabPanelContainer`，146-154）：`keepAliveIds` 是每次渲染新建的
  Set（非 memo 值），渲染期把脏标签补进集合安全；被逐出即强制 unmount 的风险
  对脏标签解除，落盘后下一次渲染自然回收 ✓。
- **关闭入口收口**：TabBar `onClose` / 面板 `onClose` / Cmd+W / Finder 关钮全部
  `closeTabWithSplit → requestCloseTab`（gate + `pendingCloseGateRef` 防同标签
  重复弹框 + 分屏清理先于删除，避免 `rightTabId` 悬空）；「关闭其他 / 关闭右侧」
  走 `requestCloseTabs`（取消后脏标签不再连环弹框、干净标签照关）。
  裸 `closeTab` 仅剩 gate 通过后的提交步与 dstu deleted/purged 直删通道
  （实体已删，豁免 gate 正确）。**无裸删脏标签路径** ✓。
- exam 只注册 dirty checker、无 save handler → 确认框只给「放弃/取消」
  （`offerSave=false`），不虚假承诺保存 ✓；note 的 save handler flush 后复查
  `isContentDirty` 仍脏即抛错（标题等未覆盖面不放行关闭），fail-closed ✓。
- 入口 13（Page unmount 尽力 flush）：React 删除子树时 cleanup 按父先子后
  执行，Page 级 cleanup 运行时各视图的 save handler 通常仍在注册表内，
  flush 大概率有效；代码注释已对「子树先注销则 no-op」兜底，best-effort 语义成立。

## 5. beforeunload 多监听器是否互抢——不互抢

现有监听器逐一核对：

| 监听器 | preventDefault? | 行为 |
|---|---|---|
| `main.tsx:636`（MCP/ChatV2 紧急保存） | 否 | 纯同步保存，不参与拦截 |
| `NotesCrepeEditor.tsx:1254` | 笔记脏时 | 仅 preventDefault + returnValue |
| `LearningHubPage`（新，入口 14） | 任一标签脏时 | 仅 preventDefault + returnValue |
| `App.tsx`（新，workbenchActive 时） | 工作台任一窗脏时 | preventDefault + returnValue + 异步补跑停用事务 |
| 其余（EpubPreview / previewUtils / debugLogger / vfs 缓存清理） | 否 | 纯 flush/清理 |

多个 preventDefault 叠加只产生同一个原生「确认离开」对话框，互不干扰；
唯一触发自定义对话框的是 App 的 `void runWorkbenchDeactivationTransaction('app-exit')`
（single-flight，重复触发共享同一轮）。用户选「离开」→ 页面照常卸载、事务
随进程消亡；选「留下」→ 逐窗保存/放弃对话框继续可用，符合头注设计。
`pagehide` 只做 `flushSnapshot()` 兜底（不可取消路径，契约允许的退出兜底落盘）。

## 6. 窄窗不再卸壳后，移动平台护栏是否误伤——未误伤

`App.tsx:860`：`workbenchActive = workbenchMode && !isMobilePlatform()`。
删除的只有 `shellStableSmallScreen`（250ms 宽度迟滞）这一因子；
`isMobilePlatform()` 永真拦截保留，宽屏 Android 平板 / iPad 仍不进 OS 模式 ✓。
`isSmallScreen` 继续驱动页面内布局，未受影响。全库已无 `shellStableSmallScreen`
残留引用（仅注释与测试文档提及）。'breakpoint' 事务 reason 目前无调用方，
保留作为类型占位无害。

## 7. 环依赖——无环

- `deactivationTransaction` → { appRegistry, snapshot, windowCloseGuard, windowStore,
  UnifiedNotification, utils/i18n }；`snapshot` → `scheduler` →（新增）
  `windowCloseGuard` → { appRegistry, windowStore }。`windowCloseGuard` /
  `windowStore` / `appRegistry` 均不回指 scheduler/snapshot/deactivationTransaction，
  DAG 成立。`windowCloseGuard` 模块级 `useWindowStore.subscribe` 在该链上求值
  顺序无环，安全。
- `contentDirtyRegistry` 仅 import `resourceIdentity` ✓；`closeTabGate` →
  { contentDirtyRegistry, ContentCloseConfirmation, types/tabs, UnifiedNotification,
  i18next }，与 LearningHubPage / TabPanelContainer 单向 ✓。
- 补丁 1 新增 `workbenchMode → deactivationTransaction`：deactivationTransaction
  不 import settings 任何模块，无环。
- import 正确性抽查：`utils/i18n` 的 `t(key, options?, ns)` 三参签名与事务内
  用法一致；App.tsx 深路径引入的四个符号均存在且被使用；新测试文件引用的
  `resetWindowStoreForTests` / `registerTestApp` / `__resetWindowDirtyForTests` /
  `__resetContentDirtyRegistry` 均存在。essay save handler 闭包引用的
  `serializeSessionContext / lastGradedInputRef / draftKey / patchPersistedBaseline`
  均在作用域内，且 dirty checker 与 save handler 的注册键同为
  `dstuMode.resourceId ?? initialSession?.id`，无键漂移。

## 8. 本轮补丁清单（每文件最小改动，未触碰禁改区）

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `src/features/settings/components/workbenchMode.ts` | `persistWorkbenchModeEnabled(false)` 前置共享停用事务；取消返回 false | 修复确定性数据丢失旁路（§1.2） |
| 2 | `src/features/settings/components/WorkbenchSettingsSection.tsx` | `handleModeChange` 移除死代码 `outcome.reason` 分支与取消路径重复 toast | 修复确定性双 toast + 死代码（§1.3） |

禁改区零触碰：coordinator.rs / tool_loop / 44px / anki / qbank / finder 合桶均无改动；
`snapshot.ts` 白名单四防线（`pickShellFields / sanitizeWindow / sanitizeSnapshot /
WorkbenchSnapshotV1`）本轮 diff 零触及，快照契约红线（§4 R1-R5）无违规。

## 9. 遗留给后续轮次

1. 侧边栏两个模式开关入口的乐观 UI 在事务未决期间短暂显示「关」（§1.2 末），
   可在后续轮改为事务 ok 后再翻状态。
2. phase 1 → phase 2 的异步间隙竞态（§1.4）：如需彻底闭合，可在事务成功后、
   卸壳前做一次同步 `hasDirtyWorkbenchWindows()` 复检，脏则重跑事务。
3. essay「保存并关闭」后正文仅草稿级持久化（localStorage），关窗放行依赖
   重开时草稿优先恢复——第 3 轮恢复失效校验（入口 12）时需覆盖该路径。
