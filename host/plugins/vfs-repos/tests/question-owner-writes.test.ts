import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-question-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.questions;

function insertExam(id: string) {
  db.run(`INSERT INTO exam_sheets(id,exam_name,status,temp_id,metadata_json,preview_json,created_at,updated_at)
    VALUES (?1,?1,'completed',?1,'{}','{}','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`, [id]);
}
function insertGroup(id: string, examId: string) {
  db.run(`INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at)
    VALUES (?1,?2,?1,0,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')`, [id, examId]);
}
function pendingQuestion(examId: string, content = 'essay question') {
  return repo().createQuestion(db, { exam_id: examId, content, question_type: 'essay' });
}
function pendingSubmission(questionId: string, answer: string, requestId: string | null = null) {
  repo().submitAnswer(db, questionId, answer, null, true);
  return repo().insertSubmission(db, questionId, answer, null, 'ai', requestId);
}
function submissionRow(id: string) {
  return db.get<{ is_correct: number | null; grading_method: string; updated_at: string | null; local_version: number; deleted_at: string | null }>(
    `SELECT is_correct,grading_method,updated_at,COALESCE(local_version,0) AS local_version,deleted_at
     FROM answer_submissions WHERE id=?1`, [id])!;
}

describe('question table-owner write entries', { timeout: 120_000 }, () => {
  it('apply_submission_verdict updates submission row and question counters atomically', () => {
    insertExam('exam-verdict');
    const question = pendingQuestion('exam-verdict');
    const submissionId = pendingSubmission(question.id, 'my essay');
    db.run("UPDATE questions SET sync_status='synced',content_hash='stale' WHERE id=?1", [question.id]);
    const before = submissionRow(submissionId);
    expect(before).toMatchObject({ is_correct: null, grading_method: 'ai', updated_at: null, local_version: 0 });

    const now = '2026-11-04T00:00:00Z';
    const first = repo().applySubmissionVerdict(db, question.id, submissionId, true, 'manual', now);
    expect(first.changed).toBe(true);
    expect(first.updated_question).toMatchObject({ is_correct: true, correct_count: 1, status: 'in_progress' });
    expect(submissionRow(submissionId)).toMatchObject({ is_correct: 1, grading_method: 'manual', updated_at: now, local_version: 1 });
    expect(db.pluck<number>("SELECT is_correct FROM answer_submissions WHERE id=?1", [submissionId])).toBe(1);
    expect(db.pluck('SELECT sync_status FROM questions WHERE id=?1', [question.id])).toBe('modified');
    expect(db.pluck<string>('SELECT content_hash FROM questions WHERE id=?1', [question.id])).not.toBe('stale');

    const stable = submissionRow(submissionId);
    const replay = repo().applySubmissionVerdict(db, question.id, submissionId, true, 'manual', '2026-11-04T01:00:00Z');
    expect(replay.changed).toBe(false);
    expect(replay.updated_question.correct_count).toBe(1);
    expect(submissionRow(submissionId)).toEqual(stable);

    const flip = repo().applySubmissionVerdict(db, question.id, submissionId, false, 'manual', '2026-11-04T02:00:00Z');
    expect(flip.changed).toBe(true);
    expect(flip.updated_question).toMatchObject({ is_correct: false, correct_count: 0, status: 'review' });
    expect(submissionRow(submissionId)).toMatchObject({ is_correct: 0, updated_at: '2026-11-04T02:00:00Z', local_version: 2 });

    const other = pendingQuestion('exam-verdict', 'other');
    expect(() => repo().applySubmissionVerdict(db, other.id, submissionId, true, 'manual', now))
      .toThrow(`作答记录不存在或不属于该题目: ${submissionId}`);
  });

  it('apply_submission_verdict only writes question status for the latest submission', () => {
    insertExam('exam-latest');
    const question = pendingQuestion('exam-latest');
    const older = pendingSubmission(question.id, 'older');
    const newer = pendingSubmission(question.id, 'newer');
    const outcome = repo().applySubmissionVerdict(db, question.id, older, true, 'manual', '2026-11-04T00:00:00Z');
    expect(outcome.updated_question).toMatchObject({ is_correct: null, correct_count: 1 });
    expect(outcome.updated_question.status).toBe('in_progress');
    expect(submissionRow(older).is_correct).toBe(1);
    expect(submissionRow(newer).is_correct).toBeNull();
  });

  it('mastery failure in the shared transaction rolls back the owner writes', () => {
    insertExam('exam-rollback');
    const question = pendingQuestion('exam-rollback');
    const submissionId = pendingSubmission(question.id, 'rollback essay');
    expect(() => db.transaction(tx => {
      repo().applySubmissionVerdict(tx, question.id, submissionId, true, 'manual', '2026-11-04T00:00:00Z');
      throw new Error('mastery write failed');
    })).toThrow('mastery write failed');
    expect(submissionRow(submissionId)).toMatchObject({ is_correct: null, updated_at: null, local_version: 0 });
    expect(repo().getQuestion(db, question.id)).toMatchObject({ is_correct: null, correct_count: 0 });
  });

  it('reset_exam_progress clears progress and submissions, then refreshes stats', () => {
    insertExam('exam-reset');
    const first = pendingQuestion('exam-reset', 'first');
    const second = pendingQuestion('exam-reset', 'second');
    firstAnswer(first.id, 'exam-reset');
    firstAnswer(second.id, 'exam-reset');
    db.run("UPDATE questions SET sync_status='synced',content_hash='stale' WHERE exam_id='exam-reset'");
    const stats = repo().resetExamProgress(db, 'exam-reset', '2026-11-04T00:00:00Z');
    expect(stats).toMatchObject({ exam_id: 'exam-reset', total_count: 2, total_attempts: 0, total_correct: 0, correct_rate: 0 });
    expect(db.pluck<number>('SELECT COUNT(*) FROM answer_submissions WHERE question_id IN (SELECT id FROM questions WHERE exam_id=?1)', ['exam-reset'])).toBe(0);
    for (const question of repo().listQuestions(db, 'exam-reset', {}, 1, 50).questions) {
      expect(question).toMatchObject({ status: 'new', user_answer: null, is_correct: null, attempt_count: 0, correct_count: 0 });
      expect(db.pluck('SELECT sync_status FROM questions WHERE id=?1', [question.id])).toBe('modified');
      expect(db.pluck<string>('SELECT content_hash FROM questions WHERE id=?1', [question.id])).not.toBe('stale');
    }
  });

  it('reset_question_progress returns exam id, clears one question and keeps the rest', () => {
    insertExam('exam-reset-one');
    const first = pendingQuestion('exam-reset-one', 'first');
    const second = pendingQuestion('exam-reset-one', 'second');
    firstAnswer(first.id, 'exam-reset-one');
    firstAnswer(second.id, 'exam-reset-one');
    expect(repo().resetQuestionProgress(db, first.id, '2026-11-04T00:00:00Z')).toBe('exam-reset-one');
    expect(repo().getQuestion(db, first.id)).toMatchObject({ status: 'new', attempt_count: 0, correct_count: 0, user_answer: null, is_correct: null });
    expect(db.pluck<number>('SELECT COUNT(*) FROM answer_submissions WHERE question_id=?1', [first.id])).toBe(0);
    expect(repo().getQuestion(db, second.id)).toMatchObject({ status: 'in_progress', attempt_count: 1 });
    expect(() => repo().resetQuestionProgress(db, 'missing', '2026-11-04T00:00:00Z')).toThrow('missing: not found');
  });

  it('daily_progress_rows reads submission facts without duplicating legacy last_attempt rows', () => {
    insertExam('exam-progress');
    const submissionQuestion = pendingQuestion('exam-progress', 'submitted');
    const submissionId = pendingSubmission(submissionQuestion.id, 'answer');
    repo().updateSubmissionCorrect(db, submissionId, true, 'auto');
    const legacy = pendingQuestion('exam-progress', 'legacy');
    db.run("UPDATE questions SET last_attempt_at='2026-11-04T12:00:00Z',is_correct=1 WHERE id=?1", [legacy.id]);
    db.run("UPDATE answer_submissions SET submitted_at='2026-11-04T12:00:00Z' WHERE id=?1", [submissionId]);
    const date = db.pluck<string>("SELECT DATE('2026-11-04T12:00:00Z','localtime')")!;
    const progress = repo().dailyProgressRows(db, 'exam-progress', date);
    expect(new Set(progress.ids)).toEqual(new Set([submissionQuestion.id, legacy.id]));
    expect(progress.correct).toBe(2);
  });

  it('authoring metadata and group entries preserve their raw column semantics', () => {
    insertExam('exam-meta');
    for (const groupId of ['group-a', 'group-b', 'group-c']) insertGroup(groupId, 'exam-meta');
    const question = repo().createQuestion(db, { exam_id: 'exam-meta', content: 'meta' });
    db.run("UPDATE questions SET sync_status='local_only' WHERE id=?1", [question.id]);
    const updated = repo().applyQuestionMetadata(db, question.id, {
      card_id: question.id, group_id: 'group-a', group_position: 0, source_key: 'slot-a',
      provenance: { source_refs: [{ source_id: 'src', page: 1, bbox: null }] },
      answer_origin: 'manual', parent_id: null,
    });
    expect(updated).toMatchObject({ card_id: question.id, group_id: 'group-a', group_position: 0, source_key: 'slot-a', answer_origin: 'manual' });
    expect(updated.source_refs).toEqual([{ source_id: 'src', page: 1, bbox: null }]);
    // schema trigger `trg_questions_updated_at` 会在列值未变时补时间戳，与 L14 原 SQL 相同。
    expect(updated.updated_at).not.toBe('');
    expect(db.pluck('SELECT sync_status FROM questions WHERE id=?1', [question.id])).toBe('local_only');

    expect(repo().updateQuestionGroupMembership(db, question.id, {
      group_id: 'group-b', group_position: 3, exam_id: 'exam-meta', expected_group_id: 'group-a',
    })).toBe(1);
    expect(repo().updateQuestionGroupMembership(db, question.id, {
      group_id: 'group-c', group_position: 4, exam_id: 'exam-meta', expected_group_id: 'group-a',
    })).toBe(0);
    expect(repo().updateQuestionGroupMembership(db, question.id, {
      group_id: 'group-b', group_position: 4, exam_id: 'exam-meta', allow_existing_group: true,
    })).toBe(1);
    expect(repo().getQuestion(db, question.id)).toMatchObject({ group_id: 'group-b', group_position: 4 });
    expect(repo().updateQuestionGroupMembership(db, question.id, {
      group_id: 'group-c', group_position: 5, exam_id: 'exam-meta', allow_existing_group: true,
    })).toBe(0);

    expect(repo().softDeleteQuestionInGroup(db, question.id, 'exam-meta', '2026-11-04T00:00:00Z')).toBe(1);
    expect(db.get('SELECT deleted_at,group_id,group_position FROM questions WHERE id=?1', [question.id]))
      .toMatchObject({ group_id: null, group_position: null });
  });

  it('legacy card, provenance and reparse entries retain OCC and COALESCE image behavior', () => {
    insertExam('exam-legacy');
    const question = repo().createQuestion(db, {
      exam_id: 'exam-legacy', content: 'old content',
      images: [{ id: 'img', name: 'a.png', mime: 'image/png', hash: 'h1' }],
    });
    db.run("UPDATE questions SET provenance_json='{\"keep\":true}',sync_status='local_only' WHERE id=?1", [question.id]);
    expect(repo().bindQuestionCard(db, 'wrong-exam', 'card-1', question.id, '2026-11-04T00:00:00Z')).toBe(0);
    expect(repo().bindQuestionCard(db, 'exam-legacy', 'card-1', question.id, '2026-11-04T00:00:00Z')).toBe(1);
    expect(db.pluck('SELECT card_id FROM questions WHERE id=?1', [question.id])).toBe('card-1');

    expect(repo().mergeQuestionProvenance(db, question.id, { legacy: { audit: 1 } })).toBe(1);
    expect(repo().mergeQuestionProvenance(db, question.id, { reparse: { job: 'j1' } })).toBe(1);
    expect(repo().getQuestion(db, question.id)?.source_refs).toEqual([]);
    expect(JSON.parse(db.pluck<string>('SELECT provenance_json FROM questions WHERE id=?1', [question.id])!))
      .toMatchObject({ keep: true, legacy: { audit: 1 }, reparse: { job: 'j1' } });

    db.run("UPDATE questions SET sync_status='synced' WHERE id=?1", [question.id]);
    const current = repo().getQuestion(db, question.id)!;
    const changed = repo().replaceQuestionForReparse(db, 'exam-legacy', question.id, current.updated_at, {
      content: 'new content', options: null, answer: 'new answer', explanation: 'new explanation',
      question_type: 'short_answer', difficulty: 'easy', tags: ['tag'],
      structured_data: { steps: 1 }, images: [], provenance_marker: { reparse: { action: 'replace_existing' } },
    }, '2026-11-04T03:00:00Z');
    expect(changed).toBe(1);
    const replaced = repo().getQuestion(db, question.id)!;
    expect(replaced).toMatchObject({ content: 'new content', answer: 'new answer', question_type: 'short_answer', difficulty: 'easy', tags: ['tag'], updated_at: '2026-11-04T03:00:00Z' });
    expect(replaced.images).toEqual([{ id: 'img', name: 'a.png', mime: 'image/png', hash: 'h1' }]);
    expect(db.pluck('SELECT sync_status FROM questions WHERE id=?1', [question.id])).toBe('modified');
    expect(JSON.parse(db.pluck<string>('SELECT provenance_json FROM questions WHERE id=?1', [question.id])!))
      .toMatchObject({ keep: true, reparse: { action: 'replace_existing' } });

    expect(repo().replaceQuestionForReparse(db, 'exam-legacy', question.id, current.updated_at, {
      content: 'stale', options: null, answer: null, explanation: null, question_type: 'short_answer',
      difficulty: null, tags: [], structured_data: null, images: [], provenance_marker: {},
    }, '2026-11-05T00:00:00Z')).toBe(0);
    expect(repo().getQuestion(db, question.id)?.content).toBe('new content');
  });
});

function firstAnswer(questionId: string, examId: string): void {
  repo().submitAnswer(db, questionId, 'answer', true, false);
  repo().insertSubmission(db, questionId, 'answer', true, 'auto', null);
  repo().refreshStats(db, examId);
}
