import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractQuestionsFromSession, submitAnswer } from '@/api/questionBankApi';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('questionBankApi legacy behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps indefinite choice question type from preview cards', () => {
    const detail = {
      preview: {
        pages: [
          {
            cards: [
              {
                card_id: 'c1',
                question_label: '1',
                ocr_text: 'test',
                question_type: 'indefinite_choice',
                options: [],
                tags: [],
              },
            ],
          },
        ],
      },
    } as any;

    const questions = extractQuestionsFromSession(detail);
    expect(questions[0]?.questionType).toBe('indefinite_choice');
  });

  it('returns null correctness for subjective question submission', async () => {
    vi.mocked(invoke).mockResolvedValue({
      detail: {
        preview: {
          pages: [
            {
              cards: [
                {
                  card_id: 'c1',
                  answer: '参考答案',
                },
              ],
            },
          ],
        },
      },
    } as any);

    const result = await submitAnswer('s1', 'c1', '我的答案', 'essay');
    expect(result.isCorrect).toBeNull();
    expect(result.needsManualGrading).toBe(true);
  });
});
