/**
 * 中断导入会话查询（vfs/repos/exam_repo.rs:1532-1563 `list_importing_sessions`）。
 *
 * qbank 只读 exam_sheets；写入仍由 L11 vfs-repos 负责。Rust 对单行读取错误
 * `warn!` 后继续，这里保留同一行为，避免一条坏行让整个列表不可用。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ImportingSession } from '../api.ts';
import type { QbankLogger } from '../src/ports.ts';

interface ImportingSessionRow {
  id: unknown;
  exam_name: unknown;
  import_state_json: unknown;
  question_count: unknown;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function listImportingSessions(db: SqlExecutor, log?: QbankLogger): ImportingSession[] {
  const rows = db.all<ImportingSessionRow>(`SELECT id, exam_name, import_state_json,
      (SELECT COUNT(*) FROM questions WHERE exam_id = exam_sheets.id AND deleted_at IS NULL) as question_count
    FROM exam_sheets
    WHERE status = 'importing' AND deleted_at IS NULL`, []);
  const sessions: ImportingSession[] = [];
  for (const row of rows) {
    try {
      if (typeof row.id !== 'string' || typeof row.question_count !== 'number') {
        throw new TypeError('invalid exam_sheets row');
      }
      sessions.push({
        session_id: row.id,
        exam_name: optionalText(row.exam_name),
        import_state_json: optionalText(row.import_state_json),
        existing_question_count: row.question_count,
      });
    } catch (error) {
      log?.warn(`[qbank] list_importing_sessions row error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sessions;
}
