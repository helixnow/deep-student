/**
 * 工具调用转换与历史合并（`dstu-llm/src/llm_manager/mod.rs` 5009–5125、
 * 8288–8547）。
 *
 * `convertOpenaiToolCall` 对应 `LLMManager::convert_openai_tool_call`：兼容
 * OpenAI 的 `{id,type,function:{name,arguments}}` 与本项目内部的
 * `{id,tool_name,args_json}` 两种形态；空/空白 arguments 视为无参调用；
 * 作者工具（qbank 写入）的截断 JSON 绝不修复，直接报
 * `INCOMPLETE_TOOL_ARGUMENTS`。
 *
 * `mergeConsecutiveToolCalls` 对应 `LLMManager::merge_consecutive_tool_calls`：
 * 把连续的单工具调用 assistant 消息合并为一个 `tool_calls` 数组，并在新一轮
 * reasoning 出现时切分轮次，保留 thinking/签名/Responses reasoning item。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim, rustTrimEnd, utf8ByteLength } from '../../../platform/util/portable.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';

export interface ToolCall {
  id: string;
  toolName: string;
  argsJson: JsonValue;
}

/** `convert_openai_tool_call` 的返回值（`crate::models::ToolCall`）。 */
export interface ConvertedOpenAiToolCall {
  toolCallId: string;
  toolName: string;
  argsJson: JsonValue;
}

export interface ToolCallMessage {
  role: string;
  content: string;
  thinkingContent?: string | null;
  thoughtSignature?: string | null;
  toolCall?: ToolCall | null;
  metadata?: { [key: string]: JsonValue } | null;
}

export type MergedChatMessage =
  | { kind: 'regular'; message: ToolCallMessage }
  | {
    kind: 'mergedToolCalls';
    toolCalls: ToolCall[];
    content: string;
    thinkingContent: string | null;
    thoughtSignature: string | null;
    responseReasoningItem: JsonValue | null;
  };

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// convert_openai_tool_call（mod.rs:8291）
// ---------------------------------------------------------------------------

const AUTHORING_TOOL_NAMES = new Set([
  'qbank_batch_import',
  'qbank_import_document',
  'qbank_commit_authoring_draft',
]);

/** Rust `trim_start_matches("builtin-")`：去掉所有前导 `builtin-`。 */
function stripBuiltinNamespace(toolName: string): string {
  return toolName.replace(/^(?:builtin-)+/, '');
}

type ParsedJson =
  | { ok: true; value: JsonValue }
  | { ok: false; error: unknown };

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 旧内部格式（serde `ToolCall`）优先直读，保持与 Rust 一致。 */
function readInternalToolCall(record: { [key: string]: JsonValue }): ConvertedOpenAiToolCall | null {
  const id = record.id;
  const toolName = record.tool_name;
  if (typeof id !== 'string' || typeof toolName !== 'string') return null;
  if (!Object.hasOwn(record, 'args_json')) return null;
  return { toolCallId: id, toolName, argsJson: record.args_json as JsonValue };
}

