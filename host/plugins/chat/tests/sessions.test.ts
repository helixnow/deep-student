import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import * as sessions from '../repository/sessions.ts';
import { searchSessions } from '../repository/search.ts';
import { newSession } from '../src/types.ts';

describe('chat_v2/repo.rs sessions', () => {
  let f: ReturnType<typeof databaseFixture>;
  beforeEach(() => { f = databaseFixture(); });
  afterEach(() => f.dispose());

  it('test_session_crud', () => {
    sessions.createSession(f.db, newSession('sess_test_123', 'analysis'));
    const loaded = sessions.getSession(f.db, 'sess_test_123')!;
    expect(loaded.id).toBe('sess_test_123');
    expect(loaded.mode).toBe('analysis');
    expect(loaded.persistStatus).toBe('active');
    sessions.updateSession(f.db, { ...loaded, title: 'Test Session', persistStatus: 'archived' });
    expect(sessions.getSession(f.db, loaded.id)).toMatchObject({ title: 'Test Session', persistStatus: 'archived' });
    expect(sessions.listSessions(f.db, 'archived', null, 10, 0)).toHaveLength(1);
    f.db.transaction(tx => sessions.deleteSession(tx, loaded.id));
    expect(sessions.getSession(f.db, loaded.id)).toBeNull();
  });

  it('superagent_internal_sessions_are_hidden_from_regular_session_views', () => {
    for (const [id, mode, title, metadata] of [
      ['sess_plain', 'general_chat', 'needle 普通会话', null],
      ['sess_auto', 'automation', 'needle 自动化会话', { headless: true }],
      ['sess_sa_router', 'automation', 'needle Super-agent Router', { headless: true, superagent: 'router' }],
      ['sess_sa_worker', 'automation', 'needle Super-agent Worker', { headless: true, superagent: 'worker' }],
    ] as const) sessions.createSession(f.db, { ...newSession(id, mode), title, metadata });
    expect(sessions.listSessions(f.db, 'active', null, 50, 0).map(s => s.id).sort()).toEqual(['sess_auto', 'sess_plain']);
    expect(sessions.countSessions(f.db, 'active', null)).toBe(2);
    expect(searchSessions(f.db, 'needle', 50, false).map(s => s.id).sort()).toEqual(['sess_auto', 'sess_plain']);
  });

  it('hidden_super_session_is_hidden_from_regular_session_views', () => {
    for (const [id, title, metadata] of [
      ['sess_plain', 'needle 普通会话', null],
      ['sess_super_visible', 'needle Super-agent', { super_agent: { active: true, version: 1, workspace_id: 'ws_a', hidden: false }, pinned: true }],
      ['sess_super_hidden', 'needle Super-agent hidden', { super_agent: { active: true, version: 1, workspace_id: 'ws_b', hidden: true }, pinned: true }],
      ['sess_super_retired', 'needle Super-agent retired', { super_agent: { active: false, retired_at: '2026-11-01T00:00:00Z' } }],
      ['sess_legacy_router', 'needle legacy router', { headless: true, superagent: 'router' }],
    ] as const) sessions.createSession(f.db, { ...newSession(id, 'chat'), title, metadata });
    const expected = ['sess_plain', 'sess_super_retired', 'sess_super_visible'];
    expect(sessions.listSessions(f.db, 'active', null, 50, 0).map(s => s.id).sort()).toEqual(expected);
    expect(sessions.countSessions(f.db, 'active', null)).toBe(3);
    expect(searchSessions(f.db, 'needle', 50, false).map(s => s.id).sort()).toEqual(expected);
  });

  it('test_session_title_locked_default_false', () => {
    sessions.createSession(f.db, newSession('sess_lock_default', 'general_chat'));
    expect(sessions.getSession(f.db, 'sess_lock_default')!.titleLocked).toBe(false);
  });
  it('test_session_title_locked_persists_through_update', () => {
    sessions.createSession(f.db, { ...newSession('sess_lock_persist', 'chat'), titleLocked: true });
    const loaded = sessions.getSession(f.db, 'sess_lock_persist')!;
    expect(loaded.titleLocked).toBe(true);
    sessions.updateSession(f.db, { ...loaded, description: 'changed' });
    expect(sessions.getSession(f.db, loaded.id)).toMatchObject({ titleLocked: true, description: 'changed' });
  });
  it('test_set_title_locked_helper', () => {
    const id = 'sess_lock_helper';
    sessions.createSession(f.db, newSession(id, 'chat'));
    expect(sessions.getSession(f.db, id)!.titleLocked).toBe(false);
    sessions.setTitleLocked(f.db, id, true);
    expect(sessions.getSession(f.db, id)!.titleLocked).toBe(true);
    sessions.setTitleLocked(f.db, id, false);
    expect(sessions.getSession(f.db, id)!.titleLocked).toBe(false);
  });
});
