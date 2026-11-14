import type { JsonObject, JsonValue, PluginLogger, ProviderRequest } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { array, i64At, object, parseJson, string } from '../json.ts';
import { remoteImageBase64Payload } from '../media/remote-image.ts';
import { AdapterError, asciiLower, compactJson, isSyntheticToolCallId } from './gemini-openai-common.ts';

export { AdapterError, isSyntheticToolCallId, type AdapterErrorKind } from './gemini-openai-common.ts';
export { convertGeminiNonstreamResponseToOpenai, parseGeminiStreamLine, type GeminiPendingToolCall } from './gemini-openai-response.ts';

// ==================== OpenAI 数据结构（最小子集） ====================

type OpenAiContent =
  | { kind: 'text'; text: string }
  | { kind: 'parts'; parts: OpenAiContentPart[] };

type OpenAiContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'unsupported' };

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: string;
  content?: OpenAiContent;
  name?: string;
  toolCalls?: OpenAiToolCall[];
  toolCallId?: string;
  thoughtSignature?: string;
}

interface OpenAiTool {
  type: string;
  function: { name: string; description?: string; parameters: JsonValue };
}

interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  tools?: OpenAiTool[];
  toolChoice?: JsonValue;
  responseFormat?: JsonValue;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// ==================== Gemini 数据结构（最小子集） ====================

interface GeminiContent {
  role: string;
  parts: JsonObject[];
}

interface GeminiRequestDraft {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  generationConfig?: JsonObject;
  tools?: JsonValue;
  toolConfig?: JsonObject;
}

/** adapters/gemini-openai-converter.rs:249 `native_tool_call_id`. */
function nativeToolCallId(id: string): string | undefined {
  const trimmed = rustTrim(id);
  if (trimmed === '' || isSyntheticToolCallId(trimmed)) return undefined;
  return trimmed;
}

// ==================== OpenAI 反序列化（serde 语义） ====================

function deserializationError(detail: string): AdapterError {
  return new AdapterError('serialization_error', `Failed to parse OpenAI request: ${detail}`);
}

function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw deserializationError(`invalid type for field \`${key}\``);
  return value;
}

function optionalNumber(body: JsonObject, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw deserializationError(`invalid type for field \`${key}\``);
  return value;
}

function optionalI32(body: JsonObject, key: string): number | undefined {
  const value = optionalNumber(body, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw deserializationError(`invalid type for field \`${key}\``);
  }
  return value;
}

function optionalBool(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw deserializationError(`invalid type for field \`${key}\``);
  return value;
}

function requireString(body: JsonObject, key: string): string {
  const value = body[key];
  if (value === undefined) throw deserializationError(`missing field \`${key}\``);
  if (typeof value !== 'string') throw deserializationError(`invalid type for field \`${key}\``);
  return value;
}

function parseContentPart(value: JsonValue): OpenAiContentPart {
  const part = object(value);
  if (!part) throw deserializationError('invalid type in `messages[].content`');
  const type = part.type;
  if (typeof type !== 'string') throw deserializationError('invalid type in `messages[].content`');
  if (type === 'text') {
    const text = part.text;
    if (typeof text !== 'string') throw deserializationError('missing field `text`');
    return { kind: 'text', text };
  }
  if (type === 'image_url') {
    const image = object(part.image_url);
    if (!image) throw deserializationError('missing field `image_url`');
    const url = image.url;
    if (typeof url !== 'string') throw deserializationError('missing field `image_url.url`');
    optionalString(image, 'detail');
    return { kind: 'image', url };
  }
  // serde `#[serde(other)]`: audio/video/file parts degrade to Unsupported.
  return { kind: 'unsupported' };
}

function parseContent(value: JsonValue): OpenAiContent {
  if (typeof value === 'string') return { kind: 'text', text: value };
  const parts = array(value);
  if (!parts) throw deserializationError('invalid type in `messages[].content`');
  return { kind: 'parts', parts: parts.map(parseContentPart) };
}

