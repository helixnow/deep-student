import type { JsonValue } from './api.ts';
import { rustTrim } from '../util/portable.ts';
import { localizedErrorJson } from './localized-error-json.ts';

export const EXTERNAL_MCP_TOOL_PREFIX = 'mcp_';
export const EXTERNAL_MCP_DOTTED_TOOL_PREFIX = 'mcp.tools.';
export function is_external_mcp_tool_name(name: string): boolean { return name.startsWith(EXTERNAL_MCP_TOOL_PREFIX) || name.startsWith(EXTERNAL_MCP_DOTTED_TOOL_PREFIX); }
export function strip_tool_namespace(name: string): string {
  return name.startsWith('builtin-') ? name.slice(8) : name.startsWith('mcp_') ? name.slice(4) : name;
}
function object(value: JsonValue | undefined): value is Record<string, JsonValue> { return value !== undefined && value !== null && !Array.isArray(value) && typeof value === 'object'; }
export function with_localized_message(payload: JsonValue, message_key: string, message_params: JsonValue, zh_cn: string, en_us: string): Record<string, JsonValue> {
  if (!object(payload)) throw new Error('localized tool message payload must be an object');
  return { ...payload, messageKey: message_key, messageParams: message_params, messageFallback: { 'zh-CN': zh_cn, 'en-US': en_us }, message: `${zh_cn} / ${en_us}` };
}
export function ensure_localized_error(raw: string, default_code: string, message_key: string, zh_cn: string, en_us: string): string {
  return localizedErrorJson(raw, default_code, message_key, zh_cn, en_us);
}
export function coerce_json_array(value: JsonValue): JsonValue[] | null {
  if (Array.isArray(value)) return structuredClone(value);
  if (typeof value !== 'string') return null;
  try { const parsed: unknown = JSON.parse(rustTrim(value)); return Array.isArray(parsed) ? parsed as JsonValue[] : null; } catch { return null; }
}
export function get_json_array_arg(args: JsonValue, key: string): JsonValue[] | null { return object(args) && Object.hasOwn(args, key) ? coerce_json_array(args[key]!) : null; }
export function get_string_array_arg(args: JsonValue, key: string): string[] | null { return get_json_array_arg(args, key)?.filter((value): value is string => typeof value === 'string') ?? null; }
