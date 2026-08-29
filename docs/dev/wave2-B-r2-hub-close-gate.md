# 0824 Wave2-B 第 2 轮 — Learning Hub close gate（P4）

- 角色：实现员-learning-hub-close-gate（第 2 轮）
- 基线勘察：`docs/dev/wave2-B-r1-anchor-hub.md` §1（十四入口）、§6（P4 插入点）
- 改动文件：`LearningHubPage.tsx`（Page）、`apps/TabPanelContainer.tsx`（Container）、新增 `closeTabGate.ts`（gate 本体，纯逻辑无 React）
- **NotesCrepeEditor 未动**：并行卡已在 `NoteContentView.tsx` 注册 note 的 save handler（走 `editor.flushPendingSave`，flush 后仍 dirty 会抛错 fail-closed），本卡无需再碰编辑器，避免双重注册。
- 未触碰：`previewPersistence.ts`、`UnifiedAppPanel.tsx`、`ExamContentView` 判分/注册点（仅消费其 checker）、finder 分桶调用点（Page LH-HOST / 1276 / 1316 原样，双桶不变）、Page 恢复逻辑（loadPersistedTabs / persistedTabsCache / 恢复校验，第 3 轮）、coordinator.rs、workbench scheduler。

## gate 设计（`src/features/learning-hub/closeTabGate.ts`）

- `isTabDirty(tab)`：`isContentDirty(tab.type, tab.resourceId)`。键约定：各视图注册 checker 时 typeId 即 tab.type、instanceKey 即资源叶 ID（note=NoteContentView:931、exam=ExamContentView:494-501、essay/translation=学习中心视图内嵌的两个 Workbench 组件），gate 只读消费、不自建真相源。
- `confirmTabClose(tab)`：干净放行；dirty 走 `requestContentCloseDecision` 三态确认（保存并关闭 / 丢弃 / 取消），`hasContentSaveHandler` 决定是否提供保存；保存走 `saveContentNow`，失败 toast（`workbench:content.saveAndCloseFailed`）并返回 false。取消/保存失败/无确认宿主一律返回 false → 调用方保留标签与草稿（fail-closed）。
- `requestCloseTabs(tabs) → { approved, cancelled }`：批量 gate。干净标签直接放行；脏标签逐个确认；用户一旦取消（或保存失败），后续脏标签**不再弹框**、一律保留（不连环轰炸对话框），干净标签互不拖累照常放行（与同轮红灯测试 `__tests__/closeTabGate.test.ts` 的「互不拖累」语义对齐；该测试通过候选路径探测本模块，落点 `../closeTabGate` 命中）。
- 确认对话框宿主 `ContentCloseConfirmationHost` 原本只在 WorkbenchDesktop 挂载（无宿主时 decision 恒为 cancel = fail-closed），Page 两个分支（移动/桌面）各自挂载一份（portal 渲染，handler 注册栈可恢复，不与 Workbench 冲突）。

## Page 接线

- `closeTab` 退化为无 gate 的最终提交步，仅供 `requestCloseTab`（gate 通过后）调用；dstu deleted/purged 事件通道走自身 setTabs 直删，豁免 gate（实体已删）。
- `requestCloseTab`：gate 通过后先清分屏（关的是右侧分屏 tab 时退出分屏）再 `closeTab`，修复 r1 §1a 记录的入口 5/6 绕过分屏清理导致 `splitView.rightTabId` 悬空；`pendingCloseGateRef` 防同一标签重复弹框。
- `closeTabWithSplit`：所有单点入口的同步外壳（`(tabId) => void`），TabBar/Container 的 onClose 传参不变。
- 批量：`closeOtherTabs` / `closeTabsToRight` 以 tabsRef 快照算目标（保留 isPinned 豁免），经 `requestCloseTabs` 后由 `commitCloseTabs` 一次性提交（保留原活跃/分屏修正语义）。

## 十四入口对照（编号沿用 r1 §1；表也写入 Page 文件头）

| # | 入口 | 本轮落点 |
|---|------|----------|
| 1-4 | TabBar 关钮/中键/键盘/右键关闭 | `onClose=closeTabWithSplit` → `requestCloseTab`（gate） |
| 5 | Cmd/Ctrl+W | 改走 `closeTabWithSplit`（gate + 分屏清理，不再裸 closeTab） |
| 6 | Finder 工具栏 `handleCloseApp` | 同上 |
| 7 | 关闭其他 | `closeOtherTabs` → `requestCloseTabs`（脏标签逐个确认；取消后不再弹框且脏标签保留；干净标签互不拖累） |
| 8 | 关闭右侧 | `closeTabsToRight` → 同上 |
| 9 | openTab LRU 淘汰 | 淘汰候选过滤 `!isTabDirty`；候选全脏时放弃淘汰（可暂超 MAX_TABS），不弹框不丢草稿 |
| 10 | 保活实例淘汰 | Container keepAlive 集合豁免脏标签（可暂超 MAX_KEEPALIVE_TABS；淘汰只发生在重渲染，渲染期同步查 registry 即完整覆盖） |
| 11 | dstu deleted/purged | 豁免 gate（实体已删），保留原直删逻辑 |
| 12 | 恢复后失效校验 | 第 3 轮范围，未动 |
| 13 | 路由切走（Page unmount） | 无法异步拦截；对注册了 save handler 的脏标签尽力 `saveContentNow`（编辑器自身卸载 flush 仍是兜底；子树 cleanup 先注销 handler 时为 no-op，语义等价） |
| 14 | 窗口关闭（beforeunload） | 任一脏标签 → `preventDefault`（补齐笔记之外的类型；笔记编辑器自带守卫保留） |

## 验收 grep（关闭入口全部过 gate helper）

`rg -n 'closeTab\(|\.filter\(t =>' src/features/learning-hub/LearningHubPage.tsx`：

- 裸 `closeTab(` 调用仅剩 `requestCloseTab` 内部（gate 之后的提交步）。
- setTabs 直删仅剩：openTab LRU（已加 dirty 过滤）、`commitCloseTabs`（batch gate 之后）、dstu 删除事件（豁免）、恢复校验（第 3 轮，未动）。

已知边界（记录，不在本卡修）：

- 批量 gate 期间新打开的标签不受影响（targets 为发起时快照）。
- exam/essay 仅注册 checker 未注册 save handler，确认框只有「丢弃/取消」两路（essay 侧补 save handler 归 r1 smallapps 卡 E1；exam 判分侧归 E 禁改）。
- `requestCloseTabs` 返回形状 `{ approved, cancelled }` 为本轮定型，红灯测试的归一层兼容该形状，第 8 轮可收紧断言。
