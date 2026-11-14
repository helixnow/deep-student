/**
 * L16 owner seam for the insight SRS projection (L17 caller).
 *
 * SQL is copied verbatim from `dstu-research/src/insight/jobs.rs:651-729`.
 * Each function is one Rust statement group on the caller's connection; no
 * transaction is opened here because Rust runs them as separate autocommit
 * statements on `mconn`.
 */
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';

const tombstoneCardQuery = defineQuery<[string, string], void>(
  'UPDATE anki_cards SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1',
  { name: 'anki.insightProjection.tombstone' });

const upsertTaskQuery = defineQuery<[string, string, string, string, string], void>(
  `INSERT INTO document_tasks
     (id, document_id, original_document_name, segment_index, content_segment,
      status, created_at, updated_at, anki_generation_options_json)
   VALUES (?1, ?2, ?3, 0, ?4, 'Completed', ?5, ?5, '{}')
   ON CONFLICT(id) DO UPDATE SET
     original_document_name = excluded.original_document_name,
     content_segment = excluded.content_segment,
     updated_at = excluded.updated_at`,
  { name: 'anki.insightProjection.task.upsert' });

const cardExistsQuery = defineQuery<[string], { present: number }>(
  'SELECT EXISTS(SELECT 1 FROM anki_cards WHERE id = ?1) AS present',
  { name: 'anki.insightProjection.card.exists' });

const updateCardQuery = defineQuery<[string, string, string, string], void>(
  `UPDATE anki_cards
   SET front = ?2, back = ?3, updated_at = ?4, deleted_at = NULL
   WHERE id = ?1`,
  { name: 'anki.insightProjection.card.update' });

const insertCardQuery = defineQuery<[string, string, string, string, string, string], void>(
  `INSERT INTO anki_cards
     (id, task_id, front, back, tags_json, source_type, source_id, created_at, updated_at)
   VALUES (?1, ?2, ?3, ?4, '[]', 'inspiration', ?5, ?6, ?6)`,
  { name: 'anki.insightProjection.card.insert' });

export interface InsightProjectionTaskUpsert {
  readonly taskId: string;
  readonly documentId: string;
  readonly originalDocumentName: string;
  readonly contentSegment: string;
  readonly now: string;
}

export interface InsightProjectionCardWrite {
  readonly cardId: string;
  readonly taskId: string;
  readonly front: string;
  readonly back: string;
  readonly sourceId: string;
  readonly now: string;
}

/** `jobs.rs:651-656`：源卡不存在时的投影卡墓碑。 */
export function tombstoneInsightProjectionCardWithConn(conn: SqlExecutor, cardId: string, now: string): void {
  conn.run(tombstoneCardQuery, [cardId, now]);
}

/** `jobs.rs:685-703`：合成任务行 upsert。 */
export function upsertInsightProjectionTaskWithConn(conn: SqlExecutor, task: InsightProjectionTaskUpsert): void {
  conn.run(upsertTaskQuery, [task.taskId, task.documentId, task.originalDocumentName, task.contentSegment, task.now]);
}

/**
 * `jobs.rs:706-729`：存在则只改 front/back/updated_at 并清 deleted_at（保留 FSRS 与历史），
 * 否则插入 `source_type='inspiration'` 的新卡。
 */
export function writeInsightProjectionCardWithConn(
  conn: SqlExecutor,
  card: InsightProjectionCardWrite,
): 'updated' | 'inserted' {
  const exists = (conn.get(cardExistsQuery, [card.cardId])?.present ?? 0) !== 0;
  if (exists) {
    conn.run(updateCardQuery, [card.cardId, card.front, card.back, card.now]);
    return 'updated';
  }
  conn.run(insertCardQuery, [card.cardId, card.taskId, card.front, card.back, card.sourceId, card.now]);
  return 'inserted';
}
