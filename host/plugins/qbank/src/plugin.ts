import { Service, type Context } from '@deepseek-ai/cordis';
import { definePlugin, type PluginPlatform, type HostPlugin } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import * as path from '../../../platform/util/path.ts';
import type {} from '../../../platform/storage/api.ts';
import type {} from '../../../platform/paths/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import type {
  AnswerSubmission, BatchResult, CreateQuestionParams, Question, QuestionFilters, QuestionHistory,
  QuestionListResult, QuestionSearchFilters, QuestionSearchListResult, SubmitAnswerResult, UpdateQuestionParams,
  dstu_vfs__vfs__repos__question_repo__QuestionBankStats as QuestionBankStats,
} from '../api.ts';
import type { QbankExamCascade } from '../api.ts';
import * as examCascade from '../repository/exam-cascade.ts';
import type { MistakeListFilters, MistakeListResult } from '../repository/questions.ts';
import { GenerationSessions } from './generation-session.ts';
import { QuestionImportCancellations } from './question-import-cancellation.ts';
import * as questions from './question-service.ts';
import { QbankServiceError, type MasteryRecorder, type QuestionServiceHost } from './question-service.ts';
import type { PracticeServiceHost } from './practice-service.ts';
import type * as statistics from './statistics-service.ts';
import type * as management from './management-service.ts';
import type * as authoring from './authoring-service.ts';
import * as qbankExport from './export-service.ts';
import type * as legacy from './legacy-service.ts';
import type { QbankPorts } from './ports.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { LLMManager, LlmQuestionAuthoring } from '../../llm/api.ts';
import type { DocsService, PageRasterizerService } from '../../media/api.ts';
import type { VfsRefTextService } from '../../vfs-handlers/api.ts';
import type { ReviewPlanPort } from './practice-grading-queue.ts';
import type { GradingEmitter, GradingHost } from './grading-service.ts';
import { PaperExportBridge } from './paper-export-bridge.ts';
import { cropImageCodecOf } from './native-image.ts';
import type { GenerationCommandHost } from './generation-command.ts';
import { collectReferences } from './generation-references.ts';
import type { QbankPluginDeps, QbankPluginService } from './plugin-deps.ts';
import { registerAuthoring } from './register-authoring.ts';
import { registerExport } from './register-export.ts';
import { registerGeneration } from './register-generation.ts';
import { registerImports } from './register-imports.ts';
import { registerPractice } from './register-practice.ts';
import { registerQuestions } from './register-questions.ts';
import { registerStatistics } from './register-statistics.ts';
import { registerTools } from './register-tools.ts';
import { registerQbankStartupRecovery } from './startup-recovery.ts';
import { setQbankLocalRuntime, type QbankLocalRuntime } from './local-runtime.ts';

export type { QbankPluginService } from './plugin-deps.ts';

export interface QbankPluginOptions {
  /** 运行平台（profile 生成与入口校验用；桌面 `['desktop']`、移动 `['mobile']`）。 */
  readonly platforms?: readonly PluginPlatform[];
  /** 入口注入的本地运行时（`node:fs` / `node:zlib`）；不注入则文件相关命令按不可用降级。 */
  readonly localRuntime?: (ctx: Context) => QbankLocalRuntime;
}

function vfsReposOf(ctx: Context): VfsReposService {
  const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
  if (repos === undefined) {
    throw new QbankServiceError(AppError.configuration('VFS 仓库服务未提供'));
  }
  return repos;
}

function portsOf(ctx: Context): QbankPorts {
  const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
  return {
    // 索引失效 / exam_sheets 读写是尽力而为副作用；题目仓储是 D1 的唯一写入方。
    exams: repos?.exams,
    questions: repos?.questions,
    indexing: (ctx.get('vfsIndex') as VfsIndexService | undefined)?.indexing,
    log: ctx.logger('qbank'),
  };
}

function reviewPlanOf(ctx: Context): ReviewPlanPort | undefined {
  // L15 尚未在 review/api.ts 发布该服务名；提供方就绪后这里自动接线。
  return ctx.get('reviewPlan') as ReviewPlanPort | undefined;
}

