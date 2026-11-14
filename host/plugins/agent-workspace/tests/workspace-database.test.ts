import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { registerWorkspaceIndexDeletionOwner, type SqlExecutor } from '../../../platform/storage/api.ts';
import { deleteWorkspaceIndexWithConn } from '../api.ts';
import {
  WorkspaceDatabase, validateWorkspaceId,
} from '../src/workspace/database.ts';
import type { WorkspaceStoreIo } from '../src/workspace/database.ts';
import { generateWorkspaceId } from '../src/workspace/types.ts';

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const handles = new WeakMap<SqlExecutor, SqliteDatabase>();

function openSqlite(dbPath: string): SqlExecutor {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const params = (value: unknown): unknown[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
  const executor = {
    get: (sql: string, value?: unknown) => db.prepare(sql).get(...params(value)),
    one: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value));
      if (row === undefined) throw new Error('Query returned no rows');
      return row;
    },
    pluck: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value)) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : Object.values(row)[0];
    },
    all: (sql: string, value?: unknown) => db.prepare(sql).all(...params(value)),
    iterate: (sql: string, value?: unknown) => db.prepare(sql).iterate(...params(value)),
    run: (sql: string, value?: unknown) => db.prepare(sql).run(...params(value)),
    exec: (sql: string) => { db.exec(sql); },
  } as unknown as SqlExecutor;
  handles.set(executor, db);
  return executor;
}

const io: WorkspaceStoreIo = {
  open: openSqlite,
  close: executor => {
    const db = handles.get(executor);
    if (db) db.close();
  },
};

function tempWorkspacesDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-database-'));
  return path.join(root, 'active', 'workspaces');
}

function setupWorkspaceDeletion(): { dir: string; workspacesDir: string; workspaceId: string; chatDb: string } {
  const workspacesDir = tempWorkspacesDir();
  fs.mkdirSync(workspacesDir, { recursive: true });
  const chatDb = path.join(path.dirname(workspacesDir), 'chat_v2.db');
  const workspaceId = 'ws_delete_test';
  const db = new DatabaseSync(chatDb);
  db.exec(
    `CREATE TABLE workspace_index (
         workspace_id TEXT PRIMARY KEY,
         name TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         creator_session_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
     );
     CREATE TABLE __workspace_deletion_queue (
         workspace_id TEXT PRIMARY KEY,
         size INTEGER,
         deleted_at TEXT NOT NULL,
         retry_count INTEGER NOT NULL DEFAULT 0
     );`,
  );
  db.exec(fs.readFileSync(
    path.join(process.cwd(), 'resources/app/migrations/chat_v2/V20260721__workspace_deletion_intent_journal.sql'),
    'utf8',
  ));
  db.prepare(
    `INSERT INTO workspace_index (workspace_id, creator_session_id, created_at, updated_at)
     VALUES (?1, 'creator', 'now', 'now')`,
  ).run(workspaceId);
  db.close();
  fs.writeFileSync(path.join(workspacesDir, `ws_${workspaceId}.db`), 'workspace baseline');
  return { dir: path.dirname(workspacesDir), workspacesDir, workspaceId, chatDb };
}

