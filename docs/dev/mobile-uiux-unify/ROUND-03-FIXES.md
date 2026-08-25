# Round 3 落地（claude-fable-5-thinking-xhigh）

## 已修

- Settings Sheet header 中间列渲染 `sheetTitle`；返回 handler gate `isActive`；清掉 hidden 时的死顶栏字段。
- GradingMain：`isSmallScreen = compact || viewport < 768`，对齐翻译工作台。
- Todo 详情 overlay / 笔记上下文面板：返回键加可见性或 `isActive` 守卫。
- VendorDetailPanel 小屏取消 sticky；DimensionManagement 触控放大。
- InputBar 提示条 coarse 44px；VideoPlayer 全屏接返回；VerticalResizable 手柄扩区。
- 闪卡/浏览器 legacy no-op 改为桌面-only 通知（番茄钟保持静默，因移动壳已有全局组件）。

## Round 3 复查残留

- MessageSearchBar.placement.test 未改查 body，portal 后红。
- 消息搜索条未接返回键；触屏无入口。
- TodoContentView 嵌入 workbench 未 `enabled: !inWorkbenchWindow`。
- 设置「引擎」分区触控弱；数据治理宽表 28px 操作钮。
