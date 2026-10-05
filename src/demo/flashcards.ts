/**
 * Web 演示壳 - 闪卡复习 mock（学习桌面模式里的「闪卡」窗口）
 *
 * 卡片库预置一套「高等数学 · 错题本」旧卡，其中三张今天到期；对话里生成的
 * 卡片点「加入卡片库」后也会进库，「复习这批」把它们排进复习。
 * 调度用与桌面版相同的 FSRS-6（fsrs-rs 默认参数）与 Anki 学习步（1m 10m / 重学 10m，
 * 凌晨 4 点日切，演示里不加 fuzz），旧卡的复习历史也按这套调度逐次模拟出来，
 * 记忆曲线、间隔预览都和桌面版一致。
 * 评分按真实后端的响应形状回写（logId / dueMs / cardState），到期队列、
 * 今日统计、热力图和评分分布都跟着变；只存在内存里，刷新页面回到初始状态。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DECK = '高等数学 · 错题本';
const LEARN_AHEAD_MINUTES = 20;

/** FSRS 卡片状态：0 新卡 / 1 学习中 / 2 复习 / 3 重学 */
type CardStateKind = 0 | 1 | 2 | 3;
type Rating = 1 | 2 | 3 | 4;

// ---- FSRS-6（fsrs-rs 默认参数）+ Anki 学习步：与 src-tauri/src/fsrs_scheduler.rs 同一套规则 ----

const W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614,
  0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const DECAY = -W[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;
const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 36_500;
const LEARNING_STEPS_MINUTES = [1, 10];
const RELEARNING_STEPS_MINUTES = [10];
const DAY_ROLLOVER_HOUR = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const forgettingCurve = (elapsedDays: number, stability: number) => (1 + (FACTOR * elapsedDays) / stability) ** DECAY;
const initDifficulty = (rating: Rating) => W[4] - Math.exp(W[5] * (rating - 1)) + 1;
const intervalDays = (stability: number, minimum = 1) =>
  clamp(Math.round((stability / FACTOR) * (DESIRED_RETENTION ** (1 / DECAY) - 1)), Math.min(minimum, MAX_INTERVAL_DAYS), MAX_INTERVAL_DAYS);

/** 逻辑日序号：本地时间过了日切小时才算新的一天 */
function logicalDay(ms: number): number {
  const shifted = new Date(ms - DAY_ROLLOVER_HOUR * HOUR);
  return Math.round(Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) / DAY);
}

interface MemoryState {
  stability: number;
  difficulty: number;
}

/** fsrs-rs `step`：同一逻辑日内走短期公式，跨日按遗忘曲线计算 */
function step(memory: MemoryState | null, rating: Rating, daysElapsed: number): MemoryState {
  if (!memory) {
    return { stability: W[rating - 1], difficulty: clamp(initDifficulty(rating), 1, 10) };
  }
  const { stability: s, difficulty: d } = memory;
  let stability: number;
  if (daysElapsed === 0) {
    const sinc = Math.exp(W[17] * (rating - 3 + W[18])) * s ** -W[19];
    stability = s * (rating >= 2 ? Math.max(sinc, 1) : sinc);
  } else {
    const r = forgettingCurve(daysElapsed, s);
    if (rating === 1) {
      const lapse = W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp((1 - r) * W[14]);
      stability = Math.min(lapse, s / Math.exp(W[17] * W[18]));
    } else {
      const modifier = rating === 2 ? W[15] : rating === 4 ? W[16] : 1;
      stability = s * (Math.exp(W[8]) * (11 - d) * s ** -W[9] * (Math.exp((1 - r) * W[10]) - 1) * modifier + 1);
    }
  }
  const damped = d + ((10 - d) * (-W[6] * (rating - 3))) / 9;
  const difficulty = clamp(W[7] * (initDifficulty(4) - damped) + damped, 1, 10);
  return { stability: clamp(stability, 0.001, 36_500), difficulty };
}

interface Memory {
  state: CardStateKind;
  stability: number;
  difficulty: number;
  lastReviewMs: number | null;
  reps: number;
  lapses: number;
  /** 当前学习 / 重学步序号 */
  learningStep?: number;
}

interface Scheduled extends Memory {
  dueMs: number;
  scheduledDays: number;
}

function hardDelay(steps: number[], index: number): number {
  const current = steps[Math.min(index, steps.length - 1)];
  if (index > 0) return current;
  return steps.length > 1 ? (current + steps[1]) / 2 : Math.min(current * 1.5, current + 1440);
}

