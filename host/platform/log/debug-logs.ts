/**
 * LLM 请求体/原始响应调试日志（`dstu-platform/src/debug_log_service.rs` 300–600，
 * 命令侧根目录解析见 `src-tauri/src/commands.rs` 574–651）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { DebugLogFiles, DebugLogsInfo } from './api.ts';
import { redactSensitiveFields, redactSensitiveText } from './redact.ts';
import { compareRustPaths } from '../paths/index.ts';
import { charCount, decodeUtf8Strict, Utf8DecodeError } from '../util/index.ts';
import { chronoRfc3339, chronoStamp, civilTime, nowEpochNanos } from '../time/index.ts';
import { ioMessage } from '../paths/compat.ts';

const DEBUG_LOGS_DIR = 'debug-logs';
const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
const AUTO_CLEANUP_THRESHOLD = 500;
const FLUSH_TIMEOUT_MS = 10_000;

export interface DebugLogFilesOptions {
  logDir: string;
  roots: readonly string[];
  report: (level: 'info' | 'warn', message: string) => void;
  unix?: boolean;
}

/** `safe_model_component`：取最后一个 `/` 段，Unicode 字母数字与 `-_.` 保留，其余 `_`，最多 80 字符。 */
export function safeModelComponent(model: string): string {
  const short = model.split('/').pop() ?? model;
  let out = '';
  let i = 0;
  for (const ch of short) {
    if (i++ >= 80) break;
    out += /^[\p{Alphabetic}\p{N}]$/u.test(ch) || ch === '-' || ch === '_' || ch === '.' ? ch : '_';
  }
  return out;
}

/** `safe_tag_component`：ASCII 字母数字与 `-_`。 */
export function safeTagComponent(tag: string): string {
  let out = '';
  let i = 0;
  for (const ch of tag) {
    if (i++ >= 80) break;
    out += /^[A-Za-z0-9_-]$/.test(ch) ? ch : '_';
  }
  return out;
}

