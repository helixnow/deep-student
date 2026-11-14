import type { JsonObject, JsonValue, PluginLogger, ProviderAdapter, ProviderRequest, StreamEvent } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { extractStreamDataPayload } from '../../../../platform/util/portable.ts';
import { array, asciiLowercase, object, string, field, i64At, parseJson } from '../json.ts';
import { cloneProviderToolCall } from '../tool-call-values.ts';
import { removeKey } from '../json_map.ts';

export function normalizeOllamaRootBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(rustTrim(baseUrl)); } catch (error) {
    if (error instanceof TypeError) return baseUrl;
    throw error;
  }
  if (url.port === '11434' && (url.pathname === '' || url.pathname === '/') && !url.href.includes('?')) {
    url.pathname = '/v1';
    return url.href.replace(/\/+$/, '');
  }
  return baseUrl;
}
export function openaiEndpointUrl(baseUrl: string, endpoint: string): string {
  const base = normalizeOllamaRootBaseUrl(baseUrl);
  const tailStart = base.search(/[?#]/);
  const path = (tailStart < 0 ? base : base.slice(0, tailStart)).replace(/\/+$/, '');
  const tail = tailStart < 0 ? '' : base.slice(tailStart);
  const suffix = `/${endpoint.replace(/^\/+|\/+$/g, '')}`;
  const lower = asciiLowercase(path);
  if (lower.endsWith(asciiLowercase(suffix))) return path + tail;
  const existing = ['/chat/completions', '/responses'].find(candidate => lower.endsWith(candidate));
  return (existing ? path.slice(0, -existing.length) : path) + suffix + tail;
}
export function isOfficialEndpoint(baseUrl: string, host: string): boolean {
  try { return asciiLowercase(new URL(rustTrim(baseUrl)).hostname) === host; } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
export function isMeaningfulOpenaiToolDelta(value: JsonValue): boolean {
  const obj = object(value);
  if (!obj) return false;
  const fn = object(obj.function);
  const args = fn?.arguments;
  return i64At(obj, 'index') !== undefined && (
    rustTrim(string(obj.id) ?? '') !== '' || rustTrim(string(fn?.name) ?? '') !== ''
    || (args !== undefined && args !== null && (typeof args !== 'string' || args !== ''))
  );
}
function declaresBlankName(tool: JsonValue): boolean {
  const flat = string(field(tool, 'name'));
  const nested = string(field(field(tool, 'function'), 'name'));
  return (flat !== undefined && rustTrim(flat) === '') || (nested !== undefined && rustTrim(nested) === '');
}
export function sanitizeOpenaiRequestBody(body: JsonValue): JsonValue {
  const sanitized = structuredClone(body);
  const obj = object(sanitized);
  if (!obj) return sanitized;
  const seenNames = new Set<string>();
  const tools = array(obj.tools);
  let validNames = new Set<string>();
  if (tools) {
    const cleaned: JsonValue[] = [];
    for (const tool of tools) {
      if (declaresBlankName(tool)) continue;
      if ((string(field(tool, 'type')) ?? 'function') !== 'function') { cleaned.push(tool); continue; }
      const fn = object(field(tool, 'function'));
      const name = rustTrim(string(fn?.name) ?? '');
      if (!fn || !name || seenNames.has(name)) continue;
      seenNames.add(name);
      fn.name = name;
      const parameters = object(fn.parameters);
      fn.parameters = parameters ?? { type: 'object', properties: {} };
      if (parameters) {
        if (!Object.hasOwn(parameters, 'type')) parameters.type = 'object';
        if (!Object.hasOwn(parameters, 'properties')) parameters.properties = {};
      }
      cleaned.push(tool);
    }
    // Rust derives the valid-name set from every surviving tool declaration.
    validNames = new Set(cleaned
      .map(tool => string(field(field(tool, 'function'), 'name')))
      .filter((name): name is string => name !== undefined));
    if (!cleaned.length) { removeKey(obj, 'tools'); removeKey(obj, 'tool_choice'); }
    else obj.tools = cleaned;
  }
  if (Object.hasOwn(obj, 'tool_choice')) {
    const choice = obj.tool_choice!;
    if (typeof choice === 'string' && ['auto', 'none', 'required'].includes(choice)) obj.tool_choice = choice;
    else {
      const type = string(field(choice, 'type')) ?? '';
      const name = rustTrim(string(field(choice, 'name')) ?? string(field(field(choice, 'function'), 'name')) ?? '');
      if (!['function', 'tool'].includes(type) || !validNames.has(name)) removeKey(obj, 'tool_choice');
      else obj.tool_choice = { type: 'function', function: { name } };
    }
  }
  return sanitized;
}

function pushContentPartEvents(events: StreamEvent[], parts: JsonValue[]): void {
  for (const part of parts) {
    if (typeof part === 'string') { if (part) events.push({ type: 'ContentChunk', value: part }); continue; }
    const type = string(field(part, 'type')) ?? 'text';
    if (['thinking', 'think', 'reasoning'].includes(type)) {
      const obj = object(part);
      const thinking = obj && Object.hasOwn(obj, 'thinking') ? obj.thinking : field(part, 'text');
      if (typeof thinking === 'string' && thinking !== '') events.push({ type: 'ReasoningChunk', value: thinking });
      else if (Array.isArray(thinking)) for (const chunk of thinking) {
        const text = string(chunk) ?? string(field(chunk, 'text'));
        if (text) events.push({ type: 'ReasoningChunk', value: text });
      }
    } else {
      const text = string(field(part, 'text'));
      if (text) events.push({ type: 'ContentChunk', value: text });
    }
  }
}

/** providers/mod.rs:82–718. A finish_reason is not a transport terminator. */
export class OpenAIAdapter implements ProviderAdapter {
  _logger?: PluginLogger;
  _sawFinishReason = false;
  _deepseekOfficial = false;
  _pendingDeepseekFailure: JsonValue | undefined;

  constructor(logger?: PluginLogger) { this._logger = logger; }
  requiresExplicitStreamCompletion(): boolean { return true; }
  buildRequest(baseUrl: string, apiKey: string, _model: string, body: JsonValue): ProviderRequest {
    const url = openaiEndpointUrl(baseUrl, 'chat/completions');
    const key = rustTrim(apiKey);
    const sanitized = sanitizeOpenaiRequestBody(body);
    this._sawFinishReason = false;
    this._deepseekOfficial = isOfficialEndpoint(baseUrl, 'api.deepseek.com');
    this._pendingDeepseekFailure = undefined;
    const obj = object(sanitized);
    if (obj?.stream === true && isOfficialEndpoint(baseUrl, 'api.openai.com') && !Object.hasOwn(obj, 'stream_options')) obj.stream_options = { include_usage: true };
    const headers: [string, string][] = [['Content-Type', 'application/json']];
    if (key) headers.unshift(['Authorization', `Bearer ${key}`]);
    return { url, headers, body: sanitized };
  }
  parseStream(line: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const data = extractStreamDataPayload(line);
    if (data === null) return events;
    if (rustTrim(data) === '[DONE]') {
      this._sawFinishReason = false;
      const failure = this._pendingDeepseekFailure;
      this._pendingDeepseekFailure = undefined;
      return failure !== undefined ? [{ type: 'SafetyBlocked', value: failure }] : [{ type: 'Done' }];
    }
    const json = parseJson(data);
    if (json === undefined) return events;
    const error = field(json, 'error');
    if (error !== undefined && error !== null) {
      this._logger?.error('[OpenAIAdapter] Stream error event: %s', JSON.stringify(error));
      this._sawFinishReason = false;
      return [{ type: 'SafetyBlocked', value: { type: 'provider_error', reason: 'stream_error', details: structuredClone(error) } }, { type: 'Done' }];
    }
    const choices = array(field(json, 'choices'));
    if (choices) for (const choice of choices) {
      const delta = object(field(choice, 'delta'));
      if (delta) {
        if (typeof delta.content === 'string') events.push({ type: 'ContentChunk', value: delta.content });
        else if (Array.isArray(delta.content)) pushContentPartEvents(events, delta.content);
        let reasoningSeen = false;
        if (typeof delta.reasoning_content === 'string') {
          events.push({ type: 'ReasoningChunk', value: delta.reasoning_content }); reasoningSeen = true;
        }
        if (!reasoningSeen && typeof delta.reasoning === 'string' && delta.reasoning !== '') {
          events.push({ type: 'ReasoningChunk', value: delta.reasoning }); reasoningSeen = true;
        }
        if (!reasoningSeen) for (const detail of array(delta.reasoning_details) ?? []) {
          const text = string(field(detail, 'text')) ?? string(field(detail, 'summary'));
          if (text) events.push({ type: 'ReasoningChunk', value: text });
        }
        for (const tc of array(delta.tool_calls) ?? []) if (isMeaningfulOpenaiToolDelta(tc)) events.push({ type: 'ToolCall', value: cloneProviderToolCall(tc) });
      }
      const reason = string(field(choice, 'finish_reason'));
      if (this._deepseekOfficial && reason !== undefined && rustTrim(reason) !== '' && !['stop', 'tool_calls', 'function_call'].includes(reason)) {
        this._pendingDeepseekFailure ??= { type: 'provider_error', reason, details: { message: reason === 'length' ? 'DeepSeek output token budget exhausted (length)' : `DeepSeek stopped: ${reason}` } };
      }
    }
    const usage = object(field(json, 'usage'));
    if (usage) events.push({ type: 'Usage', value: structuredClone(usage) });
    if (choices && choices.length > 0 && choices.every(choice => rustTrim(string(field(choice, 'finish_reason')) ?? '') !== '')) this._sawFinishReason = true;
    return events;
  }
  finishStream(): StreamEvent[] {
    if (this._pendingDeepseekFailure !== undefined) {
      const failure = this._pendingDeepseekFailure;
      this._pendingDeepseekFailure = undefined; this._sawFinishReason = false;
      return [{ type: 'SafetyBlocked', value: failure }];
    }
    const finished = this._sawFinishReason;
    this._sawFinishReason = false;
    return finished ? [{ type: 'Done' }] : [];
  }
}

export function normalizeOpenaiNonstreamResponse(response: JsonValue): JsonValue {
  const normalized = structuredClone(response);
  const message = object(field(array(field(normalized, 'choices'))?.[0], 'message'));
  const parts = array(message?.content);
  if (!message || !parts) return normalized;
  const text: string[] = [], reasoning: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') { if (part) text.push(part); continue; }
    const target = ['thinking', 'think', 'reasoning'].includes(string(field(part, 'type')) ?? 'text') ? reasoning : text;
    const obj = object(part);
    const content = obj && Object.hasOwn(obj, 'thinking') ? obj.thinking : field(part, 'text');
    if (typeof content === 'string' && content !== '') target.push(content);
    else if (Array.isArray(content)) for (const chunk of content) {
      const value = string(chunk) ?? string(field(chunk, 'text'));
      if (value) target.push(value);
    }
  }
  message.content = text.join('');
  if (reasoning.length) message.reasoning_content = reasoning.join('');
  return normalized;
}
