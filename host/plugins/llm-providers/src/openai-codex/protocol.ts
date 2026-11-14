import { validateHeaderValue } from './header-value.ts';
import type { JsonObject, JsonValue } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { array, field, object, parseJson, string, u64At } from '../json.ts';
import { removeKey } from '../json_map.ts';
import { CodexAuthError } from './error.ts';
import type { CodexRequestAuth } from './types.ts';

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
export const CODEX_CREDENTIAL_KEY = 'internal.oauth.openai_codex.session';
export const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access';
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_RESPONSES_BETA = 'responses=experimental';
export class CodexEndpointConfig {
  clientId = OPENAI_OAUTH_CLIENT_ID;
  authorizeUrl = `${OPENAI_OAUTH_ISSUER}/oauth/authorize`;
  tokenUrl = `${OPENAI_OAUTH_ISSUER}/oauth/token`;
  revokeUrl = `${OPENAI_OAUTH_ISSUER}/oauth/revoke`;
  deviceUserCodeUrl = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
  deviceTokenUrl = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
  deviceVerificationUrl = CODEX_DEVICE_VERIFICATION_URL;
  deviceRedirectUrl = `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`;
  responsesUrl = CODEX_RESPONSES_ENDPOINT;
  usageUrl = CODEX_USAGE_ENDPOINT;
  static forTest(base: string): CodexEndpointConfig {
    const config = new CodexEndpointConfig(); config.clientId = 'test-client';
    for (const [key, path] of Object.entries({ authorizeUrl: 'oauth/authorize', tokenUrl: 'oauth/token', revokeUrl: 'oauth/revoke', deviceUserCodeUrl: 'device/usercode', deviceTokenUrl: 'device/token', deviceVerificationUrl: 'device', deviceRedirectUrl: 'device/callback', responsesUrl: 'codex/responses', usageUrl: 'wham/usage' })) {
      config[key as Exclude<keyof CodexEndpointConfig, 'clientId'>] = new URL(path, base).href;
    }
    return config;
  }
}
export function codexResponsesEndpoint(): string { return CODEX_RESPONSES_ENDPOINT; }
export function buildCodexRequestHeaders(auth: CodexRequestAuth, sessionId: string, version: string): Record<string, string> {
  const bearer = `Bearer ${auth.accessToken()}`;
  const userAgent = `deep-student/${version}`;
  try {
    validateHeaderValue('authorization', bearer); validateHeaderValue('session-id', sessionId); validateHeaderValue('user-agent', userAgent);
  } catch (error) { throw new CodexAuthError('InvalidHeader', { reason: error instanceof Error ? error.name : '' }); }
  const accountId = rustTrim(auth.accountId());
  if (accountId === '') throw new CodexAuthError('MissingAccountId');
  try { validateHeaderValue('chatgpt-account-id', accountId); }
  catch (error) { throw new CodexAuthError('InvalidHeader', { reason: error instanceof Error ? error.name : '' }); }
  return {
    authorization: bearer, 'chatgpt-account-id': accountId, originator: CODEX_ORIGINATOR, 'openai-beta': CODEX_RESPONSES_BETA,
    'session-id': sessionId, session_id: sessionId, conversation_id: sessionId,
    ...(auth.isFedramp() ? { 'x-openai-fedramp': 'true' } : {}),
    'user-agent': userAgent, 'content-type': 'application/json', accept: 'text/event-stream, application/json',
  };
}
export function prepareCodexResponsesBody(body: JsonValue): JsonObject {
  const payload = object(structuredClone(body));
  if (!payload) throw new CodexAuthError('InvalidRequestBody', { reason: 'expected a JSON object' });
  if (!rustTrim(string(payload.model) ?? '')) throw new CodexAuthError('InvalidRequestBody', { reason: 'model is required' });
  if (!Object.hasOwn(payload, 'input')) throw new CodexAuthError('InvalidRequestBody', { reason: 'Responses input is required' });
  payload.store = false; payload.stream = true;
  const include = array(removeKey(payload, 'include') as JsonValue | undefined) ?? [];
  if (!include.includes('reasoning.encrypted_content')) include.push('reasoning.encrypted_content');
  payload.include = include;
  for (const key of ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'max_total_tokens', 'temperature', 'top_p']) removeKey(payload, key);
  return payload;
}

