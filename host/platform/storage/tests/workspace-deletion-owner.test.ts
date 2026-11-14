import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SlotOccupied } from '../../../kernel/api.ts';
import { deleteWorkspaceIndex } from '../../../plugins/agent-workspace/repository/chat-v2-repository.ts';
import { registerWorkspaceIndexDeletionOwner, type SqlExecutor } from '../api.ts';
import { prepareWorkspaceDeletion } from '../node.ts';
import { SqliteDatabase } from '../database.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workspace-owner-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new SqliteDatabase({ name: 'chat_v2', path: path.join(dir, 'chat.db'), profile: {} });
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE workspace_index (workspace_id TEXT PRIMARY KEY);
    CREATE TABLE __file_deletion_journal (
      operation_id TEXT PRIMARY KEY, target_kind TEXT, entity_key TEXT, local_path TEXT,
      expected_hash TEXT, size INTEGER, state TEXT, prepared_at TEXT, ready_at TEXT,
      published_at TEXT, cancelled_at TEXT, retry_count INTEGER DEFAULT 0, last_error TEXT);
    INSERT INTO workspace_index VALUES ('w1')`);
  const file = path.join(dir, 'ws_w1.db');
  fs.writeFileSync(file, 'workspace bytes');
  return { db, dir, file };
}

it('prepare_workspace_deletion delegates to the real L05 owner inside its original savepoint', () => {
  const { db, dir, file } = setup();
  const seen: SqlExecutor[] = [];
  const registration = registerWorkspaceIndexDeletionOwner((conn, id) => {
    seen.push(conn);
    expect(conn).toBe(db);
    expect(conn.inTransaction).toBe(true);
    expect(conn.pluck('SELECT state FROM __file_deletion_journal WHERE entity_key = ?', [id])).toBe('prepared');
    deleteWorkspaceIndex(conn, id);
  });
  cleanups.push(() => registration.dispose());
  const intent = prepareWorkspaceDeletion(db, dir, 'w1');
  expect(seen).toHaveLength(1);
  expect(db.inTransaction).toBe(false);
  expect(db.pluck('SELECT COUNT(*) FROM workspace_index')).toBe(0);
  expect(db.pluck('SELECT state FROM __file_deletion_journal WHERE operation_id = ?', [intent.operation_id])).toBe('prepared');
  expect(fs.readFileSync(file, 'utf8')).toBe('workspace bytes');
});

it('prepare_workspace_deletion rolls back both writes on owner SQL error and preserves the file', () => {
  const { db, dir, file } = setup();
  db.exec("CREATE TRIGGER deny_delete BEFORE DELETE ON workspace_index BEGIN SELECT RAISE(ABORT, 'owner denied'); END");
  const registration = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndex);
  cleanups.push(() => registration.dispose());
  expect(() => prepareWorkspaceDeletion(db, dir, 'w1')).toThrow('删除意图数据库错误: owner denied');
  expect(db.pluck('SELECT COUNT(*) FROM __file_deletion_journal')).toBe(0);
  expect(db.pluck('SELECT COUNT(*) FROM workspace_index')).toBe(1);
  expect(db.inTransaction).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
});

it('workspace owner registration rejects duplicates, disposes idempotently and fails visibly when absent', () => {
  const { db, dir } = setup();
  const first = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndex);
  cleanups.push(() => first.dispose());
  expect(() => registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndex)).toThrow(SlotOccupied);
  first.dispose(); first.dispose();
  expect(() => prepareWorkspaceDeletion(db, dir, 'w1')).toThrow('workspace index deletion owner is not registered');
  expect(db.pluck('SELECT COUNT(*) FROM __file_deletion_journal')).toBe(0);
  const second = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndex);
  cleanups.push(() => second.dispose());
  first.dispose(); // An old disposer must not clear its replacement.
  expect(prepareWorkspaceDeletion(db, dir, 'missing').entity_key).toBe('missing');
  expect(db.pluck('SELECT COUNT(*) FROM workspace_index')).toBe(1);
});
