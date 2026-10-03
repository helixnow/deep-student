/**
 * 闪卡记忆曲线：FSRS 遗忘曲线的取样、坐标轴与后端响应解析。
 *
 * 曲线常数随数据从后端下发，与调度器（rs-fsrs `Parameters::forgetting_curve`）同源：
 * R(t, S) = (1 + factor · t / S)^decay，t 以天计，t = S 时 R = 90%。
 * 单卡历史的画法与 Anki 卡片信息页的遗忘曲线一致：每次复习 R 回到 100%，
 * 之后按该次复习后的稳定性衰减；最后一段越过「此刻」的部分是预测。
 */
import { invoke } from '@tauri-apps/api/core';

export const MS_PER_DAY = 86_400_000;
const MINUTE = 1 / 1440;
const HOUR = 1 / 24;

export interface ForgettingCurve {
  decay: number;
  factor: number;
}

/** FSRS-4.5 / FSRS-5 的固定常数，后端未下发时回退 */
export const FSRS5_CURVE: ForgettingCurve = { decay: -0.5, factor: 19 / 81 };

export type MemoryRating = 1 | 2 | 3 | 4;

export interface MemoryCard {
  cardStateId: string;
  ankiCardId: string;
  front: string;
  text: string | null;
  extraFields: Record<string, string>;
  state: number;
  stability: number | null;
  difficulty: number | null;
  lastReviewMs: number | null;
  dueMs: number;
  reps: number;
  lapses: number;
  lastRating: MemoryRating | null;
}

export interface TrueRetention {
  windowDays: number;
  reviews: number;
  passed: number;
}

export interface MemoryOverview {
  generatedAtMs: number;
  desiredRetention: number;
  curve: ForgettingCurve;
  recent: MemoryCard[];
  memorizedCount: number;
  averageRetrievability: number | null;
  trueRetention: TrueRetention;
}

export interface MemoryReview {
  logId: string;
  reviewMs: number;
  rating: MemoryRating;
  stateBefore: number;
  stateAfter: number;
  stabilityAfter: number | null;
  difficultyAfter: number | null;
  dueAfterMs: number | null;
}

export interface CardMemoryHistory {
  generatedAtMs: number;
  desiredRetention: number;
  curve: ForgettingCurve;
  card: MemoryCard;
  reviews: MemoryReview[];
}

// ---------------------------------------------------------------------------
// 遗忘曲线
// ---------------------------------------------------------------------------

export function retrievability(elapsedDays: number, stability: number, curve: ForgettingCurve = FSRS5_CURVE): number {
  if (!(stability > 0)) return 0;
  return (1 + (curve.factor * Math.max(0, elapsedDays)) / stability) ** curve.decay;
}

/** 保持率跌到 target 时距上次复习的天数（retrievability 的反函数） */
export function daysUntilRetention(target: number, stability: number, curve: ForgettingCurve = FSRS5_CURVE): number {
  if (!(stability > 0) || !(target > 0 && target < 1)) return Number.NaN;
  return (stability / curve.factor) * (target ** (1 / curve.decay) - 1);
}

/** 学习中 / 重新学习：下次复习是学习步，不是保持率跌到期望值的那一刻 */
export function isLearningState(state: number): boolean {
  return state === 1 || state === 3;
}

// ---------------------------------------------------------------------------
// 「最近复习」视图：横轴 = 距上次复习（对数），各卡从 100% 起对齐比较
// ---------------------------------------------------------------------------

export type TickUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface TimeTick {
  days: number;
  unit: TickUnit;
  count: number;
}

const LOG_TICKS: TimeTick[] = [
  { days: MINUTE, unit: 'minute', count: 1 },
  { days: 10 * MINUTE, unit: 'minute', count: 10 },
  { days: HOUR, unit: 'hour', count: 1 },
  { days: 1, unit: 'day', count: 1 },
  { days: 7, unit: 'week', count: 1 },
  { days: 30, unit: 'month', count: 1 },
  { days: 90, unit: 'month', count: 3 },
  { days: 365, unit: 'year', count: 1 },
  { days: 365 * 3, unit: 'year', count: 3 },
  { days: 3650, unit: 'year', count: 10 },
];

export interface RecentRange {
  minDays: number;
  maxDays: number;
  ticks: TimeTick[];
}

/**
 * 横轴起点取「最早需要看见的时刻」（学习步 / 此刻）向下取整到 1 分钟 / 10 分钟 / 1 小时；
 * 终点至少 1 个月，并留出最远到期点与稳定性的 1.6 倍，让每条曲线都能越过 90% 那条线。
 */
