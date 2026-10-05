import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, isEnabled, activateDetailed, openDueNotesReview, flashcards } = vi.hoisted(() => ({
  launch: vi.fn(),
  isEnabled: vi.fn(),
  activateDetailed: vi.fn(async () => ({ delivered: true, result: { handled: true } })),
  openDueNotesReview: vi.fn(),
  flashcards: { screen: 'library', setScreen: vi.fn() },
}));
vi.mock('@/features/workbench/core/workbenchBus', () => ({ workbenchBus: { launch, isEnabled, activateDetailed } }));
vi.mock('../todayLearning', () => ({ openDueNotesReview }));
vi.mock('@/features/flashcards/store/fsrsReviewStore', () => ({
  useFsrsReviewStore: { getState: () => flashcards },
}));

import { openTodayReviewTarget } from '../openTodayReview';
import { closeDueMistakesReview, isDueMistakesReviewOpen } from '../dueMistakesReview';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('openTodayReviewTarget', () => {
  const navigations: Array<{ view?: string }> = [];
  const onNavigate = (event: Event) => navigations.push((event as CustomEvent<{ view?: string }>).detail);

  beforeEach(() => {
    vi.clearAllMocks();
    navigations.length = 0;
    flashcards.screen = 'library';
    closeDueMistakesReview();
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigate);
  });
  afterEach(() => window.removeEventListener('NAVIGATE_TO_VIEW', onNavigate));

  it('opens the flashcards Today screen on the study desktop, where classic view events go nowhere', async () => {
    isEnabled.mockReturnValue(true);
    openTodayReviewTarget('cards');
    await flush();
    expect(activateDetailed).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'flashcards',
      action: 'showScreen',
      payload: { screen: 'today' },
      fallbackLaunch: expect.objectContaining({ typeId: 'flashcards', payload: { screen: 'today' } }),
    }));
    expect(navigations).toEqual([]);
  });

  it('does not interrupt a running flashcards session, only brings the window forward', async () => {
    isEnabled.mockReturnValue(true);
    flashcards.screen = 'session';
    openTodayReviewTarget('cards');
    await flush();
    expect(launch).toHaveBeenCalledWith({ typeId: 'flashcards', reason: 'api' });
    expect(activateDetailed).not.toHaveBeenCalled();
  });

  it('keeps the classic view navigation and lands on Today when the study desktop is off', async () => {
    isEnabled.mockReturnValue(false);
    openTodayReviewTarget('cards');
    await flush();
    expect(flashcards.setScreen).toHaveBeenCalledWith('today');
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
