# 0824 主题合并预演：subapp × mobile

## 范围

- 主体分支：`origin/cursor/0824-theme-subapp-cde6`（F）
- 合入分支：`origin/cursor/0824-theme-mobile-cde6`（G）
- 预演分支：`cursor/0824-rehearse-subapp-mobile-cde6`
- 总原则：保留 F 的组件拆分和功能重写，在 F 的新组件边界上重放 G 的触控目标、窄屏布局和 Android 返回键增量；G 已删除的 legacy notes 文件不复活。

## 冲突文件取舍

1. `src/components/ReviewQuestionsView.tsx`
   - 保留 F 的“开始复习 + 生成卡片”双动作、禁用原因与窄屏换行布局。
   - 吸收 G 的 coarse pointer 触控要求，两项主操作及批量操作保持至少 44px 命中高度。

2. `src/components/essay-grading/StreamingAnnotatedText.tsx`
   - 保留 F 的“已应用 / 撤销 / 应用”完整状态机，不退回 G 的单一应用按钮。
   - 将 G 的触屏热区应用到“应用”和“撤销”，coarse pointer 下提升到 44px。

3. `src/components/shared/Resizable.tsx`
   - 同时保留 F 的 `storageKey` 比例持久化和 G 的 `fixed` 窄屏固定分栏模式。
   - 固定模式继续不渲染拖拽手柄；可拖模式继续读取和保存比例。

4. `src/components/skills-management/SkillsManagementPage.tsx`
   - 保留 F 的 `/` 聚焦搜索及 workbench/legacy 可见性、焦点门禁。
   - 使用 G 的 `anyInlinePanelOpen`，把技能浏览器和全部行内确认面板纳入滚回顶部逻辑，并保留 F 的 reset 确认条件。

5. `src/components/ui/DsDialog.tsx`
   - 保留 F 的按钮行 `flex-wrap`，避免多按钮确认框在窄屏溢出。
   - 重放 G 的取消按钮 coarse pointer 最小 44px 高度；确认按钮原有 44px 规则不变。

6. `src/features/anki-tasks/AnkiTasksApp.tsx`
   - 保留 F 空状态中的“去聊天”和“打开模板库”双 CTA。
   - 两个 CTA 均吸收 G 的 coarse pointer 44px 高度。

7. `src/features/anki-tasks/components/SessionRow.tsx`
   - 保留 F 基于 `failedTasks > 0` 的重试可见性，覆盖失败与暂停并存的会话，不收窄为 `attention` 分组。
   - 桌面行内重试及展开区重试均吸收 G 的 44px 触控目标，同时保留 F 的 aria label。

8. `src/features/chat/components/input-bar/InputBarUI.tsx`
   - 以 F 拆分后的 `InputBarUI` 为主体，不恢复 G 基于旧单体文件的大块实现。
   - G 的移动端增量按新边界重放：上下文环、发送/停止按钮和运行时模型搜索移到 `ComposerToolbar.tsx`；附件操作移到 `AttachmentPanelBody.tsx`；长粘贴、制卡、媒体和思维导图提示按钮留在 `InputBarUI.tsx` 并扩大到 44px。

9. `src/features/flashcards/screens/StatisticsScreen.tsx`
   - 保留 F 的错误态布局：调度设置在统计加载失败时仍可用，错误与重试位于同一滚动区。
   - 仅把 G 的 44px coarse pointer 高度加到 F 的重试按钮，避免恢复重复错误块。

10. `src/features/flashcards/screens/TodayScreen.tsx`
    - 保留 F 的 `wb-fcx-empty-cta` 统一视觉类。
    - 叠加 G 的 coarse pointer 最小 44px 高度到“去卡库”和“统计设置”按钮。

11. `src/features/learning-hub/apps/views/EpubPreview.tsx`
    - 保留 F 的 metadata 阅读进度合并、`epubReaderState` 解析和进度上报。
    - 增加 G 的 `isActive` 属性及活跃标签页守卫，使隐藏 EPUB 标签不注册 Android 返回键 handler。

12. `src/features/learning-hub/apps/views/FileContentView.tsx`
    - 向 EPUB 同时传递 F 的 `metadataProgress` / `onProgressChange` 和 G 的 `isActive`，兼得跨端进度与返回键隔离。

13. `src/features/learning-hub/apps/views/TextbookContentView.tsx`
    - 与文件视图一致，同时传递 F 的阅读进度协议和 G 的活跃标签页状态。

14. `src/features/learning-hub/apps/views/media/VideoPlayer.tsx`
    - 保留 F 的 `hasShortcutModifier`，组合键继续交给壳层和系统。
    - 保留 G 的 Android 返回键处理：全屏时优先退出全屏。

