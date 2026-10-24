import { describe, expect, it } from 'vitest';
import { convertToApiQuestion, type StoreQuestion } from '@/hooks/useQuestionBankSession';
import { isSourceQuestionImage, type QuestionMaterial } from '@/api/questionBankApi';

const material: QuestionMaterial = {
  id: 'qmat_1',
  content: '阅读下面的文章，回答问题。',
  images: [{ id: 'file_fig1', name: 'fig1.png', mime: 'image/png', hash: 'a'.repeat(64) }],
  source_refs: [{ source_id: 'src_1', page: 2 }],
  version: 3,
};

function storeQuestion(overrides: Partial<StoreQuestion> = {}): StoreQuestion {
  return {
    id: 'q_abc',
    card_id: 'q_abc',
    question_label: '1',
    content: '子题一',
    question_type: 'short_answer',
    options: [],
    answer: '答案',
    explanation: '',
    difficulty: 'medium',
    tags: [],
    status: 'new',
    user_answer: '',
    is_correct: null,
    user_note: '',
    attempt_count: 0,
    correct_count: 0,
    last_attempt_at: null,
    is_favorite: false,
    images: [],
    structured_data: null,
    ...overrides,
  };
}

describe('questionBankApi group/material mapping', () => {
  it('maps snake_case group + materials into camelCase while keeping per-question material access', () => {
    const question = convertToApiQuestion(storeQuestion({
      group_id: 'qgroup_1',
      group_position: 2,
      group_label: '阅读理解一',
      materials: [material],
    }));

    expect(question.groupId).toBe('qgroup_1');
    expect(question.groupPosition).toBe(2);
    expect(question.groupLabel).toBe('阅读理解一');
    expect(question.materials).toEqual([material]);
  });

  it('keeps standalone questions working with null group and empty materials', () => {
    const question = convertToApiQuestion(storeQuestion());

    expect(question.groupId).toBeNull();
    expect(question.groupPosition).toBeNull();
    expect(question.groupLabel).toBeNull();
    expect(question.materials).toEqual([]);
  });
});

describe('question image roles', () => {
  it('prefers explicit role and only falls back to crop_ naming for legacy data', () => {
    expect(isSourceQuestionImage({ name: 'figure_1.png', role: 'question' })).toBe(false);
    expect(isSourceQuestionImage({ name: 'figure_1.png', role: 'option' })).toBe(false);
    expect(isSourceQuestionImage({ name: 'crop_1.png', role: 'source' })).toBe(true);
    expect(isSourceQuestionImage({ name: 'crop_1.png' })).toBe(false);
    expect(isSourceQuestionImage({ name: 'figure_1.png' })).toBe(true);
  });
});
