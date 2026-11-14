/**
 * 测试专用的 L16 Anki 数据层镜像。
 *
 * FSRS 的跨领域测试需要验证「墓碑 / 会话归属 / 版本 CAS / 卡片库删除」与调度状态的
 * 交互，但这些函数属于 L16 anki 插件的实现文件，`cross-plugin-impl` 边界规则禁止
 * review 测试直接 import。这里按 `dstu-storage/src/database/mod.rs` 的 SQL 逐条镜像，
 * 只在测试中使用；断言真正的业务代码仍是 review 插件的生产服务。
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';

export interface CardRow {
  id: string;
  task_id: string;
  front: string;
  back: string;
  updated_at: string;
  tags_json: string | null;
  images_json: string | null;
  extra_fields_json: string | null;
  card_order_in_task: number;
}

const CARD_COLUMNS = `ac.id AS id, ac.task_id AS task_id, ac.front AS front, ac.back AS back,
  ac.updated_at AS updated_at, ac.tags_json AS tags_json, ac.images_json AS images_json,
  ac.extra_fields_json AS extra_fields_json, COALESCE(ac.card_order_in_task, 0) AS card_order_in_task`;

const LIVE_CARD = `ac.deleted_at IS NULL AND dt.deleted_at IS NULL`;

export function insertTaskAndCard(
  db: SqlExecutor, documentId: string, taskId: string, cardId: string,
): void {
  db.run(`INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json
  ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')`, [taskId, documentId]);
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`,
  [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

export function insertCardForTask(
  db: SqlExecutor, documentId: string, taskId: string, cardId: string,
): void {
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`,
  [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

export function setTaskOwner(db: SqlExecutor, taskId: string, sessionId: string): void {
  const result = db.run('UPDATE document_tasks SET source_session_id = ?1 WHERE id = ?2', [sessionId, taskId]);
  if (result.changes !== 1) throw new Error(`task owner not set: ${taskId}`);
}

export function getCardsForTask(db: SqlExecutor, taskId: string): CardRow[] {
  return db.all<CardRow>(`SELECT ${CARD_COLUMNS} FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ac.task_id = ?1 AND ${LIVE_CARD}
    ORDER BY ac.card_order_in_task, ac.created_at`, [taskId]);
}

export function getCardsForDocument(db: SqlExecutor, documentId: string): CardRow[] {
  return db.all<CardRow>(`SELECT ${CARD_COLUMNS} FROM anki_cards ac
    INNER JOIN document_tasks dt ON ac.task_id = dt.id
    WHERE dt.document_id = ?1 AND ${LIVE_CARD}
    ORDER BY dt.segment_index, ac.card_order_in_task, ac.created_at`, [documentId]);
}

export function getCardsForDocumentForSession(
  db: SqlExecutor, documentId: string, sessionId: string,
): CardRow[] | null {
  const counts = db.get<{ total: number; owned: number }>(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS owned
    FROM document_tasks WHERE document_id = ?1 AND deleted_at IS NULL`, [documentId, sessionId]);
  if (counts === undefined || counts.total === 0 || counts.total !== counts.owned) return null;
  return getCardsForDocument(db, documentId);
}

export function getCardsByIds(db: SqlExecutor, ids: readonly string[]): CardRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  return db.all<CardRow>(`SELECT ${CARD_COLUMNS} FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ac.id IN (${placeholders}) AND ${LIVE_CARD}
    ORDER BY ac.card_order_in_task, ac.created_at`, [...ids]);
}

export function getAnkiCardWithDocument(
  db: SqlExecutor, cardId: string,
): (CardRow & { document_id: string; source_session_id: string | null }) | null {
  return db.get<CardRow & { document_id: string; source_session_id: string | null }>(
    `SELECT ${CARD_COLUMNS}, dt.document_id AS document_id, dt.source_session_id AS source_session_id
    FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ac.id = ?1 AND ${LIVE_CARD} LIMIT 1`, [cardId]) ?? null;
}

export function getAnkiCardForSession(
  db: SqlExecutor, cardId: string, sessionId: string,
): (CardRow & { document_id: string }) | null {
  return db.get<CardRow & { document_id: string }>(`SELECT ${CARD_COLUMNS}, dt.document_id AS document_id
    FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ac.id = ?1 AND dt.source_session_id = ?2 AND ${LIVE_CARD} LIMIT 1`,
  [cardId, sessionId]) ?? null;
}

export function isDocumentOwnedBySession(
  db: SqlExecutor, documentId: string, sessionId: string,
): boolean {
  const counts = db.get<{ total: number; owned: number }>(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN source_session_id = ?2 THEN 1 ELSE 0 END), 0) AS owned
    FROM document_tasks WHERE document_id = ?1 AND deleted_at IS NULL`, [documentId, sessionId]);
  return counts !== undefined && counts.total > 0 && counts.total === counts.owned;
}

export type VersionUpdateOutcome = 'updated' | 'conflict' | 'not_found';

export function updateAnkiCardIfVersionForSession(
  db: DatabaseHandle, cardId: string, expectedVersion: string, sessionId: string, front: string,
): VersionUpdateOutcome {
  return db.transaction(tx => {
    const current = getAnkiCardWithDocument(tx, cardId);
    if (current === null) return 'not_found';
    if (!isDocumentOwnedBySession(tx, current.document_id, sessionId)) return 'not_found';
    const now = new Date().toISOString();
    const next = now === expectedVersion ? new Date(Date.now() + 1).toISOString() : now;
    const changed = tx.run(`UPDATE anki_cards SET front = ?1, updated_at = ?2
      WHERE id = ?3 AND updated_at = ?4 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM document_tasks dt WHERE dt.id = anki_cards.task_id AND dt.deleted_at IS NULL)`,
    [front, next, cardId, expectedVersion]).changes;
    return changed === 1 ? 'updated' : 'conflict';
  }, { behavior: 'immediate' });
}

export type VersionDeleteOutcome =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'conflict'; current: CardRow }
  | { status: 'review_conflict'; current: CardRow; review: ReviewVersion | null };

export interface ReviewVersion {
  cardStateId: string;
  reviewVersion: number;
}

export function loadReviewVersion(db: SqlExecutor, cardId: string): ReviewVersion | null {
  const row = db.get<{ id: string; version: number }>(`SELECT id, COALESCE(local_version, 0) AS version
    FROM fsrs_card_states WHERE anki_card_id = ?1 AND deleted_at IS NULL`, [cardId]);
  return row === undefined ? null : { cardStateId: row.id, reviewVersion: Number(row.version) };
}

export function deleteAnkiCardForSession(
  db: DatabaseHandle,
  cardId: string,
  expectedVersion: string,
  expectedReviewVersion: number | bigint | null,
  sessionId: string,
): VersionDeleteOutcome {
  return db.transaction(tx => {
    const current = getAnkiCardWithDocument(tx, cardId);
    if (current === null) return { status: 'not_found' };
    if (!isDocumentOwnedBySession(tx, current.document_id, sessionId)) return { status: 'not_found' };
    if (current.updated_at !== expectedVersion) return { status: 'conflict', current };
    const review = loadReviewVersion(tx, cardId);
    const reviewMatches = review === null
      ? expectedReviewVersion === null
      : expectedReviewVersion !== null && BigInt(review.reviewVersion) === BigInt(expectedReviewVersion);
    if (!reviewMatches) return { status: 'review_conflict', current, review };
    if (review !== null) {
      tx.run('DELETE FROM fsrs_review_logs WHERE card_state_id = ?1 AND anki_card_id = ?2',
        [review.cardStateId, cardId]);
      const deleted = tx.run(`DELETE FROM fsrs_card_states
        WHERE id = ?1 AND anki_card_id = ?2 AND COALESCE(local_version, 0) = ?3 AND deleted_at IS NULL`,
      [review.cardStateId, cardId, review.reviewVersion]).changes;
      if (deleted !== 1) return { status: 'review_conflict', current, review: loadReviewVersion(tx, cardId) };
    }
    tx.run('DELETE FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]);
    tx.run('DELETE FROM fsrs_card_states WHERE anki_card_id = ?1 AND deleted_at IS NOT NULL', [cardId]);
    const deleted = tx.run(`DELETE FROM anki_cards WHERE id = ?1 AND updated_at = ?2 AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM fsrs_card_states fs WHERE fs.anki_card_id = anki_cards.id AND fs.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM document_tasks dt WHERE dt.id = anki_cards.task_id AND dt.source_session_id = ?3 AND dt.deleted_at IS NULL)`,
    [cardId, expectedVersion, sessionId]).changes;
    if (deleted !== 1) {
      const latest = getAnkiCardWithDocument(tx, cardId);
      if (latest === null) return { status: 'not_found' };
      return latest.updated_at !== expectedVersion
        ? { status: 'conflict', current: latest }
        : { status: 'review_conflict', current: latest, review: loadReviewVersion(tx, cardId) };
    }
    return { status: 'deleted' };
  }, { behavior: 'immediate' });
}

export function insertAnkiCardsForDocument(
  db: DatabaseHandle,
  documentId: string,
  sessionId: string,
  cards: readonly { id: string; front: string; back: string }[],
): string[] {
  if (cards.length === 0) return [];
  return db.transaction(tx => {
    if (!isDocumentOwnedBySession(tx, documentId, sessionId)) {
      throw new Error('document_ownership_mismatch');
    }
    const taskId = tx.pluck<string>(`SELECT id FROM document_tasks
      WHERE document_id = ?1 AND source_session_id = ?2 AND deleted_at IS NULL
      ORDER BY segment_index DESC, created_at DESC, rowid DESC LIMIT 1`, [documentId, sessionId]);
    if (taskId === undefined) throw new Error('document_task_not_found');
    let nextOrder = Number(tx.pluck<number>(`SELECT COALESCE(MAX(card_order_in_task), -1) + 1
      FROM anki_cards WHERE task_id = ?1 AND deleted_at IS NULL`, [taskId]) ?? 0);
    const inserted: string[] = [];
    for (const card of cards) {
      const now = new Date().toISOString();
      tx.run(`INSERT INTO anki_cards (id, task_id, front, back, tags_json, images_json,
        is_error_card, card_order_in_task, created_at, updated_at, extra_fields_json,
        source_type, source_id) VALUES (?1, ?2, ?3, ?4, '[]', '[]', 0, ?5, ?6, ?6, '{}', 'document', ?7)`,
      [card.id, taskId, card.front, card.back, nextOrder, now, documentId]);
      inserted.push(card.id);
      nextOrder += 1;
    }
    return inserted;
  }, { behavior: 'deferred' });
}

export function getDocumentSessionSource(db: SqlExecutor, documentId: string): string | null {
  return db.pluck<string>(`SELECT source_session_id FROM document_tasks
    WHERE document_id = ?1 AND source_session_id IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
  [documentId]) ?? null;
}

export function getDocumentTask(db: SqlExecutor, taskId: string): Record<string, unknown> {
  const row = db.get(`SELECT * FROM document_tasks WHERE id = ?1 AND deleted_at IS NULL`, [taskId]);
  if (row === undefined) throw new Error('Query returned no rows');
  return row;
}

export function countTasksForDocument(db: SqlExecutor, documentId: string): number {
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM document_tasks
    WHERE document_id = ?1 AND deleted_at IS NULL`, [documentId]) ?? 0);
}

export function countRecentTasks(db: SqlExecutor, limit: number): number {
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM (
    SELECT id FROM document_tasks WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1)`,
  [limit]) ?? 0);
}

export function countRecentCards(db: SqlExecutor, limit: number): number {
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM (
    SELECT ac.id FROM anki_cards ac INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ${LIVE_CARD} ORDER BY ac.created_at DESC LIMIT ?1)`, [limit]) ?? 0);
}

export function updateDocumentTaskStatus(db: SqlExecutor, taskId: string, status: string): void {
  const changed = db.run(`UPDATE document_tasks SET status = ?1, error_message = 'must not update',
    updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`,
  [status, new Date().toISOString(), taskId]).changes;
  if (changed === 0) throw new Error(`document_task_not_found_or_deleted: ${taskId}`);
}

export function recoverStuckDocumentTasks(db: SqlExecutor, minutes: number): number {
  return db.run(`UPDATE document_tasks
    SET status = 'Paused', error_message = '任务被中断（应用重启），可点击恢复继续',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE (status IN ('Processing', 'Streaming')
      OR (status = 'Pending' AND NOT EXISTS (
        SELECT 1 FROM document_tasks live WHERE live.document_id = document_tasks.document_id
          AND live.deleted_at IS NULL AND live.status IN ('Processing', 'Streaming'))))
      AND deleted_at IS NULL
      AND (?1 = 0 OR datetime(updated_at) < datetime('now', '-' || ?1 || ' minutes')
        OR datetime(updated_at) IS NULL)`, [minutes]).changes;
}

export function deleteAnkiCard(db: SqlExecutor, cardId: string): void {
  const tx = db as SqlExecutor;
  tx.run('DELETE FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]);
  tx.run('DELETE FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]);
  tx.run('DELETE FROM anki_cards WHERE id = ?1', [cardId]);
}

export function deleteDocumentTask(db: SqlExecutor, taskId: string): void {
  db.run(`DELETE FROM fsrs_review_logs WHERE anki_card_id IN (SELECT id FROM anki_cards WHERE task_id = ?1)`, [taskId]);
  db.run(`DELETE FROM fsrs_card_states WHERE anki_card_id IN (SELECT id FROM anki_cards WHERE task_id = ?1)`, [taskId]);
  db.run('DELETE FROM anki_cards WHERE task_id = ?1', [taskId]);
  db.run('DELETE FROM document_tasks WHERE id = ?1', [taskId]);
}

export function deleteDocumentSession(db: SqlExecutor, documentId: string): void {
  db.run(`DELETE FROM fsrs_review_logs WHERE anki_card_id IN (
    SELECT a.id FROM anki_cards a INNER JOIN document_tasks t ON t.id = a.task_id WHERE t.document_id = ?1)`,
  [documentId]);
  db.run(`DELETE FROM fsrs_card_states WHERE anki_card_id IN (
    SELECT a.id FROM anki_cards a INNER JOIN document_tasks t ON t.id = a.task_id WHERE t.document_id = ?1)`,
  [documentId]);
  db.run(`DELETE FROM anki_cards WHERE task_id IN (SELECT id FROM document_tasks WHERE document_id = ?1)`,
    [documentId]);
  db.run('DELETE FROM document_tasks WHERE document_id = ?1', [documentId]);
}

export function listLibraryCards(db: SqlExecutor): { total: number; ids: string[] } {
  const ids = db.all<{ id: string }>(`SELECT ac.id AS id FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ${LIVE_CARD} ORDER BY ac.created_at DESC`).map(row => row.id);
  return { total: ids.length, ids };
}

export function getAnkiAgentLibraryCard(db: SqlExecutor, cardId: string): CardRow | null {
  return db.get<CardRow>(`SELECT ${CARD_COLUMNS} FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    WHERE ac.id = ?1 AND ${LIVE_CARD} LIMIT 1`, [cardId]) ?? null;
}

export type LibraryDeleteOutcome =
  | { status: 'deleted'; documentId: string; sourceSessionId: string | null }
  | { status: 'not_found' }
  | { status: 'content_conflict'; current: CardRow }
  | { status: 'review_conflict'; current: CardRow; review: ReviewVersion | null };

export function deleteAnkiCardForLibrary(
  db: DatabaseHandle,
  cardId: string,
  expectedVersion: string,
  expectedReviewVersion: number | bigint | null,
): LibraryDeleteOutcome {
  return db.transaction(tx => {
    const current = getAnkiCardWithDocument(tx, cardId);
    if (current === null) return { status: 'not_found' };
    const review = loadReviewVersion(tx, cardId);
    if (current.updated_at !== expectedVersion) {
      return { status: 'content_conflict', current };
    }
    const reviewMatches = review === null
      ? expectedReviewVersion === null
      : expectedReviewVersion !== null && BigInt(review.reviewVersion) === BigInt(expectedReviewVersion);
    if (!reviewMatches) return { status: 'review_conflict', current, review };
    if (review !== null) {
      tx.run('DELETE FROM fsrs_review_logs WHERE card_state_id = ?1 AND anki_card_id = ?2',
        [review.cardStateId, cardId]);
      const deleted = tx.run(`DELETE FROM fsrs_card_states
        WHERE id = ?1 AND anki_card_id = ?2 AND COALESCE(local_version, 0) = ?3 AND deleted_at IS NULL`,
      [review.cardStateId, cardId, review.reviewVersion]).changes;
      if (deleted !== 1) return { status: 'review_conflict', current, review: loadReviewVersion(tx, cardId) };
    }
    tx.run('DELETE FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]);
    tx.run('DELETE FROM fsrs_card_states WHERE anki_card_id = ?1 AND deleted_at IS NOT NULL', [cardId]);
    const deleted = tx.run(`DELETE FROM anki_cards WHERE id = ?1 AND updated_at = ?2 AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM fsrs_card_states fs WHERE fs.anki_card_id = anki_cards.id AND fs.deleted_at IS NULL)`,
    [cardId, expectedVersion]).changes;
    if (deleted !== 1) return { status: 'review_conflict', current, review: loadReviewVersion(tx, cardId) };
    return { status: 'deleted', documentId: current.document_id, sourceSessionId: current.source_session_id };
  }, { behavior: 'immediate' });
}

export function countFsrsRows(db: SqlExecutor, cardId: string): { states: number; logs: number } {
  return {
    states: Number(db.pluck<number>('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]) ?? 0),
    logs: Number(db.pluck<number>('SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]) ?? 0),
  };
}

export function assertNoFsrsRows(db: SqlExecutor, cardIds: readonly string[]): void {
  for (const cardId of cardIds) {
    const rows = countFsrsRows(db, cardId);
    if (rows.states !== 0 || rows.logs !== 0) {
      throw new Error(`leaked FSRS rows for ${cardId}: states=${rows.states}, logs=${rows.logs}`);
    }
  }
}
