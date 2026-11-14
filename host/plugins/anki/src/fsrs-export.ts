/**
 * 导出侧 FSRS 进度（`dstu-anki/src/fsrs_review_service.rs:3947-4032`）。
 *
 * 读取调度配置与卡片状态，构造 `AnkiFsrs` 元数据（`apkg_exporter_service.rs`
 * 的 `fsrs_sched_restore` 消费它回写 Anki 排期）。纯数据变换，SQL 在仓储层。
 */

/** `FsrsSchedulerConfig::default()` 中导出用到的三个字段。 */
export interface ExportSchedulerConfig {
  desiredRetention: number;
  dayRolloverHour: number;
  fsrsParams: number[];
}

export const DEFAULT_EXPORT_SCHEDULER_CONFIG: ExportSchedulerConfig = {
  desiredRetention: 0.9,
  dayRolloverHour: 4,
  fsrsParams: [],
};

/** 与 `fsrs` crate 6.6.2 / L15 移植一致的 FSRS-5 默认参数。 */
const DEFAULT_PARAMETERS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const FSRS5_DEFAULT_DECAY = 0.5;
const DECAY_RANGE: readonly [number, number] = [0.1, 0.8];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `load_scheduler_config`（`fsrs_review_service.rs:5080-5195`）的导出相关子集：
 * 兼容 snake_case 存量与 camelCase 写入方；非法 JSON 回退默认值。
 */
export function parseExportSchedulerConfig(raw: string | null): ExportSchedulerConfig {
  if (raw === null) return { ...DEFAULT_EXPORT_SCHEDULER_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return { ...DEFAULT_EXPORT_SCHEDULER_CONFIG };
    throw error;
  }
  if (!isObject(parsed)) return { ...DEFAULT_EXPORT_SCHEDULER_CONFIG };
  const value = parsed;
  const field = (snake: string, camel: string): unknown =>
    Object.hasOwn(value, snake) ? value[snake] : Object.hasOwn(value, camel) ? value[camel] : null;

  let desiredRetention = DEFAULT_EXPORT_SCHEDULER_CONFIG.desiredRetention;
  const retention = field('desired_retention', 'desiredRetention');
  if (typeof retention === 'number' && Number.isFinite(retention) && retention > 0 && retention < 1) {
    desiredRetention = retention;
  }

  let dayRolloverHour = DEFAULT_EXPORT_SCHEDULER_CONFIG.dayRolloverHour;
  const rollover = field('day_rollover_hour', 'dayRolloverHour');
  if (typeof rollover === 'number' && Number.isInteger(rollover) && rollover >= 0 && rollover <= 23) {
    dayRolloverHour = rollover;
  }

  let fsrsParams: number[] = [];
  const params = field('fsrs_params', 'fsrsParams');
  if (Array.isArray(params)) {
    const parsedParams = params
      .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      .map((item) => Math.fround(item));
    if (parsedParams.length === params.length && parametersUsable(parsedParams)) {
      fsrsParams = parsedParams;
    }
  }

  return { desiredRetention, dayRolloverHour, fsrsParams };
}

/** `fsrs::check_and_fill_parameters(params).is_ok()`：17 / 19 / 21 个有限 f32。 */
function parametersUsable(params: readonly number[]): boolean {
  return (params.length === 17 || params.length === 19 || params.length === 21)
    && params.every((value) => Number.isFinite(value));
}

/** `effective_parameters`（`dstu-learning/src/fsrs_scheduler.rs:404-406`）。 */
function effectiveParameters(params: readonly number[]): number[] {
  let filled: number[];
  if (params.length === 0) {
    filled = [...DEFAULT_PARAMETERS];
  } else if (params.length === 17) {
    filled = [...params];
    filled[4] = filled[5]! * 2 + filled[4]!;
    filled[5] = Math.log(filled[5]! * 3 + 1) / 3;
    filled[6] = filled[6]! + 0.5;
    filled.push(0, 0, 0, FSRS5_DEFAULT_DECAY);
  } else if (params.length === 19) {
    filled = [...params, 0, FSRS5_DEFAULT_DECAY];
  } else if (params.length === 21) {
    filled = [...params];
  } else {
    return [...DEFAULT_PARAMETERS];
  }
  if (filled.some((value) => !Number.isFinite(value))) return [...DEFAULT_PARAMETERS];
  return filled;
}

/**
 * `forgetting_curve_constants(params).decay` 的绝对值（`fsrs_scheduler.rs:414-419`）。
 * `load_export_progress` 写入 `-config.forgetting_curve().decay`，即裁剪后的 w[20]。
 */
export function exportDecay(params: readonly number[]): number {
  const effective = effectiveParameters(params);
  return Math.min(DECAY_RANGE[1], Math.max(DECAY_RANGE[0], effective[20]!));
}

/** `fsrs_card_states` 的导出读取结果（`STATE_COLUMNS`）。 */
export interface ExportCardState {
  id: string;
  ankiCardId: string;
  state: number;
  stability: number | null;
  difficulty: number | null;
  scheduledDays: number;
  reps: number;
  lapses: number;
  dueMs: number;
  lastReviewMs: number | null;
  suspended: boolean;
  desiredRetention: number | null;
}

/** `fsrs_review_logs` 的一条复习记录（导出 `rev` 数组的元素来源）。 */
export interface ExportReviewLog {
  reviewMs: number;
  rating: number;
  stateBefore: number;
  stateAfter: number;
  scheduledDays: number;
  dueAfterMs: number | null;
  durationMs: number | null;
}

export interface ExportProgressValue {
  v: 1;
  state: number;
  s: number | null;
  d: number | null;
  dr: number;
  decay: number;
  ivl: number;
  due: number;
  lrt: number | null;
  reps: number;
  lapses: number;
  susp: boolean;
  rollover: number;
  rev: Array<[number, number, number, number, number, number | null, number | null]>;
}

/** `load_export_progress` 的 JSON 构造（字段顺序与 `json!` 宏一致）。 */
export function buildExportProgressValue(
  state: ExportCardState,
  reviews: readonly ExportReviewLog[],
  config: ExportSchedulerConfig,
): ExportProgressValue {
  return {
    v: 1,
    state: state.state,
    s: state.stability,
    d: state.difficulty,
    dr: state.desiredRetention ?? config.desiredRetention,
    decay: exportDecay(config.fsrsParams),
    ivl: state.scheduledDays,
    due: state.dueMs,
    lrt: state.lastReviewMs,
    reps: state.reps,
    lapses: state.lapses,
    susp: state.suspended,
    rollover: config.dayRolloverHour,
    rev: reviews.map((log) => [
      log.reviewMs,
      log.rating,
      log.stateBefore,
      log.stateAfter,
      log.scheduledDays,
      log.dueAfterMs,
      log.durationMs,
    ]),
  };
}
