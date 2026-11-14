import { describe, expect, it } from 'vitest';
import type { AuthorityState } from '../api.ts';
import {
  askBlockStructuredOutput, authorityStateFromMetadata, authorityStateToMetadata,
  evaluateAuthorityGate, isWriteTool, parsePermissionPreset, permissionPresetWireName,
  PlanGateManager, planBindingSatisfiesToolApproval, planCallBindingKey,
  requiresToolApproval, shellGuardAdmitted,
} from '../src/authority-mode.ts';

const craft = (): AuthorityState => ({ authorityMode: 'craft', permissionPreset: 'relaxed', plan: null });
// L04 PlanAuthorityState owns this predicate; fixtures model its approved binding/expiry.
const approvedPlan = (binding: string, until: number) => ({
  isActiveForBinding: (key: string, now: Date) => key === binding && until > now.getTime(),
});

describe('authority_mode.rs::tests', () => {
  it('craft_allows_writes', () => {
    expect(evaluateAuthorityGate(craft(), 'builtin-note_delete', 'high', null, new Date())).toEqual({ kind: 'allow' });
  });
  it('craft_presets_apply_exact_approval_matrix', () => {
    const state = craft();
    expect(state.permissionPreset).toBe('relaxed');
    expect(requiresToolApproval(state, 'medium', 'medium', false, false, false)).toBe(false);
    expect(requiresToolApproval(state, 'high', 'low', false, false, false)).toBe(true);
    expect(requiresToolApproval(state, 'low', 'high', false, false, false)).toBe(true);
    expect(requiresToolApproval(state, null, null, false, false, false)).toBe(true);
    expect(requiresToolApproval(state, 'medium', 'medium', true, false, false)).toBe(true);
    state.permissionPreset = 'cautious';
    expect(requiresToolApproval(state, 'medium', 'medium', false, false, false)).toBe(true);
    expect(requiresToolApproval(state, 'low', 'low', true, false, false)).toBe(true);
    state.permissionPreset = 'full_access';
    expect(requiresToolApproval(state, 'high', 'high', false, false, false)).toBe(false);
    expect(requiresToolApproval(state, 'high', 'high', false, false, true)).toBe(true);
    expect(requiresToolApproval(state, 'high', 'high', true, false, false)).toBe(false);
    expect(requiresToolApproval(state, 'high', 'high', true, true, false)).toBe(false);
    state.permissionPreset = 'danger_full_access';
    expect(requiresToolApproval(state, 'high', 'high', true, false, false)).toBe(false);
    expect(requiresToolApproval(state, 'low', 'low', false, false, true)).toBe(true);
  });
  it('ask_and_plan_ignore_full_access_presets', () => {
    for (const authorityMode of ['ask', 'plan'] as const) {
      const state: AuthorityState = { authorityMode, permissionPreset: 'danger_full_access', plan: null };
      expect(requiresToolApproval(state, 'high', 'high', false, false, false)).toBe(true);
      expect(requiresToolApproval(state, 'low', 'low', true, false, false)).toBe(true);
      expect(requiresToolApproval(state, 'low', 'low', false, false, true)).toBe(true);
    }
  });
  it('shell_guard_admission_accepts_full_access_bypass_or_explicit_approval', () => {
    expect(shellGuardAdmitted(true, false, false)).toBe(true);
    expect(shellGuardAdmitted(true, true, true)).toBe(true);
    expect(shellGuardAdmitted(true, true, false)).toBe(false);
    expect(shellGuardAdmitted(false, false, false)).toBe(false);
  });
  it('ask_blocks_medium_write_and_allows_low', () => {
    const state: AuthorityState = { ...craft(), authorityMode: 'ask' };
    const blocked = evaluateAuthorityGate(state, 'builtin-memory_export_all', 'medium', null, new Date());
    expect(blocked.kind).toBe('blockAsk');
    if (blocked.kind !== 'blockAsk') throw new Error('expected BlockAsk');
    expect(blocked.message).toContain('AUTHORITY_BLOCKED');
    expect(blocked.message).toContain('suggestedMode=plan');
    expect(evaluateAuthorityGate(state, 'builtin-memory_search', 'low', null, new Date())).toEqual({ kind: 'allow' });
  });
  it('meta_tools_are_never_writes', () => {
    for (const name of ['attempt_completion', 'builtin-attempt_completion', 'todo_update', 'builtin-todo_init', 'load_skills', 'ask_user', 'builtin-ask_user']) {
      expect(isWriteTool(name, 'high'), name).toBe(false);
    }
  });
  it('plan_approved_binding_skips_secondary_tool_approval', () => {
    const state: AuthorityState = { ...craft(), authorityMode: 'plan' };
    const now = new Date();
    const binding = planCallBindingKey('builtin-note_delete', { id: 1 }, 'r1');
    expect(planBindingSatisfiesToolApproval(state, binding, false, true, now)).toBe(true);
    expect(planBindingSatisfiesToolApproval(state, binding, true, true, now)).toBe(false);
    state.plan = approvedPlan(binding, now.getTime() + 600_000);
    expect(planBindingSatisfiesToolApproval(state, binding, false, false, now)).toBe(true);
    expect(planBindingSatisfiesToolApproval(state, 'planbind:other', false, false, now)).toBe(false);
    state.authorityMode = 'craft';
    expect(planBindingSatisfiesToolApproval(state, binding, false, true, now)).toBe(false);
  });
  it('plan_waits_without_approval_then_allows_active_batch', () => {
    const state: AuthorityState = { ...craft(), authorityMode: 'plan' };
    const now = new Date();
    expect(evaluateAuthorityGate(state, 'builtin-note_delete', 'high', null, now).kind).toBe('waitPlanGate');
    const binding = planCallBindingKey('builtin-note_delete', { id: 1 }, 'r1');
    state.plan = approvedPlan(binding, now.getTime() + 600_000);
    expect(evaluateAuthorityGate(state, 'builtin-note_delete', 'high', binding, now)).toEqual({ kind: 'allow' });
    state.plan = approvedPlan(binding, now.getTime() - 1000);
    expect(evaluateAuthorityGate(state, 'builtin-note_delete', 'high', binding, now).kind).toBe('waitPlanGate');
  });
  it('ask_gate_prevents_executor_invocation', async () => {
    let calls = 0;
    const decision = evaluateAuthorityGate({ ...craft(), authorityMode: 'ask' }, 'fake_write_tool', 'medium', null, new Date());
    if (decision.kind === 'allow') calls++;
    expect(decision.kind).toBe('blockAsk');
    if (decision.kind !== 'blockAsk') throw new Error('Ask must block writes');
    expect(calls).toBe(0);
    expect(decision.message).toContain('AUTHORITY_BLOCKED');
    expect(askBlockStructuredOutput('fake_write_tool').authorityBlocked).toBe(true);
    expect(calls).toBe(0);
  });
  it('plan_gate_manager_delivers_approval', async () => {
    const manager = new PlanGateManager().withTimeout(5);
    const rx = manager.register('sess_1', 'call_1', 'plan_abc');
    expect(manager.respond({ sessionId: 'sess_1', planId: 'plan_abc', toolCallId: 'call_1', approved: true })).toBe(true);
    const response = await rx;
    expect(response.approved).toBe(true);
    expect(response.planId).toBe('plan_abc');
  });
  it('plan_gate_manager_rejects_wrong_plan_id_without_consuming_waiter', async () => {
    const manager = new PlanGateManager().withTimeout(5);
    const rx = manager.register('sess_1', 'call_1', 'plan_expected');
    expect(manager.respond({ sessionId: 'sess_1', planId: 'plan_stale', toolCallId: 'call_1', approved: true })).toBe(false);
    expect(manager.respond({ sessionId: 'sess_1', planId: 'plan_expected', toolCallId: 'call_1', approved: true })).toBe(true);
    expect((await rx).planId).toBe('plan_expected');
  });
  it('plan_binding_is_canonical_and_round_scoped', () => {
    const a = planCallBindingKey('builtin-note_delete', { b: 2, a: 1 }, 'r1');
    expect(a).toBe(planCallBindingKey('note_delete', { a: 1, b: 2 }, 'r1'));
    expect(a).not.toBe(planCallBindingKey('note_delete', { a: 1, b: 2 }, 'r2'));
  });
  it('oneshot supersession and cancellation preserve Rust receiver outcomes', async () => {
    const manager = new PlanGateManager();
    expect(manager.defaultTimeout()).toBe(300);
    const first = manager.register('s', 'c', 'p1');
    const second = manager.register('s', 'c', 'p2');
    await expect(first).resolves.toEqual({ sessionId: 's', toolCallId: 'c', planId: '', approved: false, reason: 'superseded' });
    const rejection = expect(second).rejects.toThrow('channel closed');
    manager.cancel('s', 'c');
    await rejection;
    expect(manager.respond({ sessionId: 's', toolCallId: 'c', planId: 'p2', approved: true })).toBe(false);
  });
});

