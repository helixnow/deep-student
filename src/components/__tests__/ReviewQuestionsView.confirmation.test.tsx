import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/components/ui/NotionDialog', () => ({
  NotionAlertDialog: ({
    open,
    title,
    confirmText,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    onConfirm: () => void;
  }) => open ? (
    <div role="alertdialog">
      <p>{title}</p>
      <button type="button" onClick={onConfirm}>{confirmText}</button>
    </div>
  ) : null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (
      typeof fallback === 'string' ? fallback : key
    ),
  }),
  Trans: () => null,
}));

import { ReviewQuestionsView } from '../ReviewQuestionsView';

const reviewQuestion = {
  id: 'question-1',
  questionLabel: 'Q1',
  content: 'Question content',
  questionType: 'single_choice' as const,
  tags: [],
  status: 'review' as const,
};

describe('ReviewQuestionsView destructive actions', () => {
  it('waits for confirmation before deleting selected review questions', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);

    render(<ReviewQuestionsView questions={[reviewQuestion]} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'review:questions.delete' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common:delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(['question-1']));
  });

  it('waits for confirmation before resetting selected review questions', async () => {
    const onResetProgress = vi.fn().mockResolvedValue(undefined);

    render(<ReviewQuestionsView questions={[reviewQuestion]} onResetProgress={onResetProgress} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'review:questions.reset' }));

    expect(onResetProgress).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'practice:questionBank.resetProgress' }));
    await waitFor(() => expect(onResetProgress).toHaveBeenCalledWith(['question-1']));
  });
});
