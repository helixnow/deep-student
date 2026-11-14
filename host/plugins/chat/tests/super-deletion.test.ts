import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { nextSessionSequenceId } from '../src/events.ts';

describe('Super session deletion hook ordering', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  const observations: unknown[] = [];
  beforeEach(async () => {
    f = databaseFixture(); observations.length = 0;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub,
      agentSubagent: { onSessionRemoved(id: string, hard: boolean) {
        observations.push([id, hard, getSession(f.db, id)?.persistStatus ?? null, nextSessionSequenceId(id)]);
      } },
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function seed(id: string, status: 'active' | 'deleted' = 'active', superSession = true) {
    createSession(f.db, { ...newSession(id, 'chat'), persistStatus: status,
      ...(superSession ? { metadata: { super_agent: { active: status === 'active' } } } : {}) });
    nextSessionSequenceId(id); nextSessionSequenceId(id);
  }
  it('soft deletion persists trash and resets sequence before the rebuild hook', async () => {
    seed('sess_super_soft'); seed('sess_regular', 'active', false);
    await host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_super_soft' });
    await host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_regular' });
    expect(observations).toEqual([['sess_super_soft', false, 'deleted', 0]]);
  });
  it('hard deletion clears the row and sequence before the workspace removal hook', async () => {
    seed('sess_super_hard');
    await host.invoke('chat_v2_delete_session', { sessionId: 'sess_super_hard' });
    expect(observations).toEqual([['sess_super_hard', true, null, 0]]);
  });
  it('trash purge notifies only marked deleted sessions after clearing their counters', async () => {
    seed('sess_super_purge', 'deleted'); seed('sess_regular_purge', 'deleted', false); seed('sess_live');
    expect(await host.invoke('chat_v2_empty_deleted_sessions')).toBe(2);
    expect(observations).toEqual([['sess_super_purge', true, null, 0]]);
    expect(getSession(f.db, 'sess_live')!.persistStatus).toBe('active');
  });
});
