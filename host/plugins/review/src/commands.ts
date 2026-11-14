/**
 * `fsrs_*` 命令层（Rust `src/cmd/fsrs_review.rs` 的 TypeScript 迁移）。
 *
 * - 打开复习队列时可回填记忆状态；统计查询保持只读；
 * - 评分 / 到期读取前后尽力补偿掌握度 outbox（失败只告警，不影响已提交结果）；
 * - 写操作成功后 emit `fsrs://changed`，无实际写入时不 emit。
 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import type {
  FsrsEnqueuedCard, FsrsOptimizeResult, FsrsPendingMasteryReview, FsrsSchedulerConfig,
  FsrsSchedulerConfigUpdate,
} from './fsrs-types.ts';
import { FSRS7_CURVE } from './fsrs7.ts';
import { f32Wire, type FsrsTrainer } from './fsrs-trainer.ts';
import { appError, errorText } from './errors.ts';
import { FsrsReviewService } from './review.ts';
import {
  buildFsrsChangedPayloadAfterWrite,
  buildFsrsEnqueueChangedPayload,
  type FsrsChangedPayload,
} from './fsrs-events.ts';

/** `FsrsSchedulerConfig.fsrs_params: Vec<f32>` serializes each weight as its shortest f32 decimal. */
function schedulerConfigWire(config: FsrsSchedulerConfig, trialV7 = false) {
  return { ...config, fsrsParams: config.fsrsParams.map(f32Wire), ...(trialV7 && { model: FSRS7_CURVE.model }) };
}

function logger(ctx: Context): ReturnType<Context['logger']> {
  return ctx.logger('review');
}

/** F7 `nativeFsrs` 在调用时解析：review 不强依赖 native 插件，缺失时按训练线程异常上报。 */
function nativeFsrsTrainer(ctx: Context): FsrsTrainer {
  const resolve = (): FsrsTrainer => {
    const fsrs = ctx.get('nativeFsrs') as FsrsTrainer | undefined;
    if (fsrs === undefined) throw new Error('nativeFsrs service is not available');
    return fsrs;
  };
  return {
    optimize: (input, options) => resolve().optimize(input, options),
    evaluate: (parameters, items, options) => resolve().evaluate(parameters, items, options),
  };
}

function service(ctx: Context, trialV7 = false): FsrsReviewService {
  return new FsrsReviewService(
    ctx.storage.database('mistakes'),
    message => logger(ctx).warn(message),
    message => logger(ctx).info(message),
    message => logger(ctx).debug(message),
    trialV7,
  );
}

function emitChanged(ctx: Context, payload: FsrsChangedPayload | null): void {
  if (payload === null) return;
  try {
    ctx.backendEvents.emit('fsrs://changed', payload);
  } catch (error) {
    // Rust: app.emit 失败只记 debug，命令仍返回已提交结果。
    logger(ctx).debug('[fsrs_review] Failed to emit fsrs://changed: %s', errorText(error));
  }
}

/** Rust `emit_fsrs_enqueue_changed`：读取新增卡片失败时只记 debug 并跳过 emit。 */
function emitEnqueueChanged(
  ctx: Context,
  svc: FsrsReviewService,
  result: Parameters<FsrsReviewService['getEnqueuedCards']>[0],
): void {
  let cards: FsrsEnqueuedCard[];
  try {
    cards = svc.getEnqueuedCards(result);
  } catch (error) {
    logger(ctx).debug(
      '[fsrs_review] Failed to load newly enqueued cards for fsrs://changed: %s',
      errorText(error),
    );
    return;
  }
  emitChanged(ctx, buildFsrsEnqueueChangedPayload(result, cards, 'user'));
}

/** 调度器换代后的一次性记忆状态重算；失败只告警，不阻塞读取。 */
function ensureMemoryStatesCurrent(ctx: Context, svc: FsrsReviewService, caller: string): void {
  try {
    svc.ensureMemoryStatesCurrent();
  } catch (error) {
    logger(ctx).warn('[%s] memory state upgrade failed: %s', caller, errorText(error));
  }
}

