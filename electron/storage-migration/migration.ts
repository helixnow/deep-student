/**
 * Tauri 版 WebView localStorage → Electron 的一次性迁移编排（DESIGN.md §5），在 Electron main 中、
 * Host 启动之前运行。
 *
 * 状态文件 `<userData>/webview-migration/state.json`：
 * - 不存在 / `snapshotting`：定位源 → 核验旧 writer 已停止 → 复制到 `source/` → 再核验、比对源文件
 *   指纹 → 解码副本 → 写 `snapshotted`。找不到源（新用户）直接写 `done`。
 * - `snapshotted`：只解码已有快照，不再读源（两次启动之间源变化不影响一致性）。
 * - `done`：什么都不做。preload 写入成功、main `flushStorageData()` 之后由
 *   {@link completeWebviewMigration} 写入。
 *
 * 源文件只复制，不打开、不改名、不删除；快照与源在 `done` 之后都保留。任何一步失败都抛
 * {@link WebviewMigrationError}，调用方只能提供“重试 / 退出”，不得放行页面脚本或标记跳过。
 */
import { copyFileSync, existsSync, fsyncSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WebviewMigrationApplyReport } from './apply.ts';
import { decodeChromiumLocalStorage, decodeWebKitLocalStorage, type LocalStorageEntry } from './formats.ts';
import { readLevelDb } from './leveldb.ts';
import { locateMigrationSource, sourceFiles, SourceLocationError, type MigrationSource, type SourceLocation } from './sources.ts';
import { lsofProbe, procFdProbe, webview2ProcessProbe, type WriterProbe, type WriterProbeResult } from './writer-probe.ts';

export const MIGRATION_DIR_NAME = 'webview-migration';
const STATE_FILE = 'state.json';
const SNAPSHOT_DIR = 'source';
const SQLITE_SNAPSHOT = 'localstorage.sqlite3';
const LEVELDB_SNAPSHOT = 'leveldb';

export type WebviewMigrationErrorCode =
  | 'WRITER_RUNNING'
  | 'WRITER_UNVERIFIED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_AMBIGUOUS'
  | 'SOURCE_UNREADABLE'
  | 'SNAPSHOT_FAILED'
  | 'TARGET_WRITE_FAILED'
  | 'TARGET_VERIFY_FAILED'
  | 'NOT_SNAPSHOTTED';

const USER_MESSAGES: Record<WebviewMigrationErrorCode, string> = {
  WRITER_RUNNING: '检测到旧版 Deep Student 仍在运行（或它的网页组件进程还没退出）。请先完全退出旧版，再点“重试”。在此之前不会读取或改动旧版数据。',
  WRITER_UNVERIFIED: '无法确认旧版 Deep Student 已经完全退出，为避免复制到不完整的数据，界面数据迁移已暂停。请确认旧版已退出后点“重试”。',
  SOURCE_CHANGED: '复制旧版界面数据时，源文件发生了变化，说明旧版可能仍在写入。请先完全退出旧版，再点“重试”。',
  SOURCE_AMBIGUOUS: '找到了多份疑似旧版界面数据，无法确定该迁移哪一份。旧数据未被改动，请导出诊断信息联系支持。',
  SOURCE_UNREADABLE: '旧版界面数据（作文草稿、布局等）读取失败。旧数据未被改动，可以点“重试”；如果一直失败，请导出诊断信息联系支持。',
  SNAPSHOT_FAILED: '复制旧版界面数据到新版目录失败（可能是磁盘空间或权限问题）。旧数据未被改动，处理后请点“重试”。',
  TARGET_WRITE_FAILED: '把旧版界面数据写入新版失败，迁移没有完成，下次启动会自动重试。',
  TARGET_VERIFY_FAILED: '旧版界面数据写入新版后核对不一致（可能还没写到磁盘），迁移没有完成。可以点“重试”；下次启动也会自动重试，新版里已有的数据不会被覆盖。',
  NOT_SNAPSHOTTED: '界面数据迁移状态异常（尚未完成快照），请重启应用重试。',
};

export class WebviewMigrationError extends Error {
  readonly code: WebviewMigrationErrorCode;
  /** 可直接展示给用户的说明（含下一步操作）。 */
  readonly userMessage: string;

  constructor(code: WebviewMigrationErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`[webview-migration] ${code}: ${detail}`, options);
    this.name = 'WebviewMigrationError';
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
  }
}

