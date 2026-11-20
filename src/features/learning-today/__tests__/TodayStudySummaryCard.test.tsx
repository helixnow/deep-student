import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshot, openTodayReviewTarget, openDailySprint, todoState } = vi.hoisted(() => ({
  snapshot: { cards: 0, mistakes: 0, notes: 0, dueNotes: [] as unknown[] },
  openTodayReviewTarget: vi.fn(),
  openDailySprint: vi.fn(),
  todoState: { count: 0 },
}));

vi.mock('../todayLearningStore', () => ({
  getTodayLearningSnapshot: () => snapshot,
  subscribeTodayLearning: () => () => {},
  refreshTodayLearning: async () => {},
}));
vi.mock('../openTodayReview', () => ({ openTodayReviewTarget }));
vi.mock('../todayTodoCount', () => ({
  useTodayTodoCount: (externalCount?: number) => (typeof externalCount === 'number' ? externalCount : todoState.count),
}));
vi.mock('@/components/exam-sprint', () => ({
  openDailySprint,
  useSprintLauncherSnapshot: () => ({ readiness: null }),
}));

import { TodayStudySummaryCard } from '../TodayStudySummaryCard';

describe('TodayStudySummaryCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(snapshot, { cards: 0, mistakes: 0, notes: 0, dueNotes: [] });
    todoState.count = 0;
  });

  it('returns null when nothing is due', () => {
    const { container } = render(<TodayStudySummaryCard inTodayTodoView />);
    expect(container.firstChild).toBeNull();
  });

  it('aggregates due flashcards, mistake FSRS, review notes, and today todos with one-click navigation', () => {
    Object.assign(snapshot, { cards: 5, mistakes: 3, notes: 2 });
    const onOpenTodos = vi.fn();

    render(<TodayStudySummaryCard inTodayTodoView todoDueCount={4} onOpenTodos={onOpenTodos} />);

    const card = screen.getByTestId('today-study-summary-card');
    expect(card.textContent).toContain('14');
    expect(screen.getByTestId('today-summary-cards')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('today-summary-mistakes')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('today-summary-notes')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('today-summary-todos')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByTestId('today-summary-cards'));
    fireEvent.click(screen.getByTestId('today-summary-mistakes'));
    fireEvent.click(screen.getByTestId('today-summary-notes'));
    expect(openTodayReviewTarget.mock.calls).toEqual([['cards'], ['mistakes'], ['notes']]);

    fireEvent.click(screen.getByTestId('today-summary-todos'));
    expect(onOpenTodos).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('today-summary-sprint'));
    expect(openDailySprint).toHaveBeenCalledWith({ source: 'todo-today' });
  });

  it('falls back to openTodayReviewTarget("todos") when onOpenTodos is not provided', () => {
    Object.assign(snapshot, { cards: 1, mistakes: 0, notes: 0 });
    todoState.count = 2;

    render(<TodayStudySummaryCard />);
    fireEvent.click(screen.getByTestId('today-summary-todos'));
    expect(openTodayReviewTarget).toHaveBeenCalledWith('todos');
  });
});
