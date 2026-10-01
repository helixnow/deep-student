# WP05 — 本地笔记历史 MVP

实现入口：`src-tauri/src/vfs/repos/note_revision_repo.rs`、`src/features/notes/NoteHistoryPanel.tsx`。

## 持久化与保存

- 新迁移 `V20260921__note_document_revisions.sql`，追加注册与 migration lock；不复活旧 `notes_versions`。
- 快照独立保存完整 Markdown、title、tags、props、附件引用清单、版本/父版本/恢复来源、格式说明、来源与时间。旧 `resources` 回收不影响历史正文。
- Repo 的 create、update、metadata、回收站恢复改名在各自事务内记录历史。DSTU、Canvas、VFS、notes_manager、VFS ZIP overwrite 已有的 Repo 调用自动覆盖；没有改变这些入口的 OCC 参数或令牌推进规则。
- 首次写存量笔记时先保存旧正文基线。字段结构相等时不创建新版本（props 用结构比较，不做 JSON 字符串或 HashMap 哈希比较）。仅收藏变动不生成文档版本。
- 每次实际保存先写新的不可变版本 ID；同一 5 分钟时间桶内，前一个未固定的普通 edit 版本可被清理。最多保留 100 个未固定普通 edit 版本；created、baseline、metadata、restore、已固定版本不自动清理。父 ID 可指向已清理的版本，读取不依赖父链重放。
- IPC 预览只读，不自动固定，不会因单纯查看而阻塞永久删除。用户可选择“长期保留此版本”，或在确认后“解除长期保留”；“只看已长期保留的版本”通过后端过滤并分页，能管理旧预览／恢复操作留下的全部本地 pin。
- 解除固定只更新保留标志，不立即删除正文、元数据或附件引用；普通 edit 版本后续仍按原有合并／预算规则清理。恢复副本仍在同一事务内固定恢复源和恢复前状态，只有用户之后明确解除才取消这些保留。当前没有外部块历史引用租约，因此这些 pin 均可由本地用户管理，无需新增或重写迁移。
- 未固定版本如果在预览后被合并清理，恢复按原 `noteId + versionId` 在事务内读取并固定，目标不存在则整个恢复失败，不回退当前正文，也不创建半成品副本。恢复为副本不覆盖原笔记，不需要改变原文 OCC 约定。
- 含固定版本的笔记仍禁止永久删除；可通过面板逐个解除全部保留后再删。回收站中笔记可先还原，再从笔记历史管理。已恢复的副本独立保留正文与附件引用，永久删除原笔记不能连带删掉副本所需的附件。

## IPC / TypeScript API

| 命令 | 参数 | 返回 |
|---|---|---|
| `notes_history_list` / `NotesAPI.historyList` | `noteId`, `cursor?`, `limit?`, `pinnedOnly?` | `{ items, next_cursor }`，默认 30，最多 100；游标为本地递增 seq，支持只列出固定版本 |
| `notes_history_get` / `NotesAPI.historyGet` | `noteId`, `versionId` | `NoteHistoryRevision` 全文、元数据、附件清单；只读 |
| `notes_history_set_pinned` / `NotesAPI.historySetPinned` | `noteId`, `versionId`, `pinned` | 更新后的 `NoteHistorySummary`；显式保留／解除，不立即 prune |
| `notes_history_restore_copy` / `NotesAPI.historyRestoreCopy` | `noteId`, `versionId` | 新副本的 `DstuNode` |

命令已注册 `lib.rs` 与 `permissions/application-commands.toml`。历史 wire 字段为 snake_case；Tauri 参数为 camelCase。缺失/已清理的版本返回错误，不退回当前正文。

恢复副本在单一事务内固定恢复源与当前已落库状态，在资源库根目录创建独立新笔记及 folder_items 条目，并记录 `restored_from_version_id`。副本标题添加“（历史副本）”并避重名，tags/props/完整正文来自目标版本；当前笔记、OCC 令牌、未保存草稿不被改写。成功后发 DSTU created watch 事件，当前出链/全文索引继续走现有 Repo/数据库触发器。

## 宿主接线

```tsx
import { NoteHistoryPanel } from '@/features/notes/NoteHistoryPanel';

<NoteHistoryPanel
  noteId={noteId}
  open={historyOpen}
  onOpenChange={setHistoryOpen}
  onRestoredCopy={(node) => { /* 刷新列表或显示“副本已创建” */ }}
/>
```

`onRestoredCopy?: (node: DstuNode) => void` 仅通知创建完成。宿主如要自动打开副本，先走自己的草稿保存/保留流程。组件不会替换原编辑器正文，也不会自动导航。切页、关闭、连续选版本时，过期异步结果不会回填到另一个笔记。预览以只读 Markdown 显示全文，包含未加载后缀和未知语法。

## 附件与备份边界

- 自有 `notes_assets/...` 引用由当前笔记（包括回收站）和保留历史共同保护；外部 `pdfref://` / `file://` / HTTP 引用只保存引用，不备份外部字节。
- 孤儿扫描、单个/批量删除、硬删除、清空回收站使用共同引用规则；物理删除仍经过原有 deletion journal。恢复旧 prepared intent 时再次检查引用，已被引用的意图取消，必要时从隔离文件恢复原路径。检查和删除持有 SQLite writer reservation。
- 硬删除只删无引用的文件，不递归删除仍含共享附件的笔记目录。VFS ZIP 导入使用每次导入的新资产路径，防止覆盖历史引用的旧文件。
- 新历史表登记 `BackupOnly`，使用整库 SQLite Backup API 可以保留历史；笔记 ZIP 仍仅导出当前内容。
- 本地 head 使用历史表 seq，不在 RowSync 的 `notes` 增加悬空本地版本指针。**没有实现远端每次 RowSync 应用的历史捕获或历史跨设备传输**；远端写入后的状态在下一次本地 Repo 写入前保存基线。不能把本地历史声明为跨设备完整历史，也没有启用文档格式升级或历史块引用协议。

## 验证

- `node scripts/check-migrations.mjs`：通过，124 个迁移文件。
- `vitest run src/features/notes/__tests__/NoteHistoryPanel.test.tsx --maxWorkers=1 --minWorkers=1`：保留管理修订后 9 tests 通过。
- `cargo check --lib`：保留管理修订后通过（等待开发构建释放 Cargo 锁后执行；现有代码 warnings，无编译错误）。
- `cargo test --lib vfs::repos::note_revision_repo::tests -- --test-threads=1`：保留管理修订后 12 tests 通过，6066 filtered out，执行 6.62s。原 9 项覆盖资源回收后读取、完整恢复副本/元数据、no-op/空正文/A→B→A、OCC 与快照失败回滚、存量基线/分页、合并与固定保留、历史/回收站/共享附件及删除日志恢复、SQLite Backup API、ZIP 覆盖导入资产隔离；新增验证只读预览不阻止永久删除、预览后版本清理时恢复不得回退、旧 pin 显式解除后仍可恢复、恢复重新保护源与当前版本、全部解除后可永久删除而副本附件仍受保护、跨页保留过滤及跨笔记解除拒绝。
- `tsc --noEmit --pretty false`：通过。
- 未运行全量测试或真实桌面视觉验收；未修改其他 agent 所有的 editor/header/workspace。
