import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enFlashcards from '@/locales/en-US/flashcards.json';
import zhFlashcards from '@/locales/zh-CN/flashcards.json';
import enCommon from '@/locales/en-US/common.json';
import type { AnkiLibraryListResponse, ListAnkiCardsParams } from '@/types';

const CJK_RE = /[\u4e00-\u9fff\u3001\u3002\uff08\uff09\uff1a\uff1b\u300c\u300d]/;

function lookupKey(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function resolveEnTranslation(key: string, opts?: Record<string, unknown> | string): string {
  const options = typeof opts === 'object' && opts !== null ? opts : undefined;
  const nsMatch = /^([a-zA-Z0-9_-]+):(.+)$/.exec(key);
  const ns = nsMatch ? nsMatch[1] : 'flashcards';
  const bareKey = nsMatch ? nsMatch[2] : key;
  const bundle = ns === 'common'
    ? (enCommon as unknown as Record<string, unknown>)
    : (enFlashcards as unknown as Record<string, unknown>);

  let raw: unknown;
  if (typeof options?.count === 'number' && options.count === 1) {
    raw = lookupKey(bundle, `${bareKey}_one`);
  }
  if (raw === undefined) {
    raw = lookupKey(bundle, bareKey);
  }
  if (typeof raw !== 'string') {
    raw = typeof options?.defaultValue === 'string'
      ? options.defaultValue
      : typeof opts === 'string'
        ? opts
        : key;
  }
  if (!options) return String(raw);
  return String(raw).replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, token: string) => (
    token in options ? String(options[token] ?? '') : match
  ));
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listAnkiLibraryCards: vi.fn<(params: ListAnkiCardsParams) => Promise<AnkiLibraryListResponse>>(),
  notify: vi.fn(),
  dispatch: vi.fn(),
  speak: vi.fn(async () => undefined),
  stopTts: vi.fn(async () => undefined),
  replayAudio: vi.fn(),
  lastCardFaceProps: null as { fallbackText?: string; className?: string } | null,
  windowListeners: new Map<string, Set<EventListener>>(),
  layout: { scrollHeight: 400, clientHeight: 400 },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chatApi')>()),
  listAnkiLibraryCards: mocks.listAnkiLibraryCards,
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: (props: {
    fallbackText?: string;
    className?: string;
    onImageLightboxChange?: (open: boolean) => void;
  }) => {
    mocks.lastCardFaceProps = { fallbackText: props.fallbackText, className: props.className };
    return (
      <div data-testid="mock-anki-card-face" className={props.className}>
        <span data-testid="mock-anki-fallback-text">{props.fallbackText}</span>
        <button
          type="button"
          data-anki-zoom-trigger="true"
          data-testid="mock-zoom-trigger"
          onClick={() => props.onImageLightboxChange?.(true)}
        >
          zoom
        </button>
      </div>
    );
  },
}));
vi.mock('@/components/anki/utils/cardMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/anki/utils/cardMedia')>()),
  replayCardAudio: mocks.replayAudio,
}));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ viewportRef, children, ...props }: {
    viewportRef?: (element: HTMLDivElement | null) => void;
    children: React.ReactNode;
    className?: string;
  }) => {
    const ref = React.useCallback((element: HTMLDivElement | null) => {
      if (element) {
        Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => mocks.layout.scrollHeight },
          clientHeight: { configurable: true, get: () => mocks.layout.clientHeight },
        });
      }
      if (typeof viewportRef === 'function') viewportRef(element);
    }, [viewportRef]);
    return <div {...props}><div ref={ref} data-testid="mock-scroll-viewport">{children}</div></div>;
  },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));