15. `src/features/learning-hub/components/finder/FinderToolbar.tsx`
    - 保留 F 的宽度观测、桌面 compact 模式和窄窗溢出菜单。
    - 所有导航/视图/排序/新建/刷新按钮在触屏保持 40px 视觉，并用伪元素扩展到至少 44px 命中区；桌面细指针继续使用 28/32px 紧凑密度。

16. `src/features/notes/components/NoteTagsEditor.tsx`
    - modify/delete 按 G 处理：删除 legacy notes 组件，不复活 F 的修改。

17. `src/features/notes/reference-selector/ReferenceSelector.tsx`
    - modify/delete 按 G 处理：删除 legacy reference selector，不复活 F 的修改。

18. `src/features/notes/reference-selector/__tests__/ReferenceSelector.test.tsx`
    - 随被删除的 legacy selector 一并删除，避免保留指向已移除实现的孤立测试。

19. `src/features/pdf/components/EnhancedPdfViewer.tsx`
    - 保留 F 的统一侧栏（目录、缩略图、书签、批注）、划词学习动作和新导航/搜索状态，不恢复 G 所基于的旧浮动书签/批注面板。
    - 重放 G 的隐藏 keep-alive 实例返回键可见性守卫、移动高亮色板 44px 命中区、密码/重试/页选择/移动 tab 等触控增量。
    - G 对旧书签面板输入框的 44px/16px 规则迁移到 F 的 `renderBookmarkList` 新位置；划词翻译也纳入返回键浮层判定。

20. `src/features/todo/components/TodoMainPanel.tsx`
    - 复用 F 的 `panelRootRef`，同时服务 F 的 workbench 键盘焦点门禁和 G 的 Android 返回键可见性守卫，不保留两个指向同一根节点的 ref。
    - G 的搜索框、筛选、多选、分组标题和批量改期触控热区保留。

21. `src/features/workbench/apps/notes/NotesWorkspaceApp.css`
    - 保留 F 的探索器“更多”折叠菜单样式。
    - 紧接其后保留 G 的 coarse pointer 44px 图标按钮规则；其余自动合并的搜索、标签、菜单、确认条和固定 compact 分栏移动规则全部保留。

22. `src/features/workbench/components/ExposeOverlay.css`
    - 两套能力并列保留：F 的 Windows forced-colors 焦点/选中可读性，以及 G 的触屏关闭按钮常显与 44px 命中区。
    - entering/closing 阶段继续显式禁用关闭按钮，避免子级 pointer-events 穿透。

23. `src/features/workbench/core/legacyNavigationMap.ts`
    - 功能上同时保留 F 的聊天导航握手和 G 的 desktop-only 全局通知。
    - 冲突仅在模块说明，改为准确描述当前轻依赖集合，不再声称“零重依赖”。

## 第四轮复查修正

- `FinderToolbar.tsx`：F 新增的 compact 溢出菜单承接了排序、新建与刷新，但触发器未重放 G 的伪元素扩展热区；现保持 40px 视觉并补足至少 44px 命中区。
- `EnhancedPdfViewer.tsx`：F 统一侧栏新增的书签/批注移动 tab 被高特异性 CSS 压回 34px；现与目录/缩略图一致，在 coarse pointer 下保持至少 44px 高度。

## 编译门禁

合并提交 `cf394904` 推送后执行：

- `npm ci`：通过（1200 packages）。
- `npm run typecheck`：通过。首次运行前需由仓库脚本 `npm run version:generate` 生成 gitignored 的 `src/version.ts`。
- `npx vite build`：通过（19678 modules transformed）；仅有既存的 Rollup 循环 chunk / 大 chunk 警告。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过；`deep-student` lib 仅报告既存 warning。

本机 Rust 初始为 Cargo 1.83，无法解析锁定依赖使用的 edition 2024；切换到 stable Cargo 1.98 后继续。Linux Tauri 检查还需要 GTK/WebKit 系统开发库与 `resources/pdfium/libpdfium.so`，后者通过仓库的 `scripts/download-pdfium.sh linux-x64` 临时准备。门禁结束后移除下载的未跟踪二进制并还原脚本更新的 license 文本，仓库未引入生成物。

## 第五轮：F 快进合并（575fee7f）

首轮合并基于 F 的 `115b202a`；此后 F 补进 #160/#161 修复推进到 `575fee7f`
（workbench 壳层交互、practice 进度契约、flashcards 卡库入口、pomodoro 悬浮胶囊、
空桌面 tour 契约、locale 与 license 刷新）。G（`4ab24435`）未再前进，因此直接在原预演分支上
merge 最新 F（合并提交 `f1927e4b`），不重开分支。

