import type { JsonObject, JsonValue, PluginLogger, ProviderAdapter, ProviderRequest, StreamEvent } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { extractStreamDataPayload } from '../../../../platform/util/portable.ts';
import { array, cloneExact, field, fieldI64, i32At, i64At, losslessJsonField, object, parseJson, setExactInteger, string } from '../json.ts';
import { parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../../platform/util/lossless-json.ts';
import { remoteImageBase64Payload } from '../media/remote-image.ts';
import { removeKey } from '../json_map.ts';

/** providers/mod.rs:3042. Anthropic hard limit: 4 cache_control breakpoints per request. */
export const ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4;

export type ClaudeGeneration = 'adaptive' | 'manual' | 'unsupported';

const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;

/** llm_manager/adapters/anthropic.rs:65 `parse_claude_model`. */
function parseClaudeModel(model: string): [string, number, number | undefined] | undefined {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/).filter(token => token !== '');
  const familyIndex = tokens.findIndex(token => (CLAUDE_FAMILIES as readonly string[]).includes(token));
  if (familyIndex < 0) return undefined;
  const family = CLAUDE_FAMILIES.find(candidate => candidate === tokens[familyIndex])!;
  const asVersion = (token: string | undefined): number | undefined => {
    if (token === undefined || !/^\d+$/.test(token)) return undefined;
    const value = Number(token);
    return value < 100 ? value : undefined;
  };
  const after = asVersion(tokens[familyIndex + 1]);
  if (after !== undefined) return [family, after, asVersion(tokens[familyIndex + 2])];
  const numbers: number[] = [];
  let i = familyIndex;
  while (i > 0) {
    i -= 1;
    const value = asVersion(tokens[i]);
    if (value === undefined) break;
    numbers.push(value);
  }
  numbers.reverse();
  if (numbers.length) return [family, numbers[0]!, numbers[1]];
  return [family, 0, undefined];
}

/** llm_manager/adapters/anthropic.rs:109 `claude_generation`. */
export function claudeGeneration(model: string): ClaudeGeneration {
  const parsed = parseClaudeModel(model);
  if (!parsed) return 'unsupported';
  const [family, major, minor] = parsed;
  if (family === 'fable' || family === 'mythos') return 'adaptive';
  if (family === 'opus' || family === 'sonnet') {
    if (major === 0) return 'unsupported';
    if (major >= 5) return 'adaptive';
    if (major === 4 && minor !== undefined && minor >= 6) return 'adaptive';
    if (major === 4) return 'manual';
    if (family === 'sonnet' && major === 3 && minor === 7) return 'manual';
    return 'unsupported';
  }
  if (family === 'haiku') {
    if (major === 0) return 'unsupported';
    return major === 4 ? 'manual' : 'unsupported';
  }
  return 'unsupported';
}

/** llm_manager/adapters/anthropic.rs:161 `map_budget_tokens_to_effort`. */
export function mapBudgetTokensToEffort(budget: number): 'low' | 'medium' | 'high' | 'max' {
  if (budget < 8192) return 'low';
  if (budget < 16384) return 'medium';
  if (budget < 32768) return 'high';
  return 'max';
}

/** Shortest decimal that round-trips through f32, matching serde_json's f32 output. */
function f32Shortest(value: number): number {
  const target = Math.fround(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(target.toPrecision(precision));
    if (Math.fround(candidate) === target) return candidate;
  }
  return target;
}

function asI32(value: number): number { return value | 0; }

function ephemeral(): JsonObject { return { type: 'ephemeral' }; }

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonValue;
  cache_control?: JsonValue;
}

/** providers/mod.rs:3049 `enforce_anthropic_cache_breakpoint_budget`. */
export function enforceAnthropicCacheBreakpointBudget(tools: AnthropicTool[] | undefined, systemBlocks: JsonObject[]): void {
  const blockBudget = ANTHROPIC_CACHE_BREAKPOINT_BUDGET - 1;
  const toolMarkerCount = tools?.filter(tool => Object.hasOwn(tool, 'cache_control')).length ?? 0;
  const systemMarkerCount = systemBlocks.filter(block => Object.hasOwn(block, 'cache_control')).length;
  let overflow = Math.max(0, toolMarkerCount + systemMarkerCount - blockBudget);
  if (overflow === 0) return;
  if (tools) {
    for (const tool of tools) {
      if (overflow === 0) break;
      if (Object.hasOwn(tool, 'cache_control')) { delete tool.cache_control; overflow -= 1; }
    }
  }
  for (const block of systemBlocks) {
    if (overflow === 0) break;
    if (Object.hasOwn(block, 'cache_control')) { removeKey(block, 'cache_control'); overflow -= 1; }
  }
}

