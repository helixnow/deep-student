/**
 * `qbank_grading/pipeline.rs`：AI 评判的落库、失败草稿、通用解析回填与命令管线。
 *
 * 流式传输由 L02 `llmStreaming.singleShotCompletion` 提供；`GradingCompletion`
 * 端口保持与 Rust `stream_grade(..., &mut GradingStreamState, on_chunk)` 同形。
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue } from '../../../platform/errors/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { QuestionRepository, VfsReposService } from '../../vfs-repos/api.ts';
import type {
  GradingDiagnostics, QbankGradingMode, QbankGradingRequest, QbankGradingResponse, Question,
  Verdict,
} from '../api.ts';
import * as repo from '../repository/questions.ts';
import { utcNow } from '../repository/questions.ts';
import { GradingContext } from './grading-context.ts';
import { fetchContextImages, fetchImageAnswerContents, guessImageMime } from './grading-images.ts';
import { buildPrompts, parseVerdictAndScore } from './grading-prompts.ts';
import { GradingStreamState, type GradingStreamConfig } from './grading-stream.ts';
import { parseImageAnswerEnvelope } from './image-answer.ts';
import { runSingleShotGrading } from './llm-completion.ts';
import type { ReviewPlanPort } from './practice-grading-queue.ts';
import type { QbankLogger } from './ports.ts';
import {
  applySubmissionVerdict, type QuestionServiceHost, type VerdictOutcome,
} from './question-service.ts';

export type GradingMode = 'grade' | 'analyze';

export interface GradingEmitter {
  emitData(sessionId: string, chunk: string, accumulated: string): void;
  emitComplete(sessionId: string, submissionId: string | null, verdict: string | null,
    score: number | null, feedback: string, explanationWritten: boolean,
    diagnostics: GradingDiagnostics): void;
  emitError(sessionId: string, message: string): void;
  emitFailure(sessionId: string, message: string, feedback: string,
    diagnostics: GradingDiagnostics): void;
  emitCancelled(sessionId: string): void;
}

export interface GradingHost extends QuestionServiceHost {
  readonly db: DatabaseHandle;
  readonly llm: LLMManager;
  readonly blobsDir: string;
  readonly images: VfsReposService;
  readonly reviewPlan?: ReviewPlanPort;
  readonly log: QbankLogger;
}

export interface GradingCompletionInput {
  config: GradingStreamConfig;
  apiConfig: ApiConfig;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  eventName: string;
  images: Array<{ base64: string; mime: string; label: string }>;
  stream: GradingStreamState;
  onChunk: (chunk: string) => void;
}

export interface GradingCompletion {
  run(input: GradingCompletionInput): Promise<{ error: AppErrorValue | null }>;
}

/** L02 `llmStreaming` 已发布流式补全；适配器只做 qbank 侧的请求/诊断映射。 */
export function llmGradingCompletion(resolve: () => LLMManager | undefined,
  resolveStreaming: () => LlmStreamingService | undefined): GradingCompletion {
  return {
    async run(input: GradingCompletionInput): Promise<{ error: AppErrorValue | null }> {
      const llm = resolve();
      if (llm === undefined) {
        return { error: AppError.configuration('AI 评判服务不可用：llm 服务未提供') };
      }
      const streaming = resolveStreaming();
      if (streaming === undefined) {
        return { error: AppError.configuration('AI 评判服务不可用：L02 llmStreaming 服务未提供') };
      }
      const result = await runSingleShotGrading(llm, streaming, {
        ...input,
        config: input.apiConfig,
      });
      return { error: result.error };
    },
  };
}

export interface ResolvedGradingConfig {
  id: string;
  model: string;
  apiKey: string;
  isMultimodal: boolean;
  maxOutputTokens: number;
  maxTokensLimit: number | null;
  /** 完整配置供 L02 传输层构造请求（本接口其余字段是其摘要）。 */
  config: ApiConfig;
}

function rejectNonMultimodal(config: { model: string; isMultimodal: boolean },
  source: string): AppErrorValue | null {
  if (!config.isMultimodal) {
    return AppError.validation(
      `题目/材料配图或图片作答需要视觉模型，但${source}（${config.model}）不支持图片输入。`
      + '请在「设置 → 模型分配」中为题库 AI 评判配置多模态模型，或将图片作答改为文字。');
  }
  return null;
}

