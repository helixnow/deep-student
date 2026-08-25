# Round 14 落地（claude-fable-5-thinking-xhigh）

## 已修

- NotesWorkspaceApp 窄窗 explorer 返回加 DOM 可见性守卫
- SessionGroupActions 区头 ⋯ coarse 常显，钮 ≥44
- UnifiedSidebar desktop 行内编辑/删除 coarse 常显 + `--touch-target-size`
- DataImportExport 备份动作改按 `pointer:fine` 藏、coarse 常显 44
- ModelPicker pin coarse `after:-inset-3`（44）
- 题库 RowHoverActions / ankiCardsBlock 触屏 40→44
- LearningHub / TabPanelContainer 分屏手柄 `hitAreaMargins` coarse 19；关闭钮伪元素扩热区

## 仍开（Round 15+）

- NotesSearchOverlay / ImageContentView 保活吞返回
- 工作台笔记 compact 分屏仍可拖；Chat/Sandbox 手柄无 hitAreaMargins
- HorizontalResizable coarse 热区不足 44
- ReferenceSelector / Chat 右屏 / askUserBlock / ActivityTimeline <44
- TextbookCard 死代码；PromptPanel mobileFullscreen 自绘 h-12
- 孤儿：NotesHeader / NotesTabsBar / NotesLibraryDialog / notes TrashDialog
