# WP10：学习属性、个人模板与学习视图接入

## 2026-09-22 当前接线合同（供主 agent / host agent）

- `noteRelations.ts` **已对齐实际后端** `docs/dev/notes-storage-contract-20260922.md`：`notes_relation_put({request})` 使用 snake_case 请求/响应；`list({noteId})`；`delete({id,expectedRevision})`；`notes_reference_status({resourceId,locator})`。不再使用 provisional upsert。source/page 使用 VFS resources.id，card/card 使用 document_tasks.document_id，mistake/question 使用 exam resource ID。
- `NoteLearningRelations` 已挂到 `NoteLearningPropertiesSection`（经典壳）及 `NotesWorkspaceApp` 属性页。内建来源阅读器/卡片预览、有效性检查、版本化 CRUD；无需 NoteContentView 额外挂第二份。
- `NotesLibraryView` 是独立笔记列表/状态/复习容器。`LearningHubPage` 桌面和移动分支已通过 `NotesLibraryEntry` 接入“学习资源 / 笔记学习”入口；打开仍走 `handleOpenApp`。没有向混合 Finder 添加学习 viewMode。
- `CreateLearningNoteDialog` 在工作台文件侧栏“新建 → 新建学习笔记”和经典笔记学习库可达。明确选择空白 / 课程默认 / 指定模板，默认空白；课程输入、手动属性优先于模板预设。
- 实际 `dstu_create` 的 notes 分支（handlers.rs）只消费 tags，不保存 props。前端已使用 `createLearningNote → finishLearningNoteCreation`：创建正文后，通过 get/setMetadata(OCC)/get 保存属性；失败显示“正文已创建，属性尚未保存”，提供同 ID 重试或打开已创建笔记，避免重复创建。**后端可选 needs**：若要真正原子初始化，应让 note 创建事务接受 props；本轮前端不依赖尚不存在的能力。

### Host agent 精准 needs

`NotesTemplatePanel` 的 `documentHost` 已扩展（深导入 `noteTemplates.ts`）：

```ts
getDocument(): { noteId: string; revision: number; markdown: string };
replaceDocument(markdown, baseline): Promise<NoteTemplateDocument | boolean | void>;
getInsertionPoint?(): { from: number; to: number };
insertDocument?(markdown, baseline, position: {from:number;to:number}): Promise<NoteTemplateDocument | boolean | void>;
```

`getInsertionPoint` 必须返回编辑器失焦前记住的选区；坐标为 Host 原生坐标（分页映射由 Host 负责）。`insertDocument` 再次检查 noteId/revision 和选区有效性，插到该位置并走正常保存。返回 false/reject 代表未成功，UI 保留预览。个人模板的追加已直接走全文 Host 的版本检查和 replaceDocument，保留原文字节前缀；替换继续使用显式确认。**请按 noteId 为模板面板设 key**。正文模板操作不隐式修改属性。

面板另接可选 `learningPropsHost: NoteTemplateLearningPropsHost`：

```ts
getProps(): { noteId: string; props: Record<string, unknown> };
saveProps(next, baseline): Promise<void>;
```

`saveProps` 需以 baseline 做 `mergeNotePropEdits`、最新 metadata OCC 写入，失败 reject；不推进正文 token。个人模板预览中的“应用属性预设”只填未设置字段，未知/非法旧值保留。已有属性编辑器的“从个人模板填入属性预设”继续可用，不依赖此可选 Host。

locale 由主 agent 补：新增键位于 `notes:learning.mapping.* / learning.relations.* / learning.create.* / learning.library.* / learning.confirm_latest` 与 `personalTemplates.insert/inserted/preset_preview/apply_preset/preset_applied/errors.no_selection`；源码均提供中文 defaultValue，可直接提取。

### 本轮实现与验证结果

