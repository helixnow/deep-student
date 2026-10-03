/**
 * Web 演示壳 - 闪卡复习 mock（学习桌面模式里的「闪卡」窗口）
 *
 * 卡片库预置一套「高等数学 · 错题本」旧卡，其中三张今天到期；对话里生成的
 * 卡片点「加入卡片库」后也会进库，「复习这批」把它们排进复习。
 * 评分按真实后端的响应形状回写（logId / dueMs / cardState），到期队列、
 * 今日统计、热力图和评分分布都跟着变；只存在内存里，刷新页面回到初始状态。
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DECK = '高等数学 · 错题本';
const LEARN_AHEAD_MINUTES = 20;

/** FSRS 卡片状态：0 新卡 / 1 学习中 / 2 复习 / 3 重学 */
type CardStateKind = 0 | 1 | 2 | 3;

interface DemoCard {
  /** fsrs 状态 id（评分用） */
  id: string;
  ankiCardId: string;
  front: string;
  back: string;
  tags: string[];
  templateId: string | null;
  createdAt: number;
  enqueued: boolean;
  state: CardStateKind;
  dueMs: number;
  stability: number;
  difficulty: number;
  lastReviewMs: number | null;
  latestReview: { logId: string; rating: number; reviewedAt: string } | null;
}

interface ReviewLog {
  logId: string;
  cardId: string;
  rating: number;
  reviewedAt: number;
  /** 撤销时恢复用 */
  before: DemoCard;
}

const SEED: Array<{ front: string; back: string; tags: string[]; dueInDays: number; stability: number }> = [
  {
    front: '洛必达法则使用前要先确认什么？',
    back: '先确认是 0/0 或 ∞/∞ 型未定式，分子分母在去心邻域内可导且分母导数不为 0。\n求导后的极限存在（或为 ∞），结论才成立。',
    tags: ['高等数学', '极限'],
    dueInDays: -0.2,
    stability: 3.4,
  },
  {
    front: 'eˣ 在 x = 0 处的三阶麦克劳林展开是什么？',
    back: 'eˣ = 1 + x + x²/2 + x³/6 + o(x³)。',
    tags: ['高等数学', '泰勒公式'],
    dueInDays: -0.1,
    stability: 5.2,
  },
  {
    front: '分部积分求 ∫ x·eˣ dx 时，u 和 dv 怎么选？',
    back: '取 u = x、dv = eˣ dx（「反对幂三指」里幂函数排在指数函数前面）。\n∫ x·eˣ dx = x·eˣ − ∫ eˣ dx = (x − 1)eˣ + C。',
    tags: ['高等数学', '不定积分'],
    dueInDays: -0.05,
    stability: 2.6,
  },
  {
    front: 'p 级数 Σ 1/nᵖ 什么时候收敛？',
    back: 'p > 1 时收敛，p ≤ 1 时发散；p = 1 就是调和级数。',
    tags: ['高等数学', '级数'],
    dueInDays: 2,
    stability: 9.8,
  },
  {
    front: '函数在一点可导和连续是什么关系？',
    back: '可导必连续，连续不一定可导。\n反例：f(x) = |x| 在 x = 0 处连续但不可导。',
    tags: ['高等数学', '导数'],
    dueInDays: 3,
    stability: 14.5,
  },
  {
    front: 'f 是奇函数时，∫₋ₐᵃ f(x) dx 等于多少？',
    back: '等于 0。\nf 是偶函数时等于 2∫₀ᵃ f(x) dx。',
    tags: ['高等数学', '定积分'],
    dueInDays: 5,
    stability: 21,
  },
  {
    front: '曲线 y = f(x) 在 x₀ 处的切线方程怎么写？',
    back: 'y − f(x₀) = f′(x₀)(x − x₀)。',
    tags: ['高等数学', '导数'],
    dueInDays: 8,
    stability: 30,
  },
  {
    front: 'lim(x→∞) (1 + 1/x)ˣ 等于多少？',
    back: '等于 e，这是第二个重要极限。\n变形 lim(x→0) (1 + x)^(1/x) = e 同样常用。',
    tags: ['高等数学', '极限'],
    dueInDays: 12,
    stability: 41,
  },
];

const now0 = Date.now();
const cards: DemoCard[] = SEED.map((seed, i) => ({
  id: `fsrs-demo-${i + 1}`,
  ankiCardId: `demo-card-${i + 1}`,
  front: seed.front,
  back: seed.back,
  tags: seed.tags,
  templateId: null,
  createdAt: now0 - (40 - i * 3) * DAY,
  enqueued: true,
  state: 2,
  dueMs: now0 + seed.dueInDays * DAY,
  stability: seed.stability,
  difficulty: 5.1,
  lastReviewMs: now0 + (seed.dueInDays - seed.stability) * DAY,
  latestReview: null,
}));
const logs: ReviewLog[] = [];
let logSeq = 1;
let stateSeq = SEED.length + 1;