/** 读取卡片 concept tags 与掌握度分数（供 rate / preview 共用）。 */
function prefetchMasteryForCard(
  ctx: Context,
  svc: FsrsReviewService,
  cardStateId: string,
): { tags: string[]; score: number | null } {
  let ankiCardId: string | undefined;
  try {
    ankiCardId = svc.getCardState(cardStateId)?.ankiCardId;
  } catch {
    // Rust `get_card_state(...).ok().flatten()`：读取失败按无掌握度处理。
    return { tags: [], score: null };
  }
  if (ankiCardId === undefined) return { tags: [], score: null };
  let tags: string[];
  try {
    tags = svc.getCardConceptTags(ankiCardId);
  } catch (error) {
    logger(ctx).warn('[fsrs_rate] failed to load card tags for mastery bias: %s', errorText(error));
    return { tags: [], score: null };
  }
  const concept = tags.map(rustTrim).find(tag => tag.length > 0);
  if (concept === undefined) return { tags, score: null };
  try {
    return { tags, score: ctx.mastery.getState(concept)?.score ?? null };
  } catch {
    return { tags, score: null };
  }
}

/** `failureFormat` carries the exact Rust warn! text for each call site (cmd/fsrs_review.rs). */
function loadPendingMastery(ctx: Context, svc: FsrsReviewService, failureFormat: string): FsrsPendingMasteryReview[] {
  try {
    return svc.pendingMasteryReviews(100);
  } catch (error) {
    logger(ctx).warn(failureFormat, errorText(error));
    return [];
  }
}

function confirmMasterySynced(
  ctx: Context,
  svc: FsrsReviewService,
  logId: string,
  failureFormat: string,
): void {
  try {
    svc.markMasteryReviewSynced(logId);
  } catch (error) {
    logger(ctx).warn(failureFormat, logId, errorText(error));
  }
}

/** Rust `.is_ok()` / `matches!(.., Ok(..))` on a best-effort call: errors become `false`, unlogged. */
function succeeded(run: () => boolean): boolean {
  try {
    return run();
  } catch {
    return false;
  }
}

/**
 * `fsrs_get_due` 的补偿循环：读取/确认失败不能让到期列表整体失败。
 * 标签读取失败 ≠ 无标签，Err 时保留 pending 等待下次补偿。
 */
function compensateMasteryOutboxOnRead(ctx: Context, svc: FsrsReviewService): void {
  for (const pending of loadPendingMastery(ctx, svc, '[fsrs_get_due] mastery outbox query failed: %s')) {
    let reconciled = false;
    if (pending.revert) {
      // Rust `matches!(revert(..), Ok(Some(_)))`: a failed revert stays pending without a log.
      reconciled = succeeded(() => ctx.mastery.revertFsrsRatingForLog(pending.logId) !== null);
    } else {
      let tags: string[];
      try {
        tags = svc.getCardConceptTags(pending.ankiCardId);
      } catch (error) {
        logger(ctx).warn(
          '[fsrs_get_due] tag lookup failed for card %s; mastery review %s stays pending: %s',
          pending.ankiCardId,
          pending.logId,
          errorText(error),
        );
        continue;
      }
      // Rust `tags.is_empty() || record(..).is_ok()`: a failed write stays pending without a log.
      reconciled = tags.length === 0 || succeeded(() => {
        ctx.mastery.recordFsrsRatingForLog(pending.logId, pending.ankiCardId, tags, pending.rating);
        return true;
      });
    }
    if (reconciled) confirmMasterySynced(ctx, svc, pending.logId, '[fsrs_get_due] failed to confirm mastery row %s: %s');
  }
}

const RATE_RETRY_DELAYS_MS = [20, 40] as const;

/**
 * `fsrs_rate` 的补偿循环。评分事务此时已经提交，任何失败都不得让命令返回错误，
 * 否则前端会把已落库的评分当成失败并重试产生二次评分。
 */
