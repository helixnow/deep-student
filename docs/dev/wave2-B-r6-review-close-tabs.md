# 0824 Wave2-B 第 6 轮 — 复核员-关标签（r6-review「关标签」）

- 角色：复核员-关标签（第 6 轮），对第 2 轮 close gate（P4）与第 3 轮标签恢复（P8）落地面逐 diff 复核
- 复核对象：`src/features/learning-hub/closeTabGate.ts`、`LearningHubPage.tsx`（关闭/LRU 段）、`apps/TabPanelContainer.tsx`（keepalive 段）；旁证只读：`components/TabBar.tsx`、`apps/UnifiedAppPanel.tsx`、workbench `contentDirtyRegistry.ts` / `ContentCloseConfirmation.tsx`、各视图 checker 注册点、zh/en `workbench.json`
- 验证口径：**全程静态**（逐行读码 + rg grep + python json.load 键路径核对），未跑 npm/vitest/编译（禁令遵守）；未 commit/push（父代理统一处置）
- 未触碰：`previewPersistence.ts`、finder 分桶调用点（Page LH-HOST 双桶原样）、TabBar、UnifiedAppPanel、contentDirtyRegistry、locale JSON——本轮 2 处修复全部落在授权可写的 hub 三文件内

## 一、核项 1：十四入口仍经 gate — **通过**

git 溯源先行：`closeTabGate.ts` 与 `TabPanelContainer.tsx` 自 r2（`18b8f81b`）后、`LearningHubPage.tsx` 自 r3（`6fe01f2a`）后**无任何提交触碰**（r4/r5 零 diff），工作区与 HEAD 一致。逐入口对照（行号为本轮复核后工作区实况）：

| # | 入口 | 复核证据 |
|---|------|----------|
| 1-4 | TabBar 关钮/中键/Delete键/右键关闭 | `TabBar.tsx:131,137-142,158-161,371` 四路全部收敛到 `onClose` prop；Page 两分支（移动 `:1403,1412` / 桌面 `:1531,1544`）`onClose=closeTabWithSplit` |
| 5 | Cmd/Ctrl+W | `LearningHubPage.tsx:553-571`：视图活跃门控 + `closeTabWithSplit(currentId)`（`:567`，P4-5 注释在案），无裸 closeTab |
| 6 | Finder 工具栏 handleCloseApp | `:1160-1166` → `closeTabWithSplit` |
| 7/8 | 关闭其他 / 关闭右侧 | `:485-496` → `requestCloseTabsBatch` → gate `requestCloseTabs` → `commitCloseTabs`（isPinned 豁免保留） |
| 9 | openTab LRU 淘汰 | `:359-369` 候选过滤 `!isTabDirty(t)`，候选全脏放弃淘汰（可暂超 MAX_TABS=20）；本轮补 1 处分屏悬空修复（见 §四.2） |
| 10 | 保活实例淘汰 | `TabPanelContainer.tsx:150-154` keepAlive 集合豁免脏标签（可暂超 MAX_KEEPALIVE_TABS=5）；活跃/分屏 tab LRU 序号最新必在集合内（`:128-133`） |
| 11 | dstu deleted/purged | `:573-623` 自身 setTabs 直删豁免 gate（实体已删），activeTabId/splitView 修正语义在案 |
| 12 | 恢复后失效校验 | 即 P8-2，见 §二 |
| 13 | 路由切走（unmount） | `:641-647` 对注册 save handler 的脏标签尽力 `saveContentNow` |
| 14 | 窗口关闭 beforeunload | `:627-636` 任一脏标签 → preventDefault |

验收 grep 复跑：裸 `closeTab(` 调用仅剩 `requestCloseTab` 内 gate 通过后的提交步（`:429`）；setTabs 直删仅剩 openTab LRU（已过滤脏）、`commitCloseTabs`（batch gate 后）、dstu 删除事件（豁免）、P8 恢复校验（仅 NOT_FOUND），与 r2 文档验收清单一致。

**dirty 真相源键约定复核**（gate 以 `(tab.type, tab.resourceId)` 查询）：registry 键经 `normalizeResourceInstanceKey` 统一归一为叶 ID（`contentDirtyRegistry.ts:20-22`），同键多 checker 为 Set 并集（`:34-36`，任一 dirty 即 dirty）。产品侧全部注册点核对：note 正文 `NoteContentView:952`（`{typeId:'note', instanceKey:node.id}` 传入 NotesCrepeEditor:1469）+ note 标题 `NotesEditorHeader:113`（同键并集）+ note save handler `NoteContentView:807`；exam `ExamContentView:496-503`（sessionId=node.id，仅 checker 无 save handler，确认框只有丢弃/取消——r2 已知边界不变）；translation `TranslateWorkbench:389,426` 与 essay `EssayGradingWorkbench:240,615`（均以 `dstuMode.resourceId`=视图 node.id 注册）。node 由 UnifiedAppPanel 以 `/${resourceId}` 载入（`:216`），叶 ID 与 tab.resourceId 同源，**无键漂移**。

**fail-closed 链路复核**：无宿主时 `requestContentCloseDecision` 恒 'cancel'（`ContentCloseConfirmation.tsx:42`）；宿主卸载时在途/排队请求全部 resolve('cancel')（`:104-109`）；Page 移动/桌面两分支各挂一份宿主（`:1456,1555`，互斥渲染，handler 注册栈可恢复）；批量 gate 取消后不再连环弹框、干净标签互不拖累（`closeTabGate.ts:66-77`），与红灯测试 `__tests__/closeTabGate.test.ts` 语义对齐（探测路径 `../closeTabGate` 命中，`{approved}` 形状被归一层兼容）。

