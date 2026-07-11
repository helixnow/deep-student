/**
 * FSRS 复习会话最小 store（M3）
 *
 * - 支持今日 due / Chat 批次（ankiCardIds）两种入口
 * - 优先 invoke `fsrs_get_due` / `fsrs_enqueue_cards` / `fsrs_rate`；失败则本地 mock 队列
 * - `ReviewCard.id` = fsrs_card_states.id（评分用 cardStateId）；`ankiCardId` 为内容侧 id
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import type { AnkiLibraryCard } from '@/types';
import { requestFlashcardsDueRefresh } from '../events';

export type FlashcardsScreen = 'today' | 'library' | 'settings' | 'session';

export type FsrsRating = 1 | 2 | 3 | 4;

export interface ReviewCard {
  /** fsrs_card_states.id — 传给 fsrs_rate 的 cardStateId */
  id: string;
  /** anki_cards.id */
  ankiCardId?: string;
  front: string;
  back: string;
  tags?: string[];
}

export interface FlashcardsLaunchPayload {
  screen?: FlashcardsScreen;
  mode?: 'due' | 'batch';
  /** anki_cards.id 列表（Chat「复习这批」） */
  cardIds?: string[];
}

interface FsrsReviewState {
  screen: FlashcardsScreen;
  dueCards: ReviewCard[];
  queue: ReviewCard[];
  queueIndex: number;
  flipped: boolean;
  loading: boolean;
  ratingBusy: boolean;
  usingMock: boolean;
  error: string | null;
  lastRated: FsrsRating | null;

  setScreen: (screen: FlashcardsScreen) => void;
  applyLaunchPayload: (payload: unknown) => void;
  loadDue: () => Promise<void>;
  startDueSession: () => void;
  startBatchSession: (cardIds: string[], cards?: ReviewCard[]) => Promise<void>;
  /**
   * ACR R1-15：复习 session 进行中 append-only 入队。
   * 仅 screen==='session' 时生效；按 id 去重；不动 queueIndex/flipped/当前卡。
   * @returns 实际新加入的卡片数
   */
  appendToQueue: (cards: ReviewCard[]) => number;
  flip: () => void;
  rate: (rating: FsrsRating) => Promise<void>;
  endSession: () => void;
  resetFlip: () => void;
}

const MOCK_DUE: ReviewCard[] = [
  {
    id: 'mock-1',
    front: 'What is FSRS?',
    back: 'Free Spaced Repetition Scheduler — an open spaced-repetition algorithm.',
    tags: ['mock'],
  },
  {
    id: 'mock-2',
    front: 'Rating 1 / 2 / 3 / 4 means…',
    back: 'Again / Hard / Good / Easy (Anki-style grades).',
    tags: ['mock'],
  },
  {
    id: 'mock-3',
    front: 'Deep Student flashcards live where?',
    back: 'In the workbench Flashcards app (typeId: flashcards).',
    tags: ['mock'],
  },
];

function asLibraryCard(card: AnkiLibraryCard): ReviewCard {
  return {
    id: card.id,
    ankiCardId: card.id,
    front: card.front || card.fields?.Front || '',
    back: card.back || card.fields?.Back || card.text || '',
    tags: card.tags,
  };
}

function parseLaunchPayload(payload: unknown): FlashcardsLaunchPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload as FlashcardsLaunchPayload;
}

function parseTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = raw.filter((t): t is string => typeof t === 'string');
  return tags.length > 0 ? tags : undefined;
}

/** 解析 fsrs_get_due / enqueue states 行 → ReviewCard */
function mapFsrsRow(row: Record<string, unknown>): ReviewCard | null {
  const id = typeof row.id === 'string' ? row.id : null;
  if (!id) return null;
  const ankiCardId =
    typeof row.ankiCardId === 'string'
      ? row.ankiCardId
      : typeof row.anki_card_id === 'string'
        ? row.anki_card_id
        : undefined;
  return {
    id,
    ankiCardId,
    front: typeof row.front === 'string' ? row.front : '',
    back: typeof row.back === 'string' ? row.back : '',
    tags: parseTags(row.tags),
  };
}

