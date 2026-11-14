/**
 * `enhanced_anki_service.rs` 中不依赖 LLM 请求编排的部分：
 * 运行状态登记、硬暂停/取消/恢复、文档状态查询、生成卡自动入复习。
 *
 * Rust 的 `DOCUMENT_STATES` 是本模块 {@link DocumentRunRegistry} 的进程级实例。
 */
import type { DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  FsrsEnqueuedCard,
  FsrsEnqueueResult,
} from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { Context } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { deleteDocumentSession, listCardsForDocument, updateCardRows } from '../repository/anki-cards.ts';
import { insertDocumentTask } from '../repository/document-processing.ts';
import { DocumentProcessingService } from './document-processing.ts';
import type { AnkiLogger } from './logger.ts';
import { documentTracker, releaseDocumentTracker } from './anki-qa-tracker.ts';
import { decodeAnkiCardRow } from './anki-cards.ts';
import {
  buildFeedbackInjection,
  defaultFsrsFeedbackConfig,
} from './anki-fsrs-feedback.ts';
import {
  cancelStreaming,
  clearCancelSender,
  errorContentIsRepairable,
  isStreaming,
  RETRY_ASSIGNMENT_MARK,
} from './streaming-anki.ts';
import { nowRfc3339 } from './time.ts';
import { requireFsrsTransactionOwner, type FsrsTransactionOwner } from './fsrs-owner.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
/** 流服务取消通道（Rust `StreamingAnkiService::{cancel_streaming,clear_cancel_sender,is_streaming}`）。 */
export interface StreamingControlPort {
  cancelStreaming(taskId: string): Promise<void>;
  clearCancelSender(taskId: string): Promise<void>;
  isStreaming(taskId: string): Promise<boolean>;
}

/** `StreamedCardPayload` 事件名（Rust `emit("anki_generation_event", ...)`）。 */
export const ANKI_GENERATION_EVENT = 'anki_generation_event';

/** 最小窗口端口：对应 Tauri `Window::emit`。 */
export interface AnkiEventWindow {
  emit(event: string, payload: unknown): void;
}

/** `DocumentRunState`（Rust `DOCUMENT_STATES` 的值）。 */
export interface DocumentRunState {
  paused: boolean;
  running: boolean;
  epoch: number;
  current_task_id: string | null;
}

export function defaultDocumentRunState(): DocumentRunState {
  return { paused: false, running: false, epoch: 0, current_task_id: null };
}

/** 进程级文档运行状态（Rust `static DOCUMENT_STATES`）。 */
export class DocumentRunRegistry {
  private readonly states = new Map<string, DocumentRunState>();

  entry(documentId: string): DocumentRunState {
    const existing = this.states.get(documentId);
    if (existing !== undefined) return existing;
    const created = defaultDocumentRunState();
    this.states.set(documentId, created);
    return created;
  }

  get(documentId: string): DocumentRunState | undefined {
    return this.states.get(documentId);
  }

  remove(documentId: string): void {
    this.states.delete(documentId);
  }

  clear(): void {
    this.states.clear();
  }
}

export const documentRunRegistry = new DocumentRunRegistry();

/** 生产装配：Context 的最小依赖（命令 handler 共用）。 */
export function enhancedServiceDepsFor(
  ctx: Context,
  db: DatabaseHandle,
): EnhancedServiceDeps {
  return {
    db,
    registry: documentRunRegistry,
    logger: ctx.logger,
    streaming: { cancelStreaming, clearCancelSender, isStreaming },
    fsrsOwner: requireFsrsTransactionOwner(ctx),
  };
}

/** `fsrs_feedback_authorized`：仅显式 `true` 授权。 */
export function fsrsFeedbackAuthorized(flag: boolean | null | undefined): boolean {
  return flag === true;
}

/** 复习入队端口（L15 `review.enqueueCards`）。 */
export interface ReviewEnqueuePort {
  enqueueCards(cardIds: string[]): FsrsEnqueueResult;
  /** L15 `getEnqueuedCards`：`fsrs://changed` 只需要新增 state 的卡片内容。 */
  getEnqueuedCards?(result: FsrsEnqueueResult): FsrsEnqueuedCard[];
}

/**
 * `enqueue_document_cards`：文档内非错误卡加入 FSRS 复习；
 * 无卡时返回 null，卡片重复由 enqueue 自行跳过。
 */
