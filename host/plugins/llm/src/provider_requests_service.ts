/** Provider conversion and post-adapter diagnostics from model2_pipeline.rs:6202–6267. */
import type { LlmProviderRequests } from '../api.ts';
import type { LlmAdapterService, LlmCodexAuthService } from '../../llm-providers/api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { preparePlainProviderRequest, prepareProviderRequest } from './prepared_request.ts';
import { chatV2SessionScopeAndGeneration } from './stream_scope.ts';
import { logPostAdapterFingerprint } from './cache_debug.ts';

export function createProviderRequests(adapters: LlmAdapterService, codex?: LlmCodexAuthService): LlmProviderRequests {
  return {
    async prepareModel2Async(config, body, streamEvent, messageId, cacheDebugEnabled) {
      const protocol = effectiveApiProtocolForConfig(config);
      const adapter = adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
        : protocol === 'google_generate_content' ? 'gemini' : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
      const session = chatV2SessionScopeAndGeneration(streamEvent)?.[0] ?? null;
      const prepared = await prepareProviderRequest(adapters, codex, adapter, config, body, null,
        session ?? messageId ?? 'chat_stream', '对话请求构建失败', session);
      if (cacheDebugEnabled) logPostAdapterFingerprint(streamEvent, config.model, prepared.request.body);
      return { ...prepared, adapter, requiresExplicitStreamCompletion: adapter.requiresExplicitStreamCompletion() };
    },
    prepareModel2(config, body, streamEvent, messageId, cacheDebugEnabled) {
      const protocol = effectiveApiProtocolForConfig(config);
      const adapter = adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
        : protocol === 'google_generate_content' ? 'gemini' : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
      const session = chatV2SessionScopeAndGeneration(streamEvent)?.[0] ?? null;
      const request = preparePlainProviderRequest(adapter, config, body, null, session ?? messageId ?? 'chat_stream',
        '对话请求构建失败', session);
      if (cacheDebugEnabled) logPostAdapterFingerprint(streamEvent, config.model, request.body);
      return { request, adapter, requiresExplicitStreamCompletion: adapter.requiresExplicitStreamCompletion() };
    },
  };
}
