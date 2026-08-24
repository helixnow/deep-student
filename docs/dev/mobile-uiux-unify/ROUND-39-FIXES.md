# Round 39 落地（claude-fable-5-thinking-xhigh）

## 已修

- McpStatusIndicator compact 刷新 36→44
- 作文：StreamingAnnotatedText / ScoreCard / ModelEssayView / SentenceDetailView / PolishSectionView / GradingStreamRenderer 的 coarse 36→44
- NotesContextPanel 大纲 caret 宽 36→44，去掉贴边 inset
- 导图大纲任务勾选：视觉 14，::before 命中 44
- NotesLibraryManager 冲突策略 radio 行；BatchEditDialog section-header

## 仍开（Round 40+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel 图标已用 COARSE_HIT 伪元素凑 44，勿重做视觉 h-9
