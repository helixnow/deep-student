import { beforeEach, describe, expect, it, vi } from 'vitest';

const { activateDetailed, launch, openTodayReviewTarget, snapshot } = vi.hoisted(() => ({
  activateDetailed: vi.fn(async () => ({ delivered: true, result: { handled: true } })),
  launch: vi.fn(),
  openTodayReviewTarget: vi.fn(),
  snapshot: { cards: 0, mistakes: 0, notes: 0, dueNotes: [] as unknown[] },
}));

vi.mock('@/features/workbench', () => ({ workbenchBus: { activateDetailed, launch } }));
vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget }));
vi.mock('@/features/learning-today/todayLearningStore', () => ({ getTodayLearningSnapshot: () => snapshot }));

import { createWorkbenchLearningHandlers } from '../workbenchLearningHandlers';

describe('workbench learning handlers — today review routing', () => {
  const handlers = createWorkbenchLearningHandlers();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(snapshot, { cards: 0, mistakes: 0, notes: 0 });
  });

  it('starts the flashcards session when cards are due', async () => {
    Object.assign(snapshot, { cards: 3, mistakes: 2 });
    await handlers['start-review'].handler({} as never);
    expect(activateDetailed).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'flashcards', action: 'startReview' }));
    expect(openTodayReviewTarget).not.toHaveBeenCalled();
  });

  it('goes to the mistakes review instead of an empty flashcards queue', async () => {
    Object.assign(snapshot, { mistakes: 2, notes: 1 });
    await handlers['start-review'].handler({} as never);
    expect(openTodayReviewTarget).toHaveBeenCalledWith('mistakes');
    expect(activateDetailed).not.toHaveBeenCalled();
  });

  it('falls through to notes when only notes are due', async () => {
    Object.assign(snapshot, { notes: 1 });
    await handlers['start-review'].handler({} as never);
    expect(openTodayReviewTarget).toHaveBeenCalledWith('notes');
  });

  it('routes the dedicated review actions and opens a real app for the plan export', async () => {
    await handlers['review-mistakes'].handler({} as never);
    await handlers['review-notes'].handler({} as never);
    expect(openTodayReviewTarget.mock.calls).toEqual([['mistakes'], ['notes']]);
    await handlers['export-plan'].handler({} as never);
    expect(launch).toHaveBeenCalledWith({ typeId: 'files', reason: 'api' });
  });
});
