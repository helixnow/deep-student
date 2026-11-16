/**
 * F17: once a user plugin's tool brought external data into a turn, a high-sensitivity tool call in the same turn asks
 * the user even under full access; other turns and medium calls keep the preset's behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGateHook, type ApprovalGatePorts, type ToolHookContext } from '../src/approval-gate.ts';
import { ToolAdmission } from '../src/hooks.ts';
import { markExternalPluginData, resetExternalPluginDataForTest } from '../../agent-skills/src/tools/external-data-taint.ts';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function ports(sensitivity: 'medium' | 'high', register: ReturnType<typeof vi.fn>): ApprovalGatePorts {
  return {
    killSwitchError: () => null, executionPolicyAllows: () => true, trustedAutomationError: () => null,
    trustedAutomationPreauthorized: () => false, isLocalShell: () => false, isExternalMcp: () => false, immutableGuard: () => null,
    shellCommandDecision: () => null, resolveLocalShellApprovalArguments: () => ({ ok: true, value: null }), runtimeRootBinding: () => null,
    runtimeScopeKey: () => '', baseSensitivity: () => sensitivity, effectiveSensitivity: base => base,
    authorityState: () => ({ authorityMode: 'craft', permissionPreset: 'full_access', plan: null }),
    consumePlanBinding: () => true, newPendingPlan: () => ({ planId: 'p', markApproved: () => {} }), setPlanState: () => {},
    isPrivilegeEscalation: () => false, neverRememberApproval: () => false, redactForDisplay: (_name, args) => args,
    runtimeApprovalScope: () => null,
    approvalManager: { defaultTimeout: () => 5, checkSessionRemembered: () => null, registerWithPermissionPreset: register as never,
      cancelWithSession: () => {}, generateDescription: () => 'd' },
    planGates: {} as never,
  } as ApprovalGatePorts;
}

function context(messageId: string): ToolHookContext {
  const emitter = { emitStart: vi.fn(), emitEnd: vi.fn(), emitError: vi.fn(), emitStartWithMeta: vi.fn(), emitErrorWithMeta: vi.fn() };
  return { toolCall: { id: 'call_1', name: 'builtin-note_delete', arguments: {} }, blockId: 'blk', emitter: emitter as never, sessionId: 'sess',
    messageId, variantId: null, skillStateVersion: null, roundId: null, skillPackageRoots: null, executionAllowedTools: null,
    cancellation: null, memoryEnabled: true, ragEnabled: true, webSearchEnabled: true };
}

describe('external plugin data forces approval of high-sensitivity calls in the same turn', () => {
  afterEach(() => resetExternalPluginDataForTest());

  it('asks under full access after a plugin tool read external data in this turn', async () => {
    const register = vi.fn(async () => ({ approved: true, reason: null }));
    const gate = new ApprovalGateHook(ports('high', register), log);
    markExternalPluginData('sess', 'msg_tainted', '课表');
    const admission = new ToolAdmission();
    await expect(gate.beforeTool(context('msg_tainted'), admission)).resolves.toEqual({ kind: 'proceed' });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('keeps full access silent in other turns and for medium calls', async () => {
    const register = vi.fn(async () => ({ approved: true, reason: null }));
    markExternalPluginData('sess', 'msg_tainted', '课表');
    await expect(new ApprovalGateHook(ports('high', register), log).beforeTool(context('msg_clean'), new ToolAdmission())).resolves.toEqual({ kind: 'proceed' });
    await expect(new ApprovalGateHook(ports('medium', register), log).beforeTool(context('msg_tainted'), new ToolAdmission())).resolves.toEqual({ kind: 'proceed' });
    expect(register).not.toHaveBeenCalled();
  });

  it('blocks the call when the user rejects it', async () => {
    const register = vi.fn(async () => ({ approved: false, reason: null }));
    markExternalPluginData('sess', 'msg_tainted', '课表');
    const outcome = await new ApprovalGateHook(ports('high', register), log).beforeTool(context('msg_tainted'), new ToolAdmission());
    expect(outcome.kind).toBe('block');
  });
});
