import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lsofProbe, procFdProbe, webview2ProcessProbe, type CommandResult, type CommandRunner } from '../writer-probe.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'w07-writer-probe-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function runner(result: CommandResult, calls: Array<readonly string[]> = []): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    return result;
  };
}

describe('procFdProbe (Linux)', () => {
  function fakeProc(links: Record<string, Record<string, string>>): string {
    const proc = join(root, 'proc');
    for (const [pid, fds] of Object.entries(links)) {
      mkdirSync(join(proc, pid, 'fd'), { recursive: true });
      for (const [fd, target] of Object.entries(fds)) symlinkSync(target, join(proc, pid, 'fd', fd));
    }
    mkdirSync(join(proc, 'self'), { recursive: true });
    return proc;
  }

  it('reports running when any process holds a source file open', async () => {
    const db = join(root, 'tauri_localhost_0.localstorage');
    writeFileSync(db, 'x');
    const proc = fakeProc({ 100: { 0: '/dev/null' }, 4242: { 3: '/dev/null', 7: db } });
    expect(await procFdProbe(proc).check([db])).toMatchObject({ state: 'running', detail: expect.stringContaining('4242') });
  });

  it('matches handles to files that were deleted while open', async () => {
    const db = join(root, 'db');
    writeFileSync(db, 'x');
    const proc = fakeProc({ 7: { 9: `${db} (deleted)` } });
    expect((await procFdProbe(proc).check([db])).state).toBe('running');
  });

  it('reports stopped when no inspected process has the files open, unknown when nothing is inspectable', async () => {
    const db = join(root, 'db');
    writeFileSync(db, 'x');
    expect((await procFdProbe(fakeProc({ 1: { 0: '/dev/null' } })).check([db])).state).toBe('stopped');
    const empty = join(root, 'empty-proc');
    mkdirSync(empty);
    expect((await procFdProbe(empty).check([db])).state).toBe('unknown');
    expect((await procFdProbe(join(root, 'missing')).check([db])).state).toBe('unknown');
  });
});

describe('lsofProbe (macOS)', () => {
  it('parses lsof -F output into a running verdict', async () => {
    const calls: Array<readonly string[]> = [];
    const result = await lsofProbe(runner({ code: 0, stdout: 'p812\nccom.apple.WebKit.Networking\n', stderr: '' }, calls)).check(['/a.sqlite3', '/a.sqlite3-wal']);
    expect(result).toMatchObject({ state: 'running', detail: expect.stringContaining('812（com.apple.WebKit.Networking）') });
    expect(calls[0]).toEqual(['/usr/sbin/lsof', '-F', 'pc', '--', '/a.sqlite3', '/a.sqlite3-wal']);
  });

  it('treats exit 1 without output as stopped and anything else as unknown', async () => {
    expect((await lsofProbe(runner({ code: 1, stdout: '', stderr: '' })).check(['/a'])).state).toBe('stopped');
    expect((await lsofProbe(runner({ code: 1, stdout: '', stderr: 'lsof: status error on /a: No such file' })).check(['/a'])).state).toBe('unknown');
    expect((await lsofProbe(runner({ code: null, stdout: '', stderr: 'spawn ENOENT' })).check(['/a'])).state).toBe('unknown');
  });
});

describe('webview2ProcessProbe (Windows)', () => {
  const userData = 'C:\\Users\\Bob\\AppData\\Local\\com.deepstudent.app\\EBWebView';
  /** One output line of the PowerShell query: PID, tab, Base64 of the UTF-8 command line. */
  const line = (pid: number, commandLine: string) => `${pid}\t${Buffer.from(commandLine, 'utf8').toString('base64')}`;

  it('finds a WebView2 browser process still bound to the Tauri user-data-dir', async () => {
    const stdout = [
      line(1200, '"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe" --embedded-browser-webview=1 --user-data-dir="C:\\Users\\Bob\\AppData\\Local\\Other.App\\EBWebView"'),
      line(1300, '"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe" --embedded-browser-webview=1 --user-data-dir="c:\\users\\bob\\appdata\\local\\com.deepstudent.app\\EBWebView" --noerrdialogs'),
    ].join('\r\n');
    const calls: Array<readonly string[]> = [];
    expect(await webview2ProcessProbe(userData, runner({ code: 0, stdout, stderr: '' }, calls)).check([])).toMatchObject({ state: 'running', detail: expect.stringContaining('1300') });
    expect(calls[0]!.at(-1)).toContain('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))');
  });

  it('matches a user-data-dir under a non-ASCII user name', async () => {
    const chinese = 'C:\\Users\\张三\\AppData\\Local\\com.deepstudent.app\\EBWebView';
    const stdout = line(1400, `msedgewebview2.exe --user-data-dir="C:\\Users\\张三\\AppData\\Local\\com.deepstudent.app\\EBWebView"`);
    expect(await webview2ProcessProbe(chinese, runner({ code: 0, stdout, stderr: '' })).check([])).toMatchObject({ state: 'running', detail: expect.stringContaining('1400') });
  });

  it('is unknown, not stopped, when a line is not UTF-8 Base64 (OEM code page text, GBK bytes)', async () => {
    const chinese = 'C:\\Users\\张三\\AppData\\Local\\com.deepstudent.app\\EBWebView';
    const oemDecoded = '1400\tmsedgewebview2.exe --user-data-dir="C:\\Users\\\uFFFD\uFFFD\\AppData\\Local\\com.deepstudent.app\\EBWebView"';
    const gbkBytes = `1400\t${Buffer.from([0x43, 0x3a, 0x5c, 0xd5, 0xc5, 0xc8, 0xfd]).toString('base64')}`;
    for (const stdout of [oemDecoded, gbkBytes, '1400', `pid\t${Buffer.from('x').toString('base64')}`]) {
      expect(await webview2ProcessProbe(chinese, runner({ code: 0, stdout, stderr: '' })).check([]), stdout).toMatchObject({ state: 'unknown' });
    }
  });

  it('reports stopped when only other apps use WebView2, unknown when PowerShell is blocked', async () => {
    const other = line(1200, 'msedgewebview2.exe --user-data-dir=C:\\Users\\Bob\\AppData\\Local\\Other.App\\EBWebView');
    expect((await webview2ProcessProbe(userData, runner({ code: 0, stdout: other, stderr: '' })).check([])).state).toBe('stopped');
    expect((await webview2ProcessProbe(userData, runner({ code: 0, stdout: `${line(1500, '')}\r\n`, stderr: '' })).check([])).state).toBe('stopped');
    expect((await webview2ProcessProbe(userData, runner({ code: 0, stdout: '', stderr: '' })).check([])).state).toBe('stopped');
    expect((await webview2ProcessProbe(userData, runner({ code: 1, stdout: '', stderr: 'This program is blocked by group policy.' })).check([]))).toMatchObject({ state: 'unknown', detail: expect.stringContaining('group policy') });
  });
});
