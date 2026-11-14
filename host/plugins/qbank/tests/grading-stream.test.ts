/**
 * `qbank_grading/stream.rs` 的流完成状态测试。
 *
 * 供应商错误、截断、取消和 EOF 都不能被正常的 [DONE] 覆盖；诊断状态与
 * 错误文案保留给失败草稿。适配器使用 llm-providers 的真实实现。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import {
  AnthropicAdapter, GeminiAdapter, OpenAIAdapter, OpenAIResponsesAdapter,
} from '../../llm-providers/api.ts';
import { GradingStreamState } from '../src/grading-stream.ts';

function decode(blocks: string[]): {
  state: GradingStreamState; text: string; error: ReturnType<GradingStreamState['complete']>;
} {
  const config = { model: 'test-reasoner', max_output_tokens: 128000 };
  const adapter = new OpenAIAdapter();
  adapter.buildRequest('https://example.com/v1', 'test', config.model, {});
  const state = new GradingStreamState(config);
  let text = '';
  const onChunk = (chunk: string): void => { text += chunk; };
  for (const block of blocks) state.processBlock(adapter, block, onChunk);
  state.finishAdapter(adapter, onChunk);
  const error = state.complete(false, null);
  return { state, text, error };
}

describe('qbank_grading/stream.rs', () => {
  it('normal_finish_without_sentinel_preserves_content_and_trailing_usage', () => {
    const { state, text, error } = decode([
      'data: {"choices":[{"delta":{"content":"反馈<verdict>correct</verdict>"},'
        + '"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"completion_tokens":42000}}',
    ]);
    expect(error).toBeNull();
    expect(state.diagnostics.status).toBe('completed');
    expect(state.diagnostics.max_output_tokens).toBe(128000);
    expect(state.diagnostics.usage).toMatchObject({ completion_tokens: 42000 });
    expect(text.endsWith('</verdict>')).toBe(true);
  });

  it('length_is_truncated_even_with_a_valid_tag_and_done', () => {
    const { state, text, error } = decode([
      'data: {"choices":[{"delta":{"content":"<verdict>correct</verdict>"},'
        + '"finish_reason":"length"}]}',
      'data: [DONE]',
    ]);
    expect(state.diagnostics.status).toBe('truncated');
    expect(error?.message).toContain('128000');
    expect(text).not.toBe('');
  });

  it('provider_errors_are_not_hidden_by_done', () => {
    const { state, text, error } = decode([
      'data: {"choices":[{"delta":{"content":"草稿"},"finish_reason":null}]}',
      'data: {"error":{"message":"quota exceeded","code":"quota"}}',
      'data: [DONE]',
    ]);
    expect(state.diagnostics.status).toBe('provider_error');
    expect(text).toBe('草稿');
    expect(error?.message).toContain('quota exceeded');
  });

  it('reasoning_only_without_a_terminal_marker_is_incomplete', () => {
    const { state, text, error } = decode([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"},'
        + '"finish_reason":null}]}',
    ]);
    expect(state.diagnostics.status).toBe('incomplete');
    expect(state.diagnostics.reasoning_chars).toBe(8);
    expect(text).toBe('');
    expect(error).not.toBeNull();
  });

  it('anthropic_max_tokens_is_truncated_not_completed', () => {
    const adapter = new AnthropicAdapter();
    const state = new GradingStreamState({});
    let text = '';
    const onChunk = (chunk: string): void => { text += chunk; };
    state.processBlock(adapter,
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"draft"}}',
      onChunk);
    state.processBlock(adapter,
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},'
      + '"usage":{"output_tokens":8192}}', onChunk);
    state.processBlock(adapter, 'data: {"type":"message_stop"}', onChunk);
    state.finishAdapter(adapter, onChunk);
    expect(state.complete(false, null)).not.toBeNull();
    expect(state.diagnostics.status).toBe('truncated');
    expect(text).toBe('draft');
  });

  it('responses_incomplete_preserves_terminal_draft_and_usage', () => {
    const adapter = new OpenAIResponsesAdapter();
    const state = new GradingStreamState({});
    let text = '';
    const onChunk = (chunk: string): void => { text += chunk; };
    state.processBlock(adapter,
      'data: {"type":"response.incomplete","response":{"status":"incomplete",'
      + '"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message",'
      + '"content":[{"type":"output_text","text":"draft"}]}],"usage":{"output_tokens":8192}}}',
      onChunk);
    state.finishAdapter(adapter, onChunk);
    expect(state.complete(false, null)).not.toBeNull();
    expect(state.diagnostics.status).toBe('truncated');
    expect(text).toBe('draft');
    expect(state.diagnostics.usage).toMatchObject({ output_tokens: 8192 });
  });

  it('provider_failure_and_transport_eof_have_distinct_statuses', () => {
    const provider = new GradingStreamState({});
    provider.httpError(429, '{"error":{"message":"rate limit"}}');
    const httpError = provider.complete(false, null);
    expect(provider.diagnostics.status).toBe('provider_error');
    expect(httpError?.message).toContain('429');
    expect(httpError?.message).toContain('rate limit');

    const transport = new GradingStreamState({});
    transport.complete(false, AppError.network('connection reset'));
    expect(transport.diagnostics.status).toBe('transport_error');

    const configuration = new GradingStreamState({});
    configuration.complete(false, AppError.configuration('model not configured'));
    expect(configuration.diagnostics.status).toBe('configuration_error');
  });

  it('gemini_stop_finish_reason_completes_without_done_sentinel', () => {
    const adapter = new GeminiAdapter();
    const state = new GradingStreamState({});
    let text = '';
    const onChunk = (chunk: string): void => { text += chunk; };
    state.processBlock(adapter,
      'data: {"candidates":[{"content":{"parts":[{"text":"feedback <verdict>correct</verdict>"}]},'
      + '"finishReason":"STOP"}]}', onChunk);
    state.finishAdapter(adapter, onChunk);
    expect(state.complete(false, null)).toBeNull();
    expect(state.diagnostics.status).toBe('completed');
    expect(text).toContain('feedback');
  });
});