## 二、核项 2：恢复段 P8 未被回退 — **通过**

对照 `wave2-B-r3-tab-restore.md` 逐条：

- **P8-1 写透缓存**：`savePersistedTabs`（`:236-246`）先更新模块级 `persistedTabsCache` 再写 localStorage，storage 抛异常不影响缓存。在。
- **P8-2 稳定 resourceId 校验**：恢复后台校验 `dstu.get('/' + tab.resourceId)`（`:305`）与 UnifiedAppPanel 加载键对齐；三分支原样——成功重绑 `dstuPath=node.path`/`title=node.name`（name 空保留旧 title，`:309-313`）、`NOT_FOUND` 删标签（`:314-315`）、其他错误码保留不删（`:317` 注释在案）；activeTabId 修正语义保留（`:337-340`）。在。
- **P8-3 版本化白名单**：key 沿用 `learning-hub-tabs-v1` + `version: 2`（`:148-149,241`）；`parsePersistedTab` 整条丢弃（tabId/resourceId/type）与字段修复（dstuPath/title/openedAt/isPinned）策略原样（`:170-185`）；tabId+resourceId 双重去重（`:208-218`）；JSON 整体损坏回空态（`:226-230`）。在。

## 三、核项 3：Cmd+W 走 closeTabWithSplit — **通过**

`LearningHubPage.tsx:553-571`：meta/ctrl + 非 alt/shift + 'w'（toLocaleLowerCase），仅 learning-hub 视图活跃时拦截，`closeTabWithSplit(currentId)` → `requestCloseTab`（gate + pendingCloseGateRef 防重复弹框 + 关闭右侧分屏 tab 时先清分屏，`:417-433`）。无裸 closeTab 回退。

## 四、翻案落地（2 处，均在授权可写文件内）

1. **gate 确认文案引用不存在的 i18n 键（用户可见缺陷，修复）**：`closeTabGate.ts` 原写 `i18next.t('workbench:notes.confirmCloseUnsaved')`，但 zh/en `workbench.json` **均无 `notes` 对象**（json 键路径核对：该文案实际在 `content.confirmCloseUnsaved` 与 `notesWorkspace.confirmCloseUnsaved`），dirty 关标签确认框 description 会露出裸 key。r2 i18n 文档（`wave2-B-r2-i18n.md:25-27`）本就声明复用既有键并点名标签页措辞版 `notesWorkspace.confirmCloseUnsaved`（「此标签页有未保存的更改，确定要关闭吗？」，zh/en 双语齐、语义正对关标签场景且不含笔记专属措辞）。修复改引该键（`closeTabGate.ts:40`），**不新造键、不改 locale JSON**。全仓其余 `confirmCloseUnsaved` 引用（content/notes register、createContentApp、ResourceAppWorkspace）均引用存在的键，无同类问题。
2. **入口 9 LRU 淘汰可致 splitView.rightTabId 悬空（低危边角，修复）**：openTab 淘汰候选只排除 isPinned/活跃/脏标签，右侧分屏 tab（openedAt 不随分屏刷新）可被淘汰，`splitView.rightTabId` 悬空 → 右侧面板落入空白占位（`TabPanelContainer:229-233` 的 empty 分支，不崩溃但需手动关分屏）。r2 在 `requestCloseTab`/`commitCloseTabs`/dstu 直删三处都做了分屏清理，唯独入口 9 漏配。修复：淘汰命中分屏 tab 时同步 `setSplitView(null)`（函数式更新幂等，与同 updater 内既有 setActiveTabId 范式一致；`LearningHubPage.tsx:364-369`）。

## 五、记录不修（非缺陷或域外）

- `TabPanelContainer` 渲染期写 `lruRef`/`lruTickRef`（`:128-133`）：非纯渲染但幂等（StrictMode 双渲染仅多推进 tick 序号，排序语义不变），r2 生命周期审阅已过，维持现状。
- exam/essay 无 save handler 时确认框只有「丢弃/取消」两路：exam 判分侧归 E 禁改（r2 已知边界）；essay save handler 已在 r2（P2d）注册，现三态齐全，仅 exam 维持两态。
- 批量 gate 期间新开标签不受影响（targets 为发起时快照）：r2 已知边界，语义合理不改。
- essay「保存并关闭」正文草稿级持久化（2.5/3.7/4.6 挂账项）：不在本卡范围，继续挂账。

## 六、已验证 / 未验证

**已验证（静态）**：十四入口逐条行号对表 + 验收 grep 复跑；P8 三件套逐条与 r3 文档比对无回退；registry 键归一与全部产品注册点无漂移；确认宿主 fail-closed 三层（无宿主/卸载/取消）；i18n 修复后引用键在 zh/en 双语均存在（json.load 核对）;禁改区（previewPersistence、finder 分桶、TabBar/UnifiedAppPanel/registry/locale）本轮零触碰。

**未验证（如实声明）**：未跑 vitest/tsc/编译（禁令）——`closeTabGate.test.ts` 红绿未知、两处修复的运行时行为（确认框文案渲染、淘汰分屏清理时序）未经执行验证，归第 8 轮实测；beforeunload/unmount flush 仍为静态推演。
