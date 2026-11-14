/**
 * chat_v2/context.rs + pipeline/history.rs — LLM message reconstruction
 * helpers that do not depend on the session repository.
 */
import type {
  MessageBlock, ToolResultInfo,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { LegacyChatMessage } from './microcompact.ts';

export const BLOCK_TYPE_CONTENT = 'content';
export const BLOCK_TYPE_THINKING = 'thinking';

/** Only `content` blocks contribute text; thinking/tool blocks are excluded. */
export function contentTextFromBlocks(blocks: readonly MessageBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type !== BLOCK_TYPE_CONTENT) continue;
    text += block.content ?? '';
  }
  return text;
}

export interface ToolResultsToMessagesOptions {
  /** `response_reasoning_by_tool_call_id`: Responses reasoning item per call. */
  reasoningItemByToolCallId?: ReadonlyMap<string, unknown>;
  /** `pending_reasoning_for_api`: attached to the first assistant message only. */
  pendingReasoning?: string | null;
}

/**
 * One assistant `tool_call` message followed by the matching `tool` result for
 * every tool result, in order. This is the OpenAI-required pairing.
 */
export function toolResultsToMessages(toolResults: readonly ToolResultInfo[],
  options: ToolResultsToMessagesOptions = {}): LegacyChatMessage[] {
  const messages: LegacyChatMessage[] = [];
  let isFirstAssistantMessage = true;

  for (const result of toolResults) {
    const toolCallId = result.toolCallId ?? '';
    const reasoningItem = options.reasoningItemByToolCallId?.get(toolCallId);
    const thinkingContent = isFirstAssistantMessage
      ? (options.pendingReasoning ?? null)
      : null;
    isFirstAssistantMessage = false;

    messages.push({
      role: 'assistant',
      content: '',
      tool_call: {
        id: toolCallId,
        tool_name: result.toolName,
        args_json: result.input,
      },
      thinking_content: thinkingContent,
      ...(reasoningItem === undefined
        ? {}
        : { metadata: { openai_responses_reasoning_item: reasoningItem } }),
    });

    messages.push({
      role: 'tool',
      content: JSON.stringify(result.output) ?? '',
      tool_result: {
        call_id: toolCallId,
        ok: result.success,
        error: result.error ?? null,
        data_json: result.output,
      },
    });
  }
  return messages;
}
