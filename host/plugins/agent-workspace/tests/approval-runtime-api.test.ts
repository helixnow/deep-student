import { expect, it } from 'vitest';
import {
  isLocalShellExecuteTool, isPrivilegeEscalationToolForArgs, neverRememberApprovalForArgs,
  redactToolArgumentsForDisplay, runtimeRootBindingFromArgs, makeRuntimeScopeKey,
  makeRuntimeApprovalScope,
} from '../api.ts';
import { createWorkspaceHost } from './host-support.ts';

it('ChatToolRuntime can consume the real approval provider with permission presets and descriptions', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const manager = host.ctx.agentApproval;
    const args = { root_id: 'workspace', path: 'report.md' };
    const pending = manager.registerWithPermissionPreset('s', 'c', 'workspace_file_write', args, 'relaxed', 'medium');
    expect(manager.defaultTimeout()).toBe(300);
    expect(manager.generateDescription('builtin-local_shell_execute', { command: 'echo safe' })).toBe('将执行命令: echo safe');
    expect(manager.respondWithResult({ sessionId: 's', toolCallId: 'c', toolName: 'workspace_file_write', approved: true,
      reason: null, remember: true, rememberSession: true })).toEqual({ delivered: true, settingKey: null });
    await expect(pending).resolves.toMatchObject({ approved: true, reason: null });
    expect(manager.checkSessionRemembered('s', 'workspace_file_write', args)).toBe(true);
    expect(manager.checkSessionRemembered('other', 'workspace_file_write', args)).toBeNull();
    const cautious = manager.registerWithPermissionPreset('s', 'c2', 'test_tool', {}, 'cautious', 'medium');
    manager.respond({ sessionId: 's', toolCallId: 'c2', toolName: 'test_tool', approved: true,
      reason: null, remember: true, rememberSession: true });
    await expect(cautious).resolves.toMatchObject({ approved: true });
    expect(manager.checkSessionRemembered('s', 'test_tool', {})).toBeNull();
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('publishes owner approval-scope functions rather than local-shell name heuristics', () => {
  const args = { command: 'echo safe', root_id: 'workspace', _runtimeRootBinding: 'bound' };
  expect(isLocalShellExecuteTool('builtin-local_shell_execute', args)).toBe(true);
  expect(isLocalShellExecuteTool('mcp_builtin-local_shell_execute', args)).toBe(false);
  expect(isPrivilegeEscalationToolForArgs('builtin-runtime_root_request', {})).toBe(true);
  expect(neverRememberApprovalForArgs('builtin-runtime_root_request', {})).toBe(true);
  expect(runtimeRootBindingFromArgs(args)).toBe('bound');
  expect(makeRuntimeScopeKey('builtin-local_shell_execute', args)).toContain('binding=bound');
  expect(makeRuntimeApprovalScope('builtin-local_shell_execute', args, 'medium')).toMatchObject({ rootBinding: 'bound' });
  const redacted = redactToolArgumentsForDisplay('builtin-local_shell_execute', { command: 'curl --token secret-value' });
  expect(JSON.stringify(redacted)).not.toContain('secret-value');
});
