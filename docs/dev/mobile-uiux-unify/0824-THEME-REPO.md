# 0824 主题仓 G（mobile）状态记录

日期：2026-08-24  
分支：`cursor/0824-theme-mobile-cde6`  
底座：`origin/cursor/mobile-uiux-unify-0888`（PR #172，HEAD `e963b6df`）  
规模：相对 `origin/main`（`0e4c9fad`）544 提交 / 688 文件（+9335 / -14655）

本仓是 0824 统一合并（见 `docs/0824-MERGE-PLAN.md`，在 `cursor/0824-cde6` 上）的主题仓 G。
按计划第 5 节，**G 最后合入**，策略为「主体用 F/A，重放 G 热区增量」。
本轮不 merge #176 / #268 / #213，只做稳定化验证。

## 编译门禁结果（全部通过）

| 步骤 | 结果 |
|---|---|
| `npm ci` | 通过 |
| `npm run typecheck` | 通过（需先 `npm run version:generate` 生成 `src/version.ts`；单独跑 typecheck 不会自动触发，属环境步骤而非本枝断裂） |
| `npx vite build` | 通过（1m14s，仅 chunk 体积警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | 通过（本枝对 `src-tauri/` 相对 main 零改动；工具链需 Rust ≥1.92 级别 stable，1.83/1.89 因 `html2text` edition2024 与 `libsqlite3-sys` `cfg_select` 无法编译锁定依赖） |

无需任何代码修复：底座 #172 在四项门禁下本身即绿。

## 与 #176（F subapp）/ #268（A wrapup）的已知冲突面

文件级重叠（相对 main 的改动文件交集）：

- G ∩ F(#176)：**73 个文件**。热区集中在 essay-grading、practice、translation、
  learning-hub views/finder、chat input-bar / MessageItem / ChatV2Page、
  flashcards screens、mindmap、`App.tsx`、`ModernSidebar.tsx`、`DsDialog.tsx`。
- G ∩ A(#268)：**46 个文件**。热区集中在 BatchOperationToolbar、QuestionBank、
  unified-sidebar、chat AttachmentUploader / input-bar、learning-hub views、
  `TranslateWorkbench.tsx`、`DsDialog.tsx`。

删除 vs 修改类冲突（G 删除、对方仍在改，**按计划以 G 的删除为准，弃对方小补丁**）：

- G 删 / F 改：`src/features/notes/components/NoteTagsEditor.tsx`、
  `src/features/notes/reference-selector/ReferenceSelector.tsx`（及其测试）
- G 删 / A 改：`src/features/notes/NotesTabsBar.tsx`、`src/features/notes/PreviewPanel.tsx`、
  `src/features/notes/__tests__/NoteTagsEditor.test.tsx`、reference-selector 测试

`useMessageActions.ts`（#176 删 vs #268 改的已知冲突点）本仓未触碰，与 G 无关。

## 本仓保持的两条约定

1. **legacy notes 删除是有意的**：本枝的 38 处删除（`preview/`、`reference-selector/`、
   `DndFileTree/`、`notes-home.css`、`notes-tabs-bar.css`、`dnd-file-tree.css` 等）来自
   "drop dead reference picker / delete unused file tree / drop dead notes chrome" 系列
   死代码清理提交。不要在合成时把旧 notes 加回来。
2. **附件上限不变**：文件 200MB（`ATTACHMENT_MAX_SIZE`、后端 `MAX_DOCUMENT_SIZE`）/
   图片 50MB（后端 `file_manager.rs`）。本枝对这些文件相对 main 零改动。拒绝 #198 的
   「图片也 200MB」。