function hostOf(ctx: Context): QuestionServiceHost {
  return {
    ...portsOf(ctx),
    db: ctx.storage.database('vfs'),
    questions: vfsReposOf(ctx).questions,
    mastery: () => ctx.get('mastery') as unknown as MasteryRecorder | undefined,
    reviewPlan: reviewPlanOf(ctx),
  };
}

function gradingHostOf(ctx: Context): GradingHost {
  const llm = ctx.get('llm') as LLMManager | undefined;
  if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供'));
  const vfsRepo = ctx.get('vfsRepo') as VfsReposService | undefined;
  if (vfsRepo === undefined) {
    throw new QbankServiceError(AppError.configuration('VFS 仓库服务未提供'));
  }
  return {
    ...portsOf(ctx),
    db: ctx.storage.database('vfs'),
    questions: vfsRepo.questions,
    mastery: () => ctx.get('mastery') as unknown as MasteryRecorder | undefined,
    llm,
    blobsDir: path.join(ctx.storage.locations.activeDir, 'vfs_blobs'),
    images: vfsRepo,
    reviewPlan: reviewPlanOf(ctx),
    log: ctx.logger('qbank'),
  };
}

/** `qbank_generation/mod.rs` 命令体的依赖：LLM 必需；参考资料解析服务仅在请求带参考资料时必需。 */
function generationHostOf(ctx: Context, generationSessions: GenerationSessions): GenerationCommandHost {
  const llm = ctx.get('llm') as LLMManager | undefined;
  if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供'));
  const questionAuthoring = ctx.get('llmQuestionAuthoring') as LlmQuestionAuthoring | undefined;
  if (questionAuthoring === undefined) throw new QbankServiceError(AppError.configuration('题目解析 LLM 服务未提供'));
  const repos = vfsReposOf(ctx);
  const db = ctx.storage.database('vfs');
  const blobsDir = path.join(ctx.storage.locations.activeDir, 'vfs_blobs');
  const log = ctx.logger('qbank');
  const nativeImage = cropImageCodecOf(ctx);
  return {
    db, blobsDir, repos, llm, questionAuthoring, ocr: ctx.get('llmOcrModels'), nativeImage, ports: portsOf(ctx),
    generationSessions, log,
    collectReferences: (request) => {
      const rasterizer = ctx.get('pageRasterizer') as PageRasterizerService | undefined;
      const docs = ctx.get('docs') as DocsService | undefined;
      const refText = ctx.get('vfsRefText') as VfsRefTextService | undefined;
      const needed = (request.reference_file_ids ?? []).length + (request.reference_files_base64 ?? []).length > 0;
      if (needed && (rasterizer === undefined || docs === undefined || refText === undefined)) {
        throw new QbankServiceError(AppError.configuration('参考资料解析服务未提供（pageRasterizer / docs / vfsRefText）'));
      }
      return collectReferences({
        db, blobsDir, repos, nativeImage, log,
        rasterizer: rasterizer as PageRasterizerService, docs: docs as DocsService, refText: refText as VfsRefTextService,
      }, request);
    },
    emit: (event, payload) => ctx.backendEvents.emit(event, payload),
    spawn: (task) => {
      // F4 `backgroundTasks`（Rust background_tasks::spawn）；未提供时直接在事件循环上执行。
      const background = ctx.get('backgroundTasks') as BackgroundTasks | undefined;
      return background === undefined ? task() : background.spawn(task);
    },
  };
}

function gradingEmitterOf(ctx: Context): GradingEmitter {
  const emit = (sessionId: string, payload: unknown): void => {
    ctx.backendEvents.emit(`qbank_grading_stream_${sessionId}`, payload);
  };
  return {
    emitData: (sessionId, chunk, accumulated) =>
      emit(sessionId, { type: 'data', chunk, accumulated }),
    emitComplete: (sessionId, submissionId, verdict, score, feedback,
      explanationWritten, diagnostics) => emit(sessionId, {
      type: 'complete', submission_id: submissionId, verdict, score, feedback,
      explanation_written: explanationWritten, diagnostics,
    }),
    emitError: (sessionId, message) =>
      emit(sessionId, { type: 'error', message, feedback: null, diagnostics: null }),
    emitFailure: (sessionId, message, feedback, diagnostics) =>
      emit(sessionId, { type: 'error', message, feedback, diagnostics }),
    emitCancelled: sessionId => emit(sessionId, { type: 'cancelled' }),
  };
}