async function fetchDueFromBackend(): Promise<ReviewCard[] | null> {
  try {
    const result = await invoke<unknown>('fsrs_get_due', { limit: 50 });
    if (!Array.isArray(result)) return null;
    const cards: ReviewCard[] = [];
    for (const item of result) {
      if (!item || typeof item !== 'object') continue;
      const mapped = mapFsrsRow(item as Record<string, unknown>);
      if (mapped) cards.push(mapped);
    }
    return cards;
  } catch {
    return null;
  }
}

/**
 * 批次入口：先 enqueue（anki_card_id → fsrs state），再用返回的 state.id 作为评分 id。
 * 内容优先用调用方传入的 cards；否则从库表补全。
 */
async function enqueueBatchForReview(
  ankiCardIds: string[],
  contentByAnkiId?: Map<string, ReviewCard>,
): Promise<ReviewCard[] | null> {
  if (ankiCardIds.length === 0) return [];
  try {
    const result = await invoke<{
      enqueued?: number;
      skipped?: number;
      states?: Array<Record<string, unknown>>;
    }>('fsrs_enqueue_cards', { ankiCardIds });
    const states = Array.isArray(result?.states) ? result.states : [];
    if (states.length === 0) return null;

    return states
      .map((row): ReviewCard | null => {
        const mapped = mapFsrsRow(row);
        if (!mapped) return null;
        const content = mapped.ankiCardId
          ? contentByAnkiId?.get(mapped.ankiCardId)
          : undefined;
        return {
          ...mapped,
          front: content?.front || mapped.front || '',
          back: content?.back || mapped.back || '',
          tags: content?.tags || mapped.tags,
        } satisfies ReviewCard;
      })
      .filter((c): c is ReviewCard => !!c);
  } catch {
    return null;
  }
}

async function resolveContentByAnkiIds(
  ankiCardIds: string[],
): Promise<Map<string, ReviewCard>> {
  const map = new Map<string, ReviewCard>();
  if (ankiCardIds.length === 0) return map;
  try {
    const res = await listAnkiLibraryCards({ page: 1, page_size: 200 });
    for (const c of res.items) {
      if (ankiCardIds.includes(c.id)) {
        map.set(c.id, asLibraryCard(c));
      }
    }
  } catch {
    /* library unavailable */
  }
  return map;
}

