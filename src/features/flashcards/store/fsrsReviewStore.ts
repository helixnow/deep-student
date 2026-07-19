/**
 * FSRS 复习会话最小 store（M3）
 *
 * - 支持今日 due / Chat 批次（ankiCardIds）两种入口
 * - invoke `fsrs_get_due` / `fsrs_enqueue_cards` / `fsrs_rate`，失败时保留显式错误供用户重试
 * - `ReviewCard.id` = fsrs_card_states.id（评分用 cardStateId）；`ankiCardId` 为内容侧 id
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import type { AnkiCard } from '@/types';
import { requestFlashcardsDueRefresh } from '../events';
import {
  applyReviewCardEdit,
  isClozeReviewCard,
  type ReviewEditTemplate,
} from '../reviewCardEditFields';
import { hasValidCloze } from '../cloze';

export type FlashcardsScreen = 'today' | 'library' | 'settings' | 'session';

export type FsrsRating = 1 | 2 | 3 | 4;

const FSRS_DIAGNOSTIC_CARD_NOT_REVIEWABLE = 'fsrs_diagnostic_card_not_reviewable';

export type RatingPreview = {
  dueMs: number;
  scheduledDays: number;
  intervalMs: number;
};

export type RatingPreviews = Partial<Record<FsrsRating, RatingPreview>>;

export interface ReviewCard {
  /** fsrs_card_states.id — 传给 fsrs_rate 的 cardStateId */
  id: string;
  /** anki_cards.id */
  ankiCardId?: string;
  front: string;
  back: string;
  /** Cloze 原文（保留 {{cN::...}} 标记） */
  text?: string;
  tags?: string[];
  images?: string[];
  templateId?: string | null;
  extraFields?: Record<string, string>;
  isErrorCard?: boolean;
  errorContent?: string | null;
  /** 当前调度状态是否暂停；活动 session 会跳过暂停卡。 */
  suspended?: boolean;
  /** 评分 CAS：进入队列时的 last_review_ms（null=从未评过） */
  lastReviewMs?: number | null;
}

export type FsrsAgentReviewAction = 'undo_last_review' | 'set_suspended';

export interface FsrsAgentReviewStateChange {
  ankiCardId: string;
  cardStateId: string;
  suspended: boolean;
  dueMs?: number;
}

export interface ReviewReceipt {
  logId: string;
  cardStateId: string;
  queueIndex: number;
  /** 评分前队列快照，供 Again 回插后 undo 还原顺序 */
  queueSnapshot?: ReviewCard[];
  rating?: FsrsRating;
}

export interface SuspendedReviewReceipt {
  cardStateId: string;
  queueIndex: number;
}

export type ReviewSessionErrorKind =
  | 'prepare'
  | 'rate'
  | 'undo'
  | 'edit'
  | 'suspend'
  | 'resume';

export interface FlashcardsLaunchPayload {
  screen?: FlashcardsScreen;
  mode?: 'due' | 'batch';
  /** anki_cards.id 列表（Chat「复习这批」） */
  cardIds?: string[];
  /** 调用方已持有的卡片正文，避免再次扫描卡片库。 */
  cards?: ReviewCard[];
}

export interface BatchReviewRequest {
  cardIds: string[];
  cards?: ReviewCard[];
}

interface FsrsReviewState {
  screen: FlashcardsScreen;
  dueCards: ReviewCard[];
  /** 后端统计的真实到期总数（可能大于本轮 dueCards.length） */
  dueTotal: number;
  queue: ReviewCard[];
  queueIndex: number;
  flipped: boolean;
  loading: boolean;
  ratingBusy: boolean;
  error: string | null;
  errorKind: ReviewSessionErrorKind | null;
  lastRated: FsrsRating | null;
  lastReview: ReviewReceipt | null;
  lastSuspended: SuspendedReviewReceipt | null;
  retryBatchRequest: BatchReviewRequest | null;
  sessionRatedCount: number;
  sessionAgainCount: number;
  remainingDueAfterSession: number | null;
  ratingPreviews: RatingPreviews | null;
  lastSchedule: { dueMs: number; scheduledDays: number } | null;
  /** 本窗近期成功评分的 logId，用于忽略域事件回声（含延迟回声） */
  recentLocalLogIds: string[];
  /** ratingBusy 期间暂存的外部已评卡，rate 结束后再 reconcile */
  pendingExternalRateIds: string[];
  /** 完成态 stats 拉取代数，防止乱序覆盖 */
  statsFetchGen: number;

  setScreen: (screen: FlashcardsScreen) => void;
  applyLaunchPayload: (payload: unknown) => void;
  loadDue: () => Promise<boolean>;
  startDueSession: () => void;
  startBatchSession: (cardIds: string[], cards?: ReviewCard[]) => Promise<boolean>;
  retryBatchSession: () => Promise<void>;
  /**
   * ACR R1-15：复习 session 进行中 append-only 入队。
   * 仅 screen==='session' 时生效；按 id 去重；不重置活动卡或翻面状态。
   * 已完成的 session 可越过新追加队列开头的暂停卡。
   * @returns 实际新加入的卡片数
   */
  appendToQueue: (cards: ReviewCard[]) => number;
  /** 将 ChatAnki Agent 写入的调度状态合并进正在进行的复习 session。 */
  reconcileAgentReviewChange: (
    action: FsrsAgentReviewAction,
    changes: FsrsAgentReviewStateChange[],
  ) => void;
  /** Merge Agent card-content mutations without replacing FSRS state IDs. */
  reconcileAgentCardContent: (cards: ReviewCard[]) => void;
  /**
   * 多窗 / 他端已评分：从本会话队列移除对应卡，避免重复评分。
   * 本窗 logId 回声与 lastReview 匹配的卡不会被移除。
   */
  reconcileExternalRate: (
    cardStateIds: string[],
    options?: {
      logIds?: string[];
      cardLogPairs?: Array<{ cardStateId: string; logId: string }>;
    },
  ) => void;
  flip: () => void;
  loadRatingPreviews: () => Promise<void>;
  rate: (rating: FsrsRating) => Promise<void>;
  undoLastReview: () => Promise<boolean>;
  updateCurrentCard: (
    front: string,
    back: string,
    template?: ReviewEditTemplate | null,
  ) => Promise<boolean>;
  suspendCurrent: () => Promise<boolean>;
  resumeLastSuspended: () => Promise<boolean>;
  endSession: () => void;
  resetFlip: () => void;
}

