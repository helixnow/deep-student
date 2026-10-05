/**
 * FSRS 调度配置的解析与学习步文本格式（与后端 FsrsSchedulerConfig 对应）。
 *
 * 学习步沿用 Anki 写法：空格分隔，单位 s / m / h / d，裸数字按分钟，如 `1m 10m 1d`。
 */

export interface SchedulerConfig {
  newPerDay: number;
  reviewsPerDay: number;
  desiredRetention: number;
  learnAheadMinutes: number;
  learningSteps: number[];
  relearningSteps: number[];
  dayRolloverHour: number;
  maximumInterval: number;
  enableFuzz: boolean;
  fsrsParams: number[];
  fsrsOptimizedAtMs: number | null;
  fsrsOptimizedReviewCount: number | null;
  buryNewSiblings: boolean;
  buryReviewSiblings: boolean;
  reviewOrder: ReviewOrder;
  newReviewOrder: NewReviewOrder;
  maxAnswerSeconds: number;
}

export const REVIEW_ORDERS = ['due', 'retrievability', 'random'] as const;
export type ReviewOrder = (typeof REVIEW_ORDERS)[number];
export const NEW_REVIEW_ORDERS = ['after', 'before', 'mix'] as const;
export type NewReviewOrder = (typeof NEW_REVIEW_ORDERS)[number];

export interface ModelEvaluation {
  logLoss: number;
  rmseBins: number;
}

export type OptimizeStatus = 'optimized' | 'already_optimal' | 'not_enough_data';

export interface OptimizeResult {
  status: OptimizeStatus;
  cardCount: number;
  itemCount: number;
  reviewCount: number;
  current: ModelEvaluation | null;
  optimized: ModelEvaluation | null;
  recomputedCards: number;
}

export const STEP_LIMIT = 16;
export const MAX_STEP_MINUTES = 525_600;
export const MAX_INTERVAL_DAYS = 36_500;

const UNIT_MINUTES: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440 };

export const DEFAULT_SCHEDULER_EXTRAS = {
  learningSteps: [1, 10],
  relearningSteps: [10],
  dayRolloverHour: 4,
  maximumInterval: MAX_INTERVAL_DAYS,
  enableFuzz: true,
  fsrsParams: [] as number[],
  buryNewSiblings: true,
  buryReviewSiblings: true,
  reviewOrder: 'due' as ReviewOrder,
  newReviewOrder: 'after' as NewReviewOrder,
  maxAnswerSeconds: 60,
};

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return numbers.length === value.length ? numbers : null;
}

