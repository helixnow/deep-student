/**
 * 主进程自己的日志文件（`<app_log_dir>/electron-main.log`，与 Host 的 `deep-student.log` 同目录）。
 *
 * Host 的日志插件装载之前发生的失败（HostFatal、Host 进程异常退出、Host 的早期 stderr）只有 main 能记录。
 * 文件路径要等 `start()` 解析出目录后才知道，之前的行先缓存。逐行同步追加：main 的日志量很小，
 * 同步写保证进程随后崩溃时已写的行不丢。写失败只降级为不写文件，不影响启动。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';
import type { ShellPlatform } from './tauri-config.ts';

export const MAIN_LOG_FILE_NAME = 'electron-main.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 2_000;

export class MainLog {
  private file: string | null = null;
  private failed = false;
  private pending: string[] = [];
  private dropped = 0;
  private readonly now: () => Date;
  private readonly maxBytes: number;
  private readonly maxPending: number;

  constructor(options: { now?: () => Date; maxBytes?: number; maxPending?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  get path(): string | null {
    return this.file;
  }

  write(message: string): void {
    const line = `${this.now().toISOString()} ${message}\n`;
    if (this.failed) return;
    if (this.file === null) {
      this.pending.push(line);
      if (this.pending.length > this.maxPending) {
        this.pending.shift();
        this.dropped += 1;
      }
      return;
    }
    this.append(line);
  }

  /** 打开（必要时轮转为 `.1`）并写出缓存的行。只生效一次。 */
  open(file: string): void {
    if (this.file !== null || this.failed) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      let size = 0;
      try { size = statSync(file).size; } catch { size = 0; }
      if (size > this.maxBytes) renameSync(file, `${file}.1`);
    } catch (error) {
      this.disable(file, error);
      return;
    }
    this.file = file;
    const pending = this.pending;
    this.pending = [];
    if (this.dropped > 0) {
      this.append(`${this.now().toISOString()} [main-log] ${this.dropped} earlier line(s) dropped before the log file was opened\n`);
    }
    if (pending.length > 0) this.append(pending.join(''));
  }

  private append(text: string): void {
    if (this.file === null) return;
    try {
      appendFileSync(this.file, text);
    } catch (error) {
      this.disable(this.file, error);
    }
  }

  private disable(file: string, error: unknown): void {
    this.failed = true;
    this.file = null;
    this.pending = [];
    process.stderr.write(`[dstu-shell] [main-log] cannot write ${file}: ${error instanceof Error ? error.message : String(error)}; main log file disabled\n`);
  }
}

/**
 * Rust `app_log_dir`，与 Host `host/platform/paths` 的推导一致（标识取外壳写入 `DS_APP_IDENTIFIER` 的 bundle identifier）：
 * macOS `<home>/Library/Logs/<id>`，其余 `<data_local>/<id>/logs`。
 */
export function mainLogFile(
  platform: ShellPlatform,
  dirs: { readonly home: string | null; readonly dataLocal: string | null },
  identifier: string,
): string | null {
  if (platform === 'win32') {
    return dirs.dataLocal === null ? null : winJoin(dirs.dataLocal, identifier, 'logs', MAIN_LOG_FILE_NAME);
  }
  if (platform === 'darwin') return dirs.home === null ? null : posixJoin(dirs.home, 'Library/Logs', identifier, MAIN_LOG_FILE_NAME);
  return dirs.dataLocal === null ? null : posixJoin(dirs.dataLocal, identifier, 'logs', MAIN_LOG_FILE_NAME);
}
