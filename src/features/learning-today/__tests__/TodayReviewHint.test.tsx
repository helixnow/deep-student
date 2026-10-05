import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshot, openTodayReviewTarget } = vi.hoisted(() => ({
  snapshot: { cards: 0, mistakes: 0, notes: 0, dueNotes: [] as unknown[] },
  openTodayReviewTarget: vi.fn(),
}));
vi.mock('../todayLearningStore', () => ({
  getTodayLearningSnapshot: () => snapshot,
  subscribeTodayLearning: () => () => {},
  refreshTodayLearning: async () => {},
}));
vi.mock('../openTodayReview', () => ({ openTodayReviewTarget }));

import { TodayReviewHint } from '../TodayReviewHint';

describe('TodayReviewHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(snapshot, { cards: 0, mistakes: 0, notes: 0 });
  });

  it('renders nothing when no review line is due', () => {
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
});