function parseToolCall(value: JsonValue): OpenAiToolCall {
  const call = object(value);
  if (!call) throw deserializationError('invalid type in `tool_calls`');
  const id = requireString(call, 'id');
  const type = requireString(call, 'type');
  const fn = object(call.function);
  if (!fn) throw deserializationError('missing field `function`');
  return { id, type, function: { name: requireString(fn, 'name'), arguments: requireString(fn, 'arguments') } };
}

function parseMessage(value: JsonValue): OpenAiMessage {
  const message = object(value);
  if (!message) throw deserializationError('invalid type in `messages`');
  const role = requireString(message, 'role');
  const messageContent = message.content;
  const content = messageContent === undefined || messageContent === null ? undefined : parseContent(messageContent);
  const name = optionalString(message, 'name');
  const toolCallId = optionalString(message, 'tool_call_id');
  const thoughtSignature = optionalString(message, 'thought_signature');
  let toolCalls: OpenAiToolCall[] | undefined;
  const rawToolCalls = message.tool_calls;
  if (rawToolCalls !== undefined && rawToolCalls !== null) {
    const items = array(rawToolCalls);
    if (!items) throw deserializationError('invalid type for field `tool_calls`');
    toolCalls = items.map(parseToolCall);
  }
  return { role, content, name, toolCalls, toolCallId, thoughtSignature };
}

function parseTool(value: JsonValue): OpenAiTool {
  const tool = object(value);
  if (!tool) throw deserializationError('invalid type in `tools`');
  const type = requireString(tool, 'type');
  const fn = object(tool.function);
  if (!fn) throw deserializationError('missing field `function`');
  const name = requireString(fn, 'name');
  if (!Object.hasOwn(fn, 'parameters')) throw deserializationError('missing field `parameters`');
  const description = optionalString(fn, 'description');
  return { type, function: { name, description, parameters: structuredClone(fn.parameters!) } };
}

function parseStop(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  const values = array(value);
  if (!values) throw deserializationError('invalid type for field `stop`');
  return values.map(item => {
    if (typeof item !== 'string') throw deserializationError('invalid type for field `stop`');
    return item;
  });
}

function parseOpenAiRequest(value: JsonValue): OpenAiRequest {
  const body = object(value);
  if (!body) throw deserializationError('invalid type: expected struct OpenAIRequest');
  const model = requireString(body, 'model');
  const messagesValue = body.messages;
  if (messagesValue === undefined || messagesValue === null) throw deserializationError('missing field `messages`');
  const messagesArray = array(messagesValue);
  if (!messagesArray) throw deserializationError('invalid type for field `messages`');

  const request: OpenAiRequest = { model, messages: messagesArray.map(parseMessage) };
  const stream = optionalBool(body, 'stream');
  if (stream !== undefined) request.stream = stream;
  const temperature = optionalNumber(body, 'temperature');
  if (temperature !== undefined) request.temperature = temperature;
  const topP = optionalNumber(body, 'top_p');
  if (topP !== undefined) request.topP = topP;
  const maxTokens = optionalI32(body, 'max_tokens');
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  const frequencyPenalty = optionalNumber(body, 'frequency_penalty');
  if (frequencyPenalty !== undefined) request.frequencyPenalty = frequencyPenalty;
  const presencePenalty = optionalNumber(body, 'presence_penalty');
  if (presencePenalty !== undefined) request.presencePenalty = presencePenalty;
  const stop = body.stop;
  if (stop !== undefined && stop !== null) request.stopSequences = parseStop(stop);
  const toolsValue = body.tools;
  if (toolsValue !== undefined && toolsValue !== null) {
    const toolList = array(toolsValue);
    if (!toolList) throw deserializationError('invalid type for field `tools`');
    request.tools = toolList.map(parseTool);
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) request.toolChoice = structuredClone(body.tool_choice);
  if (body.response_format !== undefined && body.response_format !== null) request.responseFormat = structuredClone(body.response_format);
  return request;
}