export function recentRange(cards: MemoryCard[], nowMs: number): RecentRange {
  let near = Infinity;
  let far = 0;
  for (const card of cards) {
    if (card.lastReviewMs == null) continue;
    const due = (card.dueMs - card.lastReviewMs) / MS_PER_DAY;
    const now = (nowMs - card.lastReviewMs) / MS_PER_DAY;
    for (const offset of [due, now]) {
      if (offset > 0) near = Math.min(near, offset);
    }
    far = Math.max(far, due, now, card.stability ?? 0);
  }
  const minDays = [HOUR, 10 * MINUTE, MINUTE].find((d) => d <= near) ?? MINUTE;
  const target = Math.max(30, far * 1.6);
  const maxDays = LOG_TICKS.find((tick) => tick.days >= target)?.days ?? LOG_TICKS[LOG_TICKS.length - 1].days;
  return {
    minDays,
    maxDays,
    ticks: LOG_TICKS.filter((tick) => tick.days >= minDays - 1e-9 && tick.days <= maxDays + 1e-9),
  };
}

/** 纵轴下限：最低那条曲线在横轴终点的保持率向下取整到 10%，夹在 40%–80% */
export function recentFloor(cards: MemoryCard[], maxDays: number, curve: ForgettingCurve): number {
  let lowest = 1;
  for (const card of cards) {
    if (card.stability && card.stability > 0) lowest = Math.min(lowest, retrievability(maxDays, card.stability, curve));
  }
  return Math.min(0.8, Math.max(0.4, Math.floor(lowest * 10) / 10));
}

export interface CurvePoint {
  days: number;
  r: number;
}

/** 在对数时间上均匀取样；`extra` 里的时刻（此刻、到期点）精确插入，曲线经过标记点 */
export function sampleLogCurve(
  stability: number,
  curve: ForgettingCurve,
  minDays: number,
  maxDays: number,
  extra: number[] = [],
  samples = 96,
): CurvePoint[] {
  const ratio = Math.log(maxDays / minDays);
  const days = new Set<number>();
  for (let i = 0; i <= samples; i += 1) days.add(minDays * Math.exp((ratio * i) / samples));
  for (const d of extra) {
    if (d > minDays && d < maxDays) days.add(d);
  }
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => ({ days: d, r: retrievability(d, stability, curve) }));
}

// ---------------------------------------------------------------------------
// 单卡历史视图：横轴 = 绝对时间（线性），锯齿形
// ---------------------------------------------------------------------------

export interface HistorySegment {
  fromMs: number;
  toMs: number;
  stability: number;
  rating: MemoryRating;
  /** 这次复习前一刻的保持率（上一段的终点）；首段或上一段缺稳定性时为 null */
  recallBefore: number | null;
}

export interface HistoryRow {
  logId: string;
  reviewMs: number;
  rating: MemoryRating;
  /** 距上一次复习的天数；首次学习为 null */
  elapsedDays: number | null;
  recallBefore: number | null;
  stabilityAfter: number | null;
}

export function historyRows(history: CardMemoryHistory): HistoryRow[] {
  return history.reviews.map((review, i) => {
    const previous = i > 0 ? history.reviews[i - 1] : null;
    const elapsedDays = previous ? (review.reviewMs - previous.reviewMs) / MS_PER_DAY : null;
    const recallBefore = previous && elapsedDays != null && previous.stabilityAfter && previous.stabilityAfter > 0
      ? retrievability(elapsedDays, previous.stabilityAfter, history.curve)
      : null;
    return {
      logId: review.logId,
      reviewMs: review.reviewMs,
      rating: review.rating,
      elapsedDays,
      recallBefore,
      stabilityAfter: review.stabilityAfter,
    };
  });
}

/** 每次复习起一段，到下一次复习（最后一段到 endMs）为止；缺稳定性的复习不画 */
export function historySegments(history: CardMemoryHistory, endMs: number): HistorySegment[] {
  const rows = historyRows(history);
  const segments: HistorySegment[] = [];
  history.reviews.forEach((review, i) => {
    const stability = review.stabilityAfter;
    if (!stability || !(stability > 0)) return;
    const next = history.reviews[i + 1];
    const toMs = next ? next.reviewMs : Math.max(endMs, review.reviewMs);
    segments.push({ fromMs: review.reviewMs, toMs, stability, rating: review.rating, recallBefore: rows[i].recallBefore });
  });
  return segments;
}

export interface HistoryRange {
  startMs: number;
  endMs: number;
  ticks: number[];
  /** 刻度标签粒度 */
  label: 'time' | 'day' | 'month';
}

const HOUR_MS = MS_PER_DAY / 24;
const LINEAR_STEPS = [1, 3, 6, 12].map((h) => h * HOUR_MS).concat([1, 2, 7, 14, 30, 60, 90, 180, 365].map((d) => d * MS_PER_DAY));

/** 从首次复习到「此刻 / 下次复习」中较晚者，右侧留 12% 预测段；刻度不超过 6 个 */
export function historyRange(history: CardMemoryHistory, nowMs: number, maxTicks = 6): HistoryRange {
  const first = history.reviews[0]?.reviewMs ?? history.card.lastReviewMs ?? nowMs;
  const last = Math.max(nowMs, history.card.dueMs, first + HOUR_MS);
  const endMs = last + Math.max(HOUR_MS, (last - first) * 0.12);
  const span = endMs - first;
  const step = LINEAR_STEPS.find((s) => span / s <= maxTicks) ?? LINEAR_STEPS[LINEAR_STEPS.length - 1];
  const ticks: number[] = [];
  const startTick = step >= MS_PER_DAY ? localMidnight(first) : Math.floor(first / HOUR_MS) * HOUR_MS;
  for (let tick = startTick; tick <= endMs; tick += step) {
    if (tick >= first) ticks.push(tick);
  }
  return { startMs: first, endMs, ticks, label: step < MS_PER_DAY ? 'time' : step >= 60 * MS_PER_DAY ? 'month' : 'day' };
}

