# Round 79 落地（claude-fable-5-thinking-xhigh）

## 已修

- CollapsibleModelSelector 选项行（`py-2` + `text-sm` ≈ 36px；触发器已有 coarse 未动）
- Combobox 选项行（同上）
- NotesWorkspaceApp 页签溢出菜单 / 右键菜单 / 行内新建输入（桌面 30/28，仅 coarse 44；搜索栏已有 coarse 未动）
- NotesSearchOverlay 清除/关闭 28px、模式钮 coarse 36→44（结果行 52 未动）
- 笔记空态 `.nes-action` 28px（含 ghost / 树空态）
- 会话 TagFilter 加标签 input（已有 16px 字号，补 `min-h-11`）
- 反链「展开上下文」文字链（create-button 已有 coarse 未动）
- AgentTaskPanel 工作区「.. /」父目录钮
- MemoryView 行内编辑 textarea（coarse 16px + min-h-11；按钮已有 coarse 未动）
- MemoryFolderBanner 导入/新建 textarea（只补 iOS 16px zoom，不硬叠 44 视觉）

## 仍开（Round 80+）

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
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