async function compensateMasteryOutboxAfterRate(
  ctx: Context,
  svc: FsrsReviewService,
  resultLogId: string,
  preTags: readonly string[],
): Promise<void> {
  for (const pending of loadPendingMastery(
    ctx, svc, '[fsrs_rate] mastery outbox query failed after commit; rating stays committed: %s',
  )) {
    if (pending.revert) {
      try {
        if (ctx.mastery.revertFsrsRatingForLog(pending.logId) !== null) {
          confirmMasterySynced(ctx, svc, pending.logId, '[fsrs_rate] failed to confirm mastery revert for %s: %s');
        } else {
          logger(ctx).debug('[fsrs_rate] mastery revert stays pending; event not present for %s', pending.logId);
        }
      } catch (error) {
        logger(ctx).warn(
          '[fsrs_rate] mastery revert compensation failed for review log %s: %s',
          pending.logId,
          errorText(error),
        );
      }
      continue;
    }
    let tags: string[];
    if (pending.logId === resultLogId && preTags.length > 0) {
      tags = [...preTags];
    } else {
      try {
        tags = svc.getCardConceptTags(pending.ankiCardId);
      } catch (error) {
        logger(ctx).warn(
          '[fsrs_rate] tag lookup failed for card %s; mastery review %s stays pending: %s',
          pending.ankiCardId,
          pending.logId,
          errorText(error),
        );
        continue;
      }
    }
    if (tags.length === 0) {
      confirmMasterySynced(ctx, svc, pending.logId, '[fsrs_rate] failed to confirm tagless mastery row %s: %s');
      continue;
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        ctx.mastery.recordFsrsRatingForLog(pending.logId, pending.ankiCardId, tags, pending.rating);
        confirmMasterySynced(ctx, svc, pending.logId, '[fsrs_rate] failed to confirm mastery row %s: %s');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, RATE_RETRY_DELAYS_MS[attempt]));
        }
      }
    }
    if (lastError !== null) {
      logger(ctx).warn(
        '[fsrs_rate] mastery compensation failed for review log %s: %s',
        pending.logId,
        errorText(lastError),
      );
    }
  }
}

interface FsrsEnqueueArgs { ankiCardIds: string[] }
interface LimitArgs { limit?: number | null; readOnly?: boolean | null }
interface RecentLimitArgs { recentLimit?: number | null }
interface DaysArgs { days?: number | null }
interface CardStateArgs { cardStateId: string }
interface RateArgs {
  cardStateId: string;
  rating: number;
  durationMs?: number | null;
  clientOpId?: string | null;
  enforceExpectedLastReview?: boolean | null;
  expectedLastReviewMs?: number | null;
}
interface UndoArgs { expectedLogId: string; cardStateId: string }
interface UpdateConfigArgs { update: FsrsSchedulerConfigUpdate }

/**
 * `fsrs_optimize_parameters`（Rust `cmd/fsrs_review.rs:570-591`）。
 *
 * Rust 在 `spawn_blocking` 中运行 `optimize_parameters`：无进度事件、不可取消；服务返回的
 * AppError 原样透传（`??`），线程 panic 映射为 `AppError::internal("FSRS 参数优化任务异常: …")`
 * （error_type Unknown）。TS 中训练器 trap/崩溃等非 AppError 拒绝走同一映射。成功后按
 * `recomputed_cards > 0` 发 `fsrs://changed`（user/optimize，无卡片实体）。
 */
export async function fsrsOptimizeParameters(ctx: Context, trainer: FsrsTrainer): Promise<FsrsOptimizeResult> {
  let result: FsrsOptimizeResult;
  try {
    result = await service(ctx).optimizeParameters(trainer);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw appError('Unknown', `FSRS 参数优化任务异常: ${errorText(error)}`);
  }
  emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(result.recomputedCards > 0, 'user', 'optimize', [], []));
  return result;
}

