/** Read-only, lossless SQLite end-state evidence for the scenario-v0 runner. */
// boundary-allow native-import: X3 独立只读逐表差分，必须观察 SQLite typeof 与原始 i64，不能经业务序列化器丢精度；仅 E2E 工具。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export type Cell =
  | { storageClass: 'null'; value: null }
  | { storageClass: 'integer' | 'real' | 'text' | 'blob'; value: string };
export interface Column {
  cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number;
}
export type RowKey = { kind: 'primary'; values: Record<string, Cell>; occurrence: number }
  | { kind: 'ordinal'; index: number };
export interface TableState {
  columns: Column[];
  primaryKey: string[];
  rows: { key: RowKey; values: Record<string, Cell> }[];
}
export interface DatabaseState {
  metadata: { userVersion: number; applicationId: number };
  schema: { type: string; name: string; tbl_name: string; sql: string | null }[];
  tables: Record<string, TableState>;
}
export type FileState = { kind: 'symlink'; target: string } | { kind: 'special' }
  | { kind: 'unreadable'; size: number; sha256: string };
export interface DirectoryState {
  version: 0; databases: Record<string, DatabaseState>;
  /** Non-SQLite evidence only; absent on ordinary trees for existing v0 consumers. */
  files?: Record<string, FileState>;
}
export interface DatabaseDifference {
  kind: 'database' | 'metadata' | 'schema' | 'table' | 'column' | 'row' | 'value' | 'storageClass' | 'file';
  db: string;
  table: string | null;
  key: RowKey | null;
  column: string | null;
  before: unknown;
  after: unknown;
}

function cell(value: unknown, storageClass: unknown): Cell {
  if (storageClass === 'null' && value === null) return { storageClass, value };
  if (storageClass === 'integer' && typeof value === 'bigint') return { storageClass, value: value.toString() };
  if (storageClass === 'real' && typeof value === 'number') {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return { storageClass, value: bytes.toString('hex') };
  }
  if (storageClass === 'text' && typeof value === 'string') return { storageClass, value };
  if (storageClass === 'blob' && value instanceof Uint8Array) return { storageClass, value: Buffer.from(value).toString('hex') };
  throw new Error(`Unexpected SQLite value/storage class: ${String(storageClass)}`);
}

const rank = { null: 0, integer: 1, real: 2, text: 3, blob: 4 };
function compareCell(a: Cell, b: Cell): number {
  if (a.storageClass !== b.storageClass) return rank[a.storageClass] - rank[b.storageClass];
  const value = (c: Cell) => c.storageClass === 'integer' ? BigInt(c.value)
    : c.storageClass === 'real' ? Buffer.from(c.value, 'hex').readDoubleBE() : c.value;
  const av = value(a), bv = value(b);
  if (av === bv) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  return av < bv ? -1 : 1;
}

/** Table reads share one SQLite read transaction; caller quiesces all app writers. */
export function snapshotDatabase(filename: string): DatabaseState {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare<[], DatabaseState['schema'][number]>(
      'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
    ).all();
    const tables: [string, TableState][] = [];
    for (const { name } of schema.filter(row => row.type === 'table')) {
      // xinfo, not info: generated and virtual hidden columns are evidence too.
      const columns = db.prepare<[], Column>(`PRAGMA table_xinfo(${quote(name)})`).all();
      const primaryKey = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
      const names = columns.map(c => c.name);
      const projection = [...names.map(quote), ...names.map(c => `typeof(${quote(c)})`)];
      const raw = db.prepare<[], unknown[]>(`SELECT ${projection.join(',')} FROM ${quote(name)}`).raw().safeIntegers().all();
      const rows = raw.map(row => Object.fromEntries(names.map((column, i) => [column, cell(row[i], row[names.length + i])])));
      const order = [...primaryKey, ...names.filter(n => !primaryKey.includes(n))];
      rows.sort((a, b) => {
        for (const column of order) {
          const result = compareCell(a[column]!, b[column]!);
          if (result !== 0) return result;
        }
        return 0;
      });
      let lastPrimary = '', occurrence = 0;
      tables.push([name, { columns, primaryKey, rows: rows.map((values, index) => {
        // Fixed arrays, never serialized object/HashMap insertion order, form identity.
        const primary = JSON.stringify(primaryKey.map(c => [values[c]!.storageClass, values[c]!.value]));
        occurrence = primary === lastPrimary ? occurrence + 1 : 0;
        lastPrimary = primary;
        const key: RowKey = primaryKey.length
          ? { kind: 'primary', values: Object.fromEntries(primaryKey.map(c => [c, values[c]!])), occurrence }
          : { kind: 'ordinal', index };
        return { key, values };
      }) }]);
    }
    const metadata = {
      userVersion: db.pragma('user_version', { simple: true }) as number,
      applicationId: db.pragma('application_id', { simple: true }) as number,
    };
    db.exec('COMMIT');
    return { metadata, schema, tables: Object.fromEntries(tables) };
  } finally { db.close(); }
}

