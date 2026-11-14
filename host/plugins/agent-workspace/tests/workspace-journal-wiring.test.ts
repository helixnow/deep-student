import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerWorkspaceIndexDeletionOwner, StorageError, type DatabaseHandle } from '../../../platform/storage/api.ts';
import { prepareWorkspaceDeletion } from '../../../platform/storage/node.ts';
import { createWorkspaceHost } from './host-support.ts';
import { deleteWorkspaceIndexWithConn } from '../api.ts';
import { WorkspaceDatabase } from '../src/workspace/database.ts';
import type { WorkspaceStoreIo } from '../src/workspace/database.ts';

it('v2 journal prepare failure preserves metadata/file and closes the borrowed real F3 handle', async () => {
  const { host, storage } = await createWorkspaceHost();
  const opened: DatabaseHandle[] = [];
  const closed: DatabaseHandle[] = [];
  const io: WorkspaceStoreIo = {
    open(file) { const db = storage.openFile(file, { profile: 'workspace' }); opened.push(db); return db; },
    close(db) { closed.push(db as DatabaseHandle); storage.close(db as DatabaseHandle); },
  };
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const workspace = host.ctx.agentWorkspace.createWorkspace('coord', 'journal');
    host.ctx.agentWorkspace.closeWorkspace(workspace.id);
    const root = path.join(storage.locations.activeDir, 'workspaces');
    const file = path.join(root, `ws_${workspace.id}.db`);
    const chat = storage.database('chat_v2');
    // F3-V2-05: the owner operation participates in, but never commits, the caller's transaction.
    expect(() => chat.transaction(tx => {
      deleteWorkspaceIndexWithConn(tx, workspace.id);
      expect(tx.pluck('SELECT COUNT(*) FROM workspace_index WHERE workspace_id = ?', [workspace.id])).toBe(0);
      expect(fs.existsSync(file)).toBe(true);
      throw new Error('caller rolls back');
    }, { behavior: 'immediate' })).toThrow('caller rolls back');
    expect(chat.pluck('SELECT COUNT(*) FROM workspace_index WHERE workspace_id = ?', [workspace.id])).toBe(1);
    expect(() => deleteWorkspaceIndexWithConn(chat, 'missing-workspace')).not.toThrow();
    chat.exec("CREATE TRIGGER fail_owner_delete BEFORE DELETE ON workspace_index BEGIN SELECT RAISE(FAIL, 'owner deletion denied'); END;");
    let ownerError: unknown;
    try { deleteWorkspaceIndexWithConn(chat, workspace.id); } catch (error) { ownerError = error; }
    expect(ownerError).toBeInstanceOf(StorageError);
    expect(ownerError).toMatchObject({ message: 'owner deletion denied', code: 'SQLITE', sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(() => WorkspaceDatabase.deleteDatabase(io, root, workspace.id)).toThrow('owner deletion denied');
    expect(chat.pluck('SELECT COUNT(*) FROM __file_deletion_journal WHERE entity_key = ?', [workspace.id])).toBe(0);
    expect(chat.pluck('SELECT COUNT(*) FROM workspace_index WHERE workspace_id = ?', [workspace.id])).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
    expect(closed).toEqual(opened);
    chat.exec('DROP TRIGGER fail_owner_delete');
    chat.exec("CREATE TRIGGER fail_prepare BEFORE INSERT ON __file_deletion_journal BEGIN SELECT RAISE(FAIL, 'prepare denied'); END;");
    expect(() => WorkspaceDatabase.deleteDatabase(io, root, workspace.id)).toThrow('Failed to prepare workspace deletion:');
    expect(fs.existsSync(file)).toBe(true);
    expect(chat.pluck('SELECT COUNT(*) FROM workspace_index WHERE workspace_id = ?', [workspace.id])).toBe(1);
    expect(closed).toEqual(opened);
    chat.exec('DROP TRIGGER fail_prepare');
    WorkspaceDatabase.deleteDatabase(io, root, workspace.id);
    expect(fs.existsSync(file)).toBe(false);
    expect(chat.pluck('SELECT state FROM __file_deletion_journal WHERE entity_key = ?', [workspace.id])).toBe('ready');
    expect(chat.pluck('SELECT COUNT(*) FROM workspace_index WHERE workspace_id = ?', [workspace.id])).toBe(0);
    expect(closed).toEqual(opened);
    const recreated = WorkspaceDatabase.create(io, root, workspace.id);
    expect(chat.pluck('SELECT state FROM __file_deletion_journal WHERE entity_key = ?', [workspace.id])).toBe('cancelled');
    expect(chat.pluck('SELECT COUNT(*) FROM __workspace_deletion_queue WHERE workspace_id = ?', [workspace.id])).toBe(0);
    recreated.close();
    expect(closed).toEqual(opened);
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('plugin apply registers the workspace owner and host disposal releases it for the next scope', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const chat = storage.database('chat_v2');
    const root = path.join(storage.locations.activeDir, 'workspaces');
    fs.mkdirSync(root, { recursive: true });
    expect(() => registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn)).toThrow();
    expect(prepareWorkspaceDeletion(chat, root, 'missing-before-disposal').entity_key).toBe('missing-before-disposal');
    await host.dispose();
    expect(() => prepareWorkspaceDeletion(chat, root, 'missing-after-disposal'))
      .toThrow('workspace index deletion owner is not registered');
    expect(chat.pluck('SELECT COUNT(*) FROM __file_deletion_journal WHERE entity_key = ?', ['missing-after-disposal'])).toBe(0);
    const successor = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn);
    try {
      expect(prepareWorkspaceDeletion(chat, root, 'missing-after-reload').entity_key).toBe('missing-after-reload');
    } finally { successor.dispose(); }
  } finally { await host.dispose(); storage.dispose(); }
});

it('v2 journal foreign-key configuration failure keeps its Rust prefix and releases the connection', async () => {
  const { host, storage } = await createWorkspaceHost();
  const closed: DatabaseHandle[] = [];
  let opened: DatabaseHandle | undefined;
  try {
    const io: WorkspaceStoreIo = {
      open(file) {
        opened = storage.openFile(file, { profile: 'workspace' });
        const exec = opened.exec.bind(opened);
        vi.spyOn(opened, 'exec').mockImplementation(sql => {
          if (sql === 'PRAGMA foreign_keys = ON') throw new Error('foreign keys denied');
          exec(sql);
        });
        return opened;
      },
      close(db) { closed.push(db as DatabaseHandle); storage.close(db as DatabaseHandle); },
    };
    const root = path.join(storage.locations.activeDir, 'workspaces');
    expect(() => WorkspaceDatabase.create(io, root, 'new-workspace'))
      .toThrow(new Error('Failed to enable workspace deletion foreign keys: foreign keys denied'));
    expect(closed).toEqual([opened]);
    expect(fs.existsSync(path.join(root, 'ws_new-workspace.db'))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    storage.dispose();
    await host.dispose();
  }
});
