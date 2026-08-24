# Round 70 落地（claude-fable-5-thinking-xhigh）

## 已修

- TodoTrashDialog 永久删除
- ComposerPanel 搜索输入（coarse `h-10` → `h-11`）
- NotesContextPanel 大纲标题 / 折叠 caret
- SessionBrowser 嵌入搜索输入
- mindmap outline 幽灵新行（coarse 32/36 → 44）
- mindmap 移动「更多」工具钮（`w-10 h-10` → coarse 44）
- InputBar 发送钮 iPad 洞（`md:` 缩到 32，补 coarse 44）
- ReviewCalendar 热力图格子（视觉不变，`::after` 扩命中）
- ParallelVariant 分页圆点（纵向伪元素 42 → 44）
- QuestionBankListView 空态清除筛选

## 扫过无残留

- PromptPanel：加词/确认/取消/模板/chip 均已有 coarse 44

## 仍开（Round 71+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader：已有 CSS 或 `shellIconButtonClassName` 覆盖
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen` 洞、CSS 32px 色板/自绘钮
