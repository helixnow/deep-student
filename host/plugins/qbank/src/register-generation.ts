import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { QbankGenerationRequest, QbankGradingRequest } from '../api.ts';
import { getTask, isTerminal, listTasks, markCancelled, taskView } from '../repository/generation-tasks.ts';
import { submitGenerationTask } from './generation-command.ts';
import { AppErrorThrow, llmGradingCompletion, runQbankGrading } from './grading-service.ts';
import { QbankServiceError } from './question-service.ts';
import { serviceCallAsync, type QbankPluginDeps } from './plugin-deps.ts';

/** AI question generation tasks and AI grading commands. */
export function registerGeneration(deps: QbankPluginDeps): void {
  const { ctx, qbank, log } = deps;
  ctx.commands.register<{ taskId: string }>('qbank_get_generation_task', ({ taskId }) => {
    try {
      const record = getTask(ctx.storage.database('vfs'), taskId);
      return record === null ? null : taskView(record);
    } catch (error) {
      throw new CommandError(AppError.database(error instanceof Error ? error.message : String(error)));
    }
  });
  ctx.commands.register<{ examId: string; limit: number | null }>('qbank_list_generation_tasks', ({ examId, limit }) => {
    try {
      return listTasks(ctx.storage.database('vfs'), examId, Math.min(limit ?? 20, 100)).map(taskView);
    } catch (error) {
      throw new CommandError(AppError.database(error instanceof Error ? error.message : String(error)));
    }
  });

  ctx.commands.register<{ request: QbankGenerationRequest }>('qbank_ai_generate_questions', ({ request }) =>
    serviceCallAsync(() => submitGenerationTask(deps.generationHost(), request)));
  ctx.commands.register<{ taskId: string }>('qbank_cancel_generation_task', ({ taskId }) =>
    serviceCallAsync(async () => {
      const db = ctx.storage.database('vfs');
      const record = getTask(db, taskId);
      if (record === null) {
        log.warn(`[QbankGeneration] 取消任务时任务不存在: ${taskId}`);
        return null;
      }
      if (isTerminal(record.status)) {
        log.info(`[QbankGeneration] 任务已处于终态，无需取消: id=${taskId}, status=${record.status}`);
        return taskView(record);
      }
      log.info(`[QbankGeneration] 请求取消任务: id=${taskId}, stream_event=${record.stream_event}`);
      const llm = ctx.get('llm') as LLMManager | undefined;
      if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供'));
      await llm.requestCancelStream(record.stream_event);
      qbank.generationSessions.cancel(record.stream_event);
      markCancelled(db, taskId);
      return taskView(record);
    }));
  ctx.commands.register<{ streamEventName: string }>('qbank_cancel_grading', ({ streamEventName }) =>
    serviceCallAsync(async () => {
      const llm = ctx.get('llm');
      if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供'));
      log.info(`[QbankGrading] 取消评判流: ${streamEventName}`);
      await llm.requestCancelStream(streamEventName);
      return null;
    }));

  ctx.commands.register<{ request: QbankGradingRequest }>('qbank_ai_grade', ({ request }) =>
    serviceCallAsync(async () => {
      const completion = llmGradingCompletion(
        () => ctx.get('llm') as LLMManager | undefined,
        () => ctx.get('llmStreaming') as LlmStreamingService | undefined);
      try {
        return await runQbankGrading(deps.gradingHost(), request, completion,
          deps.gradingEmitter());
      } catch (failure) {
        if (failure instanceof AppErrorThrow) throw new QbankServiceError(failure.appError);
        throw failure;
      }
    }));
}
