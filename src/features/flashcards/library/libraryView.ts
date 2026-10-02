/**
 * 卡片库视图层纯函数：状态推导、客户端筛选/排序、到期时间人性化。
 * 后端 list_anki_library_cards 只支持 search/page，筛选排序均作用于当前页。
 */
import type { AnkiLibraryCard } from '@/types';
import type {
  LibrarySortDir,
  LibrarySortKey,
  LibraryStatusFilter,
} from '../store/libraryStore';

export type LibraryCardStatus =
  | 'notEnqueued'
  | 'suspended'
  | 'new'
  | 'learning'
  | 'review'
  | 'relearning'
  | 'enqueued';

export function getCardStatus(card: AnkiLibraryCard): LibraryCardStatus {
  if (!card.enqueued) return 'notEnqueued';
  if (card.suspended) return 'suspended';
  switch (card.state) {
    case 0:
      return 'new';
    case 1:
      return 'learning';
    case 2:
      return 'review';
    case 3:
      return 'relearning';
    default:
      return 'enqueued';
  }
}

/**
 * 队列分区：已生成但尚未入队 FSRS 的卡（inbox，收件箱）与已入队的调度中卡（scheduled）。
 * 稳定分区：各组内保持传入顺序（调用方先做筛选/排序）。
 */
export interface LibraryQueueSections {
  /** 未入队：制卡产物落库后还没进复习计划，不会出现在到期队列。 */
  inbox: AnkiLibraryCard[];
  /** 已入队（含暂停）：由 FSRS 调度，属于复习队列。 */
  scheduled: AnkiLibraryCard[];
}

export function partitionLibraryQueues(items: AnkiLibraryCard[]): LibraryQueueSections {
  const inbox: AnkiLibraryCard[] = [];
  const scheduled: AnkiLibraryCard[] = [];
  for (const card of items) {
    (card.enqueued ? scheduled : inbox).push(card);
  }
  return { inbox, scheduled };
}

export function countDueCards(items: AnkiLibraryCard[]): number {
  return items.reduce(
    (count, card) => (card.isDue && !card.suspended ? count + 1 : count),
    0,
  );
}

export function matchesStatusFilter(
  card: AnkiLibraryCard,
  filter: LibraryStatusFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'due') return card.isDue && !card.suspended;
  const status = getCardStatus(card);
  if (filter === 'learning') return status === 'learning' || status === 'relearning';
  return status === filter;
}

// 模板专属字段的语义优先级：生成时 front/back 列可能落在「科目」「编号」这类辅助字段上
// （选择题模板正面成了「高等数学」、蓝图模板成了「LMT-01」），列表/搜索需要真正的题面与答案。
const FRONT_FIELD_KEYS = ['question', 'term', 'word', 'name', 'symbol', 'title', 'text', 'front'];
const BACK_FIELD_KEYS = ['answer', 'definition', 'explanation', 'expl', 'detail', 'backdetail', 'meaning', 'back'];

function pickField(card: AnkiLibraryCard, keys: string[]): string {
  const merged: Record<string, string> = { ...(card.fields ?? {}), ...(card.extra_fields ?? {}) };
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), trimmed);
  }
  for (const key of keys) {
    const value = byLower.get(key);
    if (value) return value;
  }
  return '';
}

export function getCardFront(card: AnkiLibraryCard): string {
  return pickField(card, FRONT_FIELD_KEYS) || card.front || card.fields?.Front || '';
}

export function getCardBack(card: AnkiLibraryCard): string {
  const front = getCardFront(card);
  const semantic = pickField(card, BACK_FIELD_KEYS);
  if (semantic && semantic !== front) return semantic;
  const fallback = card.back || card.fields?.Back || card.text || '';
  return fallback !== front ? fallback : '';
}

function createdAtMs(card: AnkiLibraryCard): number {
  const value = Date.parse(card.created_at);
  return Number.isFinite(value) ? value : 0;
}

export function sortLibraryCards(
  items: AnkiLibraryCard[],
  sortKey: LibrarySortKey,
  sortDir: LibrarySortDir,
): AnkiLibraryCard[] {
  if (sortKey === 'default') return items;
  const dir = sortDir === 'asc' ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortKey === 'due') {
      // 未入队 / 无到期时间的卡固定排在最后，不参与方向翻转。
      const aDue = typeof a.dueMs === 'number' && Number.isFinite(a.dueMs) ? a.dueMs : null;
      const bDue = typeof b.dueMs === 'number' && Number.isFinite(b.dueMs) ? b.dueMs : null;
      if (aDue === null && bDue === null) return 0;
      if (aDue === null) return 1;
      if (bDue === null) return -1;
      return (aDue - bDue) * dir;
    }
    if (sortKey === 'created') {
      return (createdAtMs(a) - createdAtMs(b)) * dir;
    }
    return getCardFront(a).localeCompare(getCardFront(b)) * dir;
  });
  return sorted;
}

const RELATIVE_UNITS: Array<{ limitMs: number; unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { limitMs: 60 * 60 * 1000, unit: 'minute', ms: 60 * 1000 },
  { limitMs: 48 * 60 * 60 * 1000, unit: 'hour', ms: 60 * 60 * 1000 },
  { limitMs: 60 * 24 * 60 * 60 * 1000, unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { limitMs: 540 * 24 * 60 * 60 * 1000, unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
];

/**
 * 到期时间人性化："3天后" / "2小时前"。一分钟以内返回 null，由调用方显示"现在到期"。
 */
export function formatRelativeDue(
  dueMs: number | null | undefined,
  locale: string,
  nowMs: number = Date.now(),
): string | null {
  if (typeof dueMs !== 'number' || !Number.isFinite(dueMs)) return null;
  const diff = dueMs - nowMs;
  const abs = Math.abs(diff);
  if (abs < 60 * 1000) return null;
  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  } catch {
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  }
  for (const { limitMs, unit, ms } of RELATIVE_UNITS) {
    if (abs < limitMs) {
      const value = Math.round(diff / ms);
      return formatter.format(value, unit);
    }
  }
  return formatter.format(Math.round(diff / (365 * 24 * 60 * 60 * 1000)), 'year');
}

export function formatAbsoluteTime(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatCreatedAt(card: AnkiLibraryCard): string | null {
  const ms = createdAtMs(card);
  if (!ms) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

/** 逗号 / 中文逗号 / 分号分隔的标签输入解析（去空白、去重、保序）。 */
export function parseTagsInput(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value.split(/[,，;；]/)) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}
