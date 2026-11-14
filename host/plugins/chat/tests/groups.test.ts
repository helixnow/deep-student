import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import vfsRepositories from '../../vfs-repos/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createGroup, getGroup, listGroups } from '../repository/groups.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock } from '../repository/blocks.ts';
import { createVfsFolder, getVfsFolder, newVfsFolder } from '../repository/vfs-folders.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, ChatV2State } from '../api.ts';
import { StudySpaceRepo } from '../../vfs-repos/api.ts';
import type { SessionGroup } from '../api.ts';
import { ensureGroupFolder, topicFolderTitle, type VfsFolderServiceLike } from '../src/group-actions.ts';

function group(id: string, name: string, extra: Partial<SessionGroup> = {}): SessionGroup {
  return {
    id, name, defaultSkillIds: [], pinnedResourceIds: [], sortOrder: 1, persistStatus: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...extra,
  };
}

describe('chat_v2 topic (group) commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let vfsDb: DatabaseHandle;
  beforeEach(async () => {
    f = databaseFixture();
    const report = f.coordinator.migrateSingle('vfs');
    if (!report.success) throw new Error(JSON.stringify(report));
    vfsDb = f.storage.database('vfs');
    const vfs: VfsFolderServiceLike = { version: 1, database: { getConnSafe: () => vfsDb } };
    const platform = process.platform;
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
      throw new Error(`Unsupported desktop test platform: ${platform}`);
    }
    host = await createTestHost({
      plugins: [vfsRepositories, plugin],
      provide: {
        storage: f.storage, vfs, paths: createPaths({ dataDir: f.root, platform }),
        runtimeRoots: { rootById: (id: string, context: unknown) => {
          expect(context).toEqual({ session_id: 'session-preview' });
          if (id === 'root_valid') return { path: '/Users/test/root' };
          throw new Error('runtime root not found');
        } },
      },
    });
  }, 60_000);
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('topic_folder_title sanitises control characters, separators and blank names', () => {
    expect(topicFolderTitle('  Maths / Algebra  ')).toBe('Maths _ Algebra');
    expect(topicFolderTitle('__topic__')).toBe('topic');
    expect(topicFolderTitle('\\bad\0name')).toBe('bad_name');
    expect(topicFolderTitle('   ')).toBe('未命名课题');
    expect(topicFolderTitle('_ _')).toBe('未命名课题');
    expect(topicFolderTitle('x'.repeat(150))).toHaveLength(100);
    expect(topicFolderTitle(`a${String.fromCharCode(0x85)}b`)).toBe('a_b');
  });

  it('get_group creates a root topic folder for active groups and persists it', async () => {
    createGroup(f.db, group('group_alpha', 'Alpha'));
    const returned = await host.invoke<SessionGroup>('chat_v2_get_group', { groupId: 'group_alpha' });
    expect(returned.pinnedResourceIds).toHaveLength(1);
    const folderId = returned.pinnedResourceIds[0]!;
    expect(folderId.startsWith('fld_')).toBe(true);
    const folder = getVfsFolder(vfsDb, folderId, host.ctx.vfsRepo.folders)!;
    expect(folder.title).toBe('Alpha');
    expect(folder.parentId).toBeNull();
    expect(folder.icon).toBe('folder');
    expect(getGroup(f.db, 'group_alpha')!.pinnedResourceIds).toEqual([folderId]);

    // Idempotent: the pinned root folder is reused, not duplicated.
    const again = await host.invoke<SessionGroup>('chat_v2_get_group', { groupId: 'group_alpha' });
    expect(again.pinnedResourceIds).toEqual([folderId]);
  });

  it('get_group reuses a pinned root folder and renames it to the group title', async () => {
    const existing = newVfsFolder('Old name', null, null);
    createVfsFolder(vfsDb, existing, host.ctx.vfsRepo.folders);
    createGroup(f.db, group('group_rename', 'New name', {
      pinnedResourceIds: [existing.id, ' fld_unrelated'],
    }));
    const returned = await host.invoke<SessionGroup>('chat_v2_get_group', { groupId: 'group_rename' });
    expect(returned.pinnedResourceIds).toEqual([existing.id, ' fld_unrelated']);
    expect(getVfsFolder(vfsDb, existing.id, host.ctx.vfsRepo.folders)!.title).toBe('New name');
  });

  it('get_group returns null for missing groups and leaves archived groups untouched', async () => {
    await expect(host.invoke('chat_v2_get_group', { groupId: 'group_missing' })).resolves.toBeNull();
    createGroup(f.db, group('group_archived', 'Archived', { persistStatus: 'archived' }));
    const returned = await host.invoke<SessionGroup>('chat_v2_get_group', { groupId: 'group_archived' });
    expect(returned!.pinnedResourceIds).toEqual([]);
    expect(getVfsFolder(vfsDb, 'fld_none', host.ctx.vfsRepo.folders)).toBeNull();
  });

  it('list_groups filters by status and workspace and only provisions active groups', async () => {
    createGroup(f.db, group('group_one', 'One', { workspaceId: 'ws_a' }));
    createGroup(f.db, group('group_two', 'Two', { workspaceId: 'ws_b', sortOrder: 2 }));
    createGroup(f.db, group('group_old', 'Old', { persistStatus: 'archived', sortOrder: 3 }));

    const all = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {});
    expect(all.map(item => item.id)).toEqual(['group_one', 'group_two', 'group_old']);
    expect(all[0]!.pinnedResourceIds).toHaveLength(1);
    expect(all[1]!.pinnedResourceIds).toHaveLength(1);
    expect(all[2]!.pinnedResourceIds).toEqual([]);

    const scoped = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {
      status: 'active', workspaceId: 'ws_b',
    });
    expect(scoped.map(item => item.id)).toEqual(['group_two']);
    expect(getGroup(f.db, 'group_two')!.pinnedResourceIds).toEqual(scoped[0]!.pinnedResourceIds);
  });

  it('archive_group marks the group and its active sessions, then delete_group purges them', async () => {
    createGroup(f.db, group('group_work', 'Work'));
    const session = newSession('sess_group_work', 'chat');
    session.groupId = 'group_work';
    createSession(f.db, session);
    createMessage(f.db, {
      id: 'msg_group_work', sessionId: 'sess_group_work', role: 'user', timestamp: 1, blockIds: [],
    });

    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_work' }))
      .rejects.toBe(new ChatV2Error('Validation', '请先归档课题，再从归档页永久删除。').toCommandError());

    await expect(host.invoke('chat_v2_archive_group', { groupId: 'group_work' })).resolves.toBeNull();
    const archivedGroup = getGroup(f.db, 'group_work')!;
    expect(archivedGroup.persistStatus).toBe('archived');
    const archivedSession = getSession(f.db, 'sess_group_work')!;
    expect(archivedSession.persistStatus).toBe('archived');
    expect((archivedSession.metadata as Record<string, unknown>).groupArchivedBy).toMatchObject({
      groupId: 'group_work',
    });

    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_work' })).resolves.toBeNull();
    expect(getGroup(f.db, 'group_work')).toBeNull();
    expect(getSession(f.db, 'sess_group_work')).toBeNull();
    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_work' }))
      .rejects.toBe(new ChatV2Error('GroupNotFound', 'group_work').toCommandError());
  });

  it('restore_group restores the group and its sessions and provisions the topic folder', async () => {
    createGroup(f.db, group('group_restore', 'Restore'));
    const autoArchived = newSession('sess_auto_archived', 'chat');
    autoArchived.groupId = 'group_restore';
    createSession(f.db, autoArchived);
    const manual = newSession('sess_manual_archived', 'chat');
    manual.groupId = 'group_restore';
    manual.metadata = { manuallyArchivedBy: { archivedAt: '2026-01-01T00:00:00Z' } };
    createSession(f.db, manual);

    await host.invoke('chat_v2_archive_group', { groupId: 'group_restore' });
    // Simulate a manual archive that happened before the group archive.
    f.db.run(`UPDATE chat_v2_sessions SET metadata_json = ?2 WHERE id = ?1`, [
      'sess_manual_archived', JSON.stringify({ manuallyArchivedBy: { archivedAt: '2026-01-01T00:00:00Z' } }),
    ]);

    const restored = await host.invoke<SessionGroup>('chat_v2_restore_group', { groupId: 'group_restore' });
    expect(restored.persistStatus).toBe('active');
    expect(restored.pinnedResourceIds).toHaveLength(1);
    expect(getSession(f.db, 'sess_auto_archived')!.persistStatus).toBe('active');
    expect((getSession(f.db, 'sess_auto_archived')!.metadata as Record<string, unknown>).groupArchivedBy)
      .toBeUndefined();
    // Manually archived sessions keep their archived state and marker.
    const stillArchived = getSession(f.db, 'sess_manual_archived')!;
    expect(stillArchived.persistStatus).toBe('archived');
    expect((stillArchived.metadata as Record<string, unknown>).manuallyArchivedBy).toBeDefined();
  });

  it('delete_group refuses streaming sessions and running anki generation', async () => {
    createGroup(f.db, group('group_guard', 'Guard', { persistStatus: 'archived' }));
    const session = newSession('sess_group_guard', 'chat');
    session.groupId = 'group_guard';
    createSession(f.db, session);

    const state = host.ctx.get('chatState') as ChatV2State;
    const token = state.registerStream('sess_group_guard');
    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_guard' }))
      .rejects.toBe(new ChatV2Error('Other',
        'Cannot delete topic while a session is streaming. Please wait for completion or cancel first.')
        .toCommandError());
    state.removeStream('sess_group_guard');
    token.abort();

    createMessage(f.db, {
      id: 'msg_group_anki', sessionId: 'sess_group_guard', role: 'assistant', timestamp: 1,
      blockIds: ['blk_group_anki'],
    });
    createBlock(f.db, {
      id: 'blk_group_anki', messageId: 'msg_group_anki', type: 'anki_cards', status: 'running',
      blockIndex: 0,
    });
    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_guard' }))
      .rejects.toBe(new ChatV2Error('Other',
        'Cannot delete topic while ChatAnki generation is still running. Please wait for completion or cancel first.')
        .toCommandError());
    expect(getGroup(f.db, 'group_guard')).not.toBeNull();
  });

  it('list_groups keeps inactive groups untouched and updates only changed pins', async () => {
    createGroup(f.db, group('group_stable', 'Stable'));
    const first = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {});
    const pinned = first[0]!.pinnedResourceIds;
    const before = getGroup(f.db, 'group_stable')!.updatedAt;
    const second = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {});
    expect(second[0]!.pinnedResourceIds).toEqual(pinned);
    expect(getGroup(f.db, 'group_stable')!.updatedAt).toBe(before);

    // A group whose pinned folder was deleted gets a fresh root folder.
    vfsDb.run('UPDATE folders SET deleted_at = ?2 WHERE id = ?1', [pinned[0]!, Date.now()]);
    const third = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {});
    // A dead topic root is replaced, not kept as a pinned retrieval target.
    expect(third[0]!.pinnedResourceIds).toHaveLength(1);
    expect(third[0]!.pinnedResourceIds[0]).not.toBe(pinned[0]);
    expect(listGroups(f.db, 'active', null)).toHaveLength(1);
  });
  it('create_group appends sort order, provisions the topic folder and resolves runtime roots', async () => {
    createGroup(f.db, group('group_existing', 'Existing', { sortOrder: 4, workspaceId: 'ws_1' }));
    const created = await host.invoke<SessionGroup>('chat_v2_create_group', {
      request: {
        name: 'Physics', description: 'd', icon: 'atom', color: '#fff', systemPrompt: 'sp',
        defaultSkillIds: ['skill_a'], pinnedResourceIds: [], workspaceId: 'ws_1',
        defaultRuntimeRootId: 'root_valid', preferredProjectRootPath: '/client/path',
      },
    });
    expect(created.id.startsWith('group_')).toBe(true);
    expect(created.sortOrder).toBe(5);
    expect(created.persistStatus).toBe('active');
    expect(created.defaultSkillIds).toEqual(['skill_a']);
    expect(created.pinnedResourceIds).toHaveLength(1);
    const persistedCreated = getGroup(f.db, created.id)!;
    expect(persistedCreated.rootFolderId).toBe(created.pinnedResourceIds[0]);
    expect(f.db.pluck<string>('SELECT root_folder_id FROM chat_v2_session_groups WHERE id = ?1', [created.id]))
      .toBe(created.pinnedResourceIds[0]);
    expect(getVfsFolder(vfsDb, created.pinnedResourceIds[0]!, host.ctx.vfsRepo.folders)!.title).toBe('Physics');
    expect(created.defaultRuntimeRootId).toBe('root_valid');
    expect(created.preferredProjectRootPath).toBe('/Users/test/root');
    expect(persistedCreated.name).toBe('Physics');
  });

  it('update_group merges or clears optional fields and archives sessions on request', async () => {
    createGroup(f.db, group('group_edit', 'Old', { description: 'keep', color: '#000' }));
    createSession(f.db, { ...newSession('sess_in_group', 'chat'), groupId: 'group_edit' });
    const updated = await host.invoke<SessionGroup>('chat_v2_update_group', {
      groupId: 'group_edit',
      request: { name: 'New', description: '', color: '#fff', persistStatus: 'archived' },
    });
    expect(updated.name).toBe('New');
    expect(updated.description).toBeUndefined();
    expect(updated.color).toBe('#fff');
    expect(updated.persistStatus).toBe('archived');
    expect(getSession(f.db, 'sess_in_group')!.persistStatus).toBe('archived');

    await expect(host.invoke('chat_v2_update_group', {
      groupId: 'group_edit', request: { defaultRuntimeRootId: '/absolute/path' },
    })).rejects.toBe(new ChatV2Error('Validation',
      'defaultRuntimeRootId must be a runtime root id (workspace / authorized_*), not a filesystem path').toCommandError());
    await expect(host.invoke('chat_v2_update_group', {
      groupId: 'group_edit', request: { defaultRuntimeRootId: 'root_missing' },
    })).rejects.toBe(new ChatV2Error('Validation',
      "defaultRuntimeRootId 'root_missing' is not resolvable on this device: runtime root not found").toCommandError());
  });

  it('update_group recreates root_folder_id when the previous root folder was deleted', async () => {
    const created = await host.invoke<SessionGroup>('chat_v2_create_group', {
      request: { name: 'Calculus' },
    });
    const oldRootId = getGroup(f.db, created.id)!.rootFolderId!;
    expect(oldRootId.startsWith('fld_')).toBe(true);

    vfsDb.run('UPDATE folders SET deleted_at = ?2 WHERE id = ?1', [oldRootId, Date.now()]);

    const updated = await host.invoke<SessionGroup>('chat_v2_update_group', {
      groupId: created.id,
      request: { name: 'Calculus II' },
    });
    const persistedUpdated = getGroup(f.db, created.id)!;
    expect(persistedUpdated.rootFolderId).toBeDefined();
    expect(persistedUpdated.rootFolderId).not.toBe(oldRootId);
    expect(updated.pinnedResourceIds[0]).toBe(persistedUpdated.rootFolderId);
    expect(f.db.pluck<string>('SELECT root_folder_id FROM chat_v2_session_groups WHERE id = ?1', [created.id]))
      .toBe(persistedUpdated.rootFolderId);
  });

  it('synchronizes profiles through create, root repair, archive, restore and permanent deletion', async () => {
    const created = await host.invoke<SessionGroup>('chat_v2_create_group', { request: { name: '生命周期' } });
    const repo = new StudySpaceRepo();
    const root = getGroup(f.db, created.id)!.rootFolderId!;
    expect(repo.getProfile(vfsDb, created.id)?.rootFolderId).toBe(root);
    repo.upsertProfile(vfsDb, { spaceId: created.id, rootFolderId: root, dailyBudgetMinutes: 90, defaultDeckId: 'deck_keep' });
    vfsDb.run('UPDATE folders SET deleted_at = 1 WHERE id = ?1', [root]);
    await host.invoke('chat_v2_update_group', { groupId: created.id, request: { name: '生命周期新' } });
    const repaired = repo.getProfile(vfsDb, created.id)!;
    expect(repaired.rootFolderId).toBe(getGroup(f.db, created.id)!.rootFolderId);
    expect(repaired.rootFolderId).not.toBe(root);
    expect(repaired).toMatchObject({ dailyBudgetMinutes: 90, defaultDeckId: 'deck_keep' });
    repo.addMount(vfsDb, { spaceId: created.id, targetFolderId: repaired.rootFolderId, itemType: 'note', itemId: 'note_external' });
    await host.invoke('chat_v2_archive_group', { groupId: created.id });
    expect(repo.getProfile(vfsDb, created.id)).toBeNull();
    await host.invoke('chat_v2_restore_group', { groupId: created.id });
    expect(repo.getProfile(vfsDb, created.id)).toMatchObject({ dailyBudgetMinutes: 90, defaultDeckId: 'deck_keep' });
    expect(repo.listMounts(vfsDb, { spaceId: created.id })).toHaveLength(1);
    await host.invoke('chat_v2_archive_group', { groupId: created.id });
    await host.invoke('chat_v2_delete_group', { groupId: created.id });
    expect(repo.getProfile(vfsDb, created.id)).toBeNull();
    expect(repo.listMounts(vfsDb, { spaceId: created.id })).toEqual([]);
  });

  it('does not adopt or rename Inbox, or create orphan folders on invalid runtime roots', async () => {
    new StudySpaceRepo().ensureInboxFolder(vfsDb);
    const before = vfsDb.pluck('SELECT COUNT(*) FROM folders');
    await expect(host.invoke('chat_v2_create_group', { request: { name: '无效', defaultRuntimeRootId: 'root_missing' } })).rejects.toBeDefined();
    expect(vfsDb.pluck('SELECT COUNT(*) FROM folders')).toBe(before);
    const created = await host.invoke<SessionGroup>('chat_v2_create_group', { request: { name: '不抢收件箱', pinnedResourceIds: ['fld_inbox'] } });
    expect(getGroup(f.db, created.id)!.rootFolderId).not.toBe('fld_inbox');
    expect(getVfsFolder(vfsDb, 'fld_inbox', host.ctx.vfsRepo.folders)!.title).toBe('Inbox');
    const title = getVfsFolder(vfsDb, created.pinnedResourceIds[0]!, host.ctx.vfsRepo.folders)!.title;
    await expect(host.invoke('chat_v2_update_group', { groupId: created.id, request: { name: '不应改名', defaultRuntimeRootId: 'root_missing' } })).rejects.toBeDefined();
    expect(getVfsFolder(vfsDb, created.pinnedResourceIds[0]!, host.ctx.vfsRepo.folders)!.title).toBe(title);
  });

  it('preserves an explicitly selected nested root folder instead of silently replacing it', () => {
    const parent = newVfsFolder('父目录', null, null);
    const nested = newVfsFolder('嵌套空间', parent.id, null);
    const folders = host.ctx.vfsRepo.folders;
    createVfsFolder(vfsDb, parent, folders);
    createVfsFolder(vfsDb, nested, folders);
    expect(ensureGroupFolder({ version: 1, database: { getConnSafe: () => vfsDb }, folders },
      '嵌套空间', [], nested.id)).toEqual({ rootFolderId: nested.id, pinned: [nested.id] });
    expect(getVfsFolder(vfsDb, nested.id, folders)?.parentId).toBe(parent.id);
  });

  it('accepts and returns explicit rootFolderId through all five AJV-validated group wire commands', async () => {
    const folders = host.ctx.vfsRepo.folders;
    const firstRoot = newVfsFolder('指定根目录', null, null);
    const secondRoot = newVfsFolder('替换根目录', null, null);
    createVfsFolder(vfsDb, firstRoot, folders);
    createVfsFolder(vfsDb, secondRoot, folders);
    const created = await host.invoke<SessionGroup>('chat_v2_create_group', {
      request: { name: '显式空间', rootFolderId: firstRoot.id },
    });
    expect(created.rootFolderId).toBe(firstRoot.id);
    const updated = await host.invoke<SessionGroup>('chat_v2_update_group', {
      groupId: created.id, request: { rootFolderId: secondRoot.id },
    });
    expect(updated.rootFolderId).toBe(secondRoot.id);
    const fetched = await host.invoke<SessionGroup>('chat_v2_get_group', { groupId: created.id });
    expect(fetched.rootFolderId).toBe(secondRoot.id);
    const listed = await host.invoke<SessionGroup[]>('chat_v2_list_groups', {});
    expect(listed.find(group => group.id === created.id)?.rootFolderId).toBe(secondRoot.id);
    await host.invoke('chat_v2_archive_group', { groupId: created.id });
    const restored = await host.invoke<SessionGroup>('chat_v2_restore_group', { groupId: created.id });
    expect(restored.rootFolderId).toBe(secondRoot.id);
    expect(new StudySpaceRepo().getProfile(vfsDb, created.id)?.rootFolderId).toBe(secondRoot.id);
  });
});
