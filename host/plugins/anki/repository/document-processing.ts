/**
 * `document_tasks` 文档任务仓储：文档分段服务用到的任务 CRUD
 * （`dstu-storage/src/database/mod.rs:4482-4536,4698-4800,6095-6129`）。SQL 只出现在本目录。
 */
import { defineQuery, type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { DocumentTask, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';
import type { FsrsTransactionOwner } from '../src/fsrs-owner.ts';
import type { DocumentTaskRow } from '../src/anki-cards.ts';
import { nowRfc3339 } from '../src/time.ts';

const TASK_COLUMNS = `id, document_id, original_document_name, segment_index, content_segment,
    status, created_at, updated_at, error_message, anki_generation_options_json`;

const TASKS_FOR_DOCUMENT = defineQuery<[string], DocumentTaskRow>(
  `SELECT ${TASK_COLUMNS}
   FROM document_tasks
   WHERE document_id = ?1
     AND deleted_at IS NULL
   ORDER BY segment_index`,
  { name: 'anki.documentTasks.forDocument' },
);

const TASK_BY_ID = defineQuery<[string], DocumentTaskRow>(
  `SELECT ${TASK_COLUMNS}
   FROM document_tasks
   WHERE id = ?1
     AND deleted_at IS NULL`,
  { name: 'anki.documentTasks.byId' },
);

/**
 * `insert_document_task`：兼容新旧两种表结构——旧表有 `subject_name` 列时写入默认值「通用」。
 * 主键冲突等 SQLite 错误原样抛给调用方（服务层再映射 `AppError::database`）。
 */
export function insertDocumentTask(db: SqlExecutor, task: DocumentTask): void {
  const hasSubjectName =
    (db.pluck<number>(
      "SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='subject_name'",
      [],
    ) ?? 0) > 0;
  if (hasSubjectName) {
    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, subject_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      [
        task.id,
        task.document_id,
        task.original_document_name,
        '通用',
        task.segment_index,
        task.content_segment,
        task.status,
        task.created_at,
        task.updated_at,
        task.error_message,
        task.anki_generation_options_json,
      ],
    );
    return;
  }
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    [
      task.id,
      task.document_id,
      task.original_document_name,
      task.segment_index,
      task.content_segment,
      task.status,
      task.created_at,
      task.updated_at,
      task.error_message,
      task.anki_generation_options_json,
    ],
  );
}

/** `get_tasks_for_document`：按 `segment_index` 升序；不含软删除任务。 */
export function listDocumentTasks(db: SqlExecutor, documentId: string): DocumentTaskRow[] {
  return db.all(TASKS_FOR_DOCUMENT, [documentId]);
}

/** `get_document_task`：无行时抛存储层 `Query returned no rows`（与 rusqlite 文案一致）。 */
export function getDocumentTaskRow(db: SqlExecutor, taskId: string): DocumentTaskRow {
  return db.one(TASK_BY_ID, [taskId]);
}

/**
 * `update_document_task_status`：`updated_at` 取当前 RFC3339；影响行数为 0 表示任务
 * 不存在或已软删除，抛 `document_task_not_found_or_deleted: <task_id>`。
 */
export function updateDocumentTaskStatus(
  db: SqlExecutor,
  taskId: string,
  status: TaskStatus,
  errorMessage: string | null,
): void {
  const updatedAt = nowRfc3339();
  const updated = db.run(
    `UPDATE document_tasks
     SET status = ?1, error_message = ?2, updated_at = ?3
     WHERE id = ?4
       AND deleted_at IS NULL`,
    [status, errorMessage, updatedAt, taskId],
  ).changes;
  if (updated === 0) {
    throw new Error(`document_task_not_found_or_deleted: ${taskId}`);
  }
}

/**
 * `delete_document_session`：同一事务内先由 L15 清理 FSRS 记录，再删除卡片与任务。
 * FSRS 状态/日志归 L15（decisions D1/D4），事务仍由本调用方持有。
 */
export function deleteDocumentSessionRows(
  db: DatabaseHandle,
  documentId: string,
  fsrs: FsrsTransactionOwner,
): void {
  // 同 `database/mod.rs:6097`：普通删除用默认 deferred 事务。
  db.transaction((tx) => {
    fsrs.cleanupDocumentDeletionInTx(tx, documentId);
    tx.run(
      'DELETE FROM anki_cards WHERE task_id IN (SELECT id FROM document_tasks WHERE document_id = ?1)',
      [documentId],
    );
    tx.run('DELETE FROM document_tasks WHERE document_id = ?1', [documentId]);
  });
}
