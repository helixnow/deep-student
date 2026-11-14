/**
 * 崩溃日志（`src-tauri/src/crash_logger.rs`）：`<logDir>/crash/crash-<UTC %Y-%m-%dT%H-%M-%S%.3fZ>-pid<pid>.log`，
 * 启动时只保留最新 20 份（按 mtime）。Node 中由 `uncaughtException` 钩子代替 panic hook。
 */
import { mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { chronoRfc3339, chronoStamp, civilTime, nowEpochNanos } from '../time/index.ts';
import { scrubPii } from './redact.ts';

export const MAX_CRASH_LOGS = 20;

export interface CrashInfo {
  version: string;
  buildNumber: string;
  gitHash: string;
}

export function cleanupOldCrashLogs(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Rust `let Ok(entries) = fs::read_dir(dir) else { return }`。
    return;
  }
  const logs = names
    .filter((n) => n.startsWith('crash-'))
    .map((n) => {
      const path = join(dir, n);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        // `unwrap_or(UNIX_EPOCH)`。
        mtime = 0;
      }
      return { path, mtime };
    });
  if (logs.length <= MAX_CRASH_LOGS) return;
  logs.sort((a, b) => a.mtime - b.mtime);
  for (const entry of logs.slice(0, logs.length - MAX_CRASH_LOGS)) {
    try {
      unlinkSync(entry.path);
    } catch {
      // Rust `let _ = fs::remove_file(..)`：清理旧日志失败不影响启动。
      continue;
    }
  }
}

function locationOf(error: unknown): string {
  const stack = error instanceof Error ? error.stack : undefined;
  if (stack) {
    for (const line of stack.split('\n').slice(1)) {
      const m = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
      if (m) return `${m[1]}:${m[2]}:${m[3]}`;
    }
  }
  return '未知位置';
}

/** 写入一份崩溃日志并返回路径（内容整体过 `scrub_pii`）。 */
export function writeCrashLog(crashDir: string, error: unknown, info: CrashInfo): string {
  const now = nowEpochNanos();
  const t = civilTime(now, false);
  const path = join(crashDir, `crash-${chronoStamp(t, '-', true)}Z-pid${process.pid}.log`);
  mkdirSync(crashDir, { recursive: true });
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '无法解析的 panic payload';
  let buffer = '=== Deep Student 崩溃日志 ===\n';
  buffer += `时间: ${chronoRfc3339(now)}\n`;
  buffer += `版本: ${info.version} (Build ${info.buildNumber}, ${info.gitHash})\n`;
  buffer += `进程: ${process.pid}\n`;
  buffer += `线程: main\n`;
  buffer += `位置: ${locationOf(error)}\n`;
  buffer += `错误: ${message}\n`;
  buffer += '回溯:\n';
  buffer += `${error instanceof Error && error.stack ? error.stack : new Error(message).stack}\n`;
  const fd = openSync(path, 'w', 0o600);
  try {
    // Rust write_all(scrub_pii(buffer).as_bytes()) before sync_all.
    writeFileSync(fd, Buffer.from(scrubPii(buffer, process.platform), 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}