/** providers/mod.rs:3094 `extract_system_text_blocks`. */
function extractSystemTextBlocks(message: JsonValue): JsonObject[] {
  const content = field(message, 'content');
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts = array(content);
  if (!parts) return [];
  const blocks: JsonObject[] = [];
  for (const part of parts) {
    if (string(field(part, 'type')) !== 'text') continue;
    const text = string(field(part, 'text'));
    if (text === undefined) continue;
    const block: JsonObject = { type: 'text', text };
    const partObject = object(part);
    if (partObject && Object.hasOwn(partObject, 'cache_control')) block.cache_control = structuredClone(partObject.cache_control!);
    blocks.push(block);
  }
  return blocks;
}

/** providers/mod.rs:3403 `sanitize_tool_name_for_anthropic`. */
function sanitizeToolName(name: string): string {
  return [...name].map(char => /^[A-Za-z0-9_-]$/.test(char) ? char : '_').join('');
}

/** providers/mod.rs:3417 `restore_tool_name_from_anthropic`. */
export function restoreToolNameFromAnthropic(name: string): string { return name; }

/** providers/mod.rs:3509 `create_base64_payload`. */
function createBase64Payload(url: string): [string, string] | undefined {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) return undefined;
    const header = url.slice(0, comma);
    const data = url.slice(comma + 1);
    const mediaType = header.replace(/^(?:data:)+/, '').replace(/(?:;base64)+$/, '');
    return [mediaType, data];
  }
  return remoteImageBase64Payload(url);
}

/** providers/mod.rs:3535 `convert_response_format_for_anthropic`. */
function convertResponseFormatForAnthropic(value: JsonValue): JsonValue {
  const obj = object(value);
  if (!obj) return structuredClone(value);
  const formatType = string(obj.type) ?? '';
  if (formatType === 'json_object') return { type: 'json' };
  if (formatType === 'json_schema') {
    const wrapper = obj.json_schema;
    if (wrapper !== undefined) {
      const wrapperObject = object(wrapper);
      const schema = wrapperObject && Object.hasOwn(wrapperObject, 'schema')
        ? structuredClone(wrapperObject.schema!)
        : structuredClone(wrapper);
      return { type: 'json_schema', schema };
    }
    return { type: 'json' };
  }
  return structuredClone(value);
}

/** providers/mod.rs:3462 `convert_tool_choice`. */
function convertToolChoice(choice: JsonValue | undefined): JsonValue | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'any') return { type: choice };
    return undefined;
  }
  const obj = object(choice);
  if (!obj) return undefined;
  const choiceType = string(obj.type);
  if (choiceType === 'auto' || choiceType === 'none' || choiceType === 'any') return { type: choiceType };
  if (choiceType === 'function' || choiceType === 'tool') {
    const name = string(obj.name) ?? string(field(obj.function, 'name'));
    if (name !== undefined) return { type: 'tool', name };
  }
  const functionName = string(obj.function);
  if (functionName !== undefined) return { type: 'tool', name: functionName };
  return undefined;
}

/** providers/mod.rs:3421 `convert_tool_definition`. */
function convertToolDefinition(value: JsonValue): AnthropicTool | undefined {
  if ((string(field(value, 'type')) ?? 'function') !== 'function') return undefined;
  const fn = object(field(value, 'function'));
  if (!fn) return undefined;
  const rawName = string(fn.name);
  if (rawName === undefined) return undefined;
  const description = string(fn.description);
  const inputSchema = fn.parameters !== undefined
    ? structuredClone(fn.parameters)
    : { type: 'object', properties: {} };
  const schemaObject = object(inputSchema);
  if (schemaObject && !Object.hasOwn(schemaObject, 'type')) schemaObject.type = 'object';
  const valueObject = object(value);
  const hasCacheControl = valueObject !== undefined && Object.hasOwn(valueObject, 'cache_control');
  const tool = {
    name: sanitizeToolName(rawName),
    ...(description !== undefined ? { description } : {}),
    input_schema: inputSchema,
    ...(hasCacheControl ? { cache_control: structuredClone(valueObject.cache_control!) } : {}),
  } as AnthropicTool;
  return tool;
}

