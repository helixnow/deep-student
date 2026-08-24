# Round 82 落地（claude-fable-5-thinking-xhigh）

## 已修

- TileMenuPopover 平铺菜单格 `.wb-tilemenu-item` 36px / 沉浸行 30px（文件原先无 coarse）
- quick-assistant 残留：输入 34、主按钮 30、评分行 27、结果行 40（Round 81 已修图标/返回/保存/菜单/清除，未动这些）
- WelcomeOnboardingDialog 语言分段：已有 `min-h-11` 缺 `!`，被 `.study-shell-segmented-button { min-height: 0 }` 压掉
- TodoAutomationWorkspace 动作类型 / 会话模式分段
- ReviewQuestionsView 排序分段
- AutomationList 动作类型 / 会话模式分段
- GeneralTab 语言 / 队列模式 / 通知策略分段
- WorkbenchSettingsSection 性能档 / 材质 / 壁纸 / 标题栏双击 / 浏览器网络 / Agent 控制 / pacing 共 7 处
- VoiceInputSettingsSection 触发模式分段
- ModelsTab 翻译显示模式分段

## 仍开（Round 83+）

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
- `.study-shell-segmented-button { min-height: 0 }` 会压掉 primitive 非 important coarse：新 segmented 调用处须 `[@media(pointer:coarse)]:!min-h-11`
- 仍缺 `!min-h-11` 的生产路径 SegmentedControl（Round 83 优先）：AppearanceTab 主题、AgentControlCenter 模式、DataChartsPanel 范围、PromptPanel 语体、TranslationMain 布局、TranslationViewerWrapper 视图、AutomationScheduleEditor 周期、MindMapContentView 视图切换
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
