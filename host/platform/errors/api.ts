/** Rust: dstu-core/src/models.rs:928–1084 and error_details.rs. All factories return plain IPC values. */
// AppError / CommandError live in the dependency-free kernel leaf so kernel code can use them
// without importing this file (which would close a kernel/api.ts ⇄ platform/errors cycle).
import type { JsonValue } from '../../kernel/error-model.ts';
export { AppError, AppErrorType, CommandError, errorDisplay, isAppErrorValue } from '../../kernel/error-model.ts';
export type { JsonValue } from '../../kernel/error-model.ts';
export { UNSUPPORTED_ON_PLATFORM, UNSUPPORTED_ON_PLATFORM_PREFIX, parseUnsupportedOnPlatform, unsupportedOnPlatformMessage } from './unsupported-on-platform.ts';
export { EXTERNAL_MCP_TOOL_PREFIX, EXTERNAL_MCP_DOTTED_TOOL_PREFIX, is_external_mcp_tool_name, strip_tool_namespace, with_localized_message, ensure_localized_error, coerce_json_array, get_json_array_arg, get_string_array_arg } from './tool-args.ts';

export type ErrorCode = 'CONFIG_MISSING' | 'CONFIG_INVALID' | 'API_KEY_MISSING' | 'API_KEY_INVALID'
  | 'NETWORK_UNREACHABLE' | 'NETWORK_TIMEOUT' | 'DNS_RESOLUTION_FAILED' | 'HTTP_CLIENT_ERROR'
  | 'HTTP_SERVER_ERROR' | 'HTTP_BAD_REQUEST' | 'HTTP_UNAUTHORIZED' | 'HTTP_FORBIDDEN' | 'HTTP_NOT_FOUND'
  | 'HTTP_TOO_MANY_REQUESTS' | 'SERVICE_UNAVAILABLE' | 'RATE_LIMIT' | 'QUOTA_EXCEEDED' | 'PARSE_ERROR'
  | 'VALIDATION_ERROR' | 'FORMAT_ERROR' | 'TOOL_NOT_FOUND' | 'TOOL_DISABLED' | 'TOOL_TIMEOUT' | 'INTERNAL_ERROR' | 'UNKNOWN';
