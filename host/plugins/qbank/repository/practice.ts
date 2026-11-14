/** Durable practice drafts, papers and submitted attempts, mirroring qbank_practice.rs. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  GeneratedPaper, PaperConfig, PracticeAttempt, PracticeDraft, PracticeSummary,
} from '../api.ts';
import { generatedPaper, practiceAttempt, practiceDraft } from './practice-decode.ts';
import { fromStr, type Decoder } from './serde-decode.ts';

/** qbank_practice.rs:131 `decode` = `serde_json::from_str::<T>`. */
function json<T>(raw: string, decode: Decoder<T>): T {
  return fromStr(raw, decode);
}

export function loadDraft(db: SqlExecutor, id: string): PracticeDraft | null {
  const raw = db.pluck<string>('SELECT document_json FROM qbank_practice_drafts WHERE id = ?1', [id]);
  return raw === undefined ? null : json(raw, practiceDraft);
}

export function loadAttempt(db: SqlExecutor, id: string): PracticeAttempt | null {
  const raw = db.pluck<string>(
    'SELECT document_json FROM qbank_practice_attempts WHERE id = ?1 AND deleted_at IS NULL', [id]);
  return raw === undefined ? null : json(raw, practiceAttempt);
}

export function savePaper(db: SqlExecutor, paper: GeneratedPaper, deviceId: string): void {
  db.run(`INSERT INTO qbank_papers(id, exam_id, title, document_json, device_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  [paper.id, paper.exam_id, paper.title, JSON.stringify(paper), deviceId, paper.created_at]);
}

export function loadPaper(db: SqlExecutor, id: string): GeneratedPaper | null {
  const raw = db.pluck<string>(
    'SELECT document_json FROM qbank_papers WHERE id = ?1 AND deleted_at IS NULL', [id]);
  return raw === undefined ? null : json(raw, generatedPaper);
}

export function listPapers(db: SqlExecutor, examId: string): GeneratedPaper[] {
  return db.all<{ document_json: string }>(
    `SELECT document_json FROM qbank_papers WHERE exam_id = ?1 AND deleted_at IS NULL
     ORDER BY created_at DESC`, [examId]).map(row => json(row.document_json, generatedPaper));
}

export function updatePaper(db: SqlExecutor, id: string, paper: GeneratedPaper,
  deleted: boolean, now: string): void {
  db.run(`UPDATE qbank_papers SET title = ?2, document_json = ?3, deleted_at = ?4,
      updated_at = ?5, local_version = local_version + 1 WHERE id = ?1`,
  [id, paper.title, JSON.stringify(paper), deleted ? now : null, now]);
}

/** qbank_executor.rs:4144 — rewrite the stored document only (updated_at untouched). */
export function rewritePaperDocument(db: SqlExecutor, paper: GeneratedPaper): void {
  db.run('UPDATE qbank_papers SET document_json=?2,local_version=local_version+1 WHERE id=?1',
    [paper.id, JSON.stringify(paper)]);
}

export function persistAttempt(db: SqlExecutor, attempt: PracticeAttempt, now: string): number {
  return db.run(`UPDATE qbank_practice_attempts SET document_json = ?2, updated_at = ?3,
      local_version = local_version + 1 WHERE id = ?1 AND deleted_at IS NULL`,
  [attempt.id, JSON.stringify(attempt), now]).changes;
}

export function insertDraft(db: SqlExecutor, draft: PracticeDraft): void {
  db.run(`INSERT INTO qbank_practice_drafts(id, scope_id, paper_id, document_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  [draft.id, draft.scope_id, draft.paper_id, JSON.stringify(draft), draft.created_at]);
}

export function updateDraft(db: SqlExecutor, draft: PracticeDraft, expectedRevision: number): number {
  return db.run(`UPDATE qbank_practice_drafts SET document_json = ?2, revision = ?3, updated_at = ?4
    WHERE id = ?1 AND revision = ?5`,
  [draft.id, JSON.stringify(draft), draft.revision, draft.updated_at, expectedRevision]).changes;
}

export function insertAttempt(db: SqlExecutor, attempt: PracticeAttempt, deviceId: string): void {
  db.run(`INSERT INTO qbank_practice_attempts(id, scope_id, paper_id, document_json, device_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  [attempt.id, attempt.scope_id, attempt.paper_id, JSON.stringify(attempt), deviceId, attempt.submitted_at]);
}

export function insertJob(db: SqlExecutor, attemptId: string, questionId: string, updatedAt: string): void {
  db.run(`INSERT INTO qbank_practice_jobs(id, attempt_id, question_id, status, updated_at)
    VALUES (?1, ?2, ?3, 'queued', ?4)`,
  [`${attemptId}:${questionId}`, attemptId, questionId, updatedAt]);
}

export function queueJob(db: SqlExecutor, attemptId: string, questionId: string, updatedAt: string): void {
  db.run(`INSERT INTO qbank_practice_jobs(id, attempt_id, question_id, status, updated_at)
    VALUES (?1, ?2, ?3, 'queued', ?4)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET
      status = 'queued', error = NULL, updated_at = excluded.updated_at`,
  [`${attemptId}:${questionId}`, attemptId, questionId, updatedAt]);
}

export function finishJob(db: SqlExecutor, attemptId: string, questionId: string, updatedAt: string): void {
  db.run('UPDATE qbank_practice_jobs SET status = ?3, updated_at = ?4 WHERE attempt_id = ?1 AND question_id = ?2',
    [attemptId, questionId, 'done', updatedAt]);
}

export function deleteDraft(db: SqlExecutor, id: string): void {
  db.run('DELETE FROM qbank_practice_drafts WHERE id = ?1', [id]);
}

export function deleteAttempt(db: SqlExecutor, id: string, now: string): void {
  db.run(`UPDATE qbank_practice_attempts SET deleted_at = ?2, updated_at = ?2,
      local_version = local_version + 1 WHERE id = ?1`, [id, now]);
}

/** qbank_executor.rs:4041-4049: raw `document_json` rows behind `qbank_list_papers` / `qbank_list_practices`. */
export function listPaperDocumentJson(db: SqlExecutor, examId: string): string[] {
  return db.all<{ document_json: string }>(
    'SELECT document_json FROM qbank_papers WHERE exam_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [examId]).map(row => row.document_json);
}

export function listAttemptDocumentJson(db: SqlExecutor, scopeId: string): string[] {
  return db.all<{ document_json: string }>(
    'SELECT document_json FROM qbank_practice_attempts WHERE scope_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [scopeId]).map(row => row.document_json);
}

export function listDraftDocuments(db: SqlExecutor, scopeId: string, offset: number): PracticeDraft[] {
  return db.all<{ document_json: string }>(
    `SELECT document_json FROM qbank_practice_drafts WHERE scope_id = ?1
     ORDER BY updated_at DESC, id DESC LIMIT 200 OFFSET ?2`, [scopeId, offset])
    .map(row => json(row.document_json, practiceDraft));
}

export function listAttemptDocuments(db: SqlExecutor, scopeId: string, offset: number): PracticeAttempt[] {
  return db.all<{ document_json: string }>(
    `SELECT document_json FROM qbank_practice_attempts WHERE scope_id = ?1 AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 200 OFFSET ?2`, [scopeId, offset])
    .map(row => json(row.document_json, practiceAttempt));
}

export function draftSummary(draft: PracticeDraft, updatedAt: string): PracticeSummary {
  return {
    id: draft.id, title: draft.title, mode: draft.mode, paper_id: draft.paper_id,
    question_count: draft.questions.length, answered_count: Object.keys(draft.answers).length,
    correct_count: 0, pending_count: 0, status: 'draft', updated_at: updatedAt,
  };
}

export function attemptSummary(attempt: PracticeAttempt, updatedAt: string): PracticeSummary {
  return {
    id: attempt.id, title: attempt.title, mode: attempt.mode, paper_id: attempt.paper_id,
    question_count: attempt.questions.length, answered_count: Object.keys(attempt.answers).length,
    correct_count: attempt.results.filter(result => result.is_correct === true).length,
    pending_count: attempt.results.filter(result => result.status === 'pending' || result.status === 'failed').length,
    status: attempt.status, updated_at: updatedAt,
  };
}

/** qbank_practice.rs:601-662 returns the persisted updated_at, not the document copy. */
export function listPracticeSummaries(db: SqlExecutor, scopeId: string, submitted: boolean,
  offset: number): PracticeSummary[] {
  if (submitted) {
    return db.all<{ document_json: string; updated_at: string }>(
      `SELECT document_json, updated_at FROM qbank_practice_attempts
       WHERE scope_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 200 OFFSET ?2`,
      [scopeId, offset]).map(row => attemptSummary(json(row.document_json, practiceAttempt), row.updated_at));
  }
  return db.all<{ document_json: string; updated_at: string }>(
    `SELECT document_json, updated_at FROM qbank_practice_drafts
     WHERE scope_id = ?1 ORDER BY updated_at DESC, id DESC LIMIT 200 OFFSET ?2`,
    [scopeId, offset]).map(row => draftSummary(json(row.document_json, practiceDraft), row.updated_at));
}

export function draftDeadlineDocuments(db: SqlExecutor): PracticeDraft[] {
  return db.all<{ document_json: string }>(
    `SELECT document_json FROM qbank_practice_drafts
     WHERE json_extract(document_json, '$.deadline') IS NOT NULL`)
    .map(row => json(row.document_json, practiceDraft));
}

export function resetRunningJobs(db: SqlExecutor): void {
  db.run("UPDATE qbank_practice_jobs SET status = 'queued' WHERE status = 'running'");
}

export function nextQueuedJob(db: SqlExecutor, deviceId: string): { id: string; attempt_id: string; question_id: string } | null {
  return db.get<{ id: string; attempt_id: string; question_id: string }>(
    `SELECT j.id, j.attempt_id, j.question_id FROM qbank_practice_jobs j
     JOIN qbank_practice_attempts a ON a.id = j.attempt_id
     WHERE j.status = 'queued' AND a.deleted_at IS NULL AND a.device_id = ?1
     ORDER BY j.updated_at, j.id LIMIT 1`, [deviceId]) ?? null;
}

export function markJobRunning(db: SqlExecutor, jobId: string, now: string): void {
  db.run("UPDATE qbank_practice_jobs SET status = 'running', updated_at = ?2 WHERE id = ?1", [jobId, now]);
}

export function markJobDone(db: SqlExecutor, jobId: string, now: string): void {
  db.run('UPDATE qbank_practice_jobs SET status = ?2, updated_at = ?3 WHERE id = ?1', [jobId, 'done', now]);
}

export function markJobFailed(db: SqlExecutor, jobId: string, error: string, now: string): void {
  db.run('UPDATE qbank_practice_jobs SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1',
    [jobId, 'failed', error, now]);
}

export function paperConfigTitle(config: PaperConfig): string {
  return config.title;
}
