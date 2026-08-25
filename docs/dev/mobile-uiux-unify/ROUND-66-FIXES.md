# Round 66 落地（claude-fable-5-thinking-xhigh）

## 已修

- QuestionHistoryView 错误重试
- FolderPickerDialog 对话框底栏取消 / 确认
- DesktopView 对话框关闭
- SessionItemRenderer 重命名取消 / 保存
- ComposerPanel 关闭
- BackupTab 配置加载重试
- IndexDiagnosticPanel 展开头
- paperSave 重试
- OutlineNodeMenu 删除确认 / 取消
- TodoTrashDialog 返回

## 仍开（Round 67+）

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
