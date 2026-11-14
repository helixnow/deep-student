/**
 * 主日志：tauri-plugin-log 2.8.0 `RotatingFile` + fern 格式的复刻。
 *
 * 配置来源 `src-tauri/src/lib.rs` 788–807：`LogDir{file_name:"deep-student"}`、`max_file_size(10 MiB)`、
 * `KeepSome(5)`、`UseLocal`、`level(Info)` + 若干 `level_for`。debug 构建另加 Stdout target。
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from './api.ts';
import { civilTime, nowEpochNanos, ymd, type CivilTime } from '../time/index.ts';

const LEVEL_RANK: Record<LogLevel, number> = { error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const LEVEL_DISPLAY: Record<LogLevel, string> = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG', trace: 'TRACE' };

/** 全局 Info 之外的 `level_for`（lib.rs 797–807；第一方 crate 显式 Info，与全局相同）。 */
export const LEVEL_OVERRIDES: Readonly<Record<string, LogLevel>> = {
  lance: 'warn',
  lance_encoding: 'warn',
  lance_io: 'warn',
  tracing: 'warn',
  h2: 'warn',
  hyper: 'warn',
  rustls: 'warn',
  reqwest: 'warn',
};

/** fern `level_for` 匹配：target 等于模块名或以 `模块名::` 开头，最长者生效。 */
export function levelEnabled(level: LogLevel, target: string, global: LogLevel = 'info'): boolean {
  let best: string | undefined;
  for (const name of Object.keys(LEVEL_OVERRIDES)) {
    if ((target === name || target.startsWith(`${name}::`)) && (best === undefined || name.length > best.length)) best = name;
  }
  const limit = best !== undefined ? LEVEL_OVERRIDES[best]! : global;
  return LEVEL_RANK[level] <= LEVEL_RANK[limit];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `[YYYY-MM-DD][HH:MM:SS][LEVEL][target] message`（`timezone_strategy` 设置后的格式，level 在前）。 */
export function formatLine(t: CivilTime, level: LogLevel, target: string, message: string): string {
  return `[${ymd(t)}][${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}][${LEVEL_DISPLAY[level]}][${target}] ${message}`;
}

/** `LOG_DATE_FORMAT` = `[year]-[month]-[day]_[hour]-[minute]-[second]`。 */
function datedSuffix(t: CivilTime): string {
  return `${ymd(t)}_${pad2(t.hour)}-${pad2(t.minute)}-${pad2(t.second)}`;
}

export interface RotatingFileOptions {
  dir: string;
  fileName: string;
  maxSize: number;
  keepCount: number;
  /** 本地时区（UseLocal）。 */
  local: boolean;
  now?: () => bigint;
}

/** `RotatingFile`（仅实现本应用使用的 `KeepSome` 策略）。 */
export class RotatingFile {
  readonly path: string;
  private fd: number | null = null;
  private currentSize = 0;
  private readonly now: () => bigint;

  private readonly options: RotatingFileOptions;

  constructor(options: RotatingFileOptions) {
    this.options = options;
    this.now = options.now ?? nowEpochNanos;
    if (!existsSync(options.dir)) mkdirSync(options.dir, { recursive: true });
    this.path = join(options.dir, `${options.fileName}.log`);
    try {
      this.openFile();
      if (this.currentSize >= options.maxSize) this.rotate();
      this.removeOldFiles(options.keepCount);
    } catch (error) {
      // Rust drops the partially initialized RotatingFile/File on Err. Preserve
      // the original initialization error even if closing the descriptor fails.
      try { this.close(); } finally { throw error; }
    }
  }

  private openFile(): void {
    this.fd = openSync(this.path, 'a');
    this.currentSize = fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    if (existsSync(this.path)) {
      // remove_old_files 不计活跃文件，所以先留出 keep_count - 1 个归档位。
      this.removeOldFiles(this.options.keepCount - 1);
      this.renameFileToDated();
    }
    this.openFile();
  }

  private removeOldFiles(keepCount: number): void {
    const { fileName } = this.options;
    const files: Array<{ path: string; date: string }> = [];
    for (const name of readdirSync(this.options.dir)) {
      if (!name.startsWith(fileName) || name === `${fileName}.log`) continue;
      const rest = name.slice(fileName.length);
      if (!rest.startsWith('_') || !rest.endsWith('.log')) continue;
      files.push({ path: join(this.options.dir, name), date: rest.slice(1, -'.log'.length) });
    }
    files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (files.length > keepCount) {
      for (const f of files.slice(0, files.length - keepCount)) unlinkSync(f.path);
    }
  }

  private renameFileToDated(): void {
    const to = join(this.options.dir, `${this.options.fileName}_${datedSuffix(civilTime(this.now(), this.options.local))}.log`);
    if (existsSync(to)) renameSync(to, `${to}.bak`);
    renameSync(this.path, to);
  }

  /** fern `Output::writer(.., "\n")`：一条记录 = 格式化行 + `\n`，整条写入后 flush。 */
  write(record: string): void {
    const buffer = Buffer.from(`${record}\n`, 'utf8');
    if (this.fd === null) this.openFile();
    if (this.currentSize !== 0 && this.currentSize + buffer.length > this.options.maxSize) this.rotate();
    // File::write_all in tauri-plugin-log2.8.0: one writeSync may be partial.
    writeFileSync(this.fd!, buffer);
    this.currentSize += buffer.length;
  }

  close(): void {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      closeSync(fd);
    }
  }
}

export const MAIN_LOG_FILE_NAME = 'deep-student';
export const MAIN_LOG_MAX_SIZE = 10 * 1024 * 1024;
export const MAIN_LOG_KEEP = 5;
