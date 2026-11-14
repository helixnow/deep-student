/**
 * Workbench / OS-mode tool routing, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs`.
 *
 * The bridge transport lives in `workbench-bridge.ts`; this module owns tool
 * classification, argument normalisation, approval ceilings and the structured
 * error mapping shared by the ACR front end.
 */
import { performance } from 'node:perf_hooks';
import type { SettingsStore } from '../../../../platform/settings/api.ts';
import type { AgentToolCall, AgentToolResultInfo } from '../../../../kernel/agent-api.ts';
import { acrBridgeCall, isBridgeCancelled, isBridgeResultUnknown } from '../workbench-bridge.ts';
import type { AcrBridgeLogger, BridgeEventBus } from '../workbench-bridge.ts';
import { stripToolNamespace } from './naming.ts';

export const WORKBENCH_TOOL_NAMES = {
  GET_CAPABILITIES: 'workbench_get_capabilities',
  OBSERVE: 'workbench_observe',
  ACT: 'workbench_act',
  ACT_HIGH: 'workbench_act_high',
  WAIT_FOR: 'workbench_wait_for',
  UNDO: 'workbench_undo',
  LIST_WINDOWS: 'workbench_list_windows',
  OPEN_APP: 'workbench_open_app',
  APP_COMMAND: 'workbench_app_command',
  CLOSE_WINDOW: 'workbench_close_window',
  QUERY_STATE: 'workbench_query_state',
} as const;

export type WorkbenchToolName = typeof WORKBENCH_TOOL_NAMES[keyof typeof WORKBENCH_TOOL_NAMES];

export const TIMEOUT_QUERY_MS = 5_000;
export const TIMEOUT_MUTATE_MS = 15_000;
export const TIMEOUT_WAIT_MS = 35_000;

export const HINT_UNAVAILABLE =
  '桌面模式未开启或未就绪，导航类操作不可用；数据修改请改用对应领域工具';
export const HINT_DISABLED = '将设置「AI 助手操控」改为后台或跟随即可；数据修改也可改用领域工具';
export const HINT_FLAG_OFF = '请开启 feature flag tools.workbench_agent；数据修改请改用领域工具';
export const HINT_CANCELLED = '用户已取消；请根据 partial 回执的 done/undone 继续，勿原样重试';

export function isReadonlyWorkbenchTool(stripped: string): boolean {
  return stripped === WORKBENCH_TOOL_NAMES.GET_CAPABILITIES
    || stripped === WORKBENCH_TOOL_NAMES.OBSERVE
    || stripped === WORKBENCH_TOOL_NAMES.WAIT_FOR
    || stripped === WORKBENCH_TOOL_NAMES.LIST_WINDOWS
    || stripped === WORKBENCH_TOOL_NAMES.QUERY_STATE;
}

export function canDispatchUnderOffGate(stripped: string): boolean {
  return isReadonlyWorkbenchTool(stripped)
    || stripped === WORKBENCH_TOOL_NAMES.ACT
    || stripped === WORKBENCH_TOOL_NAMES.ACT_HIGH;
}

/**
 * The setting parser: empty (unset) / `background` / `follow` enable the
 * feature; everything else (including `off`) disables it.
 */
export function isWorkbenchAgentEnabled(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '') return true;
  return value === 'background' || value === 'follow';
}

export function structuredError(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
): string {
  return JSON.stringify({ code, message, hint, retryable });
}

export function workbenchUnavailable(message: string): string {
  return structuredError('WORKBENCH_UNAVAILABLE', message, HINT_UNAVAILABLE, false);
}

export function workbenchDisabled(message: string): string {
  return structuredError('WORKBENCH_DISABLED', message, HINT_DISABLED, false);
}

export function workbenchFlagDisabled(message: string): string {
  return structuredError('WORKBENCH_DISABLED', message, HINT_FLAG_OFF, false);
}

export function workbenchCancelled(message: string): string {
  return structuredError('CANCELLED', message, HINT_CANCELLED, false);
}

export function workbenchResultUnknown(message: string): string {
  return JSON.stringify({
    code: 'RESULT_UNKNOWN',
    message,
    hint: '桥请求已提交但未收到权威终态；先重新 observe/读取目标，禁止原样重试',
    retryable: false,
    resultUnknown: true,
  });
}

