# Round 60 落地（claude-fable-5-thinking-xhigh）

## 已修

- OutlineMultiselectBar 删除确认 / 取消 / 批量完成缩进复制折叠删除 / 关闭
- InlineConfirmDelete 确认 / 取消 / 触发
- VendorSidebar 添加厂商图标 + 列表行 iPad 横屏洞（不再只靠 isSmallScreen）
- McpPanel 刷新图标
- SearchPanel 关闭 / 引擎 chip / 全选切换
- VariantActions 溢出菜单触发
- VariantSwitcher 变体 tab
- MessageInlineEdit 取消 / 发送
- BlockingToolLimitBar 继续 + PlanGateCard 展开 / 拒绝 / 批准
- PracticeModeSelector 模式钮 + CountStepperRow ±（修正「移动端已 44」注释）
- ImportConversationDialog 选文件 / 取消 / 确认 + ViewErrorFallback 重试

## 仍开（Round 61+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