- 旧自由属性：`LegacyLearningPropsMapper` 已在真实 `NoteCustomPropsEditor` 中可达；选择来源、明确目标值、前后预览、应用、撤销。来源键与未知值不删除；应用检查来源/目标变化，撤销只恢复本次目标差异，保留其他并发修改。失败保留预览，切篇随 note key 重挂载。
- 学习字段草稿保留开始编辑时的基线，同字段并发更新不会被新的 props 悄悄覆盖。失败后提供“已核对最新值，保留草稿重试”。工作台丢弃旧版本 metadata 事件，三视图共享列表。
- 个人模板加本地 revision，防同一 WebView 的两个编辑面板互相覆盖。现有 settings 仓库不提供跨 WebView 原子 CAS；这里不声称增加了后端事务。正文操作三种语义与失败/换篇/版本检查均已有 UI 和测试。
- 关系 UI 提供 PDF/卡片/题目集选择器，分页读真实 DSTU / Anki library / qbank APIs。业务 source ID 与底层 resource ID 明确区分；PDF 阅读器用 source ID 挂载并等待页码定位 ACK，错题使用 qbank 定位事件，卡片按真实 document/card ID 读取。失效关系仍显示；显示标题实时解析，不参与关系身份。手工 ID 输入折叠在高级入口。
- 验证：17 文件、122 项整组回归通过；收尾补充“显式清除模板课程”用例后，受影响 3 文件、9 项再次通过（当前定向覆盖共 123 项）。`npm run typecheck:native -- --pretty false` 最终通过。
- `noteRelations.ipc.test.ts` 绕过 vitest 对 core 的全局 alias，使用真正 `@tauri-apps/api/core.js` 的 invoke，经 Tauri mockIPC 验证注册命令、snake_case request、typed locator、CAS/delete 参数和错误传播。这是 IPC 边界合同测试，**不是运行中的 Rust 后端端到端验收**；本轮未启动桌面或运行视觉测试。
- 初次交接时尚缺 `getInsertionPoint/insertDocument` 和 `learningPropsHost`；主代理整合现已在 `NotesCrepeEditor` 通过 `templateDocumentHost` / `useTemplateLearningPropsHost` 接通。模板入口收拢至“页面 → 笔记模板”，先记住正文选区再打开面板。最新验证边界见 `docs/dev/notes-host-integration-20260922.md`。
- 所有本轮编辑均经 apply_patch；未 commit、stash、reset 或还原工作区。

下方为上一轮接入记录，当前合同以上述段落为准。

## 真实入口核验

- 经典壳：`App.tsx` → `LearningHubPage` → `UnifiedAppPanel` → `NoteContentView` → `NotesCrepeEditor`。
- 工作台：`apps/registerAll.ts` 导入 `notes/register.ts`；注册项的 lazy render 为 `NotesWorkspaceApp`。工作台内的笔记仍由 `UnifiedAppPanel` / `NoteContentView` 渲染。
- 因此 `NotesWorkspaceApp` 有真实消费者，但只修改它不会给经典壳 / learning-hub 自动加上属性和学习视图。

## 已接入的功能