const KNOWN_ERROR_CODES: readonly string[] = [
  'WORKBENCH_DISABLED',
  'WORKBENCH_UNAVAILABLE',
  'BRIDGE_AUTH_FAILED',
  'BRIDGE_PROTOCOL_ERROR',
  'WINDOW_BUSY',
  'WINDOW_NOT_FOUND',
  'STALE_TARGET_WINDOW',
  'WINDOW_TARGET_MISMATCH',
  'DRIVER_NOT_FOUND',
  'APP_AGENT_UNAVAILABLE',
  'APP_NOT_REGISTERED',
  'OBSERVE_FAILED',
  'STALE_OBSERVATION',
  'CAPABILITY_NOT_FOUND',
  'ACTION_UNAVAILABLE',
  'INVALID_AGENT_REF',
  'TARGET_REF_MISMATCH',
  'INVALID_ACTION_ARGS',
  'CONDITION_NOT_MET',
  'POSTCONDITION_FAILED',
  'INVALID_CONDITION',
  'FOCUS_REQUIRED',
  'ACTION_FAILED',
  'RISK_APPROVAL_REQUIRED',
  'UNDO_NOT_FOUND',
  'UNDO_IN_PROGRESS',
  'UNDO_CONFLICT',
  'UNDO_PARTIAL',
  'INVALID_ARGS',
  'STRICT_MODE',
  'ANCHOR_NOT_FOUND',
  'TODO_CONFLICT',
  'QBANK_CONFLICT',
  'NOTE_OCC_REQUIRED',
  'NOTE_CONFLICT',
  'NOTE_WRITE_FAILED',
  'DUPLICATE_RUN_ID',
  'DUPLICATE_CORRELATION_ID',
  'RUN_ID_REUSE',
  'RUN_ID_EXPIRED',
  'CANCELLED',
  'RESULT_UNKNOWN',
  'UNSUPPORTED_ACTION',
  'UNKNOWN_COMMAND',
  'INTERNAL',
];

const DEFAULT_HINTS: Readonly<Record<string, string>> = {
  WORKBENCH_DISABLED: HINT_DISABLED,
  CANCELLED: HINT_CANCELLED,
  RESULT_UNKNOWN: '桥请求已提交但终态未知；请先重新 observe/读取目标，禁止原样重试',
  BRIDGE_AUTH_FAILED: '桥回执身份或结构不可采信；写请求先重新读取目标，禁止原样重试',
  BRIDGE_PROTOCOL_ERROR: '桥回执身份或结构不可采信；写请求先重新读取目标，禁止原样重试',
  WINDOW_BUSY: '目标窗口正被其他 Agent run 占用；请等待或换窗',
  STALE_TARGET_WINDOW: '目标窗口已关闭、切换资源或身份不匹配；请重新 probe/observe 并使用精确 windowId',
  WINDOW_TARGET_MISMATCH: '目标窗口已关闭、切换资源或身份不匹配；请重新 probe/observe 并使用精确 windowId',
  STALE_OBSERVATION: '目标状态已变化；请重新 observe 并根据最新 revision 规划，勿原样重试',
  APP_AGENT_UNAVAILABLE: '目标应用未注册 Agent 能力；请重新 get_capabilities 或改用领域工具',
  APP_NOT_REGISTERED: '目标应用未注册 Agent 能力；请重新 get_capabilities 或改用领域工具',
  OBSERVE_FAILED: '无法观察目标应用；请确认窗口就绪后重新 observe',
  CAPABILITY_NOT_FOUND: '能力不存在或当前不可用；请重新 get_capabilities 与 observe',
  ACTION_UNAVAILABLE: '能力不存在或当前不可用；请重新 get_capabilities 与 observe',
  INVALID_AGENT_REF: '实体引用无效、已过期或与参数不一致；请重新 observe 并使用最新 ref',
  TARGET_REF_MISMATCH: '实体引用无效、已过期或与参数不一致；请重新 observe 并使用最新 ref',
  INVALID_ACTION_ARGS: '动作参数不符合 capability inputSchema；请重新 get_capabilities',
  CONDITION_NOT_MET: '动作已执行但后置条件未满足；请查看最新 observation 再决定下一步',
  POSTCONDITION_FAILED: '动作已执行但后置条件未满足；请查看最新 observation 再决定下一步',
  INVALID_CONDITION: '条件格式无效；请使用工具 schema 支持的结构化 condition',
  FOCUS_REQUIRED: '该能力要求目标窗口获得焦点；请使用跟随模式或先聚焦窗口',
  ACTION_FAILED: '应用拒绝或未能完成动作；请查看回执与最新 observation',
  RISK_APPROVAL_REQUIRED:
    'manifest 能力风险超过本工具的可信审批上限；高风险动作必须改用 workbench_act_high',
  UNDO_NOT_FOUND: '撤销 token 不存在、已消费或已过期；不要重复调用',
  UNDO_IN_PROGRESS: '同一 token 正在撤销；等待原撤销终态，不要并发重放 inverse',
  UNDO_CONFLICT: '撤销前状态已变化；重新 observe，由用户决定冲突处理',
  UNDO_PARTIAL: 'inverse 仅部分完成；根据回执剩余进度重新观察，勿从头重放',
  STRICT_MODE: '番茄钟严格模式拒绝该操作',
  NOTE_OCC_REQUIRED: '先读取笔记 updated_at，再携带 expected_updated_at 提交；不得无条件覆写',
  NOTE_CONFLICT: '版本冲突；请重新读取后基于最新版本规划',
  TODO_CONFLICT: '版本冲突；请重新读取后基于最新版本规划',
  QBANK_CONFLICT: '版本冲突；请重新读取后基于最新版本规划',
  NOTE_WRITE_FAILED: '笔记持久化未确认；请重新读取目标后再决定下一步',
  DUPLICATE_RUN_ID: '事务身份已被使用；等待原事务终态，不要覆盖或复用身份',
  DUPLICATE_CORRELATION_ID: '事务身份已被使用；等待原事务终态，不要覆盖或复用身份',
  RUN_ID_REUSE: '事务身份已被使用；等待原事务终态，不要覆盖或复用身份',
  RUN_ID_EXPIRED: '该 run 身份的终态记录已过期；请以新的 tool call 发起请求，不要重放旧身份',
  UNSUPPORTED_ACTION: '目标应用不支持该动作；请重新 get_capabilities 后改用已声明能力',
  UNKNOWN_COMMAND: 'bridge 命令不在冻结协议中；请使用协议列出的命令',
  INTERNAL: 'StageManager 内部异常；保留诊断信息，重新读取目标后再决定',
};

