/** src-tauri/tests/error_details_tests.rs; factories are owned/published by F4. */
import { expect, it } from 'vitest';
import { ErrorDetails, ErrorDetailsBuilder as B, http_status_to_error_code, infer_error_code_from_message, type ActionSuggestion } from '../../platform/errors/api.ts';
it('test_error_details_creation', () => {
  const e = ErrorDetails.new('API_KEY_MISSING', 'API key not found', '请配置API密钥');
  expect(e).toEqual({ code: 'API_KEY_MISSING', message: 'API key not found', user_message: '请配置API密钥', suggestions: [], trace_id: null, context: null });
});
it('test_error_details_builder_methods', () => {
  const e = ErrorDetails.with_context(ErrorDetails.with_trace_id(ErrorDetails.with_suggestion(ErrorDetails.new('NETWORK_TIMEOUT', 'Request timeout', '网络请求超时'), { action_type: 'retry', label: '重试', url: null, data: null }), 'trace_123'), 'timeout_ms', 5000);
  expect(e.suggestions).toHaveLength(1); expect(e.suggestions[0]!.action_type).toBe('retry'); expect(e.trace_id).toBe('trace_123'); expect(e.context?.timeout_ms).toBe(5000);
});
it('test_error_details_builder_api_key_missing', () => {
  const e = B.api_key_missing('OpenAI'); expect(e.code).toBe('API_KEY_MISSING'); expect(e.message).toContain('OpenAI'); expect(e.user_message).toContain('OpenAI'); expect(e.suggestions.length).toBeGreaterThan(0); expect(e.suggestions[0]).toMatchObject({ action_type: 'settings', label: 'Open Settings' });
});
it('test_error_details_builder_api_key_invalid', () => {
  const e = B.api_key_invalid('SerpAPI'); expect(e.code).toBe('API_KEY_INVALID'); expect(e.message).toContain('SerpAPI'); expect(e.suggestions).toHaveLength(2); expect(e.suggestions.map(s => s.action_type)).toEqual(expect.arrayContaining(['settings', 'retry']));
});
it('test_error_details_builder_network_error', () => {
  const e = B.network_error('Connection refused'); expect(e.code).toBe('NETWORK_UNREACHABLE'); expect(e.message).toContain('Connection refused'); expect(e.suggestions).toHaveLength(2); expect(e.suggestions.map(s => s.action_type)).toEqual(expect.arrayContaining(['check_network', 'retry']));
});
it('test_error_details_builder_rate_limit', () => {
  const e = B.rate_limit_error('Tavily', 30); expect(e.code).toBe('RATE_LIMIT'); expect(e.message).toContain('Tavily'); expect(e.user_message).toContain('30秒'); expect(e.suggestions.length).toBeGreaterThan(0); expect(e.suggestions[0]!.action_type).toBe('retry'); expect(e.context?.retry_after_seconds).toBe(30);
});
it('test_error_details_builder_service_unavailable', () => {
  const e = B.service_unavailable('Bing'); expect(e.code).toBe('SERVICE_UNAVAILABLE'); expect(e.message).toContain('Bing'); expect(e.suggestions).toHaveLength(2); expect(e.suggestions.map(s => s.action_type)).toEqual(expect.arrayContaining(['retry', 'contact_support']));
});
it('test_error_details_builder_tool_not_found', () => {
  const e = B.tool_not_found('unknown_tool'); expect(e.code).toBe('TOOL_NOT_FOUND'); expect(e.message).toContain('unknown_tool'); expect(e.suggestions.length).toBeGreaterThan(0); expect(e.suggestions[0]!.action_type).toBe('settings'); expect(e.suggestions[0]!.url).toContain('tools');
});
it('test_error_details_builder_tool_timeout', () => {
  const e = B.tool_timeout('web_search', 10000); expect(e.code).toBe('TOOL_TIMEOUT'); expect(e.message).toContain('web_search'); expect(e.user_message).toContain('10000毫秒'); expect(e.suggestions.length).toBeGreaterThan(0); expect(e.suggestions[0]!.action_type).toBe('retry'); expect(e.context?.timeout_ms).toBe(10000);
});
it('test_error_details_builder_parse_error', () => {
  const e = B.parse_error('JSON', 'Unexpected token at line 5'); expect(e.code).toBe('PARSE_ERROR'); expect(e.message).toContain('JSON'); expect(e.message).toContain('Unexpected token'); expect(e.suggestions).toHaveLength(2); expect(e.suggestions.map(s => s.action_type)).toEqual(expect.arrayContaining(['retry', 'contact_support']));
});
it('test_http_status_to_error_code', () => {
  expect([400, 401, 403, 404, 429, 450, 500, 502, 200].map(http_status_to_error_code)).toEqual(['HTTP_BAD_REQUEST', 'HTTP_UNAUTHORIZED', 'HTTP_FORBIDDEN', 'HTTP_NOT_FOUND', 'HTTP_TOO_MANY_REQUESTS', 'HTTP_CLIENT_ERROR', 'HTTP_SERVER_ERROR', 'HTTP_SERVER_ERROR', 'UNKNOWN']);
});
it('test_infer_error_code_from_message', () => {
  expect(['API key is missing', 'Invalid api_key provided', 'Request timeout occurred', 'Network connection failed', 'Too many requests, rate limit exceeded', 'Quota exceeded for this month', 'Failed to parse JSON response', 'Tool not found', 'Tool is disabled', 'Something went wrong'].map(infer_error_code_from_message)).toEqual(['API_KEY_MISSING', 'API_KEY_INVALID', 'NETWORK_TIMEOUT', 'NETWORK_UNREACHABLE', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'PARSE_ERROR', 'TOOL_NOT_FOUND', 'TOOL_DISABLED', 'UNKNOWN']);
});
it('test_error_details_serialization', () => {
  const e = ErrorDetails.with_context(ErrorDetails.with_trace_id(B.api_key_missing('TestService'), 'test_trace_123'), 'service_type', 'search');
  const json = JSON.stringify(e);
  for (const text of ['API_KEY_MISSING', 'TestService', 'test_trace_123', 'service_type']) expect(json).toContain(text);
  expect(JSON.parse(json)).toMatchObject({ code: 'API_KEY_MISSING', trace_id: 'test_trace_123' });
});
it('test_action_suggestion_serialization', () => {
  const suggestion: ActionSuggestion = { action_type: 'settings', label: '检查设置', url: 'https://example.com/settings', data: { section: 'api_keys' } };
  const json = JSON.stringify(suggestion);
  for (const text of ['settings', '检查设置', 'https://example.com/settings', 'api_keys']) expect(json).toContain(text);
  expect(JSON.parse(json)).toMatchObject({ action_type: 'settings', label: '检查设置', url: 'https://example.com/settings' });
});
