import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { cloneDbJson, isJsonObject, type EngineChange } from '../../sync/api.ts';
import type { NotesRelationGetCommandResult } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { serviceHost } from './service-host.ts';

// Rust note_history.rs:393-731 uses migrated source/target databases, real note
// creation and the production pending -> enrich -> apply chain. No hook overrides.
const stores: ReturnType<typeof createStorageService>[] = [];
const dirs: string[] = [];
let source: DatabaseHandle;
let target: DatabaseHandle;
let host: Awaited<ReturnType<typeof serviceHost>>;
const context = { deviceId: 'note-history-apply' };

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-support-note-apply-'));
    dirs.push(dir);
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    stores.push(storage);
    await storage.migrations.runAll();
  }
  source = stores[0]!.database('vfs');
  target = stores[1]!.database('vfs');
  // One application registers the process-wide notes owner once. Source/target
  // operations still use distinct real handles, passed explicitly to every API.
  // The command endpoint reads the target database, as the Rust reference does.
  host = await serviceHost(target, true);
}, 120_000);

afterAll(async () => {
  try {
    await host?.dispose();
  } finally {
    for (const storage of stores) storage.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  for (const db of [source, target]) {
    db.exec(`PRAGMA foreign_keys=OFF;
      DELETE FROM note_document_revisions;
      DELETE FROM note_document_formats;
      DELETE FROM note_learning_relations;
      DELETE FROM note_links;
      DELETE FROM note_tags;
      DELETE FROM folder_items;
      DELETE FROM notes;
      DELETE FROM resources;
      DELETE FROM __change_log;
      PRAGMA foreign_keys=ON;`);
  }
});

function payloads(): EngineChange[] {
  const pending = host.sync!.getPendingChanges(source, null, null);
  const changes = host.sync!.enrichChangesWithData(source,
    pending.entries.filter(row => row.table_name === 'notes' || row.table_name === 'resources'), null);
  for (const change of changes) {
    change.suppress_change_log = true;
    change.database_name = 'vfs';
  }
  return changes.reverse();
}

function rowChange(changes: EngineChange[], table: string): EngineChange {
  const change = changes.find(row => row.table_name === table);
  expect(change).toBeDefined();
  return change!;
}

function dataOf(change: EngineChange) {
  if (!isJsonObject(change.data)) throw new Error(`Missing ${change.table_name} payload`);
  return change.data;
}

function apply(db: DatabaseHandle, changes: EngineChange[]) {
  return host.sync!.applyDownloadedChanges(db, changes, context);
}

describe('note_history.rs: real pending/enrich/default apply chain', () => {
  it('direct_remote_resource_update_keeps_both_full_document_snapshots', () => {
    const note = host.notes.repository.createNote({ title: 'Resource fixture',
      content: 'original full document\n\nsuffix', tags: [] }, source);
    const changes = payloads();
    expect(apply(target, changes).failure_count).toBe(0);
    const resource = rowChange(changes.filter(row => row.record_id === note.resourceId), 'resources');
    dataOf(resource).data = 'remote full document\n\nremote suffix';
    dataOf(resource).updated_at = Date.now() + 1;
    resource.operation = 'Update';
    // Observe real implementations only: both the support reader and L10 writer
    // must execute on the transaction passed by the default production hooks.
    const reader = vi.spyOn(host.service.noteHistory, 'available');
    const writer = vi.spyOn(host.notes.sync!, 'updateInferredFormat');
    try {
      expect(apply(target, [resource]).failure_count).toBe(0);
      expect(reader).toHaveBeenCalled();
      expect(writer).toHaveBeenCalled();
      const tx = writer.mock.calls[0]![0];
      expect(tx).not.toBe(target);
      expect(reader.mock.calls.some(([conn]) => conn === tx)).toBe(true);
    } finally { reader.mockRestore(); writer.mockRestore(); }
    expect(host.notes.repository.getNoteContent(note.id, target)).toBe('remote full document\n\nremote suffix');
    const snapshots = host.notes.revisions.list(target, note.id, null, 100).items
      .map(row => host.notes.revisions.get(target, note.id, row.version_id));
    expect(snapshots.some(row => row.content_md === 'original full document\n\nsuffix' && row.pinned)).toBe(true);
    expect(snapshots.some(row => row.content_md === 'remote full document\n\nremote suffix')).toBe(true);
  });

  it('relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it', async () => {
    const note = host.notes.repository.createNote({ title: 'Relation fixture', content: 'body', tags: [] }, source);
    source.run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES ('relation',?1,'source','missing-target','{"type":"whole"}',77,?2,?2)`, [note.id, note.updatedAt]);
    const changes = payloads();
    const relation = rowChange(changes, 'note_learning_relations');
    expect(Object.hasOwn(dataOf(relation), 'revision')).toBe(false);
    expect(apply(target, changes).failure_count).toBe(0);
    const revision = () => target.pluck("SELECT revision FROM note_learning_relations WHERE id='relation'");
    expect(revision()).toBe(1);
    expect(apply(target, [relation]).failure_count).toBe(0);
    expect(revision()).toBe(1);
    expect(target.pluck("SELECT COUNT(*) FROM resources WHERE id='missing-target'")).toBe(0);
    dataOf(relation).resource_id = note.resourceId;
    dataOf(relation).updated_at = new Date(Date.now() + 1).toISOString();
    expect(apply(target, [relation]).failure_count).toBe(0);
    expect(revision()).toBe(2);
    expect(apply(target, [relation]).failure_count).toBe(0);
    expect(revision()).toBe(2);
    const row = await host.invoke<NotesRelationGetCommandResult>('notes_relation_get', { id: 'relation' });
    expect(row?.reference.resource_exists).toBe(true);
    expect(row?.reference.locator_exists).toBe(true);
  });

  it('remote_pin_is_retained_after_unpinned_replay_and_prune', () => {
    const note = host.notes.repository.createNote({ title: 'Pin fixture', content: 'body', tags: [] }, source);
    const original = rowChange(payloads(), 'note_document_revisions');
    host.notes.revisions.setPinned(source, note.id, original.record_id, false);
    const pinned = { ...original, data: { ...dataOf(original), pinned: 1 } };
    expect(apply(source, [pinned]).failure_count).toBe(0);
    const unpinned = { ...original, data: { ...dataOf(original), pinned: 0 } };
    expect(apply(source, [unpinned]).failure_count).toBe(0);
    expect(apply(source, [{ ...original, operation: 'Delete', data: null }]).failure_count).toBe(0);
    expect(host.notes.revisions.get(source, note.id, original.record_id).pinned).toBe(true);
  });

  it('row_sync_transmits_history_dependencies_and_preserves_remote_before_after', () => {
    const note = host.notes.repository.createNote({ title: 'Sync fixture', content: 'before', tags: [] }, source);
    const changes = payloads();
    const future = changes.map(row => ({ ...row, data: cloneDbJson(row.data) }));
    dataOf(rowChange(future, 'note_document_formats')).format_version = 999;
    expect(() => apply(target, future)).toThrow();
    expect(target.pluck('SELECT COUNT(*) FROM notes')).toBe(0);
    const capability = changes.map(row => ({ ...row, data: cloneDbJson(row.data) }));
    dataOf(rowChange(capability, 'note_document_formats')).serializer_version = 'markdown-v1+ds-columns-v999';
    expect(() => apply(target, capability)).toThrow();
    expect(target.pluck('SELECT COUNT(*) FROM resources')).toBe(0);
    const history = rowChange(changes, 'note_document_revisions');
    expect(Object.hasOwn(dataOf(history), 'seq')).toBe(false);
    expect(Object.hasOwn(dataOf(history), 'pinned')).toBe(true);
    expect(apply(target, changes).failure_count).toBe(0);
    expect(() => host.notes.revisions.get(target, note.id, history.record_id)).not.toThrow();
    host.notes.repository.updateNote(note.id, { content: 'after' }, source);
    expect(apply(target, payloads()).failure_count).toBe(0);
    expect(host.notes.repository.getNoteContent(note.id, target)).toBe('after');
    const states = target.all<{ content_md: string; pinned: number }>(
      'SELECT content_md,pinned FROM note_document_revisions WHERE note_id=?1', [note.id]);
    expect(states.some(row => row.content_md === 'before' && row.pinned !== 0)).toBe(true);
    expect(states.some(row => row.content_md === 'after')).toBe(true);
    const restored = host.notes.revisions.restoreCopy(target, note.id, history.record_id);
    expect(host.notes.repository.getNoteContent(restored.id, target)).toBe('before');
  });

  it('immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins', () => {
    const note = host.notes.repository.createNote({ title: 'Fixture', content: 'original', tags: [] }, source);
    const original = rowChange(payloads(), 'note_document_revisions');
    host.notes.revisions.setPinned(source, note.id, original.record_id, true);
    const tampered = { ...original, data: { ...dataOf(original), content_md: 'tampered' } };
    const result = apply(source, [tampered]);
    expect(result.failure_count).toBe(1);
    expect(result.failures[0]?.error).toContain('Immutable history conflict:');
    const saved = host.notes.revisions.get(source, note.id, original.record_id);
    expect(saved.content_md).toBe('original');
    expect(saved.pinned).toBe(true);
    expect(apply(source, [original]).failure_count).toBe(0);
    expect(apply(source, [{ ...original, operation: 'Delete', data: null }]).failure_count).toBe(0);
    expect(host.notes.revisions.get(source, note.id, original.record_id).pinned).toBe(true);
    const future = { ...original, record_id: 'future-version',
      data: { ...dataOf(original), version_id: 'future-version', format_version: 999 } };
    expect(apply(source, [future]).failure_count).toBe(1);
    expect(() => host.notes.revisions.get(source, note.id, 'future-version')).toThrow();
  });
});