function extractErrorCode(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start >= 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.slice(start)); }
    catch { parsed = undefined; }
    // Rust `value.get("code").and_then(Value::as_str)`: only an object's string field.
    const code = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).code : undefined;
    if (typeof code === 'string' && KNOWN_ERROR_CODES.includes(code)) {
      return code;
    }
  }
  const trimmed = raw.trimStart();
  const byPrefix = KNOWN_ERROR_CODES.find(code => trimmed.startsWith(code));
  if (byPrefix !== undefined) return byPrefix;
  return KNOWN_ERROR_CODES.find(code => raw.includes(code));
}

interface ParsedError {
  object?: Record<string, unknown>;
  code?: string;
  message?: string;
  hint?: string;
  retryable?: boolean;
}

function parseError(raw: string): ParsedError {
  let object: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      object = parsed as Record<string, unknown>;
    }
  } catch { object = undefined; }
  return {
    object,
    ...(typeof object?.code === 'string' ? { code: object.code } : {}),
    ...(typeof object?.message === 'string' ? { message: object.message } : {}),
    ...(typeof object?.hint === 'string' ? { hint: object.hint } : {}),
    ...(typeof object?.retryable === 'boolean' ? { retryable: object.retryable } : {}),
  };
}

/** Map a bridge `ok:false` error string to the frozen structured shape. */
export function mapBridgeError(raw: string): string {
  const parsed = parseError(raw);
  const code = (parsed.code !== undefined ? extractErrorCode(parsed.code) : undefined)
    ?? extractErrorCode(raw)
    ?? 'WORKBENCH_UNAVAILABLE';
  const defaultHint = DEFAULT_HINTS[code] ?? HINT_UNAVAILABLE;
  const message = parsed.message !== undefined && parsed.message.trim() !== ''
    ? parsed.message : raw;
  const hint = parsed.hint !== undefined && parsed.hint.trim() !== ''
    ? parsed.hint : defaultHint;
  const retryable = parsed.retryable
    ?? (code === 'WINDOW_BUSY' || code === 'UNDO_IN_PROGRESS');
  if (code === 'RESULT_UNKNOWN') return workbenchResultUnknown(message);
  const out: Record<string, unknown> = { ...(parsed.object ?? {}) };
  out.code = code;
  out.message = message;
  out.hint = hint;
  out.retryable = retryable;
  return JSON.stringify(out);
}

