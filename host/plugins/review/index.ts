import { Service, type Context } from '@deepseek-ai/cordis';
import { CommandError, definePlugin } from '../../kernel/api.ts';
import type {} from '../../platform/storage/api.ts';
import type { ReviewPlanPort, ReviewService } from './api.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import { FsrsReviewService } from './src/review.ts';
import { DailySprintService, type RemoteCallMeta } from './src/dailySprintService.ts';
import type {
  BuildDailySprintRequest,
  ExamHorizonConfigPatch,
  GenerateMistakeVariantRequest,
  GetExamReadinessRequest,
  SettleSprintSessionRequest,
} from './src/examHorizonScheduler.ts';
import { registerFsrsCommands } from './src/commands.ts';
import { initializeFsrs7 } from './src/fsrs7.ts';
import { registerReviewPlanCommands } from './src/review-plan-commands.ts';
import { ReviewPlanService, defaultReviewPlanConfig } from './src/review-plan.ts';
import { registerEssayGradingCommands } from './src/essay-grading-commands.ts';
import { registerInsightCommands } from './src/insight-commands.ts';
import { studyTimeAdd, studyTimeRange } from './src/study-time.ts';
import { Mastery } from './src/mastery.ts';
import { appError } from './src/errors.ts';
import { ReviewToolExecutor } from './src/review-tool-executor.ts';
import { EssayGradingExecutor } from './src/essay-tool-executor.ts';
import type { BackgroundTasks } from '../../platform/diagnostics/api.ts';
import type { EssayGradingService } from '../llm/api.ts';
import type {} from '../agent-skills/api.ts';
import type { QbankService } from '../qbank/api.ts';

function reviewPlanServiceOf(ctx: Context): ReviewPlanService | null {
  const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
  if (repos === undefined) return null;
  const logger = ctx.logger('review');
  return new ReviewPlanService(
    ctx.storage.database('vfs'),
    repos,
    ctx.mastery,
    defaultReviewPlanConfig(),
    message => logger.warn(message),
    message => logger.info(message),
  );
}

/** review@1：供 Anki、chatanki 与学习总览复用的 FSRS 调度服务。 */
class Review extends Service implements ReviewService {
  private readonly sprintSvc: DailySprintService;

  private readonly trialV7: boolean;

