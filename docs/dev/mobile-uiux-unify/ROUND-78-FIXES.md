# Round 78 落地（claude-fable-5-thinking-xhigh）

## 已修

- settingsTabPrimitives `SwitchRow`（Appearance / General / AnkiConnect / Plugins / Memory / Workbench 共用；`py-2.5` + `text-sm` ≈ 40px）
- PdfSettingsSection 本地 `SwitchRow`（对齐 OCR 已修行）
- ParamsTab 本地 `SwitchRow`
- SubagentProfilesSection 列表展开主行（`py-2.5` ≈ 40px；高级 summary / icon 已有 coarse 未动）
- AutomationSettingsSection 列表展开主行（后台说明行不可点未动）
- ExamSheetUploader 题目筛选折叠头 / 题目行
- NotesWorkspaceTree `.nwt-row` 30px / `.nwt-root` 26px（仅 coarse 44；more/drag 已有 coarse 未动）
- mindmap `.outline-collapse-count` +N 胶囊（视觉保持小字，`::after` 扩命中；collapse-toggle 未动）
- 作文 InputPanel 题目元数据折叠头（`py-2` + `text-xs` ≈ 32px）
- NotesBacklinksPanel `.notes-backlinks-panel-link` 32px（桌面密度不变；create-button 已有 coarse 未动）

## 仍开（Round 79+）

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
- MemoryFolderBanner 导入/新建 textarea `text-[11px]` 是多行输入，优先防 iOS zoom 而非硬叠 44 视觉
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
