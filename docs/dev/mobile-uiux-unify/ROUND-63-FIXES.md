# Round 63 落地（claude-fable-5-thinking-xhigh）

## 已修

- SandboxWorkbenchPage 顶栏刷新 / 检查器
- SecurityStatusIndicator 刷新
- SystemWindowShared 抽屉关闭 coarse 40→44
- ChatAppWindow 标题栏侧栏开关：视觉 28 + `::after` 命中 44
- CanvasZoomIndicator 触控条 28 高用 `!min-h-11` 压过
- AboutTab 下载安装
- TimedPracticeMode 时长 / 开始 / 答题卡 / 暂停 / 交卷 / 确认
- MockExamMode 返回 / 新卷 / 开始 / 交卷 / 跳题 / 确认
- KnowledgeRadar 空态刷新
- ComposerPlusMenu 加号触发
- ContextUsagePopover 压缩上下文

## 仍开（Round 64+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
