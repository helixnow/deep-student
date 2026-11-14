/** `question_import_service.rs` CSV 导入的只读查询（写入全部经 L11 vfsRepo）。 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `discard_new_empty_exam`：题目集下未删除题目数。 */
export function countLiveQuestions(conn: SqlExecutor, examId: string): number {
  const row = conn.get<{ count: number | bigint }>(
    'SELECT COUNT(*) AS count FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL', [examId]);
  return Number(row?.count ?? 0);
}

/** `get_existing_content_hashes` 的源行。 */
export function liveQuestionContents(conn: SqlExecutor, examId: string): { id: string; content: string }[] {
  return conn.all<{ id: string; content: string }>(
    'SELECT id, content FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL', [examId]);
}
