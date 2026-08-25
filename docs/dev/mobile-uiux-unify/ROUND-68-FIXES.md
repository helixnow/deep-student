# Round 68 落地（claude-fable-5-thinking-xhigh）

## 已修

- compactionSummary 定位 / 撤销 / 复制
- ContextRefChips 清空全部
- BackupTab 备份取消
- askUserBlock 多选确认 / 自定义提交
- SessionSidebarContent 加载更多会话
- WorkspaceLogInline 复制调试 / 复制日志
- ActivityTimeline 工具限额继续
- QuestionHistoryView 加载更多
- InputPanel 移动工具栏批改
- CrepeDemoPage 顶栏复制（`shellIconButtonClassName` + 桌面 coarse）

## 仍开（Round 69+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader：已有 CSS 或 `shellIconButtonClassName` 覆盖
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
