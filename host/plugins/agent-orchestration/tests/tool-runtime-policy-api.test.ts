import { afterEach, describe, expect, it } from 'vitest';
import {
  executionPolicyAllows, installTrustedAutomationSession,
  trustedAutomationError, trustedAutomationPreauthorized, type TrustedSessionGuard,
} from '../api.ts';
import { setHeadlessPolicyLogger } from '../src/headless.ts';
import type { TrustedAutomationProfile } from '../src/trusted-profile.ts';

function profile(): TrustedAutomationProfile {
  return {
    schemaVersion: 1, profileHash: 'pinned-profile',
    allowedTools: ['builtin-workspace_change_revert', 'builtin-attachment_stage'],
    runtimeRoots: [{ rootId: 'workspace', access: 'read_write' }],
    shellCommandPrefixes: [], networkDomains: ['example.com'], maxToolRounds: 4,
    timeoutSeconds: 120, maxOutputBytes: 4096, rollbackRequired: true,
  };
}

describe('published L06 ChatToolRuntime gate policies', () => {
  const guards: TrustedSessionGuard[] = [];
  afterEach(() => {
    for (const guard of guards.splice(0)) guard.release();
    setHeadlessPolicyLogger(undefined);
  });
  function install(sessionId: string, value = profile()) {
    const guard = installTrustedAutomationSession(sessionId, value)!;
    guards.push(guard);
    return guard;
  }

  it('maps no-profile/valid/invalid Rust Result values without granting ordinary sessions preauthorization', () => {
    expect(trustedAutomationError('ordinary', 'builtin-any_tool', {})).toBeNull();
    expect(trustedAutomationPreauthorized('ordinary', 'builtin-any_tool', {})).toBe(false);
    const guard = install('pinned');
    expect(trustedAutomationError('pinned', 'workspace_change_revert', { receipt: { root_id: 'workspace' } })).toBeNull();
    expect(trustedAutomationPreauthorized('pinned', 'workspace_change_revert', { receipt: { root_id: 'workspace' } })).toBe(true);
    expect(trustedAutomationError('pinned', 'builtin-ask_user', {}))
      .toBe("Tool 'builtin-ask_user' is not allowed by the trusted automation profile");
    expect(trustedAutomationError('pinned', 'workspace_change_revert', {}))
      .toBe('Trusted automation runtime tools require explicit root_id');
    expect(trustedAutomationPreauthorized('pinned', 'workspace_change_revert', {})).toBe(false);
    guard.release();
    expect(trustedAutomationPreauthorized('pinned', 'workspace_change_revert', { root_id: 'workspace' })).toBe(false);
  });

  it('revalidates trusted domains including arrays and does not preauthorize readonly tools merely from the headless list', () => {
    install('network');
    expect(trustedAutomationError('network', 'web_fetch', { url: 'https://outside.test' }))
      .toBe('Explicit network target is outside trusted-profile domains');
    expect(trustedAutomationError('network', 'web_fetch', [{ url: 'https://outside.test' }]))
      .toBe('Explicit network target is outside trusted-profile domains');
    expect(trustedAutomationError('network', 'web_fetch', { url: 'https://example.com' })).toBeNull();
    expect(trustedAutomationPreauthorized('network', 'web_fetch', { url: 'https://example.com' })).toBe(false);
  });

  it('uses the exact Rust write-tool set and root_id-before-rootId Option chain', () => {
    const value = profile();
    value.allowedTools = ['builtin-local_shell_preflight', 'builtin-workspace_change_revert'];
    value.runtimeRoots = [{ rootId: 'workspace', access: 'read_only' }];
    value.shellCommandPrefixes = ['pwd'];
    install('readonly-preflight', value);
    const preflight = { root_id: 'workspace', command: 'pwd', max_output_bytes: 1024 };
    expect(trustedAutomationError('readonly-preflight', 'local_shell_preflight', preflight)).toBeNull();
    expect(trustedAutomationPreauthorized('readonly-preflight', 'local_shell_preflight', preflight)).toBe(true);
    expect(trustedAutomationError('readonly-preflight', 'local_shell_preflight',
      { ...preflight, root_id: null, rootId: 'workspace' }))
      .toBe('Trusted automation runtime tools require explicit root_id');
    expect(trustedAutomationError('readonly-preflight', 'local_shell_preflight',
      { ...preflight, root_id: null, rootId: 'ignored', receipt: { root_id: 'workspace' } })).toBeNull();
  });

  it('clones pinned profiles on installation, as Rust does, and records validation/rollback/success branches', () => {
    // Only the logging sink is observed; all policy decisions use the real owner implementation.
    const warn: string[] = [];
    const info: string[] = [];
    const error: string[] = [];
    setHeadlessPolicyLogger({ warn: (s) => warn.push(s), info: (s) => info.push(s), error: (s) => error.push(s) });
    const value = profile();
    install('clone', value);
    value.allowedTools.push('builtin-ask_user');
    expect(trustedAutomationError('clone', 'builtin-ask_user', {}))
      .toBe("Tool 'builtin-ask_user' is not allowed by the trusted automation profile");
    expect(trustedAutomationPreauthorized('clone', 'workspace_change_revert', { root_id: 'missing' })).toBe(false);
    expect(warn).toEqual(["[ChatV2::headless] trusted automation preauthorization denied: session=clone, tool=workspace_change_revert, reason=Runtime root 'missing' is not allowed by the trusted profile"]);
    expect(trustedAutomationPreauthorized('clone', 'attachment_stage', {})).toBe(false);
    expect(warn[1]).toBe("[ChatV2::headless] trusted automation write tool 'attachment_stage' has no verified rollback path; falling back to manual approval (session=clone, rollback_required=true)");
    expect(trustedAutomationPreauthorized('clone', 'workspace_change_revert', { root_id: 'workspace' })).toBe(true);
    expect(info).toEqual(['[ChatV2::headless] trusted_automation_preauthorized: session=clone, tool=workspace_change_revert, profile_hash=pinned-profile']);
    install('clone');
    expect(error).toEqual(['[ChatV2::headless] trusted profile install OVERWROTE existing profile: session=clone, previous_hash=pinned-profile']);
  });

  it('keeps the full tool-policy null/empty/control/builtin/MCP isolation semantics', () => {
    expect(executionPolicyAllows('any', {}, null)).toBe(true);
    expect(executionPolicyAllows('any', {}, [])).toBe(false);
    expect(executionPolicyAllows('attempt_completion', {}, [])).toBe(true);
    expect(executionPolicyAllows('attempt_completion', { _serverId: 'srv' }, [])).toBe(false);
    expect(executionPolicyAllows('builtin-web_search', {}, ['web_search'])).toBe(true);
    expect(executionPolicyAllows('builtin-web_search', {}, ['\uFEFFweb_search'])).toBe(false);
    expect(executionPolicyAllows('mcp_web_search', {}, ['web_search'])).toBe(false);
    expect(executionPolicyAllows('web_search', { _serverId: 'srv' }, ['web_search'])).toBe(false);
    expect(executionPolicyAllows('web_search', { _serverId: 'srv' }, ['srv::web_search'])).toBe(true);
    expect(executionPolicyAllows('web_search', { _serverId: 'other' }, ['srv::web_search'])).toBe(false);
  });
});
