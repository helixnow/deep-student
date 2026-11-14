/**
 * 流式终止/失败校验与 SSE 事件缓冲（model2_pipeline.rs
 * provider_stream_failure_* / validate_stream_* / process_sse_stream_input +
 * dstu-util utils/sse_buffer.rs SseEventBuffer）。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { SseEventBuffer } from '../../../platform/util/portable.ts';
export { SseEventBuffer } from '../../../platform/util/portable.ts';
import {
  LLM_ERROR_CODE_EMPTY_RESPONSE, attachLlmErrorCode,
} from './routing.ts';

type JsonObject = { [key: string]: JsonValue };

export const PROVIDER_STREAM_ERROR_DETAIL_MAX_CHARS = 200;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function pointer(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const object = asObject(current);
    if (object === null) return undefined;
    current = object[key];
  }
  return current;
}

export function providerStreamErrorDetail(value: unknown): string | null {
  const raw = scalarText(pointer(value, 'details', 'message'))
    ?? scalarText(pointer(value, 'details', 'error', 'message'))
    ?? scalarText(asObject(value)?.details)
    ?? scalarText(asObject(value)?.message)
    ?? scalarText(pointer(value, 'error', 'message'));
  if (raw === null) return null;
  const collapsed = raw.split(/\s+/).filter((part) => part !== '').join(' ');
  if (collapsed === '') return null;
  const chars = [...collapsed];
  return chars.length > PROVIDER_STREAM_ERROR_DETAIL_MAX_CHARS
    ? `${chars.slice(0, PROVIDER_STREAM_ERROR_DETAIL_MAX_CHARS).join('')}...`
    : collapsed;
}

function providerStreamFailureClassification(prefix: string, reason: string): string | null {
  switch (reason) {
    case 'max_output_tokens':
    case 'max_tokens':
      return `${prefix}（达到模型输出上限）；已保留已生成内容，可重试或发送“继续”`;
    case 'response.cancelled':
    case 'response.canceled':
    case 'cancelled':
    case 'canceled':
      return `${prefix}（上游取消）；已保留已生成内容，可重试`;
    case 'content_filter':
    case 'safety':
      return `${prefix}（内容安全策略中止）；已保留已生成内容`;
    default:
      return reason.startsWith('response.incomplete')
        ? `${prefix}；已保留已生成内容，可重试或发送“继续”`
        : null;
  }
}

export function providerStreamFailureMessage(
  value: unknown,
  requiresExplicitCompletion: boolean,
  isCodex: boolean,
): string {
  const terminalReason = scalarText(asObject(value)?.reason);
  if (asObject(value)?.type === 'safety_error' && terminalReason === 'content_filter') {
    const explanation = providerStreamErrorDetail(value);
    return explanation === null ? 'DeepSeek 内容安全审核未通过，未显示回复' : `DeepSeek 内容安全审核未通过：${explanation}`;
  }
  const detailReason = scalarText(pointer(value, 'details', 'reason'))
    ?? scalarText(pointer(value, 'details', 'code'));
  const prefix = isCodex
    ? 'OpenAI Codex 回复未完整结束'
    : requiresExplicitCompletion
      ? 'OpenAI Responses 回复未完整结束'
      : '模型回复未完整结束';

  const classified = (detailReason === null
    ? null : providerStreamFailureClassification(prefix, detailReason))
    ?? (terminalReason === null
      ? null : providerStreamFailureClassification(prefix, terminalReason))
    ?? `${prefix}；已保留已生成内容，可重试`;

  const detail = providerStreamErrorDetail(value);
  return detail === null ? classified : `${classified}；上游返回：${detail}`;
}

export type ResponsesStreamInterruption = 'idle_timeout' | 'read_error' | 'missing_terminal';

export function responsesStreamInterruptionMessage(
  interruption: ResponsesStreamInterruption,
  isCodex: boolean,
): string {
  const provider = isCodex ? 'OpenAI Codex' : 'LLM provider';
  switch (interruption) {
    case 'idle_timeout':
      return `${provider} 回复流长时间无数据，已保留已生成内容，可重试`;
    case 'read_error':
      return `${provider} 回复流读取中断；已保留已生成内容，可重试`;
    case 'missing_terminal':
      return `${provider} 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试`;
  }
}

/** 终止校验：供应商失败优先于显式 Done。 */
export function validateStreamTermination(
  requireTerminalSuccess: boolean,
  terminalSuccess: boolean,
  terminalFailure: string | null,
  isCodex: boolean,
): AppError | null {
  if (terminalFailure !== null) return AppError.llm(terminalFailure);
  if (requireTerminalSuccess && !terminalSuccess) {
    return AppError.llm(responsesStreamInterruptionMessage('missing_terminal', isCodex));
  }
  return null;
}

/** 空响应（无正文/思考/工具调用）标记为可重试。 */
export function validateStreamPayload(
  wasCancelled: boolean,
  content: string,
  reasoning: string,
  toolCallCount: number,
): AppError | null {
  if (!wasCancelled && content === '' && reasoning === '' && toolCallCount === 0) {
    return attachLlmErrorCode(AppError.llm('模型返回空响应，请重试'), LLM_ERROR_CODE_EMPTY_RESPONSE);
  }
  return null;
}

/** RawPromptOptions（gpt-* JSON 模式默认开启，标题类任务显式关思考）。 */
export interface RawPromptOptions {
  forceJson: boolean;
  disableThinking: boolean;
}

export const DEFAULT_RAW_PROMPT_OPTIONS: RawPromptOptions = {
  forceJson: true,
  disableThinking: false,
};

export function rawPromptThinkingOverride(options: RawPromptOptions): boolean | null {
  return options.disableThinking ? false : null;
}

/** 处理一块网络字节（None 等价 flush）并返回完整事件块。 */
export function processSseStreamInput(
  buffer: SseEventBuffer,
  chunk: Uint8Array | null,
): string[] {
  return chunk === null ? buffer.flush() : buffer.processBytes(chunk);
}