冲突取舍（均延续「以 F 结构为主、G 触控意图不丢」原则）：

1. `src/features/workbench/components/DesktopContextMenu.css`
   - F 新增的 coarse pointer 规则（44px 命中 + 10px/12px padding + 14px 字号 + 分隔线间距）
     是此前重放的 G 44px 规则的超集，直接采用 F 版。
2. `src/features/workbench/components/EmptyDesktop.css`
   - 采用 F 版：新增的 `width <= 720px` 窄工作区单列布局，以及 CTA / tour 按钮的
     44px + padding/字号规则；G 原有的 44px 意图被完整覆盖。
3. `src/components/practice/PracticeModeSelector.tsx`
   - modify/delete：F 已确认该组件未被渲染并整体删除（含导出与引用）；
     G 侧仅有一处 coarse pointer 类名增量，无渲染面，跟随 F 删除。

第四轮复查修正（`FinderToolbar.tsx` compact 热区、`EnhancedPdfViewer.tsx` 移动 tab 44px）
所在文件未被本次合并触及，修复原样保留。

合并后门禁在合并提交 `f1927e4b` 上复跑，全部通过：

- `npm ci`：通过。
- `npm run version:generate` + `npm run typecheck`：通过。
- `npx vite build`：通过；仅有既存的大 chunk 警告。
- `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过；
  `deep-student` lib 仅报告既存 warning。本轮 VM 额外需要 `protobuf-compiler`
  （`lance-encoding` 构建脚本依赖 `protoc`），其余环境准备与首轮一致，
  门禁结束后同样清理了 pdfium 二进制并还原 license 文本。

## 第六轮复查（ec8a2524）

对更新后的分支头做独立复核，未发现缺失，无需修补：

- **F 祖先关系**：`git merge-base --is-ancestor` 确认 `575fee7f` 已是分支祖先。
- **合并保真**：用 `git merge-tree --write-tree ce7f14db 575fee7f` 机械重放合并，
  与实际合并树逐文件比对，差异恰好只有三个已记录的冲突文件
  （`DesktopContextMenu.css` / `EmptyDesktop.css` 取 F 规则，
  `PracticeModeSelector.tsx` 跟随 F 删除），无任何未记录的手工偏差。
- **第四轮修正**：`FinderToolbar.tsx` compact 触发器伪元素热区、
  `EnhancedPdfViewer.tsx` 书签/批注移动 tab 的 `!min-h-11`，与修正提交
  `ce7f14db` 逐字节一致。
- **#160/#161 能力抽查**：`generateCardsFromText`（错题本 + 作文批改）、
  卡库手动新建与 `.apkg` 导入、`questionBankStore` 连对/已答持久化、
  `requestCloseAnimated` 关窗拦截、Slash 兜底移除、`listWorkbenchShortcuts`、
  `ImmersiveHint`、空桌面 tour 解耦均在位。注意 #160 PR 自带的
  `todayScreenEmptyLibrary.test.tsx` / `AnkiTasksApp.loadError.test.tsx`
  并未被摘入 F（`575fee7f` 本身即无），预演分支与 F 基线一致，不算缺失。
- **门禁复跑**（`ec8a2524` 相对 `f1927e4b` 仅多本 docs 文件、代码零差异）：
  `npm ci` / `typecheck` / `npx vite build` 复跑通过（仅既存大 chunk 警告）；
  F 新增的 `workbench-shell-ux` / `windowCloseGuard` / `EmptyDesktop` /
  `StatusBar` / `shortcuts` 五个测试套件 81 用例全绿。
  Rust 侧 `src-tauri` 与已通过 cargo check 的 `f1927e4b` 零差异，结论沿用。

### 正式最后合 G 的复用方式

- 若正式合并时 F 仍为 `575fee7f`、G 仍为 `4ab24435`：直接把本预演分支
  （`f1927e4b` 及其上的 docs 提交）作为合并结果采用——merge 本分支或
  fast-forward 到它均可，不要在 F 上重新 merge G 后手工重解冲突。
  重要原因：第四轮修正 `ce7f14db` 只存在于预演分支，既不在 F 也不在 G，
  重新裸合 F×G 会丢掉 Finder compact 热区与 PDF tab 44px 两处修复。
- 若 F 或 G 在正式合并前再次前进：沿用第五轮做法，把新头 merge 进本预演分支、
  按本文档已固化的取舍原则解冲突、复跑门禁，再整体采用预演分支。
