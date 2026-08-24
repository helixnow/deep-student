# Round 80 落地（claude-fable-5-thinking-xhigh）

## 已修

- NotesWorkspaceTree 树右键 `.nwt-context-menu-item` 28px（Round 79 修的是 `.notes-context-menu`，另一套类）；折叠 caret 14px 用 `::after` 扩命中（行已有 coarse 未动）
- FavoritesSection 收藏行 / `.nfs-item-main` 28px（折叠头 / 取消收藏已有 coarse 未动）
- NotesWorkspaceApp 行内删除确认 26px、树加载失败重试 26px、页签溢出触发器 28px（header/search/tab 图标与溢出菜单已有 coarse 未动）
- notes-backlinks-extras 分区折叠头 20px、「加载更多」小钮（create-button / 展开上下文已有 coarse 未动）
- mindmap 画布选择/拖拽/滚轮 `.mm-canvas-mode-button` 24px（缩放指示已有 Tailwind coarse 未动；控件条 / 搜索 / 样式钮已有 coarse 未动）
- NotesSearchOverlay 错误重试 28px（清除/关闭/模式钮 Round 79 已修）
- NotesBacklinksPanel 头栏图标 27px、空态/错误重试 27px（反链行 Round 78 已修）
- AppsPanel 关闭 24px、视图切换 24px、搜索条 coarse 44 + 16px
- AgentControlCenter 打开聊天 / 末枚动作 28px（AgentStrip 已有覆盖未动）
- AnkiTasksApp 筛选 SegmentedControl：`isSmallScreen` 桌面支 `!py-1` 在 iPad 横屏 coarse 无 44（补 `!min-h-11` 压过 `.study-shell-segmented-button { min-height: 0 }`）

## 仍开（Round 81+）

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
- MobileEditorToolbar 按钮已是 44，勿重做
- MemoryFolderBanner textarea：Round 79 已补 16px zoom，勿再硬叠 44 视觉
- StatusBar 菜单栏项 / 窗口控制 26px 属桌面壳标题栏密度，若要补只走伪元素，勿硬叠 44 视觉把顶栏撑开
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
