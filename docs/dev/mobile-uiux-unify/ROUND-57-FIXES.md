# Round 57 落地（claude-fable-5-thinking-xhigh）

## 已修

- SessionBrowser 重命名保存/取消、标签筛选、新建、空态
- BatchEditDialog 底栏取消/应用、关闭、预览翻页、标签 X
- MemoryView 列表/树/档案/审计重试与加载更多
- McpToolsSection 预设选择器与一批残留 size="sm"
- MultiSelectModelPanel 重试 / 关闭
- AutomationList 删除确认与表单保存
- UnifiedSidebar 刷新/新建图标与空态动作
- MinimalTemplateEditor 侧栏 nav 与页脚
- RecoveryShell / ComponentRecoveryShell 调试退出（仅尺寸）

## 仍开（Round 58+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0` 把 DsButton 压到 30–32