function schedule(card: Memory, rating: Rating, now: number): Scheduled {
  const hasMemory = card.state !== 0 && card.stability > 0;
  const daysElapsed = hasMemory && card.lastReviewMs != null
    ? Math.max(0, logicalDay(now) - logicalDay(card.lastReviewMs))
    : 0;
  const next = step(hasMemory ? { stability: card.stability, difficulty: card.difficulty } : null, rating, daysElapsed);
  const base = { reps: card.reps + 1, lapses: card.lapses, lastReviewMs: now, ...next };
  const minutes = (state: CardStateKind, learningStep: number, delay: number): Scheduled => ({
    ...base, state, learningStep, dueMs: now + delay * MINUTE, scheduledDays: 0,
  });
  const review = (days: number, lapses = card.lapses): Scheduled => ({
    ...base, lapses, state: 2, learningStep: 0, dueMs: now + days * DAY, scheduledDays: days,
  });

  if (card.state === 2 && hasMemory) {
    if (rating === 1) {
      return RELEARNING_STEPS_MINUTES.length > 0
        ? { ...minutes(3, 0, RELEARNING_STEPS_MINUTES[0]), lapses: card.lapses + 1 }
        : review(intervalDays(next.stability), card.lapses + 1);
    }
    const prior = { stability: card.stability, difficulty: card.difficulty };
    const hard = intervalDays(step(prior, 2, daysElapsed).stability);
    const good = intervalDays(step(prior, 3, daysElapsed).stability, hard + 1);
    const easy = intervalDays(step(prior, 4, daysElapsed).stability, good + 1);
    return review(rating === 2 ? hard : rating === 3 ? good : easy);
  }

  const relearning = card.state === 3 && hasMemory;
  const steps = relearning ? RELEARNING_STEPS_MINUTES : LEARNING_STEPS_MINUTES;
  const stepState: CardStateKind = relearning ? 3 : 1;
  const index = hasMemory ? Math.min(card.learningStep ?? 0, steps.length - 1) : 0;
  const prior = hasMemory ? { stability: card.stability, difficulty: card.difficulty } : null;
  const goodDays = intervalDays(step(prior, 3, daysElapsed).stability);
  if (rating === 4) return review(intervalDays(step(prior, 4, daysElapsed).stability, goodDays + 1));
  if (rating === 1) return minutes(stepState, 0, steps[0]);
  if (rating === 2) return minutes(stepState, index, hardDelay(steps, index));
  const goodStep = hasMemory ? index + 1 : 1;
  return goodStep < steps.length ? minutes(stepState, goodStep, steps[goodStep]) : review(goodDays);
}

// ---- 卡片与复习记录 ----

interface DemoCard extends Memory {
  /** fsrs 状态 id（评分用） */
  id: string;
  ankiCardId: string;
  front: string;
  back: string;
  tags: string[];
  templateId: string | null;
  createdAt: number;
  enqueued: boolean;
  dueMs: number;
  latestReview: { logId: string; rating: number; reviewedAt: string } | null;
}

/** 记忆曲线用的单次复习（同 fsrs_review_logs 的字段） */
interface HistoryEntry {
  logId: string;
  reviewMs: number;
  rating: Rating;
  stateBefore: CardStateKind;
  stateAfter: CardStateKind;
  stabilityAfter: number;
  difficultyAfter: number;
  dueAfterMs: number;
}

interface ReviewLog {
  logId: string;
  cardId: string;
  rating: number;
  reviewedAt: number;
  /** 撤销时恢复用 */
  before: DemoCard;
}

