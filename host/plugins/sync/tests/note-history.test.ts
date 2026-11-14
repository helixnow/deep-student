import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { NotesService } from '../../notes/api.ts';
import notesPlugin from '../../notes/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import syncPlugin from '../index.ts';
import syncSupportPlugin from '../../sync-support/index.ts';
import type { SyncService } from '../api.ts';
import type { NoteHistoryHooks } from '../repository/apply.ts';
import { getDefaultNoteHistory, setDefaultNoteHistory } from '../repository/apply.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { cloneDbJson, isJsonObject } from '../../../platform/util/lossless-json.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;
let hooks: NoteHistoryHooks;
let noteRepository: NotesService['repository'];
let noteFormatRepository: NotesService['format'];
let noteRevisionRepository: NotesService['revisions'];
const extraStorages: Storage[] = [];
const extraDirs: string[] = [];

async function createEmptyDatabase(): Promise<{ storage: Storage; handle: DatabaseHandle; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sync-note-target-'));
  const targetStorage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  await targetStorage.migrations.runAll();
  extraStorages.push(targetStorage);
  extraDirs.push(dir);
  return { storage: targetStorage, handle: targetStorage.database('vfs'), dir };
}

function handle(): DatabaseHandle {
  return storage.database('vfs');
}

function db(): SqlExecutor {
  return handle();
}

beforeAll(async () => {
  host = await createTestHost({ provide: { notes: undefined, syncSupport: undefined, vfsRepo: undefined, paths: { deviceId: async () => 'note-history-test', dataSpaceDeviceId: async () => 'note-history-test' } } });
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  await host.install(vfsReposPlugin);
  await host.install(notesPlugin);
  await host.install(syncSupportPlugin);
  await host.install(syncPlugin);
  noteRepository = host.ctx.notes.repository;
  noteFormatRepository = host.ctx.notes.format;
  noteRevisionRepository = host.ctx.notes.revisions;
  hooks = getDefaultNoteHistory()!;
}, 120000);

