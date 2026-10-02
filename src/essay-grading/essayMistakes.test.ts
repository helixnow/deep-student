import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const ensureMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@/utils/ensureNamedExam', () => ({ ensureNamedExam: (...args: unknown[]) => ensureMock(...args) }));
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
  });

  it('turns replace and err markers into correction questions, de-duplicated', () => {
    const drafts = buildEssayMistakeDrafts(GRADING);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ answer: '非常高兴', explanation: '程度副词重复' });
    expect(drafts[0].content).toContain('非常很高兴');
    expect(drafts[1].content).toContain('我的理想被实现了');
    expect(drafts[1].explanation).toBe('主谓搭配不当');
    // 错误类型排在首位，掌握度按它归类
    expect(drafts[1].tags[0]).toBe('grammar');
  });

  it('writes drafts into the essay mistake set and skips when nothing to save', async () => {
    await expect(saveEssayMistakes('<good>好</good>')).resolves.toEqual({ count: 0, examId: null });
    expect(invokeMock).not.toHaveBeenCalled();

    await expect(saveEssayMistakes(GRADING)).resolves.toEqual({ count: 2, examId: 'exam_essay' });
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe('qbank_batch_create_questions');
    expect(payload.paramsList).toHaveLength(2);
    expect(payload.paramsList[0]).toMatchObject({ exam_id: 'exam_essay', answer: '非常高兴', source_type: 'manual' });
  });
});