export interface SourceRecord {
  readonly kind: MigrationSource['kind'];
  readonly origin: string;
  readonly path: string;
  readonly layout?: string;
  readonly recoveredFrom?: string;
  readonly files: readonly string[];
}

interface MigrationState {
  readonly version: 1;
  readonly status: 'snapshotting' | 'snapshotted' | 'done';
  readonly source: SourceRecord | null;
  readonly updatedAt: string;
  readonly result?: { readonly written: number; readonly kept: number };
}

export interface WebviewMigrationOptions extends SourceLocation {
  /** Electron `app.getPath('userData')`。 */
  readonly userDataDir: string;
  readonly probe?: WriterProbe;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

export type PreparedWebviewMigration =
  | { readonly status: 'done' }
  | { readonly status: 'pending'; readonly entries: readonly LocalStorageEntry[]; readonly source: SourceRecord };

export function defaultWriterProbe(location: SourceLocation): WriterProbe {
  switch (location.platform) {
    case 'linux': return procFdProbe();
    case 'darwin': return lsofProbe();
    case 'win32': return webview2ProcessProbe(join(location.dataLocalDir, location.identifier, 'EBWebView'));
  }
}

function migrationDir(userDataDir: string): string {
  return join(userDataDir, MIGRATION_DIR_NAME);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readState(dir: string, log: (message: string) => void): MigrationState | null {
  const file = join(dir, STATE_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WebviewMigrationError('SNAPSHOT_FAILED', `读取 ${file} 失败: ${errorText(error)}`, { cause: error });
  }
  const state = parseMigrationState(raw);
  if (state !== null) return state;
  log(`[webview-migration] ${file} 无法解析，按未迁移处理并重新快照`);
  return null;
}

/** 不是合法 JSON 或不是已知版本 / 状态时为 null。 */
function parseMigrationState(raw: string): MigrationState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const state = value as Partial<MigrationState> | null;
  if (typeof state !== 'object' || state === null || state.version !== 1) return null;
  return ['snapshotting', 'snapshotted', 'done'].includes(state.status as string) ? state as MigrationState : null;
}

function writeState(dir: string, state: MigrationState): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, STATE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function recordOf(source: MigrationSource, files: readonly string[]): SourceRecord {
  return source.kind === 'webkit-sqlite'
    ? {
      kind: source.kind, origin: source.origin, path: source.database, layout: source.layout,
      ...(source.recoveredFrom === undefined ? {} : { recoveredFrom: source.recoveredFrom }), files,
    }
    : { kind: source.kind, origin: source.origin, path: source.directory, files };
}

function fingerprint(files: readonly string[]): string {
  return JSON.stringify(files.map((file) => {
    try {
      const stat = statSync(file);
      return [file, stat.size, stat.mtimeMs];
    } catch {
      return [file, null, null];
    }
  }));
}

function requireStopped(result: WriterProbeResult, phase: string): void {
  if (result.state === 'running') throw new WebviewMigrationError('WRITER_RUNNING', `${phase}: ${result.detail}`);
  if (result.state === 'unknown') throw new WebviewMigrationError('WRITER_UNVERIFIED', `${phase}: ${result.detail}`);
}

function decodeSnapshot(snapshotDir: string, source: SourceRecord): LocalStorageEntry[] {
  try {
    if (source.kind === 'webkit-sqlite') return decodeWebKitLocalStorage(join(snapshotDir, SQLITE_SNAPSHOT));
    return decodeChromiumLocalStorage(readLevelDb(join(snapshotDir, LEVELDB_SNAPSHOT)), source.origin);
  } catch (error) {
    throw new WebviewMigrationError('SOURCE_UNREADABLE', `解码快照失败: ${errorText(error)}`, { cause: error });
  }
}

function copySnapshot(snapshotDir: string, source: MigrationSource, files: readonly string[]): void {
  rmSync(snapshotDir, { recursive: true, force: true });
  if (source.kind === 'webkit-sqlite') {
    mkdirSync(snapshotDir, { recursive: true });
    for (const file of files) copyFileSync(file, join(snapshotDir, `${SQLITE_SNAPSHOT}${file.slice(source.database.length)}`));
    return;
  }
  const target = join(snapshotDir, LEVELDB_SNAPSHOT);
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(file, join(target, basename(file)));
}

/**
 * main 进程启动早期调用（Host 启动、首个窗口加载之前）。返回 `pending` 时把 `entries`
 * 交给 preload 写入；成功后 `flushStorageData()` 再调用 {@link completeWebviewMigration}。
 */
export async function prepareWebviewMigration(options: WebviewMigrationOptions): Promise<PreparedWebviewMigration> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const dir = migrationDir(options.userDataDir);
  const snapshotDir = join(dir, SNAPSHOT_DIR);
  const state = readState(dir, log);

