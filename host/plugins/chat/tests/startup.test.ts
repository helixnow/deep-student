import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { reconcileInterruptedBlocksOnStartup, INTERRUPTED_BY_RESTART_ERROR } from '../repository/startup.ts';

describe('chat_v2 startup recovery', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  const logs: { level: string; message: string }[] = [];
  const logger = definePlugin({ meta: { id: 'test.chat.startup-logger' }, apply(ctx) {
    ctx.logger.exporter({ levels: { default: 4 }, export(message) {
      logs.push({ level: message.type, message: String(message.args[0]) });
    } });
  } });
  beforeEach(() => {
    f = databaseFixture(); host = undefined; logs.length = 0;
    createSession(f.db, newSession('sess_reconcile', 'chat'));
    createMessage(f.db, { id: 'msg_reconcile', sessionId: 'sess_reconcile', role: 'assistant', blockIds: [], timestamp: 1000 });
  });
  afterEach(async () => { await host?.dispose(); f.dispose(); });
  function insert(id: string, type: string, status: string, content: string | null): void {
    f.db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, started_at)
      VALUES (?1, 'msg_reconcile', ?2, ?3, 0, ?4, 1000)`, [id, type, status, content]);
  }
  function status(id: string) {
    return f.db.one<{ status: string; error: string | null; ended_at: number | null }>(
      'SELECT status, error, ended_at FROM chat_v2_blocks WHERE id = ?1', [id]);
  }
  async function boot() {
    host = await createTestHost({ plugins: [logger, plugin], provide: { storage: f.storage, vfs: vfsStub } });
  }
  it('startup_reconcile_finishes_streamed_text_and_interrupts_the_rest', async () => {
    insert('blk_think', 'thinking', 'running', '推理到一半');
    insert('blk_text', 'content', 'running', '先说结论');
    insert('blk_empty', 'content', 'pending', null);
    insert('blk_tool', 'mcp_tool', 'running', null);
    insert('blk_done', 'content', 'success', '早已完成');
    expect(reconcileInterruptedBlocksOnStartup(f.db, { info(message) { logs.push({ level: 'info', message }); } })).toBe(4);
    expect(status('blk_think').status).toBe('success'); expect(status('blk_text').status).toBe('success');
    expect(status('blk_tool').status).toBe('error');
    expect(status('blk_tool').error).toBe(INTERRUPTED_BY_RESTART_ERROR);
    expect(status('blk_tool').ended_at).not.toBeNull();
    expect(status('blk_empty').status).toBe('error');
    expect(status('blk_done')).toEqual({ status: 'success', error: null, ended_at: null });
    expect(reconcileInterruptedBlocksOnStartup(f.db, { info(message) { logs.push({ level: 'info', message }); } })).toBe(0);
    expect(logs).toEqual([{ level: 'info', message: '[ChatV2::Repo] Reconciled 4 interrupted blocks on startup (2 finished, 2 marked interrupted)' }]);
    // Production startup also uses this repository function.
    insert('blk_restart', 'mcp_tool', 'pending', null);
    await boot(); expect(status('blk_restart').error).toBe(INTERRUPTED_BY_RESTART_ERROR);
  });
  it('startup preserves timestamp precedence, existing errors and SQLite whitespace rules', async () => {
    for (const [id, text] of [['blk_ended', 'text'], ['blk_first', '\t\n'], ['blk_started', 'text'], ['blk_empty', '   ']]) {
      insert(id!, 'content', 'running', text!);
    }
    f.db.run("UPDATE chat_v2_blocks SET ended_at = 3000, first_chunk_at = 2000, error = 'old error' WHERE id = 'blk_ended'");
    f.db.run("UPDATE chat_v2_blocks SET first_chunk_at = 2000 WHERE id = 'blk_first'");
    f.db.run("UPDATE chat_v2_blocks SET ended_at = 4000, error = 'existing' WHERE id = 'blk_empty'");
    await boot();
    expect(status('blk_ended')).toEqual({ status: 'success', error: 'old error', ended_at: 3000 });
    expect(status('blk_first')).toEqual({ status: 'success', error: null, ended_at: 2000 });
    expect(status('blk_started').ended_at).toBe(1000);
    expect(status('blk_empty')).toEqual({ status: 'error', error: 'existing', ended_at: 4000 });
  });
  it('startup removes older user content blocks before reconciliation without rewriting message block ids', async () => {
    createMessage(f.db, { id: 'msg_user', sessionId: 'sess_reconcile', role: 'user', blockIds: ['blk_old'], timestamp: 1000 });
    for (const id of ['blk_old', 'blk_latest']) {
      insert(id, 'content', 'running', id);
      f.db.run("UPDATE chat_v2_blocks SET message_id = 'msg_user' WHERE id = ?1", [id]);
    }
    insert('blk_assistant_a', 'content', 'success', 'a'); insert('blk_assistant_b', 'content', 'success', 'b');
    await boot();
    expect(f.db.get('SELECT id FROM chat_v2_blocks WHERE id = ?', ['blk_old'])).toBeUndefined();
    expect(status('blk_latest').status).toBe('success');
    expect(f.db.pluck("SELECT block_ids_json FROM chat_v2_messages WHERE id = 'msg_user'")).toBe('["blk_old"]');
    expect(status('blk_assistant_a').status).toBe('success'); expect(status('blk_assistant_b').status).toBe('success');
    expect(logs.filter(row => row.level === 'info').map(row => row.message)).toEqual([
      '[ChatV2::Repo] Cleaned up 1 orphan user content blocks',
      '[ChatV2] Startup cleanup: removed 1 orphan user content blocks',
      '[ChatV2::Repo] Reconciled 1 interrupted blocks on startup (1 finished, 0 marked interrupted)',
    ]);
  });
  it('a failed second update leaves the first committed and only warns at startup', async () => {
    insert('blk_text', 'content', 'running', 'partial text'); insert('blk_tool', 'mcp_tool', 'pending', null);
    f.db.exec("CREATE TRIGGER fail_interrupt BEFORE UPDATE ON chat_v2_blocks WHEN NEW.status = 'error' BEGIN SELECT RAISE(FAIL, 'interrupt blocked'); END");
    await boot();
    expect(status('blk_text').status).toBe('success'); expect(status('blk_tool').status).toBe('pending');
    expect(logs).toContainEqual({ level: 'warn', message: '[ChatV2] Startup block reconcile failed (non-fatal): Database error: interrupt blocked' });
    expect(logs.some(row => row.message.includes('Reconciled'))).toBe(false);
    expect(await host!.invoke('chat_v2_get_session', { sessionId: 'sess_reconcile' })).toMatchObject({ id: 'sess_reconcile' });
  });
});
