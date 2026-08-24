# Round 13 落地（claude-fable-5-thinking-xhigh）

## 已修

- 题库历史/导出/裁剪：小屏经 `MobileSubviewChromeContext` 接管统一顶栏，隐藏自绘 h-12
- 翻译 DSTU 预览小屏隐藏自绘标题行；翻译/作文设置入口小屏只走宿主顶栏
- `VerticalResizable` 增加 `fixed`：翻译/作文小屏不可拖
- Todo 行优先级/专注/删除 coarse 常显弱化，命中 ≥44
- EpubPreview 接 `isActive` 并下传
- 导图 `.mm-action-btn` / 装饰链 coarse 伪元素扩到 44
- SegmentedControl / DsDialog 关闭钮 coarse 44
- 删除零消费 notes 预览组：Markdown/PDF/Image/ExamPreview

## 仍开（Round 14+）

- 工作台 NotesWorkspaceApp 窄窗返回缺可见性守卫
- SessionGroupActions / UnifiedSidebar / DataImportExport hover-only（≥768 coarse）
- ModelPicker pin 36px、题库行操作 40px、ankiCardsBlock 40px
- LearningHub 分屏手柄 6px（触屏平板）
