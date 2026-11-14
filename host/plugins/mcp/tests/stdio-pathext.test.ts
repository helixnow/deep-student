import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateStdioStart } from '../src/stdio-validation.ts';
import type { JsonValue } from '../api.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A Node/npm bin directory: `npx` is the extensionless sh shim for Git Bash, `npx.cmd` the Windows launcher. */
function npmBin(...names: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-pathext-')));
  dirs.push(dir);
  for (const name of names) writeFileSync(join(dir, name), name.endsWith('.cmd') ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

function resolveApproved(command: string, env: Record<string, string>, cwd: string, platform: string): string {
  const entries: JsonValue[] = [{ id: 'npx', name: 'npx', transportType: 'stdio', enabled: true, command, args: ['-y', 'server'], env, cwd }];
  return validateStdioStart(entries, command, ['-y', 'server'], env, cwd, null, platform).command;
}

/** Same case as the files, so the match does not depend on whether the test filesystem ignores case like NTFS. */
const PATHEXT = '.com;.exe;.bat;.cmd';

describe('V10-P2-2 executable resolution on win32 prefers PATHEXT launchers over extensionless shims', () => {
  it('RF-W21-windows-pathext-before-shim: bare "npx" on PATH resolves to npx.cmd, not the sh shim next to it', () => {
    const bin = npmBin('npx', 'npx.cmd');
    expect(resolveApproved('npx', { PATH: bin, PATHEXT }, bin, 'win32')).toBe(join(bin, 'npx.cmd'));
  });

  it('RF-W21-windows-pathext-before-shim: an explicit path without extension also resolves to the .cmd launcher', () => {
    const bin = npmBin('npx', 'npx.cmd');
    expect(resolveApproved(join(bin, 'npx'), { PATHEXT }, bin, 'win32')).toBe(join(bin, 'npx.cmd'));
  });

  it('RF-W21-windows-pathext-before-shim: an extensionless file alone is not a Windows executable and is rejected up front', () => {
    const bin = npmBin('tool');
    expect(() => resolveApproved('tool', { PATH: bin, PATHEXT }, bin, 'win32'))
      .toThrow("mcp_stdio_start rejected: executable 'tool' is not reachable via PATH");
  });

  it('win32: a command that names its extension still resolves to exactly that file', () => {
    const bin = npmBin('npx', 'npx.cmd');
    expect(resolveApproved('npx.cmd', { PATH: bin, PATHEXT }, bin, 'win32')).toBe(join(bin, 'npx.cmd'));
  });

  it('linux/darwin are unchanged: the extensionless executable is the command and PATHEXT is ignored', () => {
    const bin = npmBin('npx', 'npx.cmd');
    expect(resolveApproved('npx', { PATH: bin, PATHEXT }, bin, 'linux')).toBe(join(bin, 'npx'));
  });
});
