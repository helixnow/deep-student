/**
 * `qbank_generation/mod.rs::qbank_ai_generate_questions` 命令层：
 * serde 默认值解码 → 解析出题模型 → create_task → 后台执行 → 全局任务事件。
 *
 * 参考资料收集（`collectReferences`）由调用方注入；L18/L13b 接口进 main 后在
 * index.ts 接线并注册命令，在此之前不注册。
 */
import { nanoid } from 'nanoid';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ApiConfig, LLMManager, LlmOcrModels, LlmQuestionAuthoring } from '../../llm/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type {
  GenerationTaskView, QbankGenerationRequest, QuestionGenerationSpec, ReferenceFileBase64,
} from '../api.ts';
import {
  createTask, getTask, markCancelled, markCompleted, markFailed, markRunning, saveAuthoringResult, taskView,
} from '../repository/generation-tasks.ts';
import * as authoring from './authoring-service.ts';
import { pickVisualFallback, validateAuthoringConfig } from './authoring-route.ts';
import { attachFigures, loadPageImageBytes } from './generation-figures.ts';
import {
  executeGenerationTask, type GenerationRunnerPorts, type GenerationTaskPorts, type ReferenceBundle,
} from './generation-runner.ts';
import type { GenerationSessions } from './generation-session.ts';
import type { CropImageCodec } from './native-image.ts';
import type { QbankLogger, QbankPorts } from './ports.ts';
import { runQuestionJson } from './question-authoring-llm.ts';
import { QbankServiceError } from './question-service.ts';

/** 全局任务事件名（events.rs:16）。 */
export const QBANK_GENERATION_TASK_EVENT = 'qbank_generation_task_event';

/** 完整（已应用 serde 默认值）的请求，字段顺序同 Rust 结构体，供 request_json 序列化。 */
export type DecodedGenerationRequest = Required<QbankGenerationRequest> & {
  specs: Required<QuestionGenerationSpec>[];
};

/** serde 默认值：max_questions=10、spec.count=1、Vec/bool/Option 取空值。 */
export function decodeGenerationRequest(request: QbankGenerationRequest): DecodedGenerationRequest {
  return {
    exam_id: request.exam_id,
    stream_session_id: request.stream_session_id,
    model_config_id: request.model_config_id ?? null,
    max_questions: request.max_questions ?? 10,
    specs: (request.specs ?? []).map(spec => ({
      question_type: spec.question_type, count: spec.count ?? 1, difficulty: spec.difficulty ?? null,
    })),
    difficulty: request.difficulty ?? null,
    topic_hint: request.topic_hint ?? null,
    based_on_existing: request.based_on_existing ?? false,
    language: request.language ?? null,
    reference_file_ids: request.reference_file_ids ?? [],
    reference_files_base64: (request.reference_files_base64 ?? [])
      .map((file: ReferenceFileBase64) => ({ name: file.name, base64: file.base64 })),
    knowledge_points: request.knowledge_points ?? [],
  };
}

export interface GenerationCommandHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
  readonly repos: VfsReposService;
  readonly llm: LLMManager;
  /** L02 `llmQuestionAuthoring@1`。 */
  readonly questionAuthoring: LlmQuestionAuthoring;
  readonly ocr: LlmOcrModels | undefined;
  readonly nativeImage: CropImageCodec | null;
  readonly ports: QbankPorts;
  readonly generationSessions: GenerationSessions;
  readonly log: QbankLogger & { info: NonNullable<QbankLogger['info']> };
  /** `reference.rs::collect_references`（L18/L13b 接口接线后提供）。 */
  collectReferences(request: QbankGenerationRequest, isMultimodal: boolean): Promise<ReferenceBundle>;
  emit(event: string, payload: unknown): void;
  /** `background_tasks::spawn`；返回 null 表示进程正在退出、拒绝准入。 */
  spawn(task: () => Promise<void>): Promise<void> | null;
}

async function callLlm<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    if (error instanceof CommandError) throw new QbankServiceError(error.value);
    throw error;
  }
}

/** Rust `LLMManager::resolve_question_authoring_config`。 */
export async function resolveQuestionAuthoringConfig(llm: LLMManager, modelConfigId: string | null): Promise<ApiConfig> {
  const config = modelConfigId === null
    ? await callLlm(() => llm.getModel2Config())
    : (await callLlm(() => llm.getApiConfigs())).find(item => item.id === modelConfigId);
  return validateAuthoringConfig(config, modelConfigId);
}

