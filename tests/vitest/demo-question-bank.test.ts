import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question, QuestionListResult, SubmitAnswerResult } from '@/stores/questionBankStore';

describe('demo question bank with the production grader', () => {
  beforeEach(() => vi.resetModules());

  it('keeps selected imports, grades answers, and restores results when reopened', async () => {
    const { handleDemoQuestionBank: invoke } = await import('@/demo/questionBank');
    const { DEMO_QUESTIONS, DEMO_QBANK_ID } = await import('@/demo/fixtures');
    const request = { exam_id: DEMO_QBANK_ID, page: 1, page_size: 20, filters: {} };
    expect((await invoke('qbank_list_questions', { request }) as QuestionListResult).total).toBe(0);
    const created = await invoke('qbank_batch_create_questions', {
      paramsList: [{ ...DEMO_QUESTIONS[1], exam_id: DEMO_QBANK_ID }],
    }) as Question[];
    const listed = await invoke('qbank_list_questions', { request }) as QuestionListResult;
    expect(listed.questions.map(q => q.content)).toEqual([DEMO_QUESTIONS[1].content]);
    expect(listed.questions[0].status).toBe('new');

    const wrong = await invoke('qbank_submit_answer', {
      request: { question_id: created[0].id, user_answer: 'B' },
    }) as SubmitAnswerResult;
    expect(wrong.is_correct).toBe(false);
    expect(wrong.updated_question.status).toBe('review');
    expect(wrong.correct_answer).toBe('A');
    expect(wrong.updated_question.explanation).toBe(DEMO_QUESTIONS[1].explanation);

    const correct = await invoke('qbank_submit_answer', {
      request: { question_id: created[0].id, user_answer: 'A' },
    }) as SubmitAnswerResult;
    expect(correct.is_correct).toBe(true);
    expect(correct.updated_stats.total_attempts).toBe(2);
    expect(correct.updated_stats.correct_rate).toBe(0.5);
    const reopened = await invoke('qbank_list_questions', { request }) as QuestionListResult;
    expect(reopened.questions[0].user_answer).toBe('A');
    expect(reopened.questions[0].attempt_count).toBe(2);

    const regraded = await invoke('qbank_submit_answer', {
      request: { question_id: created[0].id, user_answer: 'A', is_correct_override: false,
        regrade_submission_id: correct.submission_id },
    }) as SubmitAnswerResult;
    expect(regraded.updated_question.attempt_count).toBe(2);
    expect(regraded.updated_question.correct_count).toBe(0);
  });
});