export function enqueueDocumentCards(
  db: SqlExecutor,
  documentId: string,
  review: ReviewEnqueuePort | null | undefined,
): FsrsEnqueueResult | null {
  const cardIds = listCardsForDocument(db, documentId)
    .filter((card) => card.is_error_card === 0)
    .map((card) => card.id);
  if (cardIds.length === 0) return null;
  if (review === null || review === undefined) {
    throw new Error('review 服务不可用：无法把生成卡加入复习');
  }
  return review.enqueueCards(cardIds);
}

/** 逐任务流式执行端口（由 `AnkiGenerationService` 实现）。 */
export interface GenerationRunner {
  processTaskAndGenerateCardsStream(
    task: DocumentTask,
    window: AnkiEventWindow,
    runSignal?: AbortSignal,
    onReady?: () => void,
  ): Promise<void>;
}

export interface EnhancedServiceDeps {
  db: DatabaseHandle;
  registry: DocumentRunRegistry;
  logger: AnkiLogger;
  streaming: StreamingControlPort;
  /** 本 lane 的生成服务（`src/generation-service.ts`），调度层只依赖逐任务执行。 */
  generation?: GenerationRunner | null;
  /** L15 复习入队；缺失时自动入队降级为告警（Rust 中服务恒存在）。 */
  review?: ReviewEnqueuePort | null;
  /** L15 事务内 FSRS 清理；删除文档会话时必须存在。 */
  fsrsOwner: FsrsTransactionOwner;
  /** Rust `tokio::spawn`；测试可注入立即执行的确定性实现。 */
  spawn?: (work: () => Promise<void>) => void;
  /** 恢复时把剩余任务交给流式调度（Rust `tokio::spawn`）。 */
  scheduleRemaining?: (tasks: readonly DocumentTask[], documentId: string, epoch: number) => void;
}

/**
 * 运行任务句柄（Rust `RUNNING_HANDLES: DashMap<String, JoinHandle<()>>`）。
 *
 * `controller` 是独立于流式取消通道的运行句柄：调度层在 spawn 时注册，
 * 删除/暂停路径在 `cancel_streaming` 失败（取消通道尚未注册）时可直接 abort，
 * 不必等生成服务走到注册点。`ready` 对应 Rust 的 oneshot 就绪信号。
 */
export interface RunningTaskHandle {
  readonly taskId: string;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly ready: Promise<void>;
  markReady(): void;
}

/** 进程级运行任务句柄（Rust `static RUNNING_HANDLES`）。 */
export const runningTaskHandles = new Map<string, RunningTaskHandle>();

/** 调度层 spawn 前注册运行句柄；返回可 abort 的 signal 与就绪信号。 */
export function registerRunningTask(taskId: string): RunningTaskHandle {
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const controller = new AbortController();
  const handle: RunningTaskHandle = {
    taskId,
    controller,
    signal: controller.signal,
    ready,
    markReady: () => { resolveReady(); },
  };
  runningTaskHandles.set(taskId, handle);
  return handle;
}

/** 任务完成/中止后释放句柄；只删除自己注册的那个实例。 */
export function releaseRunningTask(handle: RunningTaskHandle): void {
  handle.markReady();
  if (runningTaskHandles.get(handle.taskId) === handle) {
    runningTaskHandles.delete(handle.taskId);
  }
}

/** `RUNNING_HANDLES.contains_key`。 */
export function hasRunningTask(taskId: string): boolean {
  return runningTaskHandles.has(taskId);
}

/**
 * `RUNNING_HANDLES.remove(..).abort()`：独立中止运行句柄并移除条目。
 * 返回是否真的存在可中止的任务。
 */
export function abortRunningTask(taskId: string): boolean {
  const handle = runningTaskHandles.get(taskId);
  if (handle === undefined) return false;
  runningTaskHandles.delete(taskId);
  handle.controller.abort();
  return true;
}

/**
 * `EnhancedAnkiService::delete_document_session`
 * （`enhanced_anki_service.rs:901-932`）：
 * epoch 失效 → 取消运行流（失败时 abort 句柄）→ 同事务删库 → 清运行状态/QA tracker。
 */