// ==================== 请求构建 ====================

/** Shortest decimal that round-trips through f32, matching serde_json's f32 output. */
function f32Shortest(value: number): number {
  const target = Math.fround(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(target.toPrecision(precision));
    if (Math.fround(candidate) === target) return candidate;
  }
  return target;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function contentToJson(content: GeminiContent): JsonObject {
  return { role: content.role, parts: content.parts };
}

/** adapters/gemini-openai-converter.rs:1546 `extract_text_from_openai_content`. */
function extractTextFromContent(content: OpenAiContent): string {
  if (content.kind === 'text') return content.text;
  return content.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map(part => part.text)
    .join('\n');
}

function textPart(text: string): JsonObject {
  return { text };
}

/** adapters/gemini-openai-converter.rs:1590 `convert_openai_content_to_gemini_parts`. */
function convertContentToParts(content: OpenAiContent, logger?: PluginLogger): JsonObject[] {
  const parts: JsonObject[] = [];
  const items: OpenAiContentPart[] = content.kind === 'text' ? [content] : content.parts;
  for (const part of items) {
    if (part.kind === 'text') {
      if (part.text !== '') parts.push(textPart(part.text));
    } else if (part.kind === 'image') {
      const inlineData = imageUrlToInlineData(part.url);
      if (inlineData) parts.push({ inlineData });
    } else {
      // adapters/gemini-openai-converter.rs:1936: warn and skip audio/video/file.
      logger?.warn('[GeminiConverter] Skipping unsupported content part type (e.g. audio/video/file); only text and image_url are converted');
    }
  }
  return parts;
}

/**
 * adapters/gemini-openai-converter.rs:1949 `image_url_to_inline_data`.
 * Remote http(s) URLs go through the injected synchronous binary cache bridge.
 */
function imageUrlToInlineData(url: string): JsonObject | undefined {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma >= 0) {
      const header = url.slice(0, comma);
      const data = url.slice(comma + 1);
      const mimeType = header.replace(/^(?:data:)+/, '').replace(/(?:;base64)+$/, '');
      return { mimeType, data };
    }
  }
  const remote = remoteImageBase64Payload(url);
  return remote === undefined ? undefined : { mimeType: remote[0], data: remote[1] };
}

/** adapters/gemini-openai-converter.rs:1682 `convert_tool_choice_to_tool_config`. */
function convertToolChoiceToToolConfig(choice: JsonValue): JsonObject | undefined {
  if (typeof choice === 'string') {
    if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    return undefined;
  }
  const choiceObject = object(choice);
  if (choiceObject) {
    if (string(choiceObject.type) === 'function') {
      const functionObject = object(choiceObject.function);
      const name = functionObject ? string(functionObject.name) : undefined;
      if (name !== undefined) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }
    const directName = string(choiceObject.function);
    if (directName !== undefined) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [directName] } };
  }
  return undefined;
}

/** adapters/gemini-openai-converter.rs:1481 `fix_schema_for_gemini`. */
function fixSchemaForGemini(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) fixSchemaForGemini(item);
    return;
  }
  const map = object(value);
  if (!map) return;
  if (map.type === 'array' && !Object.hasOwn(map, 'items')) map.items = { type: 'string' };
  const items = object(map.items);
  if (items && !Object.hasOwn(items, 'type')) {
    items.type = Object.hasOwn(items, 'properties') ? 'object' : 'string';
  }
  const enumValues = array(map.enum);
  if (enumValues) {
    for (let index = 0; index < enumValues.length; index += 1) {
      const item = enumValues[index];
      if (typeof item === 'number') enumValues[index] = String(item);
      else if (typeof item === 'boolean') enumValues[index] = item ? 'true' : 'false';
    }
    if (map.type !== 'string') map.type = 'string';
  }
  for (const key of Object.keys(map)) fixSchemaForGemini(map[key]!);
}

