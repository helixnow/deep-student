import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { GeneratedQuestionDraft, GenerationTaskStatus, GenerationTaskView, SkippedReference } from '../api.ts';
import { decodeGeneratedDraft } from '../src/generated-draft.ts';

export interface GenerationTaskRecord {
  id: string;
  exam_id: string;
  status: GenerationTaskStatus;
  request_json: string;
  drafts: GeneratedQuestionDraft[];
  rejected_count: number;
  rejection_reasons: string[];
  skipped_references: SkippedReference[];
  used_reference_count: number;
  stream_event: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  authoring_result: unknown | null;
}

interface TaskRow {
  id: string; exam_id: string; status: string; request_json: string; drafts_json: string | null;
  rejected_count: number; rejection_reasons_json: string; skipped_references_json: string;
  used_reference_count: number; stream_event: string; error: string | null; created_at: number;
  updated_at: number; finished_at: number | null; authoring_result_json: string | null;
}

export function parseTaskStatus(status: string): GenerationTaskStatus {
  return status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'queued';
}
export function isTerminal(status: GenerationTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
export function taskView(record: GenerationTaskRecord): GenerationTaskView {
  return {
    id: record.id, examId: record.exam_id, status: record.status, drafts: record.drafts,
    rejectedCount: record.rejected_count, rejectionReasons: record.rejection_reasons,
    skippedReferences: record.skipped_references, usedReferenceCount: record.used_reference_count,
    error: record.error, createdAt: record.created_at, updatedAt: record.updated_at,
    finishedAt: record.finished_at, authoringResult: record.authoring_result,
  };
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function rowToRecord(row: TaskRow): GenerationTaskRecord {
  const rawDrafts = parsed(row.drafts_json);
  const decoded = Array.isArray(rawDrafts) ? rawDrafts.map(decodeGeneratedDraft) : [];
  const reasons = parsed(row.rejection_reasons_json);
  const skipped = parsed(row.skipped_references_json);
  const validSkipped = Array.isArray(skipped) && skipped.every(item => item !== null && typeof item === 'object'
    && typeof item.name === 'string' && typeof item.reason === 'string' && (item.detail == null || typeof item.detail === 'string'));
  return {
    id: row.id, exam_id: row.exam_id, status: parseTaskStatus(row.status), request_json: row.request_json,
    drafts: decoded.every((draft): draft is GeneratedQuestionDraft => draft !== null) ? decoded : [],
    rejected_count: Math.max(0, row.rejected_count),
    rejection_reasons: Array.isArray(reasons) && reasons.every(reason => typeof reason === 'string') ? reasons : [],
    skipped_references: validSkipped ? skipped.map(item => ({ name: item.name, reason: item.reason,
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}) })) : [],
    used_reference_count: Math.max(0, row.used_reference_count), stream_event: row.stream_event,
    error: row.error, created_at: row.created_at, updated_at: row.updated_at, finished_at: row.finished_at,
    authoring_result: parsed(row.authoring_result_json),
  };
}
function dbOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new Error(`Database error: 出题任务表操作失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
const COLUMNS = `id, exam_id, status, request_json, drafts_json, rejected_count,
  rejection_reasons_json, skipped_references_json, used_reference_count,
  stream_event, error, created_at, updated_at, finished_at, authoring_result_json`;

export function getTask(db: SqlExecutor, taskId: string): GenerationTaskRecord | null {
  return dbOperation(() => {
    const row = db.get<TaskRow>(`SELECT ${COLUMNS} FROM qbank_generation_tasks WHERE id = ?1`, [taskId]);
    return row ? rowToRecord(row) : null;
  });
}
export function listTasks(db: SqlExecutor, examId: string, limit: number): GenerationTaskRecord[] {
  return dbOperation(() => db.all<TaskRow>(`SELECT ${COLUMNS} FROM qbank_generation_tasks
    WHERE exam_id = ?1 ORDER BY created_at DESC LIMIT ?2`, [examId, limit]).map(rowToRecord));
}
export function createTask(db: SqlExecutor, taskId: string, examId: string, requestJson: string, streamEvent: string): GenerationTaskRecord {
  const now = Date.now();
  dbOperation(() => db.run(`INSERT INTO qbank_generation_tasks
    (id, exam_id, status, request_json, drafts_json, rejected_count,
     rejection_reasons_json, skipped_references_json, used_reference_count, stream_event, created_at, updated_at)
    VALUES (?1, ?2, 'queued', ?3, NULL, 0, '[]', '[]', 0, ?4, ?5, ?5)`, [taskId, examId, requestJson, streamEvent, now]));
  const result = getTask(db, taskId);
  if (!result) throw new Error('任务创建后读取失败');
  return result;
}
export function markRunning(db: SqlExecutor, taskId: string): void {
  dbOperation(() => db.run(`UPDATE qbank_generation_tasks SET status = ?2, error = ?3, updated_at = ?4
    WHERE id = ?1 AND status IN ('queued','running')`, [taskId, 'running', null, Date.now()]));
}
export function markCompleted(db: SqlExecutor, taskId: string, drafts: GeneratedQuestionDraft[], rejectedCount: number,
  rejectionReasons: string[], skippedReferences: SkippedReference[], usedReferenceCount: number): void {
  dbOperation(() => db.run(`UPDATE qbank_generation_tasks
    SET status = 'completed', drafts_json = ?2, rejected_count = ?3, rejection_reasons_json = ?4,
    skipped_references_json = ?5, used_reference_count = ?6, error = NULL, updated_at = ?7, finished_at = ?7
    WHERE id = ?1 AND status IN ('queued', 'running')`,
  [taskId, JSON.stringify(drafts), rejectedCount, JSON.stringify(rejectionReasons), JSON.stringify(skippedReferences), usedReferenceCount, Date.now()]));
}
export function markFailed(db: SqlExecutor, taskId: string, error: string): void {
  dbOperation(() => db.run(`UPDATE qbank_generation_tasks SET status = 'failed', error = ?2, updated_at = ?3, finished_at = ?3
    WHERE id = ?1 AND status IN ('queued', 'running')`, [taskId, error, Date.now()]));
}
export function saveAuthoringResult(db: SqlExecutor, taskId: string, response: unknown): void {
  dbOperation(() => db.run(`UPDATE qbank_generation_tasks SET authoring_result_json=?1
    WHERE id=?2 AND status IN ('queued','running')`, [JSON.stringify(response), taskId]));
}
export function markCancelled(db: SqlExecutor, taskId: string): void {
  dbOperation(() => db.run(`UPDATE qbank_generation_tasks SET status = 'cancelled', updated_at = ?2, finished_at = ?2
    WHERE id = ?1 AND status IN ('queued', 'running')`, [taskId, Date.now()]));
}
export function recoverInterruptedTasks(db: SqlExecutor): number {
  return dbOperation(() => db.run(`UPDATE qbank_generation_tasks SET status = 'failed',
    error = '应用重启导致任务中断，请重新生成', updated_at = ?1, finished_at = ?1
    WHERE status IN ('queued', 'running')`, [Date.now()]).changes);
}
