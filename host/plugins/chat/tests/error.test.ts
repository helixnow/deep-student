import { describe, expect, it } from 'vitest';
import { ChatV2Error } from '../api.ts';

describe('chat_v2/error.rs', () => {
  it('test_error_display', () => {
    expect(new ChatV2Error('SessionNotFound', 'sess_123').toString()).toBe('Session not found: sess_123');
    expect(new ChatV2Error('MessageNotFound', 'msg_456').toString()).toBe('Message not found: msg_456');
    expect(new ChatV2Error('BlockNotFound', 'blk_789').toString()).toBe('Block not found: blk_789');
    expect(new ChatV2Error('Cancelled').toString()).toBe('Cancelled');
  });
  it('test_variant_error_display', () => {
    expect(new ChatV2Error('VariantNotFound', 'var_123').toString()).toBe('Variant not found: var_123');
    expect(new ChatV2Error('VariantCannotActivateFailed', 'var_456').toString()).toBe('Cannot activate failed variant: var_456');
    expect(new ChatV2Error('VariantCannotDeleteLast').toString()).toBe('Cannot delete last variant');
    expect(new ChatV2Error('VariantAlreadyStreaming', 'var_789').toString()).toBe('Variant already streaming: var_789');
    expect(new ChatV2Error('VariantCannotRetry', ['var_abc', 'success']).toString()).toBe('Cannot retry variant: var_abc, current status: success');
  });
  it('test_error_to_string_conversion', () => {
    expect(JSON.parse(new ChatV2Error('Database', 'connection failed').toCommandError())).toEqual({
      code: 'DATABASE_ERROR', message: 'Database error: connection failed',
    });
  });
  it('test_command_error_code_stability', () => {
    expect(new ChatV2Error('SessionNotFound', '').code()).toBe('SESSION_NOT_FOUND');
    expect(new ChatV2Error('Validation', '').code()).toBe('VALIDATION_ERROR');
    expect(new ChatV2Error('InvalidInput', '').code()).toBe('INVALID_INPUT');
    expect(new ChatV2Error('Timeout', '').code()).toBe('TIMEOUT');
    const parsed = JSON.parse(new ChatV2Error('Timeout', 'approval_expired').toCommandError());
    expect(parsed.code).toBe('TIMEOUT');
    expect(parsed.message).toContain('approval_expired');
  });
  it('test_timeout_error', () => {
    expect(new ChatV2Error('Timeout', "Tool 'web_search' execution timed out after 180s").toString())
      .toBe("Tool execution timeout: Tool 'web_search' execution timed out after 180s");
  });
});