/** `app_command` `handled:false` is a business failure, not a success. */
export function appCommandBusinessError(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.handled !== false) return undefined;
  const code = typeof record.code === 'string' && record.code.trim() !== ''
    ? record.code : 'ACTION_FAILED';
  const message = typeof record.message === 'string' && record.message.trim() !== ''
    ? record.message : 'app_command 未被目标应用处理';
  const hint = typeof record.hint === 'string' && record.hint.trim() !== ''
    ? record.hint
    : '检查 typeId/action/payload；建议改走 observe + workbench_act 执行 manifest 能力';
  return structuredError(code, message, hint, false);
}

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['type_id', 'typeId'],
  ['instance_key', 'instanceKey'],
  ['window_id', 'windowId'],
  ['resource_id', 'resourceId'],
  ['observation_revision', 'observationRevision'],
  ['stop_on_failure', 'stopOnFailure'],
  ['timeout_ms', 'timeoutMs'],
  ['interval_ms', 'intervalMs'],
  ['undo_token', 'undoToken'],
];

/** LLM snake_case → bridge camelCase; camelCase wins when both exist. */
export function normalizeBridgeArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [snake, camel] of ALIASES) {
    if (Object.prototype.hasOwnProperty.call(out, camel)) {
      delete out[snake];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, snake)) {
      const value = out[snake];
      delete out[snake];
      out[camel] = value;
    }
  }
  return out;
}

/** Server-side risk ceiling override; model-supplied values are discarded. */
export function injectApprovalRiskCeiling(args: unknown, ceiling: string): Record<string, unknown> {
  const object = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>) } : {};
  object.approvalRiskCeiling = ceiling;
  return object;
}

/** Only the executor may set the risk ceiling; tools without a trusted one never forward the model's value. */
export function withoutApprovalRiskCeiling(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const object = args as Record<string, unknown>;
  if (!('approvalRiskCeiling' in object) && !('approval_risk_ceiling' in object)) return args;
  const { approvalRiskCeiling: _camel, approval_risk_ceiling: _snake, ...rest } = object;
  return rest;
}

export function trustedApprovalRiskCeiling(stripped: string): string | undefined {
  if (stripped === WORKBENCH_TOOL_NAMES.ACT) return 'medium';
  if (stripped === WORKBENCH_TOOL_NAMES.ACT_HIGH || stripped === WORKBENCH_TOOL_NAMES.UNDO) {
    return 'high';
  }
  return undefined;
}

const LEGACY_HIGH_RISK: ReadonlyArray<readonly [string, string]> = [
  ['pomodoro', 'stop'],
  ['sandbox', 'setMode'],
];

export function isLegacyHighRiskCommand(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const typeId = record.typeId;
  const action = record.action;
  if (typeof typeId !== 'string' || typeof action !== 'string') return false;
  return LEGACY_HIGH_RISK.some(([type, name]) => typeId === type && action === name);
}

export function bridgeCommandAndTimeout(stripped: string): [string, number] | undefined {
  const names = WORKBENCH_TOOL_NAMES;
  if (stripped === names.GET_CAPABILITIES) return ['get_capabilities', TIMEOUT_QUERY_MS];
  if (stripped === names.OBSERVE) return ['observe', TIMEOUT_QUERY_MS];
  if (stripped === names.ACT) return ['act', TIMEOUT_MUTATE_MS];
  if (stripped === names.ACT_HIGH) return ['act', TIMEOUT_MUTATE_MS];
  if (stripped === names.WAIT_FOR) return ['wait_for', TIMEOUT_WAIT_MS];
  if (stripped === names.UNDO) return ['revert_run', TIMEOUT_MUTATE_MS];
  if (stripped === names.LIST_WINDOWS) return ['list_windows', TIMEOUT_QUERY_MS];
  if (stripped === names.OPEN_APP) return ['open_app', TIMEOUT_MUTATE_MS];
  if (stripped === names.APP_COMMAND) return ['app_command', TIMEOUT_MUTATE_MS];
  if (stripped === names.CLOSE_WINDOW) return ['close_window', TIMEOUT_MUTATE_MS];
  if (stripped === names.QUERY_STATE) return ['query_state', TIMEOUT_QUERY_MS];
  return undefined;
}