/** `pipeline.rs:710 resolve_grading_config`。 */
export async function resolveGradingConfig(
  llm: LLMManager, modelConfigId: string | null, requireMultimodal: boolean,
): Promise<ResolvedGradingConfig> {
  const toResolved = async (config: ApiConfig): Promise<ResolvedGradingConfig> => ({
    id: config.id,
    model: config.model,
    apiKey: await llm.decryptApiKey(config.apiKey),
    isMultimodal: config.isMultimodal,
    maxOutputTokens: config.maxOutputTokens,
    maxTokensLimit: config.maxTokensLimit,
    config,
  });
  const checkTextModel = (config: {
    id: string; model: string; isEmbedding: boolean; isReranker: boolean;
    isMultimodal: boolean; apiKey: string; maxOutputTokens: number;
    maxTokensLimit: number | null;
  }, source: string): AppErrorValue | null => {
    if (config.isEmbedding) return AppError.llm(`嵌入模型不支持 AI 评判: ${config.id}`);
    if (config.isReranker) return AppError.llm(`重排序模型不支持 AI 评判: ${config.id}`);
    if (requireMultimodal) return rejectNonMultimodal(config, source);
    return null;
  };

  if (modelConfigId !== null) {
    const configs = await llm.getApiConfigs();
    const found = configs.find(config => config.id === modelConfigId);
    if (found === undefined) throw new AppErrorThrow(AppError.llm(`未找到模型配置: ${modelConfigId}`));
    if (!found.enabled) throw new AppErrorThrow(AppError.llm(`模型配置已禁用: ${modelConfigId}`));
    if (found.isEmbedding) throw new AppErrorThrow(AppError.llm(`嵌入模型不支持 AI 评判: ${modelConfigId}`));
    if (found.isReranker) throw new AppErrorThrow(AppError.llm(`重排序模型不支持 AI 评判: ${modelConfigId}`));
    const rejected = requireMultimodal ? rejectNonMultimodal(found, '指定的模型') : null;
    if (rejected !== null) throw new AppErrorThrow(rejected);
    return toResolved(found);
  }

  const assignments = await llm.getModelAssignments();
  const assigned = assignments.qbank_ai_grading_model_config_id;
  if (assigned !== null) {
    const configs = await llm.getApiConfigs();
    const found = configs.find(config => config.id === assigned);
    if (found === undefined) throw new AppErrorThrow(AppError.llm(`未找到模型配置: ${assigned}`));
    const rejected = checkTextModel(found, '模型分配表中的题库评判模型');
    if (rejected !== null) throw new AppErrorThrow(rejected);
    return toResolved(found);
  }
  const config = await llm.getModel2Config();
  const rejected = requireMultimodal ? rejectNonMultimodal(config, '默认模型 Model2') : null;
  if (rejected !== null) throw new AppErrorThrow(rejected);
  return toResolved(config);
}

interface DraftQuestion { id: string }

/** `pipeline.rs:541 persist_draft_feedback`。 */
export function persistDraftFeedback(
  questions: QuestionRepository, db: DatabaseHandle, question: DraftQuestion, feedback: string,
  diagnostics: GradingDiagnostics | null,
): void {
  const exists = questions.getQuestion(db, question.id) !== null;
  if (!exists) {
    throw new AppErrorThrow(AppError.not_found(`题目不存在：${question.id}`));
  }
  const payload = JSON.stringify({ feedback, diagnostics });
  try {
    questions.recordHistory(db, question.id, 'ai_grading_draft', null, payload, 'ai',
      '批改未完成，正式成绩未更新');
  } catch (error) {
    throw new AppErrorThrow(AppError.database(
      `保存批改草稿失败：${error instanceof Error ? error.message : String(error)}`));
  }
}

export function persistFailedGrading(
  questions: QuestionRepository, db: DatabaseHandle, question: DraftQuestion, feedback: string,
  diagnostics: GradingDiagnostics,
): void {
  persistDraftFeedback(questions, db, question, feedback, diagnostics);
}

/**
 * `pipeline.rs:576 persist_grading_result`：调用方事务内执行。
 * 返回 `[verdictOutcome, explanationWritten]`；Analyze 不产生 outcome。
 */
