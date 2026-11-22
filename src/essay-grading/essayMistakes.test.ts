import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const ensureMock = vi.fn();
const refreshTodayLearningMock = vi.fn(async () => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@/utils/ensureNamedExam', () => ({ ensureNamedExam: (...args: unknown[]) => ensureMock(...args) }));
vi.mock('@/features/learning-today', () => ({ refreshTodayLearning: () => refreshTodayLearningMock() }));
vi.mock('i18next', () => ({
  default: {
    t: (_key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue ?? _key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''));
    },
  },
}));

import { buildEssayMistakeDrafts, saveEssayMistakes } from './essayMistakes';

const GRADING = [
  '他<replace old="非常很高兴" new="非常高兴" reason="程度副词重复"/>地回家了。',
  '<err type="grammar" explanation="主谓搭配不当">我的理想被实现了</err>',
  '<good>结尾点题有力</good>',
  '<replace old="非常很高兴" new="非常高兴" reason="重复项"/>',
].join('\n');

describe('essay mistakes', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    ensureMock.mockReset().mockResolvedValue('exam_essay');
    refreshTodayLearningMock.mockClear();
  });

  it('turns replace and err markers into correction questions, de-duplicated', () => {
    const drafts = buildEssayMistakeDrafts(GRADING);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ answer: '非常高兴', explanation: '程度副词重复' });
    expect(drafts[0].content).toContain('非常很高兴');
    expect(drafts[1].content).toContain('我的理想被实现了');
    expect(drafts[1].answer).toBe('grammar：主谓搭配不当');
    expect(drafts[1].explanation).toBe('主谓搭配不当');
    // 错误类型排在首位，掌握度按它归类
    expect(drafts[1].tags[0]).toBe('grammar');

    const noExplDrafts = buildEssayMistakeDrafts('<err type="spelling">recieve</err>');
    expect(noExplDrafts[0]?.answer).toBe('spelling');
    expect(noExplDrafts[0]?.explanation).toBe('spelling');
  });

  it('writes drafts into the essay mistake set and skips when nothing to save', async () => {
    await expect(saveEssayMistakes('<good>好</good>')).resolves.toEqual({ count: 0, examId: null });
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'qbank_batch_create_questions') {
        return [{ id: 'q_essay_1' }, { id: 'q_essay_2' }];
      }
      return undefined;
    });

    await expect(saveEssayMistakes(GRADING)).resolves.toEqual({ count: 2, examId: 'exam_essay' });
    const batchCreateCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'qbank_batch_create_questions');
    expect(batchCreateCall).toBeDefined();
    const [command, payload] = batchCreateCall!;
    expect(command).toBe('qbank_batch_create_questions');
    expect(payload.paramsList).toHaveLength(2);
    expect(payload.paramsList[0]).toMatchObject({
      exam_id: 'exam_essay',
      answer: '非常高兴',
      question_type: 'short_answer',
      source_type: 'manual',
    });
    expect(payload.paramsList[1]).toMatchObject({
      exam_id: 'exam_essay',
      answer: 'grammar：主谓搭配不当',
      question_type: 'short_answer',
      source_type: 'manual',
    });
    expect(invokeMock).toHaveBeenCalledWith('qbank_batch_update_questions', {
      request: {
        question_ids: ['q_essay_1', 'q_essay_2'],
        params: { status: 'review' },
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('review_plan_create', {
      questionId: 'q_essay_1',
      examId: 'exam_essay',
    });
    expect(invokeMock).toHaveBeenCalledWith('review_plan_create', {
      questionId: 'q_essay_2',
      examId: 'exam_essay',
    });
    expect(refreshTodayLearningMock).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate drafts already present in the mistake exam and deduplicates concurrent saves (BUG-22)', async () => {
    const existingDrafts = buildEssayMistakeDrafts(GRADING);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'qbank_list_questions') {
        return {
          questions: [{ content: `  ${existingDrafts[0].content}  ` }],
          has_more: false,
        };
      }
      if (command === 'qbank_batch_create_questions') {
        return [{ id: 'q_essay_new' }];
      }
      return undefined;
    });

    const [first, second] = await Promise.all([
      saveEssayMistakes(GRADING),
      saveEssayMistakes(GRADING),
    ]);
    expect(first).toEqual({ count: 1, examId: 'exam_essay' });
    expect(second).toEqual({ count: 1, examId: 'exam_essay' });

    const createCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'qbank_batch_create_questions');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![1].paramsList).toHaveLength(1);
    expect(createCalls[0]![1].paramsList[0].content).toBe(existingDrafts[1].content);

    // When all drafts already exist, return { count: 0, examId } without creating anything
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'qbank_list_questions') {
        return {
          questions: existingDrafts.map((d) => ({ content: d.content })),
          has_more: false,
        };
      }
      return undefined;
    });

    await expect(saveEssayMistakes(GRADING)).resolves.toEqual({ count: 0, examId: 'exam_essay' });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'qbank_batch_create_questions')).toBe(false);
    expect(refreshTodayLearningMock).toHaveBeenCalledTimes(1);
  });
});
