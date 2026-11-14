/**
 * 文档处理运行控制的统一装配：IPC 命令（`cmd/enhanced_anki.rs`）与 `anki.pipeline`
 * 门面（L24 `chatanki_run/start/control`，`chatanki_executor.rs:6483-6759,8296-8480`）共用同一个
 * `EnhancedAnkiService` 依赖，事件同走 `anki_generation_event`（Rust `Window::emit`）。
 */
import type { Context } from '../../../kernel/api.ts';
import type { DocumentTask, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { LlmAnkiRouting, LLMManager, LlmRawPrompt, LlmStreamingService } from '../../llm/api.ts';
import type { NativeRegex } from '../../../platform/native/api.ts';
import type { AnkiDocumentPipeline } from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { throwApp, messages } from './plugin-runtime.ts';
import {
  buildRetryTaskForDocument,
  cancelDocumentProcessing,
  enhancedServiceDepsFor,
  pauseDocumentProcessing,
  processAllTasksAsync,
  resumeDocumentProcessing,
  startDocumentProcessing,
  type AnkiEventWindow,
  type EnhancedServiceDeps,
} from './enhanced-service.ts';
import { DocumentProcessingService } from './document-processing.ts';
import { AnkiGenerationService } from './generation-service.ts';
import { cancelStreaming, StreamingAnkiService } from './streaming-anki.ts';

/** Tauri 主窗口的 `emit`：发到 Host 后端事件总线。 */
export function backendEventWindow(ctx: Context): AnkiEventWindow {
  return {
    emit(event: string, payload: unknown): void {
      ctx.backendEvents.emit(event, payload);
    },
  };
}

/**
 * 本 lane 的生成服务；缺 L02 `llm` / `llmStreaming` 时返回 null，
 * 有 LLM 但缺 F7 `nativeRegex` 时显式 Configuration 失败（不回退到具体 import 的单例）。
 */
export function createGenerationService(ctx: Context, db: DatabaseHandle): AnkiGenerationService | null {
  const llm = ctx.get('llm') as LLMManager | undefined;
  const streaming = ctx.get('llmStreaming') as LlmStreamingService | undefined;
  if (llm === undefined || streaming === undefined) return null;
  const nativeRegex = ctx.get('nativeRegex') as NativeRegex | undefined;
  if (nativeRegex === undefined) {
    throwApp(
      'Configuration',
      'Anki 生成服务不可用：F7 未提供 nativeRegex 服务',
    );
  }
  const routing = (ctx.get('llmAnkiRouting') as LlmAnkiRouting | undefined) ?? null;
  const rawPrompt = (ctx.get('llmRawPrompt') as LlmRawPrompt | undefined) ?? null;
  const streamingAnki = new StreamingAnkiService({ db, regex: nativeRegex, logger: ctx.logger });
  return new AnkiGenerationService(
    { db, llm, streaming, regex: nativeRegex, logger: ctx.logger, routing, rawPrompt },
    streamingAnki,
  );
}

/** 启动/恢复/触发用的完整依赖：生成服务、L15 入队与后台调度（Rust `tokio::spawn`）。 */
export function generationDepsFor(
  ctx: Context,
  db: DatabaseHandle,
  window: AnkiEventWindow,
): EnhancedServiceDeps {
  const deps: EnhancedServiceDeps = {
    ...enhancedServiceDepsFor(ctx, db),
    generation: createGenerationService(ctx, db),
    review: (ctx.get('review') as EnhancedServiceDeps['review']) ?? null,
    spawn: (work) => {
      void work().catch((error: unknown) => {
        ctx.logger.error(`后台文档处理失败: ${messages(error)}`);
      });
    },
  };
  deps.scheduleRemaining = (tasks, documentId, epoch) => {
    deps.spawn!(() => processAllTasksAsync(deps, tasks, documentId, epoch, window));
  };
  return deps;
}

/** 启动前检查：缺 L02 生成服务时在建任务之前失败，不留下无人调度的 Pending 任务。 */
export function requireGeneration(deps: EnhancedServiceDeps): void {
  if (deps.generation === null || deps.generation === undefined) {
    throw AppError.configuration('Anki 生成服务不可用：L02 未提供 llm / llmStreaming 服务');
  }
}

export function createAnkiDocumentPipeline(ctx: Context, db: () => DatabaseHandle): AnkiDocumentPipeline {
  const backend = backendEventWindow(ctx);
  return {
    startDocumentProcessingWithId: async (request, preAllocatedDocumentId, events = backend) => {
      const deps = generationDepsFor(ctx, db(), events);
      requireGeneration(deps);
      return startDocumentProcessing(deps, request, events, preAllocatedDocumentId);
    },
    cancelStreaming: (taskId) => cancelStreaming(taskId),
    pauseDocumentProcessing: (documentId, events = backend) =>
      pauseDocumentProcessing(enhancedServiceDepsFor(ctx, db()), documentId, events),
    resumeDocumentProcessing: (documentId, events = backend) =>
      resumeDocumentProcessing(generationDepsFor(ctx, db(), events), documentId, events),
    cancelDocumentProcessing: (documentId, events = backend) =>
      cancelDocumentProcessing(enhancedServiceDepsFor(ctx, db()), documentId, events),
    buildRetryTaskForDocument: (documentId): DocumentTask | null =>
      buildRetryTaskForDocument(enhancedServiceDepsFor(ctx, db()), documentId),
    getTask: (taskId): DocumentTask => new DocumentProcessingService(db()).getTask(taskId),
    updateTaskStatus: (taskId, status: TaskStatus, errorMessage): void =>
      new DocumentProcessingService(db()).updateTaskStatus(taskId, status, errorMessage),
  };
}
