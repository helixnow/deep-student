/**
 * 工具审批管理器：移植 `chat_v2/approval_manager.rs`。
 *
 * Rust 用 oneshot channel 实现异步等待；Host 侧用 Promise 表达同一语义：
 * `registerWithScope` 返回一个等待中的 Promise，`respond*` 解析它并返回是否送达。
 * 超时由调用方（pipeline）用 `cancel*` 表达，与 Rust 一致（manager 自身不建定时器）。
 */
import type {
  ToolApprovalManager as ApprovalManagerContract, ApprovalRespondResult, ApprovalResponse, JsonValue,
} from '../api.ts';
import {
  makeRuntimeScopeKey,
  makeRuntimeScopeKeyV1,
  makeRuntimeScopeKeyV2,
  makeSettingKey,
  neverRememberApproval,
  neverRememberApprovalForArgs,
  redactShellCommandForDisplay,
  requiresPreciseApprovalScope,
  isShellRuntimeToolForArgs,
  PermissionPreset as PermissionPresetValue,
  ToolSensitivity as ToolSensitivityValue,
  type RuntimeApprovalScope,
} from './approval-scope.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './workspace/logger.ts';
import { rustTrim } from '../../../platform/util/index.ts';

// ============================================================================
// 审批请求/响应数据结构
// ============================================================================

/** 审批请求（发送到前端）。`serde(rename_all = "camelCase")`。 */
export interface ApprovalRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  sensitivity: string;
  permissionPreset: PermissionPresetValue;
  description: string;
  timeoutSeconds: number;
  runtimeScope?: RuntimeApprovalScope;
}

/** `ApprovalResponse::approved`。 */
export function approvedResponse(sessionId: string, toolCallId: string, toolName: string): ApprovalResponse {
  return {
    sessionId,
    toolCallId,
    toolName,
    approved: true,
    reason: null,
    remember: false,
    rememberSession: false,
  };
}

/** `ApprovalResponse::rejected`。 */
export function rejectedResponse(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  reason: string | null,
): ApprovalResponse {
  return { sessionId, toolCallId, toolName, approved: false, reason, remember: false, rememberSession: false };
}

/** `ApprovalResponse::timeout`。 */
export function timeoutResponse(sessionId: string, toolCallId: string, toolName: string): ApprovalResponse {
  return rejectedResponse(sessionId, toolCallId, toolName, '审批超时');
}

/** 对应 Rust `ApprovalResponse::{approved,rejected,timeout}`。 */
export const ApprovalResponses = {
  approved: approvedResponse,
  rejected: rejectedResponse,
  timeout: timeoutResponse,
} as const;

// ============================================================================
// 审批管理器
// ============================================================================

const PENDING_SEPARATOR = '\n';

/** 单个挂起审批：Rust `oneshot::Sender` + 尚未 drop 的接收方。 */
class PendingWaiter {
  active = true;
  private readonly promise: Promise<ApprovalResponse>;
  private readonly resolveFn: (response: ApprovalResponse) => void;

  constructor() {
    let resolveFn: (response: ApprovalResponse) => void = () => undefined;
    this.promise = new Promise<ApprovalResponse>(resolve => { resolveFn = resolve; });
    this.resolveFn = resolveFn;
  }

  /** Rust `tx.send(response).is_ok()`。 */
  deliver(response: ApprovalResponse): boolean {
    if (!this.active) return false;
    this.active = false;
    this.resolveFn(response);
    return true;
  }

  wait(): Promise<ApprovalResponse> {
    return this.promise;
  }
}

function makePendingKey(sessionId: string, toolCallId: string): string {
  // Rust 用换行符作分隔符而非 `:`，避免 session_id / tool_call_id 内含 `:` 造成碰撞。
  return `${sessionId}${PENDING_SEPARATOR}${toolCallId}`;
}

function makeSessionRememberKey(sessionId: string, toolName: string): string {
  return `${sessionId}${PENDING_SEPARATOR}tool${PENDING_SEPARATOR}${toolName}`;
}

function makeScopedSessionRememberKey(sessionId: string, scopeKey: string): string {
  return `${sessionId}${PENDING_SEPARATOR}scope${PENDING_SEPARATOR}${scopeKey}`;
}

