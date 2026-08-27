# Wave2-B 第 3 轮「保存落点 / 书签 / 标签恢复」i18n 键清单

范围：仅 `src/locales/{zh-CN,en-US}/chatV2.json` 与 `src/locales/{zh-CN,en-US}/learningHub.json`。
未改动任何 ts/tsx 逻辑文件；未跑 npm。四个命名空间（notes / chatV2 / learningHub / workbench）
已先行 grep 现有 `saveAsNote` 键，结论见「复用声明」与「未改动说明」。

## 本轮新增键（4 个，双语齐，zh/en 叶子键逐组核对一致）

| 键 | 场景 | zh-CN | en-US |
| --- | --- | --- | --- |
| `chatV2:messageItem.actions.saveAsNoteSuccessInFolder` | P6 单次提交携 folderId 成功（保存到目标目录成功） | 已保存为笔记：{{title}}（已存入所选目录） | Saved as note: {{title}} (in the chosen folder) |
| `chatV2:messageItem.actions.saveAsNoteSavedAtRoot` | P6 若保留回退移动：已保存但移动/目录失败，落在根目录 | 已保存为笔记：{{title}}，但移入目标目录失败，暂存于资源库根目录 | Saved as note: {{title}}, but moving it to the target folder failed. It is in the library root for now. |
| `learningHub:errors.bookmarksSaveConflict` | P5 书签保存冲突（后端若返回冲突态，先占位） | 书签保存冲突：此资源的书签已在其他窗口更新，本次修改未生效，请刷新后重试 | Bookmark save conflict: bookmarks for this resource were updated in another window. Your change was not applied — refresh and try again. |
| `learningHub:errors.restoreDroppedCorrupted` | P8 标签恢复时过滤掉损坏/非法形状的持久化记录（UI 若需提示） | 恢复标签页时丢弃了 {{count}} 条损坏的记录 | Dropped {{count}} corrupted record(s) while restoring tabs |

注：本角色起笔时工作树干净；写键期间第 3 轮实现员的部分 ts 改动已并行落入工作区
（handlers.rs / LearningHubPage / previewPersistence / 各直存入口），收尾复扫确认这些 diff
**尚未引用以上 4 键**（previewPersistence 仅在注释提及 CONFLICT、恢复校验走 rebind 无 toast、
`saveTextAsNote.ts` 尚未改动），4 键均属预置占位，落地后即可命中。若 P6 实现员选择
「单次提交、目录不存在整体失败」路线，则 `saveAsNoteSavedAtRoot` 不会被引用，届时由后续
轮次 i18n 员按死键流程记录/清理，本轮不预判删除。

## 设计取舍

- **成功文案不带 `{{folder}}` 目录名插值**：`FolderPickerDialog.onConfirm` 只回传
  `targetFolderId`（`FolderPickerDialog.tsx:19,231`），共享流程拿不到目录名；带名插值会逼迫
  ts 侧新增一次目录树查询，超出本角色边界。i18next 对缺失插值会原样露出 `{{folder}}`，
  故干脆不设。后续若实现侧补了目录名，再扩键不迟。
- **书签冲突键放 `learningHub:errors` 而非 `practice:preview_persist`**：书签持久化现有文案
  确实走 `practice:preview_persist.*`（`previewPersistence.ts:197,225,276-280,291`），但该组被
  `previewPersistence.i18n.test.ts:56-64` 以 `toEqual(ZH_LABELS)` 整组钉死（增键即红），且
  practice.json 不在本角色独占可写清单内。冲突提示语义上是 Learning Hub 资源级错误，与既有
  `learningHub:errors.resourceDeletedOrMoved` 同组自洽。
- **标签恢复键放同一 `errors` 组**：恢复校验/损坏项过滤都在 `LearningHubPage.tsx`
  （`loadPersistedTabs` 的形状过滤 `:163-168`、恢复后校验 `:227-257`），该文件已用
  `learningHub:errors.resourceDeletedOrMoved`（`:583`）做同类 toast，新键与之并列。
- **复数**：`restoreDroppedCorrupted` 沿用仓库现行 "(s)" 单键风格（同
  `chatV2:messageItem.actions.retryDeleteConfirm` 的 "message(s)"），不引入 `_one/_other` 分键。

## 复用声明（未新增，避免重复死键）

- 保存成功（无目录 / 落根目录的常规成功）：继续用既有
  `chatV2:messageItem.actions.saveAsNoteSuccess`（"已保存为笔记：{{title}}"，
  `saveTextAsNote.ts:117` 在引用）。
- 保存失败（整体失败）：继续用既有 `chatV2:messageItem.actions.saveAsNoteFailed`
  （`saveTextAsNote.ts:108` 在引用）。
- 「打开笔记」动作按钮：继续用既有 `chatV2:selectionToolbar.openNote`（`saveTextAsNote.ts:121`）。
- 目录选择器标题：继续用既有 `chatV2:selectionToolbar.saveAsNotePickFolder`
  （`useSaveAsNoteFlow.tsx:94`）。
- 产物侧另一套 `chatV2:artifacts.saveAsNote*`（`:1401-1405`，含 `savedAsNote` /
  `saveAsNoteFailed` / `saveAsNoteTruncated`）为 artifacts 面板专用，本轮不动、不合并。

## 未改动说明

- `notes.json` / `workbench.json`（zh/en）：grep 无 `saveAsNote` 相关键，本轮四条文案
  语义均不落在这两个命名空间（workbench 的 hub 关闭系键已在第 2 轮补齐），零改动。
- 未删除任何键；第 2 轮记录的疑似死键清单（`wave2-B-r2-i18n.md`）本轮未复扫。

## 验证口径

- 4 份 JSON 均通过 `json.load` 解析；`chatV2:messageItem.actions` 与 `learningHub:errors`
  两组 zh/en 叶子键集合逐组比对相等。
- 未跑 npm / vitest / 编译（本会话第 8 轮前禁止）；键引用命中依赖第 3 轮实现员落码后由
  审阅员 grep 复核。