export async function deleteDocumentSessionLifecycle(
  deps: EnhancedServiceDeps,
  documentId: string,
): Promise<void> {
  const entry = deps.registry.get(documentId);
  if (entry !== undefined) {
    entry.paused = true;
    entry.running = false;
    entry.epoch += 1;
  }

  const processor = new DocumentProcessingService(deps.db);
  let tasks: DocumentTask[] = [];
  try {
    tasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    deps.logger.warn(`获取文档任务失败，删除将继续清理数据库: ${errorText(error)}`);
  }
  for (const task of tasks.filter(
    (candidate) => candidate.status === 'Processing' || candidate.status === 'Streaming',
  )) {
    try {
      await deps.streaming.cancelStreaming(task.id);
    } catch (error) {
      deps.logger.warn(`取消流失败: ${errorText(error)}，尝试直接中止任务句柄`);
      // Rust `RUNNING_HANDLES.remove(..).abort()`：取消通道未注册时直接中止真实运行句柄。
      abortRunningTask(task.id);
    }
  }

  deleteDocumentSession(deps.db, documentId, deps.fsrsOwner);
  deps.registry.remove(documentId);
  releaseDocumentTracker(documentId);
}

function taskStatusUpdatePayload(task: DocumentTask, status: string): Record<string, unknown> {
  return {
    TaskStatusUpdate: {
      task_id: task.id,
      status,
      message: null,
      segment_index: task.segment_index,
      document_id: task.document_id,
    },
  };
}

/** `pause_document_processing`：硬暂停（断开运行中的流，只暂停运行态任务）。 */
export async function pauseDocumentProcessing(
  deps: EnhancedServiceDeps,
  documentId: string,
  window: AnkiEventWindow,
): Promise<void> {
  const { registry, logger } = deps;
  let currentTaskId: string | null;
  {
    const entry = registry.entry(documentId);
    entry.paused = true;
    entry.running = false;
    entry.epoch += 1;
    currentTaskId = entry.current_task_id;
  }

  const processor = new DocumentProcessingService(deps.db);
  let docTasks: DocumentTask[];
  try {
    docTasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    logger.warn(`获取文档任务失败，暂停将尝试仅中止当前任务: ${errorText(error)}`);
    docTasks = [];
  }

  const runningTasks = docTasks.filter(
    (task) => task.status === 'Processing' || task.status === 'Streaming',
  );
  if (currentTaskId !== null && !runningTasks.some((task) => task.id === currentTaskId)) {
    try {
      runningTasks.push(processor.getTask(currentTaskId));
    } catch (error) {
      logger.warn(`获取当前任务失败: ${errorText(error)}`);
    }
  }

  for (const task of runningTasks) {
    try {
      await deps.streaming.cancelStreaming(task.id);
    } catch (error) {
      logger.warn(`取消流失败: ${errorText(error)}，尝试直接中止任务句柄`);
      // Rust 暂停分支：cancel 失败 → abort 独立句柄 → 清残留取消通道。
      abortRunningTask(task.id);
      await deps.streaming.clearCancelSender(task.id);
    }
    processor.updateTaskStatus(task.id, 'Paused', null);
    try {
      window.emit(ANKI_GENERATION_EVENT, taskStatusUpdatePayload(task, 'Paused'));
    } catch (error) {
      logger.warn(`发送任务状态更新事件失败: ${errorText(error)}`);
    }
  }

  try {
    window.emit(ANKI_GENERATION_EVENT, { DocumentProcessingPaused: { document_id: documentId } });
  } catch (error) {
    logger.warn(`发送文档暂停事件失败: ${errorText(error)}`);
  }
}

/** `resume_document_processing`：清理暂停态并把 Paused/Pending 交给调度。 */
export async function resumeDocumentProcessing(
  deps: EnhancedServiceDeps,
  documentId: string,
  _window: AnkiEventWindow,
): Promise<void> {
  const { registry, logger } = deps;
  let myEpoch: number;
  {
    const entry = registry.entry(documentId);
    if (entry.running) {
      entry.paused = false;
      return;
    }
    entry.paused = false;
    entry.running = true;
    entry.epoch += 1;
    myEpoch = entry.epoch;
  }

  const processor = new DocumentProcessingService(deps.db);
  let remaining: DocumentTask[];
  try {
    remaining = processor.getDocumentTasks(documentId).filter(
      (task) => task.status === 'Paused' || task.status === 'Pending',
    );
  } catch (error) {
    const entry = registry.get(documentId);
    if (entry !== undefined) {
      entry.running = false;
      if (!entry.paused) registry.remove(documentId);
    }
    releaseDocumentTracker(documentId);
    throw error;
  }
  remaining.sort((a, b) => a.segment_index - b.segment_index);

  if (remaining.length === 0) {
    const entry = registry.get(documentId);
    if (entry !== undefined) {
      entry.running = false;
      if (!entry.paused) registry.remove(documentId);
    }
    releaseDocumentTracker(documentId);
    try {
      _window.emit(ANKI_GENERATION_EVENT, {
        DocumentProcessingCompleted: { document_id: documentId },
      });
    } catch (error) {
      logger.warn(`发送文档处理完成事件失败: ${errorText(error)}`);
    }
    return;
  }

  if (deps.scheduleRemaining === undefined || deps.generation === null || deps.generation === undefined) {
    // 恢复语义要求真正重新调度；没有调度端口时按 Configuration 错误暴露，
    // 不能把「未恢复」伪装成成功。
    const entry = registry.get(documentId);
    if (entry !== undefined) entry.running = false;
    throw new Error('流式调度服务不可用：resume_document_processing 无法继续生成');
  }
  deps.scheduleRemaining(remaining, documentId, myEpoch);
}

