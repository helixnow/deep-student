/**
 * L02 llm@1 的最小需求接口（`LLMManager::call_model2_raw_prompt`）。
 * L02 的 api.ts 尚未发布该方法；本 lane 只按 DRAFT 需要的形状声明，
 * 由协调者转给 L02 增补。测试用 createTestHost({ provide: { llm: … } }) 提供替身。
 */
import type {} from '@deepseek-ai/cordis';

/** `llm_usage::CallerType::Other` 的线上形状（serde 外部标签）。 */
export interface RawPromptCaller {
  Other: string;
}

export interface RawPromptOutput {
  assistant_message: string;
}

export interface RawPromptLlm {
  callModel2RawPrompt(
    prompt: string,
    images: null,
    caller: RawPromptCaller,
  ): Promise<RawPromptOutput>;
}
