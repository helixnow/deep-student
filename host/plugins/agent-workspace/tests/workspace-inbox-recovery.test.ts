import { expect, it } from 'vitest';
import path from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import { defineQuery, type Row } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import { createWorkspaceHost } from './host-support.ts';

it('WP-063: historical user_version 1 inbox survives repeated peek, exact drain and owner reopen', async () => {
  const { host, storage } = await createWorkspaceHost();
  const directory = path.join(storage.locations.activeDir, 'workspaces');
  const file = path.join(directory, 'ws_ws_old.db');
  try {
    // Production startup migrates chat_v2 (including the shared deletion journal)
    // before the workspace owner lazily opens this historical workspace copy.
    expect((await storage.migrations.runAll()).success).toBe(true);
    mkdirSync(directory, { recursive: true });
    copyFileSync(new URL('./fixtures/wp063/ws_ws_old.db', import.meta.url), file);
    const snapshot = () => {
      const db = storage.openFile(file, { mustExist: true, profile: { readonly: true } });
      try {
        const tables = ['workspace', 'agent', 'message', 'inbox', 'document', 'context', 'sleep_block', 'subagent_task', 'sqlite_sequence'];
        return {
          version: db.pluck<number>('PRAGMA user_version'),
          rows: Object.fromEntries(tables.map(table => [table, db.all(defineQuery<void, Row>(
            `SELECT * FROM "${table}" ORDER BY rowid`, { options: { safeIntegers: true } },
          ))])),
        };
      } finally {
        storage.close(db);
      }
    };
    const before = snapshot();
    expect(before.version).toBe(1);
    expect(before.rows.inbox).toEqual([expect.objectContaining({
      id: 9007199254740993n, session_id: 'worker_old', message_id: 'message_old', status: 'unread',
    })]);
    const coordinator = host.ctx.agentWorkspace;
    const expected = {
      id: 'message_old', workspaceId: 'ws_old', senderSessionId: 'creator_old', targetSessionId: null,
      messageType: 'broadcast', content: '旧消息📚\n第二行', status: 'pending',
      createdAt: '2026-09-30T17:02:03.123456789+00:00',
      metadata: { 中文: '升级📚', nil: null, n: 9007199254740991, ok: true },
    };
    expect(coordinator.pendingInboxCount('ws_old', 'worker_old')).toBe(1);
    expect(snapshot()).toEqual({ ...before, version: 2 });
    for (let i = 0; i < 2; i++) {
      expect(coordinator.peekInbox('ws_old', 'worker_old')).toEqual([expected]);
      expect(coordinator.pendingInboxCount('ws_old', 'worker_old')).toBe(1);
      expect(coordinator.hasPendingMessages('ws_old', 'worker_old')).toBe(true);
      expect(snapshot()).toEqual({ ...before, version: 2 });
    }
    expect(coordinator.drainInbox('ws_old', 'worker_old', 1)).toEqual([expected]);
    expect(coordinator.pendingInboxCount('ws_old', 'worker_old')).toBe(0);
    expect(coordinator.peekInbox('ws_old', 'worker_old')).toEqual([]);
    expect(snapshot()).toEqual({
      version: 2,
      rows: { ...before.rows, inbox: [{ ...before.rows.inbox![0], status: 'processed' }] },
    });
    const next = coordinator.sendMessage('ws_old', 'creator_old', 'worker_old', 'task', '恢复后任务📚');
    expect(coordinator.pendingInboxCount('ws_old', 'worker_old')).toBe(1);
    expect(coordinator.peekInbox('ws_old', 'worker_old')).toEqual([{ ...next, status: 'delivered' }]);
    expect(coordinator.drainInbox('ws_old', 'worker_old', 10)).toEqual([{ ...next, status: 'delivered' }]);
    expect(coordinator.pendingInboxCount('ws_old', 'worker_old')).toBe(0);
    const drained = snapshot();
    expect(drained.rows.message!.find(row => row.id === 'message_old')).toEqual(before.rows.message![0]);
    expect(drained.rows.inbox!.find(row => row.message_id === 'message_old')).toEqual({
      ...before.rows.inbox![0], status: 'processed',
    });
    await coordinator.enterMaintenanceMode();
    await host.unload(plugin.meta.id);
    await host.install(plugin);
    expect(host.ctx.agentWorkspace.peekInbox('ws_old', 'worker_old')).toEqual([]);
    expect(host.ctx.agentWorkspace.pendingInboxCount('ws_old', 'worker_old')).toBe(0);
    expect(snapshot()).toEqual(drained);
  } finally {
    await host.ctx.agentWorkspace.enterMaintenanceMode();
    storage.dispose();
    await host.dispose();
  }
});

