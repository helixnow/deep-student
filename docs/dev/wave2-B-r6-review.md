# Wave2-B 第 6 轮复核

> 各链路复核员在本文件追加自己的段落。行号为本轮工作区实况。

## r6-review：保存链

> 角色：第 6 轮复核员-保存链。审查对象：`dstu/handlers.rs` createNote tags、
> `notesDstuAdapter.createNote` folderId、`saveTextAsNote` landed、
> Textbook/File/Essay 入口、quick-assistant 豁免。
> 核验三判据：一次提交、toast 不谎报目录、i18n key 对齐。

### 结论

**保存链五个审点全部通过，三判据全部成立。** 本轮补丁仅两类：
① `saveTextAsNote.ts` 头注按 r3 豁免裁决的遗留移交修正（快捷助手移出旧入口清单）；
② 账本（ledger §r3/§r4）挂账的保存链死键按死键流程清除（zh/en 各 6 键）。
无逻辑改动，未触碰 coordinator.rs。

### 证据链

#### 1. handlers.rs createNote tags —— 通过（fail-closed）

- `src-tauri/src/dstu/handlers.rs:803-820`：`metadata.tags` 缺省/Null → 空数组；
  是数组则逐项要求字符串，任一非字符串**整单拒绝**（`INVALID_ARGUMENT`），
  非数组同样整单拒绝，不存在静默丢标签。
- 数量/长度限额由 `note_repo::validate_tags` 在创建事务内兜底（handlers 注释自述，
  与 `create_note_with_conn` 链路一致）。
- 元数据更新侧（`parse_note_metadata_update`，handlers.rs:112-160）白名单
  `title|tags|isFavorite|props` 与 `notesDstuAdapter.updateNoteMetadata` 发送的键集吻合。

#### 2. notesDstuAdapter.createNote folderId —— 通过

- `src/dstu/adapters/notesDstuAdapter.ts:192-210`：第 4 参 `folderId?: string | null`，
  有值时 `metadata: { tags, folderId }`，缺省 `{ tags }`；与 `importMarkdownContent`
  的 folderId 传法一致。
- 后端解析（handlers.rs:728-752）：`metadata.folderId` 优先，`""|"root"` 归一为根，
  非 `fld_` 前缀降级为根（兼容形态，由前端 landed 回查兜住，见 #3）。

#### 3. saveTextAsNote landed —— 通过（回查保守化）

- 一次提交：`saveTextAsNote.ts:102-107` folderId+tags 随 `createNote` 单次调用；
  后端 `note_repo.rs:2220-2272` `create_note_in_folder` 用 `BEGIN IMMEDIATE` 事务，
  **目录存在性检查在事务内**（`folder_exists_with_conn`，不存在 → `NotFound` → 回滚），
  笔记与 `folder_items` 同事务落盘。旧两步 create+move 的部分成功窗口不存在。
- landed 判定：`saveTextAsNote.ts:82-85` 创建成功后回查 `folderApi.getFolderItems(folderId)`，
  只有确认 `itemId` 命中才报 `'folder'`；回查失败/未命中一律 `'root'`（保守不谎报）。
  跨界字段名核对：`vfs/types.rs:1343-1344` `VfsFolderItem` 带 `#[serde(rename_all = "camelCase")]`，
  `item_id → itemId` 与前端 `src/dstu/types/folder.ts:86` 对齐。
- 目录树刷新：仅 landed='folder' 补发 `item-added`（`saveTextAsNote.ts:115-124`），
  kind 在 `folderEvents.ts:10-19` 合法枚举内；落根由 DSTU watch 流覆盖，不补发。
- 行为契约由 `__tests__/saveTextAsNote.test.ts` 全量锁定（空内容拒写、单次提交、
  目录不可用整体失败、兼容降级报 root、回查失败不越权报 folder、事件只在确认后发）。

#### 4. Textbook / File / Essay 入口 —— 通过

- Textbook：`learning-hub/apps/views/TextbookContentView.tsx:813` → `TextbookPdfViewer`
  → `EnhancedPdfViewer`（`TextbookPdfViewer.tsx:255`）→ 懒加载 `PdfSelectionActions`
  （`EnhancedPdfViewer.tsx:82,3194`）→ `useSaveAsNoteFlow({ openSource: 'pdf-selection' })`
  （`PdfSelectionActions.tsx:93`）+ `SaveAsNoteFolderPicker`（:265）。批注面板导出同链
  （`PdfAnnotationsPanel.tsx:73`，openSource='pdf-annotations'）。