/** 注册全部 `fsrs_*` 命令。 */
export function registerFsrsCommands(ctx: Context, trialV7 = false): void {
  const reviewService = () => service(ctx, trialV7);
  const unsupportedInTrial = () => appError('Validation', 'This command uses the FSRS-6 model and is unavailable in the isolated FSRS trial');
  ctx.commands.register<FsrsEnqueueArgs>('fsrs_enqueue_cards', ({ ankiCardIds }) => {
    const svc = reviewService();
    const result = svc.enqueueCards(ankiCardIds);
    emitEnqueueChanged(ctx, svc, result);
    return result;
  });

  ctx.commands.register<LimitArgs>('fsrs_get_due', ({ limit, readOnly }) => {
    const svc = reviewService();
    if (!readOnly) {
      if (!trialV7) ensureMemoryStatesCurrent(ctx, svc, 'fsrs_get_due');
      compensateMasteryOutboxOnRead(ctx, svc);
    }
    return svc.getDue(limit ?? null);
  });

  ctx.commands.register<CardStateArgs>('fsrs_preview_intervals', ({ cardStateId }) => {
    const svc = reviewService();
    const { score } = prefetchMasteryForCard(ctx, svc, cardStateId);
    return svc.previewIntervals(cardStateId, score);
  });

  ctx.commands.register<RateArgs>('fsrs_rate', async args => {
    const svc = reviewService();
    const { tags, score } = prefetchMasteryForCard(ctx, svc, args.cardStateId);
    const result = svc.rateWithMasteryBiasCas(
      args.cardStateId,
      args.rating,
      args.durationMs ?? null,
      score,
      args.clientOpId ?? null,
      args.enforceExpectedLastReview ?? false,
      args.expectedLastReviewMs ?? null,
    );
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      true,
      'user',
      'rate',
      [[result.cardState.id, result.cardState.ankiCardId]],
      [],
      [result.logId],
    ));
    await compensateMasteryOutboxAfterRate(ctx, svc, result.logId, tags);
    return result;
  });

  ctx.commands.register<UndoArgs>('fsrs_undo_last_review', ({ expectedLogId, cardStateId }) => {
    const svc = reviewService();
    const result = svc.undoLastReview(expectedLogId, cardStateId);
    try {
      if (ctx.mastery.revertFsrsRatingForLog(expectedLogId) !== null) {
        confirmMasterySynced(ctx, svc, expectedLogId, '[fsrs_undo] failed to confirm mastery revert for %s: %s');
      } else {
        logger(ctx).debug('[fsrs_undo] mastery revert remains pending until event %s is observed', expectedLogId);
      }
    } catch (error) {
      logger(ctx).warn(
        '[fsrs_undo] durable mastery revert remains pending for %s: %s',
        expectedLogId,
        errorText(error),
      );
    }
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      result.changed, 'user', 'undo',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });

  ctx.commands.register<CardStateArgs>('fsrs_suspend_card', ({ cardStateId }) => {
    const result = reviewService().suspendCard(cardStateId);
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      result.changed, 'user', 'suspend',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });

  ctx.commands.register<CardStateArgs>('fsrs_bury_card', ({ cardStateId }) => {
    const result = reviewService().setBuried(cardStateId, true);
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      result.changed, 'user', 'bury',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });

  ctx.commands.register<CardStateArgs>('fsrs_unbury_card', ({ cardStateId }) => {
    const result = reviewService().setBuried(cardStateId, false);
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      result.changed, 'user', 'unbury',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });

  ctx.commands.register<CardStateArgs>('fsrs_unsuspend_card', ({ cardStateId }) => {
    const result = reviewService().unsuspendCard(cardStateId);
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      result.changed, 'user', 'unsuspend',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });

  ctx.commands.register('fsrs_get_stats', () => reviewService().getStats());

  ctx.commands.register<DaysArgs>('fsrs_get_review_statistics', ({ days }) => {
    return reviewService().getReviewStatistics(days ?? null);
  });

  ctx.commands.register<RecentLimitArgs>('fsrs_get_memory_overview', ({ recentLimit }) => {
    return reviewService().getMemoryOverview(recentLimit ?? null);
  });

  ctx.commands.register<CardStateArgs>('fsrs_get_card_memory_history', ({ cardStateId }) => {
    return reviewService().getCardMemoryHistory(cardStateId);
  });

  ctx.commands.register('fsrs_get_scheduler_config', () =>
    schedulerConfigWire(reviewService().getSchedulerConfig(), trialV7));

  ctx.commands.register<UpdateConfigArgs>('fsrs_update_scheduler_config', ({ update }) => {
    if (trialV7 && update.fsrsParams != null) throw unsupportedInTrial();
    return schedulerConfigWire(reviewService().updateSchedulerConfig(update), trialV7);
  });

  ctx.commands.register('fsrs_optimize_parameters', () => {
    if (trialV7) throw unsupportedInTrial();
    return fsrsOptimizeParameters(ctx, nativeFsrsTrainer(ctx));
  });

  ctx.commands.register<CardStateArgs>('fsrs_reset_card_progress', ({ cardStateId }) => {
    const result = reviewService().resetCardProgress(cardStateId);
    emitChanged(ctx, buildFsrsChangedPayloadAfterWrite(
      true, 'user', 'reset',
      [[result.state.id, result.state.ankiCardId]], [],
    ));
    return result;
  });
}

