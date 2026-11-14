/** Complete history-to-messages phase, model2_pipeline.rs:5350–5818/6109–6122. */
import type { ApiConfig, Model2HistoryMessage } from '../api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { charCount, rustTrim, takeChars, utf8ByteLength } from '../../../platform/util/portable.ts';
import { LATEX_OUTPUT_BRIEF } from '../../llm-providers/api.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';
import { resolveQuirks } from './provider_quirks.ts';
import { mergeConsecutiveToolCalls, type ToolCallMessage } from './tool_calls.ts';
import { attachReasoningPassbackPayload } from './passback.ts';
import { shouldPassbackPlainAssistantReasoningForRequest } from './reasoning_policy.ts';
import { attachResponseReasoningReplayItem, attachWebSearchReplayItems } from './replay.ts';
import { appendInjectionToCurrentUserMessage, mergeConsecutiveUserMessagesRespectingTransients, transientUserContentsForMerge } from './injection.ts';
import { logDebug, logInfo } from './logging.ts';
import { detectImageFormatFromBase64 as imageFormat } from './image_format.ts';
import { sanitizeHistoryReasoningForTarget } from './reasoning_state_scope.ts';

type JsonObject = { [key: string]: JsonValue };

/** mod.rs:8549; intentionally concatenates without inserting separators. */
function coalesce(texts: readonly string[]): string | null {
  let result = '', count = 0;
  for (const [index, text] of texts.entries()) {
    let chunk = rustTrim(text);
    if (chunk === '') continue;
    const originalLength = charCount(chunk);
    if (originalLength > 1600) {
      chunk = takeChars(chunk, 1600);
      logDebug(`  [${index}] 注入段超限，截断 ${originalLength} -> ${charCount(chunk)} 字符`);
    }
    const length = charCount(chunk);
    if (count + length > 20_000) {
      logDebug(`  [${index}] 注入总量已达上限，停止继续追加（当前 ${count} 字符）`); break;
    }
    logDebug(`  [${index}] 收录注入段，长度 ${length} 字符`);
    result += chunk; count += length;
  }
  if (result === '') return null;
  logDebug(`[Inject] 合并注入文本总长度: ${count} 字符`);
  logDebug(`[Inject] 注入预览: ${takeChars(result, 200)}`);
  return result;
}

