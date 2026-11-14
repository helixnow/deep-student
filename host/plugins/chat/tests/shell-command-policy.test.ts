import { describe, expect, it } from 'vitest';
import {
  enforceShellCommandPolicy, applyShellCommandSensitivity, shellCommandDecision,
  SHELL_COMMAND_RULES_KEY,
} from '../../agent-workspace/api.ts';

// The policy already has one production owner: L05's local shell preflight and
// execution both call it. Exercise that public API, rather than a second policy
// or a registry populated with artificial executors.
function policy(rules: unknown[]): string {
  return JSON.stringify({ version: 1, default_effect: 'ask', rules });
}

describe('shell_command_policy.rs through the production policy API', () => {
  it('invalid_json_and_empty_rule_fail_closed', () => {
    expect(enforceShellCommandPolicy('{', 'ls', true).effective_effect).toBe('ask');
    expect(enforceShellCommandPolicy('{', 'ls', true).config_valid).toBe(false);
    const empty = policy([
      { id: 'empty', effect: 'allow', match: { kind: 'prefix', value: '' } },
    ]);
    // Rust :352 asserts parse_policy(empty).is_err(). The public enforcement
    // boundary exposes that same parse failure as config_valid=false (:289–295).
    expect(enforceShellCommandPolicy(empty, 'ls', true).config_valid).toBe(false);
    expect(enforceShellCommandPolicy(empty, 'ls', true).effective_effect).toBe('ask');
  });

  it('deny_wins_over_ask_and_allow', () => {
    const raw = policy([
      { id: 'allow-ls', effect: 'allow', match: { kind: 'executable', value: 'ls' } },
      { id: 'ask-ls', effect: 'ask', match: { kind: 'prefix', value: 'ls' } },
      { id: 'deny-exact', effect: 'deny', match: { kind: 'exact', value: 'ls -la' } },
    ]);
    const decision = enforceShellCommandPolicy(raw, 'ls -la', true);
    expect(decision.effective_effect).toBe('deny');
    expect(decision.matched_rule_id).toBe('deny-exact');
  });

  it('prefix_requires_token_boundary', () => {
    const raw = policy([
      { id: 'deny-rm', effect: 'deny', match: { kind: 'prefix', value: 'rm' } },
    ]);
    expect(enforceShellCommandPolicy(raw, 'rm -f x', true).effective_effect).toBe('deny');
    expect(enforceShellCommandPolicy(raw, 'rmdir x', true).effective_effect).toBe('ask');
  });

  it('safe_local_allow_does_not_cross_external_or_effectful_boundaries', () => {
    const raw = policy([
      { id: 'allow-ls', effect: 'allow', match: { kind: 'executable', value: 'ls' } },
      { id: 'allow-echo', effect: 'allow', match: { kind: 'executable', value: 'echo' } },
      { id: 'allow-rg', effect: 'allow', match: { kind: 'executable', value: 'rg' } },
      { id: 'allow-git', effect: 'allow', match: { kind: 'executable', value: 'git' } },
      { id: 'allow-curl', effect: 'allow', match: { kind: 'executable', value: 'curl' } },
      { id: 'allow-rm', effect: 'allow', match: { kind: 'executable', value: 'rm' } },
      { id: 'allow-python', effect: 'allow', match: { kind: 'executable', value: 'python' } },
    ]);
    expect(enforceShellCommandPolicy(raw, 'ls -la', true).effective_effect).toBe('ask');
    expect(enforceShellCommandPolicy(raw, 'echo ready', false).effective_effect).toBe('ask');
    for (const command of [
      'ls | cat',
      'ls && curl https://example.com',
      'ls > listing.txt',
      'ls $(curl https://example.com)',
      'git status; rm -rf x',
      'git push origin main',
      'git config --global user.name example',
      'git branch -D old-branch',
      'rg --pre=/tmp/processor pattern .',
      'curl https://example.com',
      'rm -f x',
      "python -c 'print(1)'",
      'sudo ls',
      'du -sh .',
    ]) {
      expect(enforceShellCommandPolicy(raw, command, true).effective_effect, command).not.toBe('allow');
    }
    expect(enforceShellCommandPolicy(raw, 'git status --short', true).effective_effect).toBe('ask');
    expect(enforceShellCommandPolicy(raw, 'echo ready', true).effective_effect).toBe('allow');
    // Rust :443 cfg(not(windows)) guards only this assertion, not the whole test.
    if (process.platform !== 'win32') {
      expect(enforceShellCommandPolicy(raw, '/bin/ls -la', true).effective_effect).toBe('allow');
    }
  });

  it('allow_never_downgrades_path_shadowable_or_subprocess_capable_commands', () => {
    const defaultAllow = JSON.stringify({ version: 1, default_effect: 'allow', rules: [] });
    for (const command of ['ls -la', 'cat README.md', 'grep needle README.md', 'stat README.md']) {
      expect(enforceShellCommandPolicy(defaultAllow, command, true).effective_effect,
        `bare PATH-resolved executable must not bypass approval: ${command}`).toBe('ask');
    }
    for (const command of [
      '/usr/bin/rg --pre=/tmp/processor needle .',
      '/usr/bin/git status --short',
      '/usr/bin/git diff --ext-diff',
      '/usr/bin/git show --textconv HEAD:file',
      '/usr/bin/git -c core.fsmonitor=/tmp/hook status',
      '/usr/bin/git -c diff.external=/tmp/differ diff',
    ]) {
      expect(enforceShellCommandPolicy(defaultAllow, command, true).effective_effect,
        `subprocess-capable command family must not bypass approval: ${command}`).toBe('ask');
    }
    expect(enforceShellCommandPolicy(defaultAllow, 'echo ready', true).effective_effect).toBe('allow');
    if (process.platform !== 'win32') {
      expect(enforceShellCommandPolicy(defaultAllow, '/usr/bin/grep needle README.md', true).effective_effect).toBe('allow');
    }
  });

  it('executable_rules_match_auditable_basename_case_insensitively', () => {
    const raw = policy([
      { id: 'deny-git', effect: 'deny', match: { kind: 'executable', value: 'GIT' } },
    ]);
    expect(enforceShellCommandPolicy(raw, '/usr/bin/git status', true).effective_effect).toBe('deny');
  });

  it('ask_forces_low_executor_to_medium_and_default_deny_blocks', () => {
    const decision = enforceShellCommandPolicy(null, 'ls', true);
    expect(applyShellCommandSensitivity(decision, 'low')).toBe('medium');
    const defaultDeny = JSON.stringify({ version: 1, default_effect: 'deny', rules: [] });
    expect(enforceShellCommandPolicy(defaultDeny, 'ls', true).effective_effect).toBe('deny');

    // Also exercise the existing concrete-call approval API, including its
    // actual settings key. No shell process or replacement executor is needed.
    const call = { name: 'builtin-local_shell_execute', arguments: { command: 'ls' } };
    expect(shellCommandDecision(call, true, null)?.applyToSensitivity('low')).toBe('medium');
    const keys: string[] = [];
    const denied = shellCommandDecision(call, true, {
      get(key) { keys.push(key); return defaultDeny; },
    });
    expect(keys).toEqual([SHELL_COMMAND_RULES_KEY]);
    expect(denied?.deny).toBe(true);
    expect(denied?.applyToSensitivity('low')).toBe('high');
  });

  it('prefix_does_not_match_a_longer_partial_token', () => {
    const raw = policy([
      { id: 'deny-git-stat', effect: 'deny', match: { kind: 'prefix', value: 'git stat' } },
    ]);
    expect(enforceShellCommandPolicy(raw, 'git stat --short', true).effective_effect).toBe('deny');
    expect(enforceShellCommandPolicy(raw, 'git status --short', true).effective_effect).toBe('ask');
  });
});
