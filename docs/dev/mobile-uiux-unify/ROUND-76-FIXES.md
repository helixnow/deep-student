# Round 76 落地（claude-fable-5-thinking-xhigh）

## 已修

- AboutTab 隐私/官网/GitHub/Issues 整行（`py-2.5` + `text-sm` ≈ 40px，无 coarse）
- SubagentProfilesSection 编辑表单「高级」`<summary>`（`py-2` + `text-sm` ≈ 36px）
- AutomationSettingsSection 编辑表单「高级」`<summary>`（同上）
- OcrEngineTestPanel 「查看区域」`<summary>`（`text-xs` 无 min-h）
- ToolInputView 「完整 JSON」`<summary>`（对齐 BlockRenderer 已有 coarse）
- SyncQuarantinePanel 隔离 payload `<summary>`（无 min-h）
- AutomationRunHistory 展开主行（`py-2.5` ≈ 40px；`containIntrinsicSize` 42→44）
- askUserBlock 多选 option `<label>`（`py-2` + `text-sm` ≈ 36px；单选已有 coarse 未动）
- sleepBlock 紧凑展开头（`py-2` + `text-sm` ≈ 36px）
- TodoSidebar 行内拖动手柄 / ⋯ 菜单（coarse `h-10` = 40px → `h-11`）

## 仍开（Round 77+）

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
- InputBarUI 上下文用量环 `h-8 w-7` 是 tooltip `role="img"`，非主操作钮；若下手用伪元素扩命中，勿硬叠视觉
- 继续扫生产路径残留：无 coarse 的原生 `<summary>` / `<button>` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