describe('workspace_database', () => {
  let owner: ReturnType<typeof registerWorkspaceIndexDeletionOwner>;
  beforeEach(() => { owner = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn); });
  afterEach(() => { owner.dispose(); });

  it('validate_workspace_id_accepts_generated_ids', () => {
    const id = generateWorkspaceId();
    expect(() => validateWorkspaceId(id), `generated id ${id}`).not.toThrow();
    expect(() => validateWorkspaceId('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow();
    expect(() => validateWorkspaceId('legacy-id_123')).not.toThrow();
  });

  it('validate_workspace_id_rejects_path_escapes', () => {
    for (const bad of [
      '', '..', '../evil', 'a/b', 'a\\b', 'ws_..', 'ws_1\0', 'ws 1', 'ws_1.db',
    ]) {
      expect(() => validateWorkspaceId(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
    expect(() => validateWorkspaceId('a'.repeat(129))).toThrow();
  });

  it('workspace_database_new_rejects_traversal_ids', () => {
    const dir = tempWorkspacesDir();
    expect(() => WorkspaceDatabase.create(io, dir, '../escape')).toThrow();
    expect(() => WorkspaceDatabase.deleteDatabase(io, dir, '../escape')).toThrow();
    // 合法 id 正常创建。
    const db = WorkspaceDatabase.create(io, dir, 'ws_testvalid123');
    expect(fs.existsSync(db.dbPath)).toBe(true);
  });

  it('prepare_failure_keeps_workspace_file_and_metadata', () => {
    const { workspacesDir, workspaceId, chatDb } = setupWorkspaceDeletion();
    const chat = new DatabaseSync(chatDb);
    chat.exec(
      `CREATE TRIGGER fail_workspace_prepare
       BEFORE INSERT ON __file_deletion_journal
       BEGIN
           SELECT RAISE(FAIL, 'injected prepare failure');
       END;`,
    );
    chat.close();

    let error = '';
    try {
      WorkspaceDatabase.deleteDatabase(io, workspacesDir, workspaceId);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(error).toContain('injected prepare failure');
    expect(fs.existsSync(path.join(workspacesDir, `ws_${workspaceId}.db`))).toBe(true);

    const inspect = new DatabaseSync(chatDb);
    const metadataExists = inspect.prepare(
      'SELECT EXISTS(SELECT 1 FROM workspace_index WHERE workspace_id = ?1) AS value',
    ).get(workspaceId) as { value: number };
    expect(Number(metadataExists.value)).not.toBe(0);
    inspect.close();
  });

  it('ready_failure_is_reported_and_next_call_recovers', () => {
    const { workspacesDir, workspaceId, chatDb } = setupWorkspaceDeletion();
    const walPath = path.join(workspacesDir, `ws_${workspaceId}.db-wal`);
    const shmPath = path.join(workspacesDir, `ws_${workspaceId}.db-shm`);
    fs.writeFileSync(walPath, 'wal');
    fs.writeFileSync(shmPath, 'shm');

    const chat = new DatabaseSync(chatDb);
    chat.exec(
      `CREATE TRIGGER fail_workspace_outbox
       BEFORE INSERT ON __workspace_deletion_queue
       BEGIN
           SELECT RAISE(FAIL, 'injected workspace outbox failure');
       END;`,
    );
    chat.close();

    let error = '';
    try {
      WorkspaceDatabase.deleteDatabase(io, workspacesDir, workspaceId);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(error).toContain('injected workspace outbox failure');
    expect(fs.existsSync(path.join(workspacesDir, `ws_${workspaceId}.db`))).toBe(false);
    expect(fs.existsSync(walPath)).toBe(false);
    expect(fs.existsSync(shmPath)).toBe(false);

    let inspect = new DatabaseSync(chatDb);
    const prepared = inspect.prepare(
      'SELECT state FROM __file_deletion_journal WHERE entity_key = ?1',
    ).get(workspaceId) as { state: string };
    expect(prepared.state).toBe('prepared');
    inspect.exec('DROP TRIGGER fail_workspace_outbox');
    inspect.close();

    WorkspaceDatabase.deleteDatabase(io, workspacesDir, workspaceId);

    inspect = new DatabaseSync(chatDb);
    const ready = inspect.prepare(
      'SELECT state FROM __file_deletion_journal WHERE entity_key = ?1',
    ).get(workspaceId) as { state: string };
    expect(ready.state).toBe('ready');
    inspect.prepare('DELETE FROM __workspace_deletion_queue WHERE workspace_id = ?1').run(workspaceId);
    const published = inspect.prepare(
      'SELECT state FROM __file_deletion_journal WHERE entity_key = ?1',
    ).get(workspaceId) as { state: string };
    expect(published.state).toBe('published');
    inspect.close();
  });
});