/** Rust `question_authoring_runner::resolve_visual_fallback`。 */
async function resolveVisualFallback(host: GenerationCommandHost): Promise<ApiConfig> {
  let ocrConfig: ApiConfig | null = null;
  try {
    ocrConfig = await host.ocr?.getOcrModelConfig() ?? null;
  } catch {
    ocrConfig = null; // Rust `if let Ok(config)`
  }
  const configs = await callLlm(() => host.llm.getApiConfigs());
  const engines = host.ocr === undefined ? [] : await callLlm(() => host.ocr!.getAvailableOcrModels());
  const visual = pickVisualFallback(configs, ocrConfig, engines);
  if (visual === null) {
    throw new QbankServiceError(AppError.configuration('当前主模型无视觉能力，且未配置可用的多模态视觉兜底模型'));
  }
  return visual;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** events.rs `emit_task_event`：发送失败只记日志。 */
function emitTaskEvent(host: GenerationCommandHost, view: GenerationTaskView): void {
  try {
    host.emit(QBANK_GENERATION_TASK_EVENT, view);
  } catch (error) {
    host.log.error(`[QbankGeneration] 发送任务事件失败: task_id=${view.id}, status=${view.status}, error=${messageOf(error)}`);
  }
}

export function generationTaskPorts(host: GenerationCommandHost): GenerationTaskPorts {
  return {
    log: host.log,
    getTask: taskId => getTask(host.db, taskId),
    markRunning: taskId => markRunning(host.db, taskId),
    saveAuthoringResult: (taskId, response) => saveAuthoringResult(host.db, taskId, response),
    markCompleted: (taskId, response) => markCompleted(host.db, taskId, response.drafts, response.rejected_count,
      response.rejection_reasons, response.skipped_references, response.used_reference_count),
    markFailed: (taskId, message) => markFailed(host.db, taskId, message),
    markCancelled: taskId => markCancelled(host.db, taskId),
    emitCurrentTask: (taskId) => {
      // mod.rs `emit_current_task`
      let record;
      try {
        record = getTask(host.db, taskId);
      } catch (error) {
        host.log.warn(`[QbankGeneration] 读取任务失败: id=${taskId}, ${messageOf(error)}`);
        return;
      }
      if (record === null) {
        host.log.warn(`[QbankGeneration] 任务不存在，无法发事件: ${taskId}`);
        return;
      }
      emitTaskEvent(host, taskView(record));
    },
  };
}

export function generationRunnerPorts(host: GenerationCommandHost): GenerationRunnerPorts {
  const figures = { db: host.db, blobsDir: host.blobsDir, repos: host.repos, nativeImage: host.nativeImage };
  const authoringHost: authoring.AuthoringHost = { ...host.ports, db: host.db, questions: host.repos.questions };
  return {
    log: host.log,
    sessions: host.generationSessions,
    collectExamContext: (examId) => {
      // pipeline.rs `collect_exam_context`：题目集读取失败向上传播；题目列表失败忽略。
      const sheet = host.repos.exams.getExamSheet(host.db, examId);
      const examName = sheet?.examName ?? '未命名题目集';
      const samples: string[] = [];
      try {
        for (const question of host.repos.questions.listQuestions(host.db, examId, {}, 1, 100).questions) {
          samples.push(question.content);
        }
      } catch { // boundary-allow empty-catch: Rust `if let Ok(result)` 列表失败时不附样本且无日志
      }
      return { examName, samples };
    },
    resolveAuthoringConfig: modelConfigId => resolveQuestionAuthoringConfig(host.llm, modelConfigId),
    resolveVisualFallback: () => resolveVisualFallback(host),
    collectReferences: (request, isMultimodal) => host.collectReferences(request, isMultimodal),
    loadPageImageBytes: blobHash => loadPageImageBytes(figures, blobHash),
    runQuestionJson: (config, systemPrompt, userContent, cancel) =>
      runQuestionJson(host.questionAuthoring, config, systemPrompt, userContent, cancel),
    attachFigures: (raw, bundle) => attachFigures(figures, raw, bundle),
    saveDraft: (examId, document, metadata) => authoring.saveDraft(authoringHost, examId, document, metadata),
    getDraft: jobId => authoring.getDraft(authoringHost, jobId),
  };
}

/** Rust `qbank_ai_generate_questions`：立即返回任务视图，后台执行。 */
export async function submitGenerationTask(host: GenerationCommandHost,
  input: QbankGenerationRequest): Promise<GenerationTaskView> {
  const request = decodeGenerationRequest(input);
  const config = await resolveQuestionAuthoringConfig(host.llm, request.model_config_id);
  const taskId = `task_${nanoid(10)}`;
  const streamEvent = `qbank_generation_stream_${request.stream_session_id}`;
  const requestJson = JSON.stringify(request);
  let record;
  try {
    record = createTask(host.db, taskId, request.exam_id, requestJson, streamEvent);
  } catch (error) {
    throw new QbankServiceError(AppError.database(messageOf(error)));
  }
  const view = taskView(record);
  host.log.info(`[QbankGeneration] 提交后台出题任务: id=${taskId}, exam=${request.exam_id}, specs=${request.specs.length}, max_questions=${request.max_questions}`);
  spawnGenerationTask(host, taskId, request, config);
  return view;
}

/** Rust `spawn_generation_task_with_config`（命令层与对话工具共用）。 */
export function spawnGenerationTask(host: GenerationCommandHost, taskId: string, request: DecodedGenerationRequest,
  config: ApiConfig): void {
  const tasks = generationTaskPorts(host);
  const runner = generationRunnerPorts(host);
  // Rust 忽略 background_tasks::spawn 的返回值；退出阶段拒绝准入由平台层记 warn，
  // 任务留在 queued，由下次启动的 finalizer `qbank.recover-interrupted-tasks`（src/startup-recovery.ts）改为 failed。
  host.spawn(() => executeGenerationTask(taskId, request, tasks, runner, config));
}
