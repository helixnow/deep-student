# 0824 Wave2-B 第 1 轮锚定 — Learning Hub（标签关闭 / 持久化 / 预览进度 / Finder 分桶）

- 角色：锚定员-learning-hub（第 1 轮，只读勘察，不改产品代码）
- 基线：`/workspace`，工作树位于 `82e016b7`（其父提交即任务指定的 `061b4815`，`82e016b7` 仅为开分支的 docs 提交，`src/` 与 `061b4815` 一致）
- 对照评审：`docs/0824-quality-review/learning-notes.md`（P1「关闭非 fail-closed」「进度写携带旧书签」、P2「标签持久化两个回滚点」）、`docs/0824-quality-review/finder-hub.md`（§1 宿主分桶、§2 标签恢复 WARN）
- 行号均为现码实测；文中「Page」= `src/features/learning-hub/LearningHubPage.tsx`，「Container」= `src/features/learning-hub/apps/TabPanelContainer.tsx`，「Panel」= `src/features/learning-hub/apps/UnifiedAppPanel.tsx`，「PP」= `src/features/learning-hub/apps/views/previewPersistence.ts`，「TabBar」= `src/features/learning-hub/components/TabBar.tsx`。

---

## 1. 标签关闭全入口清单（P4 地图）

核心状态封闭在 Page 内：`closeTab`（Page:279-291）是唯一「按 tabId 删单个」的收敛函数；`closeTabWithSplit`（Page:426-433）在其上先清分屏。以下按「用户可达入口 → 最终落点」穷尽（grep 依据：`closeTab|closeOtherTabs|closeTabsToRight|closeTabWithSplit|handleCloseApp|toEvict|onCloseApp` 全仓命中见附录 A）。

### 1a. 关当前（单 tab）

| # | 入口 | 触发代码 | 落点 |
|---|------|---------|------|
| 1 | TabBar 关闭按钮 | TabBar:131-134（`handleClose`） | TabBar:589 `onClose={() => onClose(tab.tabId)}` → Page:1240（移动）/1365（桌面）传 `closeTabWithSplit` → `closeTab` |
| 2 | 鼠标中键 | TabBar:137-142（`handleAuxClick`，`e.button === 1`） | 同上（`onClose`） |
| 3 | 键盘 Delete/Backspace（tab 聚焦时） | TabBar:152-164（158-161 分支） | 同上（`onClose`） |
| 4 | 右键菜单「关闭」 | TabBar:371 | 同上（`onClose`） |
| 5 | Cmd/Ctrl+W | Page:407-423（419 行调用） | **直接 `closeTab`，绕过 `closeTabWithSplit`** |
| 6 | Finder 工具栏「关闭应用」按钮 | `FinderBatchToolbar.tsx:282`（清选区顺带关）与 `:289-293`（独立按钮），props 链 Page:1326 `onCloseApp={handleCloseApp}` → `LearningHubSidebar.tsx:188,3854` | Page:998-1003 `handleCloseApp` → **直接 `closeTab(activeTabId)`，绕过 `closeTabWithSplit`** |

现象记录（不在本轮修）：入口 5、6 绕过分屏清理。`closeTab` 内部只通过 `pickNextActiveTab`（Page:262-277）避开分屏 tab 作为新活跃项，仅在 fallback 分支（Page:270-273）清 `splitView`；若被关的恰是右分屏 tab，`splitView.rightTabId` 悬空 → Container:165 `rightTab` 为 `undefined` → Container:219-223 右侧渲染 `splitView.empty` 空态。

### 1b. 关其他 / 关右侧（批量）

| # | 入口 | 触发代码 | 落点 |
|---|------|---------|------|
| 7 | 右键菜单「关闭其他」 | TabBar:378-386（382 行），TabBar:593 包装 tabId | Page:303-324 `closeOtherTabs`（isPinned 豁免，305 行 filter） |
| 8 | 右键菜单「关闭右侧」 | TabBar:388-398（398 行），TabBar:594 包装 | Page:326-349 `closeTabsToRight`（330 行 `i <= idx || t.isPinned`） |

两者内部自带分屏清理（Page:318-321、343-346），不经过 `closeTab`。

### 1c. LRU 淘汰（非用户显式）

