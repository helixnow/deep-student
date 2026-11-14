/**
 * `insight_*` 命令层（Rust `src-tauri/src/insight/handlers.rs`）。
 *
 * 灵感卡的存储、修订、关系与巩固任务属于记忆/研究服务；本插件只保留命令名、
 * 参数名与顺序、handler 默认值（列表 100/0、事件 50、任务 5）、错误类型。
 * 服务由对应 lane 通过 Cordis 服务 `insight` 发布；未安装时按 Rust
 * `VFS 数据库未初始化` 的数据库错误失败。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError, type IpcInteger } from '../../../kernel/api.ts';
import {
  AppErrorType, type AppError as AppErrorValue,
} from '../../../platform/errors/api.ts';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type {} from '../../memory/api.ts';
import type { InsightCommandService } from '../../memory/api.ts';
import { appError } from './errors.ts';

export const INSIGHT_SERVICE = 'insight';

const APP_ERROR_TYPES = new Set<string>(Object.values(AppErrorType));

function isAppErrorValue(value: unknown): value is AppErrorValue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.error_type === 'string'
    && APP_ERROR_TYPES.has(candidate.error_type)
    && typeof candidate.message === 'string'
    && 'details' in candidate;
}

function isCommandErrorValue(error: unknown): error is CommandError {
  return error instanceof CommandError
    || (typeof error === 'object' && error !== null
      && (error as Error).name === 'CommandError' && 'value' in error);
}

/**
 * L15 owns the IPC command boundary. Preserve an existing CommandError; convert
 * only a structured AppError published by the insight service. Unknown errors
 * are rethrown unchanged so the kernel still reports a real panic rather than
 * silently masking an unclassified failure.
 */
function rethrowInsightError(error: unknown): never {
  if (isCommandErrorValue(error)) throw error;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { appError?: unknown; value?: unknown };
    if (isAppErrorValue(candidate.appError)) throw new CommandError(candidate.appError);
    if (isAppErrorValue(candidate.value)) throw new CommandError(candidate.value);
  }
  if (isAppErrorValue(error)) throw new CommandError(error);
  throw error;
}

async function invokeInsight<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    rethrowInsightError(error);
  }
}

export function insightService(ctx: Context): InsightCommandService {
  const service = ctx.get(INSIGHT_SERVICE) as InsightCommandService | undefined;
  if (service === undefined) throw appError('Database', 'VFS 数据库未初始化');
  return service;
}

interface InsightIdArgs { insightId: string }
interface ListArgs { status?: string | null; limit?: IpcInteger | null; offset?: IpcInteger | null }
interface EventsArgs { insightId: string; limit?: number | null }
interface FeedbackArgs { insightId: string; feedback: string; sessionId?: string | null }
interface RelationArgs {
  fromId: string; toId: string; relationType: string;
  scope?: string | null; evidence?: string | null;
}

export function registerInsightCommands(ctx: Context): void {
  ctx.commands.register<{ input: Wire.InsightDraftInput }>('insight_create_draft', ({ input }) =>
    invokeInsight(() => insightService(ctx).createDraft(input)));

  ctx.commands.register<{ insightId: string; edits?: Wire.InsightCorrectInput | null }>(
    'insight_confirm', ({ insightId, edits }) =>
      invokeInsight(() => insightService(ctx).confirm(insightId, edits ?? null)));

  ctx.commands.register<{ insightId: string; input: Wire.InsightCorrectInput }>(
    'insight_correct', ({ insightId, input }) =>
      invokeInsight(() => insightService(ctx).correct(insightId, input)));

  ctx.commands.register<InsightIdArgs>('insight_delete', ({ insightId }) =>
    invokeInsight(async () => {
      await insightService(ctx).delete(insightId);
      return null;
    }));

  ctx.commands.register<InsightIdArgs>('insight_get', ({ insightId }) =>
    invokeInsight(() => insightService(ctx).getInsight(insightId)));

  ctx.commands.register<ListArgs>('insight_list', ({ status, limit, offset }) =>
    invokeInsight(() => insightService(ctx).listInsights(status ?? null, limit ?? 100, offset ?? 0)));

  ctx.commands.register<InsightIdArgs>('insight_list_revisions', ({ insightId }) =>
    invokeInsight(() => insightService(ctx).listRevisions(insightId)));

  ctx.commands.register<InsightIdArgs>('insight_list_evidence', ({ insightId }) =>
    invokeInsight(() => insightService(ctx).listEvidence(insightId)));

  ctx.commands.register<InsightIdArgs>('insight_list_relations', ({ insightId }) =>
    invokeInsight(() => insightService(ctx).listRelations(insightId)));

  ctx.commands.register<EventsArgs>('insight_list_events', ({ insightId, limit }) =>
    invokeInsight(() => insightService(ctx).listEvents(insightId, limit ?? 50)));

  ctx.commands.register<FeedbackArgs>('insight_record_feedback', ({ insightId, feedback, sessionId }) =>
    invokeInsight(async () => {
      await insightService(ctx).recordFeedback(insightId, feedback, sessionId ?? null);
      return null;
    }));

  ctx.commands.register<RelationArgs>('insight_add_relation', ({
    fromId, toId, relationType, scope, evidence,
  }) => invokeInsight(() => insightService(ctx).addRelation(
    fromId, toId, relationType, scope ?? null, evidence ?? null)));

  ctx.commands.register<{ batchSize?: number | null }>('insight_run_jobs', ({ batchSize }) =>
    invokeInsight(() => insightService(ctx).runJobs(batchSize ?? 5)));
}