/** providers/mod.rs:3119 `convert_user_message`. */
function convertUserMessage(message: JsonValue): { role: 'user'; content: JsonObject[] } | undefined {
  const content = field(message, 'content');
  if (content === undefined) return undefined;
  const blocks: JsonObject[] = [];
  if (typeof content === 'string') {
    if (content !== '') blocks.push({ type: 'text', text: content });
  } else {
    for (const part of array(content) ?? []) {
      const partType = string(field(part, 'type'));
      if (partType === 'text') {
        const text = string(field(part, 'text'));
        if (text !== undefined && text !== '') blocks.push({ type: 'text', text });
      } else if (partType === 'image_url') {
        const url = string(field(field(part, 'image_url'), 'url'));
        if (url === undefined) continue;
        const payload = createBase64Payload(url);
        if (payload) blocks.push({ type: 'image', source: { type: 'base64', media_type: payload[0], data: payload[1] } });
      }
    }
  }
  return blocks.length ? { role: 'user', content: blocks } : undefined;
}

function thinkingBlock(thinking: string, signature: string): JsonObject {
  const block: JsonObject = { type: 'thinking', thinking };
  if (signature !== '') block.signature = signature;
  return block;
}

/** providers/mod.rs:3170 `convert_assistant_message`. */
function convertAssistantMessage(message: JsonValue): { role: 'assistant'; content: JsonObject[] } | undefined {
  const blocks: JsonObject[] = [];
  const content = field(message, 'content');
  if (content !== undefined) {
    if (typeof content === 'string') {
      if (content !== '') blocks.push({ type: 'text', text: content });
    } else {
      for (const part of array(content) ?? []) {
        const partType = string(field(part, 'type')) ?? '';
        if (partType === 'thinking') {
          const thinking = string(field(part, 'thinking')) ?? '';
          const signature = string(field(part, 'signature')) ?? '';
          if (thinking !== '' || signature !== '') blocks.push(thinkingBlock(thinking, signature));
        } else if (partType === 'redacted_thinking') {
          const data = string(field(part, 'data'));
          if (data !== undefined) blocks.push({ type: 'redacted_thinking', data });
        } else if (partType === 'text') {
          const text = string(field(part, 'text'));
          if (text !== undefined && text !== '') blocks.push({ type: 'text', text });
        } else if (partType === 'tool_use') {
          const id = string(field(part, 'id')) ?? `tool_call_${crypto.randomUUID()}`;
          const name = string(field(part, 'name')) ?? '';
          const partObject = object(part);
          const input = partObject && Object.hasOwn(partObject, 'input') ? structuredClone(partObject.input!) : {};
          blocks.push({ type: 'tool_use', id, name, input: structuredClone(input) });
        }
      }
    }
  }
  for (const toolCall of array(field(message, 'tool_calls')) ?? []) {
    const fn = field(toolCall, 'function');
    if (fn === undefined) continue;
    const name = string(field(fn, 'name')) ?? '';
    const id = string(field(toolCall, 'id')) ?? `tool_call_${crypto.randomUUID()}`;
    const rawArguments = string(field(fn, 'arguments')) ?? '{}';
    const parsedArguments = parseJson(rawArguments);
    // serde_json parses `null` to Value::Null and only a parse error yields {}.
    const input = parsedArguments === undefined ? {} : parsedArguments;
    blocks.push({ type: 'tool_use', id, name, input });
  }
  const signature = string(field(message, 'thought_signature'));
  if (signature !== undefined && signature !== '') {
    let attached = false;
    for (const block of blocks) {
      if (block.type !== 'thinking') continue;
      if (!Object.hasOwn(block, 'signature') || block.signature === '') block.signature = signature;
      attached = true;
      break;
    }
    if (!attached && blocks.some(block => block.type === 'tool_use')) {
      blocks.unshift(thinkingBlock('', signature));
    }
  }
  return blocks.length ? { role: 'assistant', content: blocks } : undefined;
}

