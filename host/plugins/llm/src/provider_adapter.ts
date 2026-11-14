/**
 * 按生效协议选择供应商传输适配器（llm_manager/mod.rs build_provider_adapter）。
 *
 * 选择只看 `effective_api_protocol_for_config`，不看 model_adapter：中转站上的
 * anthropic/google 模型在 Chat Completions 协议下必须继续走 OpenAI 适配器。
 */
import {
  AnthropicAdapter, GeminiAdapter, OpenAIAdapter, OpenAIResponsesAdapter,
  type ProviderAdapter,
} from '../../llm-providers/api.ts';
import type { ApiConfig } from '../api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';

export function providerAdapterForConfig(config: ApiConfig): ProviderAdapter {
  switch (effectiveApiProtocolForConfig(config)) {
    case 'openai_responses':
      return new OpenAIResponsesAdapter();
    case 'anthropic_messages':
      return new AnthropicAdapter();
    case 'google_generate_content':
      return new GeminiAdapter();
    default:
      return new OpenAIAdapter();
  }
}