- File：`FileContentView.tsx:709` 同样经 `TextbookPdfViewer` 复用上述链路，无旁路直存。
- Essay：`EssayGradingWorkbench.tsx:1521-1546` `useSaveAsNoteFlow({ openSource: 'essay-grading' })`，
  拼好 Markdown 后 `startSaveAsNote({ content, title })` 进共享选目录流程；
  :1672 附近渲染 `SaveAsNoteFolderPicker`。不再 createNote 直落根目录。
- 三入口 toast 均由共享 `notifySaveTextAsNoteResult` 出（按 landed 措辞 + 「打开笔记」动作），
  无各自为政的成功文案。

#### 5. quick-assistant 豁免 —— 维持

- `src/quick-assistant/service.ts:227-247`：`saveAsNote` 仍 `dstu.create('/')` 直落根，
  头注指回 `wave2-B-r3-quick-assistant-exemption.md`。豁免两支柱复核仍成立：
  轻量窗无 FolderPickerDialog / showGlobalNotification / DSTU_OPEN_NOTE 消费方宿主；
  产品语义为一击即存捕获流。**未被本轮共享化改动波及，维持豁免。**
- 新发现（记录不改码）：r3 豁免文档 §2 称「metadata.source 是 dstu.create 直调才有的能力」，
  但现行后端 notes 分支只提取 `folderId` 与 `tags`（handlers.rs:728-820），
  `source: 'quick-assistant'` 实际**未落库**（`VfsCreateNoteParams` 无 metadata 透传）。
  不影响豁免成立（豁免依据是宿主与语义，不是 source 字段），但该来源标记若有
  产品用途需后端补承接——移交后续轮次裁决。

### 三判据

| 判据 | 结果 | 关键证据 |
| --- | --- | --- |
| 一次提交 | ✅ | handlers.rs:821-829 `create_note_in_folder` + note_repo.rs:2226 事务内目录检查/回滚 |
| toast 不谎报目录 | ✅ | landed 回查保守化（saveTextAsNote.ts:82-85）+ 测试锁 `never over-claims the folder` |
| i18n key 对齐 | ✅ | `saveAsNoteSuccessInFolder/AtRoot`、`saveAsNoteFailed`、`noContentToExport`（messageItem.actions）与 `saveAsNotePickFolder/saveAsNoteDefaultTitle/openNote`（selectionToolbar）zh/en 齐备，嵌套路径与代码引用逐键核对一致 |

### 本轮补丁（最小化）

1. `src/shared/notes/saveTextAsNote.ts`
   - 头注旧入口清单删去「快捷助手」并附豁免文档索引——执行 r3 豁免文档「遗留移交」
     （该文件 r3 时在裁决者禁改区，移交至今未落地）。
   - 「i18n 键由 i18n 员补充」过期注释改为「键已落库、defaultValue 仅兜底」。
2. 死键清除（zh/en 同步，均已全仓 grep 复核零代码引用，账本 §r3/§r4 挂账项）：
   - `chatV2:messageItem.actions.saveAsNoteSavedAtRoot`（旧两步「移动失败暂存根目录」语义，
     与现行「整体失败不落盘」不变式矛盾，属误导性残留）
   - `chatV2:messageItem.actions.saveAsNoteSuccess`（不带落点的旧成功文案，被两个 landed 变体取代）
   - `pdf:selection.note_saved / note_save_failed / note_default_title`（入口迁入共享流程后残留；
     `note_source` 仍被 PdfSelectionActions/PdfAnnotationsPanel 引用，保留）
   - `essay_grading:result_section.saved_as_note`（`save_as_note` 按钮键仍在用，保留）
   - 六个 JSON 均已通过 `JSON.parse` 语法校验。
3. 未清项（非保存链，留给 i18n 员整体复扫）：账本 §r4 挂账的
   `pdf:selection.quote_to_chat/create_note/generateQuestions/makeCards`、
   `pdf:toolbar.translate_selection` 等入口标签死键。

### 未验证声明

- 全部结论为静态读码 + grep 证据。本环境无 node_modules 且禁用 npm，
  vitest（`saveTextAsNote.test.ts` 等）与 cargo 编译均未运行；
  死键删除的安全性依据是全仓正则复核零非 JSON 引用。
- `coordinator.rs` 未读改（禁改区）。

## handoff（接缝三交接 · 第 6 轮复核员）