export function buildModel2Messages(config: ApiConfig, history: readonly Model2HistoryMessage[],
  systemPrompt: string | null, requestHasTools: boolean, injectionTexts: readonly string[], deepseekFiles = false): JsonValue[] {
  const messages: JsonObject[] = [{ role: 'system', content: [{ type: 'text',
    text: systemPrompt ?? `你是一个教学专家。请仔细分析这道错题，提供详细的解题思路和知识点讲解。\n\n${LATEX_OUTPUT_BRIEF}`,
    cache_control: { type: 'ephemeral' } }] }];
  const originals = new Map<ToolCallMessage, Model2HistoryMessage>();
  const normalized = history.map(original => {
    // Legacy unscoped history keeps its existing replay policy. Scoped state may
    // only be replayed against the exact provider/endpoint/model/protocol target.
    let message = original;
    if (original.stateScope != null) {
      message = sanitizeHistoryReasoningForTarget([original], config)[0]!;
      if (message !== original && message.metadata?.openai_responses_reasoning_item !== undefined) {
        const metadata = { ...message.metadata };
        delete metadata.openai_responses_reasoning_item;
        message = { ...message, metadata };
      }
    }
    const value: ToolCallMessage = { role: message.role, content: message.content, metadata: message.metadata,
      thinkingContent: message.thinking_content, thoughtSignature: message.thought_signature,
      toolCall: message.tool_call == null ? null : { id: message.tool_call.id, toolName: message.tool_call.tool_name, argsJson: message.tool_call.args_json } };
    originals.set(value, message); return value;
  });
  const adapter = requestAdapterForConfig(config), policy = resolveQuirks(config).reasoning_passback;
  const policyName = { no_passback: 'NoPassback', deep_seek_style: 'DeepSeekStyle', reasoning_details: 'ReasoningDetails' }[policy];
  let deepseekFileCount = 0;
  for (const merged of mergeConsecutiveToolCalls(normalized)) {
    if (merged.kind === 'mergedToolCalls') {
      const calls = merged.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.argsJson) } }));
      let assistant: JsonObject = { role: 'assistant', content: merged.content, tool_calls: calls };
      const thinking = merged.thinkingContent;
      if (thinking !== null && thinking !== '') {
        const formatted = adapter.formatToolCallMessage(calls, thinking);
        if (formatted !== null) {
          assistant = { role: 'assistant', content: formatted as JsonValue };
          logDebug(`[LLMManager] Adapter ${adapter.id} format: ${calls.length} tool_calls with thinking block (len=${utf8ByteLength(thinking)})`);
        } else if (policy !== 'no_passback') {
          attachReasoningPassbackPayload(assistant, policy, thinking);
          logDebug(`[LLMManager] Reasoning model: ${calls.length} tool_calls with thinking (policy=${policyName})`);
        } else logDebug(`[LLMManager] Merged ${calls.length} tool_calls into single assistant message (no custom format)`);
      } else if (thinking !== null && policy !== 'no_passback') {
        attachReasoningPassbackPayload(assistant, policy, thinking);
        logDebug(`[LLMManager] Reasoning model: ${calls.length} tool_calls with empty/present thinking payload (policy=${policyName})`);
      } else logDebug(`[LLMManager] Merged ${calls.length} tool_calls into single assistant message`);
      if (merged.thoughtSignature !== null) assistant.thought_signature = merged.thoughtSignature;
      if (merged.responseReasoningItem !== null) assistant.response_reasoning_item = merged.responseReasoningItem;
      messages.push(assistant); continue;
    }
    const message = originals.get(merged.message)!;
    if (message.role === 'user') {
      if (config.isMultimodal && message.multimodal_content?.length) {
        const content = message.multimodal_content.map((part): JsonValue => part.type === 'text' ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.base64}` } });
        logInfo(`[LLMManager] Using multimodal_content mode with ${content.length} parts (interleaved text/image)`);
        messages.push({ role: 'user', content });
      } else {
        let content = message.content;
        if (message.doc_attachments?.length) {
          content += '\n\n--- 附件内容 ---';
          for (const doc of message.doc_attachments) {
            content += `\n\n【文档: ${doc.name}】`;
            if (doc.text_content != null) content += `\n${doc.text_content}`;
          }
        }
        messages.push({ role: 'user', content: config.isMultimodal && message.image_base64?.length
          ? [{ type: 'text', text: content }, ...message.image_base64.map(image => ({ type: 'image_url', image_url: { url: `data:image/${imageFormat(image)};base64,${image}` } }))]
          : content });
      }
      if (deepseekFiles && Array.isArray(message.metadata?.canonicalContent)) {
        const ids = new Set(message.metadata.canonicalContent.flatMap(part => {
          if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'file_ref'
            && part.deepseek_config_id === config.id && typeof part.deepseek_file_id === 'string'
            && part.deepseek_file_id.startsWith('file-api-')) return [part.deepseek_file_id];
          return [];
        }));
        if (ids.size) {
          deepseekFileCount += ids.size;
          if (deepseekFileCount > 20) throw AppError.validation('DeepSeek supports at most 20 files per request, including chat history');
          const user = messages.at(-1)!;
          const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: user.content ?? '' }];
          user.content = [...[...ids].map(file_id => ({ type: 'input_file', file_id })), ...parts];
        }
      }
    } else if (message.role === 'assistant') {
      const thinking = message.thinking_content;
      let assistant: JsonObject = { role: 'assistant', content: message.content };
      if (thinking != null && thinking !== '' && adapter.requiresThinkingInHistory(config)) {
        const formatted = adapter.formatToolCallMessage([], thinking);
        const blocks: JsonValue[] = formatted === null ? [{ type: 'thinking', thinking }]
          : Array.isArray(formatted) ? structuredClone(formatted) as JsonValue[] : [formatted as JsonValue];
        if (message.content !== '') blocks.push({ type: 'text', text: message.content });
        assistant = { role: 'assistant', content: blocks };
      } else if (thinking != null && thinking !== '' && shouldPassbackPlainAssistantReasoningForRequest(config, requestHasTools)) {
        if (policy === 'deep_seek_style') assistant.reasoning_content = thinking;
        else if (policy === 'reasoning_details') assistant.reasoning_details = [{ type: 'thinking', text: thinking,
          ...(message.thought_signature == null ? {} : { signature: message.thought_signature }) }];
      }
      attachWebSearchReplayItems(message.metadata, assistant);
      attachResponseReasoningReplayItem(message.metadata, assistant);
      messages.push(assistant);
    } else if (message.role === 'tool') {
      messages.push(message.tool_result == null ? { role: 'assistant', content: message.content }
        : { role: 'tool', tool_call_id: message.tool_result.call_id, content: message.content });
    }
  }
  const transient = transientUserContentsForMerge([...history]);
  mergeConsecutiveUserMessagesRespectingTransients(messages, transient);
  const injection = coalesce(injectionTexts);
  if (injection !== null) appendInjectionToCurrentUserMessage(messages, injection, transient);
  return messages;
}
