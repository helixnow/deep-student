/**
 * 旧 writer 停止核验（DESIGN.md §5.1 前置条件）。快照前后各查一次，任一次不是 `stopped` 都不复制。
 *
 * 证据来源（只读，不发信号、不抢锁、不打开源文件）：
 * - Linux：扫描 `/proc/<pid>/fd`，看是否有进程打开着源文件（WebKitGTK 网络进程持有 localStorage 库句柄）。
 * - macOS：`/usr/sbin/lsof -F pc -- <源文件>`，同一判据（WKWebView 的 Networking XPC 进程持有句柄）。
 * - Windows：WebView2 浏览器进程（`msedgewebview2.exe`）以 `--user-data-dir=<EBWebView>` 启动并独占
 *   该目录的 LevelDB；查询进程命令行里是否还有指向 Tauri 版 EBWebView 的实例。
 * 无法取得证据（权限、命令不可用、超时）一律是 `unknown`，由编排层按 fail-closed 处理。
 */
import { execFile } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type WriterProbeResult =
  | { readonly state: 'stopped'; readonly evidence: string }
  | { readonly state: 'running'; readonly detail: string }
  | { readonly state: 'unknown'; readonly detail: string };

export interface WriterProbe {
  check(files: readonly string[]): Promise<WriterProbeResult>;
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args) => new Promise((resolve) => {
  execFile(command, [...args], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error === null) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
    const raw: unknown = (error as { code?: unknown }).code;
    const code = typeof raw === 'number' ? raw : null;
    resolve({ code, stdout: String(stdout), stderr: code === null ? `${String(stderr)}${error.message}` : String(stderr) });
  });
});

function canonical(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}

/** Linux：`/proc/<pid>/fd/*` 的链接目标与源文件比较。 */
export function procFdProbe(procRoot = '/proc'): WriterProbe {
  return {
    async check(files) {
      const targets = new Set(files.flatMap((file) => [file, canonical(file)]));
      let pids: string[];
      try {
        pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
      } catch (error) {
        return { state: 'unknown', detail: `无法读取 ${procRoot}: ${error instanceof Error ? error.message : String(error)}` };
      }
      let inspected = 0;
      for (const pid of pids) {
        const fdDir = join(procRoot, pid, 'fd');
        let fds: string[];
        try { fds = readdirSync(fdDir); } catch { continue; }
        inspected += 1;
        for (const fd of fds) {
          let target: string;
          try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
          if (targets.has(target.replace(/ \(deleted\)$/, ''))) {
            return { state: 'running', detail: `进程 ${pid} 仍打开着 ${target}` };
          }
        }
      }
      if (inspected === 0) return { state: 'unknown', detail: `${procRoot} 下没有可检查的进程` };
      return { state: 'stopped', evidence: `已检查 ${inspected} 个进程的文件句柄，均未打开源文件` };
    },
  };
}

/** macOS：lsof 列出持有源文件的进程；退出码 1 且无输出表示没有进程打开它们。 */
export function lsofProbe(run: CommandRunner = runCommand, lsof = '/usr/sbin/lsof'): WriterProbe {
  return {
    async check(files) {
      if (files.length === 0) return { state: 'stopped', evidence: '没有需要检查的源文件' };
      const result = await run(lsof, ['-F', 'pc', '--', ...files]);
      const lines = result.stdout.split('\n');
      const pids = lines.filter((line) => line.startsWith('p')).map((line) => line.slice(1));
      if (pids.length > 0) {
        const commands = lines.filter((line) => line.startsWith('c')).map((line) => line.slice(1));
        return { state: 'running', detail: `进程 ${pids.join(', ')}（${commands.join(', ')}）仍打开着旧版 WebView 存储` };
      }
      if (result.code === 1 && result.stdout.trim() === '' && !files.some((file) => result.stderr.includes(file))) {
        return { state: 'stopped', evidence: 'lsof 未发现任何进程打开源文件' };
      }
      return { state: 'unknown', detail: `lsof 退出码 ${String(result.code)}: ${result.stderr.trim()}` };
    },
  };
}

// 重定向时 PowerShell 5.1 按 OEM 代码页（如 936）写 stdout，非 ASCII 的用户目录按 UTF-8 解码后再也比不上；
// 命令行改为 UTF-8 字节的 Base64，输出只含 ASCII。
const WEBVIEW2_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { [Console]::Out.WriteLine([string]$_.ProcessId + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))) }",
].join('; ');

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeUtf8Base64(value: string): string | null {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

/** Windows：仍以 Tauri 版 EBWebView 为 user-data-dir 的 WebView2 进程。 */
export function webview2ProcessProbe(userDataDir: string, run: CommandRunner = runCommand): WriterProbe {
  const expected = normalizeWindowsPath(userDataDir);
  return {
    async check() {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WEBVIEW2_QUERY]);
      if (result.code !== 0) {
        return { state: 'unknown', detail: `无法查询 WebView2 进程（PowerShell 退出码 ${String(result.code)}）: ${result.stderr.trim()}` };
      }
      let count = 0;
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        count += 1;
        const tab = line.indexOf('\t');
        const pid = line.slice(0, Math.max(tab, 0));
        const commandLine = tab < 0 ? null : decodeUtf8Base64(line.slice(tab + 1).trim());
        if (!/^\d+$/.test(pid) || commandLine === null) {
          return { state: 'unknown', detail: `无法解析 WebView2 进程列表的输出行: ${JSON.stringify(line.slice(0, 200))}` };
        }
        const match = /--user-data-dir=(?:"([^"]+)"|(\S+))/i.exec(commandLine);
        const dir = match === null ? null : (match[1] ?? match[2] ?? '');
        if (dir !== null && normalizeWindowsPath(dir) === expected) {
          return { state: 'running', detail: `WebView2 进程 ${pid} 仍在使用 ${userDataDir}` };
        }
      }
      return { state: 'stopped', evidence: `已检查 ${count} 个 WebView2 进程，均未使用 ${userDataDir}` };
    },
  };
}