describe('authority_mode.rs::tests (metadata and presets)', () => {
  it('permission_preset_wire_names_are_stable', () => {
    const presets = ['cautious', 'relaxed', 'full_access', 'danger_full_access'] as const;
    for (const preset of presets) {
      expect(permissionPresetWireName(preset)).toBe(preset);
      expect(parsePermissionPreset(preset)).toBe(preset);
    }
    // parse trims and ASCII-lowercases, like PermissionPreset::parse.
    expect(parsePermissionPreset('  FULL_ACCESS ')).toBe('full_access');
    expect(parsePermissionPreset('Danger_Full_Access')).toBe('danger_full_access');
    expect(parsePermissionPreset('unknown')).toBeNull();
  });

  it('metadata_roundtrip_defaults_to_craft', () => {
    expect(authorityStateFromMetadata(null).authorityMode).toBe('craft');

    const withAsk = {
      authorityMode: 'ask' as const,
      permissionPreset: 'relaxed' as const,
      plan: null,
    };
    const meta = authorityStateToMetadata(withAsk, null);
    expect(meta.authorityMode).toBe('ask');
    expect(meta.authority_mode).toBe('ask');
    expect(authorityStateFromMetadata(meta).authorityMode).toBe('ask');

    // snake_case metadata from older builds still loads.
    expect(authorityStateFromMetadata({ authority_mode: 'plan' }).authorityMode)
      .toBe('plan');

    // Unknown values fall back to the craft/relaxed defaults.
    expect(authorityStateFromMetadata({ authorityMode: 'bogus' }).authorityMode)
      .toBe('craft');
    expect(authorityStateFromMetadata({ permissionPreset: 'bogus' }).permissionPreset)
      .toBe('relaxed');
  });
});