/** 今天之前的复习记录：确定性的伪随机，热力图每次打开都一样 */
const HISTORY_DAYS = 120;
const pastDaily: Array<{ date: string; total: number; again: number }> = (() => {
  const rows: Array<{ date: string; total: number; again: number }> = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let d = HISTORY_DAYS; d >= 1; d -= 1) {
    const r = rand();
    // 大约四分之一的日子没复习；最近两周更勤快
    if (r < (d > 14 ? 0.3 : 0.08)) continue;
    const total = Math.round(6 + rand() * (d > 14 ? 18 : 26));
    rows.push({ date: dayKey(now0 - d * DAY), total, again: Math.round(total * (0.06 + rand() * 0.1)) });
  }
  return rows;
})();
/** 今天在演示开始前已经复习过的张数 */
const REVIEWED_BEFORE_DEMO = 18;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isDue(card: DemoCard, at = Date.now()): boolean {
  return card.enqueued && card.dueMs <= at;
}

function reviewRow(card: DemoCard) {
  return {
    id: card.id,
    ankiCardId: card.ankiCardId,
    front: card.front,
    back: card.back,
    tags: card.tags,
    images: [],
    templateId: card.templateId,
    extraFields: {},
    state: card.state,
    dueMs: card.dueMs,
    stability: card.stability,
    difficulty: card.difficulty,
    lastReviewMs: card.lastReviewMs,
    suspended: false,
  };
}

/** 各评分档的下次间隔：按卡片稳定度粗算，形状和真实调度器一致即可 */
function intervals(card: DemoCard): Record<1 | 2 | 3 | 4, number> {
  const s = Math.max(card.stability, 0.5);
  if (card.state === 0) return { 1: MINUTE, 2: 6 * MINUTE, 3: 10 * MINUTE, 4: 2 * DAY };
  return {
    1: 10 * MINUTE,
    2: Math.max(1, Math.round(s * 0.6)) * DAY,
    3: Math.max(2, Math.round(s * 1.5)) * DAY,
    4: Math.max(4, Math.round(s * 2.6)) * DAY,
  };
}

function libraryItem(card: DemoCard) {
  return {
    id: card.ankiCardId,
    task_id: 'demo-task-library',
    front: card.front,
    back: card.back,
    text: '',
    tags: card.tags,
    images: [],
    template_id: card.templateId,
    extra_fields: {},
    deck_name: DECK,
    created_at: new Date(card.createdAt).toISOString(),
    updated_at: new Date(card.lastReviewMs ?? card.createdAt).toISOString(),
    stateId: card.enqueued ? card.id : null,
    state: card.enqueued ? card.state : null,
    dueMs: card.enqueued ? card.dueMs : null,
    suspended: false,
    enqueued: card.enqueued,
    isDue: isDue(card),
    latestReview: card.latestReview ? { ...card.latestReview, undoable: false } : null,
  };
}

function libraryStatus(card: DemoCard): string {
  if (!card.enqueued) return 'notEnqueued';
  if (isDue(card)) return 'due';
  if (card.state === 0) return 'new';
  if (card.state === 1 || card.state === 3) return 'learning';
  return 'review';
}

/** 对话里「加入卡片库」保存的卡：进库但还没排进复习 */
export function addDemoLibraryCards(saved: Array<{ id: string; front?: unknown; back?: unknown; tags?: unknown; template_id?: unknown }>): void {
  for (const card of saved) {
    if (cards.some((c) => c.ankiCardId === card.id)) continue;
    cards.push({
      id: `fsrs-demo-${stateSeq++}`,
      ankiCardId: card.id,
      front: String(card.front ?? ''),
      back: String(card.back ?? ''),
      tags: Array.isArray(card.tags) ? card.tags.map(String) : [],
      templateId: typeof card.template_id === 'string' ? card.template_id : null,
      createdAt: Date.now(),
      enqueued: false,
      state: 0,
      dueMs: Date.now(),
      stability: 0,
      difficulty: 5,
      lastReviewMs: null,
      latestReview: null,
    });
  }
}

