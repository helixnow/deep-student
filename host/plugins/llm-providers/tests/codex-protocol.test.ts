import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { CodexAuthError } from '../src/openai-codex/error.ts';
import { CodexRequestAuth, StoredCodexSession } from '../src/openai-codex/types.ts';
import { CodexEndpointConfig, buildCodexRequestHeaders, prepareCodexResponsesBody, codexSseToResponsesJson, CODEX_ORIGINATOR, CODEX_RESPONSES_BETA } from '../src/openai-codex/protocol.ts';
import type { JsonObject, JsonValue } from '../api.ts';

const session = (accountId = 'account-123456789') => new StoredCodexSession({ schemaVersion: 1, accessToken: 'access-secret', refreshToken: 'refresh-secret', idToken: 'id-secret', expiresAtUnixMs: 42n, accountId, email: 'user@example.com', planType: 'plus', isFedramp: false, lastRefreshAt: null });
it('permanent_refresh_errors_require_reauthentication', () => {
  const error = new CodexAuthError('OAuthRejected', { stage: 'refresh', code: 'invalid_grant', permanent: true, reauthRequired: true });
  expect(error.class()).toBe('reauthentication_required');
  expect(error.toDto().message).not.toContain('token');
});
it('network_errors_are_transient', () => {
  expect(new CodexAuthError('Network', { stage: 'refresh' }).class()).toBe('transient');
});
it('request_auth_debug_is_redacted', () => {
  const debug = inspect(new CodexRequestAuth(session(), 7));
  expect(debug).not.toContain('access-secret');
  expect(debug).not.toContain('account-123456789');
  expect(debug).toContain('[REDACTED]');
});
it('stored_session_debug_is_redacted', () => {
  const debug = inspect(session());
  expect(debug).not.toContain('access-secret');
  expect(debug).not.toContain('refresh-secret');
  expect(debug).not.toContain('id-secret');
});
it('stored_session_requires_account_id', () => {
  expect(session('  ').isValid()).toBe(false);
});
it('endpoint_config_can_be_overridden_for_http_tests', () => {
  const config = CodexEndpointConfig.forTest('http://127.0.0.1:3456/');
  expect(config.tokenUrl).toBe('http://127.0.0.1:3456/oauth/token');
  expect(config.responsesUrl).toBe('http://127.0.0.1:3456/codex/responses');
  expect(config.usageUrl).toBe('http://127.0.0.1:3456/wham/usage');
});
it('request_headers_contain_codex_auth_without_debuggable_dto_tokens', () => {
  const stored = session('acct_123'); stored.accessToken = 'secret-access'; stored.isFedramp = true;
  const headers = buildCodexRequestHeaders(new CodexRequestAuth(stored, 1), 'session-1', '0.11.0');
  expect(headers['chatgpt-account-id']).toBe('acct_123');
  expect(headers.originator).toBe(CODEX_ORIGINATOR);
  expect(headers['openai-beta']).toBe(CODEX_RESPONSES_BETA);
  expect(headers['session-id']).toBe('session-1');
  expect(headers.session_id).toBe('session-1');
  expect(headers.conversation_id).toBe('session-1');
  expect(headers.authorization).toBe('Bearer secret-access');
  expect(headers['x-openai-fedramp']).toBe('true');
});
it('request_headers_reject_missing_account_id', () => {
  expect(() => buildCodexRequestHeaders(new CodexRequestAuth(session(' '), 1), 'session-1', '0.11.0')).toThrow(expect.objectContaining({ kind: 'MissingAccountId' }));
});
it('responses_body_is_sanitized_for_codex', () => {
  const prepared = prepareCodexResponsesBody({ model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], store: true, stream: false, include: ['file_search_call.results'], max_output_tokens: 100, max_completion_tokens: 101, max_tokens: 102, max_total_tokens: 103, temperature: 0.2, top_p: 0.8, reasoning: { effort: 'xhigh', summary: 'auto' } });
  expect(prepared.store).toBe(false); expect(prepared.stream).toBe(true);
  for (const key of ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'max_total_tokens', 'temperature', 'top_p']) expect(prepared).not.toHaveProperty(key);
  expect(prepared.reasoning).toHaveProperty('effort', 'xhigh');
  expect(prepared.include).toContain('reasoning.encrypted_content');
});
it('responses_body_key_order_follows_serde_json_preserve_order_swap_remove', () => {
  // protocol.rs:151-174: store/stream insert in place; remove("include") moves the last key into its slot and the
  // re-insert appends; each later remove moves the then-last key into the removed slot.
  const prepared = prepareCodexResponsesBody({ model: 'gpt-5.4', input: [], store: true, stream: false, include: ['file_search_call.results'],
    max_output_tokens: 100, max_completion_tokens: 101, max_tokens: 102, max_total_tokens: 103, temperature: 0.2, top_p: 0.8,
    reasoning: { effort: 'xhigh' } });
  expect(Object.keys(prepared)).toEqual(['model', 'input', 'store', 'stream', 'reasoning', 'include']);
  expect(Object.keys(prepareCodexResponsesBody({ model: 'gpt-5.4', include: [], input: [], text: {} })))
    .toEqual(['model', 'stream', 'input', 'text', 'store', 'include']);
});
it('sse_bridge_aggregates_text_reasoning_tools_and_usage', () => {
  const events = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4' } },
    { type: 'response.reasoning_summary_text.delta', delta: 'think' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"q":"rust"}' },
    { type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.done', text: 'Hello' },
    { type: 'response.usage', usage: { input_tokens: 3, output_tokens: 2 } },
  ];
  const response = codexSseToResponsesJson(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  expect(response.id).toBe('resp_1'); expect(response.model).toBe('gpt-5.4'); expect(response.status).toBe('completed');
  expect(response.usage).toHaveProperty('input_tokens', 3);
  const output = response.output as JsonObject[];
  expect(output).toContainEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] });
  expect(output.some(item => item.type === 'function_call' && item.arguments === '{"q":"rust"}')).toBe(true);
  expect(output.some(item => item.type === 'message' && ((item.content as JsonObject[])[0]?.text) === 'Hello')).toBe(true);
});
it('sse_bridge_prefers_terminal_response_and_canonicalizes_errors', () => {
  const response = codexSseToResponsesJson('event: response.done\ndata: {"response":{"id":"resp_done","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}],"usage":{"total_tokens":9}}}\n\n');
  expect(response.id).toBe('resp_done');
  expect(((response.output as JsonObject[])[0]!.content as JsonObject[])[0]!.text).toBe('final');
  expect(response.usage).toHaveProperty('total_tokens', 9);
  const failed = codexSseToResponsesJson('data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"sensitive detail"}}\n\n');
  expect(failed.status).toBe('failed'); expect(failed.error).toHaveProperty('code', 'rate_limit_exceeded');
  expect(JSON.stringify(failed)).not.toContain('sensitive detail');
});

it('Codex SSE keeps terminal status and rejects a stream without JSON', () => {
  expect(() => codexSseToResponsesJson('data: [DONE]\n\n')).toThrow(expect.objectContaining({ kind: 'MalformedResponse' }));
  for (const status of ['failed', 'incomplete']) {
    const response = codexSseToResponsesJson(`data: ${JSON.stringify({ type: `response.${status}`, response: { status, output: [] } })}\n\n`);
    expect(response.status).toBe(status);
  }
});
