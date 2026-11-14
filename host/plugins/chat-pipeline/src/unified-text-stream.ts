/** tool_loop.rs:811–847/1176–1243 — L03 consumption of L02's real unified stream contract. */
import type { WindowRef } from '../../../kernel/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { LLMManager, LlmModel2Streaming, Model2HistoryMessage, StreamEventSink } from '../../llm/api.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import type { UnifiedTextStream } from './text-execution.ts';
import { sinkUntilAbandoned } from './stream-watchdog.ts';
import { cloneAgentJson, isRawJsonAtom } from '../../../kernel/agent-api.ts';

/** Outbound Value boundary: internal tool/meta values must already be JSON, as in Rust serde_json::Value. */
function json(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isRawJsonAtom(value)) return value as unknown as JsonValue;
  if (Array.isArray(value)) return value.map(json);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = json(item);
    return result;
  }
  throw new TypeError('LLM message contains a non-JSON value');
}

export function messageForModel2(message: LegacyChatMessage): Model2HistoryMessage {
  const metadata = message.metadata == null ? null : json(message.metadata);
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('LLM message metadata must be a JSON object');
  }
  return {
    role: message.role, content: message.content, thinking_content: message.thinking_content,
    thought_signature: message.thought_signature, metadata,
    tool_call: message.tool_call == null ? null : { ...message.tool_call, args_json: json(message.tool_call.args_json) },
    tool_result: message.tool_result == null ? null : cloneAgentJson(message.tool_result),
    doc_attachments: message.doc_attachments == null ? null : structuredClone(message.doc_attachments),
    image_base64: message.image_base64 == null ? null : [...message.image_base64],
    multimodal_content: message.multimodal_content == null ? null : structuredClone(message.multimodal_content),
  };
}

export function createUnifiedTextStream(service: LlmModel2Streaming, manager: LLMManager,
  sink: StreamEventSink, window: WindowRef | null): UnifiedTextStream {
  return {
    async call(request) {
      const options = request.options;
      const context: Record<string, JsonValue> = {
        chat_v2_compaction_checked: request.compactionChecked ?? false,
        memory_enabled: options.memoryEnabled ?? true,
        rag_enabled: options.ragEnabled ?? true,
        web_search_enabled: options.webSearchEnabled ?? true,
        deepseek_web_tools_disabled: options.disableTools ?? false,
      };
      for (const [source, key] of [['rag', 'prefetched_rag_sources'], ['memory', 'prefetched_memory_sources'],
        ['webSearch', 'prefetched_web_search_sources']] as const) {
        const sources = request.sources?.[source];
        if (sources != null) context[key] = json(sources);
      }
      let cancellation: Promise<void> | undefined;
      const cancel = () => { cancellation ??= manager.requestCancelStream(request.streamEvent); };
      request.signal.addEventListener('abort', cancel, { once: true });
      try {
        if (request.signal.aborted) { cancel(); await cancellation; }
        const result = await service.callUnifiedModel2Stream({
          context, chatHistory: request.messages.map(messageForModel2), subject: '',
          enableChainOfThought: true, enableThinking: options.enableThinking ?? false,
          taskContext: 'chat_v2', sink: sinkUntilAbandoned(sink, request.signal), streamEvent: request.streamEvent, messageId: request.messageId,
          traceId: null, window, disableTools: true, maxInputTokensOverride: options.contextLimit ?? null,
          modelOverrideId: options.model2OverrideId ?? options.modelId ?? null,
          systemPromptOverride: request.systemPrompt,
          paramOverrides: { temperature: options.temperature, topP: options.topP,
            frequencyPenalty: options.frequencyPenalty, presencePenalty: options.presencePenalty,
            maxOutputTokens: options.maxTokens },
          reasoningEffortOverride: options.reasoningEffort ?? null, thinkingBudgetOverride: options.thinkingBudget ?? null,
        });
        return { cancelled: result.cancelled, assistantMessage: result.assistant_message };
      } finally {
        request.signal.removeEventListener('abort', cancel);
        await cancellation;
      }
    },
  };
}
