# Wave2-B 第 3 轮「审阅员-数据流」书面结论

> 角色：第 3 轮审阅员-数据流。任务：逐条比对本轮前后端契约，对不一致处打最小补丁。
> 禁跑 npm/cargo/vitest（全部结论为静态读码 + grep/JSON 解析证据）；不 commit/push。

## 一、高危不一致（已修，2 处代码 + 1 处测试）

### 1.1 handlers「纯书签写 fail-closed」 vs previewPersistence 无版本书签写 —— file/textbook 书签保存全挂

**现象**：本轮 `handlers.rs` 把 bookmarks 写改为「必须携带 `expected_updated_at`，
无版本且无 readingProgress 的请求直接返回 `CONFLICT(textbooks.annotations_conflict)`」；
而前端唯一的 setMetadata 书签写入方 `previewPersistence.persistBookmarks` 仍是
`setMetadata(path, { bookmarks })` 不传版本（controller 根本不持有 node 的
`updated_at`，metadata props 天然滞后，前端补版本会造成常态 CONFLICT 风暴）。
按改前代码，textbook 与 file 的每一次书签保存都会被后端拒绝。

**修复（选更小切口：改后端）**：`src-tauri/src/dstu/handlers.rs` textbook 分支
（约 :3632-3674）与 files/file/image 分支（约 :3819-3861）统一为**书签三态契约**：

1. 带 `expected_updated_at` → `replace_bookmarks_if_version` OCC 原子替换（保留，
   对齐 highlights；chat 工具执行器 `textbook_pdf_executor.rs:227` 走的即此形态）；
2. 无版本 + 同请求带 `readingProgress` → 视为进度捎带的陈旧快照，跳过书签写入
   （保留，防跨实例交错清空书签）；
3. 无版本 + **仅 bookmarks** = 显式书签通道 → 恢复旧契约 `update_bookmarks`
   整数组覆盖写（原 fail-closed `return Err(...)` 改为此，新增 log 标注
   `versionless explicit channel`）。

不改 `coordinator.rs`、不动 highlights OCC、不动 `textbooks_update_bookmarks`
独立命令（textbook 双写通道原样）。

### 1.2 flush 合并 payload 命中后端「防交错跳过」 —— 关窗前显式书签变更被静默丢弃

**现象**：`previewPersistence.flush()` 在 progress 与 bookmarks 同时 pending 时
（用户加书签后 1s 防抖内又翻页并关窗/切 node）合并成单次
`setMetadata({ readingProgress, bookmarks })` 且无版本——恰好命中上面三态契约第 2 条，
书签被后端跳过。textbook 尚有 `updateBookmarks` 双写兜底，**file 的显式书签变更
会真丢**（file 只有 setMetadata 一条通道）。

**修复**：`previewPersistence.ts` flush 改为按通道分写：bookmarks 先走
`setMetadata({ bookmarks })`（仅书签，命中显式通道；textbook 仍先走
updateBookmarks 双写），progress 随后单独 `setMetadata({ readingProgress })`。
错误回调按通道各自触发（onBookmarksError / onProgressError 不再互串）。
文件头注释同步改写为三态契约描述（原文「后端均无版本校验」已失真）。

**随动测试修正**：`__tests__/previewPersistence.test.ts` 中
「dispose flush … combined payload」一例断言的正是会丢书签的合并单写行为，
与修后契约直接矛盾，已改为断言两次分写（call1 仅 bookmarks、call2 仅
readingProgress，highlights/annotationRevision 仍逐 payload 排除）。测试文件不在
本角色可写清单字面内，但该断言若不改则与契约修复互斥，属「修契约所必须」，特此备案。
其余既有断言（含本轮新增跨窗口交错测试、`previewPersistence.bookmarkRace.test.ts`
红转绿测试）与分写行为兼容，未动。

## 二、i18n key 不一致（已修）

`saveTextAsNote.ts:155` 实际引用 `chatV2:messageItem.actions.saveAsNoteSuccessAtRoot`，
而 i18n 员本轮预置的是旧「两步模型」语义的 `saveAsNoteSavedAtRoot`
（文案含「移入目标目录失败」——与新语义冲突：`landed:'root'` 也可能是用户主动选了
根目录，不能谎称失败）。运行时后果：en-US 用户会看到中文 defaultValue 兜底。

**修复**：zh/en `chatV2.json` 各补 `saveAsNoteSuccessAtRoot` 一键（中性措辞
「已保存为笔记：{{title}}（位于资源库根目录）」/ "Saved as note: {{title}} (in the
library root)"，与相邻 `saveAsNoteSuccessInFolder` 风格一致）。已用 json.load +
zh/en 叶子键集合比对验证。`saveAsNoteSavedAtRoot` 成为死键，按 r3-i18n.md 自述
「由后续轮次 i18n 员按死键流程清理」，本轮不删。

## 三、逐条比对结果（无需改动的项）

