/**
 * L02 `llmQuestionAuthoring@1`（`LLMManager::run_question_json`，dstu-llm/llm_manager/question_authoring.rs）的 qbank 调用点。
 * L02 以 CommandError(AppError) 拒绝；qbank 服务层统一以 QbankServiceError 传播同一 AppError（Rust `?`）。
 */
import { CommandError } from '../../../kernel/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { ApiConfig, LlmQuestionAuthoring } from '../../llm/api.ts';
import { QbankServiceError } from './question-service.ts';

export type QuestionJsonCompletion = Awaited<ReturnType<LlmQuestionAuthoring['runQuestionJson']>>;

export async function runQuestionJson(service: LlmQuestionAuthoring, config: ApiConfig, systemPrompt: string,
  userContent: JsonValue, cancel: AbortSignal | null): Promise<QuestionJsonCompletion> {
  try {
    return await service.runQuestionJson(config, systemPrompt, userContent, cancel);
  } catch (error) {
    if (error instanceof CommandError) throw new QbankServiceError(error.value);
    throw error;
  }
}