afterEach(async () => {
  for (const extra of extraStorages.splice(0)) extra.dispose();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  setDefaultNoteHistory(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  db().exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM __change_log;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;`);
}, 30000);

function revisionRow(versionId: string): DbJson {
  const row = db().get<Record<string, unknown>>(
    'SELECT * FROM note_document_revisions WHERE version_id=?1',
    [versionId],
  );
  if (row === undefined) throw new Error('revision missing');
  const out: { [key: string]: DbJson } = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ? value as DbJson
      : String(value);
  }
  return out;
}

const CONTEXT = { deviceId: 'device-local', allowSyncTestFixtureTables: true } as const;
const applyDownloadedChanges: SyncService['applyDownloadedChanges'] = (...args) => host.ctx.sync.applyDownloadedChanges(...args);

function payloads(): EngineChange[] {
  const pending = host.ctx.sync.getPendingChanges(handle(), null, null);
  const entries = pending.entries.filter(entry => entry.table_name === 'notes' || entry.table_name === 'resources');
  const changes = host.ctx.sync.enrichChangesWithData(handle(), entries, null);
  for (const change of changes) {
    change.suppress_change_log = true;
    change.database_name = 'vfs';
  }
  return changes.reverse();
}

describe('note history sync hooks', () => {
  it('S01: public apply uses default production syncSupport reader and notes owner on the same transaction', () => {
    expect(hooks).toBe(getDefaultNoteHistory());
    const note = noteRepository.createNote({ title: 'Default chain', content: 'body' }, db());
    const version = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const batch = payloads();
    const original = batch.find(change => change.table_name === 'note_document_revisions' && change.record_id === version)!;
    const resource = batch.find(change => change.table_name === 'resources' && change.record_id === note.resourceId)!;
    if (!isJsonObject(resource.data)) throw new Error('resource missing');
    const reader = vi.spyOn(host.ctx.syncSupport.noteHistory, 'available');
    const owner = vi.spyOn(host.ctx.notes.sync!, 'applyRevision');
    try {
      // Resource updates invoke the format/affected-note reader; revision rows
      // deliberately route directly to the immutable-history owner in Rust.
      const result = host.ctx.sync.applyDownloadedChanges(handle(), [original, {
        ...resource, operation: 'Update', data: { ...resource.data, data: 'updated body', updated_at: Date.now() + 1 },
      }], CONTEXT);
      expect(result.failure_count).toBe(0);
      expect(reader).toHaveBeenCalled();
      expect(owner).toHaveBeenCalledTimes(1);
      expect(owner.mock.calls[0]![0]).not.toBe(handle());
      expect(owner.mock.calls[0]![1]).toBe(version);
      expect(reader.mock.calls.some(([tx]) => tx === owner.mock.calls[0]![0])).toBe(true);
      expect(noteRevisionRepository.get(db(), note.id, version).content_md).toBe('body');
    } finally { reader.mockRestore(); owner.mockRestore(); }
  });
  it('row_sync_transmits_history_dependencies_and_preserves_remote_before_after', async () => {
    const target = (await createEmptyDatabase()).handle;
    const note = noteRepository.createNote({ title: 'Sync fixture', content: 'before', tags: [] }, db());
    const changes = payloads();
    const futureBatch = changes.map(change => ({ ...change, data: cloneDbJson(change.data) }));
    const future = futureBatch.find(change => change.table_name === 'note_document_formats')!;
    if (!isJsonObject(future.data)) throw new Error('missing format envelope');
    future.data.format_version = 999;
    expect(() => applyDownloadedChanges(target, futureBatch, CONTEXT)).toThrow();
    expect(Number(target.pluck('SELECT COUNT(*) FROM notes'))).toBe(0);

    const capabilityBatch = changes.map(change => ({ ...change, data: cloneDbJson(change.data) }));
    const capability = capabilityBatch.find(change => change.table_name === 'note_document_formats')!;
    if (!isJsonObject(capability.data)) throw new Error('missing format envelope');
    capability.data.serializer_version = 'markdown-v1+ds-columns-v999';
    expect(() => applyDownloadedChanges(target, capabilityBatch, CONTEXT)).toThrow();
    expect(Number(target.pluck('SELECT COUNT(*) FROM resources'))).toBe(0);

    const history = changes.find(change => change.table_name === 'note_document_revisions')!;
    expect(history.data).not.toHaveProperty('seq');
    expect(history.data).toHaveProperty('pinned');
    expect(applyDownloadedChanges(target, changes, CONTEXT).failure_count).toBe(0);
    expect(() => noteRevisionRepository.get(target, note.id, history.record_id)).not.toThrow();
    noteRepository.updateNote(note.id, { content: 'after' }, db());
    expect(applyDownloadedChanges(target, payloads(), CONTEXT).failure_count).toBe(0);
    expect(noteRepository.getNoteContent(note.id, target)).toBe('after');
    const states = target.all<{ content_md: string; pinned: number }>(
      'SELECT content_md,pinned FROM note_document_revisions WHERE note_id=?1', [note.id],
    );
    expect(states.some(row => row.content_md === 'before' && Boolean(row.pinned))).toBe(true);
    expect(states.some(row => row.content_md === 'after')).toBe(true);
    const restored = noteRevisionRepository.restoreCopy(target, note.id, history.record_id);
    expect(noteRepository.getNoteContent(restored.id, target)).toBe('before');
  });
  it('apply_revision_reinserts_immutable_history_row', () => {
    const note = noteRepository.createNote({ title: 'history', content: 'hello' }, db());
    const versionId = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const data = revisionRow(versionId);
    db().run('DELETE FROM note_document_revisions WHERE version_id=?1', [versionId]);

    hooks.applyRevision!(db(), versionId, data);

    expect(db().pluck<string>('SELECT title FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toBe('history');
    expect(db().pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toBe(0);
  });

  it('apply_revision_rejects_immutable_history_conflict', () => {
    const note = noteRepository.createNote({ title: 'history', content: 'hello' }, db());
    const versionId = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const data = revisionRow(versionId) as { [key: string]: DbJson };
    data.title = 'tampered';

    expect(() => hooks.applyRevision!(db(), versionId, data))
      .toThrow(new RegExp(`Immutable history conflict: ${versionId}`));
  });

  it('R4 S03: immutable props_json compares nested integers exactly and accepts equal reordered JSON', () => {
    const note = noteRepository.createNote({ title: 'precision', content: 'body' }, db());
    const version = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    db().run('UPDATE note_document_revisions SET props_json=?1 WHERE version_id=?2', ['{"nested":{"n":9007199254740992},"other":1}', version]);
    const original = revisionRow(version);
    if (!isJsonObject(original)) throw new Error('history row missing');
    expect(() => hooks.applyRevision!(db(), version, { ...original, props_json: '{"other":1,"nested":{"n":9007199254740992}}' })).not.toThrow();
    expect(() => hooks.applyRevision!(db(), version, { ...original, props_json: '{"nested":{"n":9007199254740993},"other":1}' })).toThrow('Immutable history conflict:');
    expect(db().pluck('SELECT props_json FROM note_document_revisions WHERE version_id=?1', [version])).toBe(original.props_json);
  });

  it('R4 S04: owner relation CAS reads the exact SQLite i64 before incrementing', () => {
    const note = noteRepository.createNote({ title: 'CAS fixture', content: 'body' }, db());
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES ('large-cas',?1,'source','target','{"type":"whole"}',?2,?3,?3)`,
    [note.id, 9007199254740993n, note.updatedAt]);
    const data: Record<string, DbJson> = { relation_type: 'source', locator_json: '{"type":"whole"}' };
    hooks.prepareRelation!(db(), 'large-cas', data);
    expect(data.revision).toBe(9007199254740994n);
  });

  it('R4 S03: owner immutable lookup does not round the local history seq', () => {
    const note = noteRepository.createNote({ title: 'History i64', content: 'body' }, db());
    const version = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const data = host.ctx.sync.getRecordData(handle(), 'note_document_revisions', version, 'version_id');
    db().run('UPDATE note_document_revisions SET seq=?1 WHERE version_id=?2', [9007199254740993n, version]);
    expect(() => hooks.applyRevision!(db(), version, data)).not.toThrow();
  });

  it('W18: history owner writes use the apply transaction and roll back on owner failure', () => {
    const note = noteRepository.createNote({ title: 'Owner transaction', content: 'before' }, db());
    const owner = host.ctx.notes.sync!;
    const original = owner.updateInferredFormat.bind(owner);
    const call = vi.spyOn(owner, 'updateInferredFormat').mockImplementation((tx, id) => {
      expect(tx).not.toBe(handle());
      expect(noteRepository.getNoteContent(id, tx)).toBe('after');
      original(tx, id);
      throw new Error('owner update failed');
    });
    try {
      const resource = payloads().find(change => change.table_name === 'resources' && change.record_id === note.resourceId)!;
      if (!isJsonObject(resource.data)) throw new Error('resource missing');
      const result = host.ctx.sync.applyDownloadedChanges(handle(), [{ ...resource, operation: 'Update',
        data: { ...resource.data, data: 'after', updated_at: Date.now() + 1 },
      }], CONTEXT);
      expect(result.failure_count).toBe(1);
      expect(result.failures[0]!.error).toContain('owner update failed');
      expect(call).toHaveBeenCalled();
      expect(noteRepository.getNoteContent(note.id, db())).toBe('before');
    } finally { call.mockRestore(); }
  });

  it('apply_revision_never_clears_local_pin_on_remote_unpin', () => {
    const note = noteRepository.createNote({ title: 'history', content: 'hello' }, db());
    const versionId = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    noteRevisionRepository.setPinned(db(), note.id, versionId, true);
    const data = revisionRow(versionId) as { [key: string]: DbJson };
    data.pinned = 0;

    hooks.applyRevision!(db(), versionId, data);

    expect(db().pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toBe(1);
  });

  it('validate_batch_formats_rejects_unsupported_future_envelope', () => {
    const note = noteRepository.createNote({ title: 'history', content: 'hello' }, db());
    const change: EngineChange = {
      table_name: 'note_document_formats',
      record_id: note.id,
      operation: 'Insert',
      data: {
        note_id: note.id,
        content_format: 'markdown-legacy',
        format_version: 2,
        serializer_version: 'markdown-v1',
        baseline_version_id: null,
      },
      changed_at: '2026-01-01T00:00:00Z',
      database_name: 'vfs',
    };

    expect(() => hooks.validateBatchFormats!(db(), [change]))
      .toThrow(/Unsupported future note format/u);
  });

  it('snapshot_notes_remote_sync_reinfers_format_without_dropping_capability', () => {
    const note = noteRepository.createNote({ title: 'history', content: 'hello' }, db());
    db().run(
      "UPDATE note_document_formats SET content_format='markdown-blocks', serializer_version='blocks-v1+ds-columns-v1' WHERE note_id=?1",
      [note.id],
    );

    hooks.snapshotNotes!(db(), [note.id], 'remote_sync');

    expect(db().pluck<string>('SELECT content_format FROM note_document_formats WHERE note_id=?1', [note.id]))
      .toBe('markdown-legacy');
    expect(db().pluck<string>('SELECT serializer_version FROM note_document_formats WHERE note_id=?1', [note.id]))
      .toBe('markdown-v1+ds-columns-v1');
    expect(db().pluck<string>('SELECT updated_at FROM note_document_formats WHERE note_id=?1', [note.id]))
      .toBe('');
  });

  it('direct_remote_resource_update_keeps_both_full_document_snapshots', () => {
    const note = noteRepository.createNote({
      title: 'Resource fixture',
      content: 'original full document\n\nsuffix',
    }, db());
    noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const changes = payloads();
    expect(applyDownloadedChanges(handle(), changes, CONTEXT).failure_count).toBe(0);

    const resource = changes.find(item =>
      item.table_name === 'resources' && item.record_id === note.resourceId);
    expect(resource).toBeDefined();
    const data = resource!.data as { [key: string]: unknown };
    data.data = 'remote full document\n\nremote suffix';
    data.updated_at = String(Date.now());
    const result = applyDownloadedChanges(handle(), [{ ...resource!, operation: 'Update' }], CONTEXT);
    expect(result.failure_count).toBe(0);

    expect(noteRepository.getNoteContent(note.id, db())).toBe('remote full document\n\nremote suffix');
    const versions = noteRevisionRepository.list(db(), note.id, null, 100);
    const snapshots = versions.items.map(version =>
      noteRevisionRepository.get(db(), note.id, version.version_id));
    expect(snapshots.some(version => version.content_md === 'original full document\n\nsuffix'
      && version.pinned)).toBe(true);
    expect(snapshots.some(version => version.content_md === 'remote full document\n\nremote suffix'))
      .toBe(true);
  });

  it('relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it', async () => {
    const note = noteRepository.createNote({ title: 'Relation fixture', content: 'body' }, db());
    noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    db().run(
      `INSERT INTO note_learning_relations
       (id, note_id, relation_type, resource_id, locator_json, revision, created_at, updated_at)
       VALUES ('relation', ?1, 'source', 'missing-target', '{"type":"whole"}', 77, ?2, ?2)`,
      [note.id, note.updatedAt],
    );
    const changes = payloads();
    const relation = changes.find(item => item.table_name === 'note_learning_relations');
    expect(relation).toBeDefined();
    expect((relation!.data as { [key: string]: unknown }).revision).toBeUndefined();
    const target = await createEmptyDatabase();

    const result = applyDownloadedChanges(target.handle, changes, CONTEXT);
    expect(result.failure_count).toBe(0);
    const revision = (): number => Number(target.handle.pluck<number>(
      "SELECT revision FROM note_learning_relations WHERE id='relation'",
    ));
    expect(revision()).toBe(1);

    applyDownloadedChanges(target.handle, [relation!], CONTEXT);
    expect(revision()).toBe(1);
    expect(Number(target.handle.pluck<number>("SELECT count(*) FROM resources WHERE id='missing-target'")))
      .toBe(0);

    const moved = {
      ...relation!,
      data: {
        ...(relation!.data as { [key: string]: unknown }),
        resource_id: note.resourceId,
        updated_at: new Date().toISOString(),
      },
    };
    expect(applyDownloadedChanges(target.handle, [moved], CONTEXT).failure_count).toBe(0);
    expect(revision()).toBe(2);
    applyDownloadedChanges(target.handle, [moved], CONTEXT);
    expect(revision()).toBe(2);

    // 命令层验证：L10 的 deletion journal owner 是进程级 Slot，同进程不允许第二个
    // notes 实例；把 target 中 apply 出的关系行按同一形状复制回主 host 的 vfs，再经
    // 公开 notes_relation_get 读取（不跨插件 import 内部实现）。
    const applied = target.handle.get<{
      id: string;
      note_id: string;
      block_id: string | null;
      relation_type: string;
      resource_id: string;
      locator_json: string;
      revision: number | bigint;
      invalidated_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, note_id, block_id, relation_type, resource_id, locator_json, revision,
         invalidated_at, created_at, updated_at
       FROM note_learning_relations WHERE id=?1`, ['relation'])!;
    handle().run(
      `INSERT OR REPLACE INTO note_learning_relations
       (id, note_id, block_id, relation_type, resource_id, locator_json, revision,
        invalidated_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [applied.id, applied.note_id, applied.block_id, applied.relation_type,
        applied.resource_id, applied.locator_json, applied.revision,
        applied.invalidated_at, applied.created_at, applied.updated_at],
    );
    try {
      const row = await host.invoke<{ reference: { resource_exists: boolean; locator_exists: boolean } }>(
        'notes_relation_get', { id: 'relation' },
      );
      expect(row?.reference.resource_exists).toBe(true);
      expect(row?.reference.locator_exists).toBe(true);
    } finally {
      handle().run("DELETE FROM note_learning_relations WHERE id='relation'");
    }
  });

  it('remote_pin_is_retained_after_unpinned_replay_and_prune', () => {
    const note = noteRepository.createNote({ title: 'Pin fixture', content: 'body' }, db());
    const versionId = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const original = payloads().find(item =>
      item.table_name === 'note_document_revisions' && item.record_id === versionId);
    expect(original).toBeDefined();
    noteRevisionRepository.setPinned(db(), note.id, versionId, false);

    const pinned = {
      ...original!,
      data: { ...(original!.data as { [key: string]: unknown }), pinned: 1 },
    };
    expect(applyDownloadedChanges(handle(), [pinned], CONTEXT).failure_count).toBe(0);
    const unpinned = {
      ...original!,
      data: { ...(original!.data as { [key: string]: unknown }), pinned: 0 },
    };
    expect(applyDownloadedChanges(handle(), [unpinned], CONTEXT).failure_count).toBe(0);

    const prune = { ...original!, operation: 'Delete' as const, data: null };
    applyDownloadedChanges(handle(), [prune], CONTEXT);
    expect(noteRevisionRepository.get(db(), note.id, versionId).pinned).toBe(true);
  });

  it('immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins', () => {
    const note = noteRepository.createNote({ title: 'Fixture', content: 'original' }, db());
    const versionId = noteRevisionRepository.snapshot(db(), note.id, 'before_sync');
    const payload = payloads();
    const original = payload.find(item =>
      item.table_name === 'note_document_revisions' && item.record_id === versionId);
    expect(original).toBeDefined();
    noteRevisionRepository.setPinned(db(), note.id, versionId, true);

    const tampered = {
      ...original!,
      data: { ...(original!.data as { [key: string]: unknown }), content_md: 'tampered' },
    };
    const result = applyDownloadedChanges(handle(), [tampered], CONTEXT);
    expect(result.failure_count).toBe(1);
    const saved = noteRevisionRepository.get(db(), note.id, versionId);
    expect(saved.content_md).toBe('original');
    expect(saved.pinned).toBe(true);

    expect(applyDownloadedChanges(handle(), [original!], CONTEXT).failure_count).toBe(0);
    const deletion = { ...original!, operation: 'Delete' as const, data: null };
    applyDownloadedChanges(handle(), [deletion], CONTEXT);
    expect(noteRevisionRepository.get(db(), note.id, versionId).pinned).toBe(true);

    const future = {
      ...original!,
      record_id: 'future-version',
      data: {
        ...(original!.data as { [key: string]: unknown }),
        version_id: 'future-version',
        format_version: 999,
      },
    };
    expect(applyDownloadedChanges(handle(), [future], CONTEXT).failure_count).toBe(1);
    expect(() => noteRevisionRepository.get(db(), note.id, 'future-version')).toThrow();
  });
});
