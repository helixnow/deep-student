# 0824 G 完整落地（备份树）

## 范围与输入

- 分支：`cursor/0824-g-landing-cde6`
- 正式基线：`origin/cursor/0824-cde6` @
  `362dd2dfc43c34f9fe4cf3962392f6ab6e5cdbf7`
- G：`origin/cursor/0824-theme-mobile-cde6` @
  `4ab24435bb998f7d24fed9e80e39746a4f44edb3`
- 合并方式：从最新正式基线新建分支，直接 `--no-ff` merge G；没有快进或合入旧预演分支。
- 裁决参考：
  - `origin/cursor/0824-rehearse-step5-fg-cde6` @ `0c07e5e23052`
  - `origin/cursor/0824-rehearse-step5-mobile-cde6` @ `bf8f1b72c866`
  - `origin/cursor/0824-rehearse-step3-fg-cde6` @ `60d1cbbf22f4`

基线已经包含 A/B/D/F 以及 `leftovers-safe`。本次以这些正式实现为主体，把 G 的
窄屏布局、coarse-pointer 命中区、Android 返回键和可见性守卫落到当前组件边界。
merge 共产生 52 个冲突（45 个内容冲突、7 个 modify/delete），均已解决。

## 逐冲突文件裁决

| 冲突文件 | 裁决 |
| --- | --- |
| `src/components/BatchOperationToolbar/BatchEditDialog.tsx` | 取 step5-FG 终态：保留正式批量编辑语义与 G 的移动布局/触控规则。 |
| `src/components/BatchOperationToolbar/FilterBuilder.tsx` | 取 step5-FG 终态：保留 F/A 表单结构，在现结构上保留 G 热区。 |
| `src/components/BatchOperationToolbar/index.tsx` | 取 step5-FG 终态：保留正式批处理状态机与 G 窄屏工具栏。 |
| `src/components/ErrorBoundary.tsx` | 取 step5-FG 终态：保留正式错误恢复与文案，叠加 G 移动可达性。 |
| `src/components/ExamSheetUploader.tsx` | 取 step5-FG 终态：保留当前上传/OCR 流程，叠加 G 响应式入口。 |
| `src/components/QuestionBankListView.tsx` | 取 step5-FG 终态：保留题库行为和 a11y 契约，叠加 G 44px 热区。 |
| `src/components/QuestionInlineEditor.tsx` | 取 step5-FG 终态：保留正式编辑器结构，叠加 G 窄屏操作区。 |
| `src/components/ReviewQuestionsView.tsx` | 取 step5-FG 终态：保留 D 的常显制卡入口、行内确认与 `cardAgent.startGeneration` 链路；G 的行、复选框和操作按钮热区继续保留。 |
| `src/components/SecurityStatusIndicator.tsx` | 取 step5-FG 终态：保留正式状态语义与 G 触控/a11y 增量。 |
| `src/components/dev/CrepeDemoPage.tsx` | 取 step5-FG 终态：保留 F 页面主体，在现有控件上应用 G 热区。 |
| `src/components/essay-grading/StreamingAnnotatedText.tsx` | 取 step5-FG 终态：保留 F 作文流式渲染主体与 G 窄屏呈现。 |
| `src/components/practice/PracticeModeSelector.tsx` | 跟随 F 删除；G 修改的是已被正式子应用结构淘汰的旧组件，不复活。 |
| `src/components/shared/Resizable.tsx` | 取 step5-FG 修复终态：同时保留比例持久化、`fixed` 小屏分栏和 coarse-pointer 拖拽热区。 |
| `src/components/skills-management/SkillsList.tsx` | 取 step5-FG 终态：保留 F 列表能力，叠加 G 移动操作区。 |
| `src/components/skills-management/SkillsManagementPage.tsx` | 取 step5-FG 终态：保留 F 页面结构，叠加 G 窄屏导航。 |
| `src/components/ui/DsDialog.tsx` | 取 step5-FG 终态：保留正式对话框协议与 G 移动尺寸/按钮热区。 |
| `src/components/ui/unified-sidebar/UnifiedSidebar.tsx` | 取 step5-FG 终态：保留 F sidebar 主体，叠加 G 触控和小屏规则。 |
| `src/features/anki-tasks/AnkiTasksApp.tsx` | 取 step5-FG 终态：保留 D/F 任务状态和只读闪卡边界，叠加 G 热区。 |
| `src/features/anki-tasks/components/SessionRow.tsx` | 取 step5-FG 终态：保留任务行语义，叠加 G 行级触控区。 |
| `src/features/chat/components/input-bar/InputBarUI.tsx` | 以最新正式 F 文件为底重放 step5-FG 相对 F-only 父树的 G 增量；拒绝旧巨型实现冲突块，把 Context ring、模型搜索、发送/停止及附件操作热区分别移到 `ComposerToolbar` / `AttachmentPanelBody`，同时保留 `ComposerTextarea`、`sendAvailability` 与 inline blocked hint。 |
| `src/features/flashcards/screens/StatisticsScreen.tsx` | 取 step5-FG 终态：保留 F 闪卡统计主体与 G 响应式操作。 |
| `src/features/flashcards/screens/TodayScreen.tsx` | 取 step5-FG 终态：保留 F 今日复习主体与 G 热区。 |
| `src/features/learning-hub/apps/views/EpubPreview.tsx` | 取 step5-FG 终态：保留 F 预览能力，叠加 G 移动视图。 |
| `src/features/learning-hub/apps/views/FileContentView.tsx` | 取 step5-FG 终态：保留 F 文件视图与 G 响应式操作。 |
| `src/features/learning-hub/apps/views/TextbookContentView.tsx` | 取 step5-FG 终态：保留 F 教材子应用主体与 G 热区。 |
| `src/features/learning-hub/apps/views/media/VideoPlayer.tsx` | 取 step5-FG 终态：保留 F 播放器行为与 G 移动控制区。 |
| `src/features/learning-hub/components/finder/FinderToolbar.tsx` | 取 step5-FG 终态：保留 F `ResizeObserver` compact 模式；触屏按钮维持 40px 视觉并用 `after:-inset-1` 扩到 48px 命中区。 |
| `src/features/learning-hub/components/finder/FolderPickerDialog.tsx` | 取 step5-FG 终态：保留 Finder 宿主语义与 G 移动选择热区。 |
| `src/features/learning-hub/views/IndexStatusView.tsx` | 取 step5-FG 终态：保留索引状态逻辑与 G 窄屏操作。 |
| `src/features/notes/NotesTabsBar.tsx` | 跟随 G 删除 legacy notes tabs。 |
| `src/features/notes/PreviewPanel.tsx` | 跟随 G 删除 legacy notes preview panel。 |
| `src/features/notes/__tests__/NoteTagsEditor.test.tsx` | 随被淘汰的 legacy editor 删除，不保留孤立测试。 |
| `src/features/notes/components/NoteTagsEditor.tsx` | 跟随 G 删除 legacy notes tags editor；当前 workbench notes 实现不受影响。 |
| `src/features/notes/reference-selector/ReferenceSelector.tsx` | 跟随 G 删除 legacy reference selector。 |
| `src/features/notes/reference-selector/__tests__/ReferenceSelector.test.tsx` | 随 legacy reference selector 删除，不保留孤立测试。 |
| `src/features/pdf/components/EnhancedPdfViewer.tsx` | 取 step5-FG 终态：保留 F 统一目录/缩略图/书签/批注侧栏及返回键守卫；四个移动 tab 均保留 coarse-pointer `!min-h-11`。 |
| `src/features/settings/components/CloudStorageSection.tsx` | 取 step5-FG 的 B×G 终态：保留清配置确认、重试、E2EE/巡检/导出链，并给新增操作保留 G 44px 热区。 |
| `src/features/settings/components/DataGovernanceDashboard.tsx` | **不用旧 F×G 文件**；逐字节采用 step5-mobile 修复终态，三方同存 A 的 tab 可访问名/DEV debug 门禁、B 的 E2EE zip password wiring、G 的 44px tabs。 |
| `src/features/settings/components/McpEditorSection.tsx` | 取 step5-FG 终态：保留 F 编辑器主体与 G 移动分支。 |
| `src/features/settings/components/McpToolsSection.tsx` | 取 step5-FG 终态：保留 F 工具/权限主体，并保留 G 两个小屏分支守卫。 |
| `src/features/settings/components/OcrEngineCard.tsx` | 取 step5-FG 终态：保留正式 OCR 状态与 G 触控规则。 |
| `src/features/settings/components/OcrEngineTestPanel.tsx` | 取 step5-FG 终态：保留正式测试流程与 G 移动操作区。 |
| `src/features/settings/components/VendorSidebar.tsx` | 取 step5-FG 终态：保留 F/0824 的 `dnd-kit` 实现和选择回调，不恢复旧 DnD renderer；叠加 G 热区。 |
| `src/features/settings/components/data-governance/RecordConflictsPanel.tsx` | 取 step5-FG 的 B×G 终态：保留 cloud-only DELETE keep-local/撤销批次，并保留窄屏 44px 热区。 |
| `src/features/todo/components/TodoMainPanel.tsx` | 取 step5-FG 终态：保留 F todo shell/详情能力与 G 窄屏布局。 |
| `src/features/workbench/apps/notes/NotesWorkspaceApp.css` | 取 step5-FG 终态：保留 F workbench notes 布局与 G coarse-pointer/窄屏样式。 |
| `src/features/workbench/components/DesktopContextMenu.css` | 取 step5-FG 终态：保留 F 菜单结构与 G 移动命中区。 |
| `src/features/workbench/components/EmptyDesktop.css` | 取 step5-FG 终态：保留 F 空桌面/tour 结构与 G 小屏样式。 |
| `src/features/workbench/components/ExposeOverlay.css` | 取 step5-FG 终态：保留 F expose 主体与 G 触控布局。 |
| `src/features/workbench/core/legacyNavigationMap.ts` | 取 step5-FG 终态：保留 F 当前 app 映射并接入 G 移动返回行为，不恢复旧 Finder API。 |
| `src/styles/responsive-utilities.css` | 取 step5-FG 终态：保留正式响应式工具集并叠加 G coarse-pointer 规则。 |
| `tests/vitest/secondarySurfaceShellContract.test.ts` | 以 step5-mobile 裁决刷新 step5-FG 的静默陈旧断言：保留 F template/Anki/skills/chat shell 契约，删除对已随 G 淘汰的 `NotesSidebarV2.tsx` 的读取与断言。 |

