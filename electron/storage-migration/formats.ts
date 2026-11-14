/**
 * Tauri 版 WebView 的 localStorage 落盘格式解码。只读取迁移快照副本，不碰源文件。
 *
 * - WebKit（Linux WebKitGTK、macOS WKWebView）：SQLite `ItemTable(key TEXT, value BLOB)`，
 *   value 为 UTF-16LE 码元原样（DESIGN.md §4 实测）；旧版 WebKit 存 TEXT 时原样取用。
 * - Chromium（Windows WebView2）：LevelDB，数据键 `_<origin>\x00<key>`，键与值首字节
 *   0 = UTF-16LE、1 = Latin-1（Chromium `components/services/storage/dom_storage`）；
 *   `VERSION` 必须是 `1`。
 */
import { createRequire } from 'node:module';
import type { LevelDbRecord } from './leveldb.ts';

export type LocalStorageEntry = readonly [key: string, value: string];

export class LocalStorageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStorageFormatError';
  }
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteConstructor = new (path: string) => SqliteDatabase;

let sqliteConstructor: SqliteConstructor | undefined;

/** Electron 45 内置 Node 24 的 `node:sqlite`（DESIGN.md §5.2 已实测），不新增原生依赖。 */
function openSqlite(file: string): SqliteDatabase {
  sqliteConstructor ??= (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: SqliteConstructor }).DatabaseSync;
  return new sqliteConstructor(file);
}

/** 逐码元还原 UTF-16LE，保留孤立代理与 NUL（不经 TextDecoder）。 */
export function utf16leToString(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new LocalStorageFormatError(`UTF-16 值的字节数为奇数（${bytes.length}）`);
  let out = '';
  const chunk = 8192;
  for (let start = 0; start < bytes.length; start += chunk * 2) {
    const end = Math.min(bytes.length, start + chunk * 2);
    const units = new Array<number>((end - start) / 2);
    for (let index = start; index < end; index += 2) units[(index - start) / 2] = bytes[index]! | (bytes[index + 1]! << 8);
    out += String.fromCharCode(...units);
  }
  return out;
}

/** 解码 WebKit localStorage SQLite（快照副本）：先 `integrity_check`，再按 rowid 读 `ItemTable`。 */
export function decodeWebKitLocalStorage(dbFile: string): LocalStorageEntry[] {
  const db = openSqlite(dbFile);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => String(Object.values(row)[0]));
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new LocalStorageFormatError(`localStorage 快照 integrity_check 失败: ${integrity.join('; ')}`);
    }
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'").get();
    if (table === undefined) throw new LocalStorageFormatError('localStorage 快照中没有 ItemTable，格式未知');
    const rows = db.prepare('SELECT key, value, typeof(key) AS kt, typeof(value) AS vt FROM ItemTable ORDER BY rowid').all();
    return rows.map((row): LocalStorageEntry => {
      if (row.kt !== 'text') throw new LocalStorageFormatError(`ItemTable 键类型为 ${String(row.kt)}`);
      const key = row.key as string;
      if (row.vt === 'blob') return [key, utf16leToString(row.value as Uint8Array)];
      if (row.vt === 'text') return [key, row.value as string];
      throw new LocalStorageFormatError(`ItemTable 键 ${JSON.stringify(key)} 的值类型为 ${String(row.vt)}`);
    });
  } finally {
    db.close();
  }
}

function decodeChromiumString(bytes: Uint8Array, what: string): string {
  if (bytes.length === 0) throw new LocalStorageFormatError(`${what} 缺少编码前缀`);
  const body = bytes.subarray(1);
  if (bytes[0] === 0) return utf16leToString(body);
  if (bytes[0] === 1) return Buffer.from(body).toString('latin1');
  throw new LocalStorageFormatError(`${what} 编码前缀未知: ${bytes[0]}`);
}

/** 从 Chromium localStorage LevelDB 的全部记录中取出某个 origin 的键值。 */
export function decodeChromiumLocalStorage(records: readonly LevelDbRecord[], origin: string): LocalStorageEntry[] {
  const version = records.find((record) => record.key.toString('latin1') === 'VERSION');
  const prefix = Buffer.concat([Buffer.from(`_${origin}`, 'latin1'), Buffer.of(0)]);
  const data = records.filter((record) => record.key.length > prefix.length && record.key.subarray(0, prefix.length).equals(prefix));
  if (version === undefined) {
    if (records.some((record) => record.key[0] === 0x5f)) throw new LocalStorageFormatError('Chromium localStorage 缺少 VERSION，格式未知');
    return [];
  }
  if (version.value.toString('latin1') !== '1') {
    throw new LocalStorageFormatError(`Chromium localStorage VERSION=${JSON.stringify(version.value.toString('latin1'))}，不支持`);
  }
  return data.map((record): LocalStorageEntry => [
    decodeChromiumString(record.key.subarray(prefix.length), '键'),
    decodeChromiumString(record.value, '值'),
  ]);
}