/** `cancel_document_processing`：停止生成，保留任务与已生成卡片。 */
export async function cancelDocumentProcessing(
  deps: EnhancedServiceDeps,
  documentId: string,
  window: AnkiEventWindow,
): Promise<void> {
  const { registry, logger } = deps;
  {
    const entry = registry.entry(documentId);
    entry.paused = true;
    entry.running = false;
    entry.epoch += 1;
  }

  const processor = new DocumentProcessingService(deps.db);
  let tasks: DocumentTask[];
  try {
    tasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    logger.warn(`获取文档任务失败，取消仅停止调度: ${errorText(error)}`);
    tasks = [];
  }

  for (const task of tasks) {
    if (
      task.status !== 'Pending' &&
      task.status !== 'Processing' &&
      task.status !== 'Streaming' &&
      task.status !== 'Paused'
    ) {
      continue;
    }
    if (task.status === 'Processing' || task.status === 'Streaming') {
      try {
        await deps.streaming.cancelStreaming(task.id);
      } catch (error) {
        logger.warn(`取消流失败: ${errorText(error)}，尝试直接中止任务句柄`);
        await deps.streaming.clearCancelSender(task.id);
      }
    }
    processor.updateTaskStatus(task.id, 'Cancelled', null);
    try {
      window.emit(ANKI_GENERATION_EVENT, taskStatusUpdatePayload(task, 'Cancelled'));
    } catch (error) {
      logger.warn(`发送任务状态更新事件失败: ${errorText(error)}`);
    }
  }

  registry.remove(documentId);
  releaseDocumentTracker(documentId);
  try {
    window.emit(ANKI_GENERATION_EVENT, { DocumentProcessingCancelled: { document_id: documentId } });
  } catch (error) {
    logger.warn(`发送文档处理取消事件失败: ${errorText(error)}`);
  }
}

/** `get_document_state`。 */
export function getDocumentState(
  registry: DocumentRunRegistry,
  documentId: string,
): { paused: boolean; current_task_id: string | null } {
  const state = registry.get(documentId);
  return state === undefined
    ? { paused: false, current_task_id: null }
    : { paused: state.paused, current_task_id: state.current_task_id };
}

// ============================================================================
// 启动 / 调度 / 单任务重试（`enhanced_anki_service.rs:66-787`）
// ============================================================================

const MAX_DOCUMENT_SIZE = 10_000_000;

/** `AnkiGenerationOptions` 默认值（Rust `Default`）。 */
export function defaultAnkiGenerationOptions(): AnkiGenerationOptions {
  return {
    source_ref: null,
    deck_name: '默认牌组',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 10,
    max_cards_total: null,
    max_tokens: null,
    temperature: null,
    max_output_tokens_override: null,
    temperature_override: null,
    template_id: null,
    custom_anki_prompt: null,
    template_fields: null,
    field_extraction_rules: null,
    template_fields_by_id: null,
    field_extraction_rules_by_id: null,
    custom_requirements: null,
    segment_overlap_size: 200,
    system_prompt: null,
    template_ids: null,
    template_descriptions: null,
    enable_llm_boundary_detection: null,
    fsrs_feedback: null,
    user_review_profile: null,
    output_protocol: null,
    enable_qa_pass: null,
    enable_critic_pass: null,
    enable_llm_critic: null,
    critic_token_budget: null,
    sidekick_model_routing: null,
  };
}

