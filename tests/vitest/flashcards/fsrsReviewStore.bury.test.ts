import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/features/flashcards/events', () => ({
  requestFlashcardsDueRefresh: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

const invokeMock = vi.mocked(invoke);

const cards = [
  { id: 'state-a', ankiCardId: 'anki-a', front: 'A', back: 'a' },
  { id: 'state-b', ankiCardId: 'anki-b', front: 'B', back: 'b' },
  { id: 'state-c', ankiCardId: 'anki-c', front: 'C', back: 'c' },
];

function stateRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, anki_card_id: `anki-${id.slice(-1)}`, state: 2, last_review_ms: 1, ...extra };
}

describe('fsrsReviewStore burying', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    invokeMock.mockReset();
    useFsrsReviewStore.setState({
      screen: 'session',
      sessionMode: 'batch',
      queue: cards.map((card) => ({ ...card })),
      queueIndex: 0,
      flipped: true,
      flippedAtMs: null,
      loading: false,
      ratingBusy: false,
      error: null,
      errorKind: null,
      lastReview: null,
      reviewHistory: [],
      lastSuspended: null,
      pendingRateOp: null,
      pendingExternalRateIds: [],
      sessionRatedCount: 0,
      sessionAgainCount: 0,
    });
  });

  it('hides siblings that the backend buried while rating', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_rate') {
        return {
          logId: 'log-a',
          dueMs: Date.now() + 5 * 86_400_000,
          scheduledDays: 5,
          cardState: stateRow('state-a', { last_review_ms: Date.now() }),
          buriedSiblings: ['state-b'],
        };
      }
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    await useFsrsReviewStore.getState().rate(3);

    const state = useFsrsReviewStore.getState();
    expect(state.queue.find((card) => card.id === 'state-b')?.buried).toBe(true);
    expect(state.queue[state.queueIndex]?.id).toBe('state-c');
  });

  it('buries the current card and unburies it through the resume action', async () => {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      const cardStateId = (args as { cardStateId?: string } | undefined)?.cardStateId;
      if (command === 'fsrs_bury_card' || command === 'fsrs_unbury_card') {
        return { state: stateRow(cardStateId ?? ''), changed: true };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    await expect(useFsrsReviewStore.getState().buryCurrent()).resolves.toBe(true);
    let state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('fsrs_bury_card', { cardStateId: 'state-a' });
    expect(state.queue[0]?.buried).toBe(true);
    expect(state.queue[state.queueIndex]?.id).toBe('state-b');
    expect(state.lastSuspended).toMatchObject({ cardStateId: 'state-a', reason: 'bury' });

    await expect(useFsrsReviewStore.getState().resumeLastSuspended()).resolves.toBe(true);
    state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenLastCalledWith('fsrs_unbury_card', { cardStateId: 'state-a' });
    expect(state.queue[0]?.buried).toBe(false);
    expect(state.queue[state.queueIndex]?.id).toBe('state-a');
    expect(state.lastSuspended).toBeNull();
  });
});
