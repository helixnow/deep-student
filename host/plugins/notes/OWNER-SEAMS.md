# N5 / L10-V2-01：同连接写点与 owner 接缝

依据 C1 的 SW 单次快照 `1c8239f67`（main `4525e11ac`，规则 `6002c7fbd`），沿用冻结报告 `0119143715c0` 的稳定 ID，不按新数组重编号。该快照 12 个操作报告对应 **11 个 SQL 写点**：1089 的 INSERT OR REPLACE 是一个业务写点。

2026-11-04 核对本 lane 候选及 L11 候选 `6525dc938` 的公开 types：不因 Rust 原先在 note repo 内写入就视为 owner 例外；以下归属以 C2/C1 裁定为准。

2026-11-05 续作更新：下表是原请求快照。main 已包含 `705cbfcb2`，正式接口统一位于 `vfsRepo.noteOwnerWrites`（不是早先提案的 resources/folders 子对象）。本候选已按原同连接顺序消费全部六面，移除七处对应写 SQL，见 `SPEC.md` N5 分支表与 `tests/note-owner-consumption.test.ts`。下表的“L11 缺”不再是当前阻塞；`__change_log` 的 sync owner 缺口仍有效，Lance 删除仍独立开。

## 完整写点映射

| 快照文件:行 | 原 ID / 归组 | Rust 证据（`note_repo.rs`，除注明） | 当前结论 |
|---|---|---|---|
| notes.ts:398 UPDATE resources.source_id | X6-SW-0017 / N5 | :538 | L11 缺精确 source_id 绑定面 |
| notes.ts:482 DELETE resources | X6-SW-0018 / N5 | :830-837 | L11 缺单行删除面；保留调用方先查 note 引用数、清 index artifacts、再删资源的顺序 |
| notes.ts:748 UPDATE folder_items | N5 membership 软删 | :2383 | L11 缺只软删当前活 membership 的同连接面 |
| notes.ts:752 UPDATE vfs_index_units | X6-SW-0019 / N5 | :2397 | L11 缺按 resource_id 仅禁用两个 state 的同连接面 |
| notes.ts:798 UPDATE folder_items | N5 membership 恢复 | :1618-1640 | L11 缺按原排序只恢复一条最新软删行的同连接面 |
| notes.ts:826 DELETE folder_items（note 缺失） | N5 孤立 membership | :1742-1765 | 已消费正式 `folders.removeItemByItemId(conn,'note',id)`；bool 保持原 rows>0 成功、零行 NotFound |
| notes.ts:832 DELETE folder_items（正常 purge） | N5 membership purge | :1794-1801 | 已消费同一正式面，仍在 `vfs_note_purge_tx` 内、先删 membership 后删 note |
| notes.ts:843 DELETE resources | X6-SW-0020 / N5 | :1856-1882 | 与 0018 共用待补的资源单行删除面，不复制资源 cleanup 逻辑 |
| notes.ts:860 DELETE folder_items（purge wrapper） | N5 wrapper | :2435-2446 | 已消费同一正式面；Rust 本来也委托 folder repo。此 wrapper 当前未找到独立生产调用，不为消除扫描造调用 |
| notes.ts:1089 INSERT / REPLACE vfs_indexing_config | N5 回填标志（一个写点） | :3076-3118 | owner=L11；普通 setConfig 有白名单，不能等价替换。需要维护 key 专用面 |
| revisions.ts:239 DELETE __change_log | N5 / B-sync-history-logs | `note_revision_repo.rs:228-231` | owner=sync，缺正式同连接面。只向 C1/C2 记录，L20 parked 不追加派单 |

## 给 active L11 的精确接口请求

以下名称是提案；若已有同义正式 API，请返回实际符号和提交，L10 按实际签名接入。均接收同一个 `SqlExecutor`，不自行开启/提交事务，不改变条件/时间/错误顺序。

1. `resources.bindNoteSourceIdWithConn(conn, resourceId: string, noteId: string): void`
   - 仅 `UPDATE resources SET source_id=?1 WHERE id=?2`，不推进 updated_at/ref_count、不改 source_table。
2. `resources.purgeNoteResourceRowWithConn(conn, resourceId: string): number`
   - 仅 `DELETE FROM resources WHERE id=?1`，返回 affected rows。引用数读取和 `purgeIndexArtifactsByResource` 仍在原调用顺序；不借 cleanupOrphanNoteMindmapResources 扩大删除范围。
3. `folders.softDeleteNoteMembershipsWithConn(conn, noteId: string, deletedAt: string, updatedAtMs: number | bigint): number`
   - 原 `UPDATE folder_items SET deleted_at=?1,updated_at=?2 WHERE item_type='note' AND item_id=?3 AND deleted_at IS NULL`，传入 Rust 对应的 RFC3339 与纪元毫秒，不能改成另一套时间策略。
