/** 推理回传（model2_pipeline.rs attach_reasoning_passback_payload / V4 自检）。 */
import type { ApiConfig } from '../api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { PassbackPolicy } from './adapters/base.ts';
import { isOfficialDeepseekV4 } from './adapters/deepseek.ts';

type JsonObject = { [key: string]: JsonValue };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

export function attachReasoningPassbackPayload(
  assistantMsg: Record<string, unknown>,
  policy: PassbackPolicy,
  thinking: string,
): void {
  if (policy === 'deep_seek_style') {
    assistantMsg.reasoning_content = thinking;
  } else if (policy === 'reasoning_details') {
    assistantMsg.reasoning_details = [{ type: 'thinking', text: thinking }];
  }
}

/**
 * 官方 DeepSeek V4 thinking + tools 必须全量回传 reasoning_content；
 * 缺失的 assistant(tool_calls) 补空串占位（空串是合法回传）。
 */
export function ensureOfficialDeepseekV4ReasoningPassback(
  body: Record<string, unknown>,
  config: ApiConfig,
): number {
  if (!isOfficialDeepseekV4(config)) return 0;
  const thinking = asObject(body.thinking);
  if (thinking?.type === 'disabled') return 0;
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const messages = body.messages;
  if (!Array.isArray(messages)) return 0;
  let healed = 0;
  for (const message of messages) {
    const object = asObject(message);
    if (object === null) continue;
    const toolCalls = object.tool_calls;
    const isToolCallAssistant = object.role === 'assistant'
      && Array.isArray(toolCalls) && toolCalls.length > 0;
    if (!isToolCallAssistant) continue;
    if (typeof object.reasoning_content !== 'string') {
      object.reasoning_content = '';
      healed += 1;
    }
  }
  return healed;
}
