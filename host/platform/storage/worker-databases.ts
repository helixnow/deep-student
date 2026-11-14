import fs from 'node:fs';
import { StorageError, type CoordinatedDatabaseName, type DatabaseHandle, type OpenFileOptions } from './api.ts';
import { isDriverObject } from './connection.ts';
import { SqliteDatabase } from './database.ts';
import { coreDatabasePath } from './locations.ts';
import { openFileDatabase } from './service.ts';

/** Per-task handles. Does not resolve or rewrite slots/state.json and never runs migrations. */
export class WorkerDatabases {
  private readonly handles = new Set<SqliteDatabase>();
  private readonly activeDir: string;
  private readonly allowed: ReadonlySet<CoordinatedDatabaseName>;

  constructor(activeDir: string, databases: readonly CoordinatedDatabaseName[]) {
    this.activeDir = activeDir;
    this.allowed = new Set(databases);
  }

  openExisting(name: CoordinatedDatabaseName, options?: { readonly?: boolean }): DatabaseHandle | undefined {
    if (!this.allowed.has(name) || !['vfs', 'llm_usage', 'chat_v2', 'mistakes'].includes(name)) {
      throw new StorageError('UNKNOWN_DATABASE', `database worker task cannot open ${name}`);
    }
    const file = coreDatabasePath(this.activeDir, name);
    if (!fs.existsSync(file)) return undefined;
    const db = new SqliteDatabase({
      name, path: file,
      profile: { readonly: options?.readonly ?? true, busyTimeoutMs: 5000, synchronous: 'FULL' },
      mustExist: true, createParentDirs: false,
    });
    this.handles.add(db);
    return db;
  }

  /** Same opener as `StorageService.openFile`; the handle is task-scoped and closed by {@link dispose}. */
  openFile(filePath: string, options?: OpenFileOptions): DatabaseHandle {
    const db = openFileDatabase(filePath, options);
    this.handles.add(db);
    return db;
  }

  close(handle: DatabaseHandle): void {
    if (!(handle instanceof SqliteDatabase) || !this.handles.has(handle)) {
      throw new StorageError('UNKNOWN_DATABASE', 'database does not belong to this worker task');
    }
    handle.close();
    this.handles.delete(handle);
  }

  dispose(): void {
    for (const handle of this.handles) handle.close();
    this.handles.clear();
  }
}

/**
 * Worker results must be plain data: structured clone would silently turn a handle/driver into an
 * inert plain object on the parent thread, so reject it inside the worker instead.
 */
export function assertNoDatabaseHandles(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  seen.add(value);
  if (value instanceof SqliteDatabase || isDriverObject(value)) {
    throw new StorageError('INVALID_PARAM', 'database worker task result must not contain a database handle or driver connection');
  }
  const children = value instanceof Map ? [...value.keys(), ...value.values()]
    : value instanceof Set || Array.isArray(value) ? [...value]
      : Object.values(value);
  for (const child of children) assertNoDatabaseHandles(child, seen);
}
