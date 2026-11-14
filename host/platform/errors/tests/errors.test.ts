import { expect, it } from 'vitest';
import { AppError, CommandErrorEnvelope, ErrorDetails, ErrorDetailsBuilder, http_status_to_error_code, infer_error_code_from_message, type ActionSuggestion } from '../api.ts';

it('AppError constructors preserve models.rs variants and always include details', () => {
  const variants = { validation: 'Validation', database: 'Database', llm: 'LLM', file_system: 'FileSystem', not_found: 'NotFound', configuration: 'Configuration', network: 'Network', authentication: 'Network', unknown: 'Unknown', internal: 'Unknown', operation_failed: 'Unknown', conflict: 'Conflict', not_implemented: 'Unknown' } as const;
  for (const [name, variant] of Object.entries(variants)) {
    expect(AppError[name as keyof typeof variants]('message')).toEqual({ error_type: variant, message: 'message', details: null });
  }
  expect(AppError.with_details('Database', 'failed', { operation: 'read' })).toEqual({ error_type: 'Database', message: 'failed', details: { operation: 'read' } });
});
it('test_error_details_builder', () => {
  const error = ErrorDetailsBuilder.api_key_missing('OpenAI');
  expect(error.code).toBe('API_KEY_MISSING');
  expect(error.suggestions.length).toBeGreaterThan(0);
  expect(error.suggestions[0]!.action_type).toBe('settings');
});
it('test_http_status_conversion', () => {
  expect(http_status_to_error_code(401)).toBe('HTTP_UNAUTHORIZED');
  expect(http_status_to_error_code(429)).toBe('HTTP_TOO_MANY_REQUESTS');
  expect(http_status_to_error_code(500)).toBe('HTTP_SERVER_ERROR');
});
it('command_error_serializes_camel_case_and_skips_none', () => {
  const value = CommandErrorEnvelope.with_trace_id(CommandErrorEnvelope.with_data(CommandErrorEnvelope.new('VFS_CONFLICT', 'optimistic lock conflict'), { key: 'notes.conflict' }), 'trace-123');
  expect(value).toEqual({ code: 'VFS_CONFLICT', message: 'optimistic lock conflict', data: { key: 'notes.conflict' }, traceId: 'trace-123' });
  const minimal = CommandErrorEnvelope.new('X', 'y');
  expect(minimal).not.toHaveProperty('data');
  expect(minimal).not.toHaveProperty('traceId');
});
it('command_error_from_error_details_reuses_screaming_code', () => {
  const envelope = CommandErrorEnvelope.from(ErrorDetailsBuilder.api_key_missing('OpenAI'));
  expect(envelope.code).toBe('API_KEY_MISSING');
  expect(envelope.message).toContain('OpenAI');
});
it('command_error_code_is_stable_across_message_changes', () => {
  const old = CommandErrorEnvelope.new('VFS_NOT_FOUND', 'Note not found: n1');
  const next = CommandErrorEnvelope.new('VFS_NOT_FOUND', '笔记不存在（id=n1），可能已被删除');
  expect(old.code).toBe(next.code);
  expect(old.message).not.toBe(next.message);
});
it('test_error_inference', () => {
  expect(infer_error_code_from_message('API key is missing')).toBe('API_KEY_MISSING');
  expect(infer_error_code_from_message('Request timeout')).toBe('NETWORK_TIMEOUT');
  expect(infer_error_code_from_message('Too many requests')).toBe('RATE_LIMIT');
});

it('test_error_details_creation', () => {
  const error = ErrorDetails.new('API_KEY_MISSING', 'API key not found', '请配置API密钥');
  expect(error.code).toBe('API_KEY_MISSING');
  expect(error.message).toBe('API key not found');
  expect(error.user_message).toBe('请配置API密钥');
  expect(error.suggestions).toEqual([]);
  expect(error.trace_id).toBeNull();
  expect(error.context).toBeNull();
});