/** providers/mod.rs:3322 `convert_tool_result_message`. */
function convertToolResultMessage(message: JsonValue): { role: 'user'; content: JsonObject[] } | undefined {
  const toolUseId = string(field(message, 'tool_call_id')) ?? '';
  if (toolUseId === '') return undefined;
  const parts: JsonObject[] = [];
  const content = field(message, 'content');
  if (typeof content === 'string') {
    if (content !== '') parts.push({ type: 'text', text: content });
  } else {
    for (const item of array(content) ?? []) {
      if (string(field(item, 'type')) !== 'text') continue;
      const text = string(field(item, 'text'));
      if (text !== undefined && text !== '') parts.push({ type: 'text', text });
    }
  }
  const block: JsonObject = { type: 'tool_result', tool_use_id: toolUseId };
  if (parts.length) block.content = parts;
  const isError = field(message, 'is_error');
  if (typeof isError === 'boolean') block.is_error = isError;
  return { role: 'user', content: [block] };
}

/** providers/mod.rs:3370 `merge_text_content`. */
function mergeTextContent(existing: JsonObject[], incoming: JsonObject[]): void {
  for (const block of incoming) {
    if (block.type === 'text') {
      const target = existing.find(candidate => candidate.type === 'text');
      if (target) target.text = `${String(target.text ?? '')}\n\n${String(block.text ?? '')}`;
      else existing.push(block);
    } else existing.push(block);
  }
}

/** providers/mod.rs:3562 `build_usage_event`. */
export function buildUsageEvent(usage: JsonValue): JsonValue {
  const usageObject = object(usage);
  // `get(a).or_else(|| get(b))` picks the first present key (even a non-integer one).
  const firstPresent = (...keys: string[]): string => keys.find(key => usageObject?.[key] !== undefined) ?? keys[0]!;
  const inputTokens = i32At(usageObject, firstPresent('input_tokens', 'prompt_tokens')) ?? 0;
  const outputTokens = i32At(usageObject, firstPresent('output_tokens', 'completion_tokens')) ?? 0;
  const totalTokens = i32At(usageObject, 'total_tokens') ?? asI32(inputTokens + outputTokens);
  const cachedCandidates: number[] = [];
  const cacheRead = i64At(usageObject, 'cache_read_input_tokens');
  if (cacheRead !== undefined && cacheRead >= 0) cachedCandidates.push(cacheRead);
  for (const detailKey of ['prompt_tokens_details', 'input_tokens_details']) {
    const detail = i64At(field(usage, detailKey), 'cached_tokens');
    if (detail !== undefined && detail >= 0) cachedCandidates.push(detail);
  }
  const deepseekCached = i64At(usageObject, 'prompt_cache_hit_tokens');
  if (deepseekCached !== undefined && deepseekCached >= 0) cachedCandidates.push(deepseekCached);
  const geminiCached = i64At(usageObject, 'cached_tokens');
  if (geminiCached !== undefined && geminiCached >= 0) cachedCandidates.push(geminiCached);
  const cachedTokens = cachedCandidates.length ? Math.max(...cachedCandidates) : undefined;

  const writeCandidates: number[] = [];
  const cacheCreation = i64At(usageObject, 'cache_creation_input_tokens');
  if (cacheCreation !== undefined && cacheCreation >= 0) writeCandidates.push(cacheCreation);
  const responsesWrite = i64At(field(usage, 'input_tokens_details'), 'cache_write_tokens');
  if (responsesWrite !== undefined && responsesWrite >= 0) writeCandidates.push(responsesWrite);
  const gatewayWrite = i64At(usageObject, 'cache_write_tokens');
  if (gatewayWrite !== undefined && gatewayWrite >= 0) writeCandidates.push(gatewayWrite);
  const cacheWriteTokens = writeCandidates.length ? Math.max(...writeCandidates) : undefined;

  const reasoningHolder = usageObject && Object.hasOwn(usageObject, 'reasoning_tokens')
    ? usageObject
    : field(field(usage, 'completion_tokens_details'), 'reasoning_tokens') !== undefined
      ? field(usage, 'completion_tokens_details')
      : field(usage, 'output_tokens_details');
  const reasoningTokens = i64At(reasoningHolder, 'reasoning_tokens');

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    cached_tokens: cachedTokens ?? null,
    cache_write_tokens: cacheWriteTokens ?? null,
    reasoning_tokens: reasoningTokens ?? null,
    total_tokens_openai: totalTokens,
    original: structuredClone(usage),
  };
}

