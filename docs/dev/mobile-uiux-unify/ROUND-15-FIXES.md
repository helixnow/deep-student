# Round 15 落地（claude-fable-5-thinking-xhigh）

## 已修

- NotesSearchOverlay 返回加 DOM 可见性守卫
- ImageContentView 接 `isActive`，缩放菜单/pointerdown 失活不注册
- 笔记工作台 compact 不渲染分屏手柄，锁定 50/50
- Chat canvas / Sandbox 检查器 `hitAreaMargins` coarse 19
- HorizontalResizable coarse 伪元素扩到 44
- Chat 右屏打开/关闭、askUserBlock info、ActivityTimeline 折叠行 coarse ≥44
- 删除 TextbookCard；PromptPanel / 作文 InlineSettings 小屏去掉自绘标题
- 删除孤儿 NotesHeader / NotesTabsBar / NotesLibraryDialog / notes TrashDialog

## 仍开（Round 16+）

- ReferenceSelector 关闭/清除仍 `!h-6`（本轮并发上限未启动）
- MessageSearchBar portal 保活吞返回
- 闪卡库行操作 hover-only
- NotesContextPanel 标签钮 16px、TagFilter/SkillSelector X、SandboxToolbar 40、题库确认 32、MCP 预览 40
- notes-tabs-bar.css / NoteTagsEditor 可能新孤儿