export function persistGradingResult(
  conn: SqlExecutor, host: QuestionServiceHost, question: Question, mode: GradingMode,
  submissionId: string | null, feedback: string, verdict: Verdict | null,
  score: number | null, fillEmptyExplanation: boolean,
): { outcome: VerdictOutcome | null; explanationWritten: boolean } {
  const now = utcNow();
  let updated: number;
  try {
    updated = mode === 'grade'
      ? host.questions.updateAiFeedback(conn, question.id, feedback, score, now)
      : host.questions.updateAiAnalysis(conn, question.id, feedback, now);
  } catch (error) {
    throw new AppErrorThrow(AppError.database(
      `保存 AI 反馈失败: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (updated === 0) throw new AppErrorThrow(AppError.not_found(`题目不存在或已删除: ${question.id}`));

  if (mode !== 'grade') {
    const explanationWritten = fillEmptyExplanation
      ? repo.fillExplanationIfEmpty(host.questions, conn, question.id, feedback)
      : false;
    try {
      host.questions.markAsModified(conn, question.id);
    } catch (error) {
      throw new AppErrorThrow(AppError.database(
        `标记同步状态失败: ${error instanceof Error ? error.message : String(error)}`));
    }
    try {
      host.questions.updateContentHash(conn, question.id);
    } catch (error) {
      throw new AppErrorThrow(AppError.database(
        `更新内容哈希失败: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { outcome: null, explanationWritten };
  }

  if (verdict === null) throw new AppErrorThrow(AppError.llm('缺少评判 verdict'));
  if (submissionId === null) {
    throw new AppErrorThrow(AppError.validation('AI 评判需要作答记录：请先提交答案'));
  }
  const submission = host.questions.getSubmissionById(conn, submissionId);
  if (submission === null) {
    throw new AppErrorThrow(AppError.not_found(`作答记录不存在: ${submissionId}`));
  }
  if (submission.question_id !== question.id) {
    throw new AppErrorThrow(AppError.validation(
      `作答记录 ${submissionId} 不属于题目 ${question.id}`));
  }
  const outcome = applySubmissionVerdict(host, conn, question, submission,
    verdict === 'correct', 'ai', now);
  return { outcome, explanationWritten: false };
}

export class AppErrorThrow extends Error {
  readonly appError: AppErrorValue;
  constructor(appError: AppErrorValue) {
    super(appError.message);
    this.name = 'AppErrorThrow';
    this.appError = appError;
  }
}

function failureDiagnostics(diagnostics: GradingDiagnostics,
  error: AppErrorValue): GradingDiagnostics {
  const next: GradingDiagnostics = {
    ...diagnostics,
    error_message: error.message,
  };
  if (error.error_type === 'Database' || error.error_type === 'NotFound') {
    next.status = 'persistence_error';
  }
  return next;
}

function reportFailedGrading(
  host: GradingHost, emitter: GradingEmitter, request: QbankGradingRequest,
  question: { id: string }, feedback: string, diagnostics: GradingDiagnostics,
  error: AppErrorValue,
): AppErrorValue {
  const next = failureDiagnostics(diagnostics, error);
  try {
    persistFailedGrading(host.questions, host.db, question, feedback, next);
  } catch (failure) {
    const detail = failure instanceof AppErrorThrow ? failure.appError.message : String(failure);
    error = { ...error, message: `${error.message}；反馈草稿保存失败：${detail}` };
  }
  host.log.warn(`[QbankGrading] question=${question.id} diagnostics=${JSON.stringify(next)}`);
  emitter.emitFailure(request.stream_session_id, error.message, feedback, next);
  return error;
}

function asAppError(error: unknown): AppErrorValue {
  if (error instanceof AppErrorThrow) return error.appError;
  if (error instanceof CommandError) {
    const value = error.value;
    if (value !== null && typeof value === 'object' && 'error_type' in value
      && 'message' in value) {
      return value as AppErrorValue;
    }
    return AppError.unknown(String(value));
  }
  return AppError.database(error instanceof Error ? error.message : String(error));
}

function gradingModeOf(mode: QbankGradingMode): GradingMode {
  if (typeof mode === 'string') return mode;
  return Object.hasOwn(mode, 'analyze') ? 'analyze' : 'grade';
}

export interface RunGradingDeps {
  question: Question;
  submissions: Awaited<ReturnType<typeof loadGradingInputs>>;
}

async function loadGradingInputs(host: GradingHost, request: QbankGradingRequest) {
  const question = host.questions.getQuestion(host.db, request.question_id);
  if (question === null) throw new AppErrorThrow(AppError.not_found(`题目不存在: ${request.question_id}`));
  const trimmed = request.submission_id?.trim();
  const submissionId = trimmed ? trimmed : null;
  const mode = gradingModeOf(request.mode);
  if (submissionId === null && mode === 'grade') {
    throw new AppErrorThrow(AppError.validation('AI 评判需要作答记录：请先提交答案'));
  }
  const currentSubmission = submissionId === null ? null : host.questions.getSubmissionById(host.db, submissionId);
  if (submissionId !== null && currentSubmission === null) {
    throw new AppErrorThrow(AppError.not_found(`作答记录不存在: ${submissionId}`));
  }
  if (currentSubmission !== null && currentSubmission.question_id !== request.question_id) {
    throw new AppErrorThrow(AppError.validation(
      `作答记录 ${submissionId} 不属于题目 ${request.question_id}`));
  }
  let questionSnapshot: string | null = null;
  let materialSnapshot: string | null = null;
  if (currentSubmission !== null) {
    const snapshot = host.questions.getSubmissionSnapshot(host.db, currentSubmission.id);
    questionSnapshot = snapshot?.question_snapshot_json ?? null;
    materialSnapshot = snapshot?.material_snapshot_json ?? null;
  }
  const submissions = currentSubmission === null ? []
    : host.questions.getSubmissions(host.db, request.question_id, 5);
  const imageAnswer = currentSubmission === null ? null
    : parseImageAnswerEnvelope(currentSubmission.user_answer);
  const answerImages = imageAnswer === null ? [] : fetchImageAnswerContents(
    { db: host.db, blobsDir: host.blobsDir, vfsRepo: host.images }, imageAnswer);
  const context = GradingContext.fromQuestion(question);
  context.materials = question.materials ?? [];
  context.applySnapshots(questionSnapshot, materialSnapshot);
  context.images = fetchContextImages(
    { db: host.db, blobsDir: host.blobsDir, vfsRepo: host.images },
    context.materials, context.question_images);
  const prompts = buildPrompts(question, context, currentSubmission, submissions, mode, imageAnswer);
  const needsVision = answerImages.length > 0 || context.images.length > 0;
  return {
    question, currentSubmission, submissions, context, imageAnswer, answerImages, prompts,
    mode, needsVision,
  };
}

export async function runQbankGrading(
  host: GradingHost, request: QbankGradingRequest, completion: GradingCompletion,
  emitter: GradingEmitter,
): Promise<QbankGradingResponse | null> {
  let loaded: Awaited<ReturnType<typeof loadGradingInputs>>;
  try {
    loaded = await loadGradingInputs(host, request);
  } catch (error) {
    const appError = asAppError(error);
    emitter.emitError(request.stream_session_id, appError.message);
    throw new AppErrorThrow(appError);
  }

  let config: ResolvedGradingConfig;
  try {
    config = await resolveGradingConfig(host.llm, request.model_config_id ?? null, loaded.needsVision);
  } catch (error) {
    const appError = asAppError(error);
    emitter.emitError(request.stream_session_id, appError.message);
    throw new AppErrorThrow(appError);
  }

  const images = [...loaded.context.images];
  for (const [index, base64] of loaded.answerImages.entries()) {
    images.push({ base64, mime: guessImageMime(base64), label: `学生作答图 ${index + 1}` });
  }

  let accumulated = '';
  const streamEvent = `qbank_grading_stream_${request.stream_session_id}`;
  const streamConfig: GradingStreamConfig = {
    id: config.id, model: config.model, max_output_tokens: config.maxOutputTokens,
    max_tokens_limit: config.maxTokensLimit,
  };
  const stream = new GradingStreamState(streamConfig);
  const input: GradingCompletionInput = {
    config: streamConfig,
    apiConfig: config.config,
    apiKey: config.apiKey,
    systemPrompt: loaded.prompts.systemPrompt,
    userPrompt: loaded.prompts.userPrompt,
    eventName: streamEvent,
    images,
    stream,
    onChunk: chunk => {
      accumulated += chunk;
      emitter.emitData(request.stream_session_id, chunk, accumulated);
    },
  };
  let completionError: AppErrorValue | null = null;
  try {
    const result = await completion.run(input);
    completionError = result.error;
  } catch (error) {
    completionError = asAppError(error);
    stream.complete(false, completionError);
  }

  if (stream.diagnostics.status === 'cancelled') {
    if (accumulated.trim() !== '') {
      try {
        persistFailedGrading(host.questions, host.db, loaded.question, accumulated, stream.diagnostics);
      } catch (error) {
        host.log.warn(`[QbankGrading] 取消后保存反馈草稿失败: ${asAppError(error).message}`);
      }
    }
    emitter.emitCancelled(request.stream_session_id);
    return null;
  }

  if (completionError !== null) {
    throw new AppErrorThrow(reportFailedGrading(host, emitter, request, loaded.question,
      accumulated, stream.diagnostics, completionError));
  }

  if (accumulated.trim() === '') {
    stream.diagnostics.status = 'invalid_result';
    throw new AppErrorThrow(reportFailedGrading(host, emitter, request, loaded.question,
      accumulated, stream.diagnostics,
      AppError.llm('AI 未返回批改正文，仍待批改。请检查模型输出及思考预算')));
  }

  const pendingCancel = await host.llm.consumePendingCancel(streamEvent);
  if (pendingCancel) {
    stream.diagnostics.status = 'cancelled';
    try {
      persistFailedGrading(host.questions, host.db, loaded.question, accumulated, stream.diagnostics);
    } catch (error) {
      host.log.warn(`[QbankGrading] 取消后保存反馈草稿失败: ${asAppError(error).message}`);
    }
    emitter.emitCancelled(request.stream_session_id);
    return null;
  }

  const parsed = loaded.mode === 'grade'
    ? parseVerdictAndScore(accumulated) : { verdict: null, score: null };
  if (loaded.mode === 'grade' && parsed.verdict === null) {
    stream.diagnostics.status = 'invalid_result';
    throw new AppErrorThrow(reportFailedGrading(host, emitter, request, loaded.question,
      accumulated, stream.diagnostics,
      AppError.llm('AI 评判结果缺少有效 verdict 标签（需为 correct|partial|incorrect），'
        + '已保留反馈草稿，仍待批改。')));
  }

  const fillEmptyExplanation = loaded.currentSubmission === null;
  let persisted: { outcome: VerdictOutcome | null; explanationWritten: boolean };
  try {
    persisted = host.db.transaction(tx => persistGradingResult(
      tx, host, loaded.question, loaded.mode,
      loaded.currentSubmission?.id ?? null, accumulated, parsed.verdict, parsed.score,
      fillEmptyExplanation));
  } catch (error) {
    const appError = asAppError(error);
    throw new AppErrorThrow(reportFailedGrading(host, emitter, request, loaded.question,
      accumulated, stream.diagnostics, appError));
  }

  const outcome = persisted.outcome;
  if (outcome !== null) {
    if (outcome.needs_review_plan) {
      try {
        host.reviewPlan?.getOrCreatePlan(request.question_id, loaded.question.exam_id);
      } catch (error) {
        host.log.warn(`[QbankGrading] AI 判错后创建复习计划失败: question_id=${request.question_id}, `
          + `err=${asAppError(error).message}`);
      }
    }
    if (outcome.mastery_state !== null) {
      const mastery = host.mastery();
      if (mastery !== undefined) {
        try {
          mastery.syncLearnerProfile(outcome.mastery_state);
        } catch (error) {
          host.log.warn(`[QbankGrading] mastery profile 回流失败: question_id=${request.question_id}, `
            + `err=${asAppError(error).message}`);
        }
      }
    }
  }

  const response: QbankGradingResponse = {
    submission_id: loaded.currentSubmission?.id ?? null,
    verdict: parsed.verdict,
    score: parsed.score,
    feedback: accumulated,
    explanation_written: persisted.explanationWritten,
    diagnostics: stream.diagnostics,
  };
  emitter.emitComplete(request.stream_session_id, response.submission_id, parsed.verdict,
    parsed.score, accumulated, persisted.explanationWritten, stream.diagnostics);
  return response;
}
