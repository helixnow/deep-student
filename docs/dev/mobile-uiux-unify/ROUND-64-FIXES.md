# Round 64 落地（claude-fable-5-thinking-xhigh）

## 已修

- DailyPracticeMode 数量 chip / 重试 / 日历左右 / 目标输入
- PaperGenerator 预览返回 / 导出 / 导出格式格子
- PracticeLauncher 标签选择与高级模式返回图标
- LearningTrendChart 空态刷新
- DataChartsPanel 错误重试
- ResultPanel 批改失败重试
- BrowserAppWindow chrome 粗指针 40→44（地址栏 / 接管 / 提示钮同步）
- ReviewCalendarView 头栏关闭
- RecordConflictsPanel 加载更多
- QuestionInlineEditor 底栏取消 / 保存

## 仍开（Round 65+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- UnifiedNotification 动作钮 coarse 视觉 32（关闭/复制已用伪元素凑 44）
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
