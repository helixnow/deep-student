/**
 * 记忆状态重算、进度重置与参数优化（拆分自 `review.ts`）。
 *
 * 重算窗口与快照回退规则对应 Rust `recompute_memory_states` / `load_review_histories`；
 * 参数优化对应 Rust `optimize_parameters`，训练/评估经 F7 fsrs 6.6.2 训练器端口（`fsrs-trainer.ts`）。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  buildFsrs, effectiveParameters, logicalDaysBetween, sanitizeSteps, type MemoryState,
} from './fsrs-scheduler.ts';
import {
  f32Json, f32Wire, isFsrsEngineError, type FsrsTrainer, type FsrsTrainingItem,
} from './fsrs-trainer.ts';
import { readConfigObjectExact, swapRemove } from './config-json.ts';
import {
  DEFAULT_DECK_ID, FSRS_PARAMS_VERSION, MS_PER_DAY, decodeStateBeforeSnapshot,
  type FsrsModelEvaluation, type FsrsOptimizeResult, type FsrsResetResult, type FsrsSchedulerConfig,
} from './fsrs-types.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { utcNow } from './clock.ts';
import { appError } from './errors.ts';
import type { ReviewRuntime } from './review-runtime.ts';
import * as repo from '../repository/fsrs.ts';

const MEMORY_STATE_VERSION_KEY = 'memory_state_version';

export function resetCardProgress(rt: ReviewRuntime, cardStateId: string): FsrsResetResult {
  if (rustTrim(cardStateId).length === 0) throw appError('Validation', 'cardStateId is required');
  const now = utcNow();
  const nowMs = now.ms;
  const result = rt.tx('immediate', tx => {
    const before = repo.loadStateById(tx, cardStateId);
    if (before === null) throw appError('NotFound', `fsrs card state not found: ${cardStateId}`);
    const config = repo.loadSchedulerConfig(tx, before.deckId ?? DEFAULT_DECK_ID, rt.warn);
    const clearedLogs = repo.deleteProgress(tx, cardStateId);
    const newId = repo.insertFreshState(
      tx, before.ankiCardId, before.deckId ?? DEFAULT_DECK_ID, nowMs,
      config.desiredRetention, now.rfc,
    );
    const state = repo.loadStateById(tx, newId);
    if (state === null) throw appError('Database', 'state missing after progress reset');
    return { state, clearedLogs };
  });
  rt.info(`[FsrsReviewService] reset progress: card_state ${cardStateId} -> ${result.state.id} (cleared ${result.clearedLogs} logs)`);
  return result;
}

export function ensureMemoryStatesCurrent(rt: ReviewRuntime): number {
  const recorded = repo.memoryStateVersion(rt.db);
  if (recorded === FSRS_PARAMS_VERSION) return 0;
  const now = utcNow().rfc;
  const updated = rt.tx('immediate', tx => {
    const config = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, rt.warn);
    const updatedCount = recomputeMemoryStates(rt, tx, config, now);
    repo.ensureDefaultDeck(tx, now);
    const value = readConfigObjectExact(repo.readConfigJsonText(tx, DEFAULT_DECK_ID));
    value[MEMORY_STATE_VERSION_KEY] = FSRS_PARAMS_VERSION;
    repo.writeConfigJson(tx, DEFAULT_DECK_ID, value, now);
    return updatedCount;
  });
  if (updated > 0) {
    rt.info(`[FsrsReviewService] recomputed ${updated} memory states for ${FSRS_PARAMS_VERSION}`);
  }
  return updated;
}

export function recomputeMemoryStates(
  rt: ReviewRuntime, tx: SqlExecutor, config: FsrsSchedulerConfig, now: string,
): number {
  const histories = loadReviewHistories(tx, config.dayRolloverHour);
  const fsrs = buildFsrs(config.fsrsParams);
  let updated = 0;
  for (const history of histories) {
    let memory: MemoryState;
    try {
      memory = fsrs.memoryState(history.reviews, history.starting);
    } catch {
      continue;
    }
    updated += repo.updateMemoryState(tx, history.cardStateId, memory.stability, memory.difficulty, now);
  }
  return updated;
}

function loadReviewHistories(db: SqlExecutor, rolloverHour: number): {
  cardStateId: string; starting: MemoryState | null; reviews: { rating: number; deltaT: number }[];
}[] {
  const histories: {
    cardStateId: string; starting: MemoryState | null; reviews: { rating: number; deltaT: number }[];
  }[] = [];
  let current: {
    cardStateId: string; starting: MemoryState | null; reviews: { rating: number; deltaT: number }[];
    previousMs: number | null; valid: boolean;
  } | null = null;
  const flush = (): void => {
    if (current !== null && current.valid && current.reviews.length > 0) {
      histories.push({
        cardStateId: current.cardStateId,
        starting: current.starting,
        reviews: current.reviews,
      });
    }
  };
  for (const row of repo.reviewHistoryRows(db)) {
    if (current === null || current.cardStateId !== row.cardStateId) {
      flush();
      let starting: MemoryState | null = null;
      let previousMs: number | null = null;
      let valid = true;
      if (row.stateBefore === 0) {
        starting = null;
        previousMs = null;
      } else if (row.stabilityBefore !== null && row.difficultyBefore !== null
        && row.stabilityBefore > 0 && Number.isFinite(row.stabilityBefore)
        && Number.isFinite(row.difficultyBefore)) {
        starting = { stability: row.stabilityBefore, difficulty: row.difficultyBefore };
        let snapshotLastReview: number | null = null;
        if (row.snapshotJson !== null) {
          snapshotLastReview = decodeStateBeforeSnapshot(row.snapshotJson)?.lastReviewMs ?? null;
        }
        previousMs = snapshotLastReview ?? (row.elapsedDays === null
          ? null
          : row.reviewMs - Math.round(Math.max(0, row.elapsedDays)) * MS_PER_DAY);
      } else {
        starting = null;
        previousMs = null;
        valid = false;
      }
      current = { cardStateId: row.cardStateId, starting, reviews: [], previousMs, valid };
    }
    if (!current.valid || row.rating < 1 || row.rating > 4) continue;
    const deltaT = current.previousMs === null
      ? 0
      : logicalDaysBetween(current.previousMs, row.reviewMs, rolloverHour);
    current.reviews.push({ rating: row.rating, deltaT });
    current.previousMs = row.reviewMs;
  }
  flush();
  return histories;
}

/** Rust `MIN_TRAINING_ITEMS`：可训练样本少于此数时不调用优化器。 */
const MIN_TRAINING_ITEMS = 8;

