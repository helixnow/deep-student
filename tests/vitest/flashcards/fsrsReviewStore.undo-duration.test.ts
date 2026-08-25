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

  it('reports flip-to-rate duration via fsrs_rate durationMs', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') return farFutureRate('log-duration');
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    useFsrsReviewStore.getState().flip();
    expect(useFsrsReviewStore.getState().flippedAtMs).toBe(T0);

    nowMs = T0 + 42_000;
    await useFsrsReviewStore.getState().rate(3);

    const rateCall = invokeMock.mock.calls.find(([command]) => command === 'fsrs_rate');
    expect(rateCall?.[1]).toMatchObject({ cardStateId: 'state-1', durationMs: 42_000 });
    // 评分后翻面时刻清空，等待下一张卡重新计时
    expect(useFsrsReviewStore.getState().flippedAtMs).toBeNull();
  });

  it('caps runaway durations at MAX_ANSWER_DURATION_MS and omits them without a flip timestamp', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fsrs_preview_intervals') return {};
      if (command === 'fsrs_rate') return farFutureRate(`log-${nowMs}`);
      if (command === 'fsrs_get_stats') return { due: 0 };
      throw new Error(`unexpected invoke: ${command}`);
    });

    // 挂机 30 分钟后评分：按上限截断，不污染用时统计
    useFsrsReviewStore.getState().flip();
    nowMs = T0 + 30 * 60_000;
    await useFsrsReviewStore.getState().rate(3);
    let rateCall = invokeMock.mock.calls.filter(([command]) => command === 'fsrs_rate').at(-1);
    expect(rateCall?.[1]).toMatchObject({ durationMs: MAX_ANSWER_DURATION_MS });

    // 无翻面时刻（外部直接置 flipped）时诚实上报 null
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
});
