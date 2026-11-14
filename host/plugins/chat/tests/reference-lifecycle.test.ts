import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { safeSessionDir } from '../../agent-workspace/api.ts';
import { ChatV2Error } from '../api.ts';

describe('Rust chat/VFS reference compensation and runtime-root lifecycle', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let calls: unknown[][];
  let connectionFailures: number;
  let failures: Map<string, number>;
  let duringDecrement: (() => void) | null;
  beforeEach(async () => {
    f = databaseFixture(); calls = []; connectionFailures = 0; failures = new Map(); duringDecrement = null;
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage,
      vfs: { version: 1, database: { getConnSafe() { calls.push(['conn']); if (connectionFailures-- > 0) throw new Error('vfs busy'); return f.db; } } },
      vfsRepo: { resources: {
        incrementRef(_conn: unknown, id: string) {
          calls.push(['increment', id, f.db.pluck('SELECT COUNT(*) FROM chat_v2_sessions')]);
          const n = failures.get(id) ?? 0; if (n > 0) { failures.set(id, n - 1); throw new Error('counter busy'); } return 1;
        },
        decrementRef(_conn: unknown, id: string) {
          calls.push(['decrement', id]); duringDecrement?.();
          const n = failures.get(id) ?? 0; if (n > 0) { failures.set(id, n - 1); throw new Error('counter busy'); } return 0;
        },
        decrementRefs(_conn: unknown, ids: string[]) {
          calls.push(['decrementMany', [...ids]]); if (failures.has('batch')) throw new Error('batch failed');
        },
      } },
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function session(id = 'sess_refs', deleted = false) {
    host.ctx.chatSession.createSession({ ...newSession(id, 'chat'), persistStatus: deleted ? 'deleted' : 'active' });
    host.ctx.chatSession.createMessage({ id: `msg_${id}`, sessionId: id, role: 'user', blockIds: [], timestamp: 1,
      _meta: { contextSnapshot: { userRefs: [{ resourceId: 'res_a', hash: 'h', typeId: 'note' }, { resourceId: 'res_a', hash: 'h', typeId: 'note' }],
        retrievalRefs: [{ resourceId: 'res_b', hash: 'h', typeId: 'retrieval' }] } } });
  }
  it('branch increments duplicate references only after its chat transaction commits', async () => {
    session(); failures.set('res_a', 1);
    const branch = await host.invoke<{ id: string }>('chat_v2_branch_session', { sourceSessionId: 'sess_refs', upToMessageId: 'msg_sess_refs' });
    expect(host.ctx.chatSession.getSession(branch.id)).not.toBeNull();
    expect(calls).toEqual([['conn'], ['increment', 'res_a', 2], ['increment', 'res_a', 2], ['increment', 'res_a', 2], ['increment', 'res_b', 2]]);
  });
  it('connection failure is retried once and reported without undoing the branch', async () => {
    session(); connectionFailures = 2; const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'error') warnings.push(String(message.args[0])); } });
    const branch = await host.invoke<{ id: string }>('chat_v2_branch_session', { sourceSessionId: 'sess_refs', upToMessageId: 'msg_sess_refs' });
    expect(calls).toEqual([['conn'], ['conn']]); expect(host.ctx.chatSession.getSession(branch.id)).not.toBeNull();
    expect(warnings).toEqual([`[ChatV2::handlers] VFS ref increment SKIPPED for all 3 resource(s) during branch_session(sess_refs -> ${branch.id}) (conn failed after retry): vfs busy — resource_ids=[res_a, res_a, res_b]`]);
  });
  it('hard delete removes runtime files before decrementing refs and keeps retry failures nonfatal', async () => {
    session(); const directory = join(host.app.dataDir, 'chat_v2_artifacts', safeSessionDir('sess_refs'));
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'artifact.txt'), 'derived');
    duringDecrement = () => { expect(existsSync(directory)).toBe(false); expect(host.ctx.chatSession.getSession('sess_refs')).not.toBeNull(); };
    failures.set('res_b', 2); const errors: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'error') errors.push(String(message.args[0])); } });
    expect(await host.invoke('chat_v2_delete_session', { sessionId: 'sess_refs' })).toBeNull();
    expect(host.ctx.chatSession.getSession('sess_refs')).toBeNull();
    expect(calls).toEqual([['conn'], ['decrement', 'res_a'], ['decrement', 'res_a'], ['decrement', 'res_b'], ['decrement', 'res_b']]);
    expect(errors).toContain('[ChatV2::handlers] VFS ref decrement failure summary during delete_session(sess_refs): 1/3 resource(s) failed after retry — resource_ids=[res_b]');
  });
  it('runtime cleanup failure retains all trash rows and occurs before any reference decrement', async () => {
    session('sess_first', true); session('sess_second', true);
    writeFileSync(join(host.app.dataDir, 'chat_v2_artifacts'), 'not a directory');
    const error = await host.invoke('chat_v2_empty_deleted_sessions').catch(value => value);
    expect(JSON.parse(String(error)).code).toBe(JSON.parse(new ChatV2Error('IoError', '').toCommandError()).code);
    expect(host.ctx.chatSession.getSession('sess_first')).not.toBeNull();
    expect(host.ctx.chatSession.getSession('sess_second')).not.toBeNull(); expect(calls).toEqual([]);
  });
  it('trash purge rechecks restored rows after external reference work', async () => {
    session('sess_first', true); session('sess_second', true);
    duringDecrement = () => {
      duringDecrement = null;
      host.ctx.chatSession.updateSession({ ...host.ctx.chatSession.getSession('sess_second')!, persistStatus: 'active' });
    };
    expect(await host.invoke('chat_v2_empty_deleted_sessions')).toBe(1);
    expect(host.ctx.chatSession.getSession('sess_first')).toBeNull();
    expect(host.ctx.chatSession.getSession('sess_second')?.persistStatus).toBe('active');
    expect(calls.filter(call => call[0] === 'decrement')).toHaveLength(6);
  });
  it('single-message deletion uses one batch call before its transaction even when that call fails', async () => {
    session(); failures.set('batch', 1); const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
    expect(await host.invoke('chat_v2_delete_message', { sessionId: 'sess_refs', messageId: 'msg_sess_refs' })).toBeNull();
    expect(calls).toEqual([['conn'], ['decrementMany', ['res_a', 'res_a', 'res_b']]]);
    expect(host.ctx.chatSession.getMessage('msg_sess_refs')).toBeNull();
    expect(warnings).toContain('[ChatV2::handlers] Failed to decrement refs for message msg_sess_refs: batch failed');
  });
});
