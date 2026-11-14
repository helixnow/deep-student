/**
 * Mobile `agentApproval` provider.
 *
 * The desktop provider lives in `dstu.agent-workspace` (`ApprovalManager`), whose module pulls the
 * Node-only approval-scope environment. The mobile profile does not install that plugin, so without
 * this provider `approval-gate.ts` refuses every medium/high-sensitivity tool with
 * "审批服务不可用" — the AI tool runtime would be advertised but unusable for writes.
 *
 * Semantics of the manager itself are transport-independent (`chat_v2/approval_manager.rs`): a
 * pending call is a promise resolved by `respond*`, cancelled by `cancel*`, or abandoned when the
 * pipeline's own timeout wins. Remembered approvals are not persisted on mobile; the front-end
 * approval request still travels through the same `chat_v2_tool_approval_request` event.
 */
import type {
  ApprovalManager, ApprovalRespondResult, ApprovalResponse, JsonValue, PermissionPreset,
  ToolApprovalManager, ToolSensitivity,
} from '../../agent-workspace/api.ts';

interface PendingApproval {
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly resolve: (response: ApprovalResponse) => void;
}

const CANCELLED_REASON = 'tool approval cancelled';

export class MobileApprovalManager implements ToolApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  register(toolCallId: string): Promise<ApprovalResponse> {
    return this.registerWithScope('', toolCallId, '', null);
  }

  registerWithScope(sessionId: string, toolCallId: string, toolName: string, _argumentsValue: JsonValue): Promise<ApprovalResponse> {
    return this.enqueue(sessionId, toolCallId, toolName);
  }

  registerWithPermissionPreset(sessionId: string, toolCallId: string, toolName: string, _argumentsValue: JsonValue,
    _preset: PermissionPreset, _sensitivity: ToolSensitivity): Promise<ApprovalResponse> {
    return this.enqueue(sessionId, toolCallId, toolName);
  }

  private enqueue(sessionId: string, toolCallId: string, toolName: string): Promise<ApprovalResponse> {
    // A retried call reuses the id: settle the stale waiter instead of leaking it.
    this.cancel(toolCallId);
    return new Promise<ApprovalResponse>(resolve => {
      this.pending.set(toolCallId, { toolCallId, sessionId, toolName, resolve });
    });
  }

  respond(response: ApprovalResponse): boolean {
    return this.respondWithResult(response).delivered;
  }

  respondWithResult(response: ApprovalResponse): ApprovalRespondResult {
    const pending = this.pending.get(response.toolCallId);
    if (pending === undefined) return { delivered: false, settingKey: null };
    this.pending.delete(response.toolCallId);
    pending.resolve({
      sessionId: response.sessionId || pending.sessionId,
      toolCallId: pending.toolCallId,
      toolName: response.toolName || pending.toolName,
      approved: response.approved,
      reason: response.reason,
      remember: false,
      rememberSession: false,
    });
    return { delivered: true, settingKey: null };
  }

  cancelWithSession(sessionId: string, toolCallId: string): boolean {
    const pending = this.pending.get(toolCallId);
    if (pending === undefined || (sessionId !== '' && pending.sessionId !== sessionId)) return false;
    return this.cancel(toolCallId);
  }

  rejectAllPending(reason: string): number {
    let count = 0;
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.toolCallId);
      pending.resolve({
        sessionId: pending.sessionId, toolCallId: pending.toolCallId, toolName: pending.toolName,
        approved: false, reason, remember: false, rememberSession: false,
      });
      count += 1;
    }
    return count;
  }

  cancel(toolCallId: string): boolean {
    const pending = this.pending.get(toolCallId);
    if (pending === undefined) return false;
    this.pending.delete(toolCallId);
    pending.resolve({
      sessionId: pending.sessionId, toolCallId: pending.toolCallId, toolName: pending.toolName,
      approved: false, reason: CANCELLED_REASON, remember: false, rememberSession: false,
    });
    return true;
  }

  checkRemembered(_toolName: string, _argumentsValue: JsonValue): boolean | null {
    return null;
  }

  checkSessionRemembered(_sessionId: string, _toolName: string, _argumentsValue: JsonValue): boolean | null {
    return null;
  }

  clearSessionRemembered(_sessionId: string): void {}

  clearRemembered(_toolName: string, _argumentsValue: JsonValue): void {}

  clearAllRemembered(): void {}

  defaultTimeout(): number {
    return 300;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  generateDescription(toolName: string, argumentsValue: JsonValue): string {
    let args: string;
    try { args = JSON.stringify(argumentsValue); }
    catch { args = '[unserializable]'; }
    const trimmed = args.length > 240 ? `${args.slice(0, 240)}…` : args;
    return `${toolName}(${trimmed})`;
  }
}

/** Structural check used by tests and by the plugin's provide guard. */
export function isApprovalManager(value: unknown): value is ApprovalManager {
  return typeof value === 'object' && value !== null
    && typeof (value as ApprovalManager).respond === 'function'
    && typeof (value as ApprovalManager).register === 'function';
}

export { CANCELLED_REASON as MOBILE_APPROVAL_CANCELLED_REASON };
