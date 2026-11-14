import type { JsonObject, JsonValue, PluginLogger, ProviderAdapter, ProviderRequest, StreamEvent } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { extractStreamDataPayload } from '../../../../platform/util/portable.ts';
import { array, asciiLowercase, field, i64At, object, parseJson, parseU32, string } from '../json.ts';
import { isOfficialEndpoint, openaiEndpointUrl, sanitizeOpenaiRequestBody } from './openai-chat.ts';

interface PendingFunctionCall { callId: string; name: string; outputIndex: number; arguments: string }

function isReasoningItem(item: JsonValue): boolean { return field(item, 'type') === 'reasoning'; }
function outputTextItem(role: string, text: string): JsonValue {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text };
}

/** providers/mod.rs:914 `push_message_parts`. */
function pushMessageParts(parts: JsonValue[], role: string, content: JsonValue): void {
  if (typeof content === 'string') {
    if (rustTrim(content) !== '') parts.push(outputTextItem(role, content));
    return;
  }
  const items = array(content);
  if (!items) return;
  for (const part of items) {
    const type = string(field(part, 'type')) ?? '';
    if (type === 'input_text' && role !== 'assistant') {
      const text = string(field(part, 'text'));
      if (text !== undefined && text !== '') parts.push({ type: 'input_text', text });
    } else if (type === 'text' || type === 'output_text') {
      const text = string(field(part, 'text'));
      if (text !== undefined && text !== '') parts.push(outputTextItem(role, text));
    } else if ((type === 'image_url' || type === 'input_image') && role !== 'assistant') {
      const imageUrl = type === 'input_image' ? string(field(part, 'image_url')) : string(field(field(part, 'image_url'), 'url'));
      if (imageUrl !== undefined) {
        const detail = field(part, 'detail');
        parts.push(detail !== undefined && detail !== null ? { type: 'input_image', image_url: imageUrl, detail } : { type: 'input_image', image_url: imageUrl });
      }
    } else if (type === 'input_file' && role === 'user') {
      const fileId = string(field(part, 'file_id'));
      if (fileId) parts.push({ type: 'input_file', file_id: fileId });
    } else if (type === 'refusal' && role === 'assistant') {
      const refusal = string(field(part, 'refusal'));
      if (refusal !== undefined && refusal !== '') parts.push({ type: 'refusal', refusal });
    } else {
      const text = string(field(part, 'text'));
      if (text !== undefined && text !== '') parts.push(outputTextItem(role, text));
    }
  }
}

/** providers/mod.rs:995 `assistant_tool_call_items`. */
function assistantToolCallItems(message: JsonValue): JsonValue[] {
  const items: JsonValue[] = [];
  for (const toolCall of array(field(message, 'tool_calls')) ?? []) {
    const id = string(field(toolCall, 'id')) ?? 'call_unknown';
    const fn = object(field(toolCall, 'function'));
    const name = string(fn?.name) ?? 'unknown_function';
    const args = string(fn?.arguments) ?? '{}';
    items.push({ type: 'function_call', call_id: id, name, arguments: args });
  }
  return items;
}

/** providers/mod.rs:1024 `tool_result_item`. */
function toolResultItem(message: JsonValue): JsonValue | undefined {
  const callId = string(field(message, 'tool_call_id'));
  if (callId === undefined) return undefined;
  const content = field(message, 'content');
  let output = '';
  if (typeof content === 'string') output = content;
  else if (Array.isArray(content)) output = content.map(part => string(field(part, 'text'))).filter((text): text is string => text !== undefined).join('\n');
  return { type: 'function_call_output', call_id: callId, output };
}

/** providers/mod.rs:1043 `convert_tool_call_to_response_tool_choice`. */
function convertToolChoice(value: JsonValue): JsonValue | undefined {
  if (typeof value === 'string') return ['auto', 'none', 'required'].includes(value) ? value : undefined;
  const obj = object(value);
  if (!obj) return undefined;
  const type = string(obj.type) ?? '';
  if (type === 'function' || type === 'tool') {
    const name = string(obj.name) ?? string(field(obj.function, 'name'));
    return name === undefined ? undefined : { type: 'function', name };
  }
  return undefined;
}

/** providers/mod.rs:1074 `convert_tool_definition_to_responses`. */
function convertToolDefinition(tool: JsonValue): JsonValue {
  const type = string(field(tool, 'type')) ?? 'function';
  if (type !== 'function') return structuredClone(tool);
  const fn = object(field(tool, 'function'));
  if (!fn) return structuredClone(tool);
  const flat: JsonObject = { type: 'function' };
  for (const key of ['name', 'description', 'parameters']) if (fn[key] !== undefined) flat[key] = structuredClone(fn[key]);
  flat.strict = fn.strict === undefined ? false : structuredClone(fn.strict);
  return flat;
}