export function parseSchedulerConfig(raw: unknown): SchedulerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const read = (camel: string, snake: string): unknown => row[camel] ?? row[snake];
  const readNumber = (camel: string, snake: string): number | null => {
    const value = read(camel, snake);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const newPerDay = readNumber('newPerDay', 'new_per_day');
  const reviewsPerDay = readNumber('reviewsPerDay', 'reviews_per_day');
  const desiredRetention = readNumber('desiredRetention', 'desired_retention');
  if (newPerDay == null || reviewsPerDay == null || desiredRetention == null) return null;
  const enableFuzz = read('enableFuzz', 'enable_fuzz');
  const readBool = (camel: string, snake: string, fallback: boolean) => {
    const value = read(camel, snake);
    return typeof value === 'boolean' ? value : fallback;
  };
  const reviewOrder = read('reviewOrder', 'review_order');
  const newReviewOrder = read('newReviewOrder', 'new_review_order');
  return {
    newPerDay,
    reviewsPerDay,
    desiredRetention,
    learnAheadMinutes: readNumber('learnAheadMinutes', 'learn_ahead_minutes') ?? 15,
    learningSteps: readNumberArray(read('learningSteps', 'learning_steps')) ?? DEFAULT_SCHEDULER_EXTRAS.learningSteps,
    relearningSteps:
      readNumberArray(read('relearningSteps', 'relearning_steps')) ?? DEFAULT_SCHEDULER_EXTRAS.relearningSteps,
    dayRolloverHour: readNumber('dayRolloverHour', 'day_rollover_hour') ?? DEFAULT_SCHEDULER_EXTRAS.dayRolloverHour,
    maximumInterval: readNumber('maximumInterval', 'maximum_interval') ?? DEFAULT_SCHEDULER_EXTRAS.maximumInterval,
    enableFuzz: typeof enableFuzz === 'boolean' ? enableFuzz : DEFAULT_SCHEDULER_EXTRAS.enableFuzz,
    fsrsParams: readNumberArray(read('fsrsParams', 'fsrs_params')) ?? [],
    fsrsOptimizedAtMs: readNumber('fsrsOptimizedAtMs', 'fsrs_optimized_at_ms'),
    fsrsOptimizedReviewCount: readNumber('fsrsOptimizedReviewCount', 'fsrs_optimized_review_count'),
    buryNewSiblings: readBool('buryNewSiblings', 'bury_new_siblings', DEFAULT_SCHEDULER_EXTRAS.buryNewSiblings),
    buryReviewSiblings: readBool(
      'buryReviewSiblings',
      'bury_review_siblings',
      DEFAULT_SCHEDULER_EXTRAS.buryReviewSiblings,
    ),
    reviewOrder: (REVIEW_ORDERS as readonly unknown[]).includes(reviewOrder)
      ? reviewOrder as ReviewOrder
      : DEFAULT_SCHEDULER_EXTRAS.reviewOrder,
    newReviewOrder: (NEW_REVIEW_ORDERS as readonly unknown[]).includes(newReviewOrder)
      ? newReviewOrder as NewReviewOrder
      : DEFAULT_SCHEDULER_EXTRAS.newReviewOrder,
    maxAnswerSeconds: readNumber('maxAnswerSeconds', 'max_answer_seconds') ?? DEFAULT_SCHEDULER_EXTRAS.maxAnswerSeconds,
  };
}

function parseEvaluation(raw: unknown): ModelEvaluation | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const logLoss = row.logLoss ?? row.log_loss;
  const rmseBins = row.rmseBins ?? row.rmse_bins;
  return typeof logLoss === 'number' && typeof rmseBins === 'number' ? { logLoss, rmseBins } : null;
}

export function parseOptimizeResult(raw: unknown): OptimizeResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const status = row.status;
  if (status !== 'optimized' && status !== 'already_optimal' && status !== 'not_enough_data') return null;
  const count = (camel: string, snake: string) => {
    const value = row[camel] ?? row[snake];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    status,
    cardCount: count('cardCount', 'card_count'),
    itemCount: count('itemCount', 'item_count'),
    reviewCount: count('reviewCount', 'review_count'),
    current: parseEvaluation(row.current),
    optimized: parseEvaluation(row.optimized),
    recomputedCards: count('recomputedCards', 'recomputed_cards'),
  };
}

/** `1m 10m 1d` → 分钟数组；任何一项非法返回 null。空串 = 不使用学习步。 */
export function parseStepsInput(value: string): number[] | null {
  const tokens = value.trim().split(/[\s,，]+/).filter(Boolean);
  if (tokens.length > STEP_LIMIT) return null;
  const steps: number[] = [];
  for (const token of tokens) {
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(token);
    if (!match) return null;
    const minutes = Number(match[1]) * UNIT_MINUTES[(match[2] || 'm').toLowerCase()];
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_STEP_MINUTES) return null;
    steps.push(Math.round(minutes * 1000) / 1000);
  }
  return steps;
}

function formatStep(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  return `${Number.isInteger(minutes) ? minutes : Math.round(minutes * 100) / 100}m`;
}

export function formatSteps(steps: number[]): string {
  return steps.map(formatStep).join(' ');
}

export function stepsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
}

/** 任一学习步达到或超过 1 天：FSRS 建议学习步都在当天完成。 */
export function hasDayLongStep(steps: number[]): boolean {
  return steps.some((minutes) => minutes >= 1440);
}