/** `chrono::Utc::now().format("%Y%m%d_%H%M%S")`。 */
function utcDocumentStamp(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export interface StartDocumentProcessingRequest {
  document_content: string;
  original_document_name?: string | null;
  options?: AnkiGenerationOptions | null;
}

/**
 * `start_document_processing_inner`：校验 → FSRS 注入 → 分段建任务 →
 * 发 Started 事件 → 登记运行状态 → 后台调度。
 *
 * `preAllocatedId` 非空时即 `start_document_processing_with_id`，任务落在该 document_id 下。
 * 返回 document_id（Rust `Ok(document_id)`）。
 */
export async function startDocumentProcessing(
  deps: EnhancedServiceDeps,
  request: StartDocumentProcessingRequest,
  window: AnkiEventWindow,
  preAllocatedId: string | null = null,
): Promise<string> {
  const trimmedContent = rustTrim(request.document_content);
  if (trimmedContent.length === 0) throw AppError.validation('文档内容不能为空');
  if (utf8ByteLength(request.document_content) > MAX_DOCUMENT_SIZE) {
    throw AppError.validation('文档内容过大，最大支持 10MB');
  }

  const originalName = request.original_document_name ?? null;
  if (originalName !== null) {
    if (
      originalName.includes('../') ||
      originalName.includes('..\\') ||
      originalName.includes('./')
    ) {
      throw AppError.validation('文档名称包含非法字符');
    }
    if (utf8ByteLength(originalName) > 255) {
      throw AppError.validation('文档名称过长，最大支持 255 个字符');
    }
  }

  const options: AnkiGenerationOptions = request.options === null || request.options === undefined
    ? defaultAnkiGenerationOptions()
    : { ...request.options };
  if (options.max_cards_per_mistake > 100) {
    throw AppError.validation('单次生成卡片数量过多，最大支持 100 张');
  }

  if (fsrsFeedbackAuthorized(options.fsrs_feedback)) {
    const provided = options.user_review_profile;
    const injected = (provided !== null && provided !== undefined && rustTrim(provided) !== '')
      ? provided
      : buildFeedbackInjection(
          deps.db,
          request.document_content,
          defaultFsrsFeedbackConfig(),
        );
    if (injected !== null) {
      options.user_review_profile = injected;
      const existing = options.custom_requirements;
      options.custom_requirements = (existing !== null && existing !== undefined && rustTrim(existing) !== '')
        ? `${rustTrim(existing)}\n\n${injected}`
        : injected;
    }
  }

  const documentName = originalName !== null && rustTrim(originalName) !== ''
    ? rustTrim(originalName)
    : `文档_${utcDocumentStamp(Date.now())}`;

  const processor = new DocumentProcessingService(deps.db);
  const [documentId, tasks] = preAllocatedId === null
    ? await processor.processDocumentAndCreateTasks(request.document_content, documentName, options)
    : await processor.processDocumentAndCreateTasksWithId(preAllocatedId, request.document_content, documentName, options);

  documentTracker(documentId);

  try {
    window.emit(ANKI_GENERATION_EVENT, {
      DocumentProcessingStarted: {
        document_id: documentId,
        total_segments: tasks.length,
      },
    });
  } catch (error) {
    deps.logger.warn(`发送文档处理开始事件失败: ${errorText(error)}`);
  }

  let myEpoch: number;
  {
    const entry = deps.registry.entry(documentId);
    entry.paused = false;
    entry.running = true;
    entry.current_task_id = null;
    entry.epoch += 1;
    myEpoch = entry.epoch;
  }

  const spawn = deps.spawn ?? ((work: () => Promise<void>): void => {
    void work().catch((error: unknown) => {
      deps.logger.error(`后台文档处理失败: ${errorText(error)}`);
    });
  });
  spawn(() => processAllTasksAsync(deps, tasks, documentId, myEpoch, window));

  return documentId;
}

/** `process_all_tasks_async`：最多 5 个任务并发，暂停/代际更替时停止调度。 */
export async function processAllTasksAsync(
  deps: EnhancedServiceDeps,
  tasks: readonly DocumentTask[],
  documentId: string,
  myEpoch: number,
  window: AnkiEventWindow,
): Promise<void> {
  const CONCURRENT_TASK_LIMIT = 5;
  let completedCount = 0;
  let skippedCount = 0;
  let cursor = 0;

  const runTask = async (task: DocumentTask): Promise<boolean> => {
    const state = deps.registry.get(documentId);
    if (state === undefined) return false;
    if (state.paused || state.epoch !== myEpoch) return false;

    deps.registry.entry(documentId).current_task_id = task.id;
    const handle = registerRunningTask(task.id);
    try {
      if (deps.generation === null || deps.generation === undefined) {
        throw AppError.configuration(
          'Anki 生成服务不可用：无法执行 process_task_and_generate_cards_stream',
        );
      }
      await deps.generation.processTaskAndGenerateCardsStream(
        task,
        window,
        handle.signal,
        handle.markReady,
      );
    } catch (error) {
      deps.logger.warn(`任务处理失败: ${errorText(error)}`);
    } finally {
      releaseRunningTask(handle);
    }

    const after = deps.registry.get(documentId);
    if (after !== undefined && after.current_task_id === task.id) {
      after.current_task_id = null;
    }
    return true;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cursor >= tasks.length) return;
      const state = deps.registry.get(documentId);
      if (state === undefined || state.paused || state.epoch !== myEpoch) return;
      const task = tasks[cursor]!;
      cursor += 1;
      const executed = await runTask(task);
      if (executed) {
        completedCount += 1;
      } else {
        skippedCount += 1;
        deps.logger.warn(`任务 ${task.id} 因文档暂停被跳过`);
      }
      const current = deps.registry.get(documentId);
      if (current !== undefined && (current.paused || current.epoch !== myEpoch)) {
        deps.logger.warn(
          `文档 ${documentId} 被暂停或调度代际已更替(epoch ${current.epoch} != ${myEpoch})，已完成 ${completedCount} 个任务，跳过 ${skippedCount} 个任务`,
        );
        return;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENT_TASK_LIMIT, Math.max(tasks.length, 1)) },
      () => worker(),
    ),
  );

  const retryTask = buildRetryTaskForDocument(deps, documentId);
  if (retryTask !== null) {
    const state = deps.registry.get(documentId);
    const paused = state?.paused ?? false;
    const stale = state === undefined || state.epoch !== myEpoch;
    if (!paused && !stale) {
      deps.registry.entry(documentId).current_task_id = retryTask.id;
      const handle = registerRunningTask(retryTask.id);
      try {
        if (deps.generation === null || deps.generation === undefined) {
          throw AppError.configuration(
            'Anki 生成服务不可用：无法执行统一重试任务',
          );
        }
        await deps.generation.processTaskAndGenerateCardsStream(
          retryTask,
          window,
          handle.signal,
          handle.markReady,
        );
      } catch (error) {
        deps.logger.warn(`统一重试任务处理失败: ${errorText(error)}`);
      } finally {
        releaseRunningTask(handle);
      }
      const after = deps.registry.get(documentId);
      if (after !== undefined) after.current_task_id = null;
    }
  }

  let shouldEmitCompleted = false;
  const entry = deps.registry.get(documentId);
  if (entry !== undefined && entry.epoch === myEpoch) {
    entry.running = false;
    shouldEmitCompleted = !entry.paused;
    if (!entry.paused) {
      deps.registry.remove(documentId);
      releaseDocumentTracker(documentId);
    }
  }
  if (shouldEmitCompleted) {
    enqueueGeneratedCards(deps, documentId, window);
    try {
      window.emit(ANKI_GENERATION_EVENT, {
        DocumentProcessingCompleted: { document_id: documentId },
      });
    } catch (error) {
      deps.logger.warn(`发送文档处理完成事件失败: ${errorText(error)}`);
    }
  }
}