复核范围：`workbench/core/handoffDescriptor.ts`、`workbench/core/legacyNavigationMap.ts`（`handoffWorkbenchToLegacyShell`）、`App.tsx` 消费 effect（≈L2220-2309）、mode-off 两处调用点（`workbenchMode.persistWorkbenchModeEnabled` L174、`WorkbenchSettingsSection.handleModeChange` L322）。静态读码 + grep，未执行 npm/编译/vitest，未 commit/push。**四条核验全部通过，零补丁**（记账项均为有意设计或优雅降级，不构成必须动刀的缺陷）。

### 1. 消费一次即清 — 通过

- `consumeHandoffDescriptor`（`handoffDescriptor.ts:313-331`）在同一 try 块内 `getItem` 后**立即 `removeItem`**，之后才 parse / 判新鲜度——无论载荷坏、陈旧，条目都已删除，坏载荷不滞留。
- 全仓 grep 确认**消费方唯一**：`consumeHandoffDescriptor` 仅 `App.tsx:2244` 一处调用；`peekHandoffDescriptor` / `clearHandoffDescriptor` 生产代码零调用。经典壳挂载侧刻意不消费（r5-handoff 文档 §6 未接线②的双消费方裁决，本轮未推翻）。
- 重复触发防线：消费 effect 以 `prevWorkbenchActiveRef` 短路（`App.tsx:2235-2239`），currentView / 会话 id 变化引起的重跑 wasActive=true 直接返回；StrictMode 双执行 / 重挂载下 ref 重建为当前值（true）同样短路，不会二次消费或二次 launch。写侧 `saveHandoffDescriptor` 覆盖旧值（后发生的切换胜出），与一次即清自洽。

### 2. 移动不启 Workbench — 通过

- `workbenchActive = workbenchMode && !isMobilePlatform()`（`App.tsx:887`）永真拦截；消费 effect 再显式 `isMobilePlatform()` 护栏一次且**置于 consume 之前**（`App.tsx:2239`）——移动端不但不 launch，也不烧掉 descriptor（换回桌面端仍可交接）。
- launch 前 `await import(registerAll)` 后复查 `workbenchBus.isEnabled()`（`App.tsx:2275`），等待期间模式被关掉即放弃交接，杜绝 launch 误入 legacy 降级导航。桌面壳预热同样带移动护栏（`App.tsx:193`）。

### 3. 不合桶 — 通过

- `learning-hub/stores/finderStore.ts` grep 零 handoff 引用；descriptor 走独立 key `desktop.workbenchHandoff`（`handoffDescriptor.ts:63`）；`snapshot.ts` grep 零 handoff 引用（快照白名单纯净性不受影响）。
- `handoffDescriptor.ts` 依赖仅 windowStore + resourceWorkspaceRegistry（沿用 workbenchBus 的 core→apps/content 先例），不触碰任何分桶结构；跨壳连续性全部经 descriptor 通道，Finder 分桶隔离原样。

### 4. 不改窄窗卸壳 — 通过

- `workbenchActive` 表达式不含任何宽度项（`App.tsx:878-887` 注释块即 r2 裁决原文：窄窗是布局问题不整壳硬切，`shellStableSmallScreen` 仅存于注释）。
- `handoffWorkbenchToLegacyShell` 全仓仅两处调用，均在 mode-off 写通道（事务 ok + persist 成功之后、`setEnabled(false)` / mode-changed 之前），无任何 resize / isSmallScreen 触发路径；消费 effect 亦只观察 `workbenchActive`，与窄窗零交互。

### 交叉验证（消费/采集细节）

- 采集口径属实：`collectFocusHandoffDescriptor` 读 focusStack 栈顶，windowStore 不变量 1（`windowStore.ts:9`，focusStack 结构性排除 minimized 窗）保证「全最小化 → null」成立；单实例工作区（exam/essay/translation）回落 `getResourceWorkspaceActive`，与 workbenchBus 的 RESOURCE_WORKSPACE_TYPE_IDS 同口径。
- innerRoute 消费契约成立：`page:<n>` + PDF 类 typeId 走 `workbenchBus.openPdfPage`（`workbenchBus.ts:482`，typeId 白名单与 `PDF_PAGE_ACTIVATION_TYPE_IDS` 一致）；未识别前缀以瞬态 payload 透传不进快照。
- OS 专属应用（browser/flashcards/pomodoro）焦点 → `hasLegacyViewMapping` false → 不落盘不派发不弹提示（`legacyNavigationMap.ts:206`），与头注契约一致。

### 记录（非缺陷，不动刀）