async function practiceHostOf(ctx: Context): Promise<PracticeServiceHost> {
  return {
    ...portsOf(ctx),
    db: ctx.storage.database('vfs'),
    questions: vfsReposOf(ctx).questions,
    deviceId: await ctx.paths.deviceId(),
    mastery: () => ctx.get('mastery') as unknown as MasteryRecorder | undefined,
    reviewPlan: reviewPlanOf(ctx),
  };
}

function statisticsHostOf(ctx: Context): statistics.StatisticsServiceHost {
  return { db: ctx.storage.database('vfs'), questions: vfsReposOf(ctx).questions, log: ctx.logger('qbank') };
}

function managementHostOf(ctx: Context): management.ManagementHost {
  return { ...portsOf(ctx), db: ctx.storage.database('vfs'), questions: vfsReposOf(ctx).questions };
}

function authoringHostOf(ctx: Context): authoring.AuthoringHost {
  return { ...portsOf(ctx), db: ctx.storage.database('vfs'), questions: vfsReposOf(ctx).questions };
}

function legacyHostOf(ctx: Context): legacy.LegacyHost {
  return { ...portsOf(ctx), db: ctx.storage.database('vfs'), questions: vfsReposOf(ctx).questions };
}

function exportHostOf(ctx: Context): qbankExport.ExportHost {
  return { db: ctx.storage.database('vfs'), blobsDir: path.join(ctx.storage.locations.activeDir, 'vfs_blobs') };
}

class Qbank extends Service implements QbankPluginService {
  readonly examCascade: QbankExamCascade = {
    copyAuthoringEntitiesWithConn: examCascade.copyAuthoringEntities,
    softDeleteForExamWithConn: examCascade.softDeleteForExam,
    restoreForExamWithConn: examCascade.restoreForExam,
    retainsAssetWithConn: examCascade.retainsAsset,
  };
  readonly questionImports = new QuestionImportCancellations();
  readonly generationSessions = new GenerationSessions();
  constructor(ctx: Context) { super(ctx, 'qbank'); }
  get db(): DatabaseHandle { return this.ctx.storage.database('vfs'); }
  private get host(): QuestionServiceHost { return hostOf(this.ctx); }

