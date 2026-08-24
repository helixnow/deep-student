# Round 62 落地（claude-fable-5-thinking-xhigh）

## 已修

- templatePreview 非可视化回退切换
- subagentEmbed 折叠头
- CitationPopover 打开链接 / 触发（未改内联引用 chip）
- TemplateToolOutput 正反面 tab / 原始 JSON
- InputBar 附件 / 发送停止
- BlockRenderer 重置 + 原始块 summary
- NoTagTreeShadPanel 生成预览 / 确认导入
- SummaryBox 生成 / 关闭
- LlmUsageStatsPage 错误重试 / 返回 / 时间范围 / 刷新
- TranslateWorkbench 重试 / 丢弃部分 / 关闭提示

## 仍开（Round 63+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