1. **mode-off 资源级导航的 150ms 竞态（既有约定，优雅降级）**：handoff 派发的 `NAVIGATE_TO_VIEW learning-hub + openResource` 中，`LEARNING_HUB_OPEN_RESOURCE` 按 App.tsx 既有节奏延迟 150ms 派发（`App.tsx:1479-1481`），而 LearningHubPage 要等 `await closeBrowserForDisabledGate()` 完成、mode-changed 卸壳后才挂载监听——若 browser_close 慢于 ~100ms，资源级打开静默丢失，仅降级为视图级对齐。descriptor 已先落盘，切回 Workbench 的 round-trip 不受影响；150ms 模式为 legacy 派发链既有约定（`translateLegacyNavigation` 同构），现有调用顺序已由本轮事务复核员核准，不单方面重排。
2. **消费先烧后用**：`App.tsx:2244` consume 在 `await import(registerAll)` 之前，chunk 加载失败 / 等待期间模式被关掉时 descriptor 已删、本次交接放弃——与「尽力而为增强、绝不阻塞壳切换」的模块契约一致，接受。
3. **冷启动纠偏路径会触发消费**：localStorage 预读 false → 设置库 true 时 `setWorkbenchMode(true)`（`App.tsx:858`）构成会话内 false→true，消费 effect 会运行——与「冷启动直进桌面不消费」字面略有出入，但该路径可达时 descriptor 必为陈旧（正常 mode-off 后 settings 与 cache 同步为 false），15min 新鲜度窗口 + hydrate `preserveExisting` 双兜底，实际无害；effect 注释（`App.tsx:2229-2233`）已如实记载该时序，不改。
4. 两条 mode-off 写通道各自复制「persist → handoff → closeBrowser → setEnabled → dispatch」序列——本轮 handoff 视角逐行对表一致（两处调用点位次、try/catch + warn 均相同），后续改动需双侧同步（与事务复核员记账互证）。

## SOTA-笔记工作台（图谱 kind 分色 / 快速切换拖拽 / 最小命名桌面）

复核范围：r5「SOTA 笔记」（`wave2-B-r5-sota-notes.md`）与「SOTA 工作台」（`wave2-B-r5-sota-workbench.md`）落地面——`apps/notes/graph/*`（localGraph / NotesGraphTab / NotesLocalGraphView / CSS）、`NotesSearchOverlay.tsx` 拖源、`components/desktopNameStore.ts` + `core/persistedSettings.parsePersistedDesktopName` + `StatusBarBrandMenu` 重命名入口。**三项主体全部通过；落地 2 个最小补丁（i18n 遗留补键 + 启动回放时序守卫），详见下。**

### 1. 图谱边 kind 分色 — 通过

- 数据层：`localGraph.ts` 的 `LocalGraphEdgeKind = wikilink | noteref | unknown`，unknown 语义如实（入链行 `NoteBacklinkDto` 不带 linkType，不猜类型），两条补全通道逐行核对在位——双向借用（`collectNeighbors` 先建 `outgoingKindById`，`:107-117`）与无向边去重后的「见出链行即升级」（`addEdge` `:162-172`）。
- 渲染层：`NotesLocalGraphView` 边 className `notes-graph-edge-<kind>`；`NotesLocalGraph.css:158-161` noteref 边 `hsl(var(--info)/78%)` + `stroke-dasharray`（颜色+虚线双通道，非仅色觉），`--info` token 在 `styles/shadcn-variables.css:168,208`（明暗两套）均有定义，非悬空变量。wikilink/unknown 共用中性实线（`:150-153`），与 r5 文档声明一致。
- 图例噪声控制：`NotesGraphTab.tsx:280-281` `hasNoterefEdges` 门控，纯双链库不渲染图例；客户端降级图边恒 `wikilink`（`:109-123`），与降级仅解析 `[[..]]` 正文的数据能力对齐。
- 测试对合：`localGraph.test.ts:99-135` 覆盖四类定型（in-only=unknown、双向借用、noteref、幽灵 noteref）与深度 2 unknown 升级，断言与实现逐条一致（未执行）。

### 2. NotesSearchOverlay 结果拖拽 — 通过