export const useFsrsReviewStore = create<FsrsReviewState>((set, get) => ({
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

  setScreen: (screen) => set({ screen }),

  applyLaunchPayload: (payload) => {
    const parsed = parseLaunchPayload(payload);
    if (!parsed) return;
    if (parsed.screen === 'session' && parsed.mode === 'batch' && Array.isArray(parsed.cardIds)) {
      void get().startBatchSession(parsed.cardIds);
      return;
    }
    if (parsed.screen === 'session' && parsed.mode === 'due') {
      void get()
        .loadDue()
        .then(() => get().startDueSession());
      return;
    }
    if (parsed.screen && parsed.screen !== 'session') {
      set({ screen: parsed.screen });
    }
  },

  loadDue: async () => {
    set({ loading: true, error: null });
    const fromBackend = await fetchDueFromBackend();
    // [] 是合法空 due，仅 null（invoke 失败 / 非数组）才降级 mock
    if (fromBackend !== null) {
      set({ dueCards: fromBackend, usingMock: false, loading: false });
      return;
    }
    set({ dueCards: MOCK_DUE, usingMock: true, loading: false });
  },

  startDueSession: () => {
    const { dueCards, usingMock } = get();
    // 真实空 due：空队列（完成态）；仅演示模式才用 MOCK_DUE
    const queue =
      dueCards.length > 0 ? dueCards : usingMock ? MOCK_DUE : [];
    set({
      queue,
      queueIndex: 0,
      flipped: false,
      lastRated: null,
      screen: 'session',
      usingMock: dueCards.length === 0 ? usingMock : false,
      error: null,
    });
  },

  startBatchSession: async (cardIds, cards) => {
    set({ loading: true, error: null, screen: 'session' });
    const ankiIds = cardIds.filter((id) => typeof id === 'string' && id.length > 0);

    const contentByAnkiId =
      cards && cards.length > 0
        ? new Map(
            cards.map((c) => [c.ankiCardId || c.id, c] as const),
          )
        : await resolveContentByAnkiIds(ankiIds);

    const enqueued = await enqueueBatchForReview(ankiIds, contentByAnkiId);
    if (enqueued && enqueued.length > 0) {
      set({
        queue: enqueued,
        queueIndex: 0,
        flipped: false,
        lastRated: null,
        loading: false,
        usingMock: false,
      });
      return;
    }

    // 后端不可用：用内容 stub，评分会走 mock 降级
    const fallback =
      ankiIds.length > 0
        ? ankiIds.map((id, i) => {
            const content = contentByAnkiId.get(id);
            return {
              id,
              ankiCardId: id,
              front: content?.front || `Card ${i + 1}`,
              back:
                content?.back ||
                'Content unavailable offline — rate to continue.',
              tags: content?.tags || ['batch'],
            } satisfies ReviewCard;
          })
        : MOCK_DUE;

    set({
      queue: fallback,
      queueIndex: 0,
      flipped: false,
      lastRated: null,
      loading: false,
      usingMock: true,
    });
  },

  /**
   * ACR R1-15：session 中 append-only 入队（铁律：不重置 queueIndex / flipped）。
   * 见 docs/dev/acr/DESIGN.md §5.4。
   */
  appendToQueue: (cards) => {
    const state = get();
    if (state.screen !== 'session') return 0;
    if (!Array.isArray(cards) || cards.length === 0) return 0;

    const existing = new Set(state.queue.map((c) => c.id));
    const toAdd: ReviewCard[] = [];
    for (const card of cards) {
      if (!card || typeof card.id !== 'string' || !card.id) continue;
      if (existing.has(card.id)) continue;
      existing.add(card.id);
      toAdd.push(card);
    }
    if (toAdd.length === 0) return 0;

    set({ queue: [...state.queue, ...toAdd] });
    return toAdd.length;
  },

  flip: () => set((s) => ({ flipped: !s.flipped })),

  rate: async (rating) => {
    const { queue, queueIndex, ratingBusy, usingMock } = get();
    if (ratingBusy) return;
    const current = queue[queueIndex];
    if (!current) return;

    set({ ratingBusy: true, lastRated: rating, error: null });

    const advance = () => {
      const nextIndex = queueIndex + 1;
      // 队列耗尽时保持 screen=session，让 ReviewSessionScreen 展示完成态；
      // 不直接跳回 today（由用户点「返回今日」/退出）。
      // 不在此处 loadDue：其 loading 会盖住完成态；返回今日时 TodayScreen 会自行刷新。
      set({
        ratingBusy: false,
        flipped: false,
        queueIndex: nextIndex,
      });
      requestFlashcardsDueRefresh();
    };

    // 演示队列：本地前进，不伪装后端成功
    if (usingMock) {
      advance();
      return;
    }

    try {
      await invoke('fsrs_rate', {
        cardStateId: current.id,
        rating,
      });
      advance();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : '评分失败';
      set({
        ratingBusy: false,
        error: message || '评分失败',
      });
    }
  },

  endSession: () => {
    set({
      screen: 'today',
      flipped: false,
      lastRated: null,
      ratingBusy: false,
    });
    requestFlashcardsDueRefresh();
  },

  resetFlip: () => set({ flipped: false }),
}));
