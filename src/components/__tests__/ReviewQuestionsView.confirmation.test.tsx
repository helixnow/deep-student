import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateCardsFromText = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/anki/generateCardsFromText', () => ({
  generateCardsFromText: mockGenerateCardsFromText,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (
      typeof fallback === 'string' ? fallback : key
    ),
  }),
  Trans: () => null,
  // ReviewQuestionsView 的传递依赖图会加载 i18n 初始化模块（其 import 需要该导出）
  initReactI18next: { type: '3rdParty', init: () => {} },
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

describe('ReviewQuestionsView destructive actions (inline confirmation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for inline confirmation before deleting selected review questions', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);

    render(<ReviewQuestionsView questions={[reviewQuestion]} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('checkbox'));

    // 第一次点击仅进入待确认态（按钮文案切换为确认文案），不执行删除
    fireEvent.click(screen.getByRole('button', { name: 'review:questions.delete' }));
    expect(onDelete).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: 'review:questions.confirmDelete' });
    expect(confirmButton).toBeInTheDocument();

    // 第二次点击真正执行
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(['question-1']));
  });

  it('waits for inline confirmation before resetting selected review questions', async () => {
    const onResetProgress = vi.fn().mockResolvedValue(undefined);

    render(<ReviewQuestionsView questions={[reviewQuestion]} onResetProgress={onResetProgress} />);

    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: 'review:questions.reset' }));
    expect(onResetProgress).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: 'review:questions.confirmReset' });
    expect(confirmButton).toBeInTheDocument();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(onResetProgress).toHaveBeenCalledWith(['question-1']));
  });

  it('disarms the pending confirmation when selection changes', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);

    render(<ReviewQuestionsView questions={[reviewQuestion]} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'review:questions.delete' }));
    expect(screen.getByRole('button', { name: 'review:questions.confirmDelete' })).toBeInTheDocument();

    // 变更选择集：待确认态应回退，避免确认数量与实际不一致
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByRole('button', { name: 'review:questions.confirmDelete' })).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('routes selected mistakes through the shared CardAgent generation entry', async () => {
    render(<ReviewQuestionsView questions={[reviewQuestion]} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'review:questions.generateCards' }));

    await waitFor(() => expect(mockGenerateCardsFromText).toHaveBeenCalledTimes(1));
    expect(mockGenerateCardsFromText).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Question content'),
      deckName: 'review:questions.cardSource.deckName',
      maxCards: 5,
    }));
  });
});
