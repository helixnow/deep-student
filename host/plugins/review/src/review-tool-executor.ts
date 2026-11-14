/**
 * `review_*` agent tools — Rust `src-tauri/src/chat_v2/tools/review_executor.rs`.
 *
 * All business logic goes through `ReviewPlanService` (SM-2); card_id → question_id
 * resolution reuses the qbank service, as in Rust. Successful mutations broadcast
 * `review://changed` with the same payloads and timing as Rust.
 */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { get_string_array_arg, strip_tool_namespace, with_localized_message, type JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim, takeChars } from '../../../platform/util/portable.ts';
import type { Question } from '../../vfs-repos/api.ts';
import type { ReviewPlanService } from './review-plan.ts';
import type { DueReviewsFilter, ReviewPlan, ReviewPlanStatus } from './review-plan-types.ts';
import {
  argsObject, asBool, asI64, asStr, asU64, compareRustStrings, runToolWithEvents, toolErrorText,
  u64AsU32, type ToolLog,
} from './tool-execution.ts';

export const REVIEW_CHANGED_EVENT = 'review://changed';

/** review_executor.rs:47 — 到期查询单页上限。 */
const MAX_DUE_LIMIT = 100;
/** review_executor.rs:51 — 批量安排复习计划的单次题目数上限。 */
const MAX_SCHEDULE_BATCH = 500;

export const REVIEW_TOOL_NAMES = [
  'review_get_due', 'review_schedule', 'review_plan_generate', 'review_submit',
  'review_stats', 'review_suspend', 'review_resume', 'review_delete',
] as const;

export interface ReviewToolQuestionBank {
  getQuestionByCardId(examId: string, cardId: string): Pick<Question, 'id'> | null;
}

export interface ReviewToolDeps {
  /** `ReviewPlanService::new(ctx.vfs_db)`; `null` ⇔ Rust `ctx.vfs_db == None`. */
  service(): ReviewPlanService | null;
  /** `VfsQuestionRepo::get_question(vfs_db, id)`; `null` when the VFS database is unavailable. */
  getQuestion(questionId: string): Question | null;
  /** `ctx.services.get::<QuestionBankService>()`. */
  questionBank(): ReviewToolQuestionBank | null;
  /** Tauri `Emitter::emit` (broadcast to every webview). */
  emit(event: string, payload: unknown): void;
  log: ToolLog;
}

type Args = Record<string, unknown>;

/** review_executor.rs:67 `validate_date`. */
export function validateReviewDate(value: string, field: string): void {
  const message = `参数 '${field}' 日期格式无效: ${value}（应为 YYYY-MM-DD）`;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) throw new Error(message);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(message);
  }
}

/** `ReviewPlanStatus::from_str` (case-sensitive): unknown strings fall back to `New`. */
function reviewPlanStatusFromStr(value: string): ReviewPlanStatus {
  switch (value) {
    case 'learning': return 'learning';
    case 'reviewing': return 'reviewing';
    case 'graduated': return 'graduated';
    case 'suspended': return 'suspended';
    default: return 'new';
  }
}

/** review_executor.rs:135 `parse_status_filter` (accepts JSON-stringified arrays). */
export function parseReviewStatusFilter(args: unknown): ReviewPlanStatus[] | null {
  return get_string_array_arg(args as JsonValue, 'status')?.map(reviewPlanStatusFromStr) ?? null;
}

