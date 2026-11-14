import { describe, expect, it } from 'vitest';
import type { MessageBlock, ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { contentTextFromBlocks, toolResultsToMessages } from '../src/history.ts';

function block(id: string, type: string, content: string | null): MessageBlock {
  return {
    id,
    messageId: 'msg_1',
    type,
    status: 'success',
    content,
  };
}

function toolResult(overrides: Partial<ToolResultInfo> = {}): ToolResultInfo {
  return {
    toolCallId: 'call_123',
    blockId: 'blk_test_123',
    toolName: 'test_tool',
    input: { arg: 'value' },
    output: { result: 'success' },
    success: true,
    durationMs: 100,
    ...overrides,
  };
}

describe('chat_v2/pipeline_tests.rs::tests (block and tool message helpers)', () => {
  it('test_content_block_filter', () => {
    const blocks = [
      block('blk_1', 'thinking', '思考内容'),
      block('blk_2', 'content', '正文内容1'),
      block('blk_3', 'rag', null),
      block('blk_4', 'content', '正文内容2'),
    ];
    expect(contentTextFromBlocks(blocks)).toBe('正文内容1正文内容2');
  });

  it('test_tool_results_to_messages', () => {
    const messages = toolResultsToMessages([toolResult()]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('assistant');
    expect(messages[0]!.tool_call).toBeDefined();
    expect(messages[1]!.role).toBe('tool');
    expect(messages[1]!.tool_result).toBeDefined();
  });

  it('test_tool_results_to_messages_format', () => {
    const messages = toolResultsToMessages([toolResult({
      toolCallId: 'call_abc',
      toolName: 'web_search',
      input: { query: 'rust async' },
      output: { results: [{ title: 'Async Rust' }] },
    })]);

    expect(messages).toHaveLength(2);
    const assistant = messages[0]!;
    expect(assistant.tool_call).toEqual({
      id: 'call_abc',
      tool_name: 'web_search',
      args_json: { query: 'rust async' },
    });
    // The tool message carries the serialized output, byte-for-byte.
    expect(messages[1]!.content).toBe(JSON.stringify({ results: [{ title: 'Async Rust' }] }));
    expect(messages[1]!.tool_result).toEqual({
      call_id: 'call_abc',
      ok: true,
      error: null,
      data_json: { results: [{ title: 'Async Rust' }] },
    });
  });

  it('tool_results_pair_each_call_with_its_result_and_first_reasoning', () => {
    const messages = toolResultsToMessages(
      [toolResult({ toolCallId: 'call_1' }), toolResult({ toolCallId: 'call_2' })],
      {
        pendingReasoning: 'pending-reasoning',
        reasoningItemByToolCallId: new Map([['call_2', { id: 'rs_2' }]]),
      },
    );
    expect(messages.map(message => message.role))
      .toEqual(['assistant', 'tool', 'assistant', 'tool']);
    // Only the first assistant message replays the pending reasoning content.
    expect(messages[0]!.thinking_content).toBe('pending-reasoning');
    expect(messages[2]!.thinking_content).toBeNull();
    expect(messages[2]!.metadata).toEqual({ openai_responses_reasoning_item: { id: 'rs_2' } });
    expect(messages[1]!.tool_result?.call_id).toBe('call_1');
    expect(messages[3]!.tool_result?.call_id).toBe('call_2');
  });
});
