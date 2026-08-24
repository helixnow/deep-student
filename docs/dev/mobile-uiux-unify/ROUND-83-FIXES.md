# Round 83 落地（claude-fable-5-thinking-xhigh）

## 已修

- AppearanceTab 主题模式分段（default 档 36px 被 `min-height: 0` 压掉）
- AgentControlCenter 模式切换分段（紧急停止 / 打开聊天未动）
- DataChartsPanel 范围 / 趋势范围分段
- PromptPanel 语体分段
- TranslationMain 布局分段
- TranslationViewerWrapper 视图分段（与题库导出同 commit 落地，内容正确）
- AutomationScheduleEditor 周期种类分段
- MindMapContentView 大纲/导图视图分段
- DockWindowList 关闭钮 20px + hover-only：coarse 不再要求 `hover: none`（iPad 触控板洞），常显并升到 44
- QuestionBankExportDialog 本地分段 / 步骤条：`min-h-11` 补 `!`（压过 `min-h-[32px]`）

## 仍开（Round 84+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel 关闭与行动作 / AgentStrip / ResourceAppWorkspace 侧栏钮：已有 CSS 或 `shellIconButtonClassName` 覆盖
- CloudStorage 提供商卡 `!p-3 !h-auto` 通常已够高，勿当新活
- AccentPicker `DOT_BASE_CLASS` 已是 coarse 44，勿重做
- HeaderTemplate 小屏应隐藏，勿当新活
- WorkbenchModeSwitchRow / App.tsx `desktop-shell-*` 属桌面壳
- OCR/PDF `settings-range-slider` 已有 coarse padding 扩命中，勿当新活
- ChatErrorBoundary / MindMapErrorBoundary 的 `<summary>` 仅 DEV 栈，勿当生产新活
- SkillsList 默认徽章 / SiliconFlow 折叠头 / 题库卡片 / ShadApi 能力卡：行高或双行已够，勿当新活
- WebSearchAdvancedConfig `SwitchRow` 行本身不可点（仅 Switch，Round 75 已 44），勿当新活
- `.notes-tree-row` / `.notes-tree-root` 是死 CSS（TSX 已迁 nwt-*），勿当新活
- MinimalTemplateEditor.css `.icon-button` 是死 CSS（TSX 未用），勿当新活
- MobileEditorToolbar 按钮已是 44，勿重做
- MemoryFolderBanner textarea：Round 79 已补 16px zoom，勿再硬叠 44 视觉
- StatusBar 菜单栏项 / 窗口控制 26px 属桌面壳标题栏密度，若要补只走伪元素，勿硬叠 44 视觉把顶栏撑开
- SummaryBox `.sb-btn` 已有 Tailwind `min-h-11`，CSS coarse 36 被 min-height 压过，勿当新活
- AgentControlCenter 紧急停止已有 `!min-h-11`；打开聊天 / 末枚动作 Round 80 已修
- `.content-header .nav-history-button` 26px 属桌面壳，小屏 `deep-student.css` 隐藏，勿当新活
- ThinkingChain.css `.anki-card-panel__*` 是死 CSS（TSX 未用），勿当新活
- ComponentCompareTab（style-lab）分段属 DEV 对照页，勿当生产新活
- 生产路径项目级 `SegmentedControl` 调用处已基本补完 `!min-h-11`；新调用处仍须带 `!`（`.study-shell-segmented-button { min-height: 0 }` 会压掉基元非 important coarse）
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、`@media (hover: none) and (pointer: coarse)` 的 iPad 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
