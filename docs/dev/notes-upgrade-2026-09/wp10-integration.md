# WP10：学习属性、个人模板与学习视图接入

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