/**
 * `build_retry_task_for_document`：错误卡统一重试任务。
 * 无任务/已有待处理修复任务/无错误卡时返回 null。
 */
export function buildRetryTaskForDocument(
  deps: EnhancedServiceDeps,
  documentId: string,
): DocumentTask | null {
  const processor = new DocumentProcessingService(deps.db);
  let tasks: DocumentTask[];
  try {
    tasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    throw AppError.database(`获取文档任务失败: ${errorText(error)}`);
  }
  if (tasks.length === 0) return null;
  if (
    tasks.some(
      (task) =>
        (task.status === 'Pending' || task.status === 'Processing') &&
        task.content_segment.includes('错误卡修复'),
    )
  ) {
    deps.logger.warn('🛈 已存在等待中的错误卡修复任务，跳过重复创建');
    return null;
  }

  let errorCards: ReturnType<typeof decodeAnkiCardRow>[] = [];
  try {
    for (const row of listCardsForDocument(deps.db, documentId)) {
      const card = decodeAnkiCardRow(row);
      if (!card.is_error_card) continue;
      const content = card.error_content;
      if (content === null || content === undefined) continue;
      if (content.startsWith(RETRY_ASSIGNMENT_MARK)) continue;
      if (!errorContentIsRepairable(content)) {
        deps.logger.warn(
          `跳过不可修复的错误卡（无实质内容，疑似模型特殊token泄漏）: card_id=${card.id}`,
        );
        continue;
      }
      errorCards.push(card);
    }
  } catch {
    // Rust `if let Ok(cards)`：读取失败时按「无错误卡」继续。
    errorCards = [];
  }
  if (errorCards.length === 0) return null;

  const first = tasks[0]!;
  const newIndex = tasks.reduce((max, task) => Math.max(max, task.segment_index), 0) + 1;
  let aggregated =
    '你将收到若干条‘错误卡片的原始输出片段’（例如被截断/不完整/被安全策略阻断的内容）。\n';
  aggregated += '请逐条修复并补全为有效的 Anki 卡片JSON。\n';
  aggregated += '严格要求：\n- 对每条 ==FIX== 段，输出1个或多个完整卡片JSON\n';
  aggregated += '- 每个卡片JSON输出后紧跟分隔符 <<<ANKI_CARD_JSON_END>>>\n';
  aggregated += '- 不输出任何额外解释或Markdown，只输出JSON与分隔符\n';
  aggregated +=
    '- 卡片内容只能来自片段里的学习材料；片段若只有报错信息、占位符或格式说明，跳过该段，绝不为报错信息、模板或本指令本身制卡\n\n';

  let index = 1;
  for (const card of errorCards) {
    aggregated += `==FIX ${index} | 源任务ID:${card.task_id} | 错误卡ID:${card.id} ==\n`;
    aggregated += card.error_content ?? '';
    aggregated += '\n\n';
    index += 1;
  }

  const now = nowRfc3339();
  const retryTask: DocumentTask = {
    id: globalThis.crypto.randomUUID(),
    document_id: first.document_id,
    original_document_name: `${first.original_document_name} - 错误卡修复`,
    segment_index: newIndex,
    content_segment: aggregated,
    status: 'Pending',
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: first.anki_generation_options_json,
  };

  try {
    insertDocumentTask(deps.db, retryTask);
  } catch (error) {
    throw AppError.database(`插入重试任务失败: ${errorText(error)}`);
  }

  for (const card of errorCards) {
    const content = card.error_content;
    if (content === null || content === undefined) continue;
    if (content.startsWith(RETRY_ASSIGNMENT_MARK)) continue;
    card.error_content = `${RETRY_ASSIGNMENT_MARK}\n${content}`;
    try {
      updateCardRows(deps.db, card, nowRfc3339());
    } catch (error) {
      deps.logger.error(`标记错误卡片为待修复失败: ${errorText(error)}`);
    }
  }

  return retryTask;
}

