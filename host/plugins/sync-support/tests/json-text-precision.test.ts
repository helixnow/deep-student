import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, SyncChangeWithData } from '../api.ts';
import { MINIMAL_NOTES_SCHEMA } from './note-fixtures.ts';
import { serviceHost } from './service-host.ts';

const LOW = '{"counter":9007199254740992}';
const HIGH = '{"counter":9007199254740993}';
const low = { id: 'r', props_json: LOW };
const high = { id: 'r', props_json: HIGH };

describe('R4 §5 S03: adjacent integers inside persisted JSON text', () => {
  it('propagates missing numeric source access while malformed JSON retains the Rust string fallback', async () => {
    const h = await serviceHost();
    const nativeParse = JSON.parse;
    try {
      expect(h.service.conflicts.canonicalizeForCompare({ props_json: '{invalid' }))
        .toEqual({ props_json: '{invalid' });
      // Emulate the platform capability gap, retaining the native JSON parser and
      // production shared parser/hash logic; only the reviver source argument is absent.
      vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => nativeParse(text,
        reviver === undefined ? undefined : function (key: string, value: unknown) {
          return reviver.call(this, key, value);
        }));
      expect(() => h.service.conflicts.computeDataHash(high))
        .toThrow('Lossless JSON parsing requires JSON.parse source access');
    } finally { vi.restoreAllMocks(); await h.dispose(); }
  });

  it('computeDataHash distinguishes adjacent i64 JSON values but ignores JSON whitespace', async () => {
    const h = await serviceHost();
    try {
      const conflicts = h.service.conflicts;
      expect(conflicts.computeDataHash(low)).not.toBe(conflicts.computeDataHash(high));
      expect(conflicts.computeDataHash(high)).toBe(conflicts.computeDataHash({
        id: 'r', props_json: ' { "counter" : 9007199254740993 } ',
      }));
    } finally { await h.dispose(); }
  });

  it('resolveOne detects changed JSON text and snapshots the exact previous content', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, props_json TEXT);
        CREATE TABLE __change_log(table_name TEXT, record_id TEXT, sync_version INTEGER);
        INSERT INTO __change_log VALUES ('items', 'r', 0);`);
      h.db.run('INSERT INTO items VALUES (?, ?)', ['r', LOW]);
      const snapshots: JsonValue[] = [];
      const resolver = h.service.conflicts.createResolver('keep_cloud', {
        newBatchId: () => 'json-text-batch',
        snapshotRecord: (_db, _batch, _reason, _table, _id, value) => { snapshots.push(value); return true; },
      });
      const change: SyncChangeWithData = { table_name: 'items', record_id: 'r', operation: 'Update',
        data: high, changed_at: '2026-11-04T00:00:00Z' };
      expect(resolver.resolveOne(h.db, change, 'id')).toEqual({
        winner: 'cloud', loser: 'local', winner_data: high, loser_data: low,
      });
      expect(snapshots).toEqual([low]);
    } finally { await h.dispose(); }
  });

  it('saveConflictRecord persists both JSON-text values and deduplicates only the actual repeat', async () => {
    const h = await serviceHost();
    try {
      const record = { table_name: 'items', record_id: 'r', side: 'local' as const };
      expect(h.service.conflicts.saveConflictRecord(h.db, { ...record, data: low })).toBe(true);
      expect(h.service.conflicts.saveConflictRecord(h.db, { ...record, data: high })).toBe(true);
      expect(h.service.conflicts.saveConflictRecord(h.db, { ...record, data: high })).toBe(false);
      const rows = h.db.all<{ data_json: string }>('SELECT data_json FROM __sync_conflicts ORDER BY id');
      expect(rows.map(row => JSON.parse(row.data_json))).toEqual([low, high]);
    } finally { await h.dispose(); }
  });

  it('applyRevision rejects a changed immutable JSON integer before upgrading the pin', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(MINIMAL_NOTES_SCHEMA);
      const revision = {
        version_id: 'v', note_id: 'n', title: 't', content_md: 'body',
        tags_json: '[]', asset_refs_json: '[]', source: 'remote_sync',
        created_at: '2026-11-04T00:00:00Z', content_format: 'markdown-legacy',
        format_version: 1, serializer_version: 'markdown-v1', props_json: LOW, pinned: 0,
      };
      h.service.noteHistory.applyRevision(h.db, 'v', revision);
      expect(() => h.service.noteHistory.applyRevision(h.db, 'v', {
        ...revision, props_json: HIGH, pinned: 1,
      })).toThrow('Database error: Immutable history conflict: v (props_json)');
      expect(h.db.get('SELECT props_json, pinned FROM note_document_revisions WHERE version_id=?', ['v']))
        .toEqual({ props_json: LOW, pinned: 0 });
      expect(() => h.service.noteHistory.applyRevision(h.db, 'v', {
        ...revision, props_json: ' { "counter" : 9007199254740992 } ',
      })).not.toThrow();
    } finally { await h.dispose(); }
  });
});