/** providers/mod.rs:3667 `convert_anthropic_response_to_openai`. */
export function convertAnthropicResponseToOpenai(response: JsonValue, model: string): JsonValue | undefined {
  if (string(field(response, 'type')) !== 'message') return undefined;
  const content = array(field(response, 'content'));
  if (!content) return undefined;
  const textSegments: string[] = [];
  const toolCalls: JsonValue[] = [];
  content.forEach((block, index) => {
    const blockType = string(field(block, 'type')) ?? '';
    if (blockType === 'text') {
      const text = string(field(block, 'text'));
      if (text !== undefined && text !== '') textSegments.push(text);
    } else if (blockType === 'tool_use') {
      const id = string(field(block, 'id')) ?? `tool_call_${crypto.randomUUID()}`;
      const name = restoreToolNameFromAnthropic(string(field(block, 'name')) ?? '');
      const blockObject = object(block);
      const input = blockObject && Object.hasOwn(blockObject, 'input')
        ? structuredClone(blockObject.input!)
        : {};
      toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(input) }, index });
    }
  });
  const message: JsonObject = { role: 'assistant', content: textSegments.join('') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const stopReason = string(field(response, 'stop_reason'));
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'max_tokens' ? 'length'
      : stopReason === 'end_turn' ? 'stop'
        : stopReason ?? 'stop';
  const responseObject = object(response)!;
  const usageSource = Object.hasOwn(responseObject, 'usage') ? responseObject.usage : responseObject.usage_metadata;
  let usageValue: JsonObject | undefined;
  if (usageSource !== undefined) {
    // Rust `or_else` stops at a present key even when it is not an i64, so
    // presence decides the branch and only the cast failure yields 0.
    const usageObject = object(usageSource);
    const promptKey = usageObject && Object.hasOwn(usageObject, 'input_tokens') ? 'input_tokens' : 'prompt_tokens';
    const completionKey = usageObject && Object.hasOwn(usageObject, 'output_tokens') ? 'output_tokens' : 'completion_tokens';
    const promptTokens = i32At(usageSource, promptKey) ?? 0;
    const completionTokens = i32At(usageSource, completionKey) ?? 0;
    const totalTokens = i32At(usageSource, 'total_tokens') ?? asI32(promptTokens + completionTokens);
    usageValue = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
    const cacheRead = i64At(usageSource, 'cache_read_input_tokens');
    if (cacheRead !== undefined) usageValue.cache_read_input_tokens = cacheRead;
    const cacheCreation = i64At(usageSource, 'cache_creation_input_tokens');
    if (cacheCreation !== undefined) usageValue.cache_creation_input_tokens = cacheCreation;
  }
  const created = Math.floor(Date.now() / 1000);
  const id = string(field(response, 'id')) ?? `anthropic-msg-${crypto.randomUUID()}`;
  const result: JsonObject = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usageValue !== undefined) result.usage = usageValue;
  return result;
}

/** providers/mod.rs:2306–2914 AnthropicAdapter. */
export class AnthropicAdapter implements ProviderAdapter {
  _logger?: PluginLogger;
  _pendingToolCalls = new Map<number, { id: string; name: string; buffer: string; baseInput?: DbJson }>();
  _pendingSignatures = new Map<number, string>();
  _usageFromStart: JsonValue | undefined;

  constructor(logger?: PluginLogger) { this._logger = logger; }

  requiresExplicitStreamCompletion(): boolean { return true; }

