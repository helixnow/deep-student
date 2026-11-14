/**
 * 定位 Tauri 版 WebView 的 localStorage 源（DESIGN.md §2）。只做存在性检查，不打开文件。
 *
 * - Linux：Tauri 把 WebView 数据目录设为 `<data_local>/<id>`（tauri `manager/webview.rs:534-545`），
 *   旧布局 `localstorage/tauri_localhost_0.localstorage`（实测）；按 origin 分区的新布局
 *   `storage/<h>/<h>/LocalStorage/localstorage.sqlite3`；F3 启动恢复可能已把它们移到
 *   `<appData>/recovery/incidents/<id>/legacy-root/`。
 * - macOS：WKWebView 默认数据存储 `~/Library/WebKit/<id>/WebsiteData/`，旧布局
 *   `LocalStorage/tauri_localhost_0.localstorage`，新布局 `Default/<h>/<h>/LocalStorage/localstorage.sqlite3`。
 * - Windows：WebView2 用户数据目录 `<data_local>/<id>/EBWebView`，`Default/Local Storage/leveldb`，
 *   origin `http://tauri.localhost`（未开 `useHttpsScheme`）。
 *
 * 新布局目录名是 origin 的加盐哈希；第一方 origin 的顶层与帧目录同名，`origin` 文件里有协议与主机
 * 字符串。同名目录且 `origin` 同时含 `tauri`、`localhost` 才认定为应用自身的 origin。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type WebviewPlatform = 'darwin' | 'win32' | 'linux';

export const WEBKIT_ORIGIN = 'tauri://localhost';
export const WEBVIEW2_ORIGIN = 'http://tauri.localhost';

export interface SourceLocation {
  readonly platform: WebviewPlatform;
  readonly homeDir: string;
  /** Rust `dirs::data_local_dir()`（与 Host `ctx.paths.os.dataLocal` 同源）。 */
  readonly dataLocalDir: string;
  /** Tauri `app_data_dir()`（F3 启动恢复事件所在的 base）。 */
  readonly appDataDir: string;
  readonly identifier: string;
}

export type WebKitLayout = 'legacy' | 'origin-partitioned';

export type MigrationSource =
  | {
    readonly kind: 'webkit-sqlite';
    readonly origin: typeof WEBKIT_ORIGIN;
    readonly database: string;
    readonly layout: WebKitLayout;
    readonly recoveredFrom?: string;
  }
  | {
    readonly kind: 'chromium-leveldb';
    readonly origin: typeof WEBVIEW2_ORIGIN;
    readonly directory: string;
  };

export class SourceLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceLocationError';
  }
}

const LEGACY_FILE = 'tauri_localhost_0.localstorage';
const PARTITIONED_FILE = join('LocalStorage', 'localstorage.sqlite3');

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function originFileNamesApp(file: string): boolean {
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return false; }
  return bytes.includes(Buffer.from('tauri', 'latin1')) && bytes.includes(Buffer.from('localhost', 'latin1'));
}

/** 新布局：`<root>/<h>/<h>/LocalStorage/localstorage.sqlite3`，`origin` 指向 tauri://localhost。 */
export function findPartitionedDatabase(root: string): string | null {
  const matches: string[] = [];
  for (const top of listDirectories(root)) {
    const frame = join(root, top, top);
    if (!existsSync(frame)) continue;
    if (!originFileNamesApp(join(frame, 'origin'))) continue;
    const database = join(frame, PARTITIONED_FILE);
    if (isFile(database)) matches.push(database);
  }
  if (matches.length > 1) {
    throw new SourceLocationError(`在 ${root} 找到多个疑似应用 origin 的 localStorage 库，无法确定迁移源: ${matches.join(', ')}`);
  }
  return matches[0] ?? null;
}

function webkitAt(base: string, legacyDir: string, partitionedRoot: string): MigrationSource | null {
  const partitioned = findPartitionedDatabase(join(base, partitionedRoot));
  if (partitioned !== null) return { kind: 'webkit-sqlite', origin: WEBKIT_ORIGIN, database: partitioned, layout: 'origin-partitioned' };
  const legacy = join(base, legacyDir, LEGACY_FILE);
  if (isFile(legacy)) return { kind: 'webkit-sqlite', origin: WEBKIT_ORIGIN, database: legacy, layout: 'legacy' };
  return null;
}

/** 事件清单里的 `created_at`；清单缺失、损坏或没有合法时间时为 null（调用方按目录 mtime 排序）。 */
function manifestCreatedAt(dir: string): number | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const createdAt = (manifest as { created_at?: unknown } | null)?.created_at;
  if (typeof createdAt !== 'string') return null;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function incidentCreatedAt(dir: string): number {
  const created = manifestCreatedAt(dir);
  if (created !== null) return created;
  try { return statSync(dir).mtimeMs; } catch { return 0; }
}

/** Linux：F3 启动恢复把 WebKit 目录移进 `legacy-root` 后，取最近一次事件里的副本。 */
function recoveredWebkit(appDataDir: string): MigrationSource | null {
  const incidents = join(appDataDir, 'recovery', 'incidents');
  const found = listDirectories(incidents)
    .map((id) => ({ id, dir: join(incidents, id) }))
    .map((incident) => ({ ...incident, source: webkitAt(join(incident.dir, 'legacy-root'), 'localstorage', 'storage') }))
    .filter((incident): incident is typeof incident & { source: MigrationSource } => incident.source !== null)
    .sort((a, b) => incidentCreatedAt(b.dir) - incidentCreatedAt(a.dir));
  const latest = found[0];
  if (latest === undefined || latest.source.kind !== 'webkit-sqlite') return null;
  return { ...latest.source, recoveredFrom: latest.id };
}

/** 返回唯一的迁移源；没有旧数据（新用户）时返回 null。 */
export function locateMigrationSource(location: SourceLocation): MigrationSource | null {
  switch (location.platform) {
    case 'linux': {
      const base = join(location.dataLocalDir, location.identifier);
      return webkitAt(base, 'localstorage', 'storage') ?? recoveredWebkit(location.appDataDir);
    }
    case 'darwin': {
      const base = join(location.homeDir, 'Library', 'WebKit', location.identifier, 'WebsiteData');
      return webkitAt(base, 'LocalStorage', 'Default');
    }
    case 'win32': {
      const directory = join(location.dataLocalDir, location.identifier, 'EBWebView', 'Default', 'Local Storage', 'leveldb');
      return isFile(join(directory, 'CURRENT')) ? { kind: 'chromium-leveldb', origin: WEBVIEW2_ORIGIN, directory } : null;
    }
  }
}

/** 快照需要复制的源文件（SQLite 连同 -wal/-shm；LevelDB 不含 LOCK 与 LOG）。 */
export function sourceFiles(source: MigrationSource): string[] {
  if (source.kind === 'webkit-sqlite') {
    return ['', '-wal', '-shm'].map((suffix) => `${source.database}${suffix}`).filter(isFile);
  }
  return readdirSync(source.directory)
    .filter((name) => name === 'CURRENT' || /^MANIFEST-\d+$/.test(name) || /^\d+\.(ldb|sst|log)$/.test(name))
    .sort()
    .map((name) => join(source.directory, name));
}
