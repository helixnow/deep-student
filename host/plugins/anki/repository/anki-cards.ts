/**
 * Anki 卡片、文档任务与待处理记忆候选的仓储
 * （`dstu-storage/src/database/mod.rs:4547-4558,4754-4788,4874-4993,5196-5235,
 * 6053-6129,7389-7543,7546-7598`）。SQL 只出现在本目录。
 */
import { defineQuery, type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import { decodeTaskStatus, type AnkiCardRow, type DocumentTaskRow } from '../src/anki-cards.ts';
import type { FsrsTransactionOwner } from '../src/fsrs-owner.ts';

const CARD_COLUMNS = `ac.id, ac.task_id, ac.front, ac.back, ac.text, ac.tags_json, ac.images_json,
    ac.is_error_card, ac.error_content, ac.created_at, ac.updated_at,
    COALESCE(ac.extra_fields_json, '{}') as extra_fields_json, ac.template_id`;

const CARDS_FOR_TASK = defineQuery<[string], AnkiCardRow>(
  `SELECT ${CARD_COLUMNS}
   FROM anki_cards ac
   INNER JOIN document_tasks dt ON dt.id = ac.task_id
   WHERE ac.task_id = ?1
     AND ac.deleted_at IS NULL
     AND dt.deleted_at IS NULL
   ORDER BY ac.card_order_in_task, ac.created_at`,
  { name: 'anki.cards.forTask' },
);

const CARDS_FOR_DOCUMENT = defineQuery<[string], AnkiCardRow>(
  `SELECT ${CARD_COLUMNS}
   FROM anki_cards ac
   JOIN document_tasks dt ON ac.task_id = dt.id
   WHERE dt.document_id = ?1
     AND dt.deleted_at IS NULL
     AND ac.deleted_at IS NULL
   ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at`,
  { name: 'anki.cards.forDocument' },
);

const RECENT_CARDS = defineQuery<[number], AnkiCardRow>(
  `SELECT ${CARD_COLUMNS}
   FROM anki_cards ac
   INNER JOIN document_tasks dt ON dt.id = ac.task_id
   WHERE ac.deleted_at IS NULL
     AND dt.deleted_at IS NULL
   ORDER BY ac.created_at DESC
   LIMIT ?1`,
  { name: 'anki.cards.recent' },
);

const TASKS_FOR_DOCUMENT = defineQuery<[string], DocumentTaskRow>(
  `SELECT id, document_id, original_document_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json
   FROM document_tasks
   WHERE document_id = ?1
     AND deleted_at IS NULL
   ORDER BY segment_index`,
  { name: 'anki.tasks.forDocument' },
);

export function listCardsForTask(db: SqlExecutor, taskId: string): AnkiCardRow[] {
  return db.all(CARDS_FOR_TASK, [taskId]);
}

export function listCardsForDocument(db: SqlExecutor, documentId: string): AnkiCardRow[] {
  return db.all(CARDS_FOR_DOCUMENT, [documentId]);
}

export function listRecentCards(db: SqlExecutor, limit: number): AnkiCardRow[] {
  return db.all(RECENT_CARDS, [limit]);
}

/**
 * `get_cards_for_document_for_session`（`database/mod.rs:4999-5045`）：
 * 文档内全部活任务必须归属该会话，否则返回 null（fail-closed）。
 */
export function getCardsForDocumentForSession(
  db: SqlExecutor,
  documentId: string,
  sessionId: string,
): AnkiCardRow[] | null {
  const row = db.one<{ task_count: number; owned_task_count: number }>(
    `SELECT COUNT(*) AS task_count,
            COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS owned_task_count
     FROM document_tasks
     WHERE document_id = ?1
       AND deleted_at IS NULL`,
    [documentId, sessionId],
  );
  if (row === undefined || row.task_count === 0 || row.task_count !== row.owned_task_count) {
    return null;
  }
  return listCardsForDocument(db, documentId);
}

/** `get_cards_by_ids`（`database/mod.rs:5045-5110`）：按 ID 取活卡，按 `created_at` 排序。 */
export function getCardsByIds(db: SqlExecutor, cardIds: readonly string[]): AnkiCardRow[] {
  if (cardIds.length === 0) return [];
  const placeholders = cardIds.map(() => '?').join(',');
  return db.all<AnkiCardRow>(
    `SELECT ${CARD_COLUMNS}
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     WHERE ac.id IN (${placeholders})
       AND ac.deleted_at IS NULL
       AND dt.deleted_at IS NULL
     ORDER BY ac.created_at`,
    [...cardIds],
  );
}

export function listTasksForDocument(db: SqlExecutor, documentId: string): DocumentTaskRow[] {
  return db.all(TASKS_FOR_DOCUMENT, [documentId]);
}

/** `DocumentTaskCountsDto`。 */
export interface DocumentTaskCounts {
  pending: number;
  processing: number;
  streaming: number;
  paused: number;
  completed: number;
  failed: number;
  truncated: number;
  cancelled: number;
  total: number;
}

/** `DocumentTaskCountsDto::default()`（全零）。 */
export function zeroDocumentTaskCounts(): DocumentTaskCounts {
  return {
    pending: 0,
    processing: 0,
    streaming: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    truncated: 0,
    cancelled: 0,
    total: 0,
  };
}

/**
 * `enhanced_anki_service.rs:1061-1079`：按 `get_document_tasks` 的结果计数。
 * 未知状态串按 `TaskStatus::from_str` 的默认值归入 Pending。
 */
export function countDocumentTasks(db: SqlExecutor, documentId: string): DocumentTaskCounts {
  const counts = zeroDocumentTaskCounts();
  for (const row of listTasksForDocument(db, documentId)) {
    counts.total += 1;
    switch (decodeTaskStatus(row.status)) {
      case 'Pending': counts.pending += 1; break;
      case 'Processing': counts.processing += 1; break;
      case 'Streaming': counts.streaming += 1; break;
      case 'Paused': counts.paused += 1; break;
      case 'Completed': counts.completed += 1; break;
      case 'Failed': counts.failed += 1; break;
      case 'Truncated': counts.truncated += 1; break;
      case 'Cancelled': counts.cancelled += 1; break;
    }
  }
  return counts;
}

/** `update_anki_card_rows`：影响行数 0 表示卡片不存在/已软删除/任务已删除。 */
export function updateCardRows(db: SqlExecutor, card: AnkiCard, updatedAt: string): number {
  const result = db.run(
    `UPDATE anki_cards SET
       front = ?1, back = ?2, text = ?3, tags_json = ?4, images_json = ?5,
       is_error_card = ?6, error_content = ?7, updated_at = ?8,
       extra_fields_json = ?9, template_id = ?10
     WHERE id = ?11
       AND deleted_at IS NULL
       AND EXISTS (
           SELECT 1
           FROM document_tasks dt
           WHERE dt.id = anki_cards.task_id
             AND dt.deleted_at IS NULL
       )`,
    [
      card.front,
      card.back,
      card.text,
      JSON.stringify(card.tags),
      JSON.stringify(card.images),
      card.is_error_card ? 1 : 0,
      card.error_content,
      updatedAt,
      JSON.stringify(card.extra_fields),
      card.template_id,
      card.id,
    ],
  );
  return result.changes;
}

export function deleteCard(
  db: DatabaseHandle,
  cardId: string,
  fsrs: FsrsTransactionOwner,
): void {
  // Rust `database/mod.rs:6055` 使用默认 deferred `conn.transaction()`。
  db.transaction((tx) => {
    fsrs.cleanupCardDeletionInTx(tx, [cardId]);
    tx.run('DELETE FROM anki_cards WHERE id = ?1', [cardId]);
  });
}

export function deleteDocumentTask(
  db: DatabaseHandle,
  taskId: string,
  fsrs: FsrsTransactionOwner,
): void {
  // Rust `database/mod.rs:6072` 使用默认 deferred `conn.transaction()`。
  db.transaction((tx) => {
    fsrs.cleanupTaskDeletionInTx(tx, taskId);
    tx.run('DELETE FROM anki_cards WHERE task_id = ?1', [taskId]);
    tx.run('DELETE FROM document_tasks WHERE id = ?1', [taskId]);
  });
}

export function deleteDocumentSession(
  db: DatabaseHandle,
  documentId: string,
  fsrs: FsrsTransactionOwner,
): void {
  // Rust `database/mod.rs:6097` 使用默认 deferred `conn.transaction()`。
  db.transaction((tx) => {
    fsrs.cleanupDocumentDeletionInTx(tx, documentId);
    tx.run(
      'DELETE FROM anki_cards WHERE task_id IN (SELECT id FROM document_tasks WHERE document_id = ?1)',
      [documentId],
    );
    tx.run('DELETE FROM document_tasks WHERE document_id = ?1', [documentId]);
  });
}

/**
 * `recover_stuck_document_tasks_older_than_minutes`（`database/mod.rs:7402-7427`）：
 * Processing/Streaming 直接按阈值回收；Pending 仅当文档已无活跃分段时回收。
 */
export function recoverStuckDocumentTasks(db: SqlExecutor, minutes: number): number {
  const result = db.run(
    `UPDATE document_tasks
     SET status = 'Paused',
         error_message = '任务被中断（应用重启），可点击恢复继续',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE (
         status IN ('Processing', 'Streaming')
         OR (
             status = 'Pending'
             AND NOT EXISTS (
                 SELECT 1 FROM document_tasks live
                 WHERE live.document_id = document_tasks.document_id
                   AND live.deleted_at IS NULL
                   AND live.status IN ('Processing', 'Streaming')
             )
         )
     )
     AND deleted_at IS NULL
     AND (?1 = 0 OR datetime(updated_at) < datetime('now', '-' || ?1 || ' minutes')
          OR datetime(updated_at) IS NULL)`,
    [minutes],
  );
  return result.changes;
}

// ------------------------------------------------------------ 保存聊天卡片

/**
 * `save_document_task_with_cards_atomic`（`database/mod.rs:4598-4707`）：
 * 任务与卡片同一事务；`INSERT OR IGNORE` 命中的卡片不进 `saved_ids`。
 */
export function saveDocumentTaskWithCardsAtomic(
  db: DatabaseHandle,
  task: DocumentTask,
  cards: readonly AnkiCard[],
): string[] {
  return db.transaction((tx) => {
    const hasSubjectName =
      (tx.pluck<number>("SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='subject_name'", []) ?? 0) > 0;
    if (hasSubjectName) {
      tx.run(
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
    } else {
      tx.run(
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

    const savedIds: string[] = [];
    for (const card of cards) {
      const result = tx.run(
        `INSERT OR IGNORE INTO anki_cards
           (id, task_id, front, back, text, tags_json, images_json,
            is_error_card, error_content, card_order_in_task, created_at, updated_at,
            extra_fields_json, template_id, source_type, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        [
          card.id,
          card.task_id,
          card.front,
          card.back,
          card.text,
          JSON.stringify(card.tags),
          JSON.stringify(card.images),
          card.is_error_card ? 1 : 0,
          card.error_content,
          0,
          card.created_at,
          card.updated_at,
          JSON.stringify(card.extra_fields),
          card.template_id,
          'document',
          task.document_id,
        ],
      );
      if (result.changes > 0) savedIds.push(card.id);
    }

    if (cards.length > 0 && savedIds.length === 0) {
      throw new Error('no_cards_saved_in_atomic_insert: all cards were ignored');
    }
    return savedIds;
  });
}

/**
 * `Database::insert_anki_card`（`dstu-storage/src/database/mod.rs:4791-4813`）：
 * 任务存在时 `source_type='document'` + `source_id=document_id`，否则按 task 记录；
 * `INSERT OR IGNORE ... WHERE EXISTS(document_tasks 未删除)` 返回是否真正插入。
 */
export function insertAnkiCard(db: SqlExecutor, card: AnkiCard): boolean {
  const taskRow = db.get<{ document_id: string }>(
    'SELECT document_id FROM document_tasks WHERE id = ?1 AND deleted_at IS NULL',
    [card.task_id],
  );
  const documentId = taskRow?.document_id ?? null;
  const sourceType = documentId !== null ? 'document' : 'task';
  const sourceId = documentId ?? card.task_id;
  return (
    db.run(
      `INSERT OR IGNORE INTO anki_cards
         (id, task_id, front, back, text, tags_json, images_json,
          is_error_card, error_content, card_order_in_task, created_at, updated_at,
          extra_fields_json, template_id, source_type, source_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
       WHERE EXISTS (
           SELECT 1
           FROM document_tasks dt
           WHERE dt.id = ?2
             AND dt.deleted_at IS NULL
       )`,
      [
        card.id,
        card.task_id,
        card.front,
        card.back,
        card.text,
        JSON.stringify(card.tags),
        JSON.stringify(card.images),
        card.is_error_card ? 1 : 0,
        card.error_content,
        0,
        card.created_at,
        card.updated_at,
        JSON.stringify(card.extra_fields),
        card.template_id,
        sourceType,
        sourceId,
      ],
    ).changes > 0
  );
}

/** `update_anki_card_rows_for_document`（`cmd/anki_connect.rs:542-598`）。 */
export function updateAnkiCardRowsForDocument(
  db: SqlExecutor,
  documentId: string,
  card: AnkiCard,
  updatedAt: string,
): number {
  return db.run(
    `UPDATE anki_cards SET
       front = ?1, back = ?2, text = ?3, tags_json = ?4, images_json = ?5,
       updated_at = ?6,
       extra_fields_json = ?7, template_id = ?8
     WHERE id = ?9
       AND source_type = 'document'
       AND source_id = ?10
       AND deleted_at IS NULL
       AND is_error_card = 0
       AND EXISTS (
         SELECT 1
         FROM document_tasks dt
         WHERE dt.id = anki_cards.task_id
           AND dt.document_id = ?10
           AND dt.deleted_at IS NULL
       )`,
    [
      card.front,
      card.back,
      card.text,
      JSON.stringify(card.tags),
      JSON.stringify(card.images),
      updatedAt,
      JSON.stringify(card.extra_fields),
      card.template_id,
      card.id,
      documentId,
    ],
  ).changes;
}

/** `anki_card_is_diagnostic_in_document`（`cmd/anki_connect.rs:600-620`）。 */
export function ankiCardIsDiagnosticInDocument(
  db: SqlExecutor,
  documentId: string,
  cardId: string,
): boolean {
  const row = db.get<{ is_error_card: number }>(
    `SELECT is_error_card
     FROM anki_cards
     WHERE id = ?1
       AND source_type = 'document'
       AND source_id = ?2
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM document_tasks dt
         WHERE dt.id = anki_cards.task_id
           AND dt.document_id = ?2
           AND dt.deleted_at IS NULL
       )
     LIMIT 1`,
    [cardId, documentId],
  );
  return row !== undefined && row.is_error_card !== 0;
}

/** `find_existing_card_id_by_content`（`cmd/anki_connect.rs:502-540`）。 */
export function findExistingCardIdByContent(
  db: SqlExecutor,
  documentId: string,
  card: AnkiCard,
): string | null {
  const text = card.text !== null && card.text.length > 0 ? card.text : null;
  const row = db.get<{ id: string }>(
    `SELECT id
     FROM anki_cards
     WHERE source_type = 'document'
       AND source_id = ?1
       AND is_error_card = 0
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM document_tasks dt
         WHERE dt.id = anki_cards.task_id
           AND dt.document_id = ?1
           AND dt.deleted_at IS NULL
       )
       AND (
         (?2 IS NOT NULL AND length(?2) > 0 AND text = ?2)
         OR
         ((?2 IS NULL OR length(?2) = 0)
           AND (text IS NULL OR length(text) = 0)
           AND front = ?3
           AND back = ?4)
       )
     ORDER BY rowid
     LIMIT 1`,
    [documentId, text, card.front, card.back],
  );
  return row?.id ?? null;
}

export * from './anki-library.ts';
export * from './anki-sessions.ts';
export * from './anki-review-state.ts';