function localMidnight(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < ms ? date.getTime() + MS_PER_DAY : date.getTime();
}

// ---------------------------------------------------------------------------
// 后端响应解析（字段缺失 / 类型不符一律视为不可用，不编造默认值）
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const rating = (value: unknown): MemoryRating | null => (value === 1 || value === 2 || value === 3 || value === 4 ? value : null);

function parseCurve(value: unknown): ForgettingCurve {
  if (!isObject(value)) return FSRS5_CURVE;
  const decay = num(value.decay);
  const factor = num(value.factor);
  return decay != null && decay < 0 && factor != null && factor > 0 ? { decay, factor } : FSRS5_CURVE;
}

function parseCard(value: unknown): MemoryCard | null {
  if (!isObject(value)) return null;
  const cardStateId = str(value.cardStateId);
  const dueMs = num(value.dueMs);
  if (!cardStateId || dueMs == null) return null;
  const extraFields: Record<string, string> = {};
  if (isObject(value.extraFields)) {
    for (const [key, field] of Object.entries(value.extraFields)) {
      if (typeof field === 'string') extraFields[key] = field;
    }
  }
  return {
    cardStateId,
    ankiCardId: str(value.ankiCardId) ?? '',
    front: str(value.front) ?? '',
    text: str(value.text),
    extraFields,
    state: num(value.state) ?? 0,
    stability: num(value.stability),
    difficulty: num(value.difficulty),
    lastReviewMs: num(value.lastReviewMs),
    dueMs,
    reps: num(value.reps) ?? 0,
    lapses: num(value.lapses) ?? 0,
    lastRating: rating(value.lastRating),
  };
}

function parseDesiredRetention(value: unknown): number {
  const retention = num(value);
  return retention != null && retention > 0 && retention < 1 ? retention : 0.9;
}

export function parseMemoryOverview(raw: unknown): MemoryOverview | null {
  if (!isObject(raw) || !Array.isArray(raw.recent)) return null;
  const trueRetention = isObject(raw.trueRetention) ? raw.trueRetention : {};
  return {
    generatedAtMs: num(raw.generatedAtMs) ?? Date.now(),
    desiredRetention: parseDesiredRetention(raw.desiredRetention),
    curve: parseCurve(raw.curve),
    recent: raw.recent.map(parseCard).filter((card): card is MemoryCard => card !== null),
    memorizedCount: num(raw.memorizedCount) ?? 0,
    averageRetrievability: num(raw.averageRetrievability),
    trueRetention: {
      windowDays: num(trueRetention.windowDays) ?? 30,
      reviews: num(trueRetention.reviews) ?? 0,
      passed: num(trueRetention.passed) ?? 0,
    },
  };
}

export function parseCardMemoryHistory(raw: unknown): CardMemoryHistory | null {
  if (!isObject(raw) || !Array.isArray(raw.reviews)) return null;
  const card = parseCard(raw.card);
  if (!card) return null;
  const reviews: MemoryReview[] = [];
  for (const item of raw.reviews) {
    if (!isObject(item)) continue;
    const logId = str(item.logId);
    const reviewMs = num(item.reviewMs);
    const itemRating = rating(item.rating);
    if (!logId || reviewMs == null || itemRating == null) continue;
    reviews.push({
      logId,
      reviewMs,
      rating: itemRating,
      stateBefore: num(item.stateBefore) ?? 0,
      stateAfter: num(item.stateAfter) ?? 0,
      stabilityAfter: num(item.stabilityAfter),
      difficultyAfter: num(item.difficultyAfter),
      dueAfterMs: num(item.dueAfterMs),
    });
  }
  reviews.sort((a, b) => a.reviewMs - b.reviewMs);
  return {
    generatedAtMs: num(raw.generatedAtMs) ?? Date.now(),
    desiredRetention: parseDesiredRetention(raw.desiredRetention),
    curve: parseCurve(raw.curve),
    card,
    reviews,
  };
}

export async function fetchMemoryOverview(recentLimit = 5): Promise<MemoryOverview> {
  const parsed = parseMemoryOverview(await invoke<unknown>('fsrs_get_memory_overview', { recentLimit }));
  if (!parsed) throw new Error('fsrs_get_memory_overview returned an unexpected payload');
  return parsed;
}

export async function fetchCardMemoryHistory(cardStateId: string): Promise<CardMemoryHistory> {
  const parsed = parseCardMemoryHistory(await invoke<unknown>('fsrs_get_card_memory_history', { cardStateId }));
  if (!parsed) throw new Error('fsrs_get_card_memory_history returned an unexpected payload');
  return parsed;
}
