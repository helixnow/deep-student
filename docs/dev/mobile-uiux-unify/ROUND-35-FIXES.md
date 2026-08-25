# Round 35 落地（claude-fable-5-thinking-xhigh）

## 已修

- OCR/PDF `.settings-range-slider` 触屏 min-height 44 + padding-block + background-clip（视觉轨仍 6px）
- `.fc-lib-chip` 触屏 40→44
- paperSave 错误展开 span：coarse py/-my 凑 44，不撑行
- MCP 勾选伪元素、ToggleSwitch 垂直伪元素、工具权限全选行
- 聊天 Workspace 日志/消息/Agent 抽屉、MultiSelect 选择点、GroupEditor 浏览、SessionBrowser 分组头
- TagNavigation 搜索/练习/清空/标签云；PracticeLauncher 标签行
- Todo 详情关闭、AutomationSchedule 字段/时区候选行
- Skills 顶栏新建、ComponentCompare 分段钮
- ReviewSession 退出/撤销/编辑/跳过/挂起

## 仍开（Round 36+）

- DEV：`TestControls` native 28–32；`PlaygroundControlPanel` tab ~26
- 作文 `InputPanel` 去图徽章 16+inset-3=40（需再扩 inset）
- `ankiCardsBlock` `min-h-10` 簇（lg+ coarse 40）
- `WebSearchAdvancedConfig` reranker top-k `h-8`
- `ModernSidebar` 会话重命名 `h-7`
- `WorkbenchSettingsSection` 另有不用 `.settings-range-slider` 的 range
- 内联引用 chip 设计未决；MiniCalendar 日格 / TabBar 更多关闭宽度 28 有意折衷
- ShortcutSettings 属 #166 不碰
