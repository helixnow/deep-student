import { describe, expect, it } from 'vitest';
import { defineQuery } from '../../../platform/storage/api.ts';
import type { JsonValue, SyncChangeWithData } from '../api.ts';
import { serviceHost } from './service-host.ts';
import { MINIMAL_NOTES_SCHEMA } from './note-fixtures.ts';

const ABOVE_SAFE = 9_007_199_254_740_993n;
const I64_MAX = 9_223_372_036_854_775_807n;

describe('R4 S03: exact SQLite integers through syncSupport', () => {
  it('roundtrips cursors, watermarks, upload and event sequences through i64::MAX', async () => {
    const h = await serviceHost();
    try {
      const state = h.service.state;
      for (const n of [ABOVE_SAFE, I64_MAX]) {
        state.setCursor('i', 'd', n);
        state.setCursor('i', 'd', n - 1n);
        expect(state.getCursor('i', 'd')).toBe(n);
        expect(state.cursors('i').get('d')).toBe(n);
        state.setTombstoneWatermark('i', 'd', 'blobs', n);
        expect(state.getTombstoneWatermark('i', 'd', 'blobs')).toBe(n);
        state.markPublishedSeq('i', 'd', n);
        expect(state.publishedMaxSeq('i', 'd')).toBe(n);
        expect(state.nextUploadSeq('i', 'd', 0n)).toBe(n === I64_MAX ? n : n + 1n);
        expect(state.reserveTombstoneEventSeqWithExisting('i', 'd', String(n), 'a', 0n, n)).toBe(n);
        expect(state.reserveTombstoneEventSeq('i', 'd', String(n), 'a', 0n)).toBe(n);
        if (n !== I64_MAX) expect(state.reserveTombstoneEventSeq('i', 'd', String(n), 'b', 0n)).toBe(n + 1n);
      }
      state.setCursor('i', 'saturated', (1n << 64n) - 1n);
      expect(state.getCursor('i', 'saturated')).toBe(I64_MAX);
    } finally { await h.dispose(); }
  });

  it('prepare_relation increments the full i64 range and rejects only checked_add overflow', async () => {
    const h = await serviceHost();
    try {
      h.db.exec('CREATE TABLE note_learning_relations(id TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
      for (const current of [ABOVE_SAFE, I64_MAX - 1n, -5n, -9007199254740994n, -(1n << 63n)]) {
        h.db.run('INSERT OR REPLACE INTO note_learning_relations VALUES (?, ?)', ['r', current]);
        const obj: Record<string, JsonValue> = { locator_json: '{"type":"whole"}', relation_type: 'source' };
        h.service.noteHistory.prepareRelation(h.db, 'r', obj);
        expect(obj.revision).toBe(current === -5n ? -4 : current + 1n);
      }
      h.db.run('UPDATE note_learning_relations SET revision=?', [I64_MAX]);
      expect(() => h.service.noteHistory.prepareRelation(h.db, 'r', {
        locator_json: '{"type":"whole"}', relation_type: 'source',
      })).toThrow('Database error: Relation revision exhausted');
    } finally { await h.dispose(); }
  });

  it('history dependencies preserve INTEGER values instead of rounding before publication', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`CREATE TABLE note_document_revisions(version_id TEXT PRIMARY KEY, note_id TEXT, seq INTEGER, value INTEGER);
        INSERT INTO note_document_revisions VALUES ('v', 'n', 1, 9007199254740993);`);
      const changes: SyncChangeWithData[] = [{ table_name: 'notes', record_id: 'n', operation: 'Insert',
        data: { id: 'n' }, changed_at: '2026-01-01T00:00:00Z' }];
      h.service.noteHistory.includeNoteDependencies(h.db, changes);
      expect(changes[1]?.data).toEqual({ version_id: 'v', note_id: 'n', value: ABOVE_SAFE });
    } finally { await h.dispose(); }
  });

  it('the real notes owner compares immutable INTEGER history fields without rounding', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(MINIMAL_NOTES_SCHEMA);
      const revision = {
        version_id: 'v', note_id: 'n', title: 't', content_md: 'body', tags_json: '[]',
        asset_refs_json: '[]', source: 'remote_sync', created_at: '2026-11-04T00:00:00Z',
        content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1',
        content_bytes: ABOVE_SAFE,
      };
      h.service.noteHistory.applyRevision(h.db, 'v', revision);
      expect(() => h.service.noteHistory.applyRevision(h.db, 'v', revision)).not.toThrow();
      expect(() => h.service.noteHistory.applyRevision(h.db, 'v', {
        ...revision, content_bytes: ABOVE_SAFE - 1n,
      })).toThrow('Database error: Immutable history conflict: v (content_bytes)');
    } finally { await h.dispose(); }
  });

  it('conflict comparison, snapshot arguments and saved JSON keep distinct adjacent i64 values', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, value INTEGER);
        INSERT INTO items VALUES ('r', 9007199254740993);
        CREATE TABLE __change_log(table_name TEXT, record_id TEXT, sync_version INTEGER);
        INSERT INTO __change_log VALUES ('items', 'r', 0);`);
      const snapshots: JsonValue[] = [];
      const resolver = h.service.conflicts.createResolver('keep_cloud', {
        newBatchId: () => 'batch',
        snapshotRecord: (_db, _batch, _reason, _table, _id, value) => { snapshots.push(value); return true; },
      });
      const change: SyncChangeWithData = { table_name: 'items', record_id: 'r', operation: 'Update',
        changed_at: '2026-01-01T00:00:00Z', data: { id: 'r', value: ABOVE_SAFE } };
      expect(resolver.resolveOne(h.db, change, 'id')).toBeNull();
      change.data = { id: 'r', value: ABOVE_SAFE - 1n };
      const conflict = resolver.resolveOne(h.db, change, 'id');
      expect(conflict?.loser_data).toEqual({ id: 'r', value: ABOVE_SAFE });
      expect(snapshots).toEqual([{ id: 'r', value: ABOVE_SAFE }]);
      h.service.conflicts.saveConflictRecord(h.db, {
        table_name: 'items', record_id: 'r', side: 'local', data: conflict!.loser_data,
      });
      expect(h.db.pluck('SELECT data_json FROM __sync_conflicts')).toBe('{"id":"r","value":9007199254740993}');
    } finally { await h.dispose(); }
  });

  it('echo suppression leaves a pre-existing odd i64 change-log id unsynced', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`CREATE TABLE todo_items(id TEXT PRIMARY KEY, completed_pomodoros INTEGER);
        CREATE TABLE pomodoro_records(todo_item_id TEXT, status TEXT, type TEXT, deleted_at TEXT);
        CREATE TABLE __change_log(id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, sync_version INTEGER);
        INSERT INTO todo_items VALUES ('t', 99);
        INSERT INTO pomodoro_records VALUES ('t', 'completed', 'work', NULL);
        INSERT INTO __change_log VALUES (9007199254740993, 'todo_items', 0);
        CREATE TRIGGER count_changed AFTER UPDATE ON todo_items BEGIN
          INSERT INTO __change_log(table_name, sync_version) VALUES ('todo_items', 0);
        END;`);
      h.service.pomodoroCounts.recompute(h.db);
      const rows = h.db.all(defineQuery<[], { id: bigint; sync_version: bigint }>(
        'SELECT id, sync_version FROM __change_log ORDER BY id', { options: { safeIntegers: true } },
      ), []);
      expect(rows[0]).toEqual({ id: ABOVE_SAFE, sync_version: 0n });
      expect(rows[1]?.id).toBe(ABOVE_SAFE + 1n);
      expect(rows[1]?.sync_version).toBeGreaterThan(0n);
      expect(h.db.pluck('SELECT completed_pomodoros FROM todo_items')).toBe(1);
    } finally { await h.dispose(); }
  });
});