export function isWorkbenchTool(stripped: string): boolean {
  return bridgeCommandAndTimeout(stripped) !== undefined;
}

// ------------------------------------------------------------------ gates

export const FLAG_WORKBENCH_AGENT = 'tools.workbench_agent';
export const SETTING_WORKBENCH_AGENT_CONTROL = 'desktop.workbenchAgentControl';

export type WorkbenchGateMode = 'flag_off' | 'off' | 'enabled';

/** Feature-flag + settings access used by the double gate (`resolve_workbench_gates`). */
export interface WorkbenchGateEnvironment {
  featureFlagEnabled(name: string): boolean;
  settings: Pick<SettingsStore, 'get'>;
}

/**
 * `resolve_workbench_gates`: flag off → hard gate; setting off → read-only;
 * otherwise enabled. Missing setting defaults to `follow`.
 */
export function resolveWorkbenchGates(env: WorkbenchGateEnvironment | null | undefined): WorkbenchGateMode {
  if (env === null || env === undefined) {
    throw new Error(structuredError('WORKBENCH_UNAVAILABLE', 'AppState 不可用', HINT_UNAVAILABLE, false));
  }
  let enabled: boolean;
  try { enabled = env.featureFlagEnabled(FLAG_WORKBENCH_AGENT); }
  catch (error) {
    throw new Error(structuredError('WORKBENCH_UNAVAILABLE', errorText(error), HINT_UNAVAILABLE, false));
  }
  if (!enabled) return 'flag_off';
  let raw: string | null;
  try { raw = env.settings.get(SETTING_WORKBENCH_AGENT_CONTROL); }
  catch (error) {
    throw new Error(structuredError(
      'WORKBENCH_UNAVAILABLE', `读取设置失败: ${errorText(error)}`, HINT_UNAVAILABLE, false,
    ));
  }
  return isWorkbenchAgentEnabled(raw ?? 'follow') ? 'enabled' : 'off';
}

/** Domain write tools must pass the same double gate before delegating to the front end. */
export function isWorkbenchAgentDelegationEnabled(env: WorkbenchGateEnvironment | null | undefined): boolean {
  return resolveWorkbenchGates(env) === 'enabled';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WorkbenchToolContext {
  sessionId: string;
  toolCallId: string;
  blockId: string;
  events: BridgeEventBus;
  /** Null mirrors Rust's missing app state: every call fails `WORKBENCH_UNAVAILABLE`. */
  gates: WorkbenchGateEnvironment | null;
  cancel?: AbortSignal | null;
  /** Tool-card chunk sink for bridge progress (`emit_chunk(TOOL_CALL, ..)`). */
  emitProgressChunk?: (chunk: string) => void;
  emitToolCallStart?: (name: string, args: unknown, callId: string | null) => void;
  emitToolCallEnd?: (payload: unknown) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: AgentToolResultInfo) => void;
  logger?: AcrBridgeLogger;
  /** Bounded cancel-drain window override (tests / callers with tighter budgets). */
  drainMs?: number;
}

export class WorkbenchToolExecutor {
  canHandle(toolName: string): boolean {
    return isWorkbenchTool(stripToolNamespace(toolName));
  }