/**
 * Rust `training_items`（Anki 口径）：只用完整历史；每个「跨日复习」形成一个样本，
 * 样本包含该次复习及之前的全部复习。卡序号为 histories 下标（Rust `index as i64`）。
 */
function trainingItems(histories: ReturnType<typeof loadReviewHistories>): {
  items: FsrsTrainingItem[]; cardIds: number[]; reviewCount: number; cardCount: number;
} {
  const items: FsrsTrainingItem[] = [];
  const cardIds: number[] = [];
  let reviewCount = 0;
  let cardCount = 0;
  histories.forEach((history, index) => {
    if (history.starting !== null) return;
    let used = false;
    for (let end = 1; end < history.reviews.length; end++) {
      if (history.reviews[end]!.deltaT === 0) continue;
      items.push({
        reviews: history.reviews.slice(0, end + 1).map(review => ({ rating: review.rating, delta_t: review.deltaT })),
      });
      cardIds.push(index);
      used = true;
    }
    if (used) {
      cardCount += 1;
      reviewCount += history.reviews.length;
    }
  });
  return { items, cardIds, reviewCount, cardCount };
}

/** Rust 闭包 `evaluate`：`FSRS::new(params).ok()?` + `evaluate(..).ok()` + 有限性过滤。 */
async function evaluateParameters(
  trainer: FsrsTrainer, params: readonly number[], items: readonly FsrsTrainingItem[],
): Promise<FsrsModelEvaluation | null> {
  let evaluation;
  try {
    evaluation = await trainer.evaluate(params, items);
  } catch (error) {
    if (isFsrsEngineError(error)) return null;
    throw error;
  }
  const logLoss = Math.fround(evaluation.logLoss);
  const rmseBins = Math.fround(evaluation.rmseBins);
  if (!Number.isFinite(logLoss) || !Number.isFinite(rmseBins)) return null;
  return { logLoss: f32Wire(logLoss), rmseBins: f32Wire(rmseBins) };
}

