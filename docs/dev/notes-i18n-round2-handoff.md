# 第二轮 notes i18n 交接

基线：`502a0ce39`。扫描覆盖 `git diff` 涉及的前端文件及未跟踪新文件；包含字符串 fallback、动态布局/移动工具条/search worker key、history notice 间接 key。并发工作区仍在变化，下列行号用于定位，接入时以原文搜索为准。

## 本次完成

- `src/locales/{zh-CN,en-US}/notes.json` 增量添加 144 个实际消费 key。没有重排 JSON、删除或改写旧产品词条。
- 范围包括学习库、新建学习笔记、旧属性映射、资源关系/选择器/预览、模板插入与预设、全文搜索范围/search worker 错误、历史选段/差异/覆盖/保留规则、块链接/拖放/跨笔记移动、桌面和移动分栏命令，以及并发新增文件涉及的标签重命名/双链空态。
- 实际组件名为 `NoteLearningRelations`，不是 `NoteRelationsPanel`。`NotesLibraryView`、`CreateLearningNoteDialog`、`LegacyLearningPropsMapper` 和关系组件组原有用户文案已使用 `t(..., { defaultValue })`；补齐资源后直接消费英文，保留全部中文 fallback。
- `noteDraftPersistence.ts` 的 4 条裸中文改为 `notes:draftPersistence.{save_unconfirmed,recovered,save_before_discard,delete_unconfirmed}`；读取历史草稿时保留原始已存错误详情。
- 新增 `src/features/notes/__tests__/notesRound2.i18n.test.tsx`，绕过默认中文 React i18n mock，以真实 `react-i18next` + `i18next` + 中英文 notes 资源验证英文界面、用户数据保留及草稿错误路径。
- 真实英文组件/草稿测试 7 项、现有中文学习组件测试 10 项通过。AST/真实 i18next 增量核验：144 个新增 key 有消费者、双语可解析、无重复 JSON key、插值变量一致、原 fallback 保持一致、基线旧值全部保留。静态 `t()` 缺键为 0。

## 待 host/editor 负责人接入的原文

以下还没有实际 key 消费调用，因此本轮未向 locale 填入预占键。接入时保留对应 fallback 原文；已有适用键可复用。调试日志、用户内容、Markdown 语法和事件名不计为 UI 硬编码。

### AI 范围、落点与逐组审阅

- `src/features/notes/AIDiffPanel.tsx:273`：`范围`、`AI 编辑范围`、`选区`、`当前块`、`当前章节`、`整页`。
- 同文件约 281：`落点`、`AI 结果落点`、`替换`、`插入下方`、`另存结果`。
- 同文件约 288：`接受此组会立即保存到笔记；其余建议保留。表格、折叠块和提示块按块审阅。` 旧 `aiDiff.staged/atomic` 文案必须保留给旧消费者；不要用旧的“统一保存”文案替代新语义。
- `src/features/notes/OfficialDiffReview.tsx:28,45`：`审阅实例已关闭。`、`候选内容逐组审阅`。
- `src/components/crepe/officialDiffAdapter.ts:64,72,110,142,155`：`接受此组`、`拒绝此组`（可复用 `aiDiff.accept_group/reject_group`）、`候选 Markdown 无法解析。`、`审阅分组已变化，请重新打开审阅。`、`审阅已挂起。`。
- `src/features/notes/officialDiffContract.ts:45`：`审阅范围已过期，请重新选择范围。`。

`src/features/notes/aiReview.ts` 新增裸错误（原 `aiReviewError()` 动态调用已核验现有资源）：

| 约行号 | fallback 原文 |
| --- | --- |
| 254 | 审阅尚未就绪。 |
| 255 | 审阅已结束。 |
| 263 | 请先重试上一组的保存，再处理其他建议。 |
| 266 | 候选审阅结构与正文不一致，请重新打开审阅。 |
| 275 | 审阅状态尚未保存，请重试。 |
| 279 | 另存结果接口尚未就绪。 |
| 282 | 保存失败后候选已变化，请重新审阅。 |
| 283 | 笔记保存接口尚未就绪。 |
| 290 | 笔记窗口已变化，审阅结果已保留供恢复。 |
| 344 | 审阅编辑器尚未就绪，请展开候选后重试。 |
| 376 | 笔记版本已变化，候选和已接受组已保留。请重新生成建议。 |
| 381 | 已接受组请通过检查点撤销。 |
| 382 | 审阅编辑器尚未就绪。 |
| 404 | 范围选择接口尚未就绪。 |

### 格式、草稿、全文 host

`src/features/notes/NotesCrepeEditor.tsx`：

- 状态/错误原文：`笔记等待刷新。`、`笔记等待刷新，已阻止过期草稿保存。`、`笔记保存版本不可用。`、`笔记操作尚未完成，请刷新后重试保存。`、`笔记已切换。`、`审阅交互锁尚未就绪。`、`此笔记宿主尚未提供完整刷新能力。`、`请等待图片上传完成或取消上传后再操作。`、`笔记草稿尚未确认保存，已取消操作。`、`笔记已更新，正在刷新正文。`。
- 草稿控件/通知：`恢复草稿`、`草稿已另存为笔记。`、`重试刷新`、`草稿持久化失败：`、`重试草稿存储`、`已找到未保存草稿`、`查看草稿`、`草稿另存为笔记`。其中保留/恢复/复制草稿的旧 `editor.*` keys 已存在，勿重复造键。
- 导出/块入口：`加载全文以使用块操作`、`导出笔记`、`普通 Markdown`、`Markdown（保留布局）`。

`src/features/notes/noteEditorHost.ts`：