/** `fsrs://changed` 的 enqueue 载荷（L15 builder 尚未经 api.ts 发布，按 wire 形状本地构造）。 */
export interface FsrsEnqueueChangedPayload {
  source: string;
  action: string;
  entityIds: string[];
  cardStateIds: string[];
  cards: FsrsEnqueuedCard[];
}

export function buildFsrsEnqueueChangedPayload(
  result: FsrsEnqueueResult,
  loadedCards: readonly FsrsEnqueuedCard[],
  source: string,
): FsrsEnqueueChangedPayload | null {
  if (result.enqueuedStateIds.length === 0) return null;
  const byStateId = new Map(loadedCards.map((card) => [card.id, card]));
  const cards: FsrsEnqueuedCard[] = [];
  for (const stateId of result.enqueuedStateIds) {
    const card = byStateId.get(stateId);
    if (card === undefined) return null;
    cards.push(card);
  }
  return {
    source,
    action: 'enqueue',
    entityIds: cards.map((card) => card.ankiCardId),
    cardStateIds: cards.map((card) => card.id),
    cards,
  };
}

/** `enqueue_generated_cards`：失败只告警，绝不阻断完成事件。 */
export function enqueueGeneratedCards(
  deps: EnhancedServiceDeps,
  documentId: string,
  window: AnkiEventWindow,
): void {
  try {
    const result = enqueueDocumentCards(deps.db, documentId, deps.review);
    if (result === null) return;
    deps.logger.info(
      `[EnhancedAnki] 文档 ${documentId} 生成的卡已加入复习: enqueued=${result.enqueued}, skipped=${result.skipped}`,
    );
    if (result.enqueued <= 0) return;
    if (deps.review?.getEnqueuedCards === undefined) return;
    let payload: FsrsEnqueueChangedPayload | null;
    try {
      payload = buildFsrsEnqueueChangedPayload(
        result,
        deps.review.getEnqueuedCards(result),
        'user',
      );
    } catch (error) {
      deps.logger.debug(`[fsrs_review] Failed to load newly enqueued cards for fsrs://changed: ${errorText(error)}`);
      return;
    }
    if (payload === null) return;
    try {
      window.emit('fsrs://changed', payload);
    } catch (error) {
      deps.logger.debug(`[fsrs_review] Failed to emit fsrs://changed: ${errorText(error)}`);
    }
  } catch (error) {
    deps.logger.warn(`[EnhancedAnki] 生成卡自动加入复习失败: ${errorText(error)}`);
  }
}