  /** providers/mod.rs:2375 `convert_openai_to_anthropic`. */
  convertOpenaiToAnthropic(model: string, body: JsonValue): JsonObject {
    const bodyObject = object(body) ?? {};
    const stream = typeof bodyObject.stream === 'boolean' ? bodyObject.stream : false;
    // Rust's `or_else` chain stops at a present key even when its value cannot be
    // cast to i64 (falling back to the 1024 default), so probe presence first.
    const maxKey = ['max_tokens', 'max_completion_tokens', 'max_total_tokens']
      .find(key => Object.hasOwn(bodyObject, key));
    const maxTokens = (maxKey === undefined ? undefined : i32At(bodyObject, maxKey)) ?? 1024;
    const generation = claudeGeneration(model);
    const isAdaptiveGeneration = generation === 'adaptive';

    let thinking: JsonValue | undefined = bodyObject.thinking === undefined ? undefined : structuredClone(bodyObject.thinking);
    let derivedEffort: string | undefined;
    if (isAdaptiveGeneration) {
      const thinkingObject = object(thinking);
      if (thinkingObject && thinkingObject.type === 'enabled') {
        // mod.rs:2401-2403 `budget as i32`.
        const budget = i32At(thinkingObject, 'budget_tokens');
        if (budget !== undefined) derivedEffort = mapBudgetTokensToEffort(budget);
        thinking = { type: 'adaptive' };
      }
    }
    const thinkingType = string(field(thinking, 'type'));
    const hasThinking = thinkingType === 'enabled' || thinkingType === 'adaptive';

    const rawTemperature = typeof bodyObject.temperature === 'number' ? f32Shortest(bodyObject.temperature) : undefined;
    const rawTopP = typeof bodyObject.top_p === 'number' ? f32Shortest(bodyObject.top_p) : undefined;
    let temperature: number | undefined;
    let topP: number | undefined;
    if (!(hasThinking || isAdaptiveGeneration)) {
      if (rawTemperature !== undefined) temperature = rawTemperature;
      else if (rawTopP !== undefined) topP = rawTopP;
    }
    const topK = hasThinking || isAdaptiveGeneration ? undefined : i32At(bodyObject, 'top_k');

    const systemBlocks: JsonObject[] = [];
    const messages: { role: 'user' | 'assistant'; content: JsonObject[] }[] = [];
    for (const item of array(bodyObject.messages) ?? []) {
      const role = string(field(item, 'role')) ?? '';
      if (role === 'system' || role === 'developer') {
        systemBlocks.push(...extractSystemTextBlocks(item));
      } else if (role === 'user') {
        const converted = convertUserMessage(item);
        if (!converted) continue;
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') { mergeTextContent(last.content, converted.content); continue; }
        messages.push(converted);
      } else if (role === 'assistant') {
        const converted = convertAssistantMessage(item);
        if (!converted) continue;
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') { mergeTextContent(last.content, converted.content); continue; }
        messages.push(converted);
      } else if (role === 'tool' || role === 'function') {
        const converted = convertToolResultMessage(item);
        if (converted) messages.push(converted);
      }
    }

    const hasBlockLevelMarker = systemBlocks.some(block => Object.hasOwn(block, 'cache_control'));
    if (!hasBlockLevelMarker && systemBlocks.length) systemBlocks[systemBlocks.length - 1]!.cache_control = ephemeral();

    let tools: AnthropicTool[] | undefined;
    const rawTools = array(bodyObject.tools);
    if (rawTools) {
      const converted = rawTools.map(convertToolDefinition).filter((tool): tool is AnthropicTool => tool !== undefined);
      if (!converted.some(tool => Object.hasOwn(tool, 'cache_control')) && converted.length) {
        converted[converted.length - 1]!.cache_control = ephemeral();
      }
      if (converted.length) tools = converted;
    }
    enforceAnthropicCacheBreakpointBudget(tools, systemBlocks);

    const system = systemBlocks.length ? systemBlocks : undefined;

    let stopSequences: string[] | undefined;
    const stop = bodyObject.stop;
    if (typeof stop === 'string') { if (stop !== '') stopSequences = [stop]; }
    else if (Array.isArray(stop)) {
      const sequences = stop.map(value => string(value)).filter((value): value is string => value !== undefined);
      if (sequences.length) stopSequences = sequences;
    }

    let toolChoice = convertToolChoice(bodyObject.tool_choice);
    if (toolChoice === undefined && bodyObject.tool_choice === undefined && tools?.length) toolChoice = { type: 'auto' };

    const responseFormat = bodyObject.response_format === undefined
      ? undefined
      : convertResponseFormatForAnthropic(bodyObject.response_format);

    let outputConfig: JsonObject | undefined;
    const requestedEffort = string(bodyObject.effort);
    const effort = requestedEffort ?? derivedEffort;
    if (effort !== undefined) outputConfig = { effort };
    if (responseFormat !== undefined) {
      if (outputConfig) outputConfig.format = responseFormat;
      else outputConfig = { format: responseFormat };
    }

    if (hasThinking && tools?.length && toolChoice !== undefined) {
      const choiceType = string(field(toolChoice, 'type')) ?? '';
      if (choiceType !== 'auto' && choiceType !== 'none') toolChoice = { type: 'auto' };
    }

    const request: JsonObject = { model, max_tokens: maxTokens, messages: messages as unknown as JsonValue };
    if (system !== undefined) request.system = system as unknown as JsonValue;
    if (tools !== undefined) request.tools = tools as unknown as JsonValue;
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
    if (temperature !== undefined) request.temperature = temperature;
    if (topP !== undefined) request.top_p = topP;
    if (topK !== undefined) request.top_k = topK;
    if (stopSequences !== undefined) request.stop_sequences = stopSequences;
    if (stream) request.stream = true;
    if (thinking !== undefined) request.thinking = thinking;
    if (outputConfig !== undefined) request.output_config = outputConfig;
    request.cache_control = ephemeral();
    return request;
  }