此外，按 step5-FG 的合并后修复恢复
`finderStore.ts` 的 `useHostFinderStore = useFinderStoreFor` 兼容导出；保留
`generateCardsFromText.ts` 对作文、错题和笔记共用
`cardAgent.startGeneration` 的 F 契约。附件上限保持单一事实源：
一般附件 200MB、图片 50MB。

门禁首轮还抓到旧 step5-FG InputBar 整文件裁决会覆盖正式 F 后续拆分与
`sendAvailability`。最终树不采用该整文件：先恢复 `362dd2dfc` 的拆分目录，再把
G 相对 step5-FG F-only 父树的 16 文件净增量三方重放；旧结构上的 7 个拒绝 hunk
分别迁入 `ComposerToolbar` / `AttachmentPanelBody`，其余 5 个
`InputBarUI` 44px hunk干净保留。

## 与正式 0824 推进量的差异摘要

step5 预演以 `4f05d227` 为基线；本分支从正式 `362dd2dfc` 起步。正式推进段已经：

1. 合入 F（workbench shell、Finder 每宿主分桶、InputBar 拆分、notes/practice 子应用）；
2. 落入 F 正式合并时的 i18n、Finder、qbank 和测试修复；
3. 合入 `leftovers-safe` 的 Generative UI ingress/sanitizer 与 HPIAS session
   isolation 加固。

