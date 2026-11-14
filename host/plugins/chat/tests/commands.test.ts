import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { insertGoal } from '../repository/goals.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error } from '../api.ts';

describe('Chat command wire contracts', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    createSession(f.db, newSession('sess_wire', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('session lookup/list/count preserve null, validation wording, default filtering and pagination', async () => {
    await expect(host.invoke('chat_v2_get_session', { sessionId: 'sess_missing' })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_get_session', { sessionId: 'bad' })).rejects.toBe(
      new ChatV2Error('Validation', 'Invalid session_id format: bad').toCommandError());
    await expect(host.invoke('chat_v2_list_sessions')).resolves.toMatchObject([{ id: 'sess_wire' }]);
    await expect(host.invoke('chat_v2_list_sessions', { limit: 0 })).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_count_sessions')).resolves.toBe(1);
    await expect(host.invoke('chat_v2_count_sessions', { groupId: '*' })).resolves.toBe(0);
  });
  it('tag insertion trims but removal preserves input; batches omit absent sessions', async () => {
    await expect(host.invoke('chat_v2_add_tag', { sessionId: 'sess_wire', tag: '  tag  ' })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_get_session_tags', { sessionId: 'sess_wire' })).resolves.toEqual(['tag']);
    await expect(host.invoke('chat_v2_remove_tag', { sessionId: 'sess_wire', tag: ' tag ' })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_get_tags_batch', { sessionIds: ['invalid', 'sess_wire'] })).resolves.toEqual({ sess_wire: ['tag'] });
    await expect(host.invoke('chat_v2_list_all_tags')).resolves.toEqual([['tag', 1]]);
    await expect(host.invoke('chat_v2_remove_tag', { sessionId: 'sess_wire', tag: 'tag' })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_list_all_tags')).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_add_tag', { sessionId: 'sess_wire', tag: ' ' })).rejects.toBe(
      new ChatV2Error('Validation', 'Tag must not be empty').toCommandError());
  });
  it('search returns empty before acquiring a connection or validating the optional session', async () => {
    const lease = await f.storage.enterMaintenance(['chat_v2']);
    try {
      await expect(host.invoke('chat_v2_search_content', { query: ' ', sessionId: 'bad' })).resolves.toEqual([]);
      await expect(host.invoke('chat_v2_search_sessions', { query: ' ' })).resolves.toEqual([]);
      await expect(host.invoke('chat_v2_get_session', { sessionId: 'sess_wire' })).rejects.toBe(
        new ChatV2Error('Database', 'Database is in maintenance mode (backup/restore in progress)').toCommandError());
    } finally { lease.release(); }
  });
  it('session search escapes LIKE metacharacters and rebuild reports indexed block count', async () => {
    createSession(f.db, { ...newSession('sess_percent', 'chat'), title: '100%_literal' });
    await expect(host.invoke('chat_v2_search_sessions', { query: '%_' })).resolves.toMatchObject([{ id: 'sess_percent' }]);
    await expect(host.invoke('chat_v2_search_content', { query: 'needle' })).resolves.toEqual([]);
    await expect(host.invoke('rebuild_chat_fts')).resolves.toBe(0);
  });
  it('goal edits persist before emitting the exact session payload; read allows absent sessions', async () => {
    await expect(host.invoke('chat_v2_goal_get', { sessionId: 'unknown' })).resolves.toBeNull();
    insertGoal(f.db, { sessionId: 'sess_wire', goalId: 'goal_1', objective: 'before', status: 'active',
      tokenBudget: 100, tokensUsed: 1, timeUsedSeconds: 2, continuationCount: 3, createdAtMs: 4, updatedAtMs: 5 });
    const goal = await host.invoke('chat_v2_goal_edit', { sessionId: 'sess_wire', objective: ' after ' });
    expect(goal).toMatchObject({ objective: 'after', tokenBudget: null, status: 'active', tokensUsed: 1 });
    await expect(host.invoke('chat_v2_goal_get', { sessionId: 'sess_wire' })).resolves.toEqual(goal);
    expect(host.eventsNamed('chat_v2_session_sess_wire')).toEqual([{ eventType: 'goal_updated', sessionId: 'sess_wire', goal }]);
  });
});