| 契约点 | 结论 |
| --- | --- |
| handlers `dstu_create` tags fail-closed（字符串数组，否则整单拒绝） | 通过。全仓 `dstu.create` note 调用方（notesDstuAdapter、quick-assistant service、NotesContext ×2、ChangesSection、types.ts 示例）传的均为字符串数组字面量，无形状风险。 |
| `notesDstuAdapter.createNote(title, content, tags, folderId)` → `metadata.folderId` | 通过。后端 `dstu_create:727-752` 读 `metadata.folderId`（要求 `fld_` 前缀，与 `VfsFolder` id 格式一致，FolderPickerDialog 回传即此），`create_note_in_folder` BEGIN IMMEDIATE 单事务落盘。root 时 adapter 不带 folderId 键 → 后端落根 folder_items，正确。 |
| `saveTextAsNote` 单次提交 + `resolveLandedFolder` 回查 + `landed` 三态 toast | 通过。回查用 `folderApi.getFolderItems`（`VfsFolderItem.itemId` 字段实存），保守降报 root 不谎报目录；`landed:'folder'` 时补发 `item-added` 目录事件（`emitDstuFolderChange` 契约与 folderApi.addItem 一致），落根不补发（DSTU watch 覆盖）。 |
| `saveTextAsNote.test.ts` | 与实现契约一致：createNote 四参、目录失败整体 ok:false、兼容降级 landed:root、事件仅确认入目录才发、toast 按落点措辞。i18n 桩走 defaultValue 插值，不受 locale 键影响。 |
| TextbookContentView / FileContentView 划词做笔记 | 通过。均迁至 `useSaveAsNoteFlow`（openSource='pdf-selection'）+ `SaveAsNoteFolderPicker`，标题「摘录首 30 字兜底 node.name」、正文保留 `pdf:selection.note_source` 页码 locator。`showGlobalNotification` import 仍被其他路径使用，无悬空 import。 |
| EssayGradingWorkbench 存笔记 | 通过。迁至共享流程（openSource='essay-grading'），动态 import 只剩 exportFormatter，deps 数组含 `startSaveAsNote`，picker 已挂载在组件树尾部。 |
| quick-assistant 豁免 | 认可豁免成立（轻量窗无 FolderPickerDialog / showGlobalNotification / DSTU_OPEN_NOTE 宿主；`metadata.source` 为 dstu.create 直调独有能力）。`service.ts` 函数体零改动，仅头注，无数据流影响。 |
| locale 新键 `learningHub:errors.bookmarksSaveConflict` / `restoreDroppedCorrupted` | 预置占位，本轮代码零引用（r3-i18n.md 已自述）。非缺键，不属本角色修复面，留后续轮次接线或按死键处理。 |
| LearningHubPage P8 标签恢复（白名单解析/去重/v2 payload） | 粗核无数据流冲突（resourceId 校验、仅 NOT_FOUND 删标签），不在本角色必读面，未深审。 |

## 四、遗留移交（不属本轮最小切口，未改）

1. **死键**：`chatV2:messageItem.actions.saveAsNoteSavedAtRoot`（见 §二）；
   `pdf:selection.note_saved` / `note_save_failed` / `note_default_title` 与
   `essay_grading:result_section.saved_as_note` 在本轮入口迁移后全仓零引用，
   移交后续 i18n 员按死键流程复扫。
2. `saveTextAsNote.ts` 头注「改造前各入口（聊天消息、聊天划词、快捷助手）」中
   「快捷助手」与豁免裁决不一致（r3-quick-assistant-exemption.md §遗留移交已点名，
   建议改为「聊天消息、聊天划词」并附豁免文档索引）。该文件本轮由收口员持有，
   头注非 i18n key 字符串，不在本角色可写面。
3. 后端书签显式通道（三态第 3 条）为无 OCC 覆盖写，跨窗口**同时编辑书签**仍可能
   互相覆盖（本轮只消灭了「翻页清书签」这一最高频形态）。若后续要闭环，需前端
   controller 持有并透传 `expected_updated_at`（dstu.setMetadata 第三参已就绪）+
   `learningHub:errors.bookmarksSaveConflict` 接 toast，属下一轮切口。

## 五、本轮改动清单

- `src-tauri/src/dstu/handlers.rs`：textbook 与 files 两处 bookmarks 分支
  「纯书签无版本 fail-closed 拒绝」→「显式书签通道整数组覆盖写」（三态契约第 3 条）。
- `src/features/learning-hub/apps/views/previewPersistence.ts`：flush 按通道分写
  （bookmarks 先、progress 后，各自 payload 单字段、各自错误回调）；文件头契约注释同步。
- `src/features/learning-hub/apps/views/__tests__/previewPersistence.test.ts`：
  合并单写断言改为分写断言（1 例，备案见 §1.2）。
- `src/locales/{zh-CN,en-US}/chatV2.json`：补 `saveAsNoteSuccessAtRoot`。
- 本文档。

## 六、未验证声明

未跑 npm / cargo / vitest / tsc（本轮禁止）。Rust 侧改动为既有 match 分支内
换调用（`update_bookmarks` 签名 `(&VfsDatabase, &str, &[Value]) -> VfsResult<()>`
与调用点一致，同函数内既有同签名调用可证），TS 侧改动为既有函数内重排 + 字面量
payload，静态复读通过；locale JSON 已用 python json.load + zh/en 键集合比对验证。
编译与测试红绿由第 8 轮统一验证。