| # | 入口 | 触发代码 | 落点 |
|---|------|---------|------|
| 9 | 打开第 MAX_TABS+1 个 tab | Page:239-249（`openTab` 内，243 行 `toEvict` = 最旧的非固定非活跃 tab） | **直接 `next.filter(...)` 删除（247 行），不经过 `closeTab`** |
| 10 | 保活实例淘汰（tab 仍在、组件卸载） | Container:26 `MAX_KEEPALIVE_TABS = 5`；Container:123-144 LRU 集合；Container:180-183 过滤后不渲染 | 不是「关 tab」，但等效于强制 unmount，编辑器只剩卸载 flush 兜底 |

### 1d. 事件驱动删除（非用户显式）

| # | 入口 | 触发代码 | 落点 |
|---|------|---------|------|
| 11 | dstu `deleted`/`purged` 事件 | Page:435-485（`dstu.watch('*')`，451 行按 `resourceId` filter） | 直接 `setTabs(filter)`，带活跃 tab 提示（474-479） |
| 12 | 恢复后校验删失效标签 | Page:199-229（211 行 `dstu.get(tab.dstuPath)` 失败即入 `invalidIds`） | 直接 `setTabs(filter)`（218-226）——过度清理点见 §2 |

### 1e. 离开页面

| # | 入口 | 现状 |
|---|------|------|
| 13 | 路由切走（Page 整体 unmount） | 所有面板卸载。无任何关闭前拦截；tabs 状态本身经 Page:195-197 持久化保留，但未保存草稿只靠各编辑器自己的卸载 flush |
| 14 | 窗口关闭（beforeunload） | learning-hub 内仅两处 flush 兜底：`apps/views/previewUtils.ts:239-241`（预览偏好）、`apps/views/EpubPreview.tsx:305-307`（epub 进度）。笔记/PDF 书签无 beforeunload 通道；`NoteContentView.tsx:463` 注释自述该风险 |

### 1f. dirty registry 接入现状：全部为「未接」

- registry 本体：`src/features/workbench/apps/content/contentDirtyRegistry.ts`（`isContentDirty` :47-60、`saveContentNow` :93-103、失败不放行语义 :100-102）。
- grep `isContentDirty|saveContentNow|registerContentDirtyChecker` 在 learning-hub 内的全部命中：
  - `apps/views/NoteContentView.tsx:45,323,380,413` — 仅自身内部用（外部更新时判断是否推进基线），不参与关闭门。
  - `apps/views/ExamContentView.tsx:47,494` — 注册了 checker（**归 E，禁改**；本轮只需消费其注册，不动其判分/store 调用点）。
- 上表入口 1-14 无一查询 registry：`closeTab` 是同步 `setTabs` filter；Container 不接收也不转发 `onSaveStateChange`（Container:32-42 props 定义、:92-102 UnifiedAppPanel 调用处均无该 prop，尽管 Panel:61 已声明支持）。
- 可参考的正确实现：`src/features/workbench/apps/content/createContentApp.tsx:62-70`（`canClose` → `isContentDirty` → 确认框 → `saveContentNow` 失败保窗口）。

---

## 2. persistedTabsCache 读写时序与过度清理（P8 地图）

### 2a. 读写点全景

| 代码 | 行为 |
|------|------|
| Page:115 `TABS_STORAGE_KEY = 'learning-hub-tabs-v1'` | localStorage key |
| Page:122 `let persistedTabsCache` | **模块级**缓存，生命周期 = renderer 进程 |
| Page:125-151 `loadPersistedTabs` | 仅当 cache 为 null 时解析 localStorage（126 行短路）；解析白名单只校验 `tabId/resourceId/dstuPath` 三个字符串（135-139），`type/title/openedAt/isPinned` 不校验 |
| Page:153-159 `savePersistedTabs` | 只写 localStorage，**不更新 `persistedTabsCache`** |
| Page:180-181 | `useState` 惰性初始化两次调用 `loadPersistedTabs`（cache 保证只解析一次） |
| Page:195-197 | `useEffect([tabs, activeTabId])` 每次变化调 `savePersistedTabs` |

回滚时序（learning-notes.md P2 第 1 点的现码对应）：会话内打开 A、B、C → localStorage 已是 {A,B,C}，但 cache 仍是启动时快照 {A}。同 renderer 内 Page 卸载再挂载（如路由离开又回来且组件未保活）→ 180-181 从旧 cache 恢复 {A} → 195-197 首次执行即用 {A} **覆盖回 localStorage**，{B,C} 丢失。

### 2b. 过度清理：校验键与加载键不一致（dstuPath vs resourceId）

