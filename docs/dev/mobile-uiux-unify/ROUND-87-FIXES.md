# Round 87 落地（claude-fable-5-thinking-xhigh ×10，整区域打包）

本轮继续整区域吃饱：每个 fable 扫一整块目录。10 个派出，**8 个有代码提交**（设置/工作台复扫确认 Round 85 已全覆盖；笔记 DsButton 已全带 `!`，CrepeDemo/聊天漏网被并行提交捎带入库）。合计约 **50+ 文件、130+ 处**。

## 已修

### Todo 残留 DsButton（`6bd9b43f`，13 文件 / 42 处）
- AutomationList / TodoAutomationWorkspace / AutomationRunHistory / BulkActionBar / TodoItemDetail / InlineConfirmDelete / 行尾 Play·Trash / 主面板 / 内容顶栏 / 回收站图标 / 优先级菜单
- Round 85 有意跳过的「存量 min-h-11 不加 !」已纠正：DsButton `lg:` 会压非 important min-h

### 数据恢复整目录（`7fbf5715`）
- RecoveryCenter 13 处、ComponentRecoveryShell 3 处、RecoveryShell 1 处：coarse `min-h-11` 全部补 `!`

### 导图 TSX（`15531df7`，11 文件 / 28 处）
- OutlineMultiselectBar 9 个 DsButton 补 `!`
- OutlineNodeMenu / Breadcrumb / CanvasContextMenu / Canvas / Embed / ResourcePicker / ContentView / ErrorBoundary 重试 / VersionHistory / ShortcutHelp

### 图片查看器（`a72c0098`）
- ImageViewer：**真洞**——`!h-6` 压过非 important coarse `min-h-11`（裁剪确认/取消、OCR 关闭）→ `!min-h-11`
- ImageCropDialog 翻页钮补 `!`

### 标签导航 + 题库统计（`546014b0`）
- TagNavigationView 树/云切换钮 `h-7` + coarse `h-11` 无 `!`（iPad 横屏真洞）
- VirtualQuestionList 收藏星标同款
- 并行捎带：CrepeDemoPage、InputBarUI「+ 添加」`!min-w-11`、SearchResultList 重试

### 共享漏网（`ad6588b7`）
- TopLevelFallback：CSS 管线可能已失效，改用 `matchMedia('(pointer: coarse)')` 给四个兜底钮 minHeight 44
- WorkflowTimeline 步骤钮、ModernSelect 触发器 + 选项行 40→44
- UnifiedNotification 动作钮补 `!`（关闭钮保持 32 视觉 + 伪元素）

### 学习中心残留（`06b59d92`）
- FinderBatchToolbar iPad 横屏 `lg:` 压高；MobileBreadcrumb；Memory/Index/Desktop/Banner/Dstu/QuickAccess 的 Input/SelectTrigger 补 `!`

### 番茄钟 + debug 漏网（`eb9ffcbf`）
- PomodoroPanel 延长 chip / 时长预设 `min-w-11` 补 `!`
- MediaProcessingDebugPlugin 6 处、MindMapBlurHoverDebugPlugin 3 处
- App.tsx 维护横幅 `h-6` 钮补 `!`

### 设置/工作台（无新 commit）
- 复扫确认 DsButton/SelectTrigger 已全带 `!`；Settings 导航行 `!min-h-12`/`!min-h-[72px]` 补 `!min-h-11` 反而会压矮，有意跳过

## 仍开（Round 88+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关保持视觉 28 + 伪元素
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer 底栏 CSS / UnifiedPreviewToolbar / EnhancedPdfViewer 主条 / EpubPreview / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar 已 `!` / Card3DPreview CSS / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel / AgentStrip：已有覆盖
- CloudStorage 提供商卡 / AccentPicker / HeaderTemplate 小屏隐藏 / WorkbenchModeSwitchRow / `desktop-shell-*` / OCR `settings-range-slider`：勿当新活
- ChatErrorBoundary / MindMapErrorBoundary `<summary>` 仅 DEV
- SkillsList 默认徽章 / SiliconFlow 折叠头 / 题库卡片 / ShadApi 能力卡：行高或双行已够
- MemoryFolderBanner textarea：Round 79 已补 16px zoom
- StatusBar 菜单栏 / 窗口控制 26px 属桌面壳
- ComponentCompareTab（style-lab）分段属 DEV
- flashcards / library / settings / scrollbars 残留 `hover: none and coarse` 只是藏键盘提示
- 生产路径项目级 `SegmentedControl` / 大量 DsButton 缺 `!` 已按整目录收完聊天/设置/Todo/导图/恢复/学习中心/题库练习/作文翻译/闪卡/模板/共享/DSTU/PDF
- 继续扫：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、CSS 32px 色板/自绘钮。opening-tag 扫描会假阳性，必须读文件核
- **下一轮仍须整区域打包**：每个 fable 吃一目录/一组相关文件，扫并修该区全部真洞，确保 10 个完成后整体巨大且可靠进展