/** `format_size`：f64 除以 2 的幂是精确值，按 Rust `{:.N}`（四舍六入五成双）格式化。 */
export function formatSize(bytes: number): string {
  const fmt = (divisor: bigint, digits: number) => {
    const scale = 10n ** BigInt(digits);
    const num = BigInt(bytes) * scale;
    let q = num / divisor;
    const r = num % divisor;
    if (r * 2n > divisor || (r * 2n === divisor && q % 2n === 1n)) q += 1n;
    const s = q.toString().padStart(digits + 1, '0');
    return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  };
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fmt(1024n, 1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${fmt(1024n * 1024n, 1)} MB`;
  return `${fmt(1024n * 1024n * 1024n, 2)} GB`;
}

function listLogFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Rust `read_dir(dir).ok().into_iter().flatten()`：读取失败视为空目录。
    return [];
  }
  return names
    .filter((n) => extname(n) === '.json' && n !== '.json')
    .map((n) => join(dir, n))
    .sort(compareRustPaths);
}

export class DebugLogFileService implements DebugLogFiles {
  private seq = 0;
  private pending = 0;
  private idle: Array<() => void> = [];
  private readonly unix: boolean;

  private readonly options: DebugLogFilesOptions;

  constructor(options: DebugLogFilesOptions) {
    this.options = options;
    this.unix = options.unix ?? process.platform !== 'win32';
  }

  ensureDir(logRoot: string = this.options.logDir): string {
    const dir = join(logRoot, DEBUG_LOGS_DIR);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        this.options.report('warn', `[DebugLog] create ${dir} failed: ${ioMessage(error)}`);
      }
    }
    return dir;
  }

  roots(): string[] {
    return [...this.options.roots];
  }

  private nextFilename(model: string, tag: string): { filename: string; seq: number; timestamp: string } {
    const now = nowEpochNanos();
    const time = chronoStamp(civilTime(now, true), '-', true);
    const seq = this.seq % 10000;
    this.seq = (this.seq + 1) >>> 0;
    const m = safeModelComponent(model);
    const t = safeTagComponent(tag);
    return {
      filename: `${time}_${String(seq).padStart(4, '0')}_${m === '' ? 'unknown' : m}_${t === '' ? 'unknown' : t}.json`,
      seq,
      timestamp: chronoRfc3339(now, true),
    };
  }

  private spawnWrite(logDir: string, filename: string, json: string, seq: number): string {
    const filepath = join(logDir, filename);
    const temporary = filepath.replace(/\.json$/, `.json.tmp-${seq}`);
    this.pending++;
    // Rust spawn_blocking: serialization stays on the caller, disk IO does not.
    // Node's promise filesystem APIs use the IO pool; setImmediate+*Sync does not.
    void (async () => {
      try {
        try {
          await mkdir(logDir, { recursive: true });
          const file = await open(temporary, 'w', 0o600);
          try {
            await file.writeFile(json, 'utf8');
            await file.sync();
          } finally {
            // Rust drop(File) ignores close errors; don't mask the write/sync error.
            await file.close().catch(() => undefined);
          }
          await rename(temporary, filepath);
          if (this.unix) {
            const directory = await open(logDir, 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close().catch(() => undefined);
            }
          }
          this.options.report('info', `[DebugLog] Wrote: ${filename} (${Buffer.byteLength(json, 'utf8')} bytes)`);
        } catch (error) {
          // Rust `let _ = remove_file(temporary)`: cleanup failure must not skip warn.
          await rm(temporary, { force: true }).catch(() => undefined);
          this.options.report('warn', `[DebugLog] Write failed ${filename}: ${ioMessage(error)}`);
        }
        if (seq % 50 === 0) await this.autoCleanupIfNeeded(logDir);
      } finally {
        this.pending--;
        if (this.pending === 0) for (const resolve of this.idle.splice(0)) resolve();
      }
    })();
    return filepath;
  }

  private serialize(full: Record<string, unknown>, truncatedKey: string, reason: string): string {
    const json = JSON.stringify(full, null, 2);
    const size = Buffer.byteLength(json, 'utf8');
    if (size <= MAX_DEBUG_LOG_BYTES) return json;
    const truncated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(full)) {
      truncated[k] = k === truncatedKey ? { _truncated: true, _reason: reason, _serialized_bytes: size } : v;
    }
    return JSON.stringify(truncated, null, 2);
  }

  writeRequestEntry(logDir: string, tag: string, model: string, url: string, streamEvent: string, requestBody: unknown): string | null {
    const { filename, seq, timestamp } = this.nextFilename(model, tag);
    const entry = {
      version: 1,
      timestamp,
      tag: redactSensitiveText(tag),
      model: redactSensitiveText(model),
      url: redactSensitiveText(url),
      stream_event: redactSensitiveText(streamEvent),
      request_body: redactSensitiveFields(requestBody) ?? null,
    };
    let json: string;
    try {
      json = this.serialize(entry, 'request_body', 'request log exceeded 5 MiB');
    } catch (error) {
      this.options.report('warn', `[DebugLog] Serialize failed: ${String(error)}`);
      return null;
    }
    return this.spawnWrite(logDir, filename, json, seq);
  }

  writeResponseEntry(logDir: string, tag: string, model: string, streamEvent: string, rawResponse: string): string | null {
    const { filename, seq, timestamp } = this.nextFilename(model, tag);
    const entry = {
      version: 1,
      timestamp,
      tag: redactSensitiveText(tag),
      model: redactSensitiveText(model),
      stream_event: redactSensitiveText(streamEvent),
      raw_response_chars: charCount(rawResponse),
      raw_response: redactSensitiveText(rawResponse),
    };
    return this.spawnWrite(logDir, filename, this.serialize(entry, 'raw_response', 'response log exceeded 5 MiB'), seq);
  }

  flushPending(): Promise<boolean> {
    if (this.pending === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.options.report('warn', `[DebugLog] Timed out waiting for ${this.pending} pending writes`);
        resolve(false);
      }, FLUSH_TIMEOUT_MS);
      this.idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private listLogFiles(roots: readonly string[]): string[] {
    const files = roots.flatMap((root) => listLogFilesIn(join(root, DEBUG_LOGS_DIR)));
    files.sort(compareRustPaths);
    return files.filter((f, i) => i === 0 || f !== files[i - 1]);
  }

  info(roots: readonly string[] = this.options.roots): DebugLogsInfo {
    const files = this.listLogFiles(roots);
    let total = 0;
    for (const f of files) {
      try {
        total += statSync(f).size;
      } catch {
        // `filter_map(|f| fs::metadata(f).ok())`：跳过读不到的文件。
        continue;
      }
    }
    const name = (p: string | undefined) => (p === undefined ? null : (p.split(sep).pop() ?? null));
    return {
      count: files.length,
      total_size_bytes: total,
      total_size_display: formatSize(total),
      oldest_file: name(files[0]),
      newest_file: name(files[files.length - 1]),
    };
  }

  clearAll(roots: readonly string[] = this.options.roots): number {
    const files = this.listLogFiles(roots);
    let removed = 0;
    for (const f of files) if (tryUnlink(f)) removed++;
    this.options.report('info', `[DebugLog] Cleared ${removed} / ${files.length} log files`);
    return removed;
  }

  cleanupOld(maxAgeDays: number, roots: readonly string[] = this.options.roots): number {
    const files = this.listLogFiles(roots);
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
    let removed = 0;
    for (const f of files) {
      let modified = Date.now();
      try {
        modified = statSync(f).mtimeMs;
      } catch {
        // `unwrap_or(SystemTime::now())`：读不到修改时间按"现在"处理（不删）。
        modified = Date.now();
      }
      if (modified < cutoff && tryUnlink(f)) removed++;
    }
    this.options.report('info', `[DebugLog] Cleaned up ${removed} old log files (>${maxAgeDays} days)`);
    return removed;
  }

  private async autoCleanupIfNeeded(logDir: string): Promise<void> {
    let names: string[];
    try { names = await readdir(logDir); } catch { return; }
    const files = names.filter(name => extname(name) === '.json' && name !== '.json')
      .map(name => join(logDir, name)).sort(compareRustPaths);
    if (files.length <= AUTO_CLEANUP_THRESHOLD) return;
    const toRemove = Math.floor(files.length / 10);
    let removed = 0;
    for (const file of files.slice(0, toRemove)) {
      try { await unlink(file); removed++; } catch { continue; }
    }
    if (removed > 0) this.options.report('info', `[DebugLog] Auto-cleanup: removed ${removed} oldest files (total was ${files.length})`);
  }

  readFile(path: string, roots: readonly string[] = this.options.roots): string {
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch (error) {
      throw new Error(`路径解析失败: ${ioMessage(error)}`);
    }
    const allowed = roots.some((root) => {
      const dir = join(root, DEBUG_LOGS_DIR);
      let allowedCanonical = dir;
      try {
        allowedCanonical = realpathSync(dir);
      } catch {
        // `canonicalize().unwrap_or(allowed_dir)`。
        allowedCanonical = dir;
      }
      return pathStartsWith(canonical, allowedCanonical);
    });
    if (!allowed) throw new Error('非法路径：不在 debug-logs 目录中');
    if (extname(canonical) !== '.json') throw new Error('非法文件类型：仅允许读取 .json 文件');
    try {
      return decodeUtf8Strict(readFileSync(canonical));
    } catch (error) {
      // std::fs::read_to_string maps UTF-8 failure to this io::ErrorKind::InvalidData Display,
      // not str::from_utf8's byte-offset error or Node's replacement decoding.
      throw new Error(`读取调试日志失败: ${error instanceof Utf8DecodeError ? 'stream did not contain valid UTF-8' : ioMessage(error)}`);
    }
  }
}

/** `Path::starts_with`：按组件比较。 */
function pathStartsWith(path: string, prefix: string): boolean {
  const separators = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
  const a = path.split(separators).filter(Boolean);
  const b = prefix.split(separators).filter(Boolean);
  return b.length <= a.length && b.every((c, i) => a[i] === c);
}

function tryUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Rust `fs::remove_file(f).is_ok()`：失败只是不计数。
    return false;
  }
}