/** openai_codex/protocol.rs:179–507. BTreeMap output ordering is numeric. */
class CodexSseAccumulator {
  _finalResponse?: JsonObject;
  _outputItems = new Map<number, JsonObject>();
  _outputText = '';
  _reasoningText = '';
  _usage?: JsonObject;
  _responseId?: string;
  _model?: string;
  _error?: JsonValue;
  _sawJsonEvent = false;
  absorb(event: JsonValue): void {
    this._sawJsonEvent = true;
    const type = string(field(event, 'type')) ?? '';
    const response = object(field(event, 'response'));
    if (response) {
      this._responseId ??= string(response.id); this._model ??= string(response.model);
      if (object(response.usage)) this._usage = structuredClone(object(response.usage)!);
      if (['response.completed', 'response.done', 'response.failed', 'response.incomplete'].includes(type)) this._finalResponse = structuredClone(response);
    }
    if (object(field(event, 'usage'))) this._usage = structuredClone(object(field(event, 'usage'))!);
    const delta = string(field(event, 'delta')) ?? '';
    const text = string(field(event, 'text')) ?? '';
    switch (type) {
      case 'response.output_text.delta': this._outputText += delta; break;
      case 'response.output_text.done': if (text) this._outputText = text; break;
      case 'response.reasoning_text.delta': case 'response.reasoning_summary_text.delta': this._reasoningText += delta; break;
      case 'response.reasoning_text.done': case 'response.reasoning_summary_text.done': if (text) this._reasoningText = text; break;
      case 'response.output_item.added': case 'response.output_item.done': {
        const item = object(field(event, 'item'));
        if (item) this._outputItems.set(this.index(event), structuredClone(item));
        break;
      }
      case 'response.content_part.added': case 'response.content_part.done': {
        const part = field(event, 'part');
        if (['output_text', 'text'].includes(string(field(part, 'type')) ?? '')) {
          const value = string(field(part, 'text')); if (value) this._outputText = value;
        }
        break;
      }
      case 'response.function_call_arguments.delta': this.updateToolArguments(event, 'arguments', 'delta', 'function_call'); break;
      case 'response.function_call_arguments.done': this.updateToolArguments(event, 'arguments', 'arguments', 'function_call'); break;
      case 'response.custom_tool_call_input.delta': this.updateToolArguments(event, 'input', 'delta', 'custom_tool_call'); break;
      case 'response.custom_tool_call_input.done': this.updateToolArguments(event, 'input', 'input', 'custom_tool_call'); break;
      case 'error': {
        const obj = object(event);
        const source = obj && Object.hasOwn(obj, 'error') ? obj.error : event;
        // Rust falls back to `type` whenever `code` is absent *or not a string*.
        const raw = string(field(source, 'code')) ?? string(field(source, 'type'));
        const code = (string(raw) ?? 'response_stream_error').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
        this._error = { code: code || 'response_stream_error', type: 'response_stream_error' }; break;
      }
    }
  }
  index(event: JsonValue): number {
    const obj = object(event);
    return u64At(event, obj && Object.hasOwn(obj, 'output_index') ? 'output_index' : 'item_index') ?? this._outputItems.size;
  }
  updateToolArguments(event: JsonValue, itemField: string, eventField: string, itemType: string): void {
    const index = this.index(event), value = string(field(event, eventField)) ?? '';
    let item = this._outputItems.get(index);
    if (!item) {
      item = { type: itemType };
      for (const key of ['id', 'item_id', 'call_id', 'name']) {
        const value = string(field(event, key));
        if (value !== undefined) item[key === 'item_id' ? 'id' : key] = value;
      }
      this._outputItems.set(index, item);
    }
    if (eventField === 'delta') {
      if (!Object.hasOwn(item, itemField)) item[itemField] = '';
      if (typeof item[itemField] === 'string') item[itemField] += value;
    } else if (value !== '') item[itemField] = value;
  }
  finish(): JsonObject {
    if (!this._sawJsonEvent) throw new CodexAuthError('MalformedResponse', { field: 'Codex SSE response' });
    const output = [...this._outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    for (const item of output) {
      if (item.type === 'function_call' && !Object.hasOwn(item, 'arguments')) item.arguments = '{}';
      if (item.type === 'custom_tool_call' && !Object.hasOwn(item, 'input')) item.input = '';
    }
    if (this._reasoningText !== '' && !output.some(item => item.type === 'reasoning')) output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: this._reasoningText }] });
    if (this._outputText !== '' && !output.some(item => array(item.content)?.some(part => ['output_text', 'text'].includes(string(field(part, 'type')) ?? '')))) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this._outputText, annotations: [] }] });
    if (this._finalResponse) {
      if (!array(this._finalResponse.output)?.length && output.length) this._finalResponse.output = output;
      if ((this._finalResponse.usage === undefined || this._finalResponse.usage === null) && this._usage) this._finalResponse.usage = this._usage;
      return this._finalResponse;
    }
    return { id: this._responseId ?? 'resp_codex_bridge', object: 'response', status: this._error !== undefined ? 'failed' : 'completed', output,
      ...(this._model === undefined ? {} : { model: this._model }), ...(this._usage ? { usage: this._usage } : {}), ...(this._error === undefined ? {} : { error: this._error }) };
  }
}
export function codexSseToResponsesJson(body: string): JsonObject {
  const accumulator = new CodexSseAccumulator();
  let eventName: string | undefined;
  let dataLines: string[] = [];
  for (const rawLine of [...body.split('\n'), '']) {
    const line = rawLine.replace(/\r+$/, '');
    if (line === '') {
      if (dataLines.length) {
        const data = dataLines.join('\n');
        if (rustTrim(data) !== '[DONE]') {
          const event = parseJson(data);
          if (event !== undefined) {
            const obj = object(event);
            if (obj && !Object.hasOwn(obj, 'type') && eventName !== undefined) obj.type = eventName;
            accumulator.absorb(event);
          }
        }
      }
      eventName = undefined; dataLines = []; continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventName = rustTrim(line.slice(6));
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\p{White_Space}+/u, ''));
  }
  return accumulator.finish();
}