function toolCallArguments(record: { [key: string]: JsonValue }): ConvertedOpenAiToolCall {
  const id = record.id;
  if (typeof id !== 'string') throw new Error("Missing 'id' field");

  const functionValue = record.function;
  if (functionValue === undefined || !Object.hasOwn(record, 'function')) {
    throw new Error("Missing 'function' field");
  }
  const fn = isJsonObject(functionValue) ? functionValue : null;
  const rawName = fn !== null ? fn.name : undefined;
  if (typeof rawName !== 'string') throw new Error("Missing 'function.name' field");
  const toolName = rawName;

  const rawArguments = fn !== null ? fn.arguments : undefined;
  if (fn === null || !Object.hasOwn(fn, 'arguments')) {
    throw new Error("Missing 'function.arguments' field");
  }

  // 某些 OpenAI 兼容 API 的 arguments 已是 JSON 对象/数组：直接使用。
  if (typeof rawArguments !== 'string') {
    if (rawArguments !== null && typeof rawArguments === 'object') {
      logDebug(`[llm_manager] convert_openai_tool_call: arguments 已是 JSON 值 (tool=${toolName})`);
      return { toolCallId: id, toolName, argsJson: rawArguments };
    }
    // null 或其他标量类型 → 空对象。
    return { toolCallId: id, toolName, argsJson: {} };
  }

  // 兼容无参工具调用：空串/空白串不是截断错误，按空对象处理。
  if (rustTrim(rawArguments) === '') {
    return { toolCallId: id, toolName, argsJson: {} };
  }

  const parsed = parseJson(rawArguments);
  if (parsed.ok === true) return { toolCallId: id, toolName, argsJson: parsed.value };

  const error = errorMessage(parsed.error);
  // 作者写入绝不接受被修复的前缀：可能缺 materials 或子题目。
  if (AUTHORING_TOOL_NAMES.has(stripBuiltinNamespace(toolName))) {
    throw new Error(
      `INCOMPLETE_TOOL_ARGUMENTS: ${toolName} JSON is incomplete or invalid; `
      + `no questions were written. Retry with a complete material/group boundary `
      + `or the saved draft job_id: ${error}`,
    );
  }

  const lowered = error.toLowerCase();
  // V8 用 "Unexpected end of JSON input" / "Unterminated string" 表达 serde
  // 的 EOF 类错误（输出被 max_tokens 截断）。
  const truncated = lowered.includes('eof')
    || lowered.includes('unexpected end')
    || lowered.includes('trailing')
    || lowered.includes('unterminated string')
    || lowered.includes('unexpected non-whitespace character after json')
    || Number(/at position (\d+)/.exec(error)?.[1]) === rawArguments.length;
  if (truncated) {
    logWarn(`[llm_manager] 工具调用 JSON 疑似被截断 (len=${utf8ByteLength(rawArguments)}), 尝试修复...`);
    const repaired = tryRepairTruncatedJson(rawArguments);
    if (repaired !== null) {
      logInfo(`[llm_manager] 截断 JSON 修复成功: tool=${toolName}, original_len=${utf8ByteLength(rawArguments)}, repaired_len=${utf8ByteLength(JSON.stringify(repaired))}`);
      return { toolCallId: id, toolName, argsJson: repaired };
    }
    throw new Error(`Failed to parse arguments JSON (truncated, repair failed): ${error}`);
  }
  throw new Error(`Failed to parse arguments JSON: ${error}`);
}

/**
 * `LLMManager::convert_openai_tool_call`：OpenAI 工具调用 → 内部 ToolCall。
 * 失败时抛出带原因的 Error（作者工具的截断参数以 `INCOMPLETE_TOOL_ARGUMENTS`
 * 开头）。
 */
export function convertOpenaiToolCall(value: JsonValue): ConvertedOpenAiToolCall {
  if (isJsonObject(value)) {
    const internal = readInternalToolCall(value);
    if (internal !== null) return internal;
    return toolCallArguments(value);
  }
  throw new Error("Missing 'id' field");
}

// ---------------------------------------------------------------------------
// 截断 JSON 修复（mod.rs:8418-8547）
// ---------------------------------------------------------------------------

/** 策略 1：忽略字符串内部括号，补全缺失的 `}` / `]`。 */
function repairByBracketCompletion(source: string): JsonValue | null {
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (const ch of source) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }

  if (stack.length === 0) {
    const parsed = parseJson(source);
    return parsed.ok ? parsed.value : null;
  }

  let repaired = source;
  // 截断在字符串内部：先闭合字符串。
  if (inString) repaired += '"';

  // 去掉末尾悬挂的逗号/冒号（可能是不完整的 key/value）。
  const trimmed = rustTrimEnd(repaired);
  const lastChar = trimmed.slice(-1);
  if (lastChar === ',' || lastChar === ':') repaired = trimmed.slice(0, -1);

  // 逆序闭合未完成的括号。
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const bracket = stack[index];
    if (bracket === '{') repaired += '}';
    else if (bracket === '[') repaired += ']';
  }

  const parsed = parseJson(repaired);
  return parsed.ok ? parsed.value : null;
}

/** 策略 2：回退到最后一个完整边界（`,`/`}`/`]`/换行）后再补括号。 */
function repairByTruncationRollback(source: string): JsonValue | null {
  for (const target of [',', '}', ']', '\n']) {
    const position = source.lastIndexOf(target);
    if (position < 0) continue;
    const candidate = target === ','
      ? source.slice(0, position)
      : source.slice(0, position + 1);
    const repaired = repairByBracketCompletion(candidate);
    if (repaired !== null) return repaired;
  }
  return null;
}

