# Round 11 落地（claude-fable-5-thinking-xhigh）

## 已修

- 导图 coarse / 窄屏命中 40→44：工具条、react-flow 控件、搜索、面包屑、背诵/横幅/版本历史；伪元素扩热区对齐 44
- 删除死代码：`NotesHome` + `notes-home.css`；契约测试去掉非法 viewId allowlist
- 删除零渲染方：`VideoPreview`、`AudioPreview`、notes `PreviewPanel`（学习中心用 `VideoPlayer` / `AudioPlayer`）
- 热力图年份钮 / 刷新钮 coarse 补足 `!h-11 !w-11`；`DataChartsPanel` 刷新 36→44
- Anki 失败面板「全部重试 / 逐段重试 / 更多」与防休眠钮 coarse ≥44
- Settings Sheet portal 到 body 后重建 `--mobile-safe-area-*`，避免底栏被 Home 指示条挡住
- `shad/Table` 外包 `overflow-x-auto`，窄屏宽表不再撑破布局

## 仍开（Round 12+）

- ModernSidebar named-group hover：≥768 触屏平板删除/更多不可见
- Todo 自动化工作区 640–767 双标题
- 保活视图缺 `isActive`：练习/题库/导图 MobileNodeToolbar / skills / template-management
- PluginsTab / MCP 自绘菜单未接 overlay 返回
- 残留 <44：Anki 工具条、AppSelect、Tabs、Todo 批量条、MemoryView Select