/** providers/mod.rs:1108 `convert_response_format_to_text_format`. */
function convertResponseFormat(responseFormat: JsonValue): JsonValue {
  if (string(field(responseFormat, 'type')) === 'json_schema') {
    const nested = object(field(responseFormat, 'json_schema'));
    if (nested) {
      const flat: JsonObject = { type: 'json_schema' };
      for (const [key, value] of Object.entries(nested)) if (key !== 'type') flat[key] = structuredClone(value);
      return flat;
    }
  }
  return structuredClone(responseFormat);
}

/** providers/mod.rs:1131 `convert_response_tool_call`. */
function convertResponseToolCall(item: JsonValue, outputIndex: number): JsonValue | undefined {
  if (string(field(item, 'type')) !== 'function_call') return undefined;
  const name = string(field(item, 'name'));
  if (name === undefined) return undefined;
  const args = string(field(item, 'arguments')) ?? string(field(item, 'input')) ?? '{}';
  const id = string(field(item, 'call_id')) ?? string(field(item, 'id')) ?? `resp_call_${crypto.randomUUID()}`;
  return { index: outputIndex, id, type: 'function', function: { name, arguments: args } };
}

/** providers/mod.rs:1309 `extract_web_search_sources`. */
function extractWebSearchSources(item: JsonValue): JsonValue[] {
  const sources: JsonValue[] = [];
  const page = field(item, 'page');
  const results = array(field(item, 'search_results')) ?? array(field(item, 'web_search_sources'))
    ?? array(field(field(item, 'action'), 'sources')) ?? (page === undefined ? [] : [page]);
  for (const result of results ?? []) {
    const url = string(field(result, 'url')) ?? '';
    if (url === '') continue;
    const title = string(field(result, 'title')) ?? '';
    const snippet = string(field(result, 'text')) ?? string(field(result, 'snippet')) ?? string(field(result, 'description')) ?? '';
    sources.push({ title, url, snippet });
  }
  for (const part of array(field(item, 'content')) ?? []) {
    for (const annotation of array(field(part, 'annotations')) ?? []) {
      if (string(field(annotation, 'type')) !== 'url_citation') continue;
      const url = string(field(annotation, 'url')) ?? '';
      if (url === '') continue;
      if (sources.some(existing => field(existing, 'url') === url)) continue;
      const title = string(field(annotation, 'title')) ?? '';
      const snippet = string(field(annotation, 'title')) ?? string(field(annotation, 'snippet')) ?? '';
      sources.push({ title, url, snippet });
    }
  }
  return sources;
}

/** providers/mod.rs:1393 `full_web_search_item_for_replay`. */
function fullWebSearchItem(item: JsonValue): JsonValue | undefined {
  // Rust matches on `get("type").and_then(as_str)`: a non-string type behaves
  // like a missing one and falls through to the id/status shape check.
  const type = string(field(item, 'type'));
  if (type !== undefined) return type === 'web_search_call' ? structuredClone(item) : undefined;
  const obj = object(item);
  if (obj && typeof obj.id === 'string' && obj.status !== undefined) return { ...structuredClone(obj), type: 'web_search_call' };
  return undefined;
}

/**
 * Rust `Option::or_else` chains stop at a present-but-null value; JS `??`
 * would skip it. These helpers reproduce the presence-based semantics.
 */
function firstPresent(value: JsonValue | undefined, keys: string[]): JsonValue | undefined {
  const obj = object(value);
  if (!obj) return undefined;
  for (const key of keys) if (Object.hasOwn(obj, key)) return obj[key];
  return undefined;
}
function firstPresentOf(...values: (JsonValue | undefined)[]): JsonValue | undefined {
  return values.find(value => value !== undefined);
}

/** providers/mod.rs:1811 `extract_reasoning_text`. */
function extractReasoningText(response: JsonValue): string | undefined {
  const segments: string[] = [];
  for (const item of array(field(response, 'output')) ?? []) {
    const itemType = string(field(item, 'type')) ?? '';
    if (itemType === 'reasoning') {
      for (const entry of array(field(item, 'summary')) ?? []) {
        const text = string(field(entry, 'text'));
        if (text !== undefined && text !== '') segments.push(text);
      }
    }
    const content = array(field(item, 'content'));
    if (content) {
      for (const entry of content) {
        if ((string(field(entry, 'type')) ?? '').includes('reasoning')) {
          const text = string(field(entry, 'text'));
          if (text !== undefined && text !== '') segments.push(text);
        }
      }
    } else if (itemType.includes('reasoning')) {
      const text = string(field(item, 'text'));
      if (text !== undefined && text !== '') segments.push(text);
    }
  }
  return segments.length ? segments.join('\n\n') : undefined;
}

