/**
 * `dstu-media/src/media/ledger.rs` SQL: card tallies (`mistakes`), question
 * tallies/checkpoints (`vfs`) and the in-request-order assembly.
 */
import { defineQuery } from '../../../platform/storage/query.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { MediaCheckpoint, MediaCourseSummary } from '../api.ts';
import { formatMediaClock, mediaCitation, mediaCitationSecondsFor } from '../src/ledger.ts';

export interface CardTally {
  count: number;
  due: number;
  new: number;
  ids: string[];
}

export interface QuestionTally {
  count: number;
  attempted: number;
  attempts: number;
  correct: number;
  wrong: number;
  exams: Map<string, number>;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function int(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

function optionalInt(value: unknown): number | null {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `ledger.rs::card_tallies`. */
export function cardTallies(
  conn: SqlExecutor,
  ids: readonly string[],
  nowMs: number,
  includeIds: boolean,
): Map<string, CardTally> {
  const out = new Map<string, CardTally>();
  if (ids.length === 0) return out;
  const sql = `SELECT t.rid AS rid, ac.id AS card_id, fs.id IS NOT NULL AS enqueued,
      fs.state AS state, fs.due_ms AS due_ms, COALESCE(fs.suspended, 0) AS suspended
    FROM (
      SELECT id,
             CASE WHEN json_valid(anki_generation_options_json)
                  THEN json_extract(anki_generation_options_json, '$.source_ref.id') END AS rid
      FROM document_tasks
      WHERE deleted_at IS NULL
    ) t
    JOIN anki_cards ac ON ac.task_id = t.id AND ac.deleted_at IS NULL
    LEFT JOIN fsrs_card_states fs ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
    WHERE t.rid IN (${placeholders(ids.length)})
    ORDER BY ac.created_at, ac.id`;
  for (const row of conn.all<Row>(sql, [...ids])) {
    const rid = text(row.rid);
    if (rid === '') continue;
    const tally = out.get(rid) ?? { count: 0, due: 0, new: 0, ids: [] };
    tally.count += 1;
    if (includeIds) tally.ids.push(text(row.card_id));
    if (int(row.enqueued) !== 0 && int(row.suspended) === 0) {
      const state = optionalInt(row.state);
      const dueMs = optionalInt(row.due_ms);
      if (state === 0) tally.new += 1;
      else if (state !== null && dueMs !== null && dueMs <= nowMs) tally.due += 1;
    }
    out.set(rid, tally);
  }
  return out;
}

/** `ledger.rs::question_tallies`. */
export function questionTallies(
  conn: SqlExecutor,
  ids: readonly string[],
): Map<string, QuestionTally> {
  const out = new Map<string, QuestionTally>();
  if (ids.length === 0) return out;
  const sql = `WITH req(rid) AS (SELECT value FROM json_each(?1)),
    linked(rid, qid) AS (
      SELECT src.value, q.id
      FROM questions q
      JOIN json_each(
        CASE WHEN json_valid(q.source_ref) AND json_type(q.source_ref, '$.resourceIds') = 'array'
             THEN json_extract(q.source_ref, '$.resourceIds')
             ELSE '[]' END
      ) src
      WHERE q.deleted_at IS NULL AND src.value IN (SELECT rid FROM req)
      UNION
      SELECT req.rid, q.id
      FROM questions q JOIN req
      WHERE q.deleted_at IS NULL
        AND instr(COALESCE(q.explanation, ''), '[媒体@' || req.rid || ':') > 0
    )
    SELECT linked.rid AS rid, q.id AS qid, q.exam_id AS exam_id,
           COALESCE(q.attempt_count, 0) AS attempts, COALESCE(q.correct_count, 0) AS correct,
           q.is_correct AS is_correct
    FROM linked
    JOIN questions q ON q.id = linked.qid
    JOIN exam_sheets e ON e.id = q.exam_id AND e.deleted_at IS NULL`;
  for (const row of conn.all<Row>(sql, [JSON.stringify(ids)])) {
    const rid = text(row.rid);
    if (rid === '') continue;
    const tally = out.get(rid) ?? {
      count: 0, attempted: 0, attempts: 0, correct: 0, wrong: 0, exams: new Map<string, number>(),
    };
    const attempts = Math.max(0, int(row.attempts));
    const correct = Math.max(0, int(row.correct));
    tally.count += 1;
    if (attempts > 0) tally.attempted += 1;
    tally.attempts += attempts;
    tally.correct += correct;
    if (attempts > 0 && optionalInt(row.is_correct) === 0) tally.wrong += 1;
    const examId = text(row.exam_id);
    tally.exams.set(examId, (tally.exams.get(examId) ?? 0) + 1);
    out.set(rid, tally);
  }
  return out;
}

/** `ledger.rs::checkpoints_with_conn`：解析锚定到本课时刻的题目，按 (seconds,id) 排序。 */
export function checkpointsWithConn(conn: SqlExecutor, resourceId: string): MediaCheckpoint[] {
  const needle = `[媒体@${resourceId}:`;
  const rows = conn.all<Row>(
    `SELECT q.id AS id, q.exam_id AS exam_id, q.content AS content,
            COALESCE(q.question_type, 'other') AS question_type, q.options_json AS options_json,
            q.answer AS answer, q.explanation AS explanation,
            COALESCE(q.attempt_count, 0) AS attempt_count, q.is_correct AS is_correct
     FROM questions q
     JOIN exam_sheets e ON e.id = q.exam_id AND e.deleted_at IS NULL
     WHERE q.deleted_at IS NULL AND instr(COALESCE(q.explanation, ''), ?1) > 0`,
    [needle],
  );
  const out: MediaCheckpoint[] = [];
  for (const row of rows) {
    const explanation = row.explanation;
    if (typeof explanation !== 'string') continue;
    const seconds = mediaCitationSecondsFor(explanation, resourceId);
    if (seconds === null) continue;
    const attemptCount = int(row.attempt_count);
    out.push({
      questionId: text(row.id),
      examId: text(row.exam_id),
      seconds,
      content: text(row.content),
      questionType: text(row.question_type),
      optionsJson: typeof row.options_json === 'string' ? row.options_json : null,
      answer: typeof row.answer === 'string' ? row.answer : null,
      explanation,
      attemptCount,
      isCorrect: attemptCount > 0 ? optionalInt(row.is_correct) === 1 : null,
    });
  }
  out.sort((a, b) => a.seconds - b.seconds || a.questionId.localeCompare(b.questionId));
  return out;
}

const WEAK_PER_COURSE = 5;
const QUESTION_PREVIEW_CHARS = 80;
const U32_MAX = 4_294_967_295;

function clockSeconds(ms: number): number {
  return Math.min(Math.floor(Math.max(ms, 0) / 1000), U32_MAX);
}

/** `ledger.rs:317` `watched_ms.max(0) / 60_000`：i64 整数除法在 bigint 上算，结果 ≤ 153722867280912 < 2^53，投影为 number 无损。 */
function watchedMinutes(value: unknown): number {
  if (typeof value === 'bigint') return Number((value > 0n ? value : 0n) / 60_000n);
  return Math.floor(Math.max(int(value), 0) / 60_000);
}

const LEARNING_SUMMARY_QUERY = defineQuery<[number], Row>(
  `SELECT p.resource_id AS resource_id, f.file_name AS file_name,
          p.last_position_ms AS last_position_ms, p.duration_ms AS duration_ms,
          p.watched_ms AS watched_ms, p.finished AS finished, p.updated_at AS updated_at
   FROM media_progress p
   JOIN files f ON f.id = p.resource_id AND f.status = 'active' AND f.deleted_at IS NULL
   WHERE p.watched_ms > 0
   ORDER BY p.updated_at DESC
   LIMIT ?1`,
  { name: 'media.ledger.learningSummary', options: { safeIntegers: true } },
);

/**
 * `ledger.rs:265-319 media_learning_summary`：最近在看的课（看到哪、答错的检查点），
 * 供学习概览工具使用（`learning_overview_executor.rs:250`，limit=5）。
 */
export function mediaLearningSummary(
  conn: SqlExecutor,
  limit: number,
): { recentCourses: MediaCourseSummary[] } {
  const rows = conn.all(LEARNING_SUMMARY_QUERY, [limit]);
  const recentCourses = rows.map((row): MediaCourseSummary => {
    const id = text(row.resource_id);
    const positionMs = int(row.last_position_ms);
    const durationMs = optionalInt(row.duration_ms);
    const wrongCheckpoints = checkpointsWithConn(conn, id)
      .filter(cp => cp.isCorrect === false)
      .slice(0, WEAK_PER_COURSE)
      .map(cp => ({
        ref: mediaCitation(id, cp.seconds),
        question: Array.from(cp.content).slice(0, QUESTION_PREVIEW_CHARS).join(''),
        attempts: cp.attemptCount,
      }));
    return {
      resourceId: id,
      name: text(row.file_name),
      position: formatMediaClock(clockSeconds(positionMs)),
      positionRef: mediaCitation(id, clockSeconds(positionMs)),
      duration: durationMs === null ? null : formatMediaClock(clockSeconds(durationMs)),
      watchedMinutes: watchedMinutes(row.watched_ms),
      finished: int(row.finished) !== 0,
      lastWatchedAt: int(row.updated_at),
      wrongCheckpoints,
    };
  });
  return { recentCourses };
}
