# Round 47 落地（claude-fable-5-thinking-xhigh）

## 已修

- FileViewerWrapper 关闭/重试/下载
- ImageViewerWrapper 缩放/旋转/关闭/错误态
- PDFViewerWrapper / NoteEditorWrapper / MindMapEditorWrapper 错误与关闭
- ExamEditorWrapper / TranslationViewerWrapper 关闭与重试（补 iPad lg 收缩）
- ChatSessionSurface 沙箱展开 32→44
- NoteToolPreview Diff/预览切换
- CitationTest 步骤 checkbox label
- GlobalPomodoroWidget 沉浸药丸

## 仍开（Round 48+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留（无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only）与 DEV 漏网