/**
 * Rust `optimize_parameters`：用复习日志训练 FSRS 参数（fsrs-rs `compute_parameters`）。
 * 新参数 log loss 低于当前参数才写入，并按新参数重算记忆状态；否则保持不变。
 *
 * 训练器 reject 的非 fsrs 错误（引擎 trap/崩溃）原样抛出，由命令层按 Rust JoinError 包装。
 */
export async function optimizeParameters(rt: ReviewRuntime, trainer: FsrsTrainer): Promise<FsrsOptimizeResult> {
  const config = repo.loadSchedulerConfig(rt.db, DEFAULT_DECK_ID, rt.warn);
  const histories = loadReviewHistories(rt.db, config.dayRolloverHour);
  const { items, cardIds, reviewCount, cardCount } = trainingItems(histories);
  const currentParams = effectiveParameters(config.fsrsParams);
  const result: FsrsOptimizeResult = {
    status: 'not_enough_data',
    cardCount,
    itemCount: items.length,
    reviewCount,
    current: null,
    optimized: null,
    params: currentParams.map(f32Wire),
    recomputedCards: 0,
  };
  if (items.length < MIN_TRAINING_ITEMS) return result;

  result.current = await evaluateParameters(trainer, currentParams, items);
  let optimizedParams: number[];
  try {
    optimizedParams = (await trainer.optimize({
      trainSet: items,
      cardIds,
      enableShortTerm: true,
      numRelearningSteps: sanitizeSteps(config.relearningSteps).length,
    })).map(value => Math.fround(value));
  } catch (error) {
    if (isFsrsEngineError(error)) throw appError('Validation', `FSRS 参数优化失败: ${error.message}`);
    throw error;
  }
  result.optimized = await evaluateParameters(trainer, optimizedParams, items);

  const { current, optimized } = result;
  // f32 运算：`optimized.log_loss + 1e-6 < current.log_loss`。
  const improved = current !== null && optimized !== null
    ? Math.fround(Math.fround(optimized.logLoss) + Math.fround(1e-6)) < Math.fround(current.logLoss)
    : current === null && optimized !== null;
  if (!improved) {
    result.status = 'already_optimal';
    return result;
  }

  const now = utcNow();
  const applied = rt.tx('immediate', tx => {
    repo.ensureDefaultDeck(tx, now.rfc);
    const value = swapRemove(readConfigObjectExact(repo.readConfigJsonText(tx, DEFAULT_DECK_ID)), 'fsrsParams');
    value.fsrs_params = optimizedParams.map(f32Json);
    value.fsrs_optimized_at_ms = now.ms;
    value.fsrs_optimized_review_count = reviewCount;
    repo.writeConfigJson(tx, DEFAULT_DECK_ID, value, now.rfc);
    const appliedConfig = repo.loadSchedulerConfig(tx, DEFAULT_DECK_ID, rt.warn);
    return { config: appliedConfig, recomputed: recomputeMemoryStates(rt, tx, appliedConfig, now.rfc) };
  });
  result.recomputedCards = applied.recomputed;
  result.status = 'optimized';
  result.params = effectiveParameters(applied.config.fsrsParams).map(f32Wire);
  return result;
}