it('WP-063: reloaded owner preserves unread rows across peek and shares the restored queue with routing', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const original = host.ctx.agentWorkspace;
    const workspace = original.createWorkspace('coordinator', 'inbox recovery');
    original.registerAgent(workspace.id, 'coordinator', 'coordinator', null, null);
    original.registerAgent(workspace.id, 'worker', 'worker', null, null);
    const message = original.sendMessage(workspace.id, 'worker', 'coordinator', 'result', '旧消息📚\n第二行');
    const file = path.join(storage.locations.activeDir, 'workspaces', `ws_${workspace.id}.db`);
    const rows = () => {
      const db = storage.openFile(file, { mustExist: true, profile: { readonly: true } });
      try {
        return {
          inbox: db.all('SELECT * FROM inbox ORDER BY id'),
          messages: db.all('SELECT * FROM message ORDER BY id'),
        };
      } finally {
        storage.close(db);
      }
    };
    const before = rows();
    await original.enterMaintenanceMode();
    await host.unload(plugin.meta.id);
    await host.install(plugin);
    const restored = host.ctx.agentWorkspace;
    expect(restored.loadedWorkspaceIds()).toEqual([]);
    expect(restored.pendingInboxCount(workspace.id, 'coordinator')).toBe(1);
    const expected = { ...message, status: 'delivered' };
    for (let i = 0; i < 2; i++) {
      expect(restored.peekInbox(workspace.id, 'coordinator')).toEqual([expected]);
      expect(restored.pendingInboxCount(workspace.id, 'coordinator')).toBe(1);
      expect(restored.hasPendingMessages(workspace.id, 'coordinator')).toBe(true);
      expect(rows()).toEqual(before);
    }
    const newer = restored.sendMessage(workspace.id, 'worker', 'coordinator', 'task', 'new task');
    expect(restored.peekInbox(workspace.id, 'coordinator').map(item => item.id)).toEqual([message.id, newer.id]);
    expect(restored.pendingInboxCount(workspace.id, 'coordinator')).toBe(2);
    expect(restored.drainInbox(workspace.id, 'coordinator', 1)).toEqual([expected]);
    expect(restored.pendingInboxCount(workspace.id, 'coordinator')).toBe(1);
    expect(rows().inbox).toEqual([
      { ...before.inbox[0], status: 'processed' },
      expect.objectContaining({ message_id: newer.id, status: 'unread' }),
    ]);
    expect(restored.peekInbox(workspace.id, 'coordinator').map(item => item.id)).toEqual([newer.id]);
    expect(restored.drainInbox(workspace.id, 'coordinator', 10).map(item => item.id)).toEqual([newer.id]);
    expect(restored.pendingInboxCount(workspace.id, 'coordinator')).toBe(0);
    expect(restored.hasPendingMessages(workspace.id, 'coordinator')).toBe(false);
    expect(rows().messages.find(row => row.id === message.id)).toEqual(before.messages[0]);
    await restored.enterMaintenanceMode();
    await host.unload(plugin.meta.id);
    await host.install(plugin);
    expect(host.ctx.agentWorkspace.peekInbox(workspace.id, 'coordinator')).toEqual([]);
    expect(host.ctx.agentWorkspace.pendingInboxCount(workspace.id, 'coordinator')).toBe(0);
  } finally {
    await host.ctx.agentWorkspace.enterMaintenanceMode();
    storage.dispose();
    await host.dispose();
  }
});
