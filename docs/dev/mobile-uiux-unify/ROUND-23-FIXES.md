# Round 23 落地（claude-fable-5-thinking-xhigh）

## 已修

- SessionBrowser 重命名/导出/删除触屏 36→44
- QuestionBankEditor 判对/判错 coarse `!h-11`
- QuestionBankManageView 行「更多」coarse 44 + aria-label
- InputPanel 清空确认态套 `COARSE_HIT_SM`
- TemplateManagement 选择模式返回 coarse `min-h-11`；面包屑/卡片动作/错误关闭等补齐
- paperSave 源切换 caret 伪元素扩到 44
- AnkiTasksApp 打开模板库 / 空态 CTA coarse 44；SessionRow 展开区若干钮
- 删零引用 `workspaceShared.tsx`；rmdir 空 `DndFileTree/`、`dialogs/`

## 仍开（Round 24+）

- 题库列表「开始练习」32；PomodoroPanel / PomodoroAppWindow 控制簇 28
- 题库管理确认条、编辑器草稿取消、内联添加标签、SkillEditorModal 关闭
- InlineSettingsPanel CRUD 行 32
