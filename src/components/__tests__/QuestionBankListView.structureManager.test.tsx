import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { QuestionBankListView } from '../QuestionBankListView';
import type { Question } from '@/api/questionBankApi';

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

function question(id: string): Question {
  return {
    id,
    questionLabel: id,
    content: `题目 ${id}`,
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
    groupId: null,
    groupPosition: null,
    groupLabel: null,
    materials: [],
  };
}

describe('QuestionBankListView structure management entry', () => {
  it('opens the structure manager in write mode and loads the exam structure', async () => {
    invokeMock.mockResolvedValue({ exam_id: 'exam_1', materials: [], groups: [] });

    render(
      <QuestionBankListView
        questions={[question('q1')]}
        examId="exam_1"
        onUpdateQuestion={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '题组与材料' }));

    expect(await screen.findByRole('dialog', { name: '题组与材料' })).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('qbank_list_structure', {
      examId: 'exam_1',
    }));
  });

  it('hides the management entry when the list is read-only', () => {
    render(<QuestionBankListView questions={[question('q1')]} examId="exam_1" />);

    expect(screen.queryByRole('button', { name: '题组与材料' })).not.toBeInTheDocument();
  });
});
