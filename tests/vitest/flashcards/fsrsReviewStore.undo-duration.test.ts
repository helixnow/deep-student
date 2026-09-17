/**
 * 2026-08 修复回归：
 * - F2 作答用时上报：flip 记录翻面时刻，评分随 fsrs_rate 上报 durationMs
 *   （看到答案 → 给出评分），超过上限按 MAX_ANSWER_DURATION_MS 截断。
 * - F3 多级撤销：评分回执入 reviewHistory 栈，undo 逐级弹栈还原
 *   （此前 lastReview 单槽只能撤销最近一次）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/features/flashcards/events', () => ({ requestFlashcardsDueRefresh: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import {
  MAX_ANSWER_DURATION_MS,
  useFsrsReviewStore,
} from '@/features/flashcards/store/fsrsReviewStore';

const invokeMock = vi.mocked(invoke);

const T0 = 1_756_000_000_000;
let nowMs = T0;

function farFutureRate(logId: string) {
  return {
    logId,
    dueMs: nowMs + 3 * 86_400_000,
    scheduledDays: 3,
    cardState: { state: 2, lastReviewMs: nowMs },
  };
}

function seedSession() {
  useFsrsReviewStore.setState({
    screen: 'session',
    sessionMode: 'due',
    queue: [
      { id: 'state-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
      { id: 'state-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' },
    ],
    queueIndex: 0,
    flipped: false,
    flippedAtMs: null,
    ratingBusy: false,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    reviewHistory: [],
    lastSuspended: null,
    sessionRatedCount: 0,
    sessionAgainCount: 0,
    sessionRatingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    sessionStreak: 0,
    sessionBestStreak: 0,
    dueTotal: 2,
    remainingDueAfterSession: null,
    ratingPreviews: null,
    lastSchedule: null,
    recentLocalLogIds: [],
    pendingExternalRateIds: [],
  });
}

describe('fsrsReviewStore answer duration + multi-level undo', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('en-US', 'flashcards')).toBe(true);
    });
    invokeMock.mockReset();
    nowMs = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    seedSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports presentation duration including time before the flip', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') return farFutureRate('log-duration');
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    nowMs = T0 + 40_000;
    useFsrsReviewStore.getState().flip();
    expect(useFsrsReviewStore.getState().flippedAtMs).toBe(T0 + 40_000);

    nowMs = T0 + 42_000;
    await useFsrsReviewStore.getState().rate(3, nowMs - T0);

    const rateCall = invokeMock.mock.calls.find(([command]) => command === 'fsrs_rate');
    expect(rateCall?.[1]).toMatchObject({ cardStateId: 'state-1', durationMs: 42_000 });
    // 评分后翻面时刻清空，等待下一张卡重新计时
    expect(useFsrsReviewStore.getState().flippedAtMs).toBeNull();
  });

  it('caps runaway durations and omits them without a presentation measurement', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') return farFutureRate(`log-${nowMs}`);
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    // 挂机 30 分钟后评分：按上限截断，不污染用时统计
    useFsrsReviewStore.getState().flip();
    nowMs = T0 + 30 * 60_000;
    await useFsrsReviewStore.getState().rate(3, nowMs - T0);
    let rateCall = invokeMock.mock.calls.filter(([command]) => command === 'fsrs_rate').at(-1);
    expect(rateCall?.[1]).toMatchObject({ durationMs: MAX_ANSWER_DURATION_MS });

    // 无卡面测量时诚实上报 null
    invokeMock.mockClear();
    useFsrsReviewStore.setState({ flipped: true, flippedAtMs: null });
    await useFsrsReviewStore.getState().rate(3);
    rateCall = invokeMock.mock.calls.filter(([command]) => command === 'fsrs_rate').at(-1);
    expect(rateCall?.[1]).toMatchObject({ durationMs: null });
  });

  it('supports undoing multiple ratings in reverse order (review history stack)', async () => {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') {
        const { cardStateId } = args as { cardStateId: string };
        return farFutureRate(`log-${cardStateId}`);
      }
      if (command === 'fsrs_get_stats') return { due: 0 };
      if (command === 'fsrs_undo_last_review') {
        const { expectedLogId, cardStateId } = args as {
          expectedLogId: string;
          cardStateId: string;
        };
        return {
          changed: true,
          undoneLogId: expectedLogId,
          state: { id: cardStateId, lastReviewMs: null },
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(4);

    let state = useFsrsReviewStore.getState();
    expect(state.reviewHistory.map((receipt) => receipt.logId))
      .toEqual(['log-state-1', 'log-state-2']);
    expect(state.lastReview?.logId).toBe('log-state-2');
    expect(state.sessionRatedCount).toBe(2);
    expect(state.queueIndex).toBe(2);

    // 第一次撤销：回到第二张卡，栈顶回退到第一次评分（此前单槽在此变 null）
    await expect(useFsrsReviewStore.getState().undoLastReview()).resolves.toBe(true);
    state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('fsrs_undo_last_review', {
      expectedLogId: 'log-state-2',
      cardStateId: 'state-2',
    });
    expect(state.queueIndex).toBe(1);
    expect(state.lastReview?.logId).toBe('log-state-1');
    expect(state.sessionRatedCount).toBe(1);
    expect(state.sessionRatingCounts[4]).toBe(0);

    // 第二次撤销：继续弹栈回到第一张卡
    await expect(useFsrsReviewStore.getState().undoLastReview()).resolves.toBe(true);
    state = useFsrsReviewStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('fsrs_undo_last_review', {
      expectedLogId: 'log-state-1',
      cardStateId: 'state-1',
    });
    expect(state.queueIndex).toBe(0);
    expect(state.lastReview).toBeNull();
    expect(state.reviewHistory).toEqual([]);
    expect(state.sessionRatedCount).toBe(0);
    expect(state.sessionRatingCounts[3]).toBe(0);
  });

  it('drops stale receipts from the stack when another window rates the same card', async () => {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') {
        const { cardStateId } = args as { cardStateId: string };
        return farFutureRate(`log-${cardStateId}`);
      }
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);

    // 他端对 state-1 再评分：其本窗回执过期，从栈中剔除；state-2 回执保留
    useFsrsReviewStore.getState().reconcileExternalRate(['state-1']);

    const state = useFsrsReviewStore.getState();
    expect(state.reviewHistory.map((receipt) => receipt.cardStateId)).toEqual(['state-2']);
    expect(state.lastReview?.cardStateId).toBe('state-2');
    // 剩余回执的队列快照也不能再包含被他端评掉的卡，防止 undo 复活
    expect(
      state.reviewHistory.every((receipt) =>
        (receipt.queueSnapshot ?? []).every((card) => card.id !== 'state-1'),
      ),
    ).toBe(true);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  function mockRatingsAndUndo() {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_get_stats') return { due: 0 };
      const payload = args as { cardStateId: string; expectedLogId: string };
      if (command === 'fsrs_rate') return farFutureRate(`log-${payload.cardStateId}`);
      if (command === 'fsrs_undo_last_review') return {
        changed: true, undoneLogId: payload.expectedLogId,
        state: { id: payload.cardStateId, lastReviewMs: null },
      };
      throw new Error(`unexpected invoke: ${command}`);
    });
  }

  it('preserves new cards, edited content and peer removals when restoring queue order', async () => {
    mockRatingsAndUndo();
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().reconcileAgentCardContent([
      { id: 'state-1', ankiCardId: 'anki-1', front: 'Edited Q1', back: 'Edited A1' },
    ]);
    useFsrsReviewStore.getState().appendToQueue([
      { id: 'state-3', ankiCardId: 'anki-3', front: 'Q3', back: 'A3' },
    ]);
    useFsrsReviewStore.getState().reconcileExternalRate(['state-2']);
    await expect(useFsrsReviewStore.getState().undoLastReview()).resolves.toBe(true);
    const state = useFsrsReviewStore.getState();
    expect(state.queue.map((card) => card.id)).toEqual(['state-1', 'state-3']);
    expect(state.queue[0]).toMatchObject({ front: 'Edited Q1', back: 'Edited A1', lastReviewMs: null });
    expect(state.queueIndex).toBe(0);
  });

  it('restores current and best streaks across successive undos', async () => {
    mockRatingsAndUndo();
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(4);
    expect(useFsrsReviewStore.getState().sessionBestStreak).toBe(2);
    await useFsrsReviewStore.getState().undoLastReview();
    expect(useFsrsReviewStore.getState()).toMatchObject({ sessionStreak: 1, sessionBestStreak: 1 });
    await useFsrsReviewStore.getState().undoLastReview();
    expect(useFsrsReviewStore.getState()).toMatchObject({ sessionStreak: 0, sessionBestStreak: 0 });
  });

  it('distinguishes a peer rating of the last local card from a local echo', async () => {
    mockRatingsAndUndo();
    useFsrsReviewStore.getState().flip();
    await useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().reconcileExternalRate(['state-1'], {
      cardLogPairs: [{ cardStateId: 'state-1', logId: 'peer-log' }],
    });
    expect(useFsrsReviewStore.getState().queue.map((card) => card.id)).toEqual(['state-2']);
    expect(useFsrsReviewStore.getState().lastReview).toBeNull();
  });

  it.each(['success', 'failure'])('ignores an old rating %s without unlocking the next session', async (outcome) => {
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    let ratingCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_get_stats') return { due: 0 };
      if (command === 'fsrs_rate') return ++ratingCalls === 1 ? oldRequest.promise : newRequest.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });
    useFsrsReviewStore.getState().flip();
    const oldRating = useFsrsReviewStore.getState().rate(3);
    useFsrsReviewStore.getState().endSession();
    useFsrsReviewStore.setState({
      dueCards: [{ id: 'next', ankiCardId: 'anki-next', front: 'Next Q', back: 'Next A' }],
    });
    useFsrsReviewStore.getState().startDueSession();
    useFsrsReviewStore.getState().flip();
    const newRating = useFsrsReviewStore.getState().rate(4);
    if (outcome === 'success') oldRequest.resolve(farFutureRate('old-log'));
    else oldRequest.reject(new Error('old failure'));
    await oldRating;
    expect(useFsrsReviewStore.getState()).toMatchObject({
      ratingBusy: true, queueIndex: 0, sessionRatedCount: 0, error: null,
    });
    expect(useFsrsReviewStore.getState().queue.map((card) => card.id)).toEqual(['next']);
    newRequest.resolve(farFutureRate('new-log'));
    await newRating;
    expect(useFsrsReviewStore.getState()).toMatchObject({ ratingBusy: false, sessionRatedCount: 1 });
    expect(useFsrsReviewStore.getState().lastReview?.logId).toBe('new-log');
  });

  it('keeps the newest due load when requests finish out of order', async () => {
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    let dueCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_get_stats') return { due: 1 };
      if (command === 'fsrs_get_due') return ++dueCalls === 1 ? oldRequest.promise : newRequest.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });
    const oldLoad = useFsrsReviewStore.getState().loadDue();
    const newLoad = useFsrsReviewStore.getState().loadDue();
    newRequest.resolve([{ id: 'state-new', anki_card_id: 'anki-new', front: 'new', back: 'new' }]);
    await expect(newLoad).resolves.toBe(true);
    oldRequest.resolve([{ id: 'state-old', anki_card_id: 'anki-old', front: 'old', back: 'old' }]);
    await expect(oldLoad).resolves.toBe(false);
    expect(useFsrsReviewStore.getState().dueCards.map((card) => card.id)).toEqual(['state-new']);
    expect(useFsrsReviewStore.getState().loading).toBe(false);
  });

  it('does not restore a batch after ending its session while enqueue is pending', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_enqueue_cards') return request.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });
    const start = useFsrsReviewStore.getState().startBatchSession(['anki-1'], [
      { id: 'anki-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' },
    ]);
    useFsrsReviewStore.getState().endSession();
    request.resolve({ states: [{ id: 'state-1', anki_card_id: 'anki-1' }] });
    await expect(start).resolves.toBe(false);
    expect(useFsrsReviewStore.getState()).toMatchObject({
      screen: 'today', sessionMode: null, loading: false, queue: [], error: null,
    });
  });

  it('keeps review-state identities and concurrent suspension when applying a content edit', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'update_anki_card') return request.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });
    const cards = useFsrsReviewStore.getState().queue;
    useFsrsReviewStore.setState({
      dueCards: [cards[0], { ...cards[1], ankiCardId: 'anki-1' }],
    });
    const edit = useFsrsReviewStore.getState().updateCurrentCard('Updated Q', 'Updated A');
    useFsrsReviewStore.setState({ queue: [{ ...cards[0], suspended: true }, cards[1]] });
    request.resolve(undefined);
    await expect(edit).resolves.toBe(true);
    const state = useFsrsReviewStore.getState();
    expect(state.queue[0]).toMatchObject({ front: 'Updated Q', suspended: true });
    expect(state.dueCards.map((card) => card.id)).toEqual(['state-1', 'state-2']);
    expect(state.dueCards.every((card) => card.front === 'Updated Q')).toBe(true);
  });

  it('applies peer ratings deferred during an edit once the edit settles', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'update_anki_card') return request.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });
    const edit = useFsrsReviewStore.getState().updateCurrentCard('Updated Q', 'Updated A');
    useFsrsReviewStore.getState().reconcileExternalRate(['state-1']);
    expect(useFsrsReviewStore.getState().pendingExternalRateIds).toEqual(['state-1']);
    request.resolve(undefined);
    await edit;
    expect(useFsrsReviewStore.getState().pendingExternalRateIds).toEqual([]);
    expect(useFsrsReviewStore.getState().queue.map((card) => card.id)).toEqual(['state-2']);
    expect(useFsrsReviewStore.getState().ratingBusy).toBe(false);
  });
});
