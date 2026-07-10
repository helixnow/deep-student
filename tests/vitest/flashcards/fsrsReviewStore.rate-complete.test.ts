import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/utils/chatApi', () => ({
  listAnkiLibraryCards: vi.fn(),
}));

vi.mock('@/features/workbench/apps/system/flashcardsDueSource', () => ({
  refreshFlashcardsDueCount: vi.fn(() => Promise.resolve()),
}));

import { invoke } from '@tauri-apps/api/core';
import { refreshFlashcardsDueCount } from '@/features/workbench/apps/system/flashcardsDueSource';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

const invokeMock = vi.mocked(invoke);
const refreshDueMock = vi.mocked(refreshFlashcardsDueCount);

describe('fsrsReviewStore rate completion', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    refreshDueMock.mockClear();
    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: [],
      queue: [],
      queueIndex: 0,
      flipped: false,
      loading: false,
      ratingBusy: false,
      usingMock: false,
      error: null,
      lastRated: null,
    });
  });

  it('keeps session screen when last card is rated so done UI can show', async () => {
    invokeMock.mockResolvedValueOnce({});
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 1,
      flipped: true,
      usingMock: false,
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('session');
    expect(state.queueIndex).toBe(2);
    expect(state.queue[state.queueIndex]).toBeUndefined();
    expect(state.ratingBusy).toBe(false);
    expect(state.flipped).toBe(false);
    expect(refreshDueMock).toHaveBeenCalled();
  });

  it('advances to next card without leaving session mid-queue', async () => {
    invokeMock.mockResolvedValueOnce({});
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      usingMock: false,
    });

    await useFsrsReviewStore.getState().rate(4);

    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('session');
    expect(state.queueIndex).toBe(1);
    expect(state.queue[state.queueIndex]?.id).toBe('b');
  });

  it('invokes fsrs_rate with cardStateId (not cardId)', async () => {
    invokeMock.mockResolvedValueOnce({});
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [{ id: 'state-uuid-1', ankiCardId: 'anki-1', front: 'Q', back: 'A' }],
      queueIndex: 0,
      flipped: true,
      usingMock: false,
    });

    await useFsrsReviewStore.getState().rate(3);

    expect(invokeMock).toHaveBeenCalledWith('fsrs_rate', {
      cardStateId: 'state-uuid-1',
      rating: 3,
    });
    expect(useFsrsReviewStore.getState().usingMock).toBe(false);
  });

  it('does not advance on rate failure; sets error and clears busy', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rate failed'));
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'a', front: 'A', back: 'a' },
        { id: 'b', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      usingMock: false,
      error: null,
    });

    await useFsrsReviewStore.getState().rate(2);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(0);
    expect(state.ratingBusy).toBe(false);
    expect(state.error).toBe('rate failed');
    expect(state.usingMock).toBe(false);
    expect(refreshDueMock).not.toHaveBeenCalled();
  });

  it('advances locally when usingMock without requiring invoke success', async () => {
    invokeMock.mockRejectedValue(new Error('offline'));
    useFsrsReviewStore.setState({
      screen: 'session',
      queue: [
        { id: 'mock-1', front: 'A', back: 'a' },
        { id: 'mock-2', front: 'B', back: 'b' },
      ],
      queueIndex: 0,
      flipped: true,
      usingMock: true,
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.error).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(refreshDueMock).toHaveBeenCalled();
  });

  it('treats empty due array as success, not mock fallback', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await useFsrsReviewStore.getState().loadDue();
    const state = useFsrsReviewStore.getState();
    expect(state.dueCards).toEqual([]);
    expect(state.usingMock).toBe(false);
    expect(state.loading).toBe(false);

    useFsrsReviewStore.getState().startDueSession();
    const session = useFsrsReviewStore.getState();
    expect(session.queue).toEqual([]);
    expect(session.usingMock).toBe(false);
    expect(session.screen).toBe('session');
  });

  it('applyLaunchPayload due session loads then starts', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
    ]);
    useFsrsReviewStore.getState().applyLaunchPayload({
      screen: 'session',
      mode: 'due',
    });

    // loadDue + startDueSession are async
    await vi.waitFor(() => {
      const s = useFsrsReviewStore.getState();
      expect(s.screen).toBe('session');
      expect(s.queue.length).toBe(1);
      expect(s.queue[0]?.id).toBe('state-1');
      expect(s.usingMock).toBe(false);
    });
  });

  it('endSession refreshes due badge count', () => {
    useFsrsReviewStore.setState({ screen: 'session' });
    useFsrsReviewStore.getState().endSession();
    expect(useFsrsReviewStore.getState().screen).toBe('today');
    expect(refreshDueMock).toHaveBeenCalled();
  });
});
