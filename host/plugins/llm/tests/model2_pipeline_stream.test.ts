import { describe, expect, it } from 'vitest';
import { OpenAIAdapter, OpenAIResponsesAdapter } from '../../llm-providers/api.ts';
import {
  DEFAULT_RAW_PROMPT_OPTIONS, SseEventBuffer, processSseStreamInput,
  providerStreamFailureMessage, rawPromptThinkingOverride, validateStreamPayload,
  validateStreamTermination,
} from '../src/stream_validation.ts';
import { llmErrorCode, classifyLlmError, attachLlmErrorCode,
  LLM_ERROR_CODE_EMPTY_RESPONSE, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED } from '../src/routing.ts';
import { AppError } from '../../../platform/errors/api.ts';

describe('llm_manager/model2_pipeline.rs', () => {
  it('responses_eof_without_trailing_newline_keeps_terminal_events', () => {
    const buffer = new SseEventBuffer();
    const terminal = 'data: {"type":"response.completed","response":{'
      + '"output":['
      + '{"type":"reasoning","id":"rs_1","encrypted_content":"opaque","summary":[]},'
      + '{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"}'
      + '],"usage":{"input_tokens":1,"output_tokens":2}}}';
    expect(processSseStreamInput(buffer, Buffer.from(terminal, 'utf8'))).toEqual([]);
    const blocks = processSseStreamInput(buffer, null);
    expect(blocks.length).toBe(1);

    const events = new OpenAIResponsesAdapter().parseStream(blocks[0]!);
    expect(events.some((event) => event.type === 'ResponseReasoningItem'
      && (event.value as { id: string }).id === 'rs_1')).toBe(true);
    expect(events.some((event) => event.type === 'ToolCall'
      && ((event.value as { function: { name: string } }).function.name === 'lookup'))).toBe(true);
    expect(events.some((event) => event.type === 'Usage'
      && (event.value as { input_tokens: number }).input_tokens === 1)).toBe(true);
    expect(events.at(-1)?.type).toBe('Done');
  });

  it('stream_input_reassembles_chinese_split_across_byte_chunks', () => {
    const source = 'data: {"choices":[{"delta":{"content":"数学题"}}]}\n\n';
    const bytes = Buffer.from(source, 'utf8');
    const split = bytes.indexOf(Buffer.from('数', 'utf8')) + 1;

    const buffer = new SseEventBuffer();
    const first = processSseStreamInput(buffer, bytes.subarray(0, split));
    expect(first).toEqual([]);

    const blocks = processSseStreamInput(buffer, bytes.subarray(split));
    blocks.push(...processSseStreamInput(buffer, null));
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.includes('\u{fffd}')).toBe(false);

    const events = new OpenAIAdapter().parseStream(blocks[0]!);
    expect(events.some((event) => event.type === 'ContentChunk' && event.value === '数学题')).toBe(true);
  });

  it('codex_stream_requires_an_explicit_terminal_success', () => {
    const error = validateStreamTermination(true, false, null, true);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('OpenAI Codex');
    expect(error!.message).toContain('未收到完整结束标记');
    expect(validateStreamTermination(true, true, null, true)).toBeNull();
  });

  it('completed_stream_requires_content_reasoning_or_tool_call', () => {
    const error = validateStreamPayload(false, '', '', 0);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('空响应');
    expect(llmErrorCode(error!)).toBe(LLM_ERROR_CODE_EMPTY_RESPONSE);
    expect(classifyLlmError(error!)).toBe('RetryableTransient');

    expect(validateStreamPayload(false, 'answer', '', 0)).toBeNull();
    expect(validateStreamPayload(false, '', 'thinking', 0)).toBeNull();
    expect(validateStreamPayload(false, '', '', 1)).toBeNull();
    expect(validateStreamPayload(true, '', '', 0)).toBeNull();
  });

  it('raw_prompt_options_disable_thinking_semantics', () => {
    expect(rawPromptThinkingOverride(DEFAULT_RAW_PROMPT_OPTIONS)).toBeNull();
    expect(rawPromptThinkingOverride({ forceJson: true, disableThinking: true })).toBe(false);
  });

  it('context_window_code_is_non_retryable_but_tagged', () => {
    const error = attachLlmErrorCode(
      AppError.llm('HTTP 400 - maximum context length exceeded'),
      LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED,
    );
    expect(classifyLlmError(error)).toBe('NonRetryable');
    expect(llmErrorCode(error)).toBe(LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED);
  });

  it('openai_responses_api_key_stream_requires_an_explicit_terminal_success', () => {
    const error = validateStreamTermination(true, false, null, false);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('LLM provider');
    expect(error!.message).toContain('未收到完整结束标记');
    expect(error!.message.includes('OpenAI Codex')).toBe(false);
  });

  it('provider_incomplete_reason_takes_precedence_over_terminal_success', () => {
    const message = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'response.incomplete',
      details: { reason: 'max_output_tokens' },
    }, true, true);
    expect(message).toContain('输出上限');
    expect(message).toContain('继续');

    const error = validateStreamTermination(true, true, message, true);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('输出上限');
  });

  it('provider_failure_keeps_upstream_message_for_numeric_codes', () => {
    const message = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'stream_error',
      details: {
        code: 429,
        message: 'Provider returned error: rate limit exceeded for gpt-5',
      },
    }, false, false);
    expect(message).toContain('模型回复未完整结束');
    expect(message).toContain('rate limit exceeded for gpt-5');
  });

  it('provider_failure_falls_back_to_nested_and_top_level_messages', () => {
    const nested = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'response.failed',
      details: { error: { message: 'insufficient_quota: 余额不足' } },
    }, true, false);
    expect(nested).toContain('insufficient_quota: 余额不足');

    const topLevel = providerStreamFailureMessage({
      type: 'provider_error',
      message: 'upstream gateway closed the connection',
    }, false, false);
    expect(topLevel).toContain('upstream gateway closed the connection');

    const plainDetails = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'stream_error',
      details: 'Bad gateway',
    }, false, false);
    expect(plainDetails).toContain('Bad gateway');
  });

  it('provider_failure_classifies_known_reasons_and_truncates_detail', () => {
    const cancelled = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'response.cancelled',
      details: { code: 499 },
    }, true, true);
    expect(cancelled).toContain('OpenAI Codex');
    expect(cancelled).toContain('上游取消');

    const filtered = providerStreamFailureMessage({
      type: 'content_blocked',
      reason: 'safety',
      stop_details: { category: 'self_harm' },
    }, false, false);
    expect(filtered).toContain('内容安全策略中止');

    const longDetail = `<html>${'x'.repeat(500)}</html>`;
    const truncated = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'max_tokens',
      details: { message: longDetail },
    }, false, false);
    expect(truncated).toContain('输出上限');
    expect(truncated).toContain('上游返回：<html>');
    expect(truncated.endsWith('...')).toBe(true);
    const detailPart = truncated.split('上游返回：').at(-1)!;
    expect([...detailPart].length).toBeLessThanOrEqual(203);
  });

  it('provider_failure_without_upstream_message_keeps_plain_classification', () => {
    const message = providerStreamFailureMessage({
      type: 'provider_error',
      reason: 'response.incomplete',
      details: { reason: 'max_output_tokens' },
    }, true, false);
    expect(message).toContain('输出上限');
    expect(message.includes('上游返回')).toBe(false);
  });
});