function collectOutputText(content: JsonValue, segments: string[]): void {
  if (typeof content === 'string') { if (content !== '') segments.push(content); return; }
  for (const part of array(content) ?? []) {
    const type = string(field(part, 'type')) ?? '';
    if (['output_text', 'text', ''].includes(type)) {
      const text = string(field(part, 'text'));
      if (text !== undefined && text !== '') segments.push(text);
    }
  }
}

/** providers/mod.rs:1877 `extract_output_text`. */
function extractOutputText(response: JsonValue): string | undefined {
  const segments: string[] = [];
  const output = field(response, 'output');
  if (typeof output === 'string') { if (output !== '') segments.push(output); }
  else if (Array.isArray(output)) {
    for (const item of output) {
      const content = field(item, 'content');
      if (content !== undefined) collectOutputText(content, segments);
      else if (['output_text', 'text'].includes(string(field(item, 'type')) ?? '')) {
        const text = string(field(item, 'text'));
        if (text !== undefined && text !== '') segments.push(text);
      }
    }
  }
  if (!segments.length) { const content = field(response, 'content'); if (content !== undefined) collectOutputText(content, segments); }
  if (!segments.length) { const text = string(field(response, 'output_text')); if (text !== undefined && text !== '') segments.push(text); }
  return segments.length ? segments.join('') : undefined;
}

function deepseekRefusal(response: JsonValue): string | undefined {
  for (const item of array(field(response, 'output')) ?? []) {
    for (const part of array(field(item, 'content')) ?? []) {
      if (field(part, 'type') === 'refusal') {
        return string(field(part, 'refusal')) || 'DeepSeek blocked this response.';
      }
    }
  }
  return undefined;
}

/** Render DeepSeek's Unicode offsets without changing the quoted text or trusting link schemes. */
function deepseekCitedText(response: JsonValue): string | undefined {
  const segments: string[] = [];
  const numbers = new Map<string, number>();
  for (const item of array(field(response, 'output')) ?? []) {
    if (field(item, 'type') !== 'message') continue;
    for (const part of array(field(item, 'content')) ?? []) {
      const text = string(field(part, 'text'));
      if (field(part, 'type') !== 'output_text' || !text) continue;
      const chars = Array.from(text);
      const links = new Map<number, Set<string>>();
      for (const annotation of array(field(part, 'annotations')) ?? []) {
        if (field(annotation, 'type') !== 'url_citation') continue;
        const start = i64At(annotation, 'start_index');
        const end = i64At(annotation, 'end_index');
        if (start === undefined || end === undefined || start < 0 || start >= end || end > chars.length) continue;
        const url = URL.parse(string(field(annotation, 'url')) ?? '');
        if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        if (!numbers.has(url.href)) numbers.set(url.href, numbers.size + 1);
        const at = links.get(end) ?? new Set<string>();
        at.add(url.href);
        links.set(end, at);
      }
      segments.push(chars.map((char, index) => char + [...(links.get(index + 1) ?? [])]
        .map(url => ` [${numbers.get(url)}](<${url.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`).join('')).join(''));
    }
  }
  return segments.length ? segments.join('') : extractOutputText(response);
}

