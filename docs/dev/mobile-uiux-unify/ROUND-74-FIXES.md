# Round 74 落地（claude-fable-5-thinking-xhigh）

## 已修

- SubagentProfilesSection 顶栏刷新 / 打开目录 / 创建（`max-lg:!h-11` 无 coarse，iPad `lg:` 洞）
- AutomationSettingsSection 顶栏刷新 / 创建（同上）
- SkillEditorModal 基础 / 内容 / 工具 tab（`max-lg:min-h-11` 无 coarse）
- QuestionBankEditor 提交答题主钮（`size="lg"` + `w-full`，iPad 36px）
- CollapsibleModelSelector 触发器
- Combobox 触发器
- MultiSelectModelPanel 供应商分组折叠头（`py-1.5`）
- GradingStreamRenderer 结果区 section tab（`py-1.5`；筛选 chip 已有 coarse 未动）
- ReviewSession 退出关闭（`sm:h-auto sm:w-auto` 取消窄屏 44）
- shad SelectTrigger（`lg:min-h-[var(--button-height)]` 无 coarse，设置页共用）

## 仍开（Round 75+）

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
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`/`size="lg"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
