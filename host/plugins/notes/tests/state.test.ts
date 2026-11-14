import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import notes from '../index.ts';
import { noteStateRepository } from '../repository/state.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';

// Keep the temporary database owned by a live createTestHost, including its cleanup.
async function withState(run: (host: Awaited<ReturnType<typeof createTestHost>>, storage: ReturnType<typeof createStorageService>) => Promise<void>) {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    await storage.migrations.runAll();
    const db = storage.database('vfs');
    db.run("INSERT INTO resources(id,hash,type,data,ref_count,created_at,updated_at) VALUES('res_state','state-hash','note','',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')");
    db.run("INSERT INTO notes(id,resource_id,title,tags,is_favorite,created_at,updated_at) VALUES('note_state','res_state','State','[]',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')");
    host.ctx.provide('storage', storage);
    host.ctx.provide('settings', createSettingsStore({
      db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
    }));
    await host.install(paths, vfsRepos, notes);
    await run(host, storage);
  } finally {
    await host.dispose();
    storage.dispose();
  }
}

describe('note_state_repo', () => {
  it('accepts_flattened_state_put_and_delete_requests', async () => {
    await withState(async (host) => {
      const request = { note_id: 'note_state', type: 'review' as const, key: 'a' };
      const put = await host.invoke('notes_state_put', { request: { ...request, value: null } });
      expect(put).toMatchObject({ ...request, revision: 1, deleted: false, value: null });
      const deleted = await host.invoke('notes_state_delete', { request: { ...request, expected_revision: 1 } });
      expect(deleted).toMatchObject({ ...request, revision: 2, deleted: true, value: null });
    });
  });
  it('per_entry_cas_and_tombstone_prevent_lost_reviews_and_aba', async () => {
    await withState(async (_host, storage) => {
      const db = storage.database('vfs');
      const second = storage.openFile(db.path, { profile: 'vfs' });
      const key = { note_id: 'note_state', type: 'review', key: 'review-a' } as const;
      const put = (expected_revision: number | null) => ({ ...key, expected_revision, value: { candidate: 'hello' } });
      const repo = noteStateRepository;
      expect(repo.put(db, put(null)).revision).toBe(1);
      expect(repo.get(second, key)!.revision).toBe(1);
      expect(() => repo.put(second, put(null))).toThrow();
      expect(repo.put(second, put(1)).revision).toBe(2);
      expect(() => repo.put(db, put(1))).toThrow();
      const deleted = repo.delete(db, { ...key, expected_revision: 2 });
      expect(deleted.revision).toBe(3);
      expect(deleted.deleted).toBe(true);
      expect(() => repo.put(second, put(null))).toThrow();
      expect(() => repo.put(second, put(1))).toThrow();
      expect(repo.put(second, put(3)).revision).toBe(4);
      repo.put(db, { ...key, key: 'review-b', expected_revision: null, value: 'independent' });
      expect(repo.list(db, { note_id: key.note_id, type: key.type, include_deleted: false })).toHaveLength(2);
      storage.close(second);
    });
  });

  it('validates UTF-8 key bytes, tombstone visibility, contract defaults and commit-only events', async () => {
    await withState(async (host, storage) => {
      const key = { note_id: 'note_state', type: 'draft', key: 'a' };
      expect(await host.invoke('notes_state_get', { request: key })).toBeNull();
      const created = await host.invoke('notes_state_put', { request: { ...key, value: { text: '中' } } });
      expect(created).toMatchObject({ ...key, revision: 1, deleted: false, value: { text: '中' } });
      expect(host.eventsNamed('notes:state-changed')).toEqual([created]);
      await expect(host.invoke('notes_state_put', { request: { ...key, value: null } })).rejects.toEqual({
        error_type: 'Conflict', message: 'notes.state_conflict: Stored revision changed; reload before retrying', details: null,
      });
      expect(host.eventsNamed('notes:state-changed')).toHaveLength(1);
      const deleted = await host.invoke('notes_state_delete', { request: { ...key, expected_revision: 1 } });
      expect(deleted).toMatchObject({ revision: 2, deleted: true, value: null });
      expect(await host.invoke('notes_state_get', { request: key })).toEqual(deleted);
      expect(await host.invoke('notes_state_list', { request: { note_id: key.note_id, type: key.type } })).toEqual([]);
      expect(await host.invoke('notes_state_list', { request: { note_id: key.note_id, type: key.type, include_deleted: true } })).toEqual([deleted]);
      for (const badKey of ['', '中'.repeat(171)]) {
        await expect(host.invoke('notes_state_get', { request: { ...key, key: badKey } })).rejects.toEqual({
          error_type: 'Validation', message: 'State key must contain 1..512 bytes', details: null,
        });
      }
      storage.database('vfs').run("UPDATE notes SET deleted_at='now' WHERE id='note_state'");
      await expect(host.invoke('notes_state_get', { request: key })).rejects.toEqual({
        error_type: 'Validation', message: 'Note missing or deleted', details: null,
      });
    });
  });
});