/** 完成态：队列非空且下标已越过末尾 */
export function isReviewSessionDone(state: Pick<FsrsReviewState, 'queue' | 'queueIndex' | 'loading'>): boolean {
  return !state.loading && state.queue.length > 0 && state.queueIndex >= state.queue.length;
}

/** 空队列：无卡可练（非完成态） */
export function isReviewSessionEmpty(state: Pick<FsrsReviewState, 'queue' | 'loading'>): boolean {
  return !state.loading && state.queue.length === 0;
}

/** 将间隔毫秒格式化为短文案：`<1m` / `10m` / `3d` / `1.2mo` */
export function formatInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) return '<1m';
  const minutes = intervalMs / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 10) {
    const rounded = Math.round(months * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}mo`;
  }
  return `${Math.round(months)}mo`;
}

function parseLaunchPayload(payload: unknown): FlashcardsLaunchPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload as FlashcardsLaunchPayload;
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((value): value is string => typeof value === 'string');
}

function parseStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function readAliasedValue(
  row: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): unknown {
  if (row[camelKey] !== undefined) return row[camelKey];
  return row[snakeKey];
}

function isPersistedId(value: string): boolean {
  const id = value.trim();
  return (
    id.length > 0 &&
    !id.startsWith('anki_synthetic_') &&
    !id.startsWith('chat-batch-')
  );
}

function hasReviewContent(
  card: Pick<ReviewCard, 'front' | 'back' | 'text' | 'extraFields'>,
): boolean {
  return (
    card.front.trim().length > 0 ||
    card.back.trim().length > 0 ||
    (typeof card.text === 'string' && card.text.trim().length > 0) ||
    Object.values(card.extraFields ?? {}).some((value) => value.trim().length > 0)
  );
}

function nextReviewableIndex(queue: ReviewCard[], start: number): number {
  let index = Math.max(0, start);
  while (index < queue.length && queue[index]?.suspended === true) index += 1;
  return index;
}

function matchesReviewChange(card: ReviewCard, change: FsrsAgentReviewStateChange): boolean {
  return card.id === change.cardStateId || card.ankiCardId === change.ankiCardId;
}

/** 解析 fsrs_get_due / enqueue states 行 → ReviewCard */
export function mapFsrsRow(row: Record<string, unknown>): ReviewCard | null {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!isPersistedId(id)) return null;
  const rawAnkiCardId = readAliasedValue(row, 'ankiCardId', 'anki_card_id');
  const ankiCardId = typeof rawAnkiCardId === 'string'
    ? rawAnkiCardId.trim()
    : undefined;
  const text = typeof row.text === 'string' ? row.text : '';
  const front = typeof row.front === 'string' ? row.front : '';
  const back = typeof row.back === 'string' ? row.back : '';
  const rawTemplateId = readAliasedValue(row, 'templateId', 'template_id');
  const templateId = typeof rawTemplateId === 'string'
    ? rawTemplateId.trim() || null
    : rawTemplateId === null
      ? null
      : undefined;
  const rawErrorContent = readAliasedValue(row, 'errorContent', 'error_content');
  const errorContent = typeof rawErrorContent === 'string'
    ? rawErrorContent
    : rawErrorContent === null
      ? null
      : undefined;
  const rawIsErrorCard = readAliasedValue(row, 'isErrorCard', 'is_error_card');
  const rawSuspended = row.suspended;
  const rawLastReviewMs = readAliasedValue(row, 'lastReviewMs', 'last_review_ms');
  let lastReviewMs: number | null | undefined;
  if (rawLastReviewMs === null) lastReviewMs = null;
  else if (typeof rawLastReviewMs === 'number' && Number.isFinite(rawLastReviewMs)) {
    lastReviewMs = rawLastReviewMs;
  } else if (typeof rawLastReviewMs === 'string' && rawLastReviewMs.trim()) {
    const parsed = Number(rawLastReviewMs);
    if (Number.isFinite(parsed)) lastReviewMs = parsed;
  }
  return {
    id,
    ankiCardId,
    front,
    back,
    ...(text ? { text } : {}),
    tags: parseStringArray(row.tags),
    images: parseStringArray(row.images),
    templateId,
    extraFields: parseStringRecord(readAliasedValue(row, 'extraFields', 'extra_fields')),
    ...(typeof rawIsErrorCard === 'boolean' ? { isErrorCard: rawIsErrorCard } : {}),
    errorContent,
    ...(typeof rawSuspended === 'boolean' ? { suspended: rawSuspended } : {}),
    ...(lastReviewMs !== undefined ? { lastReviewMs } : {}),
  };
}

function isDiagnosticReviewCard(card: ReviewCard): boolean {
  return card.isErrorCard === true;
}

const RECENT_LOCAL_LOG_LIMIT = 32;

function pushRecentLocalLogId(ids: string[], logId: string): string[] {
  const next = ids.filter((id) => id !== logId);
  next.push(logId);
  if (next.length > RECENT_LOCAL_LOG_LIMIT) {
    return next.slice(next.length - RECENT_LOCAL_LOG_LIMIT);
  }
  return next;
}

function mergeReviewContent(mapped: ReviewCard, content: ReviewCard | undefined): ReviewCard {
  if (!content || typeof content !== 'object') return mapped;
  const row = content as unknown as Record<string, unknown>;
  const next: ReviewCard = { ...mapped };
  if (typeof row.front === 'string' && row.front.trim()) next.front = row.front;
  if (typeof row.back === 'string' && row.back.trim()) next.back = row.back;
  if (typeof row.text === 'string') next.text = row.text;
  if (Array.isArray(row.tags)) next.tags = parseStringArray(row.tags);
  if (Array.isArray(row.images)) next.images = parseStringArray(row.images);

  const rawTemplateId = readAliasedValue(row, 'templateId', 'template_id');
  if (typeof rawTemplateId === 'string' || rawTemplateId === null) {
    next.templateId = typeof rawTemplateId === 'string'
      ? rawTemplateId.trim() || null
      : null;
  }
  const rawExtraFields = readAliasedValue(row, 'extraFields', 'extra_fields');
  if (rawExtraFields && typeof rawExtraFields === 'object' && !Array.isArray(rawExtraFields)) {
    next.extraFields = parseStringRecord(rawExtraFields);
  }
  const rawIsErrorCard = readAliasedValue(row, 'isErrorCard', 'is_error_card');
  if (typeof rawIsErrorCard === 'boolean') next.isErrorCard = rawIsErrorCard;
  const rawErrorContent = readAliasedValue(row, 'errorContent', 'error_content');
  if (typeof rawErrorContent === 'string') next.errorContent = rawErrorContent;
  else if (rawErrorContent === null) next.errorContent = null;
  return next;
}

function reviewContentAnkiId(card: ReviewCard): string {
  const row = card as unknown as Record<string, unknown>;
  const raw = readAliasedValue(row, 'ankiCardId', 'anki_card_id');
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return typeof row.id === 'string' ? row.id.trim() : '';
}

async function fetchDueFromBackend(): Promise<ReviewCard[]> {
  const result = await invoke<unknown>('fsrs_get_due', { limit: 50 });
  if (!Array.isArray(result)) {
    throw new Error(i18n.t('flashcards:today.errors.invalidResponse'));
  }
  const cards: ReviewCard[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const mapped = mapFsrsRow(item as Record<string, unknown>);
    if (mapped) cards.push(mapped);
  }
  return cards;
}

function parseDueTotalFromStats(result: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  const raw = row.due !== undefined ? row.due : row.due_count;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return null;
}

async function fetchDueTotalFromStats(): Promise<number | null> {
  try {
    const result = await invoke<unknown>('fsrs_get_stats');
    return parseDueTotalFromStats(result);
  } catch {
    return null;
  }
}

function readFiniteNumber(row: Record<string, unknown>, camelKey: string, snakeKey: string): number | null {
  const raw = readAliasedValue(row, camelKey, snakeKey);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseRatingPreviews(result: unknown): RatingPreviews | null {
  if (!result || typeof result !== 'object') return null;
  const root = result as Record<string, unknown>;
  const source =
    (root.previews && typeof root.previews === 'object' ? root.previews : null)
    ?? (root.intervals && typeof root.intervals === 'object' ? root.intervals : null)
    ?? root;

  const previews: RatingPreviews = {};
  const ingest = (rating: FsrsRating, row: Record<string, unknown>) => {
    const dueMs = readFiniteNumber(row, 'dueMs', 'due_ms');
    const scheduledDays = readFiniteNumber(row, 'scheduledDays', 'scheduled_days');
    let intervalMs = readFiniteNumber(row, 'intervalMs', 'interval_ms');
    if (intervalMs == null && dueMs != null) {
      intervalMs = Math.max(0, dueMs - Date.now());
    }
    if (dueMs == null || scheduledDays == null || intervalMs == null) return;
    previews[rating] = { dueMs, scheduledDays, intervalMs };
  };

  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const ratingRaw = readAliasedValue(row, 'rating', 'rating');
      const rating = typeof ratingRaw === 'number' ? ratingRaw : Number(ratingRaw);
      if (rating === 1 || rating === 2 || rating === 3 || rating === 4) {
        ingest(rating, row);
      }
    }
  } else if (source && typeof source === 'object') {
    for (const key of ['1', '2', '3', '4'] as const) {
      const rating = Number(key) as FsrsRating;
      const entry = (source as Record<string, unknown>)[key]
        ?? (source as Record<string, unknown>)[rating];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        ingest(rating, entry as Record<string, unknown>);
      }
    }
  }

  return Object.keys(previews).length > 0 ? previews : null;
}

/**
 * 批次入口：先 enqueue（anki_card_id → fsrs state），再用返回的 state.id 作为评分 id。
 * 内容优先用调用方传入的 cards，否则使用后端联表返回的正文。
 */
async function enqueueBatchForReview(
  ankiCardIds: string[],
  contentByAnkiId?: Map<string, ReviewCard>,
): Promise<ReviewCard[]> {
  if (ankiCardIds.length === 0) return [];
  const result = await invoke<unknown>('fsrs_enqueue_cards', { ankiCardIds });
  if (!result || typeof result !== 'object') {
    throw new Error(i18n.t('flashcards:session.errors.invalidEnqueueResponse'));
  }
  const response = result as { states?: unknown; reviewCards?: unknown };
  const stateRows = Array.isArray(response.states)
    ? response.states as Array<Record<string, unknown>>
    : null;
  const reviewRows = Array.isArray(response.reviewCards)
    ? response.reviewCards as Array<Record<string, unknown>>
    : null;
  const states = reviewRows ?? stateRows;
  if (!states) {
    throw new Error(i18n.t('flashcards:session.errors.invalidEnqueueResponse'));
  }
  if (states.length === 0) {
    throw new Error(i18n.t('flashcards:session.errors.emptyEnqueueResponse'));
  }

  // reviewCards carries display content while states remains authoritative for
  // scheduling flags such as suspension. Merge by state ID when both exist.
  const schedulingByStateId = new Map<string, Record<string, unknown>>();
  for (const row of stateRows ?? []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.id === 'string' && row.id.trim()) {
      schedulingByStateId.set(row.id.trim(), row);
    }
  }

  const requestedIds = new Set(ankiCardIds);
  const returnedIds = new Set<string>();
  const cards: ReviewCard[] = [];
  for (const row of states) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(i18n.t('flashcards:session.errors.invalidReviewState'));
    }
    const stateId = typeof row.id === 'string' ? row.id.trim() : '';
    const scheduling = schedulingByStateId.get(stateId);
    const mapped = mapFsrsRow(
      scheduling && typeof scheduling.suspended === 'boolean'
        ? { ...row, suspended: scheduling.suspended }
        : row,
    );
    if (!mapped || !mapped.ankiCardId || !isPersistedId(mapped.ankiCardId)) {
      throw new Error(i18n.t('flashcards:session.errors.invalidReviewState'));
    }
    if (!requestedIds.has(mapped.ankiCardId) || returnedIds.has(mapped.ankiCardId)) {
      throw new Error(i18n.t('flashcards:session.errors.mismatchedReviewStates'));
    }
    const content = contentByAnkiId?.get(mapped.ankiCardId);
    const card = mergeReviewContent(mapped, content);
    if (!hasReviewContent(card)) {
      throw new Error(i18n.t('flashcards:session.errors.reviewContentUnavailable', {
        cardId: mapped.ankiCardId,
      }));
    }
    returnedIds.add(mapped.ankiCardId);
    cards.push(card);
  }
  if (returnedIds.size !== requestedIds.size) {
    throw new Error(i18n.t('flashcards:session.errors.incompleteEnqueueResponse'));
  }
  return cards;
}

function structuredErrorCode(error: unknown): string | null {
  let payload = error;
  const serialized = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : null;
  if (serialized) {
    try {
      payload = JSON.parse(serialized) as unknown;
    } catch {
      // Plain backend messages continue through the existing fallback path.
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const details = (payload as Record<string, unknown>).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as Record<string, unknown>).errorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (structuredErrorCode(error) === FSRS_DIAGNOSTIC_CARD_NOT_REVIEWABLE) {
    return i18n.t('flashcards:session.errors.diagnosticCardNotReviewable');
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

export const useFsrsReviewStore = create<FsrsReviewState>((set, get) => ({
  screen: 'today',
  dueCards: [],
  dueTotal: 0,
  queue: [],
  queueIndex: 0,
  flipped: false,
  loading: false,
  ratingBusy: false,
  error: null,
  errorKind: null,
  lastRated: null,
  lastReview: null,
  lastSuspended: null,
  retryBatchRequest: null,
  sessionRatedCount: 0,
  sessionAgainCount: 0,
  remainingDueAfterSession: null,
  ratingPreviews: null,
  lastSchedule: null,
  recentLocalLogIds: [],
  pendingExternalRateIds: [],
  statsFetchGen: 0,

  setScreen: (screen) => set({ screen }),

  applyLaunchPayload: (payload) => {
    const parsed = parseLaunchPayload(payload);
    if (!parsed) return;
    if (parsed.screen === 'session' && parsed.mode === 'batch' && Array.isArray(parsed.cardIds)) {
      void get().startBatchSession(
        parsed.cardIds,
        Array.isArray(parsed.cards) ? parsed.cards : undefined,
      );
      return;
    }
    if (parsed.screen === 'session' && parsed.mode === 'due') {
      void get()
        .loadDue()
        .then((loaded) => {
          if (loaded) get().startDueSession();
        });
      return;
    }
    if (parsed.screen && parsed.screen !== 'session') {
      set({ screen: parsed.screen });
    }
  },

  loadDue: async () => {
    const previousDueTotal = get().dueTotal;
    set({ loading: true, error: null, errorKind: null });
    try {
      const [fromBackend, dueTotal] = await Promise.all([
        fetchDueFromBackend(),
        fetchDueTotalFromStats(),
      ]);
      // stats 失败时：若本批打满上限，保留上次诚实总数，避免把 50 当成「刚好 50」。
      let resolvedTotal = dueTotal ?? fromBackend.length;
      if (
        dueTotal == null
        && fromBackend.length >= 50
        && previousDueTotal > fromBackend.length
      ) {
        resolvedTotal = previousDueTotal;
      }
      set({
        dueCards: fromBackend,
        dueTotal: resolvedTotal,
        loading: false,
      });
      return true;
    } catch (error) {
      set({
        dueCards: [],
        dueTotal: 0,
        loading: false,
        error: errorMessage(error, i18n.t('flashcards:today.loadFailed')),
        errorKind: 'prepare',
      });
      return false;
    }
  },

  startDueSession: () => {
    const { dueCards, error } = get();
    if (error) return;
    if (dueCards.length === 0) {
      // 无到期卡时不要进入假完成会话
      set({
        screen: 'today',
        queue: [],
        queueIndex: 0,
        flipped: false,
        lastRated: null,
        lastReview: null,
        lastSuspended: null,
        sessionRatedCount: 0,
        sessionAgainCount: 0,
        remainingDueAfterSession: null,
        ratingPreviews: null,
        lastSchedule: null,
        pendingExternalRateIds: [],
        error: null,
        errorKind: null,
        retryBatchRequest: null,
      });
      return;
    }
    set({
      queue: dueCards,
      queueIndex: nextReviewableIndex(dueCards, 0),
      flipped: false,
      lastRated: null,
      lastReview: null,
      lastSuspended: null,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
      remainingDueAfterSession: null,
      ratingPreviews: null,
      lastSchedule: null,
      pendingExternalRateIds: [],
      screen: 'session',
      error: null,
      errorKind: null,
      retryBatchRequest: null,
    });
  },

  startBatchSession: async (cardIds, cards) => {
    const ankiIds = [
      ...new Set(
        cardIds
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim()),
      ),
    ];
    const request: BatchReviewRequest = {
      cardIds: [...ankiIds],
      ...(cards && cards.length > 0 ? { cards: [...cards] } : {}),
    };
    set({
      loading: true,
      error: null,
      errorKind: null,
      screen: 'session',
      queue: [],
      queueIndex: 0,
      flipped: false,
      lastReview: null,
      lastSuspended: null,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
      remainingDueAfterSession: null,
      ratingPreviews: null,
      lastSchedule: null,
      pendingExternalRateIds: [],
      retryBatchRequest: request,
    });

    try {
      if (ankiIds.length === 0) {
        throw new Error(i18n.t('flashcards:session.errors.noValidCardIds'));
      }
      if (ankiIds.some((id) => !isPersistedId(id))) {
        throw new Error(i18n.t('flashcards:session.errors.persistedCardIdsOnly'));
      }
      const contentByAnkiId =
        cards && cards.length > 0
          ? new Map(
              cards.map((card) => [reviewContentAnkiId(card), card] as const),
            )
          : undefined;

      const enqueued = await enqueueBatchForReview(ankiIds, contentByAnkiId);
      set({
        queue: enqueued,
        queueIndex: nextReviewableIndex(enqueued, 0),
        flipped: false,
        lastRated: null,
        lastReview: null,
        lastSuspended: null,
        sessionRatedCount: 0,
        sessionAgainCount: 0,
        remainingDueAfterSession: null,
        ratingPreviews: null,
        lastSchedule: null,
        loading: false,
        error: null,
        errorKind: null,
        retryBatchRequest: null,
      });
      return true;
    } catch (error) {
      set({
        queue: [],
        queueIndex: 0,
        flipped: false,
        loading: false,
        error: errorMessage(error, i18n.t('flashcards:session.prepareFailed')),
        errorKind: 'prepare',
        retryBatchRequest: request,
      });
      return false;
    }
  },

  retryBatchSession: async () => {
    const request = get().retryBatchRequest;
    if (!request) return;
    await get().startBatchSession(request.cardIds, request.cards);
  },

  /**
   * ACR R1-15：session 中 append-only 入队（铁律：不重置活动卡 / flipped）。
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
      if (isDiagnosticReviewCard(card)) continue;
      if (existing.has(card.id)) continue;
      existing.add(card.id);
      toAdd.push(card);
    }
    if (toAdd.length === 0) return 0;

    const queue = [...state.queue, ...toAdd];
    set({
      queue,
      // A completed session has no current card to preserve. If newly appended
      // cards begin with suspended rows, advance to the first reviewable row.
      queueIndex: state.queueIndex >= state.queue.length
        ? nextReviewableIndex(queue, state.queueIndex)
        : state.queueIndex,
    });
    return toAdd.length;
  },

  reconcileAgentReviewChange: (action, changes) => {
    if (changes.length === 0) return;
    set((state) => {
      if (state.screen !== 'session') return state;

      const affected = state.queue
        .map((card, index) => {
          const change = changes.find((item) => matchesReviewChange(card, item));
          return change ? { card, change, index } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (affected.length === 0) return state;

      const queue = state.queue.map((card) => {
        const change = changes.find((item) => matchesReviewChange(card, item));
        return change ? { ...card, suspended: change.suspended } : card;
      });
      let queueIndex = state.queueIndex;
      let flipped = state.flipped;
      let lastRated = state.lastRated;
      let lastReview = state.lastReview;
      let lastSuspended = state.lastSuspended;

      for (const { card, change, index } of affected) {
        const wasSuspended = card.suspended === true;
        const affectsLastReview = lastReview?.cardStateId === change.cardStateId;
        const affectsLastSuspended = lastSuspended?.cardStateId === change.cardStateId;

        if (action === 'undo_last_review') {
          if (!change.suspended && index <= queueIndex) {
            queueIndex = Math.min(queueIndex, index);
            flipped = false;
            lastRated = null;
          }
          if (affectsLastReview) {
            lastReview = null;
            lastRated = null;
          }
          continue;
        }

        if (affectsLastReview) {
          lastReview = null;
          lastRated = null;
        }
        if (change.suspended) {
          if (index === queueIndex) {
            queueIndex = nextReviewableIndex(queue, index + 1);
            flipped = false;
            lastRated = null;
            lastSuspended = { cardStateId: change.cardStateId, queueIndex: index };
          }
        } else {
          if (affectsLastSuspended) lastSuspended = null;
          const isDue = typeof change.dueMs !== 'number' || change.dueMs <= Date.now();
          if (wasSuspended && isDue && index < queueIndex) {
            queueIndex = index;
            flipped = false;
            lastRated = null;
          }
        }
      }

      queueIndex = nextReviewableIndex(queue, queueIndex);
      return {
        queue,
        queueIndex,
        flipped,
        lastRated,
        lastReview,
        lastSuspended,
      };
    });
  },

  reconcileAgentCardContent: (cards) => {
    if (cards.length === 0) return;
    const byAnkiCardId = new Map(
      cards
        .filter((card) => typeof card.ankiCardId === 'string' && card.ankiCardId.trim().length > 0)
        .map((card) => [card.ankiCardId!.trim(), card] as const),
    );
    if (byAnkiCardId.size === 0) return;
    set((state) => {
      if (state.screen !== 'session') return state;
      let changed = false;
      const queue = state.queue.map((card) => {
        const update = card.ankiCardId ? byAnkiCardId.get(card.ankiCardId) : undefined;
        if (!update) return card;
        changed = true;
        return {
          ...card,
          front: update.front,
          back: update.back,
          text: update.text,
          tags: update.tags,
          images: update.images,
          templateId: update.templateId,
          extraFields: update.extraFields,
          isErrorCard: update.isErrorCard,
          errorContent: update.errorContent,
        };
      });
      return changed ? { queue } : state;
    });
  },

  reconcileExternalRate: (cardStateIds, options) => {
    const idSet = new Set(
      cardStateIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim()),
    );
    if (idSet.size === 0) return;

    const localLogIds = new Set(get().recentLocalLogIds);
    // 本窗 log 回声：按 logId↔card 配对忽略（含 lastReview 已切换后的延迟回声）。
    for (const pair of options?.cardLogPairs ?? []) {
      if (
        typeof pair?.cardStateId === 'string'
        && typeof pair?.logId === 'string'
        && localLogIds.has(pair.logId)
      ) {
        idSet.delete(pair.cardStateId.trim());
      }
    }
    const last = get().lastReview;
    if (last && idSet.has(last.cardStateId) && localLogIds.has(last.logId)) {
      idSet.delete(last.cardStateId);
    }
    if (idSet.size === 0) return;

    const busy = get().ratingBusy;
    if (busy) {
      const current = get().queue[get().queueIndex];
      const deferred: string[] = [];
      for (const id of idSet) {
        if (current && id === current.id) {
          deferred.push(id);
          idSet.delete(id);
        }
      }
      if (deferred.length > 0) {
        set((state) => ({
          pendingExternalRateIds: Array.from(
            new Set([...state.pendingExternalRateIds, ...deferred]),
          ),
        }));
      }
      if (idSet.size === 0) return;
    }

    set((state) => {
      if (state.screen !== 'session') return state;

      let removedBefore = 0;
      let removedCurrent = false;
      const queue = state.queue.filter((card, index) => {
        if (!idSet.has(card.id)) return true;
        if (index < state.queueIndex) removedBefore += 1;
        if (index === state.queueIndex) removedCurrent = true;
        return false;
      });
      if (queue.length === state.queue.length) return state;

      let queueIndex = Math.max(0, state.queueIndex - removedBefore);
      let flipped = state.flipped;
      let lastRated = state.lastRated;
      let lastReview = state.lastReview;
      let ratingPreviews = state.ratingPreviews;
      if (removedCurrent) {
        flipped = false;
        lastRated = null;
        ratingPreviews = null;
        if (lastReview && idSet.has(lastReview.cardStateId)) {
          lastReview = null;
        }
      }
      queueIndex = nextReviewableIndex(queue, queueIndex);
      const sessionDone = queue.length > 0 && queueIndex >= queue.length;
      return {
        queue,
        queueIndex,
        flipped,
        lastRated,
        lastReview,
        ratingPreviews,
        remainingDueAfterSession: sessionDone
          ? Math.max(0, state.dueTotal - state.sessionRatedCount)
          : state.remainingDueAfterSession,
      };
    });

    const latest = get();
    if (
      latest.screen === 'session'
      && latest.queue.length > 0
      && latest.queueIndex >= latest.queue.length
    ) {
      const gen = latest.statsFetchGen + 1;
      set({ statsFetchGen: gen });
      void fetchDueTotalFromStats().then((total) => {
        if (total == null) return;
        const live = get();
        if (
          live.statsFetchGen !== gen
          || live.screen !== 'session'
          || live.queue.length === 0
          || live.queueIndex < live.queue.length
        ) {
          return;
        }
        set({ remainingDueAfterSession: total, dueTotal: total });
      });
    }
  },

  flip: () => {
    const nextFlipped = !get().flipped;
    if (!nextFlipped) {
      set({ flipped: false, ratingPreviews: null });
      return;
    }
    set({ flipped: true });
    void get().loadRatingPreviews();
  },

  loadRatingPreviews: async () => {
    const { queue, queueIndex } = get();
    const current = queue[queueIndex];
    if (!current) {
      set({ ratingPreviews: null });
      return;
    }
    try {
      const result = await invoke<unknown>('fsrs_preview_intervals', {
        cardStateId: current.id,
      });
      const previews = parseRatingPreviews(result);
      // 若已翻回正面或切到其他卡，丢弃过期结果
      const latest = get();
      if (!latest.flipped || latest.queue[latest.queueIndex]?.id !== current.id) return;
      set({ ratingPreviews: previews });
    } catch {
      const latest = get();
      if (!latest.flipped || latest.queue[latest.queueIndex]?.id !== current.id) return;
      set({ ratingPreviews: null });
    }
  },

  rate: async (rating) => {
    const { queue, queueIndex, ratingBusy, flipped } = get();
    if (ratingBusy || !flipped) return;
    const current = queue[queueIndex];
    if (!current) return;

    const queueSnapshot = queue.map((card) => ({ ...card }));
    set({ ratingBusy: true, lastRated: rating, error: null, errorKind: null });

    try {
      const clientOpId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : (() => {
              // 无 randomUUID 时仍生成合规 UUID，保证后端幂等生效
              const bytes = new Uint8Array(16);
              for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
              bytes[6] = (bytes[6] & 0x0f) | 0x40;
              bytes[8] = (bytes[8] & 0x3f) | 0x80;
              const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
              return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            })();
      const result = await invoke<unknown>('fsrs_rate', {
        cardStateId: current.id,
        rating,
        clientOpId,
        enforceExpectedLastReview: current.lastReviewMs !== undefined,
        expectedLastReviewMs:
          current.lastReviewMs === undefined ? null : current.lastReviewMs,
      });
      if (!result || typeof result !== 'object') {
        throw new Error(i18n.t('flashcards:session.errors.invalidRateResponse'));
      }
      const row = result as Record<string, unknown>;
      const rawLogId = readAliasedValue(row, 'logId', 'log_id');
      const logId = typeof rawLogId === 'string' ? rawLogId.trim() : '';
      if (!logId) {
        throw new Error(i18n.t('flashcards:session.errors.invalidRateLogId'));
      }
      const dueMs = readFiniteNumber(row, 'dueMs', 'due_ms');
      const scheduledDays = readFiniteNumber(row, 'scheduledDays', 'scheduled_days');
      const cardState = row.cardState ?? row.card_state;
      const ratedLastReviewMs = cardState && typeof cardState === 'object'
        ? readFiniteNumber(cardState as Record<string, unknown>, 'lastReviewMs', 'last_review_ms')
        : null;
      const now = Date.now();
      // Never show a learning card before the interval presented to the user.
      // Cards scheduled in the future return through the next due refresh.
      const shouldRequeue = dueMs != null && dueMs <= now;

      // 队列耗尽时保持 screen=session，让 ReviewSessionScreen 展示完成态；
      // 不直接跳回 today（由用户点「返回今日」/退出）。
      // 不在此处 loadDue：其 loading 会盖住完成态；返回今日时 TodayScreen 会自行刷新。
      set((state) => {
        const liveIndex = state.queue.findIndex((card) => card.id === current.id);
        const baseIndex = liveIndex >= 0 ? liveIndex : state.queueIndex;
        let nextQueue = state.queue;
        let nextIndex: number;

        if (shouldRequeue && liveIndex >= 0) {
          nextQueue = [...state.queue];
          const [moved] = nextQueue.splice(liveIndex, 1);
          if (moved) {
            nextQueue.push({
              ...moved,
              lastReviewMs: ratedLastReviewMs ?? moved.lastReviewMs ?? null,
            });
          }
          nextIndex = nextReviewableIndex(nextQueue, liveIndex);
        } else {
          nextQueue = state.queue.map((card, index) => (
            index === liveIndex && ratedLastReviewMs != null
              ? { ...card, lastReviewMs: ratedLastReviewMs }
              : card
          ));
          nextIndex = nextReviewableIndex(nextQueue, baseIndex + 1);
        }

        const sessionRatedCount = state.sessionRatedCount + 1;
        const sessionAgainCount =
          rating === 1 ? state.sessionAgainCount + 1 : state.sessionAgainCount;
        const sessionDone = nextIndex >= nextQueue.length && nextQueue.length > 0;
        // 先用粗估；下方再以 fsrs_get_stats.due 校正，避免学习回插导致虚高剩余。
        const remainingDueAfterSession = sessionDone
          ? Math.max(0, state.dueTotal - sessionRatedCount)
          : state.remainingDueAfterSession;

        return {
          queue: nextQueue,
          queueIndex: nextIndex,
          ratingBusy: false,
          flipped: false,
          ratingPreviews: null,
          lastRated: null,
          lastReview: {
            logId,
            cardStateId: current.id,
            queueIndex: baseIndex,
            queueSnapshot,
            rating,
          },
          lastSuspended: null,
          lastSchedule:
            dueMs != null && scheduledDays != null
              ? { dueMs, scheduledDays }
              : null,
          sessionRatedCount,
          sessionAgainCount,
          remainingDueAfterSession,
          recentLocalLogIds: pushRecentLocalLogId(state.recentLocalLogIds, logId),
        };
      });
      requestFlashcardsDueRefresh();

      const pending = get().pendingExternalRateIds;
      if (pending.length > 0) {
        set({ pendingExternalRateIds: [] });
        get().reconcileExternalRate(pending);
      }

      const afterRate = get();
      if (
        afterRate.queue.length > 0
        && afterRate.queueIndex >= afterRate.queue.length
      ) {
        const gen = afterRate.statsFetchGen + 1;
        set({ statsFetchGen: gen });
        void fetchDueTotalFromStats().then((total) => {
          if (total == null) return;
          const live = get();
          if (
            live.statsFetchGen !== gen
            || live.screen !== 'session'
            || live.queue.length === 0
            || live.queueIndex < live.queue.length
          ) {
            return;
          }
          set({ remainingDueAfterSession: total, dueTotal: total });
        });
      }
    } catch (err) {
      set({
        ratingBusy: false,
        error: errorMessage(err, i18n.t('flashcards:session.errors.rateFailed')),
        errorKind: 'rate',
      });
      const pending = get().pendingExternalRateIds;
      if (pending.length > 0) {
        set({ pendingExternalRateIds: [] });
        get().reconcileExternalRate(pending);
      }
    }
  },

  undoLastReview: async () => {
    const { lastReview, ratingBusy } = get();
    if (!lastReview || ratingBusy) return false;

    set({ ratingBusy: true, error: null, errorKind: null });
    try {
      const result = await invoke<unknown>('fsrs_undo_last_review', {
        expectedLogId: lastReview.logId,
        cardStateId: lastReview.cardStateId,
      });
      if (!result || typeof result !== 'object') {
        throw new Error(i18n.t('flashcards:session.errors.invalidUndoResponse'));
      }
      const row = result as Record<string, unknown>;
      const rawUndoneLogId = readAliasedValue(row, 'undoneLogId', 'undone_log_id');
      const state = row.state;
      const stateId = state && typeof state === 'object'
        ? (state as Record<string, unknown>).id
        : undefined;
      if (
        row.changed !== true ||
        rawUndoneLogId !== lastReview.logId ||
        stateId !== lastReview.cardStateId
      ) {
        throw new Error(i18n.t('flashcards:session.errors.mismatchedUndoResponse'));
      }
      const restoredState = state && typeof state === 'object'
        ? state as Record<string, unknown>
        : null;
      const restoredLastReviewMs = restoredState
        ? (() => {
            const raw = readAliasedValue(restoredState, 'lastReviewMs', 'last_review_ms');
            if (raw === null) return null;
            if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
            return undefined;
          })()
        : undefined;
      set((s) => {
        const snapshot = Array.isArray(lastReview.queueSnapshot)
          && lastReview.queueSnapshot.length > 0
          ? lastReview.queueSnapshot.map((card) => (
              card.id === lastReview.cardStateId && restoredLastReviewMs !== undefined
                ? { ...card, lastReviewMs: restoredLastReviewMs }
                : { ...card }
            ))
          : s.queue;
        const queueIndex = Math.min(
          Math.max(0, lastReview.queueIndex),
          Math.max(0, snapshot.length - 1),
        );
        return {
          queue: snapshot,
          queueIndex,
          flipped: false,
          ratingBusy: false,
          lastRated: null,
          lastReview: null,
          lastSchedule: null,
          remainingDueAfterSession: null,
          ratingPreviews: null,
          sessionRatedCount: Math.max(0, s.sessionRatedCount - 1),
          sessionAgainCount:
            lastReview.rating === 1
              ? Math.max(0, s.sessionAgainCount - 1)
              : s.sessionAgainCount,
          error: null,
          errorKind: null,
        };
      });
      requestFlashcardsDueRefresh();
      return true;
    } catch (error) {
      set({
        ratingBusy: false,
        error: errorMessage(error, i18n.t('flashcards:session.errors.undoFailed')),
        errorKind: 'undo',
      });
      return false;
    }
  },

  updateCurrentCard: async (front, back, template) => {
    const { queue, queueIndex, ratingBusy } = get();
    if (ratingBusy) return false;
    const current = queue[queueIndex];
    if (!current?.ankiCardId || !isPersistedId(current.ankiCardId)) {
      set({
        error: i18n.t('flashcards:session.errors.missingAnkiId'),
        errorKind: 'edit',
      });
      return false;
    }
    const isCloze = isClozeReviewCard(current, template);
    if (!front.trim() || (!isCloze && !back.trim())) {
      set({
        error: i18n.t('flashcards:session.errors.emptyBasicFields'),
        errorKind: 'edit',
      });
      return false;
    }
    if (isCloze && !hasValidCloze(front)) {
      set({
        error: i18n.t('flashcards:session.invalidClozeEdit'),
        errorKind: 'edit',
      });
      return false;
    }

    const edit = applyReviewCardEdit(current, { front, back }, template);
    const payload: AnkiCard = {
      id: current.ankiCardId,
      front: edit.front,
      back: edit.back,
      text: edit.text,
      tags: [...(current.tags ?? [])],
      images: [...(current.images ?? [])],
      extra_fields: edit.extraFields,
      template_id: current.templateId ?? null,
      is_error_card: current.isErrorCard ?? false,
      error_content: current.errorContent ?? null,
    };

    set({ ratingBusy: true, error: null, errorKind: null });
    try {
      await invoke('update_anki_card', { card: payload });
      const updated: ReviewCard = {
        ...current,
        front: edit.front,
        back: edit.back,
        text: edit.text,
        extraFields: edit.extraFields,
      };
      set((state) => ({
        queue: state.queue.map((card, index) => index === queueIndex ? updated : card),
        dueCards: state.dueCards.map((card) => (
          card.id === current.id || card.ankiCardId === current.ankiCardId ? updated : card
        )),
        ratingBusy: false,
        error: null,
        errorKind: null,
      }));
      return true;
    } catch (error) {
      set({
        ratingBusy: false,
        error: errorMessage(error, i18n.t('flashcards:session.errors.saveFailed')),
        errorKind: 'edit',
      });
      return false;
    }
  },

  suspendCurrent: async () => {
    const { queue, queueIndex, ratingBusy } = get();
    if (ratingBusy) return false;
    const current = queue[queueIndex];
    if (!current) return false;

    set({ ratingBusy: true, error: null, errorKind: null });
    try {
      const result = await invoke<unknown>('fsrs_suspend_card', {
        cardStateId: current.id,
      });
      if (!result || typeof result !== 'object') {
        throw new Error(i18n.t('flashcards:session.errors.invalidSuspendResponse'));
      }
      const resultRow = result as Record<string, unknown>;
      const state = resultRow.state;
      const stateId = state && typeof state === 'object'
        ? (state as Record<string, unknown>).id
        : undefined;
      if (stateId !== current.id || typeof resultRow.changed !== 'boolean') {
        throw new Error(i18n.t('flashcards:session.errors.mismatchedSuspendResponse'));
      }
      set((state) => {
        const queue = state.queue.map((card, index) => (
          index === queueIndex ? { ...card, suspended: true } : card
        ));
        return {
          queue,
          queueIndex: nextReviewableIndex(queue, queueIndex + 1),
          flipped: false,
          ratingBusy: false,
          lastRated: null,
          lastSuspended: resultRow.changed
            ? { cardStateId: current.id, queueIndex }
            : null,
          error: null,
          errorKind: null,
        };
      });
      requestFlashcardsDueRefresh();
      return true;
    } catch (error) {
      set({
        ratingBusy: false,
        error: errorMessage(error, i18n.t('flashcards:session.errors.suspendFailed')),
        errorKind: 'suspend',
      });
      return false;
    }
  },

  resumeLastSuspended: async () => {
    const { lastSuspended, ratingBusy } = get();
    if (!lastSuspended || ratingBusy) return false;

    set({ ratingBusy: true, error: null, errorKind: null });
    try {
      const result = await invoke<unknown>('fsrs_unsuspend_card', {
        cardStateId: lastSuspended.cardStateId,
      });
      if (!result || typeof result !== 'object') {
        throw new Error(i18n.t('flashcards:session.errors.invalidResumeResponse'));
      }
      const resultRow = result as Record<string, unknown>;
      const state = resultRow.state;
      const stateId = state && typeof state === 'object'
        ? (state as Record<string, unknown>).id
        : undefined;
      if (stateId !== lastSuspended.cardStateId || typeof resultRow.changed !== 'boolean') {
        throw new Error(i18n.t('flashcards:session.errors.mismatchedResumeResponse'));
      }
      set((state) => ({
        queue: state.queue.map((card) => (
          card.id === lastSuspended.cardStateId ? { ...card, suspended: false } : card
        )),
        queueIndex: lastSuspended.queueIndex,
        flipped: false,
        ratingBusy: false,
        lastSuspended: null,
        error: null,
        errorKind: null,
      }));
      requestFlashcardsDueRefresh();
      return true;
    } catch (error) {
      set({
        ratingBusy: false,
        error: errorMessage(error, i18n.t('flashcards:session.errors.resumeFailed')),
        errorKind: 'resume',
      });
      return false;
    }
  },

  endSession: () => {
    set({
      screen: 'today',
      flipped: false,
      lastRated: null,
      ratingBusy: false,
      loading: false,
      error: null,
      errorKind: null,
      lastReview: null,
      lastSuspended: null,
      retryBatchRequest: null,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
      remainingDueAfterSession: null,
      ratingPreviews: null,
      lastSchedule: null,
    });
    requestFlashcardsDueRefresh();
  },

  resetFlip: () => set({ flipped: false, ratingPreviews: null }),
}));
