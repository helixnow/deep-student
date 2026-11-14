import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_LIMIT,
  GitToolExecutor,
  GIT_DIFF_MAX_OUTPUT_BYTES,
  MAX_LOG_LIMIT,
  MAX_PATHS,
  argumentsObject,
  buildGitAddCommand,
  buildGitBranchCreateCommand,
  buildGitBranchDeleteCommand,
  buildGitBranchListCommand,
  buildGitBranchSwitchCommand,
  buildGitCommitCommand,
  buildGitDiffCommand,
  buildGitLogCommand,
  buildGitStatusCommand,
  ensureAllowedKeys,
  optionalPaths,
  quoteArg,
  quoteArgPosix,
  quoteArgPowershell,
  validateBranchName,
  validateRepoRelativePath,
} from '../src/tools/git.ts';

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('git executor helpers', () => {
  it('posix_quoting_wraps_and_escapes_single_quotes', () => {
    expect(quoteArgPosix('src/main.rs')).toBe("'src/main.rs'");
    expect(quoteArgPosix('dir with spaces/a.rs')).toBe("'dir with spaces/a.rs'");
    expect(quoteArgPosix("it's")).toBe("'it'\\''s'");
    expect(quoteArgPosix("fix: handle 'x' & `y` $(z)"))
      .toBe("'fix: handle '\\''x'\\'' & `y` $(z)'");
  });

  it('powershell_quoting_doubles_single_quotes', () => {
    expect(quoteArgPowershell('src/main.rs')).toBe("'src/main.rs'");
    expect(quoteArgPowershell("it's")).toBe("'it''s'");
    // single-quoted PowerShell strings need no backtick/dollar escaping
    expect(quoteArgPowershell('a`b $x; y')).toBe("'a`b $x; y'");
  });

  it('RF-S01-git-powershell-typographic-quote: a quoted argument stays one literal token for the PowerShell tokenizer', () => {
    // PowerShell opens and closes single-quoted strings on ' and on U+2018..U+201B; two in a row are one literal quote.
    const singleQuotes = new Set(["'", '\u2018', '\u2019', '\u201A', '\u201B']);
    const readSingleQuoted = (source: string): { value: string; rest: string } => {
      let value = '';
      for (let index = 1; index < source.length; index += 1) {
        const character = source[index]!;
        if (!singleQuotes.has(character)) { value += character; continue; }
        if (!singleQuotes.has(source[index + 1] ?? '')) return { value, rest: source.slice(index + 1) };
        value += character;
        index += 1;
      }
      throw new Error('unterminated string');
    };
    for (const value of ['Fix the user\u2019s bug', 'src/a\u2019; Remove-Item -Recurse .; \u2019b.txt',
      '\u2018\u2019\u201A\u201B\'', "it's", 'plain']) {
      expect(readSingleQuoted(quoteArgPowershell(value))).toEqual({ value, rest: '' });
    }
  });

  posixIt('platform_quoting_is_posix_off_windows', () => {
    expect(quoteArg("it's")).toBe(quoteArgPosix("it's"));
  });

  it('status_and_branch_list_commands_are_fixed', () => {
    expect(buildGitStatusCommand())
      .toBe('git --no-pager --no-optional-locks --literal-pathspecs status --porcelain=v1 --branch');
    expect(buildGitBranchListCommand().startsWith(
      'git --no-pager --no-optional-locks --literal-pathspecs branch --format=',
    )).toBe(true);
  });

  it('diff_command_supports_staged_and_quoted_paths', () => {
    expect(buildGitDiffCommand(false, null))
      .toBe('git --no-pager --no-optional-locks --literal-pathspecs diff');
    expect(buildGitDiffCommand(true, null))
      .toBe('git --no-pager --no-optional-locks --literal-pathspecs diff --staged');
    const paths = ['src/a b.rs', 'README.md'];
    expect(buildGitDiffCommand(false, paths))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs diff -- 'src/a b.rs' 'README.md'");
    expect(buildGitDiffCommand(true, paths))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs diff --staged -- 'src/a b.rs' 'README.md'");
    // empty path list must not emit a bare --
    expect(buildGitDiffCommand(false, []))
      .toBe('git --no-pager --no-optional-locks --literal-pathspecs diff');
  });

  it('log_command_embeds_validated_limit', () => {
    expect(buildGitLogCommand(1)).toContain('log -n 1');
    expect(buildGitLogCommand(100)).toContain('log -n 100');
  });

  it('branch_commands_quote_names_and_delete_uses_safe_dash_d', () => {
    expect(buildGitBranchCreateCommand('feat/x'))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs branch -- 'feat/x'");
    expect(buildGitBranchSwitchCommand('feat/x'))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs switch -- 'feat/x'");
    expect(buildGitBranchDeleteCommand('feat/x'))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs branch -d -- 'feat/x'");
    for (const command of [
      buildGitBranchCreateCommand('x'),
      buildGitBranchSwitchCommand('x'),
      buildGitBranchDeleteCommand('x'),
    ]) {
      expect(command).not.toContain('--force');
      expect(command).not.toContain(' -f');
      expect(command).not.toContain(' -D');
    }
  });

  it('commit_commands_are_add_then_commit_with_quoted_operands', () => {
    const paths = ['src/a.rs', 'docs/b.md'];
    expect(buildGitAddCommand(paths))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs add -- 'src/a.rs' 'docs/b.md'");
    expect(buildGitCommitCommand("fix: it's broken", paths))
      .toBe("git --no-pager --no-optional-locks --literal-pathspecs -c commit.gpgSign=false commit -m 'fix: it'\\''s broken' -- 'src/a.rs' 'docs/b.md'");
  });

  it('paths_must_be_relative_and_non_empty', () => {
    for (const bad of ['', '/abs/path', '../up', 'a/../../b', '-m', '--force']) {
      expect(() => validateRepoRelativePath(bad), `must reject: ${JSON.stringify(bad)}`).toThrow();
    }
    for (const good of ['src/a.rs', 'a b/c.md', '.hidden/file']) {
      expect(validateRepoRelativePath(good), `must accept: ${JSON.stringify(good)}`).toBe(good);
    }
  });

  it('commit_requires_non_empty_paths', () => {
    let map = argumentsObject({ message: 'm' });
    expect(() => optionalPaths(map, true)).toThrow();

    map = argumentsObject({ message: 'm', paths: [] });
    expect(() => optionalPaths(map, true)).toThrow();

    map = argumentsObject({ paths: ['src/a.rs'] });
    expect(optionalPaths(map, true)).toEqual(['src/a.rs']);
  });

  it('diff_paths_are_optional_but_still_validated', () => {
    let map = argumentsObject({});
    expect(optionalPaths(map, false)).toBeNull();

    map = argumentsObject({ paths: ['../escape'] });
    expect(() => optionalPaths(map, false)).toThrow();
  });

  it('branch_names_reject_option_injection_and_whitespace', () => {
    for (const bad of ['', '-D', '--force', 'feat x', 'a..b', 'a\nb']) {
      expect(() => validateBranchName(bad), `must reject: ${JSON.stringify(bad)}`).toThrow();
    }
    for (const good of ['main', 'feat/x-y', 'release_2026.09']) {
      expect(validateBranchName(good), `must accept: ${JSON.stringify(good)}`).toBe(good);
    }
  });

  it('unknown_fields_are_rejected', () => {
    const map = argumentsObject({ command: 'git push' });
    expect(() => ensureAllowedKeys(map, ['root_id'])).toThrow();
  });

  it('sensitivity_matrix_matches_read_medium_write_high', () => {
    const executor = new GitToolExecutor();
    for (const tool of [
      'git_status',
      'builtin-git_status',
      'git_diff',
      'mcp_git_diff',
      'git_log',
    ]) {
      expect(executor.sensitivityLevel(tool), `${tool} must be Medium`).toBe('medium');
      expect(executor.sensitivityLevelForCall(tool, {}), `${tool} must stay Medium per call`)
        .toBe('medium');
    }
    expect(executor.sensitivityLevel('builtin-git_commit')).toBe('high');
    // git_branch 名称级 High（fail-closed），list 按调用降为 Medium
    expect(executor.sensitivityLevel('builtin-git_branch')).toBe('high');
    expect(executor.sensitivityLevelForCall('builtin-git_branch', { action: 'list' }))
      .toBe('medium');
    for (const action of ['create', 'switch', 'delete']) {
      expect(
        executor.sensitivityLevelForCall('builtin-git_branch', { action }),
        `branch ${action} must be High`,
      ).toBe('high');
    }
    // 缺 action 的调用保持 fail-closed High
    expect(executor.sensitivityLevelForCall('builtin-git_branch', {})).toBe('high');
    expect(executor.hasDynamicSensitivity('builtin-git_branch')).toBe(true);
    expect(executor.hasDynamicSensitivity('builtin-git_commit')).toBe(false);
  });

  it('concurrency_is_readonly_for_reads_and_serial_for_writes', () => {
    const executor = new GitToolExecutor();
    for (const tool of ['git_status', 'git_diff', 'git_log']) {
      expect(executor.concurrencyClass(tool), `${tool} must be ReadOnly`).toBe('read_only');
    }
    for (const tool of ['git_branch', 'git_commit']) {
      expect(executor.concurrencyClass(tool), `${tool} must be Serial`).toBe('serial');
    }
  });

  it('can_handle_matches_all_five_tools_with_any_namespace', () => {
    const executor = new GitToolExecutor();
    for (const tool of [
      'git_status',
      'builtin-git_status',
      'mcp_git_diff',
      'git_log',
      'builtin-git_branch',
      'git_commit',
    ]) {
      expect(executor.canHandle(tool), `must handle ${tool}`).toBe(true);
    }
    for (const tool of ['git_push', 'git_reset', 'local_shell_execute', 'git']) {
      expect(executor.canHandle(tool), `must not handle ${tool}`).toBe(false);
    }
  });
});

// 常量与 Rust 保持一致，避免移植时被静默改写。
describe('git executor constants', () => {
  it('keeps rust limits', () => {
    expect(MAX_PATHS).toBe(200);
    expect(DEFAULT_LOG_LIMIT).toBe(20);
    expect(MAX_LOG_LIMIT).toBe(100);
    expect(GIT_DIFF_MAX_OUTPUT_BYTES).toBe(256 * 1024);
  });
});