/** 明确的取消决策 reason（前端可据此与「用户拒绝」区分文案）。 */
export const CANCELLED_REASON = 'approval_cancelled';

export class ApprovalManager implements ApprovalManagerContract {
  static readonly CANCELLED_REASON = CANCELLED_REASON;

  private readonly logger: WorkspaceLogger;

  constructor(logger: WorkspaceLogger = silentWorkspaceLogger) {
    this.logger = logger;
  }

  private logWarn(message: string): void {
    this.logger.warn(message);
  }

  private logInfo(message: string): void {
    this.logger.info(message);
  }

  private readonly pending = new Map<string, PendingWaiter>();
  private readonly pendingScopeKeys = new Map<string, string>();
  private readonly pendingSettingKeys = new Map<string, string>();
  private readonly pendingToolNames = new Map<string, string>();
  private readonly pendingRememberDisabled = new Map<string, boolean>();
  private readonly pendingSessionOnly = new Map<string, boolean>();
  private defaultTimeoutSeconds = 300;
  private readonly remembered = new Map<string, boolean>();
  private readonly sessionRemembered = new Map<string, boolean>();

  /** 设置默认超时时间（秒），对应 Rust `with_timeout`。 */
  withTimeout(timeoutSeconds: number): this {
    this.defaultTimeoutSeconds = timeoutSeconds;
    return this;
  }

  /** 无 session / 无参数版本的 register（Rust 中仅供单测使用）。 */
  register(toolCallId: string): Promise<ApprovalResponse> {
    return this.registerWithScope('', toolCallId, '', null);
  }

