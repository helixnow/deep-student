# Round 43 落地（claude-fable-5-thinking-xhigh）

## 已修

- ToolCallLifecycle / ThinkingBlock
- MultiVariant / MultiVariantTest / FloatingPanel / MediaProcessing
- QuestionImport / DeleteRender
- MultiAgent / EditRetry
- ChatAnkiParse / CitationTest（未撑正文内联 chip）
- ExamSheetProcessing / PdfMultimodal

## 仍开（Round 44+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 仍有未扫完的 debug-panel 插件：SubagentMessageFlow、StreamResponseMonitor、MindMapBlurHover、ChatInteractionTest、SessionLoadFlow、ChatAnkiIntegration、ImageAttachmentInspector、SessionSwitchPerf、CrepeImageUpload、MarkdownStreaming、AttachmentOcr、AnkiGeneration、AttachmentInjection、AttachmentPipeline
