import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ShellCommandGuardEffect } from '../../agent-workspace/api.ts';
import type { LocalShellCallClassifier } from '../api.ts';
import { createPipelineHost } from './chat-host.ts';
import {
  approvalManagerRequired, defaultPipelineHookNames, DEFAULT_PIPELINE_HOOK_NAMES, ToolAdmission,
} from '../src/hooks.ts';

describe('chat_v2/pipeline/hooks.rs::tests', () => {
  it('catastrophe_guard_is_wired_only_to_backend_local_shell', async () => {
    const host = await createPipelineHost();
    try {
      const local = { id: 'local-catastrophe', name: 'builtin-local_shell_execute', arguments: { command: 'rm -rf /' } };
      const decision = host.ctx.chatPipeline.immutableCommandGuardForToolCall(local);
      expect(decision).not.toBeNull();
      expect(decision!.effect).toBe(ShellCommandGuardEffect.Deny);
      const external = { id: 'external-command', name: 'mcp.tools.local_shell_execute', arguments: { command: 'rm -rf /' } };
      expect(host.ctx.chatPipeline.immutableCommandGuardForToolCall(external)).toBeNull();
    } finally { await host.dispose(); }
  });

  it('immutable guard keeps command string type checking and real Allow/Ask/Deny decisions', async () => {
    const classify = vi.fn<LocalShellCallClassifier>().mockReturnValue(true);
    const host = await createPipelineHost({ provide: { pendingLocalShellClassifier: classify } });
    try {
      const classifier = host.ctx.get('pendingLocalShellClassifier') as LocalShellCallClassifier;
      const check = (args: unknown) => host.ctx.chatPipeline.immutableCommandGuardForToolCall(
        { id: 'call', name: 'local_shell_execute', arguments: args }, classifier);
      for (const args of [null, [], {}, { command: 42 }, { command: null }]) expect(check(args)).toBeNull();
      expect(check({ command: '' })).toMatchObject({ effect: ShellCommandGuardEffect.Deny, reason: 'empty_command' });
      expect(check({ command: 'pwd' })).toMatchObject({ effect: ShellCommandGuardEffect.Allow });
      expect(check({ command: 'pwd && ls' })).toMatchObject({ effect: ShellCommandGuardEffect.Ask });
    } finally { await host.dispose(); }
  });
  it('immutable guard protects the paths-service home, not the process home', async () => {
    const host = await createPipelineHost();
    try {
      const home = host.ctx.paths.os.home;
      expect(home).not.toBe(homedir());
      const check = (command: string) => host.ctx.chatPipeline.immutableCommandGuardForToolCall(
        { id: 'call', name: 'builtin-local_shell_execute', arguments: { command } });
      expect(check(`rm -rf ${home}`)).toMatchObject({ effect: ShellCommandGuardEffect.Deny });
      expect(check(`rm -rf ${homedir()}`)?.reason).not.toBe(check(`rm -rf ${home}`)?.reason);
    } finally { await host.dispose(); }
  });
  it('default_hooks_keep_approval_gate_first', () => {
    // An order-sensitive contract: TaskAuditHook consumes the evidence written
    // by ApprovalGateHook, so admission must always run first.
    expect(defaultPipelineHookNames()).toEqual(['approval_gate', 'task_audit']);
    expect(DEFAULT_PIPELINE_HOOK_NAMES).toEqual(['approval_gate', 'task_audit']);
  });

  it('audit_consumed_admission_fields_start_fail_closed', () => {
    const admission = ToolAdmission.create({ command: 'ls' });

    expect(admission.authorityAdmission()).toBeNull();
    expect(admission.isExternalMcp).toBe(false);
    expect(admission.trustedAutomationPreauthorized).toBe(false);
    // No approval evidence either: the shell guard is not satisfied until the
    // approval gate explicitly records it.
    expect(admission.shellGuardAdmitted()).toBe(false);

    // The mutators record real evidence in the same shape the hooks consume.
    admission.recordAuthorityAdmission('craft', 'relaxed');
    admission.markExternalMcp();
    admission.markTrustedAutomationPreauthorized();
    expect(admission.authorityAdmission()).toEqual(['craft', 'relaxed']);
    expect(admission.isExternalMcp).toBe(true);
    expect(admission.trustedAutomationPreauthorized).toBe(true);
  });

  it('missing_approval_manager_is_fail_closed_for_non_low_sensitivity', () => {
    expect(approvalManagerRequired('low')).toBe(false);
    expect(approvalManagerRequired('medium')).toBe(true);
    expect(approvalManagerRequired('high')).toBe(true);
    expect(approvalManagerRequired(null)).toBe(true);
  });
});