4. `folders.restoreLatestDeletedNoteMembershipWithConn(conn, noteId: string, updatedAtMs: number | bigint): number`
   - 原 SELECT `item_type='note' AND item_id=?1 AND deleted_at IS NOT NULL ORDER BY COALESCE(updated_at,created_at) DESC, created_at DESC LIMIT 1`，再仅按选中 id UPDATE deleted_at=NULL/updated_at；无行返回 0。不恢复全部 membership、不改排序。
5. `embeddingUnits.disableNoteUnitsWithConn(conn, resourceId: string): number`
   - 仅 `UPDATE vfs_index_units SET text_state='disabled',mm_state='disabled' WHERE resource_id=?1`；不额外改 required/error/updated_at。
6. `indexingConfig.markNoteLinksBackfillDoneWithConn(conn, updatedAtMs: number | bigint): void`
   - 原 `INSERT OR REPLACE INTO vfs_indexing_config(key,value,updated_at) VALUES('maintenance.note_links_backfill_done','true',?1)`。
   - **不能直接调用 setConfig**：Rust :3087-3089 明确该维护标志不走公开配置白名单；L11 `embedding-repo.ts::validateConfig` 同样拒绝该 key。写标志只能在分批 rebuild 全部成功后，原先每批的 IMMEDIATE 事务不变，失败不落完成标志。

## 给 C1/C2 的 sync 同连接缺口（不派给 parked L20）

所需业务面：`discardUnpublishedNoteHistoryLogsWithConn(conn: SqlExecutor): void`，SQL 必须保留：

```sql
DELETE FROM __change_log
WHERE table_name='note_document_revisions'
  AND operation IN ('INSERT','UPDATE')
  AND COALESCE(sync_version,0)=0
  AND NOT EXISTS (
    SELECT 1 FROM note_document_revisions r
    WHERE r.version_id=__change_log.record_id
  )
```

调用位置为 `revisions.ts::discardUnpublishedHistoryLogs`，保留 snapshot/retention/导入事务内原顺序；不能删已发布日志、DELETE 日志或仍有实体的记录，不自开事务/不推进同步游标。需明确正式 api 出口和运行时装配，避免 notes↔sync 静态 inject 环；在提供方正式接缝到达前，不移动 SQL 到假 owner repo 或静默跳过。

## L11 blob journal 的反向 owner 请求（新增，不替代上述六面）

`vfs.__file_deletion_journal` 归 notes，与 chat_v2 同名表分开。`notes.blobDeletionJournal` 为独立可选能力（`BlobDeletionJournalRepository`），生产插件已提供；消费方只在确认能力存在后调用。

| 方法 | Rust `blob_repo.rs` / 语义 |
|---|---|
| `cancelBlobDeletionsForRecreatedBlob(conn, hash, cancelledAt): void` | :372-379；仅 blob+同 hash 且 prepared/ready，取消三字段，固定 last_error；L11 随后删除自己的 ready outbox，保留先后顺序 |
| `insertPreparedBlobDeletion(conn, { operationId, hash, relativePath, expectedHash, size, preparedAt }): void` | :656-667；原八列 INSERT，blob/prepared 常量，无 ON CONFLICT，size 为 signed i64 的 bigint|null（不做 asset u64 换算） |
| `cancelPreparedBlobDeletion(conn, operationId, cancelledAt, lastError): void` | :822-831；只按 op id + prepared，原调用方保留 Conflict 构造；不添加原 SQL 没有的 target_kind 条件 |
| `markBlobDeletionReady(conn, operationId, readyAt): number` | :861-868；只按 op id + prepared/ready，清 last_error，返回 affected rows；L11 继续负责 !=1 的 InvalidState 判断及原 outbox SQL |

四个方法不创建连接/事务，不接触文件、blobs 行或 `__blob_deletion_queue`，不解析/改写传入时间戳；L11 保留 `blob_store_metadata` / `blob_deletion_prepare` / `blob_deletion_ready` 保存点与文件编排，owner SQL 错误原样传播。

提供方测试：`tests/blob-journal-owner.test.ts`，真实安装 notes、vfs-repos、paths，使用迁移后的 vfs SQLite。`20261104161848-18d4fe` 4 passed / exit 0；typecheck `20261104161848-2483c5` exit 0；严格边界 `20261104161848-6c2f9e` 4 文件、0 违规、0 豁免 / exit 0。L11 消费接线和 main 集成尚需另验，不因提供方测试绿色宣称闭合。