  getQuestion(questionId: string): Question | null { return questions.getQuestion(this.host, questionId); }
  getQuestionByCardId(examId: string, cardId: string): Question | null {
    return questions.getQuestionByCardId(this.host, examId, cardId);
  }
  listQuestions(examId: string, filters: QuestionFilters, page: number, pageSize: number): QuestionListResult {
    return questions.listQuestions(this.host, examId, filters, page, pageSize);
  }
  listMistakes(filters: MistakeListFilters, page: number, pageSize: number): MistakeListResult {
    return questions.listMistakes(this.host, filters, page, pageSize);
  }
  searchQuestions(keyword: string, examId: string | null, filters: QuestionSearchFilters,
    page: number, pageSize: number): QuestionSearchListResult {
    return questions.searchQuestions(this.host, keyword, examId, filters, page, pageSize);
  }
  rebuildFtsIndex(): number { return questions.rebuildFtsIndex(this.host); }
  createQuestion(params: CreateQuestionParams): Question { return questions.createQuestion(this.host, params); }
  batchCreateQuestions(paramsList: CreateQuestionParams[]): Question[] {
    return questions.batchCreateQuestions(this.host, paramsList);
  }
  updateQuestion(questionId: string, params: UpdateQuestionParams, recordHistory: boolean): Question {
    return questions.updateQuestion(this.host, questionId, params, recordHistory);
  }
  batchUpdateQuestions(questionIds: string[], params: UpdateQuestionParams): BatchResult {
    return questions.batchUpdateQuestions(this.host, questionIds, params);
  }
  deleteQuestion(questionId: string): void { questions.deleteQuestion(this.host, questionId); }
  batchDeleteQuestions(questionIds: string[]): BatchResult {
    return questions.batchDeleteQuestions(this.host, questionIds);
  }
  submitAnswer(questionId: string, userAnswer: string, isCorrectOverride: boolean | null,
    clientRequestId: string | null): SubmitAnswerResult {
    return questions.submitAnswer(this.host, questionId, userAnswer, isCorrectOverride, clientRequestId);
  }
  regradeSubmission(questionId: string, submissionId: string, isCorrect: boolean): SubmitAnswerResult {
    return questions.regradeSubmission(this.host, questionId, submissionId, isCorrect);
  }
  toggleFavorite(questionId: string): Question { return questions.toggleFavorite(this.host, questionId); }
  getStats(examId: string): QuestionBankStats | null { return questions.getStats(this.host, examId); }
  countByType(examId: string): Record<string, number> { return questions.countByType(this.host, examId); }
  refreshStats(examId: string): QuestionBankStats { return questions.refreshStats(this.host, examId); }
  getHistory(questionId: string, limit: number | null): QuestionHistory[] {
    return questions.getHistory(this.host, questionId, limit);
  }
  getSubmissions(questionId: string, limit: number): AnswerSubmission[] {
    return questions.getSubmissions(this.host, questionId, limit);
  }
  /** `question_export_service/vfs_hook.rs`：trait 返回 `Result<Value, String>`，
   * 因此这里把 `QbankServiceError` 转成 Rust `AppError` 的显示文本，供 L13 包装为
   * `internal(failureMessage(error))`；命令路径仍走 `qbank_export_document` 的 AppError。 */
  exportDocument(examId: string): unknown {
    try {
      return qbankExport.document(exportHostOf(this.ctx), examId);
    } catch (error) {
      if (error instanceof QbankServiceError) {
        const appError = error.appError as { message?: unknown };
        throw new Error(typeof appError.message === 'string' ? appError.message : error.message);
      }
      throw error;
    }
  }
  resetProgress(examId: string): QuestionBankStats { return questions.resetProgress(this.host, examId); }
  resetQuestionsProgress(questionIds: string[]): BatchResult {
    return questions.resetQuestionsProgress(this.host, questionIds);
  }
}