/** adapters/gemini-openai-converter.rs:1440 `convert_openai_to_gemini`. */
function convertOpenAiToGemini(request: OpenAiRequest, logger?: PluginLogger): GeminiRequestDraft {
  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiContent | undefined;

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content) {
        const text = extractTextFromContent(message.content);
        if (text !== '') systemInstruction = { role: 'user', parts: [textPart(text)] };
      }
    } else if (message.role === 'user') {
      if (message.content) {
        const parts = convertContentToParts(message.content, logger);
        if (parts.length) contents.push({ role: 'user', parts });
      }
    } else if (message.role === 'assistant') {
      const parts: JsonObject[] = [];
      if (message.content) {
        const text = extractTextFromContent(message.content);
        if (text !== '') parts.push(textPart(text));
      }
      const toolCalls = message.toolCalls ?? [];
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index]!;
        if (toolCall.type !== 'function') continue;
        const args = parseJson(toolCall.function.arguments) ?? {};
        const nativeId = nativeToolCallId(toolCall.id);
        const functionCall: JsonObject = { name: toolCall.function.name, args };
        if (nativeId !== undefined) functionCall.id = nativeId;
        const part: JsonObject = { functionCall };
        // Gemini 3 requires the signature on the first functionCall part only.
        if (index === 0 && message.thoughtSignature !== undefined) part.thoughtSignature = message.thoughtSignature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (message.role === 'function' || message.role === 'tool') {
      let resolvedName = message.name;
      if (resolvedName === undefined && message.toolCallId !== undefined) {
        for (const previous of request.messages) {
          if (previous.role !== 'assistant') continue;
          const match = (previous.toolCalls ?? []).find(toolCall => toolCall.id === message.toolCallId);
          if (match) { resolvedName = match.function.name; break; }
        }
      }
      if (resolvedName !== undefined && message.content) {
        const responseText = extractTextFromContent(message.content);
        const responseValue = parseJson(responseText) ?? { result: responseText };
        const responseId = message.toolCallId === undefined ? undefined : nativeToolCallId(message.toolCallId);
        const functionResponse: JsonObject = { name: resolvedName, response: responseValue };
        if (responseId !== undefined) functionResponse.id = responseId;
        const newPart: JsonObject = { functionResponse };
        const last = contents[contents.length - 1];
        const shouldMerge = last !== undefined && last.role === 'user'
          && last.parts.every(part => object(part.functionResponse) !== undefined);
        if (last !== undefined && shouldMerge) last.parts.push(newPart);
        else contents.push({ role: 'user', parts: [newPart] });
      }
    }
    // Unknown roles are ignored, as in Rust.
  }

  // Merge consecutive same-role turns so Gemini's strict alternation holds.
  if (contents.length >= 2) {
    const merged: GeminiContent[] = [];
    for (const content of contents) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.role === content.role) {
        const mergedCount = content.parts.length;
        last.parts.push(...content.parts);
        logger?.warn("[GeminiConverter] Merged consecutive '%s' turns (%d parts appended)", last.role, mergedCount);
      } else merged.push(content);
    }
    contents.length = 0;
    contents.push(...merged);
  }

  // Gemini 3 rejects functionCall parts without a real thoughtSignature.
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index]!;
    const hasUnprotected = content.role === 'model'
      && content.parts.some(part => object(part.functionCall) !== undefined && part.thoughtSignature === undefined);
    if (!hasUnprotected) continue;
    for (const part of content.parts) {
      const functionCall = object(part.functionCall);
      if (!functionCall || part.thoughtSignature !== undefined) continue;
      delete part.functionCall;
      part.text = `[Tool call: ${String(functionCall.name)}(${compactJson(functionCall.args)})]`;
    }
    const next = contents[index + 1];
    if (next !== undefined && next.role === 'user') {
      for (const part of next.parts) {
        const functionResponse = object(part.functionResponse);
        if (!functionResponse) continue;
        delete part.functionResponse;
        part.text = `[Tool result for ${String(functionResponse.name)}: ${compactJson(functionResponse.response)}]`;
      }
    }
    logger?.warn('[GeminiConverter] Converted functionCall without thoughtSignature to text at content index %d', index);
  }

  if (contents.length && contents[0]!.role === 'model') {
    logger?.warn("[GeminiConverter] First content is 'model' role, inserting dummy user turn");
    contents.unshift({ role: 'user', parts: [textPart('.')] });
  }

  if (contents.length === 0 && systemInstruction === undefined) {
    throw new AdapterError('invalid_format', 'No valid content to convert');
  }

  const generationConfig = generationConfigFromRequest(request);

  let tools: JsonValue | undefined;
  if (request.tools) {
    const declarations: JsonValue[] = [];
    for (const tool of request.tools) {
      if (tool.type !== 'function') continue;
      const parameters = structuredClone(tool.function.parameters);
      fixSchemaForGemini(parameters);
      declarations.push({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters,
      });
    }
    if (declarations.length) tools = [{ functionDeclarations: declarations }];
  }

  const toolConfig = request.toolChoice === undefined
    ? undefined
    : convertToolChoiceToToolConfig(request.toolChoice);

  const draft: GeminiRequestDraft = { contents };
  if (systemInstruction !== undefined) draft.systemInstruction = systemInstruction;
  if (generationConfig !== undefined) draft.generationConfig = generationConfig;
  if (tools !== undefined) draft.tools = tools;
  if (toolConfig !== undefined) draft.toolConfig = toolConfig;
  return draft;
}

