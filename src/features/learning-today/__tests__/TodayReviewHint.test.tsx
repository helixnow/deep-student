import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshot, openTodayReviewTarget, openResourceLibrary, weakState } = vi.hoisted(() => ({
  snapshot: { cards: 0, mistakes: 0, notes: 0, dueNotes: [] as unknown[] } as {
    cards: number; mistakes: number; notes: number; dueNotes: unknown[]; cardsTotal?: number; plansTotal?: number;
  },
  openTodayReviewTarget: vi.fn(),
  openResourceLibrary: vi.fn(),
  weakState: { value: [] as Array<{ conceptKey: string; score: number; total: number; wrongCount: number }> | null },
}));
vi.mock('../todayLearningStore', () => ({
  getTodayLearningSnapshot: () => snapshot,
  subscribeTodayLearning: () => () => {},
  refreshTodayLearning: async () => {},
}));
vi.mock('../openTodayReview', () => ({ openTodayReviewTarget, openResourceLibrary }));
vi.mock('@/components/dashboard/WeakConceptsStrip', () => ({
  useWeakConcepts: () => weakState.value,
  WeakConceptsStrip: ({ concepts }: { concepts?: Array<{ conceptKey: string }> | null }) =>
    concepts && concepts.length > 0 ? <div data-testid="weak-strip">{concepts.map((c) => c.conceptKey).join(',')}</div> : null,
}));
vi.mock('@/components/dashboard/WeeklyReportActions', () => ({
  WeeklyReportActions: ({ compact }: { compact?: boolean }) => <span data-testid="weekly-report" data-compact={String(compact)} />,
}));

import { TodayReviewHint } from '../TodayReviewHint';

describe('TodayReviewHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(snapshot, { cards: 0, mistakes: 0, notes: 0, cardsTotal: undefined, plansTotal: undefined });
    weakState.value = [];
    localStorage.removeItem('learningToday.starterDismissed');
  });

  it('walks a brand-new learner through the loop, and can be dismissed for good', () => {
    Object.assign(snapshot, { cardsTotal: 0, plansTotal: 0 });
    const view = render(<TodayReviewHint />);
    expect(screen.getByTestId('today-starter').textContent).toContain('导入资料');
    fireEvent.click(screen.getByRole('button', { name: /打开资源库/ }));
    expect(openResourceLibrary).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    expect(screen.queryByTestId('today-starter')).toBeNull();
    view.unmount();
    render(<TodayReviewHint />);
    expect(screen.queryByTestId('today-starter')).toBeNull();
  });

  it('does not show the starter when the totals could not be read or the learner already has cards', () => {
    const view = render(<TodayReviewHint />);
    expect(screen.queryByTestId('today-starter')).toBeNull();
    view.unmount();
    Object.assign(snapshot, { cardsTotal: 12, plansTotal: 0 });
    render(<TodayReviewHint />);
    expect(screen.queryByTestId('today-starter')).toBeNull();
  });

  it('renders nothing for a learner with nothing due and no answer history', () => {
    const { container } = render(<TodayReviewHint />);
    expect(container.firstChild).toBeNull();
  });

  it('sends each due line to its own review instead of a generic page', () => {
    Object.assign(snapshot, { cards: 2, mistakes: 3, notes: 1 });
    render(<TodayReviewHint />);
    fireEvent.click(screen.getByText('错题复习'));
    fireEvent.click(screen.getByText('到期卡片'));
    fireEvent.click(screen.getByText('待复习笔记'));
    expect(openTodayReviewTarget.mock.calls).toEqual([['mistakes'], ['cards'], ['notes']]);
  });

  it('surfaces weak spots and the weekly report on the chat home even on a day with nothing due', () => {
    weakState.value = [{ conceptKey: '导数', score: 0.3, total: 5, wrongCount: 3 }];
    render(<TodayReviewHint />);
    expect(screen.getByTestId('weak-strip').textContent).toBe('导数');
    expect(screen.getByTestId('weekly-report').dataset.compact).toBe('true');
    expect(screen.queryByText('今日待复习')).toBeNull();
  });
});