- 工作台属性页通过现有 `NotesPropertiesTab` → `dstu.setMetadata(path, { props }, versionToken)` 持久化。新字段仅写入用户明确编辑的字段，保留旧属性与旧值。工作台以资源 ID 为 `NotesPropertiesTab` 的 key，切篇清除表单草稿；同篇 metadata 刷新不会清掉正在输入的字段。
- `metadata.props` 的四个键都是字符串：`study_course`、`study_chapter`、`study_mastery`、`study_review_date`。下划线适配现有 `key:value` 搜索语法，不需要改搜索 parser。
- 掌握状态：`unstarted` / `learning` / `needs-review` / `mastered`；日期：真实有效的本地日历 `YYYY-MM-DD`。课程和章节为最长 512 字符的单行文本。旧的 `course/status/due` 等属性不会自动迁移，未知类型化旧值显示“旧值保留”，只有用户编辑该字段后才覆盖。
- 工作台文件区的视图选择器支持文件树、笔记列表、掌握状态分组、近期复习。后三者使用同一 `filteredResources`，沿用标题 / 标签筛选。近期复习包含所有逾期项及今天起未来 7 天，按日期排序。metadata-only 的 DSTU 事件现在会更新工作台资源；比较采用逐键标量比较，不做序列化哈希。
- 现有 `NotesTemplatePanel` 内加入个人模板：编写 / 修改、保存、重新读取、Markdown 预览、追加到笔记末尾。经典壳和工作台都会消费这个面板。模板存储使用设置仓库的 `notes.personalTemplates.v1`，原生端通过现有 `get_setting` / `save_setting` 命令；读取失败时不会把库当空库覆盖。模板数据是数组，不与笔记正文或属性一起做隐式迁移。
- 追加使用现有回调及 `applyNoteTemplate`；非空原文逐字保留为前缀。空模板不清空笔记。模板保存失败保留输入，替换失败保留预览及原文。
- 经典壳现已接通：`NoteContentView` 的桌面及移动端 `NotesContextPanel.beforeOutline` 都挂载 `NoteLearningPropertiesSection`，内部复用真实 `NoteCustomPropsEditor`。仅新增入口，保留全文 agent 的全文快照、分页和回滚实现。
- 个人模板增量字段：`defaultForCourse?: string` 和 `learningPreset?: NoteLearningProps`，仍存原有 v1 数组；旧模板无须迁移。模板面板可设置 / 取消课程默认、编辑四种属性预设。同一课程只保留一个默认，重新指定不会删除原模板。所有属性编辑器的“从个人模板填入属性预设”按当前课程（包括正在填写的课程）优先选择默认模板，先预览，再显式填入未设置字段；已有旧值与草稿保留，点击“保存学习属性”才写入笔记。模板正文追加 / 替换与属性预设填入是独立、明确的操作。

## 集成接口与边界

### 1. 完整笔记转模板 / 确认替换

`NotesTemplatePanelProps` 新增可选 `documentHost: NoteTemplateDocumentHost`，类型从 `src/features/notes/noteTemplates.ts` 深路径导入。宿主可使用当前已有 `FullDocumentApi` 提供：

```tsx
documentHost={{
  getDocument: () => fullDocumentApi.getFullDocument(),
  replaceDocument: (markdown, baseline) =>
    fullDocumentApi.replaceFullDocument(markdown, baseline),
  variables: { title: noteTitle, locale: i18n.resolvedLanguage ?? i18n.language },
}}
```

仅当编辑器已就绪且可写时传入，并按 `noteId` 为面板设置 React key。

`getDocument()` 必须返回包含未保存编辑的**完整**文档 `{ noteId, revision, markdown }`，不能用分页窗口的 `getMarkdown()` 或从存储读取的旧正文。`replaceDocument` 必须校验 baseline，并走正常持久化保存链路；失败抛错或返回 false。组件预览时保留原文快照，替换前要求明确勾选，检查当前身份 / 版本 / 全文均未变化，再调用宿主。没有此接口时，界面提供个人模板编写、保存、预览和追加，不显示“从当前完整笔记填入”和“确认替换正文”。

现有 `onApplyTemplate` 支持 `void | Promise<void>`。建议宿主让追加失败 reject，便于面板就地显示错误；当前 `NotesCrepeEditor` 会捕获错误并显示全局通知。

### 2. learning-hub 属性区（已接通）

在用户授权编辑 `NoteContentView` 后，桌面属性侧栏与移动属性子页均已这样接入：

```tsx
<NotesContextPanel
  // 原有标题、标签、大纲参数保持原链路
  beforeOutline={
    <NoteLearningPropertiesSection
      key={`${noteId}:${node.path}`}
      node={node}
      readOnly={readOnly}
    />
  }
/>
```

新组件维护**独立的属性版本基线**，不会推进正文编辑器的 OCC token：

1. 属性区展开后通过 `dstu.get` 读取实际 metadata，订阅 metadata 更新；不使用旧的传入 node.props 作为可写数据。
2. 保存时捕获当前展示基线，再读最新节点，仅合并用户编辑的键，保留其他位置添加 / 修改的键。同键并发修改会显示冲突、刷新旧值并保留输入供用户核对重试。
3. 使用最新读取节点的 `updatedAtToVersionToken` 调用 `dstu.setMetadata`；若已有更新的 watch 版本、身份改变、只读、无版本或读取失败，则不写入。
4. 写入后重新读取节点以更新基线。刷新失败也如实提示“属性已写入，但刷新失败”，不误清草稿。切篇中尚未开始的写入取消，已开始的旧篇写入完成后不会回写新篇状态。

