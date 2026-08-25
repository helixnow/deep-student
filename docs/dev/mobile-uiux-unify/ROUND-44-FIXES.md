# Round 44 落地（claude-fable-5-thinking-xhigh）

## 已修

- SubagentMessageFlow / StreamResponseMonitor
- MindMapBlurHover / ChatInteractionTest
- SessionLoadFlow / ChatAnkiIntegration
- ImageAttachmentInspector（含 CSS coarse 兜底）
- SessionSwitchPerf / CrepeImageUpload
- AnkiGeneration / AttachmentOcrRequestAudit
- AttachmentInjection / AttachmentPipeline
- MarkdownStreamingProfilerPlugin 本身无 button/input/select（交互在 ProfilerPanel，Round 36 已修），跳过

## 仍开（Round 45+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- debug-panel 插件工具栏已基本扫完；下一轮转生产路径残留（coarse 36/40、无 coarse 的 `!py-1`/`h-6`/`h-7`/`h-8`）与少量漏网 DEV 筛选项
