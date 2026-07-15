import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === 'practice:tagPicker.untagged') return '未分类';
      if (key === 'practice:tagPicker.questionCount') return `${options?.count ?? 0}`;
      return key;
    },
  }),
}));

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    timedSession: null,
    mockExamSession: null,
    mockExamScoreCard: null,
  }),
}));

import { PracticeLauncher } from '../PracticeLauncher';

describe('PracticeLauncher', () => {
  it('requires an explicit tag selection before starting by-tag practice', () => {
    const onStartPractice = vi.fn();

    render(
      <PracticeLauncher
        examId="exam-1"
        questions={[
          { tags: ['Algebra'] },
          { tags: ['Geometry'] },
          { tags: [] },
        ]}
        onStartPractice={onStartPractice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /practice:modes.byTag.label/ }));

    expect(onStartPractice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Algebra/ }));
    expect(onStartPractice).toHaveBeenCalledWith('by_tag', 'Algebra');
  });

  it('offers untagged questions as a valid by-tag scope', () => {
    const onStartPractice = vi.fn();

    render(
      <PracticeLauncher
        examId="exam-1"
        questions={[{ tags: [] }]}
        onStartPractice={onStartPractice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /practice:modes.byTag.label/ }));
    fireEvent.click(screen.getByRole('button', { name: /未分类/ }));

    expect(onStartPractice).toHaveBeenCalledWith('by_tag', '__untagged__');
  });
});