`NoteLearningPropertiesSection` 已包含属性 CSS；同篇元数据刷新保留草稿，按 ID/path 重挂载避免切篇串扰。

### 3. learning-hub 学习视图

本轮评估：`LearningHubSidebar` 的 `FinderToolbar` / `FinderFileList` 是混合资源浏览器，现有 viewMode 服务整个资源库，没有自然的独立笔记学习列表容器。本轮未向该浏览器增加学习模式。若后续有独立笔记入口，可复用 `src/features/notes/components/NoteLearningViews.tsx`：

```tsx
<NoteLearningViews
  notes={filteredNotes}
  view={view /* 'list' | 'status' | 'review' */}
  activeId={activeNoteId}
  onOpen={openNote}
/>
```

节点结构是 `{ id, name, type, metadata? }`，直接接现有 DSTU 节点；由宿主负责加载、错误、搜索筛选和订阅，不建立第二份笔记库。容器需要有确定高度以供列表滚动。

## 验证

首轮：9 个测试文件、92 项测试全部通过（其中工作台现有回归 57 项）；`npm run typecheck:native -- --pretty false` 通过。针对性测试覆盖真实工作台宿主事件链、属性页版本化写回及重挂载读取、旧字段与非法旧值保留、复习日期边界、同篇刷新保留草稿 / 切篇清除草稿、原生设置命令的保存 / 重读 / 失败、个人模板 UI、确认替换及过期快照拒绝。未执行真实桌面视觉验证。

测试文件：

- `src/features/notes/__tests__/noteLearningProps.test.ts`
- `src/features/notes/__tests__/personalNoteTemplates.test.ts`
- `src/features/notes/__tests__/noteTemplates.test.ts`
- `src/features/notes/components/__tests__/PersonalNoteTemplates.test.tsx`
- `src/features/notes/components/__tests__/NoteLearningPropsFields.test.tsx`
- `src/features/workbench/apps/notes/__tests__/NoteCustomPropsEditor.test.tsx`
- `src/features/workbench/apps/notes/__tests__/NoteLearningPersistence.test.tsx`
- `src/features/workbench/apps/notes/__tests__/NotesLearningViews.host.test.tsx`
- `src/features/workbench/apps/notes/__tests__/NotesWorkspaceApp.test.tsx`

经典壳续接的定向验证：新增 `tests/vitest/learning-hub/NoteContentView.learningProps.test.tsx`，覆盖桌面 / 移动端真实属性入口、版本化连续保存、旧自由属性保留、同键冲突、写入 / 读取失败保留草稿、切篇请求失效、乱序读拒绝、只读 / 维护模式，以及属性保存不提前推进正文版本。复跑全文 agent 的 `NoteContentView.windowing.test.tsx`（17 项）通过。个人模板测试新增课程默认替换、旧模板兼容、预设持久化、实际属性草稿填入与已有值保护。

续接本轮累计 8 文件、47 项定向测试通过，最终 `npm run typecheck:native -- --pretty false` 通过。测试集合：`NoteContentView.learningProps`（7）、`NoteContentView.windowing`（17）、`notePropEdits`（2）、`personalNoteTemplates`（6）、`PersonalNoteTemplates`（4）、`NoteLearningPropsFields`（1）、`NoteCustomPropsEditor`（8）、`NoteLearningPersistence`（2）。

所有修改通过 apply_patch；未执行 commit / stash / reset / checkout / clean。续接仅在授权的 `NoteContentView` 增加属性区入口；没有修改 LearningHubPage / LearningHubSidebar / NotesEditorHeader / Toolbar / NotesCrepeEditor，历史与正文模板宿主接线仍由主 agent 负责。
