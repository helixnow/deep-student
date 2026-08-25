# Round 73 落地（claude-fable-5-thinking-xhigh）

## 已修

- MindMapContentView 加载失败重试（`ds-btn` CSS 28px，coarse 未覆盖此空态）
- MemoryView 配置加载失败重试（`size="md"` iPad `lg:` 洞）
- McpEditorSection 运行测试 / 连接测试
- WelcomeOnboardingDialog 去配置 / 跳过（`size="lg"` 36px）
- InputPanel 桌面批改主钮（`size="lg"` 无 coarse）
- UserAgreementDialog 关闭 / 同意并继续
- FeatureUnavailablePanel 前往数据治理
- useChatPageLayout 分组编辑顶栏保存
- SkillSelector 启用 / 取消钉住主钮
- MultiSelectModelPanel 模型行文字钮（`!h-auto !py-0`）

## 仍开（Round 74+）

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
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`/`size="lg"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