it('test_error_details_builder_methods', () => {
  const withSuggestion = ErrorDetails.with_suggestion(ErrorDetails.new('NETWORK_TIMEOUT', 'Request timeout', '网络请求超时'), {
    action_type: 'retry', label: '重试', url: null, data: null,
  });
  const error = ErrorDetails.with_context(ErrorDetails.with_trace_id(withSuggestion, 'trace_123'), 'timeout_ms', 5000);
  expect(error.suggestions).toHaveLength(1);
  expect(error.suggestions[0]!.action_type).toBe('retry');
  expect(error.trace_id).toBe('trace_123');
  expect(error.context).toEqual({ timeout_ms: 5000 });
});

it('test_error_details_builder_api_key_missing', () => {
  const error = ErrorDetailsBuilder.api_key_missing('OpenAI');
  expect(error.code).toBe('API_KEY_MISSING');
  expect(error.message).toContain('OpenAI');
  expect(error.user_message).toContain('OpenAI');
  expect(error.suggestions.length).toBeGreaterThan(0);
  expect(error.suggestions[0]!.action_type).toBe('settings');
  expect(error.suggestions[0]!.label).toBe('Open Settings');
});

it('test_error_details_builder_api_key_invalid', () => {
  const error = ErrorDetailsBuilder.api_key_invalid('SerpAPI');
  expect(error.code).toBe('API_KEY_INVALID');
  expect(error.message).toContain('SerpAPI');
  expect(error.suggestions).toHaveLength(2);
  const actionTypes = error.suggestions.map(item => item.action_type);
  expect(actionTypes).toContain('settings');
  expect(actionTypes).toContain('retry');
});

it('test_error_details_builder_network_error', () => {
  const error = ErrorDetailsBuilder.network_error('Connection refused');
  expect(error.code).toBe('NETWORK_UNREACHABLE');
  expect(error.message).toContain('Connection refused');
  expect(error.suggestions).toHaveLength(2);
  const actionTypes = error.suggestions.map(item => item.action_type);
  expect(actionTypes).toContain('check_network');
  expect(actionTypes).toContain('retry');
});

it('test_error_details_builder_rate_limit', () => {
  const error = ErrorDetailsBuilder.rate_limit_error('Tavily', 30);
  expect(error.code).toBe('RATE_LIMIT');
  expect(error.message).toContain('Tavily');
  expect(error.user_message).toContain('30秒');
  expect(error.suggestions.length).toBeGreaterThan(0);
  expect(error.suggestions[0]!.action_type).toBe('retry');
  expect(error.context).toMatchObject({ retry_after_seconds: 30 });
});

it('test_error_details_builder_service_unavailable', () => {
  const error = ErrorDetailsBuilder.service_unavailable('Bing');
  expect(error.code).toBe('SERVICE_UNAVAILABLE');
  expect(error.message).toContain('Bing');
  expect(error.suggestions).toHaveLength(2);
  const actionTypes = error.suggestions.map(item => item.action_type);
  expect(actionTypes).toContain('retry');
  expect(actionTypes).toContain('contact_support');
});

it('test_error_details_builder_tool_not_found', () => {
  const error = ErrorDetailsBuilder.tool_not_found('unknown_tool');
  expect(error.code).toBe('TOOL_NOT_FOUND');
  expect(error.message).toContain('unknown_tool');
  expect(error.suggestions.length).toBeGreaterThan(0);
  expect(error.suggestions[0]!.action_type).toBe('settings');
  expect(error.suggestions[0]!.url).toContain('tools');
});

it('test_error_details_builder_tool_timeout', () => {
  const error = ErrorDetailsBuilder.tool_timeout('web_search', 10000);
  expect(error.code).toBe('TOOL_TIMEOUT');
  expect(error.message).toContain('web_search');
  expect(error.user_message).toContain('10000毫秒');
  expect(error.suggestions.length).toBeGreaterThan(0);
  expect(error.suggestions[0]!.action_type).toBe('retry');
  expect(error.context).toMatchObject({ timeout_ms: 10000 });
});