/** 返回 undefined 表示不是闪卡命令，交回 mockIpc 继续分发 */
export function handleDemoFlashcards(cmd: string, args: Record<string, unknown>): unknown {
  const now = Date.now();
  switch (cmd) {
    case 'fsrs_get_due': {
      const limit = Number(args.limit ?? 50);
      return cards
        .filter((card) => card.enqueued && card.dueMs <= now + LEARN_AHEAD_MINUTES * MINUTE)
        .sort((a, b) => a.dueMs - b.dueMs)
        .slice(0, limit)
        .map(reviewRow);
    }
    case 'fsrs_get_stats': {
      const enqueued = cards.filter((card) => card.enqueued);
      const reviewsToday = REVIEWED_BEFORE_DEMO + logs.filter((log) => dayKey(log.reviewedAt) === dayKey(now)).length;
      return {
        total: enqueued.length,
        due: enqueued.filter((card) => isDue(card, now)).length,
        newCount: enqueued.filter((card) => card.state === 0).length,
        learning: enqueued.filter((card) => card.state === 1).length,
        review: enqueued.filter((card) => card.state === 2).length,
        relearning: enqueued.filter((card) => card.state === 3).length,
        suspended: 0,
        reviewsToday,
        backlog: 0,
        backlogReview: 0,
        backlogNew: 0,
        learningWaiting: enqueued.filter((card) => (card.state === 1 || card.state === 3) && card.dueMs > now).length,
      };
    }
    case 'fsrs_get_scheduler_config':
      return { learnAheadMinutes: LEARN_AHEAD_MINUTES };
    case 'fsrs_update_scheduler_config':
      return null;
    case 'fsrs_preview_intervals': {
      const card = cards.find((c) => c.id === args.cardStateId);
      if (!card) return null;
      const next = intervals(card);
      const preview = (ms: number) => ({ dueMs: now + ms, scheduledDays: Math.floor(ms / DAY), intervalMs: ms });
      return { previews: { 1: preview(next[1]), 2: preview(next[2]), 3: preview(next[3]), 4: preview(next[4]) } };
    }
    case 'fsrs_rate': {
      const card = cards.find((c) => c.id === args.cardStateId);
      const rating = Number(args.rating) as 1 | 2 | 3 | 4;
      if (!card || ![1, 2, 3, 4].includes(rating)) throw new Error('这张卡片已不在复习队列里。');
      const before = { ...card };
      const interval = intervals(card)[rating];
      const logId = `demo-log-${logSeq++}`;
      card.state = rating === 1 ? (card.state === 0 ? 1 : 3) : card.state === 0 && rating < 4 ? 1 : 2;
      card.stability = rating === 1 ? Math.max(0.4, card.stability * 0.45) : Math.max(card.stability, interval / DAY);
      card.dueMs = now + interval;
      card.lastReviewMs = now;
      card.latestReview = { logId, rating, reviewedAt: new Date(now).toISOString() };
      logs.push({ logId, cardId: card.id, rating, reviewedAt: now, before });
      return {
        logId,
        dueMs: card.dueMs,
        scheduledDays: Math.floor(interval / DAY),
        cardState: { id: card.id, state: card.state, dueMs: card.dueMs, lastReviewMs: now, suspended: false },
      };
    }
    case 'fsrs_undo_last_review': {
      const log = logs[logs.length - 1];
      if (!log || log.logId !== args.expectedLogId || log.cardId !== args.cardStateId) {
        throw new Error('review log is stale');
      }
      logs.pop();
      const index = cards.findIndex((c) => c.id === log.cardId);
      if (index >= 0) cards[index] = log.before;
      return { changed: true, undoneLogId: log.logId, state: { id: log.before.id, lastReviewMs: log.before.lastReviewMs } };
    }
    case 'fsrs_enqueue_cards': {
      const ids = Array.isArray(args.ankiCardIds) ? args.ankiCardIds.map(String) : [];
      const rows = ids.flatMap((ankiCardId) => {
        const card = cards.find((c) => c.ankiCardId === ankiCardId);
        if (!card) return [];
        if (!card.enqueued) {
          card.enqueued = true;
          card.state = 0;
          card.dueMs = now;
        }
        return [reviewRow(card)];
      });
      return { states: rows, reviewCards: rows };
    }
    case 'fsrs_suspend_card':
    case 'fsrs_unsuspend_card':
      throw new Error('请在桌面版中暂停或恢复卡片。');
    case 'fsrs_get_review_statistics': {
      const today = logs.filter((log) => dayKey(log.reviewedAt) === dayKey(now));
      const dailyReviews = [
        ...pastDaily,
        {
          date: dayKey(now),
          total: REVIEWED_BEFORE_DEMO + today.length,
          again: 1 + today.filter((log) => log.rating === 1).length,
        },
      ];
      const total = dailyReviews.reduce((sum, row) => sum + row.total, 0);
      const again = dailyReviews.reduce((sum, row) => sum + row.again, 0);
      const hard = Math.round(total * 0.14) + today.filter((log) => log.rating === 2).length;
      const easy = Math.round(total * 0.1) + today.filter((log) => log.rating === 4).length;
      return {
        dailyReviews,
        ratingDistribution: { again, hard, good: total - again - hard - easy, easy, total },
      };
    }
    case 'list_anki_library_cards': {
      const request = (args.request ?? {}) as { page?: number; pageSize?: number; search?: string; status?: string };
      const page = Math.max(1, Number(request.page ?? 1));
      const pageSize = Math.max(1, Number(request.pageSize ?? 50));
      const search = String(request.search ?? '').trim();
      const status = String(request.status ?? 'all');
      const counts: Record<string, number> = { all: cards.length, due: 0, new: 0, learning: 0, review: 0, suspended: 0, notEnqueued: 0 };
      for (const card of cards) counts[libraryStatus(card)] += 1;
      const matched = cards
        .filter((card) => !search || card.front.includes(search) || card.back.includes(search))
        .filter((card) => status === 'all' || libraryStatus(card) === status)
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        items: matched.slice((page - 1) * pageSize, page * pageSize).map(libraryItem),
        page,
        pageSize,
        total: matched.length,
        statusCounts: counts,
      };
    }
    default:
      return undefined;
  }
}