export interface ActionSuggestion { action_type: string; label: string; url: string | null; data: JsonValue }
export interface ErrorDetails {
  code: ErrorCode; message: string; user_message: string; suggestions: ActionSuggestion[];
  trace_id: string | null; context: Record<string, JsonValue> | null;
}
export const ErrorDetails = {
  new(code: ErrorCode, message: string, user_message: string): ErrorDetails {
    return { code, message, user_message, suggestions: [], trace_id: null, context: null };
  },
  with_suggestion(error: ErrorDetails, suggestion: ActionSuggestion): ErrorDetails {
    return { ...error, suggestions: [...error.suggestions, suggestion] };
  },
  with_trace_id(error: ErrorDetails, trace_id: string): ErrorDetails { return { ...error, trace_id }; },
  with_context(error: ErrorDetails, key: string, value: JsonValue): ErrorDetails {
    return { ...error, context: { ...error.context, [key]: value } };
  },
};
/** Rust CommandError envelope; distinct from kernel CommandError, which throws an IPC value. */
export interface CommandErrorEnvelope { code: string; message: string; data?: JsonValue; traceId?: string }
export const CommandErrorEnvelope = {
  new(code: string, message: string): CommandErrorEnvelope { return { code, message }; },
  internal(message: string): CommandErrorEnvelope { return { code: 'INTERNAL_ERROR', message }; },
  with_data(error: CommandErrorEnvelope, data: JsonValue): CommandErrorEnvelope { return { ...error, data }; },
  with_trace_id(error: CommandErrorEnvelope, traceId: string): CommandErrorEnvelope { return { ...error, traceId }; },
  from(details: ErrorDetails): CommandErrorEnvelope {
    return { code: details.code, message: details.message,
      ...(details.context === null ? {} : { data: details.context }),
      ...(details.trace_id === null ? {} : { traceId: details.trace_id }) };
  },
};
const suggestion = (action_type: string, label: string, url: string | null = null, data: JsonValue = null): ActionSuggestion => ({ action_type, label, url, data });
const detailed = (code: ErrorCode, message: string, user_message: string, suggestions: ActionSuggestion[]): ErrorDetails => ({ ...ErrorDetails.new(code, message, user_message), suggestions });
export const ErrorDetailsBuilder = {
  api_key_missing: (service: string) => detailed('API_KEY_MISSING', `${service} API key is not configured`, `Configure the ${service} API key in Settings before using this feature`, [suggestion('settings', 'Open Settings', '#/settings', { section: service.toLowerCase() })]),
  api_key_invalid: (service: string) => detailed('API_KEY_INVALID', `${service} API密钥无效或已过期`, `${service}的API密钥似乎无效，请检查密钥是否正确`, [suggestion('settings', '检查API密钥', '#/settings', { section: service.toLowerCase() }), suggestion('retry', '重试')]),
  network_error: (details: string) => detailed('NETWORK_UNREACHABLE', `网络连接失败: ${details}`, '网络连接出现问题，请检查网络连接后重试', [suggestion('check_network', '检查网络'), suggestion('retry', '重试')]),
  rate_limit_error(service: string, retry_after: number | null): ErrorDetails {
    const error = detailed('RATE_LIMIT', `${service} 限流`, retry_after === null ? `${service}请求过于频繁，请稍后重试` : `${service}请求过于频繁，请等待${retry_after}秒后重试`, [suggestion('retry', '稍后重试', null, retry_after === null ? null : { retry_after })]);
    return retry_after === null ? error : ErrorDetails.with_context(error, 'retry_after_seconds', retry_after);
  },
  service_unavailable: (service: string) => detailed('SERVICE_UNAVAILABLE', `${service} 服务当前不可用`, `${service}服务暂时不可用，可能正在维护中`, [suggestion('retry', '稍后重试'), suggestion('contact_support', '联系支持', null, { service })]),
  tool_not_found: (tool: string) => detailed('TOOL_NOT_FOUND', `工具 '${tool}' 不存在`, `请求的工具'${tool}'未找到，可能已被移除或重命名`, [suggestion('settings', '查看可用工具', '#/settings/tools')]),
  tool_timeout: (tool: string, timeout_ms: number) => ErrorDetails.with_context(detailed('TOOL_TIMEOUT', `工具 '${tool}' 执行超时`, `工具执行时间超过${timeout_ms}毫秒限制`, [suggestion('retry', '重试')]), 'timeout_ms', timeout_ms),
  parse_error: (content_type: string, details: string) => detailed('PARSE_ERROR', `解析${content_type}失败: ${details}`, '服务返回的数据格式异常，无法正确解析', [suggestion('retry', '重试'), suggestion('contact_support', '报告问题', null, { error_type: 'parse_error', content_type })]),
};
export function http_status_to_error_code(status: number): ErrorCode {
  const special: Record<number, ErrorCode> = { 400: 'HTTP_BAD_REQUEST', 401: 'HTTP_UNAUTHORIZED', 403: 'HTTP_FORBIDDEN', 404: 'HTTP_NOT_FOUND', 429: 'HTTP_TOO_MANY_REQUESTS' };
  return special[status] ?? (status >= 400 && status <= 499 ? 'HTTP_CLIENT_ERROR' : status >= 500 && status <= 599 ? 'HTTP_SERVER_ERROR' : 'UNKNOWN');
}
export function infer_error_code_from_message(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('api key') || lower.includes('api_key')) return lower.includes('missing') || lower.includes('not found') ? 'API_KEY_MISSING' : 'API_KEY_INVALID';
  if (lower.includes('timeout')) return 'NETWORK_TIMEOUT';
  if (lower.includes('network') || lower.includes('connection')) return 'NETWORK_UNREACHABLE';
  if (lower.includes('rate limit') || lower.includes('too many requests')) return 'RATE_LIMIT';
  if (lower.includes('quota')) return 'QUOTA_EXCEEDED';
  if (lower.includes('parse') || lower.includes('json')) return 'PARSE_ERROR';
  if (lower.includes('not found')) return 'TOOL_NOT_FOUND';
  if (lower.includes('disabled')) return 'TOOL_DISABLED';
  return 'UNKNOWN';
}