export function createQbankPlugin(options: QbankPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.qbank',
    lane: 'L14-qbank',
    commands: [
      'get_csv_exportable_fields', 'get_csv_preview', 'import_questions_csv',
      'cancel_questions_csv_import', 'export_questions_csv', 'list_importing_sessions', 'list_exam_sheet_sessions',
      'get_exam_sheet_session_detail', 'update_exam_sheet_cards', 'rename_exam_sheet_session',
      'qbank_get_generation_task', 'qbank_list_generation_tasks',
      'qbank_list_questions', 'qbank_list_mistakes', 'qbank_search_questions', 'qbank_rebuild_fts_index',
      'qbank_get_question', 'qbank_get_question_by_card_id', 'qbank_create_question',
      'qbank_batch_create_questions', 'qbank_update_question', 'qbank_batch_update_questions',
      'qbank_delete_question', 'qbank_batch_delete_questions', 'qbank_submit_answer',
      'qbank_toggle_favorite', 'qbank_get_stats', 'qbank_count_by_type', 'qbank_refresh_stats',
      'qbank_get_history', 'qbank_get_submissions', 'qbank_reset_progress', 'qbank_reset_questions_progress',
      'qbank_create_practice', 'qbank_save_practice', 'qbank_get_practice', 'qbank_list_practices',
      'qbank_submit_practice', 'qbank_delete_practice', 'qbank_list_papers', 'qbank_get_paper',
      'qbank_update_paper', 'qbank_grade_practice_manually', 'qbank_generate_paper',
      'qbank_retry_practice_grading', 'qbank_resume_practice_grading',
      'qbank_get_learning_trend', 'qbank_get_activity_heatmap', 'qbank_get_knowledge_stats',
      'qbank_get_knowledge_stats_with_comparison', 'qbank_get_check_in_calendar',
      'qbank_get_daily_practice', 'qbank_start_timed_practice', 'qbank_generate_mock_exam',
      'qbank_submit_mock_exam', 'qbank_list_structure', 'qbank_update_group', 'qbank_delete_group',
      'qbank_get_authoring_draft', 'qbank_list_authoring_drafts', 'qbank_review_authoring_draft',
      'qbank_update_material', 'qbank_delete_material', 'qbank_commit_authoring_draft',
      'qbank_resolve_authoring_route',
      'qbank_export_document', 'qbank_export_portable', 'qbank_export_paper_docx',
      'qbank_crop_source_image', 'qbank_remove_question_image',
      'qbank_ai_generate_questions', 'qbank_cancel_generation_task', 'qbank_cancel_grading', 'qbank_ai_grade', 'qbank_legacy_audit',
      'qbank_legacy_migrate_selected',
      'qbank_get_source_page', 'qbank_get_source_images',
      'qbank_reparse_report', 'qbank_reparse_resolve',
      'get_learning_heatmap', 'qbank_complete_paper_export', 'inspect_pdf_text_for_qbank',
      'get_enhanced_statistics', 'cancel_question_bank_import', 'import_question_bank', 'import_question_bank_stream',
      'resume_question_import',
    ],
    provides: ['qbank'],
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  },
  // 内核把 inject 视为"必需服务"（kernel/runtime.ts verifyStarted）：索引失效、掌握度回流等
  // 都是 Rust 里 warn 后继续的尽力而为副作用，因此只声明真正必需的平台服务；其余经 ctx.get 解析，
  // 缺失时由适配器记录 warn（见 SPEC「服务与依赖」与待接线清单）。
  // 内核把 inject 视为"必需服务"（kernel/runtime.ts verifyStarted）：索引失效、掌握度回流等
  // 都是 Rust 里 warn 后继续的尽力而为副作用，因此只声明真正必需的平台服务；其余经 ctx.get 解析，
  // 缺失时由适配器记录 warn（见 SPEC「服务与依赖」与待接线清单）。
  inject: ['storage', 'paths'],
  apply(ctx) {
    setQbankLocalRuntime(options.localRuntime?.(ctx) ?? null);
    ctx.effect(() => () => setQbankLocalRuntime(null));
    const qbank = new Qbank(ctx);
    ctx.effect(() => () => {
      qbank.generationSessions.cancelAll();
      qbank.questionImports.cancelAll();
    });
    const log = ctx.logger('qbank');
    const deps: QbankPluginDeps = {
      ctx, qbank, log,
      paperExports: new PaperExportBridge(),
      paperExportHost: () => ({
        exportDir: ctx.paths.appDataDir,
        emit: (event: string, payload: unknown) => ctx.backendEvents.emit(event, payload),
        log,
      }),
      blobsDir: () => path.join(ctx.storage.locations.activeDir, 'vfs_blobs'),
      questionHost: () => hostOf(ctx),
      gradingHost: () => gradingHostOf(ctx),
      generationHost: () => generationHostOf(ctx, qbank.generationSessions),
      gradingEmitter: () => gradingEmitterOf(ctx),
      practiceHost: () => practiceHostOf(ctx),
      statisticsHost: () => statisticsHostOf(ctx),
      managementHost: () => managementHostOf(ctx),
      authoringHost: () => authoringHostOf(ctx),
      legacyHost: () => legacyHostOf(ctx),
      exportHost: () => exportHostOf(ctx),
    };
    registerTools(deps);
    registerImports(deps);
    registerGeneration(deps);
    registerQuestions(deps);
    registerPractice(deps);
    registerStatistics(deps);
    registerAuthoring(deps);
    registerExport(deps);
    registerQbankStartupRecovery(ctx);
  },
  });
}
