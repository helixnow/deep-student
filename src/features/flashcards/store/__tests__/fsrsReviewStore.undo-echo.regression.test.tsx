import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, dispatchMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: dispatchMock,
}));

vi.mock('@/features/workbench/agent/visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const raw = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''));
    },
    i18n: { language: 'en-US' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import {
  formatInterval,
  stopFsrsDayRolloverTimer,
  useFsrsReviewStore,
  type ReviewCard,
} from '../fsrsReviewStore';
import { handleFsrsDomainChange } from '@/features/workbench/agent/drivers/fsrsDriver';
import {
  RetentionInsightsPanel,
  parseRetentionInsights,
} from '../../components/RetentionInsightsPanel';
import { FsrsParamsPanel } from '../../components/FsrsParamsPanel';
import { FsrsOptimizerPanel } from '../../components/FsrsOptimizerPanel';
import { SessionSummary } from '../../review/SessionSummary';
import { askAiAboutCard, askAiAboutCards, formatCardForAiPrompt } from '../../review/askAiAboutCard';
import { formatAbsoluteTime, formatCreatedAt } from '../../library/libraryView';
import type { AnkiLibraryCard } from '@/types';
import type { TFunction } from 'i18next';

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function makeCard(id: string, extra: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id,
    ankiCardId: `anki-${id}`,
    front: `Front ${id}`,
    back: `Back ${id}`,
    lastReviewMs: null,
    ...extra,
  };
}

function resetStore(cards: ReviewCard[] = []): void {
  stopFsrsDayRolloverTimer();
  useFsrsReviewStore.setState({
    screen: 'session',
    sessionMode: 'due',
    dueCards: cards,
    dueTotal: cards.length,
    queue: cards,
    queueIndex: 0,
    flipped: true,
    flippedAtMs: Date.now(),
    loading: false,
    ratingBusy: false,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    reviewHistory: [],
    lastSuspended: null,
    retryBatchRequest: null,
    sessionRatedCount: 0,
    sessionAgainCount: 0,
    sessionAgainCardIds: [],
    sessionRatingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    sessionStreak: 0,
    sessionBestStreak: 0,
    sessionStartedAtMs: Date.now(),
    remainingDueAfterSession: null,
    ratingPreviews: null,
    lastSchedule: null,
    recentLocalLogIds: [],
    pendingExternalRateIds: [],
    pendingExternalRatePairs: [],
    pendingRateOp: null,
  });
}

