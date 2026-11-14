import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); });

describe('question_sync_service.rs live metadata path through L11', { timeout: 120_000 }, () => {
  it('test_content_hash_consistency', () => {
    const db = vfs.storage.database('vfs');
    const repos = vfs.host.ctx.vfsRepo;
    const exam = repos.exams.createExamSheet(db, { tempId: 'hash-test', metadataJson: {}, previewJson: {} });
    const question = repos.questions.createQuestion(db, {
      exam_id: exam.id, question_label: 'Q1', content: 'What is 2+2?',
      options: [{ key: 'A', content: '3' }, { key: 'B', content: '4' }],
      answer: 'B', explanation: 'Basic arithmetic', question_type: 'single_choice',
      difficulty: 'easy', tags: ['math'], source_type: 'ocr', images: [],
    });
    const hash = () => db.one<{ content_hash: string }>(
      'SELECT content_hash FROM questions WHERE id = ?1', [question.id]).content_hash;
    // updateQuestion/submitAnswer invoke the owning repository's real
    // markAsModified/updateContentHash implementation in production.
    repos.questions.updateQuestion(db, question.id, { content: question.content });
    const hash1 = hash();
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    repos.questions.updateQuestion(db, question.id, { content: question.content });
    expect(hash()).toBe(hash1);
    const answered = repos.questions.submitAnswer(db, question.id, 'A', false, false);
    expect(answered.user_answer).toBe('A');
    expect(answered.attempt_count).toBe(1);
    expect(hash()).toBe(hash1);
    repos.questions.updateQuestion(db, question.id, { content: 'What is 3+3?' });
    expect(hash()).not.toBe(hash1);
  });
});
