import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, isEnabled, openDueNotesReview } = vi.hoisted(() => ({
  launch: vi.fn(),
  isEnabled: vi.fn(),
  openDueNotesReview: vi.fn(),
}));
vi.mock('@/features/workbench/core/workbenchBus', () => ({ workbenchBus: { launch, isEnabled } }));
vi.mock('../todayLearning', () => ({ openDueNotesReview }));

import { openTodayReviewTarget } from '../openTodayReview';
import { closeDueMistakesReview, isDueMistakesReviewOpen } from '../dueMistakesReview';

describe('openTodayReviewTarget', () => {
  const navigations: Array<{ view?: string }> = [];
  const onNavigate = (event: Event) => navigations.push((event as CustomEvent<{ view?: string }>).detail);

  beforeEach(() => {
    vi.clearAllMocks();
    navigations.length = 0;
    closeDueMistakesReview();
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigate);
  });
  afterEach(() => window.removeEventListener('NAVIGATE_TO_VIEW', onNavigate));

  it('opens the flashcards window on the study desktop, where classic view events go nowhere', () => {
    isEnabled.mockReturnValue(true);
    openTodayReviewTarget('cards');
    expect(launch).toHaveBeenCalledWith({ typeId: 'flashcards', reason: 'api' });
    expect(navigations).toEqual([]);
  });

  it('keeps the classic view navigation when the study desktop is off', () => {
    isEnabled.mockReturnValue(false);
    openTodayReviewTarget('cards');
    expect(launch).not.toHaveBeenCalled();
    expect(navigations).toEqual([{ view: 'flashcards' }]);
  });

  it('opens due notes in the files window on the study desktop', () => {
    isEnabled.mockReturnValue(true);
    openTodayReviewTarget('notes');
    const opener = openDueNotesReview.mock.calls[0][0] as () => void;
    opener();
    expect(launch).toHaveBeenCalledWith({ typeId: 'files', reason: 'api' });
  });

  it('lets the classic shell use its own learning-hub navigation for notes', () => {
    isEnabled.mockReturnValue(false);
    openTodayReviewTarget('notes');
    expect(openDueNotesReview).toHaveBeenCalledWith(undefined);
  });

  it('starts the cross-question-set mistakes review in both shells', () => {
    isEnabled.mockReturnValue(true);
    openTodayReviewTarget('mistakes');
    expect(isDueMistakesReviewOpen()).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
  });
});
