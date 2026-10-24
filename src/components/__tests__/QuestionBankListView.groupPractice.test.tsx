import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question, QuestionMaterial } from '@/api/questionBankApi';
import { QuestionBankListView } from '../QuestionBankListView';

afterEach(() => cleanup());

const material: QuestionMaterial = {
  id: 'qmat_1',
  content: '共享文章：并行训练把大批次拆到多卡。',
  images: [],
  source_refs: [{ source_id: 'src_1', page: 1 }],
  version: 1,
};

function question(id: string, groupPosition: number): Question {
  return {
    id,
    questionLabel: String(groupPosition + 1),
    content: `子题 ${groupPosition + 1}`,
    questionType: 'short_answer',
    options: [],
    answer: '答案',
    explanation: '',
    difficulty: 'easy',
    tags: [],
    status: 'new',
    attemptCount: 0,
    correctCount: 0,
    isFavorite: false,
    images: [],
    groupId: 'qgroup_1',
    groupPosition,
    groupLabel: '阅读理解一',
    materials: [material],
  };
}

describe('QuestionBankListView group materials', () => {
  it('renders shared material once per contiguous group and starts group practice with stable ids', () => {
    const onStartGroupPractice = vi.fn();
    const questions = [question('q_1', 0), question('q_2', 1)];

    render(
      <QuestionBankListView
        questions={questions}
        onStartGroupPractice={onStartGroupPractice}
      />,
    );

    expect(screen.getAllByText(/共享文章：并行训练/)).toHaveLength(1);
    expect(screen.getByText('阅读理解一')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /练习本组/ }));
    expect(onStartGroupPractice).toHaveBeenCalledWith(['q_1', 'q_2']);
  });
});
