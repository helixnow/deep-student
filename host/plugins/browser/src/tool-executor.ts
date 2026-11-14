// Port of the pure classification/error helpers in src/chat_v2/tools/browser_executor.rs.
// Executing the tools needs the native browser service and stays unregistered.

import type { ToolConcurrency, ToolSensitivity } from '../../../kernel/agent-api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import type { BridgeError, JsonValue } from './command-result.ts';

export const BROWSER_TOOLS: readonly string[] = [
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_file_upload',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_close',
];

export const BROWSER_MUTATING_TOOLS: readonly string[] = [
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_file_upload',
  'browser_scroll',
  'browser_back',
  'browser_close',
];

export const BROWSER_PASSWORD_BLOCKED = 'BROWSER_PASSWORD_BLOCKED';
export const BROWSER_USER_TAKEOVER = 'USER_TAKEOVER';

export type RuntimeRootKind =
  | 'workspace' | 'authorized' | 'skill_package' | 'artifact' | 'temp' | 'host';

export interface AgentControlClaim {
  /** This call moved control from the user to the agent. */
  claimedFromUser: boolean;
  /** The user had explicitly taken over; this is the first post-cooldown operation. */
  reclaimedAfterUserTakeover: boolean;
}

function formatToolError(code: string, message: string): string {
  return `[${code}] ${message}`;
}

export function isBrowserTool(toolName: string): boolean {
  return BROWSER_TOOLS.includes(strip_tool_namespace(toolName));
}

export function browserToolSensitivity(toolName: string): ToolSensitivity {
  switch (strip_tool_namespace(toolName)) {
    case 'browser_open':
    case 'browser_file_upload':
      return 'high';
    case 'browser_navigate':
    case 'browser_click':
    case 'browser_type':
    case 'browser_close':
      return 'medium';
    default:
      return 'low';
  }
}

/** One shared session: never parallelise (avoids double clicks / duplicate typing). */
export function browserToolConcurrency(_toolName: string): ToolConcurrency {
  return 'serial';
}

export function isMutatingBrowserTool(toolName: string): boolean {
  return BROWSER_MUTATING_TOOLS.includes(strip_tool_namespace(toolName));
}

export function isUploadRootKind(kind: RuntimeRootKind): boolean {
  return kind === 'workspace' || kind === 'authorized' || kind === 'artifact';
}