  if (state?.status === 'done') return { status: 'done' };
  if (state?.status === 'snapshotted' && state.source !== null) {
    log(`[webview-migration] 复用已有快照（${state.source.kind}，源 ${state.source.path}）`);
    return { status: 'pending', entries: decodeSnapshot(snapshotDir, state.source), source: state.source };
  }

  let source: MigrationSource | null;
  try {
    source = locateMigrationSource(options);
  } catch (error) {
    if (error instanceof SourceLocationError) throw new WebviewMigrationError('SOURCE_AMBIGUOUS', error.message, { cause: error });
    throw new WebviewMigrationError('SOURCE_UNREADABLE', `定位旧版 WebView 存储失败: ${errorText(error)}`, { cause: error });
  }
  if (source === null) {
    writeState(dir, { version: 1, status: 'done', source: null, updatedAt: now().toISOString() });
    log('[webview-migration] 未找到 Tauri 版 WebView 存储（新用户），标记完成');
    return { status: 'done' };
  }

  let files: string[];
  try {
    files = sourceFiles(source);
  } catch (error) {
    throw new WebviewMigrationError('SOURCE_UNREADABLE', `列出源文件失败: ${errorText(error)}`, { cause: error });
  }
  const record = recordOf(source, files);
  writeState(dir, { version: 1, status: 'snapshotting', source: record, updatedAt: now().toISOString() });
  log(`[webview-migration] 准备快照 ${record.kind}: ${record.path}（${files.length} 个文件）`);

  const probe = options.probe ?? defaultWriterProbe(options);
  const before = fingerprint(files);
  requireStopped(await probe.check(files), '复制前');
  try {
    copySnapshot(snapshotDir, source, files);
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw new WebviewMigrationError('SNAPSHOT_FAILED', `复制 ${record.path} 失败: ${errorText(error)}`, { cause: error });
  }
  try {
    requireStopped(await probe.check(files), '复制后');
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
  let filesAfter: string[] | null;
  try { filesAfter = sourceFiles(source); } catch { filesAfter = null; }
  if (filesAfter === null || fingerprint(filesAfter) !== before || filesAfter.join('\n') !== files.join('\n')) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw new WebviewMigrationError('SOURCE_CHANGED', `核验与复制期间 ${record.path} 的文件集合或大小/修改时间发生变化`);
  }

  const entries = decodeSnapshot(snapshotDir, record);
  writeState(dir, { version: 1, status: 'snapshotted', source: record, updatedAt: now().toISOString() });
  log(`[webview-migration] 快照完成，待写入 ${entries.length} 个键`);
  return { status: 'pending', entries, source: record };
}

/** preload 回报后、`flushStorageData()` 完成后调用；有写入失败时不标记完成，下次启动重放。 */
export function completeWebviewMigration(
  options: Pick<WebviewMigrationOptions, 'userDataDir' | 'log' | 'now'>,
  report: WebviewMigrationApplyReport,
): void {
  const log = options.log ?? (() => undefined);
  const dir = migrationDir(options.userDataDir);
  const state = readState(dir, log);
  if (state?.status !== 'snapshotted' || state.source === null) {
    throw new WebviewMigrationError('NOT_SNAPSHOTTED', `当前状态 ${state?.status ?? '无'}，不能标记完成`);
  }
  if (report.failed.length > 0) {
    const sample = report.failed.slice(0, 5).map((item) => `${item.key}: ${item.error}`).join('; ');
    throw new WebviewMigrationError('TARGET_WRITE_FAILED', `${report.failed.length} 个键写入失败（${sample}）`);
  }
  writeState(dir, {
    version: 1,
    status: 'done',
    source: state.source,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    result: { written: report.written, kept: report.kept },
  });
  log(`[webview-migration] 完成：写入 ${report.written} 个键，保留目标已有 ${report.kept} 个键`);
}

/** 诊断用：迁移状态文件是否已是 `done`。 */
export function webviewMigrationDone(userDataDir: string): boolean {
  const file = join(migrationDir(userDataDir), STATE_FILE);
  if (!existsSync(file)) return false;
  return readState(migrationDir(userDataDir), () => undefined)?.status === 'done';
}