vi.mock('@/utils/tts', () => ({ speak: mocks.speak, stop: mocks.stopTts }));
vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: mocks.dispatch,
}));
vi.mock('@/components/exam-sprint', () => ({ ExamReadinessHud: () => null }));
vi.mock('../hooks/useReviewActivity', () => ({
  useReviewActivity: () => ({
    status: 'ready',
    dayCounts: new Map(),
    totalCards: 3,
    reload: vi.fn(),
  }),
  computeCurrentStreak: () => 0,
}));
vi.mock('../useFlashcardsMobileChrome', () => ({
  useFlashcardsMobileChrome: () => false,
}));
vi.mock('../library/LibraryCardRow', () => ({
  LibraryCardRow: ({ card }: { card: { id: string; front: string } }) => (
    <li data-testid={`card-row-${card.id}`}>{card.front}</li>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: resolveEnTranslation,
    i18n: { language: 'en-US' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ReviewCardSurface } from '../review/ReviewCardSurface';
import { ReviewSessionScreen } from '../screens/ReviewSessionScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { TodayScreen } from '../screens/TodayScreen';
import { useFsrsReviewStore, type ReviewCard } from '../store/fsrsReviewStore';
import { useFlashcardsLibraryStore } from '../store/libraryStore';

function seedReviewSession(
  cards: ReviewCard[],
  extra: Partial<ReturnType<typeof useFsrsReviewStore.getState>> = {},
): void {
  useFsrsReviewStore.setState({
    screen: 'session',
    sessionMode: 'due',
    dueCards: cards,
    dueTotal: cards.length,
    queue: cards,
    queueIndex: 0,
    flipped: false,
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
    ...extra,
  });
}

function collectLeafEntries(obj: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([p, v]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectLeafEntries(v as Record<string, unknown>, p));
    }
  }
  return out;
}

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe('Wave-3 Flashcards UI fixes (G16 Slice 3 + SOTA S5)', () => {
  beforeEach(() => {
    cleanup();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(null);
    mocks.listAnkiLibraryCards.mockReset();
    mocks.notify.mockReset();
    mocks.dispatch.mockReset();
    mocks.speak.mockReset();
    mocks.stopTts.mockReset();
    mocks.replayAudio.mockReset();
    mocks.lastCardFaceProps = null;
    mocks.layout.scrollHeight = 400;
    mocks.layout.clientHeight = 400;
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('1. Cloze answer Front: review line clipping & raw {{c1::...}} DOM leak', () => {
    it('renders revealed Cloze text with zero raw {{cN::...}} markers in accessible Front summary and fallbackText', () => {
      const clozeText = '{{c1::Atropine}} blocks {{c2::muscarinic::receptor}} acetylcholine receptors.';
      const { container } = render(
        <ReviewCardSurface
          card={{
            id: 'cloze-1',
            front: clozeText,
            text: clozeText,
            back: 'Used to treat organophosphate poisoning.',
          }}
          template={null}
          templateLoading={false}
          flipped
          disabled={false}
          onFlip={vi.fn()}
          frontLabel="Front"
          backLabel="Back"
          flipAriaLabel="Show front"
          flipHint="Tap to flip"
          noFrontText="No front"
          noBackText="No back"
        />,
      );

      const accessibleFront = screen.getByTestId('review-card-front-accessible');
      expect(accessibleFront.textContent).toBe('Front: Atropine blocks muscarinic acetylcholine receptors.');
      expect(accessibleFront.textContent).not.toMatch(/\{\{c\d+::/);

      const fallbackNode = screen.getByTestId('mock-anki-fallback-text');
      expect(fallbackNode.textContent).toContain('Atropine blocks muscarinic acetylcholine receptors.');
      expect(fallbackNode.textContent).toContain('Used to treat organophosphate poisoning.');
      expect(fallbackNode.textContent).not.toMatch(/\{\{c\d+::/);

      // Keep sr-only Front: line scoped inside relative .wb-fc-card-content with zero negative margin clipping.
      const cardContent = container.querySelector('.wb-fc-card-content');
      expect(cardContent).toHaveClass('relative');
      expect(accessibleFront).toHaveClass('sr-only', 'left-1', 'top-1', '!m-0');
    });

    it('detects Cloze markup even when stored only on card.front and avoids top-overflow justify-center when content exceeds viewport', () => {
      mocks.layout.scrollHeight = 900;
      mocks.layout.clientHeight = 320;

      render(
        <ReviewCardSurface
          card={{
            id: 'cloze-front-only',
            front: 'Beta-1 blockers reduce {{c1::heart rate}} and {{c2::renin release}}.',
            back: '',
          }}
          template={null}
          templateLoading={false}
          flipped
          disabled={false}
          onFlip={vi.fn()}
          frontLabel="Front"
          backLabel="Back"
          flipAriaLabel="Show front"
          flipHint="Tap to flip"
          noFrontText="No front"
          noBackText="No back"
        />,
      );

      const accessibleFront = screen.getByTestId('review-card-front-accessible');
      expect(accessibleFront.textContent).toBe('Front: Beta-1 blockers reduce heart rate and renin release.');
      expect(accessibleFront.textContent).not.toMatch(/\{\{c\d+::/);
      expect(mocks.lastCardFaceProps?.className).not.toContain('justify-center');
    });
  });

  describe('2. Undo rating wiring & disabling Undo rating Z on Session Complete', () => {
    it('wires desktop toolbar Undo button and Z shortcut through feedback handler during active session', async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_undo_last_review') {
          return {
            changed: true,
            undoneLogId: 'log-1',
            state: { id: 'card-1', state: 0, suspended: false, lastReviewMs: null },
          };
        }
        return null;
      });

      const card1: ReviewCard = { id: 'card-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' };
      const card2: ReviewCard = { id: 'card-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' };
      seedReviewSession([card1, card2], {
        queueIndex: 1,
        flipped: true,
        sessionRatedCount: 1,
        sessionRatingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 },
        lastReview: {
          logId: 'log-1',
          cardStateId: 'card-1',
          queueIndex: 0,
          rating: 3,
          queueSnapshot: [card1, card2],
        },
        reviewHistory: [
          {
            logId: 'log-1',
            cardStateId: 'card-1',
            queueIndex: 0,
            rating: 3,
            queueSnapshot: [card1, card2],
          },
        ],
      });

      render(<ReviewSessionScreen />);

      const undoBtn = screen.getByRole('button', { name: 'Undo rating' });
      expect(undoBtn).toBeEnabled();
      fireEvent.click(undoBtn);

      await waitFor(() => {
        expect(mocks.invoke).toHaveBeenCalledWith('fsrs_undo_last_review', {
          expectedLogId: 'log-1',
          cardStateId: 'card-1',
        });
      });
      await waitFor(() => {
        expect(mocks.notify).toHaveBeenCalledWith('info', 'Undid last rating');
      });
      expect(useFsrsReviewStore.getState().flipped).toBe(false);
      expect(useFsrsReviewStore.getState().queueIndex).toBe(0);
      expect(useFsrsReviewStore.getState().sessionRatedCount).toBe(0);
    });

    it('surfaces an error notification when toolbar or keyboard Undo fails', async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_undo_last_review') {
          throw new Error('Undo conflict');
        }
        return null;
      });

      const card1: ReviewCard = { id: 'card-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' };
      const card2: ReviewCard = { id: 'card-2', ankiCardId: 'anki-2', front: 'Q2', back: 'A2' };
      seedReviewSession([card1, card2], {
        queueIndex: 1,
        lastReview: {
          logId: 'log-err',
          cardStateId: 'card-1',
          queueIndex: 0,
          rating: 3,
          queueSnapshot: [card1, card2],
        },
        reviewHistory: [
          {
            logId: 'log-err',
            cardStateId: 'card-1',
            queueIndex: 0,
            rating: 3,
            queueSnapshot: [card1, card2],
          },
        ],
      });

      render(<ReviewSessionScreen />);
      fireEvent.keyDown(window, { key: 'z', code: 'KeyZ' });

      await waitFor(() => {
        expect(mocks.notify).toHaveBeenCalledWith('error', 'Undo conflict');
      });
    });

    it('disables Undo rating Z button and ignores Z / Ctrl+Z shortcut on Session Complete', async () => {
      const card1: ReviewCard = { id: 'card-1', ankiCardId: 'anki-1', front: 'Q1', back: 'A1' };
      seedReviewSession([card1], {
        queueIndex: 1, // sessionDone === true
        sessionRatedCount: 1,
        sessionRatingCounts: { 1: 0, 2: 0, 3: 1, 4: 0 },
        lastReview: {
          logId: 'log-final',
          cardStateId: 'card-1',
          queueIndex: 0,
          rating: 3,
          queueSnapshot: [card1],
        },
        reviewHistory: [
          {
            logId: 'log-final',
            cardStateId: 'card-1',
            queueIndex: 0,
            rating: 3,
            queueSnapshot: [card1],
          },
        ],
      });

      render(<ReviewSessionScreen />);
      expect(screen.getByText('Session complete')).toBeInTheDocument();
      // Undo rating Z must NOT be active on Session Complete
      expect(screen.queryByRole('button', { name: 'Undo rating' })).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'z', code: 'KeyZ' });
      fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });

      expect(mocks.invoke).not.toHaveBeenCalledWith('fsrs_undo_last_review', expect.anything());
    });
  });

  describe('3. SOTA Gap S5 ? Keyboard Shortcut Cheat-Sheet Popover', () => {
    it('toggles via ? key and trigger button, lists Space/1-4/Z/R/E/S/-/?, guards card hotkeys while open, and closes on Esc or outside click', () => {
      const card1: ReviewCard = { id: 'card-1', ankiCardId: 'anki-1', front: 'Front Q', back: 'Back A' };
      seedReviewSession([card1]);

      render(<ReviewSessionScreen />);

      const trigger = screen.getByTestId('fc-review-shortcuts-trigger');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('fc-review-shortcuts-popover')).not.toBeInTheDocument();

      // Open via ? hotkey
      fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true });
      const popover = screen.getByTestId('fc-review-shortcuts-popover');
      expect(popover).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      // All 8 required shortcuts are present
      for (const keyLabel of ['Space', '1–4', 'Z', 'R', 'E', 'S', '-', '?']) {
        expect(popover.textContent).toContain(keyLabel);
      }
      expect(popover.textContent).not.toMatch(CJK_RE);

      // While popover is open, Space must NOT flip the card underneath
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      expect(useFsrsReviewStore.getState().flipped).toBe(false);

      // Esc closes popover cleanly
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      expect(screen.queryByTestId('fc-review-shortcuts-popover')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');

      // Reopen via click trigger and close via outside pointerdown
      fireEvent.click(trigger);
      expect(screen.getByTestId('fc-review-shortcuts-popover')).toBeInTheDocument();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByTestId('fc-review-shortcuts-popover')).not.toBeInTheDocument();

      // Reopen via click trigger and close via Close button
      fireEvent.click(trigger);
      fireEvent.click(screen.getByTestId('fc-review-shortcuts-close'));
      expect(screen.queryByTestId('fc-review-shortcuts-popover')).not.toBeInTheDocument();
    });
  });

  describe('4. Zero en-US Chinese leakage across locales & screens', () => {
    it('maintains 100% key parity between en-US and zh-CN flashcards.json with zero CJK in en-US', () => {
      const enLeaves = collectLeafEntries(enFlashcards as unknown as Record<string, unknown>);
      const zhLeaves = collectLeafEntries(zhFlashcards as unknown as Record<string, unknown>);
      expect(enLeaves.map(([k]) => k).sort()).toEqual(zhLeaves.map(([k]) => k).sort());

      for (const [k, v] of enLeaves) {
        expect(CJK_RE.test(v), `en-US flashcards.${k} must not contain CJK: "${v}"`).toBe(false);
      }
    });

    it('renders zero Chinese text in en-US across LibraryScreen (pagination + Card Composer + CSV import), ReviewSessionScreen (post-rate + edit + summary), and TodayScreen (pending enqueue)', async () => {
      // 1) LibraryScreen: pagination + Card Composer (Basic & Cloze) + CSV preview
      useFlashcardsLibraryStore.getState().reset();
      mocks.listAnkiLibraryCards.mockResolvedValue({
        items: [
          {
            id: 'c1',
            front: 'Q1',
            back: 'A1',
            tags: [],
            created_at: '2026-11-25T00:00:00Z',
            enqueued: false,
            suspended: false,
            isDue: false,
          },
        ],
        total: 40,
        page: 1,
        pageSize: 20,
        decks: [{ name: 'Pharmacology', all: 40, due: 1, new: 10, notEnqueued: 1 }],
      });

      const libView = render(<LibraryScreen />);
      await waitFor(() => {
        expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      });
      // Open Card Composer and toggle to Cloze mode
      fireEvent.click(screen.getByRole('button', { name: 'New card' }));
      fireEvent.click(screen.getByTestId('fc-lib-create-mode-cloze'));
      expect(libView.container.textContent).not.toMatch(CJK_RE);
      expect(screen.getByTestId('library-page-size-select').textContent).not.toMatch(CJK_RE);
      expect(screen.getByTestId('library-page-jump-btn').textContent).toBe('Go');

      // Open CSV import panel
      fireEvent.click(screen.getByTestId('fc-lib-more-actions'));
      fireEvent.click(screen.getByTestId('fc-lib-import-csv'));
      expect(libView.container.textContent).not.toMatch(CJK_RE);
      libView.unmount();

      // 2) ReviewSessionScreen: post-rate Again UndoNudge + Session Complete
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_rate') {
          return {
            logId: 'log-en-again',
            dueMs: Date.now() + 60_000,
            scheduledDays: 0,
            cardState: { id: 's1', state: 1, suspended: false, lastReviewMs: Date.now() },
          };
        }
        return null;
      });
      seedReviewSession(
        [
          { id: 's1', ankiCardId: 'a1', front: 'Front 1', back: 'Back 1' },
          { id: 's2', ankiCardId: 'a2', front: 'Front 2', back: 'Back 2' },
        ],
        { flipped: true },
      );
      const revView = render(<ReviewSessionScreen />);
      await act(async () => {
        await useFsrsReviewStore.getState().rate(1, 1200);
      });
      const askAiNudge = await screen.findByTestId('fc-nudge-ask-ai');
      expect(askAiNudge.textContent).toBe('Ask AI to explain');
      expect(revView.container.textContent).not.toMatch(CJK_RE);

      // Switch to Session Complete with Again rescue banner
      act(() => {
        useFsrsReviewStore.setState({ queueIndex: 2, sessionRatedCount: 2 });
      });
      expect(screen.getByTestId('fc-summary-again-rescue')).toBeInTheDocument();
      expect(revView.container.textContent).not.toMatch(CJK_RE);
      revView.unmount();

      // 3) TodayScreen: pendingEnqueue state (3 CJK keys verified clean in en-US)
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'fsrs_get_due') return [];
        if (cmd === 'fsrs_get_stats') {
          return {
            total: 0,
            due: 0,
            newCount: 0,
            learning: 0,
            review: 0,
            relearning: 0,
            suspended: 0,
            reviewsToday: 0,
          };
        }
        if (cmd === 'list_anki_library_cards') return { total: 5, decks: [] };
        return null;
      });
      useFsrsReviewStore.setState({
        screen: 'today',
        dueCards: [],
        dueTotal: 0,
        queue: [],
        queueIndex: 0,
        loading: false,
        error: null,
      });
      const todayView = render(<TodayScreen />);
      await waitFor(() => {
        expect(screen.getByText('5 new cards are not in review yet')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Add to review' })).toBeInTheDocument();
      expect(todayView.container.textContent).not.toMatch(CJK_RE);
    });
  });
});