function tryRepairTruncatedJson(truncated: string): JsonValue | null {
  const source = rustTrim(truncated);
  if (source === '') return null;
  const bracketCompleted = repairByBracketCompletion(source);
  if (bracketCompleted !== null) return bracketCompleted;
  const rollback = repairByTruncationRollback(source);
  if (rollback === null) logWarn(`[llm_manager] 截断 JSON 修复失败，所有策略均未成功 (len=${utf8ByteLength(source)})`);
  return rollback;
}

// ---------------------------------------------------------------------------
// merge_consecutive_tool_calls（mod.rs:5009）
// ---------------------------------------------------------------------------

/** serde_json::Value 的深比较（对象键顺序无关）。 */
function jsonEqual(left: JsonValue | null, right: JsonValue | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index] ?? null));
  }
  if (typeof left === 'object' || typeof right === 'object') {
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key)
      && jsonEqual(left[key] ?? null, right[key] ?? null));
  }
  return false;
}

function responseReasoningItemOf(message: ToolCallMessage): JsonValue | null {
  const metadata = message.metadata;
  if (metadata === null || metadata === undefined) return null;
  const item = metadata.openai_responses_reasoning_item;
  if (!isJsonObject(item) || item.type !== 'reasoning') return null;
  return structuredClone(item);
}

/**
 * `LLMManager::merge_consecutive_tool_calls`：连续的工具调用消息合并为
 * `tool_calls` 数组；遇到新一轮 reasoning（含空字符串）或不同的 Responses
 * reasoning item 时先刷新上一组，工具结果消息紧跟在该组之后。
 */
export function mergeConsecutiveToolCalls(history: readonly ToolCallMessage[]): MergedChatMessage[] {
  const result: MergedChatMessage[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let pendingToolResults: ToolCallMessage[] = [];
  let currentContent = '';
  let currentThinkingContent: string | null = null;
  let currentThoughtSignature: string | null = null;
  let currentResponseReasoningItem: JsonValue | null = null;

  const flush = (): void => {
    if (pendingToolCalls.length === 0) return;
    result.push({
      kind: 'mergedToolCalls',
      toolCalls: pendingToolCalls,
      content: currentContent,
      thinkingContent: currentThinkingContent,
      thoughtSignature: currentThoughtSignature,
      responseReasoningItem: currentResponseReasoningItem,
    });
    pendingToolCalls = [];
    currentContent = '';
    currentThinkingContent = null;
    currentThoughtSignature = null;
    currentResponseReasoningItem = null;
    for (const toolResult of pendingToolResults) {
      result.push({ kind: 'regular', message: toolResult });
    }
    pendingToolResults = [];
  };

  for (const message of history) {
    if (message.role === 'assistant' && message.toolCall !== null && message.toolCall !== undefined) {
      const toolCall = message.toolCall;

      // 多轮边界：新的 reasoning 文本（包括空字符串）或不同的 Responses
      // reasoning item 都表示新的一轮；同一轮的并行调用可能把两半拆在不同
      // 消息里，因此只有「同种字段再次出现」才算新轮。
      const hasNewReasoning = message.thinkingContent !== null && message.thinkingContent !== undefined;
      const responseReasoningItem = responseReasoningItemOf(message);
      const hasNewReasoningRound = hasNewReasoning && currentThinkingContent !== null;
      const hasNewResponseReasoning = responseReasoningItem !== null
        && currentResponseReasoningItem !== null
        && !jsonEqual(currentResponseReasoningItem, responseReasoningItem);

      if (hasNewReasoningRound || hasNewResponseReasoning) flush();

      pendingToolCalls.push(toolCall);

      if (currentContent === '' && message.content !== '') currentContent = message.content;

      if (currentThinkingContent === null && hasNewReasoning) {
        currentThinkingContent = message.thinkingContent ?? null;
      }
      if (currentThoughtSignature === null) {
        currentThoughtSignature = message.thoughtSignature ?? null;
      }
      if (currentResponseReasoningItem === null) {
        currentResponseReasoningItem = responseReasoningItem;
      }
    } else if (message.role === 'tool') {
      pendingToolResults.push(message);
    } else {
      flush();
      result.push({ kind: 'regular', message });
    }
  }

  flush();
  return result;
}
