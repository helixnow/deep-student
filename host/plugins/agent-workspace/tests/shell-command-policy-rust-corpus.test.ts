/** `chat_v2/shell_command_policy.rs` mod tests, case for case, against the TS `enforceForCall`. */
import { describe, expect, it } from 'vitest';
import { applyToSensitivity, enforceForCall, parsePolicy } from '../src/tools/shell-policy.ts';

function policy(rules: unknown[]): string {
  return JSON.stringify({ version: 1, default_effect: 'ask', rules });
}

const notWindows = process.platform !== 'win32';

describe('shell_command_policy.rs tests', () => {
  it('invalid_json_and_empty_rule_fail_closed', () => {
    expect(enforceForCall('{', 'ls', true).effective_effect).toBe('ask');
    expect(enforceForCall('{', 'ls', true).config_valid).toBe(false);
    const empty = policy([{ id: 'empty', effect: 'allow', match: { kind: 'prefix', value: '' } }]);
    expect(() => parsePolicy(empty)).toThrow();
    expect(enforceForCall(empty, 'ls', true).effective_effect).toBe('ask');
  });

  it('deny_wins_over_ask_and_allow', () => {
    const raw = policy([
      { id: 'allow-ls', effect: 'allow', match: { kind: 'executable', value: 'ls' } },
      { id: 'ask-ls', effect: 'ask', match: { kind: 'prefix', value: 'ls' } },
      { id: 'deny-exact', effect: 'deny', match: { kind: 'exact', value: 'ls -la' } },
    ]);
    const decision = enforceForCall(raw, 'ls -la', true);
    expect(decision.effective_effect).toBe('deny');
    expect(decision.matched_rule_id).toBe('deny-exact');
  });

  it('prefix_requires_token_boundary', () => {
    const raw = policy([{ id: 'deny-rm', effect: 'deny', match: { kind: 'prefix', value: 'rm' } }]);
    expect(enforceForCall(raw, 'rm -f x', true).effective_effect).toBe('deny');
    expect(enforceForCall(raw, 'rmdir x', true).effective_effect).toBe('ask');
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
    expect(enforceForCall(raw, 'ls -la', true).effective_effect).toBe('ask');
    expect(enforceForCall(raw, 'echo ready', false).effective_effect).toBe('ask');
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
      expect(enforceForCall(raw, command, true).effective_effect, command).not.toBe('allow');
    }
    expect(enforceForCall(raw, 'git status --short', true).effective_effect).toBe('ask');
    expect(enforceForCall(raw, 'echo ready', true).effective_effect).toBe('allow');
    if (notWindows) expect(enforceForCall(raw, '/bin/ls -la', true).effective_effect).toBe('allow');
  });

  it('allow_never_downgrades_path_shadowable_or_subprocess_capable_commands', () => {
    const defaultAllow = JSON.stringify({ version: 1, default_effect: 'allow', rules: [] });
    for (const command of ['ls -la', 'cat README.md', 'grep needle README.md', 'stat README.md']) {
      expect(enforceForCall(defaultAllow, command, true).effective_effect,
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
      expect(enforceForCall(defaultAllow, command, true).effective_effect,
        `subprocess-capable command family must not bypass approval: ${command}`).toBe('ask');
    }
    expect(enforceForCall(defaultAllow, 'echo ready', true).effective_effect).toBe('allow');
    if (notWindows) {
      expect(enforceForCall(defaultAllow, '/usr/bin/grep needle README.md', true).effective_effect).toBe('allow');
    }
  });

  it('executable_rules_match_auditable_basename_case_insensitively', () => {
    const raw = policy([{ id: 'deny-git', effect: 'deny', match: { kind: 'executable', value: 'GIT' } }]);
    expect(enforceForCall(raw, '/usr/bin/git status', true).effective_effect).toBe('deny');
  });

  it('ask_forces_low_executor_to_medium_and_default_deny_blocks', () => {
    const decision = enforceForCall(null, 'ls', true);
    expect(applyToSensitivity(decision, 'low')).toBe('medium');
    const defaultDeny = JSON.stringify({ version: 1, default_effect: 'deny', rules: [] });
    expect(enforceForCall(defaultDeny, 'ls', true).effective_effect).toBe('deny');
  });

  it('prefix_does_not_match_a_longer_partial_token', () => {
    const raw = policy([{ id: 'deny-git-stat', effect: 'deny', match: { kind: 'prefix', value: 'git stat' } }]);
    expect(enforceForCall(raw, 'git stat --short', true).effective_effect).toBe('deny');
    expect(enforceForCall(raw, 'git status --short', true).effective_effect).toBe('ask');
  });
});