function generationConfigFromRequest(request: OpenAiRequest): JsonObject | undefined {
  const config: JsonObject = {};
  if (request.temperature !== undefined) config.temperature = f32Shortest(request.temperature);
  if (request.topP !== undefined) config.topP = f32Shortest(request.topP);
  if (request.frequencyPenalty !== undefined) config.frequencyPenalty = f32Shortest(request.frequencyPenalty);
  if (request.presencePenalty !== undefined) config.presencePenalty = f32Shortest(request.presencePenalty);
  if (request.maxTokens !== undefined) config.maxOutputTokens = request.maxTokens;
  if (request.stopSequences !== undefined) config.stopSequences = request.stopSequences;
  const format = object(request.responseFormat);
  const formatType = format ? string(format.type) : undefined;
  if (formatType === 'json_object') {
    config.responseMimeType = 'application/json';
  } else if (formatType === 'json_schema') {
    config.responseMimeType = 'application/json';
    if (format && Object.hasOwn(format, 'json_schema')) {
      const holder = format.json_schema!;
      const holderObject = object(holder);
      config.responseSchema = structuredClone(holderObject && Object.hasOwn(holderObject, 'schema')
        ? holderObject.schema!
        : holder);
    }
  }
  return Object.keys(config).length ? config : undefined;
}

function ensureGenerationConfig(draft: GeminiRequestDraft, request: OpenAiRequest): JsonObject {
  draft.generationConfig ??= generationConfigFromRequest(request) ?? {};
  return draft.generationConfig;
}

/** adapters/gemini-openai-converter.rs:424 `build_gemini_request`. */
export function buildGeminiRequest(baseUrl: string, apiKey: string, model: string, openaiBody: JsonValue): ProviderRequest {
  return buildGeminiRequestWithVersion(baseUrl, apiKey, model, openaiBody, undefined);
}