/** providers/mod.rs:772–2303. */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  private deepseekModerated = false;
  private deepseekWebTools = false;
  _logger?: PluginLogger;
  _sawContentDelta = false;
  _emittedContent = false;
  _sawReasoningDelta = false;
  _emittedReasoning = false;
  _sawReasoningItem = false;
  _emittedToolCallIds = new Set<string>();
  _emittedWebSearchIds = new Set<string>();
  _emittedWebSearchWithSourcesIds = new Set<string>();
  _pendingFunctionCalls = new Map<string, PendingFunctionCall>();
  _emittedReasoningItemIds = new Set<string>();

  constructor(logger?: PluginLogger) { this._logger = logger; }

  requiresExplicitStreamCompletion(): boolean { return true; }

  static preservesProviderReasoningExtensions(baseUrl: string): boolean {
    let host: string;
    try { host = asciiLowercase(new URL(rustTrim(baseUrl)).hostname); } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
    return host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
      || host.endsWith('.maas.aliyuncs.com') || host === 'qianfan.baidubce.com' || host.endsWith('.volces.com');
  }

  static modelSupportsPromptCacheBreakpoint(model: string): boolean {
    const lower = asciiLowercase(rustTrim(model));
    const segment = lower.split('/').pop() ?? '';
    if (!segment.startsWith('gpt-')) return false;
    const rest = segment.slice(4);
    const majorDigits = /^\d*/.exec(rest)![0];
    const major = parseU32(majorDigits);
    // Rust parses the digit run as u32; an overflowing run fails the whole check.
    if (major === undefined) return false;
    const afterMajor = rest.slice(majorDigits.length);
    if (major > 5) {
      if (afterMajor === '' || afterMajor.startsWith('-') || afterMajor.startsWith('_')) return true;
      return afterMajor.startsWith('.') && /^\d/.test(afterMajor.slice(1));
    }
    if (major !== 5) return false;
    if (!afterMajor.startsWith('.')) return false;
    const minorPart = afterMajor.slice(1), minorDigits = /^\d*/.exec(minorPart)![0];
    const minor = parseU32(minorDigits);
    if (minor === undefined) return false;
    const suffix = minorPart.slice(minorDigits.length);
    return minor >= 6 && (suffix === '' || suffix.startsWith('-') || suffix.startsWith('_'));
  }

  static endpointSupportsPromptCacheBreakpoint(baseUrl: string): boolean { return isOfficialEndpoint(baseUrl, 'api.openai.com'); }

  /** providers/mod.rs:1515 `convert_to_responses_format` (endpointless gate is always false). */
  static convertToResponsesFormat(model: string, body: JsonValue): JsonObject {
    return OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(model, body, '');
  }

  /** providers/mod.rs:1519 `convert_to_responses_format_for_endpoint`. */
  static convertToResponsesFormatForEndpoint(model: string, body: JsonValue, baseUrl: string): JsonObject {
    const source = sanitizeOpenaiRequestBody(body);
    const inputBlocks: JsonValue[] = [];
    const instructions: string[] = [];
    const deepseekOfficial = isOfficialEndpoint(baseUrl, 'api.deepseek.com');
    const deepseekInHistorySystem = deepseekOfficial
      && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(asciiLowercase(rustTrim(model)));

    for (const message of array(field(source, 'messages')) ?? []) {
      const role = string(field(message, 'role')) ?? 'user';
      if (role === 'system') {
        const content = field(message, 'content');
        if (deepseekInHistorySystem && (instructions.length > 0 || inputBlocks.length > 0)) {
          const parts: JsonValue[] = [];
          if (content !== undefined) pushMessageParts(parts, role, content);
          inputBlocks.push({ role: 'system', content: parts });
          continue;
        }
        if (content !== undefined) {
          if (typeof content === 'string') { if (rustTrim(content) !== '') instructions.push(content); }
          else for (const part of array(content) ?? []) {
            const text = string(field(part, 'text'));
            if (text !== undefined && rustTrim(text) !== '') instructions.push(text);
          }
        }
        continue;
      }
      if (role === 'tool') {
        const item = toolResultItem(message);
        if (item !== undefined) inputBlocks.push(item);
        continue;
      }
      if (role === 'assistant') {
        const reasoningItem = field(message, 'response_reasoning_item');
        if (reasoningItem !== undefined && isReasoningItem(reasoningItem)) inputBlocks.push(structuredClone(reasoningItem));
        else if (deepseekOfficial) {
          const text = string(field(message, 'reasoning_content'));
          if (text !== undefined && text !== '') inputBlocks.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text }] });
        }
        for (const item of array(field(message, 'response_web_search_items')) ?? []) {
          if (field(item, 'type') === 'web_search_call'
            && (deepseekInHistorySystem || field(item, 'kind') === undefined)) inputBlocks.push(structuredClone(item));
        }
      }
      const parts: JsonValue[] = [];
      const content = field(message, 'content');
      if (content !== undefined) pushMessageParts(parts, role, content);
      if (parts.length) inputBlocks.push({ role, content: parts });
      if (role === 'assistant') for (const item of assistantToolCallItems(message)) inputBlocks.push(item);
    }

    if (!inputBlocks.length) inputBlocks.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });

    const instructionsAsDeveloperBreakpoint = instructions.length > 0
      && OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint(model)
      && OpenAIResponsesAdapter.endpointSupportsPromptCacheBreakpoint(baseUrl);
    if (instructionsAsDeveloperBreakpoint) {
      inputBlocks.unshift({ role: 'developer', content: [{ type: 'input_text', text: instructions.join('\n\n'), prompt_cache_breakpoint: { mode: 'explicit' } }] });
    }

    const streamEnabled = typeof field(source, 'stream') === 'boolean' ? field(source, 'stream') as boolean : true;
    const payload: JsonObject = { model, input: inputBlocks, stream: streamEnabled };
    const store = field(source, 'store');
    payload.store = store === undefined ? false : structuredClone(store);
    if (instructions.length && !instructionsAsDeveloperBreakpoint) payload.instructions = instructions.join('\n\n');

    const reasoning = field(source, 'reasoning');
    if (reasoning !== undefined) {
      const reasoningConfig = structuredClone(reasoning);
      const reasoningObject = object(reasoningConfig);
      if (reasoningObject && !Object.hasOwn(reasoningObject, 'effort')) {
        const effort = field(source, 'reasoning_effort');
        if (effort !== undefined) reasoningObject.effort = structuredClone(effort);
      }
      if (reasoningObject && !Object.hasOwn(reasoningObject, 'summary')) reasoningObject.summary = 'auto';
      payload.reasoning = reasoningConfig;
    } else {
      const lower = model.toLowerCase();
      if (lower.includes('o1') || lower.includes('o3') || lower.includes('gpt-5') || field(source, 'reasoning_effort') !== undefined) {
        const reasoningConfig: JsonObject = { summary: 'auto' };
        const effort = field(source, 'reasoning_effort');
        if (effort !== undefined) reasoningConfig.effort = structuredClone(effort);
        payload.reasoning = reasoningConfig;
      }
    }

    const include = field(source, 'include');
    if (include !== undefined) payload.include = structuredClone(include);
    else {
      const lower = model.toLowerCase();
      if (lower.includes('gpt-5') || lower.includes('codex') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
        payload.include = ['reasoning.encrypted_content'];
      }
    }

    if (deepseekOfficial) {
      const thinking = string(field(field(source, 'thinking'), 'type'));
      if (thinking === 'disabled') payload.reasoning = { effort: 'none' };
      else if (thinking === 'enabled') {
        const effortOption = firstPresentOf(
          field(source, 'reasoning_effort'),
          field(field(source, 'reasoning'), 'effort'),
        );
        const effort = effortOption === undefined ? 'high' : effortOption;
        payload.reasoning = { effort: structuredClone(effort) };
      }
    }

    const maxTokens = firstPresentOf(
      field(source, 'max_completion_tokens'),
      field(source, 'max_total_tokens'),
      field(source, 'max_tokens'),
    );
    if (maxTokens !== undefined) payload.max_output_tokens = structuredClone(maxTokens);
    const temperature = field(source, 'temperature');
    if (temperature !== undefined) payload.temperature = structuredClone(temperature);
    if (deepseekOfficial) {
      const topP = field(source, 'top_p');
      if (topP !== undefined) payload.top_p = structuredClone(topP);
      if (model === 'deepseek-flash') for (const key of ['safety_check', 'title']) {
        const value = field(source, key);
        if (value !== undefined) payload[key] = structuredClone(value);
      }
    }

    const responseFormat = field(source, 'response_format');
    if (responseFormat !== undefined) payload.text = { format: convertResponseFormat(responseFormat) };
    const verbosity = field(source, 'verbosity');
    if (verbosity !== undefined) {
      const textConfig = object(payload.text) ?? {};
      payload.text = { ...textConfig, verbosity: structuredClone(verbosity) };
    }
    const tools = array(field(source, 'tools'));
    if (tools && tools.length) payload.tools = tools.map(convertToolDefinition);
    const toolChoice = field(source, 'tool_choice');
    if (toolChoice !== undefined) {
      const converted = convertToolChoice(toolChoice);
      if (converted !== undefined) payload.tool_choice = converted;
    }
    const parallel = field(source, 'parallel_tool_calls');
    if (parallel !== undefined) payload.parallel_tool_calls = structuredClone(parallel);

    if (OpenAIResponsesAdapter.preservesProviderReasoningExtensions(baseUrl)) {
      for (const key of ['thinking', 'enable_thinking', 'thinking_budget']) {
        const value = field(source, key);
        if (value !== undefined) payload[key] = structuredClone(value);
      }
    }
    return payload;
  }

  buildRequest(baseUrl: string, apiKey: string, model: string, body: JsonValue): ProviderRequest {
    const url = openaiEndpointUrl(baseUrl, 'responses');
    const key = rustTrim(apiKey);
    const headers: [string, string][] = [['Content-Type', 'application/json']];
    if (key) headers.unshift(['Authorization', `Bearer ${key}`]);
    const payload = OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(model, body, baseUrl);
    const deepseekFlash = URL.parse(baseUrl)?.origin === 'https://api.deepseek.com' && model === 'deepseek-flash';
    this.deepseekWebTools = deepseekFlash && (array(payload.tools) ?? []).some(tool =>
      ['deepseek_web_search', 'deepseek_read_url'].includes(string(field(tool, 'type')) ?? ''));
    this.deepseekModerated = this.deepseekWebTools || (deepseekFlash && field(payload.safety_check, 'level') === 'high');
    return { url, headers, body: payload };
  }

  _tryEmitReasoningItem(item: JsonValue, allowUnidentified: boolean, events: StreamEvent[]): boolean {
    if (!isReasoningItem(item)) return false;
    const id = string(field(item, 'id'));
    if (id !== undefined) {
      if (this._emittedReasoningItemIds.has(id)) return false;
      this._emittedReasoningItemIds.add(id);
    } else if (!allowUnidentified) return false;
    this._sawReasoningItem = true;
    events.push({ type: 'ResponseReasoningItem', value: structuredClone(item) });
    return true;
  }

  _emitReasoningItemsFromResponse(response: JsonValue, events: StreamEvent[]): void {
    const allow = !this._sawReasoningItem;
    for (const item of array(field(response, 'output')) ?? []) this._tryEmitReasoningItem(item, allow, events);
  }

  _emitReasoningAndToolCallsFromResponse(response: JsonValue, events: StreamEvent[]): void {
    const allow = !this._sawReasoningItem;
    (array(field(response, 'output')) ?? []).forEach((item, index) => {
      this._tryEmitReasoningItem(item, allow, events);
      this._emitResponseToolCall(item, index, events);
    });
  }

  _emitResponseToolCall(item: JsonValue, outputIndex: number, events: StreamEvent[]): void {
    const toolCall = convertResponseToolCall(item, outputIndex);
    if (toolCall === undefined) return;
    const id = string(field(toolCall, 'id'));
    if (id === undefined) return;
    if (!this._emittedToolCallIds.has(id)) {
      this._emittedToolCallIds.add(id);
      events.push({ type: 'ToolCall', value: toolCall });
    }
  }

  _beginStreamingFunctionCall(item: JsonValue, outputIndex: number, events: StreamEvent[]): void {
    const itemId = string(field(item, 'id'));
    if (itemId === undefined) return;
    const callId = string(field(item, 'call_id')) ?? itemId;
    const name = string(field(item, 'name')) ?? '';
    const initialArguments = string(field(item, 'arguments')) ?? '';
    const isNew = !this._pendingFunctionCalls.has(itemId);
    this._pendingFunctionCalls.set(itemId, { callId, name, outputIndex, arguments: initialArguments });
    if (isNew && !this._emittedToolCallIds.has(callId) && name !== '') {
      events.push({ type: 'ToolCall', value: { index: outputIndex, id: callId, type: 'function', function: { name, arguments: initialArguments } } });
    }
  }

  _appendFunctionCallArgumentsDelta(parsed: JsonValue, events: StreamEvent[]): void {
    const delta = string(field(parsed, 'delta'));
    if (delta === undefined || delta === '') return;
    const itemId = string(field(parsed, 'item_id')) ?? string(field(parsed, 'call_id'));
    if (itemId === undefined) return;
    const existing = this._pendingFunctionCalls.get(itemId);
    if (!existing) {
      this._pendingFunctionCalls.set(itemId, { callId: '', name: '', outputIndex: i64At(parsed, 'output_index') ?? 0, arguments: delta });
      return;
    }
    existing.arguments += delta;
    const outputIndex = i64At(parsed, 'output_index') ?? existing.outputIndex;
    events.push({ type: 'ToolCall', value: { index: outputIndex, type: 'function', function: { arguments: delta } } });
  }

  _emitWebSearchItem(item: JsonValue, stage: string, events: StreamEvent[]): void {
    const id = string(field(item, 'id')) ?? string(field(item, 'call_id')) ?? '';
    const sources = array(field(item, 'sources')) ?? extractWebSearchSources(item);
    const hasSources = sources.length > 0;
    if (stage === 'completed') {
      const alreadyEmitted = this._emittedWebSearchIds.has(id);
      this._emittedWebSearchIds.add(id);
      if (alreadyEmitted && this._emittedWebSearchWithSourcesIds.has(id)) return;
      if (hasSources) this._emittedWebSearchWithSourcesIds.add(id);
    } else this._emittedWebSearchIds.add(id);
    const payload: JsonObject = { id, stage };
    if (stage === 'completed') payload.sources = structuredClone(sources);
    const fullItem = fullWebSearchItem(item);
    if (fullItem !== undefined && (!this.deepseekWebTools || stage === 'completed' || stage === 'failed')) payload.item = fullItem;
    events.push({ type: 'WebSearchCall', value: payload });
  }

  _emitWebSearchFromResponse(response: JsonValue, events: StreamEvent[]): void {
    let fallbackSources: JsonValue[] = [];
    for (const item of array(field(response, 'output')) ?? []) {
      if (field(item, 'type') === 'web_search_call') {
        const stage = string(field(item, 'status')) ?? 'completed';
        this._emitWebSearchItem(item, stage, events);
        fallbackSources = fallbackSources.concat(extractWebSearchSources(item));
      }
    }
    if (!fallbackSources.length || this.deepseekWebTools) {
      for (const item of array(field(response, 'output')) ?? []) {
        if (field(item, 'type') === 'message') fallbackSources = fallbackSources.concat(extractWebSearchSources(item));
      }
      if (fallbackSources.length) this._emitWebSearchItem({ id: 'resp_web_search', sources: fallbackSources }, 'completed', events);
    }
  }

  parseStream(line: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    let eventName: string | undefined;
    for (const rawLine of line.split('\n')) {
      const trimmed = rawLine.replace(/\r+$/, '');
      if (trimmed.startsWith('event:')) eventName = rustTrim(trimmed.slice(6));
    }
    const data = extractStreamDataPayload(line);
    if (data === null) return events;
    if (data === '[DONE]') {
      events.push(this.deepseekModerated
        ? { type: 'SafetyBlocked', value: { type: 'provider_error', reason: 'missing_terminal', details: 'DeepSeek ended before the final response' } }
        : { type: 'Done' });
      return events;
    }
    const parsed = parseJson(data);
    if (parsed === undefined) return events;
    const parsedObject = object(parsed);
    if (parsedObject && !Object.hasOwn(parsedObject, 'type') && eventName !== undefined) parsedObject.type = eventName;
    const eventType = string(field(parsed, 'type')) ?? '';
    if (eventType === '') {
      const error = field(parsed, 'error');
      if (error !== undefined && error !== null) {
        this._logger?.error('[OpenAIResponsesAdapter] Untyped stream error: %s', JSON.stringify(error));
        events.push({ type: 'SafetyBlocked', value: { type: 'provider_error', reason: 'stream_error', details: structuredClone(error) } });
        return events;
      }
    }
    switch (eventType) {
      case 'response.output_text.delta': {
        if (this.deepseekModerated) break;
        const delta = string(field(parsed, 'delta'));
        if (delta !== undefined && delta !== '') { this._sawContentDelta = true; this._emittedContent = true; events.push({ type: 'ContentChunk', value: delta }); }
        break;
      }
      case 'response.output_text.done': {
        if (this.deepseekModerated) break;
        if (!this._sawContentDelta) {
          const text = string(field(parsed, 'text')) ?? string(field(parsed, 'delta'));
          if (text !== undefined && text !== '') { this._emittedContent = true; events.push({ type: 'ContentChunk', value: text }); }
        }
        break;
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        if (this.deepseekModerated) break;
        const text = string(field(parsed, 'delta')) ?? string(field(parsed, 'text'));
        if (text !== undefined && text !== '') { this._sawReasoningDelta = true; this._emittedReasoning = true; events.push({ type: 'ReasoningChunk', value: text }); }
        break;
      }
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.done': {
        if (this.deepseekModerated) break;
        if (!this._sawReasoningDelta) {
          const text = string(field(parsed, 'text')) ?? string(field(parsed, 'delta'));
          if (text !== undefined && text !== '') { this._emittedReasoning = true; events.push({ type: 'ReasoningChunk', value: text }); }
        }
        break;
      }
      case 'response.output_item.added': {
        const item = field(parsed, 'item');
        if (item !== undefined) {
          const outputIndex = i64At(parsed, 'output_index') ?? i64At(item, 'index') ?? 0;
          if (!this.deepseekModerated && field(item, 'type') === 'function_call') this._beginStreamingFunctionCall(item, outputIndex, events);
          if (field(item, 'type') === 'web_search_call') this._emitWebSearchItem(item, string(field(item, 'status')) ?? 'in_progress', events);
        }
        break;
      }
      case 'response.output_item.done': {
        const item = field(parsed, 'item');
        if (item !== undefined) {
          if (!this.deepseekModerated) this._tryEmitReasoningItem(item, true, events);
          const outputIndex = i64At(parsed, 'output_index') ?? i64At(item, 'index') ?? 0;
          const itemId = string(field(item, 'id'));
          const pending = itemId === undefined ? undefined : this._pendingFunctionCalls.get(itemId);
          if (itemId !== undefined) this._pendingFunctionCalls.delete(itemId);
          const hasArguments = (string(field(item, 'arguments')) ?? '') !== '';
          if (this.deepseekModerated) {
            // Function calls, like text, are committed only by the final response.
          } else if (field(item, 'type') === 'function_call' && !hasArguments) {
            if (pending && pending.arguments !== '') this._emitResponseToolCall({ ...object(structuredClone(item))!, arguments: pending.arguments }, outputIndex, events);
            else this._emitResponseToolCall(item, outputIndex, events);
          } else this._emitResponseToolCall(item, outputIndex, events);
          if (field(item, 'type') === 'web_search_call') this._emitWebSearchItem(item, string(field(item, 'status')) ?? 'completed', events);
        }
        break;
      }
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching': {
        const defaultStage = eventType.endsWith('.in_progress') ? 'in_progress' : 'searching';
        const stage = string(field(parsed, 'stage')) ?? defaultStage;
        const id = string(field(parsed, 'call_id')) ?? string(field(parsed, 'item_id')) ?? '';
        events.push({ type: 'WebSearchCall', value: { id, stage } });
        break;
      }
      case 'response.web_search_call.completed': {
        const item = field(parsed, 'item');
        this._emitWebSearchItem(item === undefined ? parsed : item, 'completed', events);
        break;
      }
      case 'response.function_call_arguments.delta':
      case 'response.function_call.arguments.delta':
        if (!this.deepseekModerated) this._appendFunctionCallArgumentsDelta(parsed, events);
        break;
      case 'response.function_call_arguments.done':
      case 'response.function_call.arguments.done': {
        if (this.deepseekModerated) break;
        const itemId = string(field(parsed, 'item_id'));
        const pending = itemId === undefined ? undefined : this._pendingFunctionCalls.get(itemId);
        if (itemId !== undefined) this._pendingFunctionCalls.delete(itemId);
        const name = string(field(parsed, 'name')) ?? (pending && pending.name !== '' ? pending.name : undefined);
        const argumentsValue = string(field(parsed, 'arguments')) ?? (pending && pending.arguments !== '' ? pending.arguments : undefined);
        const callId = string(field(parsed, 'call_id')) ?? (pending && pending.callId !== '' ? pending.callId : undefined) ?? itemId;
        if (name !== undefined && callId !== undefined) {
          const item = { type: 'function_call', call_id: callId, name, arguments: argumentsValue ?? '{}' };
          const outputIndex = i64At(parsed, 'output_index') ?? pending?.outputIndex ?? 0;
          this._emitResponseToolCall(item, outputIndex, events);
        }
        break;
      }
      case 'response.completed':
      case 'response.done': {
        const responseOption = field(parsed, 'response');
        const response = responseOption === undefined ? parsed : responseOption;
        if (this.deepseekModerated && this._deepseekBlocked(response, events)) break;
        if (!this._emittedContent) {
          const content = this.deepseekWebTools ? deepseekCitedText(response) : extractOutputText(response);
          if (content !== undefined) { this._emittedContent = true; events.push({ type: 'ContentChunk', value: content }); }
        }
        if (!this._emittedReasoning) {
          const reasoningText = extractReasoningText(response);
          if (reasoningText !== undefined && reasoningText !== '') { this._emittedReasoning = true; events.push({ type: 'ReasoningChunk', value: reasoningText }); }
        }
        const usage = field(response, 'usage');
        if (usage !== undefined) events.push({ type: 'Usage', value: structuredClone(usage) });
        this._emitReasoningAndToolCallsFromResponse(response, events);
        this._emitWebSearchFromResponse(response, events);
        events.push({ type: 'Done' });
        break;
      }
      case 'response.incomplete':
      case 'response.cancelled':
      case 'response.canceled': {
        const response = field(parsed, 'response');
        if (response !== undefined) {
          if (this.deepseekModerated && this._deepseekBlocked(response, events)) break;
          const truncated = field(field(response, 'incomplete_details'), 'reason') === 'max_output_tokens';
          if ((!this.deepseekModerated || truncated) && !this._emittedContent) {
            const content = this.deepseekWebTools ? deepseekCitedText(response) : extractOutputText(response);
            if (content !== undefined) { this._emittedContent = true; events.push({ type: 'ContentChunk', value: content }); }
          }
          if (!this.deepseekModerated) this._emitReasoningItemsFromResponse(response, events);
          this._emitWebSearchFromResponse(response, events);
          const usage = field(response, 'usage');
          if (usage !== undefined) events.push({ type: 'Usage', value: structuredClone(usage) });
        }
        const incomplete = field(field(parsed, 'response'), 'incomplete_details');
        const details = incomplete === undefined ? structuredClone(parsed) : incomplete;
        events.push({ type: 'SafetyBlocked', value: { type: 'provider_error', reason: eventType, details } });
        break;
      }
      case 'response.failed':
      case 'error': {
        const errorOption = firstPresentOf(
          field(field(parsed, 'response'), 'error'),
          field(parsed, 'error'),
        );
        const errorDetail = errorOption === undefined ? structuredClone(parsed) : errorOption;
        this._logger?.error('[OpenAIResponsesAdapter] Stream failed event: %s', JSON.stringify(errorDetail));
        const usage = field(field(parsed, 'response'), 'usage');
        if (usage !== undefined) events.push({ type: 'Usage', value: structuredClone(usage) });
        events.push({ type: 'SafetyBlocked', value: { type: 'provider_error', reason: eventType, details: errorDetail } });
        break;
      }
      default: break;
    }
    return events;
  }

  private _deepseekBlocked(response: JsonValue, events: StreamEvent[]): boolean {
    const refusal = deepseekRefusal(response);
    if (!refusal && field(field(response, 'incomplete_details'), 'reason') !== 'content_filter') return false;
    const usage = field(response, 'usage');
    if (usage !== undefined) events.push({ type: 'Usage', value: structuredClone(usage) });
    events.push({ type: 'SafetyBlocked', value: { type: 'safety_error', reason: 'content_filter', details: refusal ?? null } });
    return true;
  }

  finishStream(): StreamEvent[] { return []; }
}