export function mimeTypeForName(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? null : name.slice(dot + 1).toLowerCase();
  switch (extension) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'txt':
    case 'md': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function detailsObject(details: JsonValue | null): Record<string, JsonValue> | null {
  return details !== null && typeof details === 'object' && !Array.isArray(details) ? details : null;
}

function bridgeBlockedReason(error: BridgeError): string {
  if (error.kind !== 'Bridge') return '';
  const reason = detailsObject(error.details)?.reason;
  return typeof reason === 'string' ? reason : '';
}

/** Bridge `BLOCKED` + `password_field` may return without taking over the session. */
export function isPasswordBlockedBridgeError(error: BridgeError): boolean {
  if (error.kind !== 'Bridge') return false;
  return error.code.toLowerCase() === 'blocked'
    && (bridgeBlockedReason(error) === 'password_field'
      || error.message.toLowerCase().includes('password'));
}

/** `BrowserToolExecutor::map_bridge_err`: agent-facing structured bridge errors. */
export function mapBrowserToolBridgeError(error: BridgeError): string {
  if (error.kind === 'Bridge') {
    const reason = bridgeBlockedReason(error);
    if (error.code.toLowerCase() === 'blocked'
      && (reason === 'password_field' || error.message.toLowerCase().includes('password'))) {
      return formatToolError(
        BROWSER_PASSWORD_BLOCKED,
        '密码/OTP 输入框禁止 Agent 代填，请用户接管后自行输入',
      );
    }
    const mapped = error.code === 'STALE_REF' || error.code === 'STALE'
      ? 'BROWSER_STALE_REF'
      : error.code === 'NOT_FOUND' || error.code === 'REF_NOT_FOUND'
        ? 'BROWSER_REF_NOT_FOUND'
        : error.code === 'NOT_INTERACTABLE'
          ? 'BROWSER_NOT_INTERACTABLE'
          : error.code === 'NOT_READY'
            ? 'BROWSER_BRIDGE_NOT_READY'
            : error.code === 'BLOCKED' ? 'BROWSER_BLOCKED' : error.code;
    let message = `[${mapped}] ${error.message}`;
    if (error.details !== null) message += ` | details=${JSON.stringify(error.details)}`;
    return mapped.startsWith('BROWSER_') ? message : `[BROWSER_${mapped}] ${error.message}`;
  }
  switch (error.kind) {
    case 'Unsupported':
      return formatToolError('BROWSER_BRIDGE_UNSUPPORTED', error.message);
    case 'WebviewNotFound':
      return formatToolError('BROWSER_NO_CONTEXT', '浏览器内容窗不存在，请先 browser_open');
    case 'Timeout':
      return formatToolError('BROWSER_TIMEOUT', '浏览器桥调用超时');
    case 'Eval':
    case 'InvalidJson':
      return formatToolError('BROWSER_BRIDGE_ERROR', error.message);
    case 'ChannelClosed':
      return formatToolError('BROWSER_BRIDGE_ERROR', '桥结果通道已关闭');
    case 'Other':
      return formatToolError('BROWSER_BRIDGE_ERROR', error.message);
  }
}

/** Structured USER_TAKEOVER error returned to the model during the cooldown. */
export function browserUserTakeoverError(): string {
  return JSON.stringify({
    code: BROWSER_USER_TAKEOVER,
    message: '用户已接管浏览器',
    hint: '用户已接管浏览器，请询问用户或稍后再试',
    retryable: true,
  });
}

/** Add control-switch notices to a successful tool payload. */
export function annotateControlClaim(
  output: Record<string, JsonValue>, claim: AgentControlClaim,
): void {
  if (!claim.claimedFromUser) return;
  output.control_claimed_from_user = true;
  output.control_notice = '已从用户手中接管浏览器控制';
  if (claim.reclaimedAfterUserTakeover) {
    output.resumed_after_user_takeover = true;
    output.user_takeover_notice = '用户此前显式接管过浏览器；这是接管冷却结束后 Agent 的首次操作，请在回复中告知用户已恢复自动控制';
  }
}

/**
 * `BrowserToolExecutor` 的策略面（`browser_executor.rs:78-208,1069-1223`）。
 *
 * 工具分发由 L04 的 `ToolExecutorRegistry` 组装；本 lane 先把无副作用的
 * can_handle / 敏感度 / 并发 / 错误映射 / 控制权回执作为服务发布，供注册表
 * 与上层执行器复用，避免两条实现漂移。
 */
export class BrowserToolPolicy {
  canHandle(toolName: string): boolean { return isBrowserTool(toolName); }
  sensitivityLevel(toolName: string): ToolSensitivity { return browserToolSensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency { return browserToolConcurrency(toolName); }
  isMutating(toolName: string): boolean { return isMutatingBrowserTool(toolName); }
  isUploadRootKind(kind: RuntimeRootKind): boolean { return isUploadRootKind(kind); }
  mimeTypeForName(name: string): string { return mimeTypeForName(name); }
  isPasswordBlocked(error: BridgeError): boolean { return isPasswordBlockedBridgeError(error); }
  mapBridgeError(error: BridgeError): string { return mapBrowserToolBridgeError(error); }
  userTakeoverError(): string { return browserUserTakeoverError(); }
  annotateControlClaim(output: Record<string, JsonValue>, claim: AgentControlClaim): void {
    annotateControlClaim(output, claim);
  }
  name(): string { return 'BrowserToolExecutor'; }
}

export const browserToolPolicy = new BrowserToolPolicy();