- 恢复校验用 `tab.dstuPath`：Page:211 `await dstu.get(tab.dstuPath)`，失败即删（213-215 → 218-226）。
- 面板真实加载用 `resourceId`：Panel:213-217 明确注释「始终使用 resourceId」「dstuPath 可能是人类可读路径…会导致 Invalid DSTU path 错误」，实际请求 `/${resourceId}`（216-217）。
- 后果：资源仅被移动/重命名（实体仍在，稳定 ID 可解析）时，`dstuPath` 已过期 → 校验误判失效 → 标签被删。这正是 finder-hub.md §2「把『已移动』与『已失效』一起删除」的现码位置。
- 佐证反差：同文件内 dstu watch 删除逻辑（Page:444-451）就是按 path 尾段提取 `resourceId` 匹配的——删除通道用稳定 ID，恢复校验却用易变 path。

### 2c. 相关但独立的键语义记录

- tab 去重键 = `resourceId`（Page:234 `prev.find(t => t.resourceId === app.resourceId)`）；LRU 排序键 = `openedAt`（Page:245）；持久化损坏的 `openedAt` 会直接进入该排序（见 2a 白名单缺口）。

---

## 3. previewPersistence 进度 payload 与后端书签整数组覆盖的接缝（P5 地图）

### 3a. 前端：进度写目前仍会携带 bookmarks —— 是

- 快照：PP:136-138，控制器创建时对 `target.metadata` 白名单提取 `readingProgress/bookmarks`（`sanitizeProgressChannelMetadata` PP:73-97）。
- `mergeBase()`（PP:145-152）：`latestBookmarks ?? metadataSnapshot.bookmarks` 只要任一存在就放入 payload。
- `persistProgress`（PP:186-201）：payload = `mergeBase()` + 新 `readingProgress` → **单纯翻页的写入同时携带本控制器视角的完整 bookmarks 数组**（PP:189-192）。
- `flush`（PP:247-303）同样以 `mergeBase()` 起底（PP:260），关 tab / 切 node 的兜底落盘也带 bookmarks。
- textbook 书签另有双写：`updateBookmarksWithRetry`（PP:173-184），在 `persistBookmarks`（PP:211-218）与 flush（PP:267-284）内走 `vfsFileApi.updateBookmarks`；file 类型仅 setMetadata（PP:219）。
- 单实例内串行保证：`writeChain`（PP:134、231-234）只防同一控制器乱序，无资源级并发协议。

### 3b. 后端接缝（`src-tauri/src/dstu/handlers.rs:3561-3775`，只读核实）

| 分支 | 行号 | OCC | 行为 |
|------|------|-----|------|
| textbook `highlights` | 3564-3585 | 有（3573-3576 强制 `expected_updated_at`，走 `replace_highlights_if_version`） | 批注通道；这是 PP 文件头「payload 白名单」注释防误触的那条分支 |
| textbook `readingProgress` | 3589-3603 | 无 | `update_reading_progress(page)` |
| textbook `bookmarks` | 3607-3622 | **无，整数组覆盖** | `VfsTextbookRepo::update_bookmarks(&vfs_db, &id, bookmarks)`（3611） |
| files/file/image `readingProgress` | 3743-3758 | 无 | 同上复用 TextbookRepo |
| files/file/image `bookmarks` | 3760-3775 | **无，整数组覆盖** | `update_bookmarks`（3764） |

接缝结论：3a 的「进度写带旧 bookmarks」×3b 的「bookmarks 无条件整数组覆盖」= learning-notes.md P1 的跨窗口覆盖交错（窗口 A 加书签落盘 → 窗口 B 翻页把 B 创建时的空书签快照随进度写回 → A 书签被清）。第 2/3 轮前端可先行的最小切口：`persistProgress` 的 payload 去掉 bookmarks 字段（即进度写只含 `readingProgress`）；书签 CAS/增量协议属后端改动，不在本 wave。

### 3c. 调用方（控制器生命周期）

- `TextbookContentView.tsx`：创建 :101-118（快照 `node.metadata`）；上报 :503-510（`scheduleProgress`/`scheduleBookmarks`，Viewer 层直通、防抖只在 PP 层）；node.id 变更时 dispose+重建、unmount 时 dispose :552-571。
- `FileContentView.tsx`：创建 :192-200；重建/dispose :241-252；上报 :254-261。
- 现有测试 `apps/views/__tests__/previewPersistence.test.ts` 全部为单控制器用例（:39-180），无双控制器交错用例。