  /** providers/mod.rs:2623 `build_request`. */
  buildRequest(baseUrl: string, apiKey: string, model: string, body: JsonValue): ProviderRequest {
    const trimmed = baseUrl.replace(/\/+$/, '');
    let url: string;
    if (trimmed.endsWith('/v1/messages') || trimmed.endsWith('/messages')) url = trimmed;
    else if (trimmed.endsWith('/v1')) url = `${trimmed}/messages`;
    else url = `${trimmed}/v1/messages`;

    const request = this.convertOpenaiToAnthropic(model, body);

    const bodyObject = object(body) ?? {};
    const hasTools = (array(bodyObject.tools)?.length ?? 0) > 0;
    const generation = claudeGeneration(model);
    const manualThinkingEnabled = string(field(field(bodyObject, 'thinking'), 'type')) === 'enabled';
    const betaFeatures: string[] = [];
    if (manualThinkingEnabled && hasTools && generation === 'manual') {
      if (model.includes('claude-4') || model.includes('claude-opus-4') || model.includes('claude-sonnet-4')) {
        betaFeatures.push('interleaved-thinking-2025-05-14');
      }
    }
    if (bodyObject.effort !== undefined && generation !== 'adaptive') betaFeatures.push('effort-2025-11-24');

    const headers: [string, string][] = [
      ['x-api-key', apiKey],
      ['anthropic-version', '2023-06-01'],
      ['Content-Type', 'application/json'],
    ];
    if (betaFeatures.length) headers.push(['anthropic-beta', betaFeatures.join(',')]);
    return { url, headers, body: request };
  }