describe('G16 fsrsReviewStore undo, self-echo race, and formatInterval regressions', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    dispatchMock.mockReset();
    notifyMock.mockReset();
    resetStore();
  });

  afterEach(() => {
    stopFsrsDayRolloverTimer();
  });

  it('ignores in-flight self-echo fsrs://changed during rate() and rolls back UI atomically on undo', async () => {
    const cardA = makeCard('state-a');
    const cardB = makeCard('state-b');
    resetStore([cardA, cardB]);

    let capturedOpId = '';
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'fsrs_rate') {
        capturedOpId = String(args?.clientOpId ?? '');
        // Simulate backend emitting fsrs://changed BEFORE fsrs_rate RPC resolves!
        handleFsrsDomainChange({
          source: 'user',
          action: 'rate',
          entityIds: ['anki-state-a'],
          cardStateIds: ['state-a'],
          cards: [{ id: 'state-a', ankiCardId: 'anki-state-a', logId: capturedOpId }],
        });
        return {
          logId: capturedOpId,
          dueMs: Date.now() + 4 * 86_400_000,
          scheduledDays: 4,
          buriedSiblings: [],
          cardState: {
            id: 'state-a',
            ankiCardId: 'anki-state-a',
            state: 2,
            suspended: false,
            lastReviewMs: Date.now(),
          },
        };
      }
      if (cmd === 'fsrs_undo_last_review') {
        return {
          changed: true,
          undoneLogId: args?.expectedLogId,
          state: {
            id: 'state-a',
            ankiCardId: 'anki-state-a',
            state: 0,
            suspended: false,
            lastReviewMs: null,
          },
        };
      }
      if (cmd === 'fsrs_get_stats') {
        return { due: 2 };
      }
      return null;
    });

    await useFsrsReviewStore.getState().rate(4, 1500);

    const afterRate = useFsrsReviewStore.getState();
    expect(capturedOpId).toBeTruthy();
    expect(afterRate.pendingExternalRateIds).toEqual([]);
    expect(afterRate.queue.map((c) => c.id)).toEqual(['state-a', 'state-b']);
    expect(afterRate.queueIndex).toBe(1);
    expect(afterRate.sessionRatedCount).toBe(1);
    expect(afterRate.sessionRatingCounts[4]).toBe(1);
    expect(afterRate.sessionStreak).toBe(1);
    expect(afterRate.lastReview?.logId).toBe(capturedOpId);

    // Now undo: must restore state-a at index 0, flip back to front, and roll back all counts!
    const ok = await useFsrsReviewStore.getState().undoLastReview();
    expect(ok).toBe(true);

    const afterUndo = useFsrsReviewStore.getState();
    expect(afterUndo.queue.map((c) => c.id)).toEqual(['state-a', 'state-b']);
    expect(afterUndo.queueIndex).toBe(0);
    expect(afterUndo.flipped).toBe(false);
    expect(afterUndo.sessionRatedCount).toBe(0);
    expect(afterUndo.sessionRatingCounts).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(afterUndo.sessionStreak).toBe(0);
    expect(afterUndo.lastReview).toBeNull();
    expect(afterUndo.queue[0]?.lastReviewMs).toBeNull();
    await waitFor(() => expect(useFsrsReviewStore.getState().dueTotal).toBe(2));
  });

  it('restores the undone card from queueSnapshot even if removed from live queue, plus leech suspension and buried siblings', async () => {
    const cardA = makeCard('state-a', { suspended: false, buried: false });
    const siblingB = makeCard('state-b', { suspended: false, buried: false });
    const cardC = makeCard('state-c');
    resetStore([cardA, siblingB, cardC]);

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'fsrs_rate') {
        return {
          logId: String(args?.clientOpId),
          dueMs: Date.now() + 60_000,
          scheduledDays: 0,
          buriedSiblings: ['state-b'],
          cardState: {
            id: 'state-a',
            ankiCardId: 'anki-state-a',
            state: 3,
            suspended: true, // leech auto-suspend
            lastReviewMs: 123456,
          },
        };
      }
      if (cmd === 'fsrs_undo_last_review') {
        return {
          changed: true,
          undoneLogId: args?.expectedLogId,
          state: {
            id: 'state-a',
            ankiCardId: 'anki-state-a',
            state: 0,
            suspended: false,
            lastReviewMs: null,
          },
        };
      }
      if (cmd === 'fsrs_get_stats') return { due: 3 };
      return null;
    });

    await useFsrsReviewStore.getState().rate(1, 900);
    expect(useFsrsReviewStore.getState().queue[0]?.suspended).toBe(true);
    expect(useFsrsReviewStore.getState().queue[1]?.buried).toBe(true);
    expect(useFsrsReviewStore.getState().queueIndex).toBe(2);

    // Simulate state-a being dropped from live queue prior to undo
    useFsrsReviewStore.setState((s) => ({
      queue: s.queue.filter((card) => card.id !== 'state-a'),
      queueIndex: 1,
      flipped: true,
    }));

    const undone = await useFsrsReviewStore.getState().undoLastReview();
    expect(undone).toBe(true);
    const next = useFsrsReviewStore.getState();
    expect(next.queue.map((c) => c.id)).toEqual(['state-a', 'state-b', 'state-c']);
    expect(next.queueIndex).toBe(0);
    expect(next.flipped).toBe(false);
    expect(next.queue[0]?.suspended).toBe(false);
    expect(next.queue[1]?.buried).toBe(false);
    expect(next.lastSuspended).toBeNull();
    expect(next.sessionAgainCount).toBe(0);
    expect(next.sessionAgainCardIds).toEqual([]);
  });

  it('drops un-logged self-echo during ratingBusy while preserving genuine foreign-logId external rates', async () => {
    const cardA = makeCard('state-a');
    const cardB = makeCard('state-b');
    resetStore([cardA, cardB]);

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'fsrs_rate') {
        // Legacy echo without logId for current card A -> deferred during ratingBusy, dropped after rate finishes
        handleFsrsDomainChange({
          source: 'user',
          action: 'rate',
          cardStateIds: ['state-a'],
          cards: [{ id: 'state-a', ankiCardId: 'anki-state-a' }],
        });
        // Genuine external rate from another window on card B with foreign logId -> immediately reconciled
        handleFsrsDomainChange({
          source: 'user',
          action: 'rate',
          cardStateIds: ['state-b'],
          cards: [{ id: 'state-b', ankiCardId: 'anki-state-b', logId: 'foreign-log-b' }],
        });
        return {
          logId: String(args?.clientOpId),
          dueMs: Date.now() + 2 * 86_400_000,
          scheduledDays: 2,
          buriedSiblings: [],
          cardState: {
            id: 'state-a',
            ankiCardId: 'anki-state-a',
            state: 2,
            suspended: false,
            lastReviewMs: Date.now(),
          },
        };
      }
      if (cmd === 'fsrs_get_stats') return { due: 0 };
      return null;
    });

    await useFsrsReviewStore.getState().rate(3, 500);
    const state = useFsrsReviewStore.getState();
    // state-a kept in completed prefix (not stripped by un-logged self-echo), state-b removed by foreign rate
    expect(state.queue.map((c) => c.id)).toEqual(['state-a']);
    expect(state.queueIndex).toBe(1);
    expect(state.sessionRatedCount).toBe(1);
    expect(state.pendingExternalRateIds).toEqual([]);
    expect(state.pendingExternalRatePairs).toEqual([]);
  });

  it('guards formatInterval against 0d, 60m, and 24h boundary artifacts', () => {
    expect(formatInterval(-500)).toBe('<1m');
    expect(formatInterval(0)).toBe('<1m');
    expect(formatInterval(59_000)).toBe('<1m');
    expect(formatInterval(60_000)).toBe('1m');
    expect(formatInterval(59.6 * 60_000)).toBe('1h');
    expect(formatInterval(23.6 * 3_600_000)).toBe('1d');
    expect(formatInterval(86_400_000)).toBe('1d');
    expect(formatInterval(4 * 86_400_000)).toBe('4d');
    expect(formatInterval(30 * 86_400_000)).toBe('1mo');
  });
});