  /** `WorkbenchToolExecutor::dispatch` — gates, normalisation and bridge error mapping. */
  async dispatch(stripped: string, args: unknown, ctx: WorkbenchToolContext): Promise<unknown> {
    const gate = resolveWorkbenchGates(ctx.gates);
    if (gate === 'flag_off') {
      throw new Error(workbenchFlagDisabled('Agent 桌面硬闸未开启（tools.workbench_agent）'));
    }
    if (gate === 'off' && !canDispatchUnderOffGate(stripped)) {
      throw new Error(workbenchDisabled(
        `Agent 桌面操控未开启（desktop.workbenchAgentControl=off），拒绝 ${stripped}`,
      ));
    }

    const bridge = bridgeCommandAndTimeout(stripped);
    if (bridge === undefined) {
      throw new Error(workbenchUnavailable(`未知的 workbench 工具: ${stripped}`));
    }
    const [command, timeoutMs] = bridge;

    const normalizedArgs = normalizeBridgeArgs(args);
    if (stripped === WORKBENCH_TOOL_NAMES.APP_COMMAND && isLegacyHighRiskCommand(normalizedArgs)) {
      throw new Error(structuredError(
        'RISK_APPROVAL_REQUIRED',
        'manifest high 风险动作不能通过兼容 app_command 执行',
        '请先 workbench_observe，再用 workbench_act_high 对本次动作精确审批',
        false,
      ));
    }
    const ceiling = trustedApprovalRiskCeiling(stripped);
    // RUST-FIX(RF-W02-workbench-untrusted-risk-ceiling): workbench_executor.rs:544-547 forwards a model-supplied
    // approvalRiskCeiling unchanged for every tool without a trusted ceiling.
    const bridgeArgs = ceiling !== undefined
      ? injectApprovalRiskCeiling(normalizedArgs, ceiling)
      : withoutApprovalRiskCeiling(normalizedArgs);

    ctx.logger?.debug?.(
      `[WorkbenchToolExecutor] bridge command=${command} timeout_ms=${timeoutMs} run_id=${ctx.toolCallId}`,
    );

    let response;
    try {
      response = await acrBridgeCall({
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        events: ctx.events,
        ...(ctx.cancel !== undefined ? { cancel: ctx.cancel } : {}),
        ...(ctx.emitProgressChunk !== undefined ? { emitProgressChunk: ctx.emitProgressChunk } : {}),
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
        ...(ctx.drainMs !== undefined ? { drainMs: ctx.drainMs } : {}),
      }, command, bridgeArgs, timeoutMs);
    } catch (error) {
      const message = errorText(error);
      if (isBridgeCancelled(message)) throw new Error(workbenchCancelled(message));
      if (isBridgeResultUnknown(message)) throw new Error(workbenchResultUnknown(message));
      throw new Error(workbenchUnavailable(message));
    }

    if (!response.ok) throw new Error(mapBridgeError(response.error ?? '桥层返回失败'));
    const data = response.data ?? {};
    if (stripped === WORKBENCH_TOOL_NAMES.APP_COMMAND) {
      const businessError = appCommandBusinessError(data);
      if (businessError !== undefined) throw new Error(businessError);
    }
    return data;
  }

  /** `ToolExecutor::execute` — start/end/error events plus best-effort block persistence. */
  async execute(call: AgentToolCall, ctx: WorkbenchToolContext): Promise<AgentToolResultInfo> {
    const startedAt = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);

    const toolName = stripToolNamespace(call.name);
    ctx.logger?.debug?.(
      `[WorkbenchToolExecutor] Executing ${toolName} (full=${call.name}, run_id=${ctx.toolCallId})`,
    );

    let output: unknown;
    let failure: string | undefined;
    try {
      output = await this.dispatch(toolName, call.arguments, ctx);
    } catch (error) {
      failure = errorText(error);
    }
    const durationMs = Math.floor(performance.now() - startedAt);

    let result: AgentToolResultInfo;
    if (failure === undefined) {
      ctx.emitToolCallEnd?.({ result: output, durationMs });
      result = {
        toolCallId: call.id, blockId: ctx.blockId, toolName: call.name,
        input: call.arguments, output, success: true, durationMs,
      };
    } else {
      ctx.emitToolCallError?.(failure);
      result = {
        toolCallId: call.id, blockId: ctx.blockId, toolName: call.name,
        input: call.arguments, output: null, success: false, error: failure, durationMs,
      };
    }
    try { ctx.saveToolBlock?.(result); }
    catch (error) {
      ctx.logger?.warn?.(`[WorkbenchToolExecutor] Failed to save tool block: ${errorText(error)}`);
    }
    return result;
  }

  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' {
    const stripped = stripToolNamespace(toolName);
    if (stripped === WORKBENCH_TOOL_NAMES.CLOSE_WINDOW
      || stripped === WORKBENCH_TOOL_NAMES.ACT_HIGH
      || stripped === WORKBENCH_TOOL_NAMES.UNDO) return 'high';
    if (stripped === WORKBENCH_TOOL_NAMES.ACT
      || stripped === WORKBENCH_TOOL_NAMES.APP_COMMAND
      || stripped === WORKBENCH_TOOL_NAMES.OPEN_APP) return 'medium';
    return 'low';
  }

  managesCancellation(_toolName: string): boolean { return true; }
  concurrencyClass(_toolName: string): 'serial' { return 'serial'; }
  name(): string { return 'WorkbenchToolExecutor'; }
}