  constructor(ctx: Context, trialV7: boolean) {
    super(ctx, 'review');
    this.trialV7 = trialV7;
    this.sprintSvc = new DailySprintService(ctx);
  }
  private svc(): FsrsReviewService {
    const logger = this.ctx.logger('review');
    return new FsrsReviewService(
      this.ctx.storage.database('mistakes'),
      message => logger.warn(message),
      message => logger.info(message),
      message => logger.debug(message),
      this.trialV7,
    );
  }
  enqueueCards(cardIds: string[]) { return this.svc().enqueueCards(cardIds); }
  enqueueCardsForSession(cardIds: readonly string[], sessionId: string, documentId: string | null) {
    return this.svc().enqueueCardsForSession(cardIds, sessionId, documentId);
  }
  enqueueCardsForLibrary(
    scope: string,
    cards: Parameters<FsrsReviewService['enqueueCardsForLibrary']>[1],
  ) {
    return this.svc().enqueueCardsForLibrary(scope, cards);
  }
  getDue(limit?: number | null) { return this.svc().getDue(limit ?? null); }
  getStats() { return this.svc().getStats(); }
  getReviewStatistics(days?: number | null) {
    return this.svc().getReviewStatistics(days ?? null);
  }
  getCardState(stateId: string) { return this.svc().getCardState(stateId); }
  getCardConceptTags(cardId: string) { return this.svc().getCardConceptTags(cardId); }
  getCardTags(cardId: string) { return this.svc().getCardTags(cardId); }
  getEnqueuedCards(result: Parameters<FsrsReviewService['getEnqueuedCards']>[0]) {
    return this.svc().getEnqueuedCards(result);
  }
  getReviewStatesForSession(cardIds: readonly string[], sessionId: string) {
    return this.svc().getReviewStatesForSession(cardIds, sessionId);
  }
  getReviewStatesForLibrary(scope: string, cardIds: readonly string[]) {
    return this.svc().getReviewStatesForLibrary(scope, cardIds);
  }
  setSuspendedForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ) {
    return this.svc().setSuspendedForSession(cardId, sessionId, expectedReviewVersion, suspended);
  }
  setSuspendedForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ) {
    return this.svc().setSuspendedForLibrary(scope, cardId, expectedReviewVersion, suspended);
  }
  undoLastReviewForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ) {
    return this.svc().undoLastReviewForSession(
      cardId, sessionId, expectedReviewVersion, expectedLogId,
    );
  }
  undoLastReviewForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ) {
    return this.svc().undoLastReviewForLibrary(
      scope, cardId, expectedReviewVersion, expectedLogId,
    );
  }
  cleanupCardDeletionInTx(
    conn: Parameters<FsrsReviewService['cleanupCardDeletionInTx']>[0],
    cardIds: readonly string[],
  ) {
    return this.svc().cleanupCardDeletionInTx(conn, cardIds);
  }
  cleanupTaskDeletionInTx(
    conn: Parameters<FsrsReviewService['cleanupTaskDeletionInTx']>[0], taskId: string,
  ) {
    return this.svc().cleanupTaskDeletionInTx(conn, taskId);
  }
  cleanupDocumentDeletionInTx(
    conn: Parameters<FsrsReviewService['cleanupDocumentDeletionInTx']>[0], documentId: string,
  ) {
    return this.svc().cleanupDocumentDeletionInTx(conn, documentId);
  }
  enqueueImportedCardsInTx(
    conn: Parameters<FsrsReviewService['enqueueImportedCardsInTx']>[0],
    cards: Parameters<FsrsReviewService['enqueueImportedCardsInTx']>[1],
  ) {
    if (this.trialV7) throw appError('Validation', 'Importing pre-scheduled cards is unavailable in the FSRS-7 trial');
    return this.svc().enqueueImportedCardsInTx(conn, cards);
  }
  getSchedulerConfig() { return this.svc().getSchedulerConfig(); }
  updateSchedulerConfig(update: Parameters<FsrsReviewService['updateSchedulerConfig']>[0]) {
    return this.svc().updateSchedulerConfig(update);
  }
  suspendCard(stateId: string) { return this.svc().suspendCard(stateId); }
  unsuspendCard(stateId: string) { return this.svc().unsuspendCard(stateId); }
  undoLastReview(logId: string, stateId: string) { return this.svc().undoLastReview(logId, stateId); }
  getExamHorizonConfig(spaceId: string | null = null, call?: RemoteCallMeta) {
    return this.sprintSvc.getExamHorizonConfig(spaceId, call);
  }
  updateExamHorizonConfig(patch: ExamHorizonConfigPatch, call?: RemoteCallMeta) {
    return this.sprintSvc.updateExamHorizonConfig(patch, call);
  }
  getExamReadiness(
    spaceIdOrRequest: string | null | GetExamReadinessRequest = null,
    call?: RemoteCallMeta,
  ) {
    if (this.trialV7) throw appError('Validation', 'Exam sprint scheduling is unavailable in the FSRS-7 trial');
    return this.sprintSvc.getExamReadiness(spaceIdOrRequest, call);
  }
  buildDailySprintPlan(request: BuildDailySprintRequest, call?: RemoteCallMeta) {
    if (this.trialV7) throw appError('Validation', 'Exam sprint scheduling is unavailable in the FSRS-7 trial');
    return this.sprintSvc.buildDailySprintPlan(request, call);
  }
  generateMistakeVariant(request: GenerateMistakeVariantRequest, call?: RemoteCallMeta) {
    return this.sprintSvc.generateMistakeVariant(request, call);
  }
  settleSprintSession(request: SettleSprintSessionRequest, call?: RemoteCallMeta) {
    if (this.trialV7) throw appError('Validation', 'Exam sprint scheduling is unavailable in the FSRS-7 trial');
    return this.sprintSvc.settleSprintSession(request, call);
  }
}

/**
 * reviewPlan@1：L14 在练习提交/改判后经 `ctx.get('reviewPlan')` 解析。
 *
 * `vfsRepo` 只在方法调用时解析，避免 review 插件（及其 FSRS 测试）必须
 * 同时安装 L11；真正的 Service 与 17 条 `review_plan_*` 命令共用同一实现。
 */
class ReviewPlan extends Service implements ReviewPlanPort {
  constructor(ctx: Context) { super(ctx, 'reviewPlan'); }
  private svc(): ReviewPlanService {
    const service = reviewPlanServiceOf(this.ctx);
    if (service === null) throw new Error('vfsRepo service is not available');
    return service;
  }
  getOrCreatePlan(questionId: string, examId: string) {
    return this.svc().getOrCreatePlan(questionId, examId);
  }
  getPlanByQuestion(questionId: string) {
    return this.svc().getPlanByQuestion(questionId);
  }
  advanceFromPractice(planId: string) {
    return this.svc().advanceFromPractice(planId);
  }
  getReviewStats(examId: string | null) {
    return this.svc().getReviewStats(examId);
  }
}

