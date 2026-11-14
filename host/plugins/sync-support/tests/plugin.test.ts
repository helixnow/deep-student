import { describe, expect, it, vi } from 'vitest';
import { serviceHost } from './service-host.ts';
import plugin from '../index.ts';
import { syncSupportService } from '../api.ts';
import { createSyncSupport } from '../src/service.ts';
import { SqliteSyncStateStore } from '../src/state.ts';
import { openTestDatabase } from './test-db.ts';
import { MINIMAL_NOTES_SCHEMA, seedNote } from './note-fixtures.ts';

describe('syncSupport plugin', () => {
  it('publishes_the_service_with_expected_metadata', async () => {
    const db = openTestDatabase();
    db.exec(MINIMAL_NOTES_SCHEMA);
    seedNote(db, 'note-1', 'resource-1', 'plugin snapshot');
    const host = await serviceHost(db);
    try {
      expect(plugin.meta.id).toBe('dstu.sync-support');
      expect(plugin.meta.lane).toBe('L20-sync');
      expect(plugin.meta.provides).toEqual(['syncSupport']);
      expect(plugin.inject).toEqual(['storage', 'notes', 'vfsRepo']);
      expect(syncSupportService).toEqual({ name: 'syncSupport', version: '1.0.0' });
      const service = host.service;
      expect(service).toBeDefined();
      expect(service.version).toBe(1);
      expect(typeof service.state.bindInstance).toBe('function');
      expect(typeof service.tombstones.uploadBlobTombstones).toBe('function');
      expect(typeof service.noteHistory.includeNoteDependencies).toBe('function');
      expect(typeof service.pomodoroCounts.recompute).toBe('function');
      expect(typeof service.conflicts.createResolver).toBe('function');

      // state 与插件暴露的是同一实例（上传 tombstone 事件复用该状态库）。
      service.state.bindInstance('default', 's3', 'bucket-a');
      expect(service.state.deviceRotationsForNew('missing')).toEqual([]);
      service.noteHistory.snapshotNotes(db, ['note-1'], 'before_sync');
      expect(db.pluck<string>('SELECT content_md FROM note_document_revisions')).toBe('plugin snapshot');
    } finally {
      await host.dispose();
      db.raw.close();
    }
  });

  it('note_history_fails_closed_when_notes_service_is_unavailable', () => {
    const db = openTestDatabase();
    try {
      const support = createSyncSupport({
        state: new SqliteSyncStateStore(db),
        notes: () => undefined,
        logger: { warn: vi.fn(), info: vi.fn() },
      });
      expect(() => support.noteHistory.validateBatchFormats([])).toThrow(/notes/);
      expect(() => support.noteHistory.affectedNotes(db, 'notes', 'n')).not.toThrow();
    } finally {
      db.raw.close();
    }
  });
});
