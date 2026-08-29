# Round 12 落地（claude-fable-5-thinking-xhigh）

## 已修

- ModernSidebar：coarse 下活动会话行 / 区头动作常显，操作钮 ≥44
- Todo 自动化：小屏 `hideHeader`，刷新/新建收入统一顶栏 `rightActions`（≤2）
- 练习/题库保活：`isActive` 或 DOM 可见性守卫（Launcher/计时/模考/组卷/编辑器/裁剪/历史/导出/日历）
- 导图 `MobileNodeToolbar` 补 `useMindMapIsActive`
- template-management / SkillTapBrowser / SkillEditorModal 返回键加可见性守卫
- PluginsTab 详情、MCP ActionMenu / 预设选择器注册 overlay 返回
- 触控补齐：Anki 工具条、图表刷新宽、AppSelect/Tabs/TagInput、Todo 批量/自动化、MemoryView、Settings 维度/MCP 小钮、聊天附件/标签清除

## 仍开（Round 13+）

- 题库历史/导出/裁剪、翻译 DSTU 预览仍自绘 h-12 顶栏
- 翻译/作文小屏仍用 VerticalResizable
- Todo 行拖柄/删除 coarse 隐藏，需确认替代入口
- EpubPreview 目录侧栏缺 isActive
- 导图 `node-edge-enhancements` `.mm-action-btn` coarse 28px