/** adapters/gemini-openai-converter.rs:435 `build_gemini_request_with_version`. */
export function buildGeminiRequestWithVersion(
  baseUrl: string,
  apiKey: string,
  model: string,
  openaiBody: JsonValue,
  apiVersion?: string,
  logger?: PluginLogger,
): ProviderRequest {
  const normalizedBody = structuredClone(openaiBody);
  const bodyMap = object(normalizedBody);
  let reasoningEffort: string | undefined;
  let googleThinkingConfig: JsonValue | null | undefined;
  let injectedTopK: number | undefined;

  if (bodyMap) {
    if (Object.hasOwn(bodyMap, 'max_total_tokens')) {
      const value = bodyMap.max_total_tokens;
      if (!Object.hasOwn(bodyMap, 'max_tokens')) bodyMap.max_tokens = value === undefined ? null : structuredClone(value);
      delete bodyMap.max_total_tokens;
    }
    if (Object.hasOwn(bodyMap, 'max_completion_tokens')) {
      const value = bodyMap.max_completion_tokens;
      if (!Object.hasOwn(bodyMap, 'max_tokens')) bodyMap.max_tokens = value === undefined ? null : structuredClone(value);
      delete bodyMap.max_completion_tokens;
    }
    if (Object.hasOwn(bodyMap, 'reasoning_effort')) reasoningEffort = string(bodyMap.reasoning_effort);
    delete bodyMap.reasoning_effort;

    if (Object.hasOwn(bodyMap, 'google_thinking_config')) {
      const value = bodyMap.google_thinking_config;
      googleThinkingConfig = value === undefined ? null : structuredClone(value);
    }
    delete bodyMap.google_thinking_config;
    if (googleThinkingConfig === undefined && Object.hasOwn(bodyMap, 'thinkingConfig')) {
      const value = bodyMap.thinkingConfig;
      googleThinkingConfig = value === undefined ? null : structuredClone(value);
    }
    delete bodyMap.thinkingConfig;
    delete bodyMap.gemini_api_version;

    const topK = i64At(bodyMap, 'top_k');
    if (topK !== undefined) injectedTopK = clamp(topK, 1, 1_000_000);
  }

  const request = parseOpenAiRequest(normalizedBody);
  const gemini = convertOpenAiToGemini(request, logger);
  const systemInstructionPresent = gemini.systemInstruction !== undefined;

  if (injectedTopK !== undefined) ensureGenerationConfig(gemini, request).topK = injectedTopK;

  const lowerModel = model.toLowerCase();
  const isGemini3 = lowerModel.includes('gemini-3');
  const isGemini3Flash = isGemini3 && lowerModel.includes('flash');

  let thinkingBudget: number | undefined;
  let thinkingLevel: string | undefined;
  let includeThoughts: boolean | undefined;

  const extra = object(googleThinkingConfig ?? undefined);
  if (extra) {
    // Rust uses `.get(snake).or_else(|| .get(camel))`: a present snake_case key
    // stops the chain (even when its value cannot be cast); only an absent key
    // falls through to the camelCase spelling.
    const presentKey = (snake: string, camel: string): string => Object.hasOwn(extra, snake) ? snake : camel;
    const present = (snake: string, camel: string): JsonValue | undefined => extra[presentKey(snake, camel)];
    thinkingLevel = string(present('thinking_level', 'thinkingLevel'));
    const budget = i64At(extra, presentKey('thinking_budget', 'thinkingBudget'));
    if (budget !== undefined) thinkingBudget = clamp(budget, -1, 2147483647);
    includeThoughts = optionalBoolean(present('include_thoughts', 'includeThoughts'));
  }

  if (reasoningEffort !== undefined) {
    const effort = asciiLower(reasoningEffort);
    if (isGemini3) {
      let level: string;
      if ((effort === 'minimal' || effort === 'none' || effort === 'unset') && isGemini3Flash) level = 'minimal';
      else if (effort === 'low') level = 'low';
      else if (effort === 'medium') level = isGemini3Flash ? 'medium' : 'high';
      else if (effort === 'high') level = 'high';
      else level = 'low';
      thinkingLevel = level;
    } else {
      const budget = effort === 'minimal' ? 256
        : effort === 'low' ? 1024
          : effort === 'medium' ? 8192
            : effort === 'high' ? 24576
              : effort === 'none' || effort === 'unset' ? 0
                : undefined;
      if (thinkingBudget === undefined && budget !== undefined) thinkingBudget = clamp(budget, -1, 2147483647);
    }
  }

  if (thinkingBudget !== undefined || thinkingLevel !== undefined || includeThoughts !== undefined) {
    const thinkingConfig: JsonObject = {};
    if (!isGemini3 && thinkingBudget !== undefined) thinkingConfig.thinkingBudget = thinkingBudget;
    if (isGemini3 && thinkingLevel !== undefined) thinkingConfig.thinkingLevel = thinkingLevel;
    if (includeThoughts !== undefined) thinkingConfig.includeThoughts = includeThoughts;
    ensureGenerationConfig(gemini, request).thinkingConfig = thinkingConfig;
  }

  const isStream = request.stream ?? false;
  const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
  const query = isStream ? `alt=sse&key=${apiKey}` : `key=${apiKey}`;

  let resolvedVersion = apiVersion;
  const thinkingConfigPresent = gemini.generationConfig !== undefined
    && object(gemini.generationConfig.thinkingConfig) !== undefined;
  const requireV1beta = thinkingConfigPresent || systemInstructionPresent || isGemini3;

  if (requireV1beta) {
    if (resolvedVersion === undefined) resolvedVersion = 'v1beta';
    else if (resolvedVersion === 'v1') resolvedVersion = 'v1beta';
  }

  let baseRoot = baseUrl.replace(/\/+$/, '');
  let versionInBase: string | undefined;
  const lastSlash = baseRoot.lastIndexOf('/');
  if (lastSlash >= 0) {
    const lastSegment = baseRoot.slice(lastSlash + 1);
    const isVersionSegment = lastSegment.startsWith('v')
      && lastSegment.length > 1
      && /^[0-9]$/.test(lastSegment[1]!);
    if (isVersionSegment) {
      versionInBase = lastSegment;
      baseRoot = baseRoot.slice(0, lastSlash);
    }
  }

  const finalVersion = resolvedVersion ?? versionInBase ?? 'v1';
  const baseRootTrimmed = baseRoot.replace(/\/+$/, '');
  const baseWithVersion = baseRootTrimmed.endsWith('://') || baseRootTrimmed === ''
    ? `${baseRootTrimmed}${finalVersion}`
    : `${baseRootTrimmed}/${finalVersion}`;

  // v1 has no systemInstruction field: merge it into the first content part.
  if (finalVersion === 'v1' && gemini.systemInstruction !== undefined) {
    const mergedTexts = gemini.systemInstruction.parts
      .map(part => string(part.text))
      .filter((text): text is string => text !== undefined && rustTrim(text) !== '');
    if (mergedTexts.length) {
      const merged = mergedTexts.join('\n\n');
      const first = gemini.contents[0];
      if (first) first.parts.unshift(textPart(merged));
      else gemini.contents.push({ role: 'user', parts: [textPart(merged)] });
    }
    delete gemini.systemInstruction;
  }

  const url = `${baseWithVersion}/models/${model}:${endpoint}?${query}`;
  const headers: [string, string][] = [
    ['Content-Type', 'application/json'],
    ['x-goog-api-key', apiKey],
  ];

  const body: JsonObject = { contents: gemini.contents.map(contentToJson) };
  if (gemini.systemInstruction !== undefined) body.systemInstruction = contentToJson(gemini.systemInstruction);
  if (gemini.generationConfig !== undefined) body.generationConfig = gemini.generationConfig;
  if (gemini.tools !== undefined) body.tools = gemini.tools;
  if (gemini.toolConfig !== undefined) body.toolConfig = gemini.toolConfig;

  return { url, headers, body };
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
