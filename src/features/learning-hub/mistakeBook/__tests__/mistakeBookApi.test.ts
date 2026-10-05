import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { listMistakes } from '../mistakeBookApi';

describe('listMistakes', () => {
  beforeEach(() => invoke.mockReset());

  it('sends snake_case filters and maps backend questions for the shared question UI', async () => {
    invoke.mockResolvedValue({
      items: [{
        id: 'q1',
        exam_id: 'exam-a',
        exam_name: '高数',
        content: '求极限',
        question_type: 'single_choice',
        options: [{ key: 'A', content: '0' }],
        answer: 'A',
        user_answer: 'B',
        tags: ['极限'],
        status: 'review',
        attempt_count: 3,
        correct_count: 1,
        last_attempt_at: '2026-10-04T00:00:00Z',
        source_ref: '{"resourceIds":["res_1"]}',
      }],
      total: 7,
      page: 1,
      has_more: true,
      exams: [{ exam_id: 'exam-a', exam_name: '高数', count: 7 }],
    });

    const page = await listMistakes({ examId: 'exam-a', search: '  极限 ', sort: 'errors' });

    expect(invoke).toHaveBeenCalledWith('qbank_list_mistakes', {
      request: { filters: { exam_id: 'exam-a', search: '极限', sort: 'errors' }, page: 1, page_size: 50 },
    });
    expect(page).toMatchObject({ total: 7, page: 1, hasMore: true, exams: [{ examId: 'exam-a', examName: '高数', count: 7 }] });
    expect(page.items[0]).toMatchObject({
      examId: 'exam-a',
      examName: '高数',
      question: {
        id: 'q1',
        content: '求极限',
        questionType: 'single_choice',
        userAnswer: 'B',
        attemptCount: 3,
        correctCount: 1,
        lastAttemptAt: '2026-10-04T00:00:00Z',
        sourceRef: '{"resourceIds":["res_1"]}',
      },
    });
  });

  it('treats blank filters as no filter', async () => {
    invoke.mockResolvedValue({ items: [], total: 0, page: 2, has_more: false, exams: [] });
    await listMistakes({ examId: null, search: '   ', page: 2 });
    expect(invoke).toHaveBeenCalledWith('qbank_list_mistakes', {
      request: { filters: { exam_id: null, search: null, sort: 'recent' }, page: 2, page_size: 50 },
    });
  });
});
