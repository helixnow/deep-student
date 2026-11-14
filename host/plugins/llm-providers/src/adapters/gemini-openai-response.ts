/** adapters/gemini-openai-converter.rs response half: stream lines and non-stream responses back to OpenAI shape. */
import type { JsonObject, JsonValue, StreamEvent } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { extractStreamDataPayload } from '../../../../platform/util/portable.ts';
import { array, fieldI64, i32At, i64At, object, parseJson, string } from '../json.ts';
import { AdapterError, asciiLower, compactJson } from './gemini-openai-common.ts';

/** adapters/gemini-openai-converter.rs:1668 `map_gemini_finish_reason`. */
function mapGeminiFinishReason(reason: string): string {
  switch (reason) {
    case 'STOP':
    case 'STOP_REASON_UNSPECIFIED':
    case 'FINISH_REASON_UNSPECIFIED':
    case 'OTHER':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'TOOL_CALL_REQUIRED':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

// ==================== 流式解析 ====================

export interface GeminiPendingToolCall {
  id: string;
  name: string;
}

/** adapters/gemini-openai-converter.rs:1235 `extract_thought_texts`. */
function extractThoughtTexts(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(extractThoughtTexts);
  const map = object(value);
  if (!map) return [];
  const out: string[] = [];
  const text = string(map.text);
  if (text !== undefined) out.push(text);
  if (map.content !== undefined) out.push(...extractThoughtTexts(map.content));
  for (const part of array(map.parts) ?? []) out.push(...extractThoughtTexts(part));
  if (map.data !== undefined) out.push(...extractThoughtTexts(map.data));
  return out;
}

function isThoughtPart(part: JsonValue, allowNonBool: boolean): boolean {
  const thought = fieldOf(part, 'thought');
  let isThought = false;
  if (allowNonBool) {
    if (typeof thought === 'boolean') isThought = thought;
    else if (typeof thought === 'string') isThought = rustTrim(thought) !== '';
    else {
      const thoughtObject = object(thought);
      // Rust `obj.get("value").and_then(as_bool).unwrap_or(true)`: a missing or
      // non-boolean `value` still counts as a thought object.
      if (thoughtObject) isThought = thoughtObject.value !== false;
    }
  } else {
    isThought = thought === true;
  }
  if (!isThought) {
    const metadata = object(fieldOf(part, 'metadata'));
    if (metadata) {
      if (asciiLower(string(metadata.type) ?? '') === 'thought') isThought = true;
      if (metadata.isThought === true) isThought = true;
    }
  }
  if (!isThought) {
    const kind = string(fieldOf(part, 'kind'));
    if (kind !== undefined && asciiLower(kind) === 'thought') isThought = true;
  }
  if (!isThought) {
    const partType = string(fieldOf(part, 'type'));
    if (partType !== undefined && asciiLower(partType) === 'thought') isThought = true;
  }
  return isThought;
}

function fieldOf(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return object(value)?.[key];
}

function pushThoughtParts(part: JsonValue, events: StreamEvent[]): void {
  const extracted = extractThoughtTexts(part);
  if (extracted.length === 0) {
    const text = string(fieldOf(part, 'text'));
    if (text !== undefined && text !== '') events.push({ type: 'ReasoningChunk', value: text });
    return;
  }
  for (const item of extracted) {
    if (item !== '') events.push({ type: 'ReasoningChunk', value: item });
  }
}

function pushToolCall(
  part: JsonValue,
  pendingToolCalls: Map<number, GeminiPendingToolCall>,
  events: StreamEvent[],
): void {
  const functionCall = object(fieldOf(part, 'functionCall'));
  if (!functionCall) return;
  const name = string(functionCall.name);
  if (name === undefined) return;
  const args = functionCall.args === undefined ? {} : functionCall.args;
  const argsText = compactJson(args);
  const rawNativeId = string(functionCall.id);
  const nativeId = rawNativeId === undefined || rustTrim(rawNativeId) === '' ? undefined : rawNativeId;

  // Gemini part positions restart in each chunk; only a native call ID can
  // identify a previously seen call across chunks.
  const existing = nativeId === undefined ? undefined
    : [...pendingToolCalls].find(([, call]) => call.id === nativeId);
  const callIndex = existing?.[0] ?? pendingToolCalls.size;
  let entry = existing?.[1];
  if (!entry) {
    entry = { id: nativeId ?? `call-${crypto.randomUUID()}`, name };
    pendingToolCalls.set(callIndex, entry);
  }

  events.push({
    type: 'ToolCall',
    value: {
      id: entry.id,
      type: 'function',
      function: { name: entry.name, arguments: argsText },
      index: callIndex,
    },
  });
}

function pushCandidateThoughts(items: JsonValue[], events: StreamEvent[]): void {
  for (const item of items) {
    const text = string(fieldOf(item, 'text'))
      ?? string(fieldOf(item, 'content'))
      ?? (typeof item === 'string' ? item : undefined);
    if (text !== undefined && text !== '') events.push({ type: 'ReasoningChunk', value: text });
  }
}

/** adapters/gemini-openai-converter.rs:741 `parse_gemini_stream_line`. */
export function parseGeminiStreamLine(line: string, pendingToolCalls: Map<number, GeminiPendingToolCall>): StreamEvent[] {
  const events: StreamEvent[] = [];
  const data = extractStreamDataPayload(line);
  if (data === null) return events;
  if (rustTrim(data) === '[DONE]') {
    pendingToolCalls.clear();
    return [{ type: 'Done' }];
  }
  const payload = parseJson(data);
  if (payload === undefined) return events;

  const candidates = array(fieldOf(payload, 'candidates'));
  const candidate = candidates?.[0];
  if (candidate !== undefined) {
    const content = fieldOf(candidate, 'content');
    const parts = array(fieldOf(content, 'parts'));
    if (parts) {
      for (let idx = 0; idx < parts.length; idx += 1) {
        const part = parts[idx]!;
        if (isThoughtPart(part, true)) {
          pushThoughtParts(part, events);
        } else {
          const text = string(fieldOf(part, 'text'));
          if (text !== undefined && text !== '') events.push({ type: 'ContentChunk', value: text });
        }

        for (const item of array(fieldOf(part, 'thoughts')) ?? []) {
          for (const chunk of extractThoughtTexts(item)) {
            if (chunk !== '') events.push({ type: 'ReasoningChunk', value: chunk });
          }
        }

        const signature = string(fieldOf(part, 'thoughtSignature'));
        if (signature !== undefined && signature !== '') events.push({ type: 'ThoughtSignature', value: signature });

        pushToolCall(part, pendingToolCalls, events);
      }
    }

    pushCandidateThoughts(array(fieldOf(candidate, 'thoughts')) ?? [], events);

    const candidateSignature = string(fieldOf(candidate, 'thoughtSignature'));
    if (candidateSignature !== undefined && candidateSignature !== '') {
      events.push({ type: 'ThoughtSignature', value: candidateSignature });
    }

    const deltaParts = array(fieldOf(fieldOf(candidate, 'delta'), 'parts'));
    if (deltaParts) {
      for (let idx = 0; idx < deltaParts.length; idx += 1) {
        const part = deltaParts[idx]!;
        if (isThoughtPart(part, false)) {
          pushThoughtParts(part, events);
          continue;
        }
        const text = string(fieldOf(part, 'text'));
        if (text !== undefined && text !== '') events.push({ type: 'ContentChunk', value: text });
        for (const item of array(fieldOf(part, 'thoughts')) ?? []) {
          const extracted = extractThoughtTexts(item);
          if (extracted.length === 0) {
            const fallback = string(fieldOf(item, 'text')) ?? string(fieldOf(item, 'content'));
            if (fallback !== undefined && fallback !== '') events.push({ type: 'ReasoningChunk', value: fallback });
          } else {
            for (const entry of extracted) {
              if (entry !== '') events.push({ type: 'ReasoningChunk', value: entry });
            }
          }
        }
        pushToolCall(part, pendingToolCalls, events);
      }
    }
  }

  pushCandidateThoughts(array(fieldOf(payload, 'thoughts')) ?? [], events);

  const usageMetadata = fieldOf(payload, 'usageMetadata');
  if (usageMetadata !== undefined) {
    const usage = object(usageMetadata);
    // gemini-openai-converter.rs:1107-1133: i64 reads, i64 total fallback, then `as i32` for the three counts.
    const prompt = fieldI64(usage, 'promptTokenCount') ?? 0n;
    const completion = fieldI64(usage, 'candidatesTokenCount') ?? 0n;
    const total = fieldI64(usage, 'totalTokenCount') ?? BigInt.asIntN(64, prompt + completion);
    const promptTokens = Number(BigInt.asIntN(32, prompt));
    const completionTokens = Number(BigInt.asIntN(32, completion));
    const totalTokens = Number(BigInt.asIntN(32, total));
    const thoughtsTokens = i64At(usage, 'thoughtsTokenCount');
    // Rust `or_else` stops at the first present key even when it is not an i64.
    const cachedKey = usage !== undefined && Object.hasOwn(usage, 'cachedContentTokenCount') ? 'cachedContentTokenCount' : 'cacheReadInputTokens';
    const cachedTokens = i64At(usage, cachedKey);

    const robustUsage: JsonObject = {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: totalTokens,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      original: usageMetadata,
    };
    if (thoughtsTokens !== undefined) {
      robustUsage.thoughtsTokenCount = thoughtsTokens;
      robustUsage.reasoning_tokens = thoughtsTokens;
    }
    if (cachedTokens !== undefined) {
      robustUsage.cachedContentTokenCount = cachedTokens;
      robustUsage.cached_tokens = cachedTokens;
    }
    events.push({ type: 'Usage', value: robustUsage });
  }

  const promptFeedback = object(fieldOf(payload, 'promptFeedback'));
  if (promptFeedback && promptFeedback.blockReason !== undefined) {
    events.push({
      type: 'SafetyBlocked',
      value: { type: 'prompt_blocked', reason: promptFeedback.blockReason, details: promptFeedback },
    });
  }

  for (const entry of candidates ?? []) {
    const finishReason = string(fieldOf(entry, 'finishReason'));
    if (finishReason === undefined || finishReason === 'STOP') continue;
    events.push({
      type: 'SafetyBlocked',
      value: {
        type: finishReason === 'SAFETY' ? 'content_blocked' : 'provider_error',
        reason: finishReason,
        safetyRatings: fieldOf(entry, 'safetyRatings') ?? null,
        details: entry,
      },
    });
  }

  if (string(fieldOf(candidate, 'finishReason')) === 'STOP') events.push({ type: 'Done' });

  if (events.length && events[events.length - 1]!.type === 'Done') pendingToolCalls.clear();
  return events;
}

// ==================== 非流式响应转换 ====================

/** adapters/gemini-openai-converter.rs:1300 `convert_gemini_nonstream_response_to_openai`. */
export function convertGeminiNonstreamResponseToOpenai(geminiJson: JsonValue, model: string): JsonValue {
  const promptFeedback = object(fieldOf(geminiJson, 'promptFeedback'));
  if (promptFeedback && promptFeedback.blockReason !== undefined) {
    throw new AdapterError('invalid_format', `Request blocked due to safety reasons: ${displayValue(promptFeedback.blockReason)}`);
  }

  const candidates = array(fieldOf(geminiJson, 'candidates'));
  if (!candidates) throw new AdapterError('invalid_format', 'Missing candidates in Gemini response');
  if (candidates.length === 0) throw new AdapterError('invalid_format', 'Empty candidates array');

  const choices: JsonValue[] = [];
  candidates.forEach((candidate, index) => {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: JsonValue[] = [];

    const content = fieldOf(candidate, 'content');
    for (const part of array(fieldOf(content, 'parts')) ?? []) {
      const isThought = fieldOf(part, 'thought') === true;
      const text = string(fieldOf(part, 'text'));
      if (text !== undefined) {
        if (isThought) reasoningParts.push(text);
        else textParts.push(text);
      }
      const functionCall = object(fieldOf(part, 'functionCall'));
      if (functionCall) {
        const name = string(functionCall.name);
        if (name !== undefined) {
          const args = functionCall.args === undefined ? {} : functionCall.args;
          const rawId = string(functionCall.id);
          const id = rawId === undefined || rustTrim(rawId) === '' ? `call-${crypto.randomUUID()}` : rawId;
          toolCalls.push({
            id,
            type: 'function',
            function: { name, arguments: compactJson(args) },
          });
        }
      }
    }

    const mainText = rustTrim(textParts.join('\n'));
    let reasoningTexts = reasoningParts;

    if (reasoningTexts.length === 0) {
      const fallback: string[] = [];
      const candidateThoughts = fieldOf(candidate, 'thoughts');
      if (candidateThoughts !== undefined) fallback.push(...extractThoughtTexts(candidateThoughts));
      if (fallback.length === 0) {
        const globalThoughts = fieldOf(geminiJson, 'thoughts');
        if (globalThoughts !== undefined) fallback.push(...extractThoughtTexts(globalThoughts));
      }
      reasoningTexts = fallback;
    }

    // Thought parts were separated above; matching words in the answer are not
    // duplicated thought content and must not be removed.
    const combinedReasoning = reasoningTexts
      .map(snippet => rustTrim(snippet))
      .filter(snippet => snippet !== '')
      .join('\n\n');

    const message: JsonObject = { role: 'assistant', content: mainText };
    if (combinedReasoning !== '') message.thinking_content = combinedReasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const finishReason = string(fieldOf(candidate, 'finishReason'));
    const finishReasonText = finishReason === undefined ? 'stop' : mapGeminiFinishReason(finishReason);

    choices.push({ index, message, finish_reason: finishReasonText });
  });

  let usage: JsonObject;
  const usageMetadata = object(fieldOf(geminiJson, 'usageMetadata'));
  if (usageMetadata) {
    // gemini-openai-converter.rs:1389-1411: every count is `as i32`; the total fallback sums in i64.
    const promptTokens = i32At(usageMetadata, 'promptTokenCount') ?? 0;
    const completionTokens = i32At(usageMetadata, 'candidatesTokenCount') ?? 0;
    const totalTokens = i32At(usageMetadata, 'totalTokenCount') ?? (promptTokens + completionTokens) | 0;
    const thoughtsTokens = i32At(usageMetadata, 'thoughtsTokenCount');
    const cachedKey = Object.hasOwn(usageMetadata, 'cachedContentTokenCount') ? 'cachedContentTokenCount' : 'cacheReadInputTokens';
    const cachedTokens = i32At(usageMetadata, cachedKey);
    usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
    if (thoughtsTokens !== undefined) usage.reasoning_tokens = thoughtsTokens;
    if (cachedTokens !== undefined) usage.cached_tokens = cachedTokens;
  } else {
    usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage,
  };
}

/** serde_json's Display for a Value: strings without quotes, everything else as JSON text. */
function displayValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