---

## 4. UnifiedAppPanel：按 resourceId 取资源 + 过期异步丢弃（现状：已正确，作基线记录）

- 加载键：`loadKey = resourceId:dstuPath:reloadNonce:localReloadNonce`（Panel:196），render 阶段同步进入加载态（Panel:197-202，「根据 props 调整 state」模式，消除旧内容多渲染一帧）。
- 请求路径：**始终 `/${resourceId}`**（Panel:216-217），`dstuPath` 只参与触发重载（deps Panel:245），不作为请求参数。
- 过期异步丢弃：`let cancelled = false` + cleanup 置位（Panel:206-207、227-231 前的 218 行 `if (cancelled) return`、240-242），resourceId 快速切换时旧响应被丢弃。
- 回调 ref 化防误重载：`onTitleChange/onClose/onNodeLoaded/onSaveStateChange` 全部走 ref（Panel:181-192），effect deps 只有 4 个加载键（Panel:245）。
- 类型路由：`SUPPORTED_TYPES`（Panel:112-114）、`strictType` 不匹配报错（Panel:271-277）、`resolvedType` 以 node.type 纠偏（Panel:278-282）。
- 与 §2b 的对照点：面板层已经完成「稳定 ID 加载」，恢复校验（Page:211）是唯一还依赖 `dstuPath` 有效性的地方——即修 P8 时无需动 Panel。
- 未消费能力：Panel:61 `onSaveStateChange` 在 Learning Hub 宿主链（Container:92-102）中未传入，是 P4 接 dirty/save 状态显示的现成挂点。

---

## 5. Finder host buckets 在 Hub 的 desktop/mobile 分桶调用点（只记录）

定义与解析（`src/features/learning-hub/stores/finderStore.ts`）：
- `FINDER_HOST_IDS`：:388-401（`files/page/page-mobile/canvas/canvas-mobile/group-picker`）。
- `HOSTS_SHARING_DEFAULT_BUCKET = {files}`：:412（files 落 default 桶，注释说明原因）。
- `resolveFinderHostId` :415-418；`finderPersistKey` :421-425（default 用旧 key，其余命名空间 key）；`useFinderStoreFor` :1286。

Hub 内调用点：
- Page:498-499：顶栏/抽屉读写宿主桶 `isSmallScreen ? FINDER_HOST_IDS.pageMobile : FINDER_HOST_IDS.page`（LH-HOST 注释：必须与本页访达同桶）。
- Page:1276：移动分支 `LearningHubSidebar hostId={FINDER_HOST_IDS.pageMobile}`。
- Page:1316：桌面分支 `LearningHubSidebar hostId={FINDER_HOST_IDS.page}`。
- `LearningHubSidebar.tsx:211`：`useFinderStoreFor(hostId)` 消费。

Hub 外同族调用点（记录以防实现员误伤）：`workbench/apps/files/FilesAppWindow.tsx:165`（files）、`chat/pages/ChatV2Page.tsx:217,890,1289`（canvas / canvasMobile）、`chat/components/groups/GroupEditorDialog.tsx:767`（groupPicker）。

语义记录（finder-hub.md §1 已裁定）：desktop/mobile 是两份独立历史，跨断点切换会看到各自的路径与视图偏好；这是测试固定的隔离语义（`finder-host-buckets.test.ts`）。**本轮及后续轮不做合桶建议**，任何触碰 Page:498-499 / 1276 / 1316 的改动都必须保持双桶不变。

---

## 6. 第 2/3 轮实现员插入点表

