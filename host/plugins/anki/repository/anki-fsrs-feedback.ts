/**
 * FSRS 复习数据回流的只读联表仓储
 * （`crates/dstu-anki/src/fsrs_review_service.rs:2565-2617`）。SQL 只出现在本目录。
 *
 * 只读查询，供 `src/anki-fsrs-feedback.ts` 在制卡开始前构建用户复习画像与
 * 同批次语义干扰预警。包含 suspended 卡（leech 自动暂停的卡恰是最需要反馈的薄弱点），
 * 排除已删除卡、错误卡与已删除任务。
 */
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import { decodeJsonStringArray } from '../src/anki-cards.ts';
import type { FsrsFeedbackRow } from '../src/anki-fsrs-feedback.ts';

/** `FsrsReviewService::list_feedback_rows` 的 `limit` 上限。 */
const MAX_FEEDBACK_ROWS = 2000;

/** `list_feedback_rows` 查询的 10 列（列名保持 SQL 形态，解码见 {@link decodeFeedbackRow}）。 */
export interface FsrsFeedbackSqlRow {
  anki_card_id: string;
  front: string | null;
  template_id: string | null;
  tags_json: string | null;
  state: number;
  stability: number | null;
  lapses: number;
  reps: number;
  due_ms: number;
  last_review_ms: number | null;
}

/** 行按 `lapses DESC, due_ms ASC` 排序。 */
const LIST_FEEDBACK_ROWS = defineQuery<[number], FsrsFeedbackSqlRow>(
  `SELECT s.anki_card_id, COALESCE(a.front, '') AS front, a.template_id,
          COALESCE(a.tags_json, '[]') AS tags_json, s.state, s.stability, s.lapses,
          s.reps, s.due_ms, s.last_review_ms
   FROM fsrs_card_states s
   INNER JOIN anki_cards a ON a.id = s.anki_card_id
   INNER JOIN document_tasks dt ON dt.id = a.task_id
   WHERE s.deleted_at IS NULL
     AND a.deleted_at IS NULL
     AND dt.deleted_at IS NULL
     AND COALESCE(a.is_error_card, 0) = 0
   ORDER BY s.lapses DESC, s.due_ms ASC
   LIMIT ?1`,
  { name: 'anki.fsrsFeedback.listRows' },
);

/** 行解码：`tags_json` 按 `serde_json::from_str::<Vec<String>>(..).unwrap_or_default()` 软解析。 */
export function decodeFeedbackRow(row: FsrsFeedbackSqlRow): FsrsFeedbackRow {
  return {
    ankiCardId: row.anki_card_id,
    front: row.front ?? '',
    templateId: row.template_id,
    tags: decodeJsonStringArray(row.tags_json),
    state: row.state,
    stability: row.stability,
    lapses: row.lapses,
    reps: row.reps,
    dueMs: row.due_ms,
    lastReviewMs: row.last_review_ms,
  };
}

/** `FsrsReviewService::list_feedback_rows`：一次性读出「调度状态 + 卡片内容摘要」联表行。 */
export function listFeedbackRows(db: SqlExecutor, limit: number): FsrsFeedbackRow[] {
  const capped = Math.min(limit, MAX_FEEDBACK_ROWS);
  return db.all(LIST_FEEDBACK_ROWS, [capped]).map(decodeFeedbackRow);
}