const reviewPlugin = definePlugin({
  meta: {
    id: 'dstu.review', lane: 'L15-review-analytics',
    commands: [
      'study_time_add', 'study_time_range', 'mastery_get_overview',
      'fsrs_enqueue_cards', 'fsrs_get_due', 'fsrs_preview_intervals', 'fsrs_rate',
      'fsrs_undo_last_review', 'fsrs_suspend_card', 'fsrs_bury_card', 'fsrs_unbury_card',
      'fsrs_unsuspend_card', 'fsrs_get_stats', 'fsrs_get_review_statistics',
      'fsrs_get_memory_overview', 'fsrs_get_card_memory_history',
      'fsrs_get_scheduler_config', 'fsrs_update_scheduler_config', 'fsrs_optimize_parameters',
      'fsrs_reset_card_progress',
      'review_plan_create', 'review_plan_process', 'review_plan_get_due',
      'review_plan_get_due_with_filter', 'review_plan_get_stats', 'review_plan_refresh_stats',
      'review_plan_get_by_question', 'review_plan_get', 'review_plan_suspend',
      'review_plan_resume', 'review_plan_delete', 'review_plan_get_history',
      'review_plan_batch_create', 'review_plan_create_for_exam', 'review_plan_list_by_exam',
      'review_plan_get_or_create', 'review_plan_get_calendar_data',
      'essay_grading_stream', 'essay_grading_create_session', 'essay_grading_get_session',
      'essay_grading_update_session', 'essay_grading_delete_session', 'essay_grading_list_sessions',
      'essay_grading_toggle_favorite', 'essay_grading_get_rounds', 'essay_grading_get_round',
      'essay_grading_get_latest_round_number', 'essay_grading_get_modes', 'essay_grading_get_mode',
      'essay_grading_create_custom_mode', 'essay_grading_update_custom_mode',
      'essay_grading_delete_custom_mode', 'essay_grading_list_custom_modes',
      'essay_grading_save_builtin_override', 'essay_grading_reset_builtin_mode',
      'essay_grading_has_builtin_override', 'essay_grading_get_models',
      'insight_create_draft', 'insight_confirm', 'insight_correct', 'insight_delete',
      'insight_get', 'insight_list', 'insight_list_revisions', 'insight_list_evidence',
      'insight_list_relations', 'insight_list_events', 'insight_record_feedback',
      'insight_add_relation', 'insight_run_jobs',
    ],
    provides: ['mastery', 'review', 'reviewPlan'],
    remote: {
      review: [
        'getExamHorizonConfig',
        'updateExamHorizonConfig',
        'getExamReadiness',
        'buildDailySprintPlan',
        'generateMistakeVariant',
        'settleSprintSession',
      ],
    },
    platforms: ['desktop', 'mobile'],
  },
  inject: ['storage'],
  apply: ctx => applyReview(ctx),
});

export default reviewPlugin;

/** Explicit entry point for the local Host trial; normal registration always uses V6. */
export function createReviewTrialPlugin(): typeof reviewPlugin {
  return { ...reviewPlugin, apply: ctx => applyReview(ctx, true) };
}

function applyReview(ctx: Context, trialV7 = false): void {
  if (trialV7) initializeFsrs7(ctx.storage.database('mistakes'));
  const mastery = new Mastery(ctx);
  new Review(ctx, trialV7);
  new ReviewPlan(ctx);
  registerFsrsCommands(ctx, trialV7);
  registerReviewPlanCommands(ctx);
  registerEssayGradingCommands(ctx);
  registerInsightCommands(ctx);
  const toolLog = ctx.logger('review');
  const reviewTools = new ReviewToolExecutor({
    service: () => reviewPlanServiceOf(ctx),
    getQuestion: questionId => {
      const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
      return repos === undefined ? null : repos.questions.getQuestion(ctx.storage.database('vfs'), questionId);
    },
    questionBank: () => (ctx.get('qbank') as QbankService | undefined) ?? null,
    emit: (event, payload) => ctx.backendEvents.emit(event, payload),
    log: toolLog,
  });
  const essayTools = new EssayGradingExecutor({
    essays: () => {
      const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
      return repos === undefined ? null : { conn: ctx.storage.database('vfs'), repo: repos.essays };
    },
    grading: () => (ctx.get('essayGrading') as EssayGradingService | undefined) ?? null,
    emit: (event, payload) => ctx.backendEvents.emit(event, payload),
    spawn: task => {
      const background = ctx.get('backgroundTasks') as BackgroundTasks | undefined;
      if (background === undefined) void task();
      else void background.spawn(task);
    },
    log: toolLog,
  });
  ctx.inject(['agentTools'], scoped => {
    const registration = scoped.agentTools.registerToolExecutors([reviewTools, essayTools]);
    scoped.effect(() => () => registration.dispose());
  });
  ctx.commands.register<{ limit: number | null }>('mastery_get_overview', ({ limit }) => {
    try { return mastery.overviewSummary(Math.min(30, Math.max(1, limit ?? 6))); }
    catch (e) {
      if (e instanceof CommandError) throw new CommandError((e.value as { message: string }).message);
      throw e;
    }
  });
  ctx.commands.register<{ seconds: number; date: string | null }>('study_time_add', ({ seconds, date }) => studyTimeAdd(ctx, seconds, date));
  ctx.commands.register<{ from: string; to: string }>('study_time_range', ({ from, to }) => studyTimeRange(ctx, from, to));
}