  /** providers/mod.rs:2346 `build_merged_usage_event`. */
  _buildMergedUsageEvent(usage: JsonValue): JsonValue {
    const start = this._usageFromStart;
    const usageObject = object(usage);
    const startObject = object(start);
    if (usageObject && startObject) {
      const merged = cloneExact(usageObject);
      for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        const current = fieldI64(merged, key) ?? 0n;
        if (current !== 0n) continue;
        const startValue = fieldI64(startObject, key);
        if (startValue !== undefined && startValue !== 0n) setExactInteger(merged, key, startValue);
      }
      return buildUsageEvent(merged);
    }
    return buildUsageEvent(usage);
  }

  /** providers/mod.rs:2696 `parse_stream`. */
  parseStream(line: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const data = extractStreamDataPayload(line);
    if (data === null) return events;
    const payload = rustTrim(data);
    if (payload === '') return events;
    if (payload === '[DONE]') return [{ type: 'Done' }];
    const parsed = parseJson(payload);
    if (parsed === undefined) return events;
    const eventType = string(field(parsed, 'type')) ?? '';

    if (eventType === 'content_block_delta') {
      const delta = field(parsed, 'delta');
      if (delta !== undefined) {
        const deltaType = string(field(delta, 'type'));
        if (deltaType === 'thinking_delta') {
          const text = string(field(delta, 'thinking'));
          if (text !== undefined && text !== '') events.push({ type: 'ReasoningChunk', value: text });
        } else if (deltaType === 'signature_delta') {
          const index = (i32At(parsed, 'index') ?? 0);
          const fragment = string(field(delta, 'signature'));
          if (fragment !== undefined) this._pendingSignatures.set(index, (this._pendingSignatures.get(index) ?? '') + fragment);
        } else {
          // Rust's else-if chain: any string `text` field terminates the branch,
          // even an empty one, so input_json_delta is only reached without it.
          const text = string(field(delta, 'text'));
          if (text !== undefined) {
            if (text !== '') events.push({ type: 'ContentChunk', value: text });
          } else if (deltaType === 'input_json_delta') {
            const index = (i32At(parsed, 'index') ?? 0);
            const fragment = string(field(delta, 'partial_json'));
            const pending = this._pendingToolCalls.get(index);
            if (fragment !== undefined && pending) pending.buffer += fragment;
          }
        }
      }
    } else if (eventType === 'content_block_start') {
      const contentBlock = object(field(parsed, 'content_block'));
      if (contentBlock && contentBlock.type === 'tool_use') {
        const index = (i32At(parsed, 'index') ?? 0);
        const id = string(contentBlock.id) ?? '';
        const name = string(contentBlock.name) ?? '';
        const baseInput = losslessJsonField(contentBlock, 'input');
        this._pendingToolCalls.set(index, { id, name, buffer: '', baseInput });
      }
    } else if (eventType === 'content_block_stop') {
      const index = (i32At(parsed, 'index') ?? 0);
      const signature = this._pendingSignatures.get(index);
      if (signature !== undefined) {
        this._pendingSignatures.delete(index);
        if (signature !== '') events.push({ type: 'ThoughtSignature', value: signature });
      }
      const toolCall = this._pendingToolCalls.get(index);
      if (toolCall) {
        this._pendingToolCalls.delete(index);
        let argsValue: DbJson;
        if (rustTrim(toolCall.buffer) === '' && toolCall.baseInput !== undefined) argsValue = toolCall.baseInput;
        // Keep serde Value acceptance/error fallback, then reuse the shared
        // lossless representation/serializer rather than printing rounded Numbers.
        // JSON null is valid, not a missing/invalid parse.
        else argsValue = parseJson(toolCall.buffer) === undefined ? {} : parseJsonLossless(toolCall.buffer);
        const argumentsText = stringifyJsonLossless(argsValue);
        events.push({
          type: 'ToolCall',
          value: {
            id: toolCall.id,
            type: 'function',
            function: { name: restoreToolNameFromAnthropic(toolCall.name), arguments: argumentsText },
            index,
          },
        });
      }
    } else if (eventType === 'message_start') {
      const usage = field(field(parsed, 'message'), 'usage');
      if (usage !== undefined) {
        this._usageFromStart = cloneExact(usage);
        events.push({ type: 'Usage', value: buildUsageEvent(usage) });
      }
    } else if (eventType === 'message_delta') {
      const delta = object(field(parsed, 'delta'));
      if (delta) {
        if (delta.usage !== undefined) events.push({ type: 'Usage', value: this._buildMergedUsageEvent(delta.usage) });
        const stopReason = string(delta.stop_reason);
        if (stopReason === 'safety' || stopReason === 'refusal') {
          const payloadValue: JsonObject = { type: 'content_blocked', reason: stopReason };
          if (delta.stop_details !== undefined) payloadValue.stop_details = structuredClone(delta.stop_details);
          events.push({ type: 'SafetyBlocked', value: payloadValue });
        } else if (stopReason === 'model_context_window_exceeded') {
          events.push({
            type: 'SafetyBlocked',
            value: {
              type: 'provider_error',
              reason: stopReason,
              details: { message: '输出因达到模型上下文窗口上限而被截断 (model_context_window_exceeded)' },
            },
          });
        }
      }
      const usage = field(parsed, 'usage');
      if (usage !== undefined) events.push({ type: 'Usage', value: this._buildMergedUsageEvent(usage) });
    } else if (eventType === 'error') {
      const errorField = field(parsed, 'error');
      const errorDetail = errorField === undefined ? structuredClone(parsed) : errorField;
      this._logger?.error('[AnthropicAdapter] Stream error event: %s', JSON.stringify(errorDetail));
      events.push({ type: 'SafetyBlocked', value: { type: 'provider_error', reason: 'stream_error', details: errorDetail } });
      events.push({ type: 'Done' });
    } else if (eventType === 'message_stop') {
      this._pendingToolCalls.clear();
      this._pendingSignatures.clear();
      this._usageFromStart = undefined;
      events.push({ type: 'Done' });
    }
    return events;
  }

  finishStream(): StreamEvent[] { return []; }
}
