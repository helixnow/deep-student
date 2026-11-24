import './local-runtime-fixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import { collectFullSnapshotChanges } from '../src/collect-sync-changes.ts';
import { applyDownloadedChangesToDatabases } from '../repository/apply-databases.ts';
import { resolveRecordConflict } from '../src/conflict-commands.ts';
import { FileLevelProgress, runFileLevelSync, type FileLevelSyncOptions } from '../src/file-level-sync.ts';
import { OptionalEmitter, SyncProgressEmitter } from '../src/emitter.ts';
import { persistLastSyncAt, LAST_SYNC_AT_SETTING_KEY } from '../src/run-sync.ts';
import { createPayloadCodec } from '../src/payload.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import type { SyncLogger } from '../src/log.ts';

const noopLogger: SyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupNotesVfsSchema(dir: string) {
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const vfs = storage.database('vfs');
  vfs.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      type TEXT,
      data TEXT,
      mime_type TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      resource_id TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE note_document_revisions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      version_number INTEGER,
      pinned INTEGER DEFAULT 0,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE note_editor_leases (
      token TEXT PRIMARY KEY,
      operation_id TEXT,
      owner_id TEXT,
      phase TEXT,
      expires_at INTEGER
    );
    CREATE TABLE note_editor_lease_notes (
      note_id TEXT NOT NULL,
      token TEXT NOT NULL
    );
    CREATE TABLE note_editor_write_grants (token TEXT PRIMARY KEY);
    CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE __sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      side TEXT NOT NULL,
      data_json TEXT NOT NULL,
      winning_device_id TEXT,
      losing_device_id TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolution TEXT
    );
  `);
  return { storage, vfs };
}

describe('Stage 5 R3-E sync regressions', () => {
  it('S5-01: persistLastSyncAt persists sync timestamp through SettingsStore.save', () => {
    const save = vi.fn();
    const fakeCtx = {
      reflect: {
        get: (token: string) => (token === 'settings' ? { save } : undefined),
      },
    } as never;

    persistLastSyncAt(fakeCtx);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      LAST_SYNC_AT_SETTING_KEY,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('S5-02: collectFullSnapshotChanges exports existing active RowSync records with change_log_id=null even when __change_log is already synced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r3e-snapshot-'));
    dirs.push(dir);
    const { storage, vfs } = setupNotesVfsSchema(dir);
    try {
      vfs.run(`INSERT INTO folders VALUES ('f-1', 'Math', NULL, '2026-11-24T10:00:00Z', NULL)`);
      vfs.run(`INSERT INTO resources VALUES ('res-1', 'markdown', 'Existing Body', 'text/markdown', '2026-11-24T10:00:00Z', NULL)`);
      vfs.run(`INSERT INTO notes VALUES ('note-1', 'Existing Note', 'res-1', '2026-11-24T10:00:00Z', NULL)`);
      vfs.run(`INSERT INTO notes VALUES ('note-del', 'Trashed Note', 'res-1', '2026-11-24T10:00:00Z', '2026-11-24T11:00:00Z')`);
      vfs.run(
        `INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
         VALUES ('notes', 'note-1', 'INSERT', '2026-11-24T10:00:00Z', 1)`,
      );

      const snapshot = await collectFullSnapshotChanges(storage, null);
      const keys = snapshot.map((c) => `${c.table_name}:${c.record_id}`);
      expect(keys).toContain('resources:res-1');
      expect(keys).toContain('folders:f-1');
      expect(keys).toContain('notes:note-1');
      expect(keys).not.toContain('notes:note-del');
      expect(snapshot.every((c) => c.change_log_id === null)).toBe(true);
      expect(snapshot.findIndex((c) => c.table_name === 'resources')).toBeLessThan(
        snapshot.findIndex((c) => c.table_name === 'notes'),
      );
    } finally {
      storage.dispose();
    }
  });

  it('S5-05: carries full content_md in notes conflict diff and converges paired notes + resources on manual/cloud resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r3e-diff-'));
    dirs.push(dir);
    const { storage, vfs } = setupNotesVfsSchema(dir);
    try {
      vfs.run(`INSERT INTO resources VALUES ('res-1', 'markdown', 'Local Note Body', 'text/markdown', '2026-11-24T10:00:00Z', NULL)`);
      vfs.run(`INSERT INTO notes VALUES ('note-1', 'Local Note Title', 'res-1', '2026-11-24T10:00:00Z', NULL)`);
      vfs.run(
        `INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES
          ('resources', 'res-1', 'UPDATE', '2026-11-24T10:00:00Z', 0),
          ('notes', 'note-1', 'UPDATE', '2026-11-24T10:00:00Z', 0)`,
      );

      const deferred: string[] = [];
      const applyResult = await applyDownloadedChangesToDatabases(
        storage,
        [
          {
            database_name: 'vfs',
            table_name: 'resources',
            record_id: 'res-1',
            operation: 'Update',
            data: { id: 'res-1', type: 'markdown', data: 'Cloud Note Body', mime_type: 'text/markdown', updated_at: '2026-11-24T12:00:00Z', deleted_at: null },
            changed_at: '2026-11-24T12:00:00Z',
            source_device_id: 'dev-a',
            source_seq: 1,
          },
          {
            database_name: 'vfs',
            table_name: 'notes',
            record_id: 'note-1',
            operation: 'Update',
            data: { id: 'note-1', title: 'Cloud Note Title', resource_id: 'res-1', updated_at: '2026-11-24T12:00:00Z', deleted_at: null },
            changed_at: '2026-11-24T12:00:00Z',
            source_device_id: 'dev-a',
            source_seq: 2,
          },
        ],
        'KeepLatest',
        'dev-b',
        { recomputeAllStatesWithConn: () => 0, syncAllLearnerProfiles: () => 0 },
        noopLogger,
        {
          deferConflictingOverwrite: true,
          onDeferredConflict: (k) => deferred.push(k),
        },
      );

      expect(applyResult.total_conflicts).toBeGreaterThanOrEqual(2);
      expect(deferred.length).toBeGreaterThanOrEqual(2);

      const noteConflictRows = vfs.all<{ id: number | bigint; side: string; data_json: string }>(
        "SELECT id, side, data_json FROM __sync_conflicts WHERE table_name = 'notes' AND record_id = 'note-1' AND resolved_at IS NULL",
      );
      expect(noteConflictRows).toHaveLength(2);
      const localJson = JSON.parse(noteConflictRows.find((r) => r.side === 'local')!.data_json) as Record<string, unknown>;
      const cloudJson = JSON.parse(noteConflictRows.find((r) => r.side === 'cloud')!.data_json) as Record<string, unknown>;
      expect(localJson.content_md).toBe('Local Note Body');
      expect(cloudJson.content_md).toBe('Cloud Note Body');

      // Manual merge writing back updated title & content_md converges both tables cleanly
      const conflictIds = noteConflictRows.map((r) => Number(r.id));
      const mergedPayload = JSON.stringify({
        id: 'note-1',
        title: 'Merged Title',
        resource_id: 'res-1',
        content_md: 'Merged Body Content',
        updated_at: '2026-11-24T10:00:00Z',
      });
      resolveRecordConflict(storage, 'vfs', 'notes', 'note-1', 'merged', mergedPayload, conflictIds);

      expect(vfs.get<{ title: string }>('SELECT title FROM notes WHERE id = ?', ['note-1'])?.title).toBe('Merged Title');
      expect(vfs.get<{ data: string }>('SELECT data FROM resources WHERE id = ?', ['res-1'])?.data).toBe('Merged Body Content');

      const unresolved = vfs.all('SELECT id FROM __sync_conflicts WHERE resolved_at IS NULL');
      expect(unresolved).toHaveLength(0);

      const pendingTables = vfs
        .all<{ table_name: string }>("SELECT DISTINCT table_name FROM __change_log WHERE sync_version = 0")
        .map((r) => r.table_name)
        .sort();
      expect(pendingTables).toEqual(['notes', 'resources']);
    } finally {
      storage.dispose();
    }
  });

  it('S5-07: handles purged notes and null/orphan note_document_revisions tombstones idempotently without quarantine poisoning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r3e-tombstone-'));
    dirs.push(dir);
    const { storage, vfs } = setupNotesVfsSchema(dir);
    try {
      vfs.run(`INSERT INTO resources VALUES ('res-purged', 'markdown', 'Old Body', 'text/markdown', '2026-11-24T09:00:00Z', NULL)`);
      vfs.run(`INSERT INTO notes VALUES ('note-purged', 'Note To Purge', 'res-purged', '2026-11-24T09:00:00Z', NULL)`);
      vfs.run(`INSERT INTO note_document_revisions VALUES ('rev-unpinned', 'note-purged', 1, 0, 'v1', '2026-11-24T09:00:00Z')`);
      vfs.run(`INSERT INTO note_document_revisions VALUES ('rev-pinned', 'note-purged', 2, 1, 'v2', '2026-11-24T09:05:00Z')`);

      const result = await applyDownloadedChangesToDatabases(
        storage,
        [
          {
            database_name: 'vfs',
            table_name: 'note_document_revisions',
            record_id: 'rev-null-orphan',
            operation: 'Update',
            data: null,
            changed_at: '2026-11-24T12:00:00Z',
            source_device_id: 'dev-a',
            source_seq: 1,
          },
          {
            database_name: 'vfs',
            table_name: 'note_document_revisions',
            record_id: 'rev-missing-parent',
            operation: 'Insert',
            data: { id: 'rev-missing-parent', note_id: 'note-gone', version_number: 1, pinned: 0, content: 'orphan', created_at: '2026-11-24T12:00:00Z' },
            changed_at: '2026-11-24T12:01:00Z',
            source_device_id: 'dev-a',
            source_seq: 2,
          },
          {
            database_name: 'vfs',
            table_name: 'note_document_revisions',
            record_id: 'rev-pinned',
            operation: 'Delete',
            data: null,
            changed_at: '2026-11-24T12:02:00Z',
            source_device_id: 'dev-a',
            source_seq: 3,
          },
          {
            database_name: 'vfs',
            table_name: 'notes',
            record_id: 'note-purged',
            operation: 'Delete',
            data: null,
            changed_at: '2026-11-24T12:03:00Z',
            source_device_id: 'dev-a',
            source_seq: 4,
          },
          {
            database_name: 'vfs',
            table_name: 'notes',
            record_id: 'note-already-gone',
            operation: 'Update',
            data: null,
            changed_at: '2026-11-24T12:04:00Z',
            source_device_id: 'dev-a',
            source_seq: 5,
          },
        ],
        'UseCloud',
        'dev-b',
        { recomputeAllStatesWithConn: () => 0, syncAllLearnerProfiles: () => 0 },
        noopLogger,
      );

      expect(result.total_failed).toBe(0);
      expect(vfs.all('SELECT * FROM __sync_quarantine')).toEqual([]);
      expect(vfs.get<{ deleted_at: string | null }>('SELECT deleted_at FROM notes WHERE id = ?', ['note-purged'])?.deleted_at).not.toBeNull();
      // Pinned revision must not be deleted by remote Delete operation
      expect(vfs.get<{ pinned: number }>('SELECT pinned FROM note_document_revisions WHERE id = ?', ['rev-pinned'])?.pinned).toBe(1);
    } finally {
      storage.dispose();
    }
  });

  it('S5-18: FileLevelProgress emits structured sync:fileSync keys and reaches 100% cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-r3e-fileprog-'));
    dirs.push(dir);
    const localStorage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    const events = { emit: vi.fn() };
    const progress = new FileLevelProgress(new OptionalEmitter(new SyncProgressEmitter(events, vi.fn())), 85, 100);
    const files = new Map<string, Uint8Array>();
    const cloud = {
      providerName: () => 'memory',
      instanceBindingHint: () => 'file-level',
      get: async (key: string) => files.get(key) ?? null,
      put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes); },
      listOutcome: async () => ({ files: [], truncated: false }),
    } as unknown as CloudStorage;
    const empty = () => ({ entries: {}, updated_at: '' });
    const options: FileLevelSyncOptions = {
      deviceId: 'a',
      codec: await createPayloadCodec(undefined, null),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      localStorage,
      openState: () => ({ bindInstance: vi.fn(), getTombstoneWatermark: () => 0n, setTombstoneWatermark: vi.fn() }) as unknown as SyncStateStore,
      isCancelled: () => false,
      tombstones: {
        downloadBlobTombstones: async () => empty(), downloadAssetTombstones: async () => empty(), downloadWorkspaceTombstones: async () => empty(),
        downloadBlobTombstonesAfter: async () => [empty(), []], downloadAssetTombstonesAfter: async () => [empty(), []], downloadWorkspaceTombstonesAfter: async () => [empty(), []],
        downloadBlobTombstonesForDevice: async () => empty(), downloadAssetTombstonesForDevice: async () => empty(), downloadWorkspaceTombstonesForDevice: async () => empty(),
        uploadBlobTombstones: vi.fn(), uploadAssetTombstones: vi.fn(), uploadWorkspaceTombstones: vi.fn(),
        DEFAULT_TOMBSTONE_RETENTION_DAYS: 90, pruneTombstones: () => 0, applyBlobTombstones: async () => [],
        validateTombstoneTimestamp: vi.fn(), pathModifiedAfter: () => false,
      },
    };
    try {
      const report = await runFileLevelSync(cloud, dir, 'Download', options, {
        enterMaintenanceMode: async () => undefined,
        exitMaintenanceMode: () => undefined,
      }, progress);
      expect(report).toEqual({ failed: false, warning: null });
      const items = events.emit.mock.calls.map((c) => c[1].current_item);
      expect(items).toEqual([
        'sync:fileSync.workspace',
        'sync:fileSync.blob',
        'sync:fileSync.assets',
        'sync:fileSync.complete',
      ]);
      expect(events.emit.mock.calls.at(-1)?.[1].percent).toBe(100);
    } finally {
      options.codec.dispose();
      localStorage.dispose();
    }
  });
});