/** 旧卡：按评分序列模拟出来的真实复习历史，最后一次的到期时间对齐 dueInDays */
const SEED: Array<{ front: string; back: string; tags: string[]; dueInDays: number; ratings: Rating[] }> = [
  {
    front: '洛必达法则使用前要先确认什么？',
    back: '先确认是 0/0 或 ∞/∞ 型未定式，分子分母在去心邻域内可导且分母导数不为 0。\n求导后的极限存在（或为 ∞），结论才成立。',
    tags: ['高等数学', '极限'],
    dueInDays: -0.2,
    ratings: [3, 3, 3, 1, 3],
  },
  {
    front: 'eˣ 在 x = 0 处的三阶麦克劳林展开是什么？',
    back: 'eˣ = 1 + x + x²/2 + x³/6 + o(x³)。',
    tags: ['高等数学', '泰勒公式'],
    dueInDays: -0.1,
    ratings: [3, 3, 2],
  },
  {
    front: '分部积分求 ∫ x·eˣ dx 时，u 和 dv 怎么选？',
    back: '取 u = x、dv = eˣ dx（「反对幂三指」里幂函数排在指数函数前面）。\n∫ x·eˣ dx = x·eˣ − ∫ eˣ dx = (x − 1)eˣ + C。',
    tags: ['高等数学', '不定积分'],
    dueInDays: -0.05,
    ratings: [1, 3, 3, 2],
  },
  {
    front: 'p 级数 Σ 1/nᵖ 什么时候收敛？',
    back: 'p > 1 时收敛，p ≤ 1 时发散；p = 1 就是调和级数。',
    tags: ['高等数学', '级数'],
    dueInDays: 2,
    ratings: [3, 3, 3],
  },
  {
    front: '函数在一点可导和连续是什么关系？',
    back: '可导必连续，连续不一定可导。\n反例：f(x) = |x| 在 x = 0 处连续但不可导。',
    tags: ['高等数学', '导数'],
    dueInDays: 3,
    ratings: [3, 3, 3, 2],
  },
  {
    front: 'f 是奇函数时，∫₋ₐᵃ f(x) dx 等于多少？',
    back: '等于 0。\nf 是偶函数时等于 2∫₀ᵃ f(x) dx。',
    tags: ['高等数学', '定积分'],
    dueInDays: 5,
    ratings: [3, 3, 3, 3],
  },
  {
    front: '曲线 y = f(x) 在 x₀ 处的切线方程怎么写？',
    back: 'y − f(x₀) = f′(x₀)(x − x₀)。',
    tags: ['高等数学', '导数'],
    dueInDays: 8,
    ratings: [4, 3, 1, 3, 3],
  },
  {
    front: 'lim(x→∞) (1 + 1/x)ˣ 等于多少？',
    back: '等于 e，这是第二个重要极限。\n变形 lim(x→0) (1 + x)^(1/x) = e 同样常用。',
    tags: ['高等数学', '极限'],
    dueInDays: 12,
    ratings: [4, 3],
  },
];

const now0 = Date.now();
let logSeq = 1;
const history = new Map<string, HistoryEntry[]>();

/** 每次在到期后的几小时内复习（确定性），算出整段历史后整体平移到「最后一次到期 = dueInDays」 */
function simulateSeed(ratings: Rating[], dueAt: number): { memory: Scheduled; entries: HistoryEntry[] } {
  let memory: Scheduled = { state: 0, stability: 0, difficulty: 0, lastReviewMs: null, reps: 0, lapses: 0, dueMs: 0, scheduledDays: 0 };
  const entries: HistoryEntry[] = [];
  let at = 0;
  ratings.forEach((rating, i) => {
    const next = schedule(memory, rating, at);
    entries.push({
      logId: `demo-log-${logSeq++}`,
      reviewMs: at,
      rating,
      stateBefore: memory.state,
      stateAfter: next.state,
      stabilityAfter: next.stability,
      difficultyAfter: next.difficulty,
      dueAfterMs: next.dueMs,
    });
    memory = next;
    at = next.dueMs + (next.scheduledDays > 0 ? ((i * 5) % 9) * HOUR : 0);
  });
  const shift = dueAt - memory.dueMs;
  for (const entry of entries) {
    entry.reviewMs += shift;
    entry.dueAfterMs += shift;
  }
  return {
    memory: { ...memory, dueMs: memory.dueMs + shift, lastReviewMs: (memory.lastReviewMs ?? 0) + shift },
    entries,
  };
}

const cards: DemoCard[] = SEED.map((seed, i) => {
  const id = `fsrs-demo-${i + 1}`;
  const { memory, entries } = simulateSeed(seed.ratings, now0 + seed.dueInDays * DAY);
  history.set(id, entries);
  return {
    id,
    ankiCardId: `demo-card-${i + 1}`,
    front: seed.front,
    back: seed.back,
    tags: seed.tags,
    templateId: null,
    createdAt: entries[0].reviewMs - DAY,
    enqueued: true,
    state: memory.state,
    dueMs: memory.dueMs,
    stability: memory.stability,
    difficulty: memory.difficulty,
    lastReviewMs: memory.lastReviewMs,
    reps: memory.reps,
    lapses: memory.lapses,
    latestReview: null,
  };
});
const logs: ReviewLog[] = [];
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
const TRUE_RETENTION_DAYS = 30;

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
    stability: card.state === 0 ? null : card.stability,
    difficulty: card.state === 0 ? null : card.difficulty,
    lastReviewMs: card.lastReviewMs,
    reps: card.reps,
    lapses: card.lapses,
    suspended: false,
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

/** 复习过、还在调度里的卡（记忆曲线的「已学卡片」口径） */
function isMemorized(card: DemoCard): boolean {
  return card.enqueued && card.state !== 0 && card.stability > 0 && card.lastReviewMs != null;
}

