/** goal_executor.rs:120–385 `GoalExecutor` over the L04 goal repository. */
import {
  buildGoalUpdatedPayload, goalGetWithConn, goalInsertWithConn, goalUpdateStatusWithConn,
  type ExecutionContext, type GoalRecord, type ToolCall, type ToolResultInfo, type ToolSensitivity,
} from '../../chat/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { GOAL_CREATE, GOAL_GET, GOAL_UPDATE, goalToolSchemas } from './goal-tools.ts';

export const GOAL_EXECUTOR_NAME = 'GoalExecutor';
const MODEL_SETTABLE_STATUSES = ['complete', 'blocked', 'waiting_user'];

type Log = (message: string) => void;
const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** goal_executor.rs:159–168: absent/null → None; otherwise a positive i64. */
function parseTokenBudget(args: unknown): number | null {
  const raw = field(args, 'token_budget');
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  throw new Error('token_budget 必须是正整数');
}

export class GoalExecutor {
  private readonly info: Log;
  private readonly warn: Log;
  private readonly now: () => number;
  constructor(log: { info: Log; warn: Log }, now: () => number = Date.now) {
    this.info = log.info; this.warn = log.warn; this.now = now;
  }

  canHandle(toolName: string): boolean {
    const bare = strip_tool_namespace(toolName);
    return bare === GOAL_CREATE || bare === GOAL_UPDATE || bare === GOAL_GET;
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: Record<string, unknown> | undefined;
    let error: string | undefined;
    try {
      switch (strip_tool_namespace(call.name)) {
        case GOAL_CREATE: output = this.create(call.arguments, ctx); break;
        case GOAL_UPDATE: output = this.update(call.arguments, ctx); break;
        case GOAL_GET: output = this.get(ctx); break;
        default: throw new Error(`未知的 Goal 工具: ${call.name}`);
      }
    } catch (cause) { error = errorText(cause); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (output !== undefined) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      this.info(`[GoalExecutor] Tool ${call.name} completed`);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(error!);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: error!, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.warn(`[GoalExecutor] Failed to save tool block: ${errorText(cause)}`); }
    return result;
  }

  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  name(): string { return GOAL_EXECUTOR_NAME; }
  /** registry.rs:191–221: continuation rounds inject these through `schema_tool_ids`. */
  schemaTools(): { id: string; schema: unknown }[] {
    return goalToolSchemas().map(schema => ({ id: schema.function.name, schema }));
  }

  private withConn<T>(ctx: ExecutionContext, operation: (conn: DatabaseHandle) => T): T {
    if (ctx.chat_v2_db === null) throw new Error('chat_v2_db unavailable in ExecutionContext');
    const conn = ctx.chat_v2_db.getConnSafe();
    return operation(conn);
  }

  /** Windowless (headless/test) runs skip the event; the goal runtime re-emits at turn end. */
  private emitGoalUpdated(ctx: ExecutionContext, goal: GoalRecord | null): void {
    if (ctx.tryWindow() === null) return;
    try { ctx.services.backendEvents.emit(`chat_v2_session_${ctx.session_id}`, buildGoalUpdatedPayload(ctx.session_id, goal)); }
    catch (cause) { this.warn(`[GoalExecutor] Failed to emit goal_updated event: ${errorText(cause)}`); }
  }

  private create(args: unknown, ctx: ExecutionContext): Record<string, unknown> {
    const rawObjective = field(args, 'objective');
    if (typeof rawObjective !== 'string') throw new Error('缺少必需参数: objective');
    const objective = rustTrim(rawObjective);
    if (objective === '') throw new Error('objective 不能为空');
    const tokenBudget = parseTokenBudget(args);
    const existing = this.withConn(ctx, conn => goalGetWithConn(conn, ctx.session_id));
    if (existing !== null && existing.status !== 'complete') {
      throw new Error('cannot create a new goal because this session has an unfinished goal; complete the existing goal first or ask the user to clear it');
    }
    const now = this.now();
    const record: GoalRecord = {
      sessionId: ctx.session_id, goalId: `goal_${globalThis.crypto.randomUUID().replaceAll('-', '')}`, objective, status: 'active',
      tokenBudget, tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: now, updatedAtMs: now,
    };
    this.withConn(ctx, conn => goalInsertWithConn(conn, record));
    this.emitGoalUpdated(ctx, record);
    return { success: true, goal: record,
      message: '目标已激活。它跨轮次持续存在，本轮结束后会自动续跑。推进过程中保持目标完整，不要缩小范围；确证全部完成后再调用 goal_update(complete)。' };
  }

  private update(args: unknown, ctx: ExecutionContext): Record<string, unknown> {
    const status = field(args, 'status');
    if (typeof status !== 'string') throw new Error('缺少必需参数: status');
    if (!MODEL_SETTABLE_STATUSES.includes(status)) {
      throw new Error('update_goal can only mark the existing goal complete, blocked, or waiting_user; pause, resume, and budget-related status changes are controlled by the user or system');
    }
    const existing = this.withConn(ctx, conn => goalGetWithConn(conn, ctx.session_id));
    if (existing === null) throw new Error('cannot update goal because this session has no goal');
    const updated = this.withConn(ctx, conn => goalUpdateStatusWithConn(conn, ctx.session_id, existing.goalId, status));
    if (updated === null) throw new Error('goal was modified concurrently; call goal_get to fetch the latest state and retry');
    this.emitGoalUpdated(ctx, updated);
    const message = status === 'complete' ? '目标已标记完成，自动续跑停止。'
      : status === 'blocked' ? '目标已标记阻塞，自动续跑停止。向用户说明阻塞原因与需要的帮助。'
        : '目标已挂起等待用户输入。用户回复后目标将继续推进。';
    return { success: true, goal: updated, message };
  }

  private get(ctx: ExecutionContext): Record<string, unknown> {
    const goal = this.withConn(ctx, conn => goalGetWithConn(conn, ctx.session_id));
    const remaining = goal?.tokenBudget == null ? 'unbounded' : goal.tokenBudget - goal.tokensUsed;
    const message = goal !== null
      ? '目标存在。推进过程中保持目标完整，不要缩小范围；确证全部完成后再调用 goal_update(complete)。'
      : '当前会话没有目标。只有用户明确提出需要多步推进的目标时才调用 goal_create。';
    return { success: true, goal, remaining_tokens: remaining, message };
  }
}
