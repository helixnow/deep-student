import { describe, expect, it } from 'vitest';
import { quoteArgPowershell } from '../src/tools/git.ts';

/** Windows PowerShell 5.1 legacy native argument passing: unquoted whitespace → wrap in bare double quotes, no escaping. */
function legacyCommandLine(args: readonly string[]): string {
  return args.map(arg => {
    let quotes = 0;
    let afterBackslash = false;
    let wrap = false;
    for (const character of arg) {
      if (character === '"' && !afterBackslash) quotes += 1;
      else if (/[\s\u0085]/u.test(character) && quotes % 2 === 0) wrap = true;
      afterBackslash = character === '\\';
    }
    return wrap ? `"${arg}"` : arg;
  }).join(' ');
}

/** The MSVCRT / CommandLineToArgvW split git.exe applies to its command line. */
function msvcrtArgv(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') {
      let count = 0;
      while (line[index] === '\\') { count += 1; index += 1; }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current += '\\'.repeat(count);
        index -= 1;
      }
      started = true;
    } else if (line[index] === '"') {
      quoted = !quoted;
      started = true;
    } else if ((line[index] === ' ' || line[index] === '\t') && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += line[index];
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** argv git.exe sees for `git commit -m <message> -- <paths>` sent through Windows PowerShell 5.1. */
const commitArgv = (message: string, paths: readonly string[]) =>
  msvcrtArgv(legacyCommandLine(['commit', '-m', message, '--', ...paths]));

describe('git_* arguments through Windows PowerShell 5.1', () => {
  it('RF-S01-git-powershell-native-quote: values that PowerShell 5.1 would re-split into git options are refused', () => {
    const injected = 'tidy up" --amend --no-verify "x';
    expect(commitArgv(injected, ['a.txt'])).toEqual(['commit', '-m', 'tidy up', '--amend', '--no-verify', 'x', '--', 'a.txt']);
    const swallowed = commitArgv('see C:\\work dir\\', ['y --amend']);
    expect(swallowed.indexOf('--amend')).toBeGreaterThan(0);
    expect(swallowed).not.toContain('--');
    for (const value of [injected, 'say "hi"', 'see C:\\work dir\\', 'tab\tend\\', 'nbsp\u00a0end\\\\']) {
      expect(() => quoteArgPowershell(value), value).toThrow(
        'Windows PowerShell cannot pass this value to git intact: remove ASCII double quotes, and any trailing backslash from a value with whitespace');
    }
  });

  it('RF-S01-git-powershell-native-quote: accepted values reach git as one unchanged argument', () => {
    for (const value of ['Fix the user\u2019s bug', 'src\\', 'dir with spaces/a.rs', 'a\\b c', '\u201cquoted\u201d title', '中文 提交说明',
      'trailing\\\\', "it's"]) {
      expect(() => quoteArgPowershell(value), value).not.toThrow();
      expect(commitArgv(value, [value])).toEqual(['commit', '-m', value, '--', value]);
    }
  });
});