- `无法确认笔记格式。`
- `此笔记格式需要更新版本的编辑器；已暂停编辑。`
- `笔记编辑器尚未就绪。`
- `引用的笔记块已删除或无法定位。`
- `启用分栏后，此笔记需要支持分栏格式的版本才能编辑。是否启用？`
- `启用分栏`

`src/features/notes/noteHostCoordinator.ts`：

- `笔记编辑器打开超时，请重试。`
- `笔记正在执行另一项操作，请稍后重试。`
- `同一笔记存在不同的未保存草稿。请先处理各窗口的草稿冲突。`
- `检测到多个应用窗口。跨窗口草稿写锁尚未就绪，请关闭其他窗口后再执行此操作；草稿未改动。`

`src/features/notes/noteReviewHost.ts`：

- `无法精确定位所选范围。`
- `笔记编辑器尚未就绪。`
- `无法读取完整笔记。`
- `请先在笔记中选择文本。`
- `审阅副本缺少原保存版本，请重新审阅后另存。`
- `另存笔记未得到持久化确认。`

`src/features/learning-hub/apps/views/NoteContentView.tsx` 新增约 357/378：`笔记已切换，无法刷新原编辑器。`、`笔记更新已提交，但刷新失败；请重试刷新后继续编辑。` 其余旧错误已有 `backend_errors:note_content.*` 包装，勿仅因 fallback 中有中文重复处理。

`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx` 约 1359：`保存失败，已保留窗口与草稿。`。

并发期间新增 `src/features/notes/NoteFormatGate.tsx`：`正在确认笔记格式…`、`笔记原文只读视图`、`此笔记使用尚不支持的格式，已显示完整原文。请使用兼容版本编辑。`、`复制失败，请重试。`、`复制完整原文`、`导出笔记原文`、`导出原文`、`完整笔记原文`、`重新检查格式`。

### 模板 host 与分栏正文

并发期间新增 `src/features/notes/noteTemplateHost.ts`：

- `请先在编辑器中选择插入位置。`
- `请在编辑器中选择位置，再重新打开模板面板。`
- `插入位置已失效，请重新打开模板面板。`
- `插入位置已改变。`

并发期间新增 `src/features/notes/useTemplateLearningPropsHost.ts`：

- `笔记属性不可用。`
- `笔记已切换。`
- `笔记属性仍在加载，请稍后重试预览。`
- `笔记已切换或不可编辑。`
- `维护期间无法保存属性。`
- `笔记属性归属已变化。`
- `属性保存版本不可用。`

`src/components/crepe/plugins/columns/commands.ts:9` 的 `DEFAULT_CORNELL_LABELS`：`线索（Cues）`、`笔记（Notes）`、`总结（Summary）`。`NoteLayoutCommands` 默认走这个对象，英文 UI 插入分栏仍可产生中文标题。命令菜单 `layout.*` 和移动栏 keys 已补齐；正文标题要由创建时的语言生成，不能转换用户已有正文。

`noteTemplates.ts` 现有中英文内置模板数据已按 locale 选择，不属于漏翻；真实英文 UI 测试覆盖了 Lecture notes 和 Core concepts。

### 英文裸错误同样需要本地化

`src/components/crepe/blockTransfer/service.ts` 的错误会传给对话框/通知，不只是内部日志：

- `Duplicate block ID: ${existing}` / `${id}`
- `Unsupported block identity target.`
- `This note contains root syntax unsupported by stable blocks.`
- `Missing root block source position.`
- `Invalid block identity span.`
- `Select distinct blocks to move.`
- `Block ID collision: ${id}`
- `Block no longer exists: ${id}`
- `Unsupported note format.`
- `Stable note contains unmarked blocks.`
- `Note changed before identity upgrade. Select the blocks again.`
- `Choose a different target note.`
- `Operation ID reused for a different move.`
- `Note identity changed.`

## 后端错误/历史副本交接

未修改后端，也没有为尚未调用 `t()` 的错误码预填 locale。需要在实际用户展示边界将稳定码映射为文案，同时保留错误码供 CAS/冲突逻辑使用：

- `src-tauri/src/vfs/repos/note_state_repo.rs:169`：`notes.state_conflict`。草稿和审阅状态 IPC 当前会把原错误透传；本轮草稿 helper 的 4 条自身确认错误已翻译，这个后端码没有改变。
- `src-tauri/src/vfs/repos/note_review_repo.rs:48,55,60,75`：`notes.review_request_reused`、`notes.operation_id_reused`、`notes.review_conflict`。
- 同文件约 91 的新笔记标题固定后缀：`（AI 审阅副本）`。不能靠前端 notes.json 翻译后端已生成的用户标题。
- 历史 copy/restore 的显示入口与通知 `history.restore_copy/copy_created`、`history.description_full/selection_*/overwrite_*` 已有真实双语 key；`src-tauri/src/vfs/repos/note_revision_repo.rs:297` 生成标题的固定后缀 `（历史副本）` 仍需后端/IPC 负责人决定如何传递创建时语言。旧笔记标题不应在切换语言时改写。

测试命令：

```sh
npx vitest run src/features/notes/__tests__/notesRound2.i18n.test.tsx src/features/notes/noteDraftPersistence.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/features/notes/__tests__/NotesLibraryView.test.tsx src/features/notes/components/__tests__/CreateLearningNoteDialog.test.tsx src/features/notes/components/__tests__/LegacyLearningPropsMapper.test.tsx src/features/notes/components/__tests__/NoteLearningRelations.test.tsx --maxWorkers=1 --minWorkers=1
```

本轮没有 commit、还原或修改其他 agent 的核心 host/editor/backend 文件。
