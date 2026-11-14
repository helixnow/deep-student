import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';

describe('C04-01/C04-05 real SQLite command error boundaries', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.chatSession.createSession(newSession('sess_tx_error', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  const snapshot = () => JSON.stringify({ format: 'deepstudent-conversation-snapshot', version: 1,
    session: newSession('sess_import_source', 'chat'), messages: [], blocks: [] });

  it('C04-01 snapshot export errors are Display strings, not JSON envelopes or HandlerPanic', async () => {
    await expect(host.invoke('chat_v2_export_session_meta', { sessionId: 'sess_missing' })).rejects.toBe('Session not found: sess_missing');
    f.db.exec('DROP TABLE chat_v2_messages');
    await expect(host.invoke('chat_v2_export_session_messages', { sessionId: 'sess_missing', offset: 0 })).rejects.toBe('Database error: no such table: chat_v2_messages');
  });

  it('C04-05 BEGIN contention settles with each command original wire and permits retry', async () => {
    const other = f.storage.openFile(f.db.path, { profile: 'chat_v2', mustExist: true });
    f.db.exec('PRAGMA busy_timeout = 1');
    other.exec('BEGIN IMMEDIATE');
    try {
      await expect(host.invoke('chat_v2_update_session_settings', { sessionId: 'sess_tx_error', settings: { title: 'locked' } }))
        .rejects.toBe('{"code":"DATABASE_ERROR","message":"Database error: database is locked"}');
      await expect(host.invoke('chat_v2_import_session', { snapshotJson: snapshot() })).rejects.toBe('database is locked');
      expect(host.ctx.chatSession.getSession('sess_tx_error')?.title).toBeUndefined();
      expect(f.db.pluck('SELECT count(*) FROM chat_v2_sessions')).toBe(1);
    } finally { other.exec('ROLLBACK'); f.storage.close(other); }
    await expect(host.invoke('chat_v2_update_session_settings', { sessionId: 'sess_tx_error', settings: { title: 'retry' } })).resolves.toMatchObject({ title: 'retry' });
    await expect(host.invoke('chat_v2_import_session', { snapshotJson: snapshot() })).resolves.toMatchObject({ messageCount: 0 });
  });

  it('C04-05 deferred commit failure rolls back settings and import and retains the commit prefix', async () => {
    host.ctx.chatSession.createMessage({ id: 'msg_tx', sessionId: 'sess_tx_error', role: 'assistant', blockIds: ['blk_tx'], timestamp: 0 });
    host.ctx.chatSession.createBlock({ id: 'blk_tx', messageId: 'msg_tx', type: 'content', status: 'success', content: 'original' });
    f.db.exec(`CREATE TABLE commit_constraint (session_id TEXT REFERENCES chat_v2_sessions(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_settings_commit AFTER UPDATE ON chat_v2_sessions BEGIN
        INSERT INTO commit_constraint VALUES ('missing_parent'); END;
      CREATE TRIGGER fail_import_commit AFTER INSERT ON chat_v2_sessions BEGIN
        INSERT INTO commit_constraint VALUES ('missing_parent'); END;
      CREATE TRIGGER fail_block_commit AFTER UPDATE ON chat_v2_blocks BEGIN
        INSERT INTO commit_constraint VALUES ('missing_parent'); END;`);
    await expect(host.invoke('chat_v2_update_session_settings', { sessionId: 'sess_tx_error', settings: { title: 'not committed' } }))
      .rejects.toBe('{"code":"DATABASE_ERROR","message":"Database error: FOREIGN KEY constraint failed"}');
    await expect(host.invoke('chat_v2_import_session', { snapshotJson: snapshot() }))
      .rejects.toBe('Failed to commit import transaction: FOREIGN KEY constraint failed');
    await expect(host.invoke('chat_v2_update_block_content', { blockId: 'blk_tx', content: 'not committed' }))
      .rejects.toBe('{"code":"DATABASE_ERROR","message":"Database error: FOREIGN KEY constraint failed"}');
    await expect(host.invoke('chat_v2_update_block_tool_output', { blockId: 'blk_tx', toolOutputJson: '{"changed":true}' }))
      .rejects.toBe('{"code":"DATABASE_ERROR","message":"Database error: FOREIGN KEY constraint failed"}');
    expect(host.ctx.chatSession.getBlock('blk_tx')?.content).toBe('original');
    expect(host.ctx.chatSession.getBlock('blk_tx')?.toolOutput).toBeUndefined();
    expect(host.ctx.chatSession.getSession('sess_tx_error')?.title).toBeUndefined();
    expect(f.db.pluck('SELECT count(*) FROM chat_v2_sessions')).toBe(1);
    expect(f.db.pluck('SELECT count(*) FROM commit_constraint')).toBe(0);
    f.db.exec('DROP TRIGGER fail_settings_commit; DROP TRIGGER fail_import_commit');
    await expect(host.invoke('chat_v2_import_session', { snapshotJson: snapshot() })).resolves.toMatchObject({ blockCount: 0 });
  });
});
