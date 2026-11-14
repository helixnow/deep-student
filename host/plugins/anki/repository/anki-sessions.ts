/**
 * 文档会话列表、统计与待处理记忆候选（`dstu-storage/src/database/mod.rs:6053-6129,7389-7543`）。
 */
import { type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { AnkiLogger } from '../src/logger.ts';

export interface DocumentSessionRow {
  documentId: string;
  documentName: string;
  sourceSessionId: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  lastUpdated: string;
  createdAt: string;
  totalCards: number;
}

export function listDocumentSessions(db: SqlExecutor, limit: number): DocumentSessionRow[] {
  return db.all<DocumentSessionRow>(
    `SELECT
       dt.document_id AS documentId,
       dt.original_document_name AS documentName,
       dt.source_session_id AS sourceSessionId,
       COUNT(DISTINCT dt.id) AS totalTasks,
       COUNT(DISTINCT CASE WHEN dt.status = 'Completed' THEN dt.id END) AS completedTasks,
       COUNT(DISTINCT CASE WHEN dt.status IN ('Failed', 'Truncated', 'Cancelled') THEN dt.id END) AS failedTasks,
       COUNT(DISTINCT CASE WHEN dt.status IN ('Processing', 'Streaming', 'Pending') THEN dt.id END) AS activeTasks,
       COUNT(DISTINCT CASE WHEN dt.status = 'Paused' THEN dt.id END) AS pausedTasks,
       MAX(dt.updated_at) AS lastUpdated,
       MIN(dt.created_at) AS createdAt,
       COUNT(DISTINCT ac.id) AS totalCards
     FROM document_tasks dt
     LEFT JOIN anki_cards ac
       ON ac.task_id = dt.id
      AND ac.deleted_at IS NULL
     WHERE dt.deleted_at IS NULL
     GROUP BY dt.document_id
     ORDER BY MAX(dt.updated_at) DESC
     LIMIT ?1`,
    [limit],
  );
}

export interface AnkiStats {
  totalCards: number;
  totalDocuments: number;
  errorCards: number;
  templateCount: number;
  libraryTemplateCount: number;
  activeLibraryTemplateCount: number;
}

const LIVE_CARDS_FROM = `FROM anki_cards ac
  INNER JOIN document_tasks dt ON dt.id = ac.task_id
  WHERE ac.deleted_at IS NULL
    AND dt.deleted_at IS NULL`;

/** 模板库计数失败时降级为 0（`database/mod.rs:7513-7533`），并记录 Rust 同款 warn。 */
function countOrZero(db: SqlExecutor, sql: string, label: string, logger: AnkiLogger): number {
  try {
    return db.pluck<number>(sql, []) ?? 0;
  } catch (error) {
    logger.warn(`[get_anki_stats] ${label}（降级为 0）: ${(error as Error).message}`);
    return 0;
  }
}

export function getAnkiStats(db: SqlExecutor, logger: AnkiLogger = { debug() {}, info() {}, warn() {}, error() {} }): AnkiStats {
  const totalCards = db.pluck<number>(`SELECT COUNT(*) ${LIVE_CARDS_FROM}`, []) ?? 0;
  const totalDocuments =
    db.pluck<number>('SELECT COUNT(DISTINCT document_id) FROM document_tasks WHERE deleted_at IS NULL', []) ?? 0;
  const errorCards = db.pluck<number>(`SELECT COUNT(*) ${LIVE_CARDS_FROM} AND ac.is_error_card = 1`, []) ?? 0;
  const templateCount =
    db.pluck<number>(
      `SELECT COUNT(DISTINCT ac.template_id) ${LIVE_CARDS_FROM}
       AND ac.template_id IS NOT NULL
       AND ac.template_id != ''`,
      [],
    ) ?? 0;
  const libraryTemplateCount = countOrZero(
    db,
    'SELECT COUNT(*) FROM custom_anki_templates',
    '查询模板库数量失败',
    logger,
  );
  const activeLibraryTemplateCount = countOrZero(
    db,
    'SELECT COUNT(*) FROM custom_anki_templates WHERE is_active = 1',
    '查询启用模板数量失败',
    logger,
  );
  return { totalCards, totalDocuments, errorCards, templateCount, libraryTemplateCount, activeLibraryTemplateCount };
}

/** 仅在 `source_session_id` 为空时写入，避免覆盖已有来源。 */
export function setDocumentSessionSource(db: SqlExecutor, documentId: string, sessionId: string): void {
  db.run(
    `UPDATE document_tasks
     SET source_session_id = ?1
     WHERE document_id = ?2
       AND source_session_id IS NULL
       AND deleted_at IS NULL`,
    [sessionId, documentId],
  );
}

// ------------------------------------------------------------ 待处理记忆候选

export interface PendingMemoryCandidateRow {
  subject: string;
  content: string;
  category: string;
  origin: string;
  user_edited: number;
  created_at: string;
}

/** Compare timestamps numerically, including ISO timestamps with a T separator. */
export function expirePendingMemoryCandidates(db: SqlExecutor): void {
  db.run("DELETE FROM pending_memory_candidates WHERE julianday(expires_at) < julianday('now')", []);
}

export function listPendingMemoryCandidates(db: SqlExecutor, conversationId: string): PendingMemoryCandidateRow[] {
  return db.all<PendingMemoryCandidateRow>(
    `SELECT subject, content, category, origin, user_edited, created_at
     FROM pending_memory_candidates
     WHERE conversation_id = ?1 AND status = 'pending'
     ORDER BY id ASC`,
    [conversationId],
  );
}

export function dismissPendingMemoryCandidates(db: SqlExecutor, conversationId: string): number {
  return db.run(
    "UPDATE pending_memory_candidates SET status = 'dismissed' WHERE conversation_id = ?1 AND status = 'pending'",
    [conversationId],
  ).changes;
}

export function markPendingMemoryCandidatesSaved(db: SqlExecutor, conversationId: string): number {
  return db.run(
    "UPDATE pending_memory_candidates SET status = 'saved' WHERE conversation_id = ?1 AND status = 'pending'",
    [conversationId],
  ).changes;
}

export interface NewPendingMemoryCandidate {
  subject: string;
  content: string;
  category: string;
  origin: string;
  userEdited: boolean;
}

/**
 * `knowledge_executor.rs:104-166`：默认 deferred 事务内先删该会话 `status = 'pending'` 的旧候选，
 * 再按顺序插入；任一语句失败整体回滚并抛出原错误。返回插入条数。
 */
export function replacePendingMemoryCandidates(
  db: DatabaseHandle, conversationId: string, rows: readonly NewPendingMemoryCandidate[],
): number {
  return db.transaction((tx) => {
    tx.run(
      "DELETE FROM pending_memory_candidates WHERE conversation_id = ?1 AND status = 'pending'",
      [conversationId],
    );
    for (const row of rows) {
      tx.run(
        `INSERT INTO pending_memory_candidates (conversation_id, subject, content, category, origin, user_edited)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [conversationId, row.subject, row.content, row.category, row.origin, row.userEdited ? 1 : 0],
      );
    }
    return rows.length;
  });
}
