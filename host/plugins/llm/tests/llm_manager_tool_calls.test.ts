import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../platform/errors/api.ts';
import {
  convertOpenaiToolCall, mergeConsecutiveToolCalls,
  type ToolCallMessage,
} from '../src/tool_calls.ts';

function asRecord(value: JsonValue | null | undefined): { [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function toolCallMessage(id: string, reasoning: string | null = null): ToolCallMessage {
  return {
    role: 'assistant',
    content: '',
    thinkingContent: reasoning,
    toolCall: { id, toolName: 'builtin_test', argsJson: {} },
  };
}

describe('llm_manager/mod.rs', () => {
  it('convert_openai_tool_call_treats_empty_string_arguments_as_empty_object', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function',
      function: {
        name: 'group_list',
        arguments: '',
      },
    };

    const converted = convertOpenaiToolCall(toolCall);

    expect(converted.toolName).toBe('group_list');
    expect(converted.argsJson).toEqual({});
  });

  it('convert_openai_tool_call_treats_whitespace_arguments_as_empty_object', () => {
    const toolCall = {
      id: 'call_2',
      type: 'function',
      function: {
        name: 'tag_list_all',
        arguments: '   \n\t  ',
      },
    };

    const converted = convertOpenaiToolCall(toolCall);

    expect(converted.toolName).toBe('tag_list_all');
    expect(converted.argsJson).toEqual({});
  });

  it('authoring_tool_never_repairs_truncated_question_or_material_arrays', () => {
    for (const name of [
      'builtin-qbank_batch_import',
      'qbank_import_document',
      'builtin-qbank_commit_authoring_draft',
    ]) {
      const call = {
        id: 'call-cut',
        type: 'function',
        function: {
          name,
          arguments: '{"questions":[{"content":"complete"}],"materials":[{"content":"unfinished',
        },
      };
      let message = '';
      try {
        convertOpenaiToolCall(call);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('INCOMPLETE_TOOL_ARGUMENTS');
    }
  });

  it('merge_consecutive_tool_calls_preserves_empty_reasoning_content', () => {
    const history = [toolCallMessage('call_empty_reasoning', '')];

    const merged = mergeConsecutiveToolCalls(history);

    const first = merged[0];
    expect(first?.kind).toBe('mergedToolCalls');
    if (first === undefined || first.kind !== 'mergedToolCalls') {
      throw new Error('expected merged tool call message');
    }
    expect(first.thinkingContent).toBe('');
  });

  it('merge_consecutive_tool_calls_preserves_responses_reasoning_item_and_round_text', () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'reasoning_1',
      encrypted_content: 'encrypted-state',
    };
    const message = toolCallMessage('call_1');
    message.content = 'Calling the tool';
    message.metadata = {
      openai_responses_reasoning_item: reasoningItem,
    };

    const merged = mergeConsecutiveToolCalls([message]);

    const first = merged[0];
    expect(first?.kind).toBe('mergedToolCalls');
    if (first === undefined || first.kind !== 'mergedToolCalls') {
      throw new Error('expected merged tool call message');
    }
    expect(first.content).toBe('Calling the tool');
    expect(first.responseReasoningItem).toEqual(reasoningItem);
  });

  it('merge_consecutive_tool_calls_splits_distinct_responses_reasoning_rounds', () => {
    const first = toolCallMessage('call_1');
    first.metadata = {
      openai_responses_reasoning_item: { type: 'reasoning', id: 'reasoning_1' },
    };
    const second = toolCallMessage('call_2');
    second.metadata = {
      openai_responses_reasoning_item: { type: 'reasoning', id: 'reasoning_2' },
    };

    const merged = mergeConsecutiveToolCalls([first, second]);
    const rounds = merged.flatMap((message) => (message.kind === 'mergedToolCalls' ? [message] : []));

    expect(rounds.length).toBe(2);
    expect(rounds[0]?.toolCalls[0]?.id).toBe('call_1');
    expect(asRecord(rounds[0]?.responseReasoningItem).id).toBe('reasoning_1');
    expect(rounds[1]?.toolCalls[0]?.id).toBe('call_2');
    expect(asRecord(rounds[1]?.responseReasoningItem).id).toBe('reasoning_2');
  });

  it('merge_consecutive_tool_calls_combines_split_state_for_parallel_responses_calls', () => {
    const first = toolCallMessage('call_1', 'reasoning text');
    first.content = 'Calling tools';
    const second = toolCallMessage('call_2');
    second.metadata = {
      openai_responses_reasoning_item: {
        type: 'reasoning',
        id: 'reasoning_1',
        content: [{ type: 'reasoning_text', text: 'reasoning text' }],
      },
    };

    const merged = mergeConsecutiveToolCalls([first, second]);

    const head = merged[0];
    expect(head?.kind).toBe('mergedToolCalls');
    if (head === undefined || head.kind !== 'mergedToolCalls') {
      throw new Error('expected one merged parallel tool-call round');
    }
    expect(head.toolCalls.length).toBe(2);
    expect(head.thinkingContent).toBe('reasoning text');
    expect(asRecord(head.responseReasoningItem).id).toBe('reasoning_1');
    expect(merged.length).toBe(1);
  });
});
