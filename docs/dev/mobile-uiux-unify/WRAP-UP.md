# 收尾状态（PR #172）

- **分支**：`cursor/mobile-uiux-unify-0888`
- **PR**：https://github.com/helixnow/deep-student/pull/172
- **基线**：`main`
- **停止条件**：不再派 fable 无限轮；文档齐、工作树干净、契约 19/19、无 P0 后标为可审。不能 `gh merge`。

## 已齐

- Round 2–90 代码与文档（见 `PROGRESS.md`、`ROUND-90-FIXES.md`）
- 16 个 `CurrentView` 均注册 `useMobileHeader`
- 契约测试 19/19（本机 `vitest` mobile-uiux + MessageSearchBar + migrationFoundation）
- #166 / #161 边界未误改
- `buttonPrimitiveContract.ts` 未改
- 死代码 NotesHome / VideoPreview / AudioPreview 已删；NotesCrepeEditor / NotesContextPanel / 学习中心播放器仍存活（有意）

## 待关（本文件会在干净后改「可审」）

- 聊天/设置 6 文件若仍脏：等对应子代理自己提交，父代理不 `git add`
- GitHub CI 对最新 push 仍可能排队；失败只修本分支引入的问题
- PR 仍为 draft，直到工作树干净且文档覆盖全部已 push 提交后再 `draft=false`

## 不要再当新活

SelectItem / SegmentedControl 原语 `!`、SkillEditorModal Label、`deep-student.css` 6b 合同、死 anki-card-panel / `.icon-button`、drawer-close 层叠、Pptx 超宽缩略图、浏览器地址栏 16px、640–767 `sm→md`、侧栏/subagent 触控重叠。热力图格子/内联 chip/行内链接勿硬叠 44 视觉。