describe('G16 RetentionInsightsPanel and en-US fallback hygiene', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    dispatchMock.mockReset();
  });

  it('explains learningReviewsToday when trueRetention has 0 formal Review samples', async () => {
    const payload = {
      dayStartMs: Date.now(),
      dailyReviews: [{ date: '2026-11-25', total: 6, studyMs: 120_000 }],
      dailyLimits: { reviewsDoneToday: 0, newIntroducedToday: 6 },
      ratingDistribution: { again: 1, hard: 1, good: 3, easy: 1, total: 6 },
      learningReviewsToday: 6,
      trueRetention: [
        { period: 'today', youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0 },
        { period: 'yesterday', youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0 },
        { period: 'week', youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0 },
        { period: 'month', youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0 },
        { period: 'year', youngReviews: 0, youngPassed: 0, matureReviews: 0, maturePassed: 0 },
      ],
      memoryDistributions: {
        cards: 6,
        difficulty: [0, 0, 0, 2, 4, 0, 0, 0, 0, 0],
        stability: [4, 2, 0, 0, 0, 0, 0, 0, 0],
        retrievability: [0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
      },
    };
    const parsed = parseRetentionInsights(payload, '2026-11-25');
    expect(parsed?.learningReviewsToday).toBe(6);
    expect(parsed?.totalReviewsInWindow).toBe(6);

    invokeMock.mockResolvedValue(payload);
    render(<RetentionInsightsPanel />);
    const note = await screen.findByTestId('fsrs-retention-learning-note');
    expect(note.textContent).toContain('6 new/learning reviews completed today');
    expect(note.textContent).not.toMatch(CJK_RE);
  });

  it('emits zero Chinese fallback text in en-US across owned Flashcards panels and helpers', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_scheduler_config') return { fsrsParams: [] };
      if (cmd === 'fsrs_get_due') return [{ stability: 4.2, difficulty: 5.1 }];
      return null;
    });

    const { container: paramsContainer } = render(<FsrsParamsPanel />);
    await waitFor(() => expect(paramsContainer.textContent).toContain('Memory stability'));
    expect(paramsContainer.textContent).not.toMatch(CJK_RE);

    const { container: optContainer } = render(
      <FsrsOptimizerPanel fsrsParams={[]} onConfigChanged={vi.fn()} />,
    );
    expect(optContainer.textContent).not.toMatch(CJK_RE);

    const { container: sumContainer } = render(
      <SessionSummary
        empty={false}
        headline="Session complete"
        ratedCount={3}
        ratingCounts={{ 1: 1, 2: 0, 3: 2, 4: 0 }}
        bestStreak={2}
        elapsedMs={30_000}
        remainingDue={0}
        busy={false}
        canUndo={false}
        canResume={false}
        onUndo={vi.fn()}
        onResume={vi.fn()}
        onBack={vi.fn()}
        againCount={1}
        canRetryAgain
        onRetryAgain={vi.fn()}
        onAskAiAgain={vi.fn()}
      />,
    );
    expect(sumContainer.textContent).not.toMatch(CJK_RE);

    const enT = ((key: string, opts?: Record<string, unknown>) => {
      if (key === 'session.front') return 'Front';
      if (key === 'session.back') return 'Back';
      const raw = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''));
    }) as unknown as TFunction;

    const prompt = formatCardForAiPrompt({ front: 'Q1', back: 'A1' }, enT);
    expect(prompt).toBe('Front: Q1\nBack: A1');
    expect(prompt).not.toMatch(CJK_RE);

    askAiAboutCard({ front: 'Q1', back: 'A1' }, enT);
    askAiAboutCards([{ front: 'Q1', back: 'A1' }], enT);
    for (const [, detail] of dispatchMock.mock.calls) {
      expect((detail as { content: string }).content).not.toMatch(CJK_RE);
    }

    const abs = formatAbsoluteTime(Date.UTC(2026, 10, 25, 12, 0), 'en-US');
    const created = formatCreatedAt({ created_at: '2026-11-25T12:00:00Z' } as AnkiLibraryCard, 'en-US');
    expect(abs).not.toMatch(CJK_RE);
    expect(created).not.toMatch(CJK_RE);
  });
});