因此相对 step5-FG 终态的差异集中在上述正式推进段（Generative UI/HPIAS、
Learning Hub 正式 F 落地修复及其测试），另有本次明确采用的
`DataGovernanceDashboard` step5-mobile 三方版本；没有发现无法由正式推进量或该
显式裁决解释的代码路径。开始合并时 `origin/cursor/0824-cde6` tip 即
`362dd2dfc`；完成全部门禁后再次 fetch，正式 tip 仍为 `362dd2dfc`，没有需要追加
比较或反向合并的官方推进。

## 关键合同与门禁

- legacy notes 删除集合保持不存在。
- Generative UI 闪卡保持 display-only；没有恢复独立 `save_to_library` 回流。
- 共享制卡入口使用 `cardAgent.startGeneration`。
- Finder compact 触屏命中区至少 44px；PDF 四个移动侧栏 tab 为 44px。
- InputBar 一般附件 200MB、图片 50MB，浏览器选择/拖放与 Tauri 路径共用限制函数。

最终代码提交 `5e57228fe` 上的门禁：

1. `npm ci`：通过，安装 lockfile 的 1192 packages。
2. `npm run build`：通过；prebuild 的版本生成、license check 与 TypeScript
   typecheck 均通过，Vite 转换 19808 modules，仅有既存循环 chunk/重复导入告警。
3. `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml --lib --locked`：
   通过（Rust 1.98.0、CI 同款 Linux 依赖与 PDFium），28 个既存 warning、0 error。
4. G/F/B/D 关键契约：25 files / 174 tests 全过，覆盖 mobile-uiux 三契约、
   secondary shell、DataGovernance A/B/G、cloud conflict、qbank、Finder host、
   display-only flashcard、`cardAgent.startGeneration`、附件 200/50 和 a11y。
5. F 拆分 InputBar 全目录：19 files / 171 tests 全过，覆盖 inline blocked hint、
   附件 chips、移动内联面板、工具栏、权限/推理/模型和发送可用性。

门禁产生的 `pdfium.txt` 临时改写已还原；PDFium 二进制与构建产物均为 gitignored，
最终工作树无验证残留。