function trimmedRequired(args: Args, snake: string, camel: string): string | null {
  const value = asStr(args[snake] ?? args[camel]);
  if (value === null) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

/** review_executor.rs:140 `required_plan_id`. */
export function requiredPlanId(args: Args): string {
  const value = trimmedRequired(args, 'plan_id', 'planId');
  if (value === null) throw new Error('Missing required parameter: plan_id (from review_get_due)');
  return value;
}

/** review_executor.rs:149 `required_expected_updated_at`. */
export function requiredExpectedUpdatedAt(args: Args): string {
  const value = trimmedRequired(args, 'expected_updated_at', 'expectedUpdatedAt');
  if (value === null) {
    throw new Error('Missing required parameter: expected_updated_at (use updatedAt from review_get_due)');
  }
  return value;
}

/** review_executor.rs:94 `plan_state_to_json`. */
export function planStateToJson(plan: ReviewPlan): Record<string, unknown> {
  return {
    plan_id: plan.id, question_id: plan.question_id, exam_id: plan.exam_id, status: plan.status,
    next_review_date: plan.next_review_date, last_review_date: plan.last_review_date,
    interval_days: plan.interval_days, repetitions: plan.repetitions, ease_factor: plan.ease_factor,
    total_reviews: plan.total_reviews, total_correct: plan.total_correct, is_difficult: plan.is_difficult,
    updatedAt: plan.updated_at,
  };
}

/** review_executor.rs:196 `review_changed_payload` (suspend/resume/delete). */
export function reviewChangedPayload(action: string, planId: string, runId: string): Record<string, unknown> {
  return {
    source: 'agent', action, operation: `review_${action}`, planId, plan_id: planId,
    entityIds: [planId], runId,
  };
}

/** review_executor.rs:208 `after_successful_mutation`: emit only after the mutation succeeded. */
export function afterSuccessfulMutation<T>(run: () => T, action: string, planId: string, runId: string,
  emit: (payload: Record<string, unknown>) => void): T {
  const value = run();
  emit(reviewChangedPayload(action, planId, runId));
  return value;
}

export class ReviewToolExecutor implements ToolExecutor {
  private readonly deps: ReviewToolDeps;
  constructor(deps: ReviewToolDeps) { this.deps = deps; }

  name(): string { return 'ReviewToolExecutor'; }

  canHandle(toolName: string): boolean {
    return (REVIEW_TOOL_NAMES as readonly string[]).includes(strip_tool_namespace(toolName));
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    switch (strip_tool_namespace(toolName)) {
      case 'review_delete': return 'high';
      case 'review_schedule': case 'review_plan_generate': case 'review_submit':
      case 'review_suspend': case 'review_resume': return 'medium';
      default: return 'low';
    }
  }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const toolName = strip_tool_namespace(call.name);
    return runToolWithEvents(this.name(), toolName, call, ctx, this.deps.log, async () => {
      const args = argsObject(call.arguments);
      switch (toolName) {
        case 'review_get_due': return this.getDue(args);
        case 'review_schedule': return this.schedule(args, ctx);
        case 'review_plan_generate': return this.planGenerate(args, ctx);
        case 'review_submit': return this.submit(args, ctx);
        case 'review_stats': return this.stats(args);
        case 'review_suspend': return this.mutate(args, ctx, 'suspend');
        case 'review_resume': return this.mutate(args, ctx, 'resume');
        case 'review_delete': return this.mutate(args, ctx, 'delete');
        default: throw new Error(`Unknown review tool: ${toolName}`);
      }
    });
  }

  private service(): ReviewPlanService {
    const service = this.deps.service();
    if (service === null) throw new Error('VFS database not available');
    return service;
  }

  /**
   * Rust emits through `ctx.window_ref()`, which panics in windowless (headless)
   * contexts after the write has committed; here a missing window skips the
   * notification instead, matching `emit_qbank_changed`.
   */
  private emitChanged(ctx: ExecutionContext, payload: Record<string, unknown>): void {
    if (ctx.tryWindow() === null) return;
    try { this.deps.emit(REVIEW_CHANGED_EVENT, payload); }
    catch (error) {
      this.deps.log.debug(`[ReviewToolExecutor] Failed to emit review://changed: ${toolErrorText(error)}`);
    }
  }

  private planToJson(plan: ReviewPlan, withQuestion: boolean): Record<string, unknown> {
    const item = planStateToJson(plan);
    if (!withQuestion) return item;
    let question: Question | null = null;
    try { question = this.deps.getQuestion(plan.question_id); }
    catch { question = null; } // Rust `if let Ok(Some(q))`: read failures omit the preview.
    if (question !== null) {
      item.question = {
        card_id: question.card_id ?? question.id,
        label: question.question_label,
        content_preview: takeChars(question.content, 120),
        question_type: question.question_type,
        tags: question.tags,
      };
    }
    return item;
  }

  /**
   * `*_if_unchanged` wraps the repo conflict in anyhow `with_context`, and
   * review_executor.rs matches on `to_string()` (outer context only). The whole
   * cause chain is checked here so the agent gets the structured, non-retryable
   * conflict with the current plan.
   */
  private mutationError(service: ReviewPlanService, action: string, planId: string,
    expectedUpdatedAt: string, error: unknown): Error {
    const text = toolErrorText(error);
    // RUST-FIX(RF-W03-review-conflict-context-chain): Rust 只看最外层 context，suspend/resume/delete 的冲突永远落不到 REVIEW_CONFLICT 分支
    if (errorChain(error).some(entry => toolErrorText(entry).includes('REVIEW_CONFLICT'))) {
      let current: unknown = null;
      try {
        const plan = service.getPlan(planId);
        current = plan === null ? null : planStateToJson(plan);
      } catch { current = null; }
      return new Error(JSON.stringify(with_localized_message({
        code: 'REVIEW_CONFLICT', action, plan_id: planId, expected_updated_at: expectedUpdatedAt,
        current: current as JsonValue, retryable: false,
        hint: '重新读取计划，使用返回的 updatedAt 再决定是否重试；不要用过期版本重复提交。',
      }, 'chat.tools.review.conflict', { action, plan_id: planId },
      '复习计划已被其他操作更新，请读取当前计划后再决定下一步。',
      'The review plan changed elsewhere. Read the current plan before deciding the next step.')));
    }
    return new Error(`复习计划${action}失败: ${text}`);
  }

  private getDue(args: Args): unknown {
    const service = this.service();
    const examId = asStr(args.exam_id);
    const untilDate = asStr(args.until_date);
    if (untilDate !== null) validateReviewDate(untilDate, 'until_date');
    const difficultOnly = asBool(args.difficult_only);
    const rawLimit = asU64(args.limit);
    const limit = rawLimit === null ? 20 : Math.min(MAX_DUE_LIMIT, Math.max(1, u64AsU32(rawLimit)));
    const rawOffset = asU64(args.offset);
    const offset = rawOffset === null ? 0 : u64AsU32(rawOffset);
    const filter: DueReviewsFilter = {
      exam_id: examId, until_date: untilDate, status: parseReviewStatusFilter(args),
      difficult_only: difficultOnly, limit, offset,
    };
    let result;
    try { result = service.getDueReviewsWithFilter(filter); }
    catch (error) { throw new Error(`查询到期复习失败: ${toolErrorText(error)}`); }
    return {
      total: result.total,
      has_more: result.has_more,
      due_reviews: result.plans.map(plan => this.planToJson(plan, true)),
      limit,
      offset,
      hint: '可用 qbank_get_question 取题目完整内容出题给用户练习；用户作答后调用 review_submit 提交 0-5 质量评分，SM-2 会自动排期下次复习。',
    };
  }

  private schedule(args: Args, ctx: ExecutionContext): unknown {
    const service = this.service();
    const examId = asStr(args.exam_id);
    if (examId === null) throw new Error("Missing 'exam_id' parameter（题目集 ID，即 qbank 工具返回的 session_id）");
    const questionIds = get_string_array_arg(args as JsonValue, 'question_ids') ?? [];
    const cardIds = get_string_array_arg(args as JsonValue, 'card_ids') ?? [];
    if (questionIds.length === 0 && cardIds.length === 0) {
      throw new Error('必须提供 question_ids 或 card_ids 至少一项。若想为整个题目集生成计划，请改用 review_plan_generate。');
    }
    const unresolvedCardIds: string[] = [];
    if (cardIds.length > 0) {
      const questionBank = this.deps.questionBank();
      if (questionBank === null) {
        throw new Error('QuestionBank service not available（card_ids 映射需要该服务，可改传 question_ids）');
      }
      for (const cardId of cardIds) {
        let question: Pick<Question, 'id'> | null = null;
        try { question = questionBank.getQuestionByCardId(examId, cardId); }
        catch { question = null; }
        if (question === null) unresolvedCardIds.push(cardId);
        else questionIds.push(question.id);
      }
    }
    const ids = [...new Set(questionIds.sort(compareRustStrings))];
    if (ids.length === 0) {
      throw new Error(`所有 card_ids 都无法解析为题目: ${rustDebugStrings(unresolvedCardIds)}（请确认 exam_id 与 card_id 是否匹配）`);
    }
    if (ids.length > MAX_SCHEDULE_BATCH) {
      throw new Error(`单次最多为 ${MAX_SCHEDULE_BATCH} 道题目安排复习（当前 ${ids.length} 道）`);
    }
    let result;
    try { result = service.batchCreateFromQuestions(ids, examId); }
    catch (error) { throw new Error(`安排复习计划失败: ${toolErrorText(error)}`); }
    const payload: Record<string, unknown> = {
      success: true,
      exam_id: examId,
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      plans_preview: result.plans.slice(0, 20).map(plan => ({
        plan_id: plan.id, question_id: plan.question_id, next_review_date: plan.next_review_date,
        updatedAt: plan.updated_at,
      })),
      message: `已为 ${result.created} 道题目创建复习计划（${result.skipped} 道已有计划跳过，${result.failed} 道失败）`,
      hint: '到期后可用 review_get_due 查询并组织复习；复习后用 review_submit 提交评分。',
    };
    if (unresolvedCardIds.length > 0) payload.unresolved_card_ids = unresolvedCardIds;
    this.emitChanged(ctx, { action: 'schedule', examId, runId: ctx.runId() });
    return payload;
  }

  private planGenerate(args: Args, ctx: ExecutionContext): unknown {
    const service = this.service();
    const examId = asStr(args.exam_id);
    if (examId === null) throw new Error("Missing 'exam_id' parameter（题目集 ID，即 qbank 工具返回的 session_id）");
    let result;
    try { result = service.createPlansForExam(examId); }
    catch (error) { throw new Error(`生成复习计划失败: ${toolErrorText(error)}`); }
    let stats = null;
    try { stats = service.refreshReviewStats(examId); }
    catch { stats = null; } // Rust `.ok()`
    const payload: Record<string, unknown> = {
      success: true,
      exam_id: examId,
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      message: `已为题目集生成复习计划：新建 ${result.created} 个，已存在跳过 ${result.skipped} 个，失败 ${result.failed} 个`,
      hint: '新建计划默认次日首次复习（SM-2 首间隔 1 天）。每天用 review_get_due 查询到期项即可开始复习。',
    };
    if (stats !== null) {
      payload.stats = { total_plans: stats.total_plans, due_today: stats.due_today, overdue: stats.overdue_count };
    }
    this.emitChanged(ctx, { action: 'plan_generate', examId, runId: ctx.runId() });
    return payload;
  }

  private submit(args: Args, ctx: ExecutionContext): unknown {
    const service = this.service();
    const qualityRaw = asI64(args.quality);
    if (qualityRaw === null) throw new Error("Missing 'quality' parameter（0-5 整数评分）");
    if (qualityRaw < 0 || qualityRaw > 5) {
      throw new Error(`quality 必须在 0-5 之间（当前: ${qualityRaw}）。0=完全不记得, 3=勉强正确, 5=完美回忆`);
    }
    const expectedUpdatedAt = requiredExpectedUpdatedAt(args);
    let planId = asStr(args.plan_id);
    if (planId === null) {
      const questionId = asStr(args.question_id);
      if (questionId === null) throw new Error('必须提供 plan_id 或 question_id 之一（plan_id 来自 review_get_due 返回）');
      let plan;
      try { plan = service.getPlanByQuestion(questionId); }
      catch (error) { throw new Error(`查询复习计划失败: ${toolErrorText(error)}`); }
      if (plan === null) throw new Error(`题目 ${questionId} 尚无复习计划，请先用 review_schedule 创建`);
      planId = plan.id;
    }
    const userAnswer = asStr(args.user_answer);
    const rawSeconds = asU64(args.time_spent_seconds);
    const timeSpentSeconds = rawSeconds === null ? null : Math.min(rawSeconds, 86_400);
    let result;
    try {
      result = service.processReviewWithExpected(planId, qualityRaw, userAnswer, timeSpentSeconds, expectedUpdatedAt);
    } catch (error) {
      throw this.mutationError(service, 'submit', planId, expectedUpdatedAt, error);
    }
    const payload = {
      success: true,
      plan_id: result.plan.id,
      question_id: result.plan.question_id,
      passed: result.passed,
      new_interval_days: result.new_interval,
      next_review_date: result.next_review_date,
      status: result.plan.status,
      repetitions: result.plan.repetitions,
      ease_factor: result.plan.ease_factor,
      is_difficult: result.plan.is_difficult,
      updatedAt: result.plan.updated_at,
      message: result.passed
        ? `复习通过，下次复习: ${result.next_review_date}（间隔 ${result.new_interval} 天）`
        : `本次未通过，计划已重置，明天（${result.next_review_date}）重新复习`,
    };
    this.emitChanged(ctx, { action: 'submit', planId, runId: ctx.runId() });
    return payload;
  }

  private stats(args: Args): unknown {
    const service = this.service();
    const examId = asStr(args.exam_id);
    let stats;
    try { stats = service.getReviewStats(examId); }
    catch (error) { throw new Error(`获取复习统计失败: ${toolErrorText(error)}`); }
    const payload: Record<string, unknown> = {
      exam_id: stats.exam_id,
      total_plans: stats.total_plans,
      by_status: {
        new: stats.new_count, learning: stats.learning_count, reviewing: stats.reviewing_count,
        graduated: stats.graduated_count, suspended: stats.suspended_count,
      },
      due_today: stats.due_today,
      overdue: stats.overdue_count,
      difficult: stats.difficult_count,
      total_reviews: stats.total_reviews,
      total_correct: stats.total_correct,
      avg_correct_rate: stats.avg_correct_rate,
      avg_ease_factor: stats.avg_ease_factor,
      updated_at: stats.updated_at,
    };
    if (asBool(args.include_calendar) ?? false) {
      const startDate = asStr(args.start_date);
      const endDate = asStr(args.end_date);
      if (startDate !== null) validateReviewDate(startDate, 'start_date');
      if (endDate !== null) validateReviewDate(endDate, 'end_date');
      let calendar;
      try { calendar = service.getCalendarData(startDate, endDate, examId); }
      catch (error) { throw new Error(`获取日历数据失败: ${toolErrorText(error)}`); }
      payload.calendar = calendar.map(entry => ({ date: entry.date, count: entry.count }));
    }
    return payload;
  }

  private mutate(args: Args, ctx: ExecutionContext, action: 'suspend' | 'resume' | 'delete'): unknown {
    const service = this.service();
    const planId = requiredPlanId(args);
    const expectedUpdatedAt = requiredExpectedUpdatedAt(args);
    const run = () => {
      switch (action) {
        case 'suspend': return this.suspendPlan(service, planId, expectedUpdatedAt);
        case 'resume': return this.resumePlan(service, planId, expectedUpdatedAt);
        case 'delete': return this.deletePlan(service, planId, expectedUpdatedAt);
      }
    };
    return afterSuccessfulMutation(run, action, planId, ctx.runId(), payload => this.emitChanged(ctx, payload));
  }

  private suspendPlan(service: ReviewPlanService, planId: string, expectedUpdatedAt: string): unknown {
    let plan;
    try { plan = service.suspendPlanIfUnchanged(planId, expectedUpdatedAt); }
    catch (error) { throw this.mutationError(service, 'suspend', planId, expectedUpdatedAt, error); }
    return {
      success: true, plan: planStateToJson(plan), message_key: 'review.plan_suspended',
      message_params: { plan_id: plan.id }, reversible: true,
    };
  }

  private resumePlan(service: ReviewPlanService, planId: string, expectedUpdatedAt: string): unknown {
    let plan;
    try { plan = service.resumePlanIfUnchanged(planId, expectedUpdatedAt); }
    catch (error) { throw this.mutationError(service, 'resume', planId, expectedUpdatedAt, error); }
    return {
      success: true, plan: planStateToJson(plan), message_key: 'review.plan_resumed',
      message_params: { plan_id: plan.id }, reversible: true,
    };
  }

  private deletePlan(service: ReviewPlanService, planId: string, expectedUpdatedAt: string): unknown {
    let plan;
    try { plan = service.getPlan(planId); }
    catch (error) { throw new Error(`Failed to load review plan before deletion: ${toolErrorText(error)}`); }
    if (plan === null) throw new Error(`Review plan not found: ${planId}`);
    try { service.deletePlanIfUnchanged(planId, expectedUpdatedAt); }
    catch (error) { throw this.mutationError(service, 'delete', planId, expectedUpdatedAt, error); }
    return {
      success: true, deleted: true, plan_id: plan.id, question_id: plan.question_id, exam_id: plan.exam_id,
      previous_status: plan.status, message_key: 'review.plan_deleted', message_params: { plan_id: plan.id },
      reversible: false,
    };
  }
}

/** Rust `{:?}` of `Vec<String>`. */
function rustDebugStrings(values: readonly string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(', ')}]`;
}

/** The error followed by its `cause` links (anyhow's chain), cycle-safe. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let entry: unknown = error; entry !== undefined && !chain.includes(entry);
    entry = entry instanceof Error ? entry.cause : undefined) {
    chain.push(entry);
  }
  return chain;
}