/** `trigger_task_processing`：手动重试 Pending/Failed/Truncated/Cancelled 任务。 */
export async function triggerTaskProcessing(
  deps: EnhancedServiceDeps,
  taskId: string,
  window: AnkiEventWindow,
): Promise<void> {
  const processor = new DocumentProcessingService(deps.db);
  const task = processor.getTask(taskId);

  // Rust `enhanced_anki_service.rs:704-719`：先按任务状态拒绝，再判运行句柄/取消通道。
  // 顺序即错误分支，不能因为运行句柄更“精确”而提前。
  if (
    task.status !== 'Pending' &&
    task.status !== 'Failed' &&
    task.status !== 'Truncated' &&
    task.status !== 'Cancelled'
  ) {
    throw AppError.validation('任务状态不是待处理');
  }

  // 防重入：任务已注册运行句柄或取消通道时拒绝重复触发。
  if (hasRunningTask(taskId) || await deps.streaming.isStreaming(taskId)) {
    throw AppError.validation('任务正在处理中，请勿重复触发');
  }

  if (deps.generation === null || deps.generation === undefined) {
    throw AppError.configuration(
      'Anki 生成服务不可用：无法执行 process_task_and_generate_cards_stream',
    );
  }

  const documentId = task.document_id;
  const spawn = deps.spawn ?? ((work: () => Promise<void>): void => {
    void work().catch((error: unknown) => {
      deps.logger.error(`后台任务处理失败: ${errorText(error)}`);
    });
  });

  const handle = registerRunningTask(taskId);
  spawn(async () => {
    try {
      await deps.generation!.processTaskAndGenerateCardsStream(
        task,
        window,
        handle.signal,
        handle.markReady,
      );
    } catch (error) {
      deps.logger.warn(`任务处理失败: ${errorText(error)}`);
    } finally {
      releaseRunningTask(handle);
    }

    const allTerminal = (() => {
      try {
        return processor.getDocumentTasks(documentId).every(
          (candidate) =>
            candidate.status !== 'Pending' &&
            candidate.status !== 'Processing' &&
            candidate.status !== 'Streaming' &&
            candidate.status !== 'Paused',
        );
      } catch {
        return false;
      }
    })();
    if (allTerminal && deps.registry.get(documentId) === undefined) {
      releaseDocumentTracker(documentId);
    }
  });
}

// ============================================================================
// Rust `#[cfg(test)]` 中的无事件暂停/恢复辅助（`enhanced_anki_service.rs:1114-1155`）
// ============================================================================

/** 测试镜像：暂停文档并暂停首个未完成任务（Rust `__test_pause_no_emit`）。 */
export function testPauseNoEmit(
  deps: EnhancedServiceDeps,
  documentId: string,
): void {
  deps.registry.entry(documentId).paused = true;
  const processor = new DocumentProcessingService(deps.db);
  let tasks: DocumentTask[];
  try {
    tasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    // Rust `if let Ok(doc_tasks)`：读取失败时静默跳过（无日志）。
    if (error instanceof Error) return;
    throw error;
  }
  const first = tasks.find(
    (task) => task.status === 'Processing' || task.status === 'Streaming' || task.status === 'Pending',
  );
  if (first !== undefined) processor.updateTaskStatus(first.id, 'Paused', null);
}

/** 测试镜像：清除暂停并恢复全部 Paused 任务为 Pending（Rust `__test_resume_no_emit`）。 */
export function testResumeNoEmit(deps: EnhancedServiceDeps, documentId: string): void {
  deps.registry.entry(documentId).paused = false;
  const processor = new DocumentProcessingService(deps.db);
  let tasks: DocumentTask[];
  try {
    tasks = processor.getDocumentTasks(documentId);
  } catch (error) {
    // Rust `if let Ok(tasks)`：读取失败时静默跳过（无日志）。
    if (error instanceof Error) return;
    throw error;
  }
  for (const task of tasks) {
    if (task.status === 'Paused') processor.updateTaskStatus(task.id, 'Pending', null);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