/** Never open links or special files, including a FIFO named *.db. */
function discover(directory: string): { databases: string[]; files: Record<string, FileState> } {
  const root = resolve(directory), databases: string[] = [], files: Record<string, FileState> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const name = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) files[name] = { kind: 'symlink', target: readlinkSync(full) };
      else if (entry.isFile() && !/-(wal|shm|journal)$/.test(entry.name)) {
        const fd = openSync(full, 'r'), header = Buffer.alloc(16);
        let size: number;
        try { size = readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
        if (size === 16 && header.toString() === 'SQLite format 3\0') databases.push(name);
        else if (/\.(db|db3|sqlite|sqlite3)$/i.test(entry.name)) files[name] = unreadable(full);
      }
      else if (!entry.isFile()) files[name] = { kind: 'special' };
    }
  };
  walk(root);
  return { databases: databases.sort(), files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
}

function unreadable(file: string): FileState {
  return { kind: 'unreadable', size: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

/** Discover nested/owner SQLite files, not a fixed core-DB allowlist. */
export function enumerateDatabases(directory: string): string[] { return discover(directory).databases; }

export function snapshotDirectory(directory: string): DirectoryState {
  const found = discover(directory), databases: Record<string, DatabaseState> = {};
  for (const file of found.databases) {
    try { databases[file] = snapshotDatabase(join(directory, file)); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'SQLITE_NOTADB' && code !== 'SQLITE_CORRUPT') throw error;
      found.files[file] = unreadable(join(directory, file));
    }
  }
  return { version: 0, databases, ...(Object.keys(found.files).length ? { files: found.files } : {}) };
}

/** Object keys are unordered; arrays (including schema/column order) stay ordered. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && equal(value, Reflect.get(b, key)));
}
const union = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
function keyIdentity(key: RowKey): string {
  return key.kind === 'ordinal' ? `ordinal:${key.index}` : JSON.stringify([
    Object.keys(key.values).sort().map(c => [c, key.values[c]!.storageClass, key.values[c]!.value]), key.occurrence,
  ]);
}

/** Pure raw-evidence comparison: no mutation, volatile replacement, epsilon or JSON parsing. */
export function compareDatabaseStates(before: DirectoryState, after: DirectoryState): DatabaseDifference[] {
  const differences: DatabaseDifference[] = [];
  const leftFiles = before.files ?? {}, rightFiles = after.files ?? {};
  for (const file of union(leftFiles, rightFiles)) {
    if (!equal(leftFiles[file], rightFiles[file])) differences.push({ kind: 'file', db: file,
      table: null, key: null, column: null, before: leftFiles[file] ?? null, after: rightFiles[file] ?? null });
  }
  for (const db of union(before.databases, after.databases)) {
    const a = before.databases[db], b = after.databases[db];
    const add = (kind: DatabaseDifference['kind'], table: string | null, key: RowKey | null, column: string | null, left: unknown, right: unknown) => {
      differences.push({ kind, db, table, key, column, before: left ?? null, after: right ?? null });
    };
    if (!a || !b) { add('database', null, null, null, a, b); continue; }
    if (!equal(a.metadata, b.metadata)) add('metadata', null, null, null, a.metadata, b.metadata);
    if (!equal(a.schema, b.schema)) add('schema', null, null, null, a.schema, b.schema);
    for (const table of union(a.tables, b.tables)) {
      const at = a.tables[table], bt = b.tables[table];
      if (!at || !bt) { add('table', table, null, null, at, bt); continue; }
      const ac = Object.fromEntries(at.columns.map(c => [c.name, c]));
      const bc = Object.fromEntries(bt.columns.map(c => [c.name, c]));
      for (const column of union(ac, bc)) if (!equal(ac[column], bc[column])) add('column', table, null, column, ac[column], bc[column]);
      const ar = new Map(at.rows.map(row => [keyIdentity(row.key), row]));
      const br = new Map(bt.rows.map(row => [keyIdentity(row.key), row]));
      for (const id of [...new Set([...ar.keys(), ...br.keys()])].sort()) {
        const left = ar.get(id), right = br.get(id);
        const key = (left ?? right)!.key;
        if (!left || !right) { add('row', table, key, null, left?.values, right?.values); continue; }
        for (const column of union(left.values, right.values)) {
          const av = left.values[column], bv = right.values[column];
          if (!equal(av, bv)) add(av && bv && av.storageClass !== bv.storageClass ? 'storageClass' : 'value', table, key, column, av, bv);
        }
      }
    }
  }
  return differences;
}

/** Retains both raw snapshots; X7 persists A1/A2/B separately before any projection. */
export function compareDatabaseDirectories(left: string, right: string) {
  const before = snapshotDirectory(left), after = snapshotDirectory(right);
  const differences = compareDatabaseStates(before, after);
  return { equal: differences.length === 0, before, after, differences };
}