- 拖源负载走既有 O19 协议：`onResultDragStart`（`NotesSearchOverlay.tsx:591-604`）→ `setWorkbenchDragData`（`useDesktopDrop.ts:152-164`，`WB_RESOURCE_MIME` JSON + `text/plain` 兜底 + `effectAllowed='copyMove'`），与 files 列表拖源 / 桌面落点桥同构，零新协议。异常负载（normalize 失败抛 TypeError）在 dragstart 捕获并 `preventDefault`，点击打开路径不受影响。
- dragend 语义（`:606-611`）：`dropEffect !== 'none'` 才经 `onCloseRef` 关面板（落点已接收），Esc/拖回取消保持面板打开——`onCloseRef` 随渲染更新（`:584-585`），无陈旧闭包。无遮罩 dismiss（document pointerdown capture）与 HTML5 拖拽无交互冲突（拖拽期间不产生 pointerdown）。
- 测试对合：`NotesSearchOverlay.test.tsx:536-572` 断言 draggable、MIME 负载往返、text/plain 兜底、取消不关面板/接收后关一次，与实现口径一致（未执行）。

### 3. desktopNameStore 最小命名桌面 — 通过（1 补丁）

- 存储通道：独立设置键 `desktop.workbenchDesktopName`（save_setting/get_setting，非 Tauri 回退 localStorage），热更新复用 `'workbench:settings-changed'` 既有契约；解析层 `parsePersistedDesktopName`（控制字符清洗 + 空白折叠 + 24 码点截断不劈代理对）坏值→null 回退品牌名。消费方 `StatusBarBrandMenu` 内联重命名（Enter 提交/Esc 取消/输入框按键不进菜单漫游）经 `persistDesktopName` 统一清洗，落盘失败仍派发事件（会话内先生效），与 `persistWorkbenchSetting` 同策略。单测 5 例覆盖清洗落盘/清除/热更新/坏值/无关键。
- **补丁（时序守卫）**：`ensureDesktopNameSync` 的启动回放（异步 get_setting）与热更新事件竞态时，晚到的回放会用陈旧值覆盖已到达的更新值（仅影响本会话展示，落盘值不受损）。加 `hotUpdateSeen` 旗标：事件先到则丢弃回放结果（`desktopNameStore.ts`，+3 行）。既有单测语义不受影响（无用例依赖事件后再回放）。

### 4. 核验：OCC 未改 — 通过

- OCC 主体在 `src/features/notes/NotesCrepeEditor.tsx`（含 `NoteContentView` 消费面），该文件最后一次变更为 `79362482`（0824-theme-mobile 合并），**不在 r5 提交 `aade198a` 的 56 文件清单中**；r5 全量 diff grep `baseVersion/base_version/occ/conflict` 仅命中 3 处文档叙述（r5 文档的「不碰 OCC」声明），零代码行。r5 触及的 `components/crepe/plugins/*` 为 pdfRef 只读链接插件（新文件），不进保存链。

### 5. 核验：快照白名单未扩正文 — 通过

- `core/snapshot.ts` / `core/types.ts` / `core/windowStore.ts` 均不在 r5 diff（snapshot.ts 最后变更 `ffef12c3`）；现行白名单 = `version / windows(壳字段) / dockPinned / tilingRatios / wallpaper / materialTier / desktopSize`，采集侧 `pickShellFields`（`snapshot.ts:274-288`）与校验侧 `sanitizeSnapshot` 双向核对，**无笔记正文、无桌面名、无 handoff 字段**。桌面名走独立 settings 键（见 §3），r5 文档「刻意不进 workbenchSnapshot」声明与实现相符；落盘前 `persistNow` 再过一次 sanitizer 双保险在位。

### 补丁清单（本节，共 3 文件）

1. `src/locales/zh-CN/workbench.json` / `en-US/workbench.json`：补 `notesWorkspace.graph.legendLabel/legendNoteref/legendWikilink` 各 3 键（r5-sota-notes §边界明文移交的遗留；zh：边类型图例/引用/双链，en：Edge types/Reference/Wiki link），JSON 解析验证通过；`NotesGraphTab` 的内联 defaultValue 保留作兜底。
2. `src/features/workbench/components/desktopNameStore.ts`：启动回放时序守卫（见 §3，+3 行）。

### 记录（非缺陷）

1. `useDesktopName` 在渲染期调用 `ensureDesktopNameSync`（模块级幂等旗标守卫）——StrictMode/并发渲染下安全，但属「渲染期副作用」范式；多 Space 演化时建议上提到宿主 effect，本轮不动。
2. 快速切换拖拽落点仅覆盖既有 O19 消费方；拖到树节点归档/分屏需树侧 drop 语义扩展（r5 已声明，维持挂账）。
3. 全部验证为静态读码 + grep + git diff 干跑，**未执行任何测试/编译/npm**；图例渲染、拖拽真机行为、重命名 IPC 往返留第 8 轮实测（建议纳入 `vitest src/features/workbench/apps/notes src/features/workbench/components`）。
