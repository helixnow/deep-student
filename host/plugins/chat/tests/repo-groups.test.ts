/**
 * repo.rs group lifecycle tests (repo.rs:5861-6155).
 * Titles keep the Rust test names so the migration ledger can match them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFixture } from './database-fixture.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  archiveGroup, createGroup, getGroup, listGroups, permanentlyDeleteGroup, restoreGroup,
  softDeleteGroup, updateGroup,
} from '../repository/groups.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error } from '../api.ts';
import type { ChatSession, SessionGroup } from '../api.ts';

function group(id: string, name: string): SessionGroup {
  return {
    id, name, defaultSkillIds: [], pinnedResourceIds: [], sortOrder: 1,
    persistStatus: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function session(id: string, groupId: string | null, extra: Partial<ChatSession> = {}): ChatSession {
  const base = newSession(id, 'chat');
  return { ...base, ...(groupId === null ? {} : { groupId }), ...extra };
}

describe('repo.rs group contracts', () => {
  let f: ReturnType<typeof databaseFixture>;
  let db: DatabaseHandle;
  beforeEach(() => { f = databaseFixture(); db = f.db; });
  afterEach(() => { f.dispose(); });

  it('test_group_preferred_runtime_root_crud', () => {
    const created = {
      ...group('group_pref_root', 'Preferred Root'),
      defaultRuntimeRootId: 'authorized_abc', preferredProjectRootPath: '/Users/demo/project',
    };
    createGroup(db, created);
    let loaded = getGroup(db, created.id)!;
    expect(loaded.defaultRuntimeRootId).toBe('authorized_abc');
    expect(loaded.preferredProjectRootPath).toBe('/Users/demo/project');

    loaded = { ...loaded, defaultRuntimeRootId: 'workspace', preferredProjectRootPath: '/tmp/workspace' };
    updateGroup(db, loaded);
    let after = getGroup(db, created.id)!;
    expect(after.defaultRuntimeRootId).toBe('workspace');
    expect(after.preferredProjectRootPath).toBe('/tmp/workspace');

    const { defaultRuntimeRootId: _id, preferredProjectRootPath: _path, ...cleared } = after;
    updateGroup(db, cleared);
    after = getGroup(db, created.id)!;
    expect(after.defaultRuntimeRootId).toBeUndefined();
    expect(after.preferredProjectRootPath).toBeUndefined();
    expect(listGroups(db, 'active', null).some(g => g.id === created.id)).toBe(true);
  });

  it('test_archive_group_preserves_group_id_and_restore_marker', () => {
    const g = group('group_archive_contract', 'Archive Contract');
    createGroup(db, g);
    createSession(db, session('sess_group_archive_contract', g.id));
    archiveGroup(db, g.id);

    expect(getGroup(db, g.id)!.persistStatus).toBe('archived');
    const archived = getSession(db, 'sess_group_archive_contract')!;
    expect(archived.persistStatus).toBe('archived');
    expect(archived.groupId).toBe(g.id);
    expect((archived.metadata as Record<string, unknown>).groupArchivedBy)
      .toEqual({ groupId: g.id, archivedAt: expect.any(String) });
  });

  it('test_restore_group_restores_only_group_archived_sessions', () => {
    const g = group('group_restore_contract', 'Restore Contract');
    createGroup(db, g);
    createSession(db, session('sess_group_carried_restore', g.id));
    createSession(db, session('sess_manual_archive_restore', g.id, {
      persistStatus: 'archived',
      metadata: { manuallyArchivedBy: { archivedAt: '2026-01-01T00:00:00Z' } },
    }));
    archiveGroup(db, g.id);
    restoreGroup(db, g.id);

    expect(getGroup(db, g.id)!.persistStatus).toBe('active');
    const carried = getSession(db, 'sess_group_carried_restore')!;
    expect(carried.persistStatus).toBe('active');
    expect(carried.groupId).toBe(g.id);
    expect((carried.metadata as Record<string, unknown> | undefined)?.groupArchivedBy).toBeUndefined();

    const manual = getSession(db, 'sess_manual_archive_restore')!;
    expect(manual.persistStatus).toBe('archived');
    expect(manual.groupId).toBe(g.id);
  });

  it('test_restore_group_reattaches_marker_sessions_with_cleared_group_id', () => {
    const g = group('group_restore_orphan_contract', 'Restore Orphan Contract');
    createGroup(db, g);
    createSession(db, session('sess_group_restore_orphan', null, {
      persistStatus: 'archived',
      metadata: { groupArchivedBy: { groupId: g.id, archivedAt: '2026-01-01T00:00:00Z' } },
    }));
    updateGroup(db, { ...g, persistStatus: 'archived' });
    restoreGroup(db, g.id);

    const restored = getSession(db, 'sess_group_restore_orphan')!;
    expect(restored.persistStatus).toBe('active');
    expect(restored.groupId).toBe(g.id);
    expect((restored.metadata as Record<string, unknown> | undefined)?.groupArchivedBy).toBeUndefined();
  });

  it('test_permanently_delete_group_deletes_topic_sessions_without_ungrouping', () => {
    const g = { ...group('group_permanent_delete_contract', 'Permanent Delete Contract') };
    createGroup(db, g);
    createSession(db, session('sess_group_permanent_delete_contract', g.id, {
      persistStatus: 'archived',
    }));
    updateGroup(db, { ...g, persistStatus: 'archived' });

    expect(permanentlyDeleteGroup(db, g.id)).toEqual(['sess_group_permanent_delete_contract']);
    expect(getGroup(db, g.id)).toBeNull();
    expect(getSession(db, 'sess_group_permanent_delete_contract')).toBeNull();
  });

  it('test_permanently_delete_group_deletes_marker_orphan_sessions', () => {
    const g = { ...group('group_permanent_delete_orphan_contract', 'Permanent Delete Orphan Contract') };
    createGroup(db, g);
    createSession(db, session('sess_group_permanent_delete_orphan_contract', null, {
      persistStatus: 'archived',
      metadata: { groupArchivedBy: { groupId: g.id, archivedAt: '2026-01-01T00:00:00Z' } },
    }));
    updateGroup(db, { ...g, persistStatus: 'archived' });

    expect(permanentlyDeleteGroup(db, g.id)).toEqual(['sess_group_permanent_delete_orphan_contract']);
    expect(getGroup(db, g.id)).toBeNull();
    expect(getSession(db, 'sess_group_permanent_delete_orphan_contract')).toBeNull();
  });

  it('test_permanently_delete_group_rejects_active_topic', () => {
    const g = group('group_active_delete_contract', 'Active Delete Contract');
    createGroup(db, g);
    expect(() => permanentlyDeleteGroup(db, g.id)).toThrow(ChatV2Error);
    expect(getGroup(db, g.id)).not.toBeNull();
  });

  it('test_soft_delete_group_is_the_only_group_flow_that_ungroups_sessions', () => {
    const g = group('group_delete_contract', 'Delete Contract');
    createGroup(db, g);
    createSession(db, session('sess_group_delete_contract', g.id));
    softDeleteGroup(db, g.id);

    expect(getGroup(db, g.id)!.persistStatus).toBe('deleted');
    expect(getSession(db, 'sess_group_delete_contract')!.groupId).toBeUndefined();
  });

  it('test_group_root_folder_id_explicit_and_fallback_mapping', () => {
    const g = {
      ...group('group_root_folder', 'Root Folder Space'),
      rootFolderId: 'fld_explicit_root',
      pinnedResourceIds: ['fld_explicit_root', 'res_1'],
    };
    createGroup(db, g);
    expect(db.pluck<string>('SELECT root_folder_id FROM chat_v2_session_groups WHERE id = ?1', [g.id]))
      .toBe('fld_explicit_root');
    expect(getGroup(db, g.id)!.rootFolderId).toBe('fld_explicit_root');

    // Simulate legacy un-backfilled row where root_folder_id is NULL in SQLite
    db.run('UPDATE chat_v2_session_groups SET root_folder_id = NULL WHERE id = ?1', [g.id]);
    expect(getGroup(db, g.id)!.rootFolderId).toBe('fld_explicit_root');
  });
});