it('test_error_details_builder_parse_error', () => {
  const error = ErrorDetailsBuilder.parse_error('JSON', 'Unexpected token at line 5');
  expect(error.code).toBe('PARSE_ERROR');
  expect(error.message).toContain('JSON');
  expect(error.message).toContain('Unexpected token');
  expect(error.suggestions).toHaveLength(2);
  const actionTypes = error.suggestions.map(item => item.action_type);
  expect(actionTypes).toContain('retry');
  expect(actionTypes).toContain('contact_support');
});

it('test_http_status_to_error_code', () => {
  expect(http_status_to_error_code(400)).toBe('HTTP_BAD_REQUEST');
  expect(http_status_to_error_code(401)).toBe('HTTP_UNAUTHORIZED');
  expect(http_status_to_error_code(403)).toBe('HTTP_FORBIDDEN');
  expect(http_status_to_error_code(404)).toBe('HTTP_NOT_FOUND');
  expect(http_status_to_error_code(429)).toBe('HTTP_TOO_MANY_REQUESTS');
  expect(http_status_to_error_code(450)).toBe('HTTP_CLIENT_ERROR');
  expect(http_status_to_error_code(500)).toBe('HTTP_SERVER_ERROR');
  expect(http_status_to_error_code(502)).toBe('HTTP_SERVER_ERROR');
  expect(http_status_to_error_code(200)).toBe('UNKNOWN');
});

it('test_infer_error_code_from_message', () => {
  expect(infer_error_code_from_message('API key is missing')).toBe('API_KEY_MISSING');
  expect(infer_error_code_from_message('Invalid api_key provided')).toBe('API_KEY_INVALID');
  expect(infer_error_code_from_message('Request timeout occurred')).toBe('NETWORK_TIMEOUT');
  expect(infer_error_code_from_message('Network connection failed')).toBe('NETWORK_UNREACHABLE');
  expect(infer_error_code_from_message('Too many requests, rate limit exceeded')).toBe('RATE_LIMIT');
  expect(infer_error_code_from_message('Quota exceeded for this month')).toBe('QUOTA_EXCEEDED');
  expect(infer_error_code_from_message('Failed to parse JSON response')).toBe('PARSE_ERROR');
  expect(infer_error_code_from_message('Tool not found')).toBe('TOOL_NOT_FOUND');
  expect(infer_error_code_from_message('Tool is disabled')).toBe('TOOL_DISABLED');
  expect(infer_error_code_from_message('Something went wrong')).toBe('UNKNOWN');
});

it('test_error_details_serialization', () => {
  const error = ErrorDetails.with_context(
    ErrorDetails.with_trace_id(ErrorDetailsBuilder.api_key_missing('TestService'), 'test_trace_123'),
    'service_type', 'search',
  );
  const json = JSON.stringify(error);
  expect(json).toContain('API_KEY_MISSING');
  expect(json).toContain('TestService');
  expect(json).toContain('test_trace_123');
  expect(json).toContain('service_type');
  const deserialized = JSON.parse(json) as typeof error;
  expect(deserialized.code).toBe('API_KEY_MISSING');
  expect(deserialized.trace_id).toBe('test_trace_123');
});

it('test_action_suggestion_serialization', () => {
  const suggestion: ActionSuggestion = {
    action_type: 'settings', label: '检查设置', url: 'https://example.com/settings', data: { section: 'api_keys' },
  };
  const json = JSON.stringify(suggestion);
  expect(json).toContain('settings');
  expect(json).toContain('检查设置');
  expect(json).toContain('https://example.com/settings');
  expect(json).toContain('api_keys');
  const deserialized = JSON.parse(json) as ActionSuggestion;
  expect(deserialized.action_type).toBe('settings');
  expect(deserialized.label).toBe('检查设置');
  expect(deserialized.url).toBe('https://example.com/settings');
});