| 编号 | 目标 | 插入点（文件:行） | 要点 / 约束 |
|------|------|------------------|------------|
| P4-1 | 建异步 close gate（`requestCloseTabs(tabIds): Promise`），内部按 tab.type→registry typeId 查 `isContentDirty`，dirty 则确认/`saveContentNow`，失败保标签 | Page:279（`closeTab` 改为 gate 的最终提交步）；registry API 见 `contentDirtyRegistry.ts:47,93`；确认流参考 `createContentApp.tsx:62-70` | **ExamContentView 的注册/判分/store 调用点归 E，禁改**，gate 只消费 `isContentDirty('exam', id)` |
| P4-2 | 批量关闭走同一 gate | Page:303-324（closeOtherTabs）、Page:326-349（closeTabsToRight） | 保留 isPinned 豁免与分屏清理语义 |
| P4-3 | LRU 淘汰走同一 gate（dirty 时改淘汰次旧或放弃淘汰） | Page:239-249（openTab 内 `toEvict`） | 注意此处在 `setTabs` updater 内，需先改为异步预检再入 updater |
| P4-4 | 保活淘汰前 flush/拦截 | Container:139-144（keepAliveIds）、:180-183（过滤渲染） | dirty tab 不应被逐出保活集合（最小改法：keepAlive 排序时豁免 dirty） |
| P4-5 | Cmd+W 与 Finder 关闭按钮改走 `closeTabWithSplit`（顺带修分屏悬空空态） | Page:419、Page:1000 | 见 §1a 现象记录 |
| P4-6 | 离开页面兜底 | Page 顶层新增 unmount/beforeunload 钩子；现有样板 `previewUtils.ts:239-241` | dstu watch 删除通道（Page:435-485）可豁免 gate（实体已删），但笔记 dirty 仍建议提示 |
| P4-7 | 接 `onSaveStateChange` 显示 dirty 圆点 | Container:32-42（props）、:92-102（透传）、Panel:61（已有 prop）、TabBar tab 渲染处 | 纯增量，不动 Panel 加载逻辑 |
| P8-1 | `savePersistedTabs` 同步更新 `persistedTabsCache`（或删除模块级缓存） | Page:122、153-159 | 消除同进程 remount 回滚 |
| P8-2 | 恢复校验改稳定 ID：`dstu.get('/' + tab.resourceId)`，成功但 path/name 变了则重绑 `dstuPath/title` 而非删除 | Page:199-229（核心是 211 行） | 与 Panel:216-217 的加载键对齐；仅稳定 ID 确认不存在才删 |
| P8-3 | `OpenTab` 白名单解析补 `type/title/openedAt/isPinned` 校验（可版本化 v2 key） | Page:134-145 | 防损坏值进入类型分发（Panel:306）与 LRU 排序（Page:245） |
| P5-1 | 进度写只携带 `readingProgress`：`persistProgress` 不再从 `mergeBase` 带 bookmarks | PP:145-152（拆分 mergeBase）、:186-201；flush（:259-298）中「仅 progress pending」路径同样不得带 bookmarks | **handlers.rs 3561-3775 本轮只读不改**；书签 CAS/增量协议不在本 wave |
| P5-2 | 补两个控制器交错测试（A 写书签 → B 仅翻页 → 断言 B 的 setMetadata payload 无 bookmarks） | 新增于 `apps/views/__tests__/previewPersistence.test.ts`（现有用例 :39-180 全为单控制器） | 第 2/3 轮实现时随 P5-1 落地 |

依赖顺序建议：P8-1/P8-2 相互独立可并行；P4-1 是 P4-2/3/4/6 的前置；P5-1 独立于 P4/P8。所有插入点均不触碰 §5 的 finder 分桶调用点与 ExamContentView。

---

## 附录 A：关闭入口穷尽性 grep 底稿

`rg 'closeTab|closeOtherTabs|closeTabsToRight|closeTabWithSplit|handleCloseApp|toEvict|onCloseApp' src/features/learning-hub` 全部命中：

- Page：243/246-247（LRU evict）、279（closeTab 定义）、303（closeOtherTabs）、326（closeTabsToRight）、419（Cmd+W）、426-433（closeTabWithSplit）、531/1147（handleCloseAppRef）、998-1003（handleCloseApp）、1240/1249/1365/1378（onClose=closeTabWithSplit 传给 TabBar/Container）、1242-1243/1370-1371（onCloseOthers/onCloseRight）、1326（onCloseApp→Sidebar）。
- TabBar：131-134（按钮）、137-142（中键）、152-164（键盘）、371（菜单关闭）、378-398（关其他/关右侧）、589/593/594（tabId 包装）。
- `LearningHubSidebar.tsx`：188、3854（onCloseApp 透传）。
- `components/finder/FinderBatchToolbar.tsx`：54/91（prop）、282、289-293（两处 UI 触发）。
- `types.ts:141`（onCloseApp 类型声明）。
- 事件/校验删除（不含以上关键词，另行核实）：Page:435-485（dstu.watch）、Page:199-229（恢复校验）。
- learning-hub 内 `isContentDirty|registerContentDirtyChecker` 命中仅 `NoteContentView.tsx:45,323,380,413` 与 `ExamContentView.tsx:47,494`，证实关闭链全部未接 registry。
