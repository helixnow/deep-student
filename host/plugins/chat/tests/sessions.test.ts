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

  it('G30: lists and counts 205 seeded sessions with persist_status=saved, numeric timestamps, empty group_id, and malformed metadata_json', () => {
    const baseEpochMs = Date.parse('2026-11-20T00:00:00.000Z');
    f.db.transaction(tx => {
      for (let i = 0; i < 205; i += 1) {
        const id = `sess_seed_${String(i).padStart(3, '0')}`;
        const title = `Seeded Session ${i + 1}`;
        const createdAt = i % 3 === 0
          ? baseEpochMs + i * 60_000
          : i % 3 === 1
            ? Math.floor((baseEpochMs + i * 60_000) / 1000)
            : `2026-11-20 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
        const groupId = i % 2 === 0 ? '' : null;
        const metadataJson = i % 5 === 0 ? '' : i % 7 === 0 ? '{bad-json' : null;
        tx.run(
          `INSERT INTO chat_v2_sessions
            (id, mode, title, description, summary_hash, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
            VALUES (?1, ?2, ?3, NULL, NULL, 0, ?4, ?5, ?6, ?7, ?8)`,
          [id, 'chat', title, 'saved', createdAt, createdAt, metadataJson, groupId],
        );
      }
      // Archived, deleted, hidden draft, and agent rows must remain excluded from active listing.
      tx.run(
        `INSERT INTO chat_v2_sessions (id, mode, title, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
         VALUES ('sess_archived_1', 'chat', 'Archived', 0, 'archived', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', NULL, NULL)`,
      );
      tx.run(
        `INSERT INTO chat_v2_sessions (id, mode, title, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
         VALUES ('sess_deleted_1', 'chat', 'Deleted', 0, 'deleted', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', NULL, NULL)`,
      );
      tx.run(
        `INSERT INTO chat_v2_sessions (id, mode, title, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
         VALUES ('sess_hidden_draft', 'chat', NULL, 0, 'saved', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', '{"chatV2Draft":{"hidden":true}}', NULL)`,
      );
      tx.run(
        `INSERT INTO chat_v2_sessions (id, mode, title, title_locked, persist_status, created_at, updated_at, metadata_json, group_id)
         VALUES ('sess_agent_1', 'agent', 'Agent', 0, 'saved', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', NULL, NULL)`,
      );
    });

    expect(sessions.countSessions(f.db, 'active', null)).toBe(205);
    expect(sessions.countSessions(f.db, 'active', '')).toBe(205);
    expect(sessions.countSessions(f.db, 'active', '*')).toBe(0);
    expect(sessions.countSessions(f.db, 'archived', null)).toBe(1);
    expect(sessions.countSessions(f.db, 'deleted', null)).toBe(1);

    const collected: string[] = [];
    for (let offset = 0; offset < 250; offset += 50) {
      const page = sessions.listSessions(f.db, 'active', '', 50, offset);
      collected.push(...page.map(s => s.id));
      for (const row of page) {
        expect(row.persistStatus).toBe('active');
        expect(row.groupId).toBeUndefined();
        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
        expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
      }
      if (page.length < 50) break;
    }
    expect(new Set(collected).size).toBe(205);

    const single = sessions.getSession(f.db, 'sess_seed_000');
    expect(single).toMatchObject({
      id: 'sess_seed_000',
      mode: 'chat',
      title: 'Seeded Session 1',
      persistStatus: 'active',
    });
    expect(single?.groupId).toBeUndefined();
    expect(single?.createdAt).toBe('2026-11-20T00:00:00Z');
  });
});