  registerWithScope(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ApprovalResponse> {
    return this.registerWithRememberPolicy(sessionId, toolCallId, toolName, argumentsValue, false, false);
  }

  registerWithPermissionPreset(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    argumentsValue: JsonValue,
    preset: PermissionPresetValue,
    sensitivity: ToolSensitivityValue,
  ): Promise<ApprovalResponse> {
    const rememberDisabled = preset === PermissionPresetValue.Cautious
      || sensitivity === ToolSensitivityValue.High;
    return this.registerWithRememberPolicy(sessionId, toolCallId, toolName, argumentsValue, rememberDisabled, true);
  }

  private registerWithRememberPolicy(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    argumentsValue: JsonValue,
    presetRememberDisabled: boolean,
    sessionOnly: boolean,
  ): Promise<ApprovalResponse> {
    const waiter = new PendingWaiter();
    const pendingKey = makePendingKey(sessionId, toolCallId);

    // 检测 tool_call_id 复用：已有同 key 的 waiter 时，旧调用方立刻收到 rejected，
    // 避免它一直等到超时。
    const prior = this.pending.get(pendingKey) ?? null;
    this.pending.set(pendingKey, waiter);
    if (prior !== null) {
      this.logWarn(
        `[ApprovalManager] Duplicate register_with_scope for pending_key session=${sessionId}, tool_call_id=${toolCallId}; `
        + 'dropping earlier receiver (likely tool_call_id reuse from adapter)',
      );
      prior.deliver(rejectedResponse(
        sessionId,
        toolCallId,
        toolName,
        'duplicate approval request; earlier one superseded',
      ));
    }

    const scopeKey = makeRuntimeScopeKey(toolName, argumentsValue);
    const settingKey = makeSettingKey(toolName, argumentsValue);
    this.pendingScopeKeys.set(pendingKey, scopeKey);
    this.pendingSettingKeys.set(pendingKey, settingKey);
    this.pendingToolNames.set(pendingKey, toolName);
    this.pendingRememberDisabled.set(
      pendingKey,
      presetRememberDisabled || neverRememberApprovalForArgs(toolName, argumentsValue),
    );
    this.pendingSessionOnly.set(makePendingKey(sessionId, toolCallId), sessionOnly);

    return waiter.wait();
  }

  respond(response: ApprovalResponse): boolean {
    return this.respondWithResult(response).delivered;
  }

  respondWithResult(input: ApprovalResponse): ApprovalRespondResult {
    const response: ApprovalResponse = { ...input };
    const pendingKey = makePendingKey(response.sessionId, response.toolCallId);

    // 先弹出 pending 通道，确认请求仍存活。不在（已取消/已超时）则直接报废本次
    // respond，且不持久化 remember（避免用 Null 作为兜底 args 构造通配作用域）。
    const waiter = this.pending.get(pendingKey) ?? null;
    if (waiter === null) {
      this.logWarn(`[ApprovalManager] No pending approval for tool_call_id: ${response.toolCallId}`);
      this.pendingScopeKeys.delete(pendingKey);
      this.pendingSettingKeys.delete(pendingKey);
      this.pendingToolNames.delete(pendingKey);
      this.pendingRememberDisabled.delete(pendingKey);
      this.pendingSessionOnly.delete(pendingKey);
      return { delivered: false, settingKey: null };
    }
    this.pending.delete(pendingKey);

    const scopeKeyOpt = this.pendingScopeKeys.get(pendingKey) ?? null;
    this.pendingScopeKeys.delete(pendingKey);
    const settingKeyOpt = this.pendingSettingKeys.get(pendingKey) ?? null;
    this.pendingSettingKeys.delete(pendingKey);
    const originalToolNameOpt = this.pendingToolNames.get(pendingKey) ?? null;
    this.pendingToolNames.delete(pendingKey);
    const rememberDisabled = this.pendingRememberDisabled.get(pendingKey) ?? true;
    this.pendingRememberDisabled.delete(pendingKey);
    const sessionOnly = this.pendingSessionOnly.get(pendingKey) ?? true;
    this.pendingSessionOnly.delete(pendingKey);

    let toolNameSpoofed = false;
    if (originalToolNameOpt !== null && originalToolNameOpt !== response.toolName) {
      this.logWarn(
        `[ApprovalManager] Approval response tool_name mismatch for session=${response.sessionId}, `
        + `tool_call_id=${response.toolCallId}: response='${response.toolName}', pending='${originalToolNameOpt}'; `
        + 'using pending tool name',
      );
      response.toolName = originalToolNameOpt;
      toolNameSpoofed = true;
    }

    // 伪造的 tool_name 不得携带 remember 语义：校正后降级为单次批准。
    if (toolNameSpoofed && (response.remember || response.rememberSession)) {
      this.logWarn(
        `[ApprovalManager] Dropping remember flags for spoofed response (session=${response.sessionId}, `
        + `tool_call_id=${response.toolCallId}, tool=${response.toolName})`,
      );
      response.remember = false;
      response.rememberSession = false;
    }

    // ADR-B2：权限类工具永不写入 remember。
    if ((rememberDisabled || neverRememberApproval(response.toolName))
      && (response.remember || response.rememberSession)) {
      this.logInfo(
        `[ApprovalManager] Downgrading remember flags for privilege tool '${response.toolName}' `
        + `(session=${response.sessionId}, tool_call_id=${response.toolCallId})`,
      );
      response.remember = false;
      response.rememberSession = false;
    }
    if (sessionOnly && response.remember) response.remember = false;

    if (response.remember) {
      if (scopeKeyOpt !== null) {
        this.logInfo(
          `[ApprovalManager] Remembering approval choice for scope '${scopeKeyOpt}': approved=${response.approved}`,
        );
        this.remembered.set(scopeKeyOpt, response.approved);
      } else {
        // H4：不允许在作用域键缺失时用 Null 合成作用域。
        this.logWarn(
          '[ApprovalManager] respond(remember=true) but scope_key missing; dropping remember flag '
          + `(session=${response.sessionId}, tool_call_id=${response.toolCallId}, tool=${response.toolName})`,
        );
      }
    }

    // 审批三档分级：会话级记住。普通工具工具级粒度；shell/runtime 工具按精确 scope。
    if (response.rememberSession && response.sessionId !== '') {
      let sessionKey = '';
      if (requiresPreciseApprovalScope(response.toolName)) {
        if (scopeKeyOpt !== null) {
          sessionKey = makeScopedSessionRememberKey(response.sessionId, scopeKeyOpt);
        } else {
          this.logWarn(
            '[ApprovalManager] respond(remember_session=true) but scope_key missing for precise tool; '
            + `dropping session remember (session=${response.sessionId}, tool_call_id=${response.toolCallId}, `
            + `tool=${response.toolName})`,
          );
        }
      } else {
        sessionKey = makeSessionRememberKey(response.sessionId, response.toolName);
      }
      if (sessionKey !== '') {
        this.logInfo(
          `[ApprovalManager] Remembering approval for this session: '${sessionKey.replaceAll('\n', ' / ')}' `
          + `approved=${response.approved}`,
        );
        this.sessionRemembered.set(sessionKey, response.approved);
      }
    }

    // ADR-B2：权限类工具不返回 setting_key，从源头阻断「始终允许」的 DB 持久化。
    const settingKeyForPersistence = (rememberDisabled
      || sessionOnly
      || toolNameSpoofed
      || neverRememberApproval(response.toolName))
      ? null
      : settingKeyOpt;

    return { delivered: waiter.deliver(response), settingKey: settingKeyForPersistence };
  }

  cancelWithSession(sessionId: string, toolCallId: string): boolean {
    return this.cancelPendingKey(makePendingKey(sessionId, toolCallId));
  }

  /** 移除一个 pending 项并向仍在等待的接收方送达取消决策。 */
  private cancelPendingKey(pendingKey: string): boolean {
    const waiter = this.pending.get(pendingKey) ?? null;
    this.pending.delete(pendingKey);
    this.pendingScopeKeys.delete(pendingKey);
    this.pendingSettingKeys.delete(pendingKey);
    const toolName = this.pendingToolNames.get(pendingKey) ?? null;
    this.pendingToolNames.delete(pendingKey);
    this.pendingRememberDisabled.delete(pendingKey);
    this.pendingSessionOnly.delete(pendingKey);

    if (waiter === null) return false;

    const separator = pendingKey.indexOf(PENDING_SEPARATOR);
    const sessionId = separator >= 0 ? pendingKey.slice(0, separator) : '';
    const toolCallId = separator >= 0 ? pendingKey.slice(separator + 1) : pendingKey;
    waiter.deliver(rejectedResponse(sessionId, toolCallId, toolName ?? '', CANCELLED_REASON));
    return true;
  }

  /** B2（一键断电）：以拒绝结果 drain 全部挂起审批。 */
  rejectAllPending(reason: string): number {
    const drained = [...this.pending.entries()];
    this.pending.clear();
    if (drained.length === 0) return 0;

    const keys = drained.map(([key]) => key);
    const toolNames = new Map<string, string>();
    for (const key of keys) {
      const name = this.pendingToolNames.get(key);
      if (name !== undefined) toolNames.set(key, name);
      this.pendingToolNames.delete(key);
      this.pendingScopeKeys.delete(key);
      this.pendingSettingKeys.delete(key);
      this.pendingRememberDisabled.delete(key);
      this.pendingSessionOnly.delete(key);
    }

    let rejected = 0;
    for (const [key, waiter] of drained) {
      const separator = key.indexOf(PENDING_SEPARATOR);
      const sessionId = separator >= 0 ? key.slice(0, separator) : '';
      const toolCallId = separator >= 0 ? key.slice(separator + 1) : key;
      const toolName = toolNames.get(key) ?? '';
      waiter.deliver(rejectedResponse(sessionId, toolCallId, toolName, reason));
      rejected += 1;
    }
    this.logWarn(`[ApprovalManager] reject_all_pending: rejected ${rejected} pending approval(s), reason=${reason}`);
    return rejected;
  }

  /** 无 session 维度的取消（旧前端命令入口）；多会话同 id 时拒绝宽匹配。 */
  cancel(toolCallId: string): boolean {
    const suffix = `${PENDING_SEPARATOR}${toolCallId}`;
    const pendingKeys = [...this.pending.keys()]
      .filter(key => key.endsWith(suffix) || key === toolCallId);
    if (pendingKeys.length === 0) return false;
    if (pendingKeys.length > 1) {
      this.logWarn(
        `[ApprovalManager] cancel('${toolCallId}') matched ${pendingKeys.length} pending approvals across sessions; `
        + 'refusing broad cancellation — use cancel_with_session',
      );
      return false;
    }
    return this.cancelPendingKey(pendingKeys[0]!);
  }

  /** 检查工具是否已被记住（自动批准/拒绝）；v2 优先，未命中回退 v1。 */
  checkRemembered(toolName: string, argumentsValue: JsonValue): boolean | null {
    if (neverRememberApprovalForArgs(toolName, argumentsValue)) return null;
    const v2Key = makeRuntimeScopeKeyV2(toolName, argumentsValue);
    const v1Key = makeRuntimeScopeKeyV1(toolName, argumentsValue);
    if (v2Key !== null) {
      const value = this.remembered.get(v2Key);
      if (value !== undefined) return value;
    }
    return this.remembered.get(v1Key) ?? null;
  }

  /** 检查工具在指定会话内是否已被记住（"本会话允许该工具"档）。 */
  checkSessionRemembered(sessionId: string, toolName: string, argumentsValue: JsonValue): boolean | null {
    if (neverRememberApprovalForArgs(toolName, argumentsValue)) return null;
    const key = this.sessionRememberKeyFor(sessionId, toolName, argumentsValue);
    return this.sessionRemembered.get(key) ?? null;
  }

  private sessionRememberKeyFor(sessionId: string, toolName: string, argumentsValue: JsonValue): string {
    if (requiresPreciseApprovalScope(toolName)) {
      const scopeKey = makeRuntimeScopeKey(toolName, argumentsValue);
      return makeScopedSessionRememberKey(sessionId, scopeKey);
    }
    return makeSessionRememberKey(sessionId, toolName);
  }

  /** 清除指定会话的所有会话级记住选择（会话删除/重置时调用）。 */
  clearSessionRemembered(sessionId: string): void {
    const prefix = `${sessionId}${PENDING_SEPARATOR}`;
    for (const key of [...this.sessionRemembered.keys()]) {
      if (key.startsWith(prefix)) this.sessionRemembered.delete(key);
    }
  }

  /** 清除记住的选择（按参数作用域）；v1 + v2 两个键都尝试清理。 */
  clearRemembered(toolName: string, argumentsValue: JsonValue): void {
    const v2Key = makeRuntimeScopeKeyV2(toolName, argumentsValue);
    const v1Key = makeRuntimeScopeKeyV1(toolName, argumentsValue);
    if (v2Key !== null) this.remembered.delete(v2Key);
    this.remembered.delete(v1Key);
  }

  clearAllRemembered(): void {
    this.remembered.clear();
    this.sessionRemembered.clear();
  }

  defaultTimeout(): number {
    return this.defaultTimeoutSeconds;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 生成旧客户端兼容描述。
   *
   * 新版前端使用结构化 tool_name + arguments 生成本地化文案，本返回值作 fallback。
   */
  generateDescription(toolName: string, argumentsValue: JsonValue): string {
    return ApprovalManager.generateDescription(toolName, argumentsValue);
  }

  static generateDescription(toolName: string, argumentsValue: JsonValue): string {
    const object = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
      ? argumentsValue as { [key: string]: JsonValue }
      : null;
    const hasKey = (key: string): boolean => object !== null && Object.hasOwn(object, key);
    const field = (key: string): string | null => {
      if (!hasKey(key)) return null;
      const value = object![key];
      return typeof value === 'string' ? value : null;
    };
    /** `.get(k1).or_else(|| .get(k2)).and_then(as_str).unwrap_or(fallback)`。 */
    const pickString = (keys: string[], fallback: string): string => {
      for (const key of keys) {
        if (!hasKey(key)) continue;
        const value = object![key];
        return typeof value === 'string' ? value : fallback;
      }
      return fallback;
    };
    /** `.get(k1).or_else(|| .get(k2)).and_then(as_str).map(str::trim).filter(non-empty)`。 */
    const pickTrimmed = (keys: string[]): string | null => {
      for (const key of keys) {
        if (!hasKey(key)) continue;
        const value = object![key];
        if (typeof value !== 'string') return null;
        const trimmed = rustTrim(value);
        return trimmed === '' ? null : trimmed;
      }
      return null;
    };

    if (isShellRuntimeToolForArgs(toolName, argumentsValue)) {
      const command = field('command') ?? '...';
      const [display] = redactShellCommandForDisplay(command);
      return `将执行命令: ${display}`;
    }
    switch (toolName) {
      case 'model_profile_add':
      case 'builtin-model_profile_add': {
        const model = field('model') ?? '未知模型';
        const baseUrl = field('base_url');
        return baseUrl !== null
          ? `将新增模型配置: ${model}（供应商地址 ${baseUrl}）`
          : `将在已有供应商下新增模型配置: ${model}`;
      }
      case 'note_set': {
        const noteId = pickString(['noteId', 'note_id'], '未知笔记');
        return `将完全替换笔记 ${noteId} 的内容`;
      }
      case 'note_replace': {
        const search = field('search') ?? '...';
        return `将替换笔记中匹配 "${search}" 的内容`;
      }
      case 'file_write': {
        const filePath = field('path') ?? '未知路径';
        return `将写入文件: ${filePath}`;
      }
      case 'workspace_artifact_write': {
        const filePath = field('path') ?? '未知路径';
        return `将写入会话产物文件: ${filePath}`;
      }
      case 'file_manager_commit':
      case 'builtin-file_manager_commit': {
        const root = field('root_id') ?? 'workspace';
        const plan = field('plan_id') ?? '未知计划';
        return `将在 ${root} 中执行已预览的文件批处理计划 ${plan}`;
      }
      case 'file_manager_restore':
      case 'builtin-file_manager_restore': {
        const receipt = object?.['receipt'];
        const receiptObject = receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
          ? receipt as { [key: string]: JsonValue }
          : null;
        let filePath = '未知路径';
        if (receiptObject !== null) {
          for (const key of ['originalPath', 'original_path']) {
            if (!Object.hasOwn(receiptObject, key)) continue;
            const value = receiptObject[key];
            filePath = typeof value === 'string' ? value : '未知路径';
            break;
          }
        }
        return `将从工作区回收区恢复文件: ${filePath}`;
      }
      case 'file_delete': {
        const filePath = field('path') ?? '未知路径';
        return `将删除文件: ${filePath}`;
      }
      case 'browser_open':
      case 'builtin-browser_open': {
        const url = field('url') ?? '未知地址';
        return `将打开内置浏览器: ${url}`;
      }
      case 'browser_navigate':
      case 'builtin-browser_navigate': {
        const url = field('url') ?? '未知地址';
        return `将导航至: ${url}`;
      }
      case 'browser_click':
      case 'builtin-browser_click': {
        const element = field('element') ?? '页面元素';
        const ref = field('ref') ?? '?';
        return `将点击网页元素: ${element} (ref=${ref})`;
      }
      case 'browser_file_upload':
      case 'builtin-browser_file_upload': {
        const element = field('element') ?? '文件输入框';
        const files = object?.['files'];
        const count = Array.isArray(files) ? files.length : 0;
        return `将向网页上传 ${count} 个已授权文件: ${element}`;
      }
      case 'media_transcribe':
      case 'builtin-media_transcribe': {
        // `arguments.get("source").unwrap_or(arguments)`
        const sourceValue: JsonValue = hasKey('source') ? object!['source']! : argumentsValue;
        const sourceObject = sourceValue !== null && typeof sourceValue === 'object' && !Array.isArray(sourceValue)
          ? sourceValue as { [key: string]: JsonValue }
          : null;
        let handleValue: JsonValue = sourceValue;
        if (sourceObject !== null) {
          for (const key of ['object_handle', 'objectHandle']) {
            if (!Object.hasOwn(sourceObject, key)) continue;
            handleValue = sourceObject[key]!;
            break;
          }
        }
        const handle = handleValue !== null && typeof handleValue === 'object' && !Array.isArray(handleValue)
          ? handleValue as { [key: string]: JsonValue }
          : null;
        let file = '未知音频文件';
        if (handle !== null) {
          for (const key of ['displayName', 'display_name', 'relativePath', 'relative_path']) {
            if (!Object.hasOwn(handle, key)) continue;
            const value = handle[key];
            file = typeof value === 'string' ? value : '未知音频文件';
            break;
          }
        }
        return `将把已授权音频文件 ${file} 发送至外部 ASR 提供商 SiliconFlow，并将转写结果写入任务 artifact`;
      }
      case 'browser_type':
      case 'builtin-browser_type': {
        const element = field('element') ?? '输入框';
        const ref = field('ref') ?? '?';
        return `将向网页元素输入文本: ${element} (ref=${ref})（内容已隐藏）`;
      }
      case 'browser_snapshot':
      case 'builtin-browser_snapshot':
      case 'browser_scroll':
      case 'builtin-browser_scroll':
      case 'browser_back':
      case 'builtin-browser_back':
      case 'browser_close':
      case 'builtin-browser_close':
        return `将执行浏览器操作: ${toolName}`;
      case 'skill_set_enabled':
      case 'builtin-skill_set_enabled': {
        const skillId = pickString(['skill_id', 'skillId'], '未知技能');
        const enabled = object?.['enabled'];
        return enabled === true ? `将启用技能: ${skillId}` : `将停用技能: ${skillId}（保留技能文件，可随时重新启用）`;
      }
      case 'skill_remove':
      case 'builtin-skill_remove': {
        const skillId = pickString(['skill_id', 'skillId'], '未知技能');
        return `将删除技能包: ${skillId}（不可恢复；builtin 技能不受影响）`;
      }
      case 'skill_trust_request':
      case 'builtin-skill_trust_request': {
        const skillId = pickString(['skill_id', 'skillId'], '未知技能');
        const reason = pickTrimmed(['reason']);
        return reason !== null
          ? `将信任技能 ${skillId}（信任绑定当前包指纹）: ${reason}`
          : `将信任技能 ${skillId}（信任绑定当前包指纹）`;
      }
      case 'mcp_server_update':
      case 'builtin-mcp_server_update': {
        const serverId = pickString(['server_id', 'serverId'], '未知服务器');
        const changedFields = object === null
          ? []
          : Object.keys(object).filter(key => key !== 'server_id' && key !== 'serverId' && key !== 'reason');
        return changedFields.length === 0
          ? `将修改 MCP 服务器配置: ${serverId}`
          : `将修改 MCP 服务器配置: ${serverId}（字段: ${changedFields.join(', ')}；修改后自动连测，失败回滚）`;
      }
      case 'mcp_server_set_enabled':
      case 'builtin-mcp_server_set_enabled': {
        const serverId = pickString(['server_id', 'serverId'], '未知服务器');
        const enabled = object?.['enabled'];
        return enabled === true
          ? `将启用 MCP 服务器: ${serverId}`
          : `将停用 MCP 服务器: ${serverId}（断开连接，保留配置与已填密钥）`;
      }
      case 'mcp_server_remove':
      case 'builtin-mcp_server_remove': {
        const serverId = pickString(['server_id', 'serverId'], '未知服务器');
        const transport = pickString(['expected_transport', 'expectedTransport'], '未知传输');
        return `将删除 MCP 服务器: ${serverId}（transport: ${transport}；连同已填密钥一并删除，不可恢复）`;
      }
      case 'custom_agent_propose':
      case 'builtin-custom_agent_propose': {
        const action = field('action') ?? 'propose';
        if (action === 'list') return '将查看待审阅的子代理 persona 提案列表';
        if (action === 'reject') {
          const proposalId = pickString(['proposal_id', 'proposalId'], '未知提案');
          return `将拒绝子代理 persona 提案: ${proposalId}`;
        }
        const fileName = pickString(['file_name', 'fileName'], '未知文件');
        return `将起草子代理 persona 提案: ${fileName}（写入 pending 提案区，不落盘 agents/，生效需后续审批）`;
      }
      case 'custom_agent_apply':
      case 'builtin-custom_agent_apply': {
        const fileName = pickString(['file_name', 'fileName'], '未知文件');
        const summary = pickTrimmed(['change_summary', 'changeSummary']);
        return summary !== null
          ? `将写入自定义子代理 persona ${fileName}: ${summary}`
          : `将写入自定义子代理 persona: workspaces/agents/${fileName}`;
      }
      case 'custom_agent_remove':
      case 'builtin-custom_agent_remove': {
        const fileName = pickString(['file_name', 'fileName'], '未知文件');
        const title = pickTrimmed(['title']);
        return title !== null
          ? `将删除自定义子代理 persona: ${fileName}（${title}，不可恢复）`
          : `将删除自定义子代理 persona: ${fileName}（不可恢复）`;
      }
      default:
        return `将执行工具: ${toolName}`;
    }
  }
}

export default ApprovalManager;