function memoryCard(card: DemoCard) {
  const entries = history.get(card.id) ?? [];
  return {
    cardStateId: card.id,
    ankiCardId: card.ankiCardId,
    deckId: 'deck_default',
    front: card.front,
    extraFields: {},
    state: card.state,
    stability: card.state === 0 ? null : card.stability,
    difficulty: card.state === 0 ? null : card.difficulty,
    lastReviewMs: card.lastReviewMs,
    dueMs: card.dueMs,
    reps: card.reps,
    lapses: card.lapses,
    lastRating: entries.length ? entries[entries.length - 1].rating : null,
  };
}

const CURVE = { decay: DECAY, factor: FACTOR };

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
      difficulty: 0,
      lastReviewMs: null,
      reps: 0,
      lapses: 0,
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
      const preview = (rating: Rating) => {
        const next = schedule(card, rating, now);
        return { dueMs: next.dueMs, scheduledDays: next.scheduledDays, intervalMs: next.dueMs - now };
      };
      return { previews: { 1: preview(1), 2: preview(2), 3: preview(3), 4: preview(4) } };
    }
    case 'fsrs_rate': {
      const card = cards.find((c) => c.id === args.cardStateId);
      const rating = Number(args.rating) as Rating;
      if (!card || ![1, 2, 3, 4].includes(rating)) throw new Error('这张卡片已不在复习队列里。');
      const before = { ...card };
      const next = schedule(card, rating, now);
      const logId = `demo-log-${logSeq++}`;
      Object.assign(card, {
        state: next.state,
        learningStep: next.learningStep ?? 0,
        stability: next.stability,
        difficulty: next.difficulty,
        dueMs: next.dueMs,
        lastReviewMs: now,
        reps: next.reps,
        lapses: next.lapses,
        latestReview: { logId, rating, reviewedAt: new Date(now).toISOString() },
      });
      const entries = history.get(card.id) ?? [];
      entries.push({
        logId,
        reviewMs: now,
        rating,
        stateBefore: before.state,
        stateAfter: next.state,
        stabilityAfter: next.stability,
        difficultyAfter: next.difficulty,
        dueAfterMs: next.dueMs,
      });
      history.set(card.id, entries);
      logs.push({ logId, cardId: card.id, rating, reviewedAt: now, before });
      return {
        logId,
        dueMs: card.dueMs,
        scheduledDays: next.scheduledDays,
        cardState: { id: card.id, state: card.state, dueMs: card.dueMs, lastReviewMs: now, suspended: false },
      };
    }
    case 'fsrs_undo_last_review': {
      const log = logs[logs.length - 1];
      if (!log || log.logId !== args.expectedLogId || log.cardId !== args.cardStateId) {
        throw new Error('review log is stale');
      }
      logs.pop();
      history.get(log.cardId)?.pop();
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
    case 'fsrs_get_memory_overview': {
      const limit = clamp(Number(args.recentLimit ?? 5) || 5, 1, 20);
      const memorized = cards.filter(isMemorized);
      const recent = [...memorized].sort((a, b) => (b.lastReviewMs ?? 0) - (a.lastReviewMs ?? 0)).slice(0, limit);
      const average = memorized.length
        ? memorized.reduce((sum, card) => sum + forgettingCurve(Math.max(0, now - (card.lastReviewMs ?? now)) / DAY, card.stability), 0) / memorized.length
        : null;
      // 真实保留率：今天之前按热力图的每日记录估（非「重来」即通过），加上今天到期复习卡的评分
      const windowStart = dayKey(now - (TRUE_RETENTION_DAYS - 1) * DAY);
      const past = pastDaily.filter((row) => row.date >= windowStart);
      const todayReviews = logs.filter((log) => dayKey(log.reviewedAt) === dayKey(now) && log.before.state === 2);
      const reviews = past.reduce((sum, row) => sum + row.total, 0) + todayReviews.length;
      const passed = past.reduce((sum, row) => sum + row.total - row.again, 0) + todayReviews.filter((log) => log.rating > 1).length;
      return {
        generatedAtMs: now,
        desiredRetention: DESIRED_RETENTION,
        curve: CURVE,
        recent: recent.map(memoryCard),
        memorizedCount: memorized.length,
        averageRetrievability: average,
        trueRetention: { windowDays: TRUE_RETENTION_DAYS, reviews, passed },
      };
    }
    case 'fsrs_get_card_memory_history': {
      const card = cards.find((c) => c.id === args.cardStateId);
      if (!card) throw new Error('fsrs card state not found');
      return {
        generatedAtMs: now,
        desiredRetention: DESIRED_RETENTION,
        curve: CURVE,
        card: memoryCard(card),
        reviews: history.get(card.id) ?? [],
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
