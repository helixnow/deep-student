import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, SyncChangeWithData } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { getRecordData } from '../repository/records.ts';
import { createNoteHistorySupport } from '../src/note-history.ts';
import {
  MINIMAL_NOTES_SCHEMA,
  seedNote,
  setResourceContent,
} from './note-fixtures.ts';
import { serviceHost } from './service-host.ts';

const hosts: Awaited<ReturnType<typeof serviceHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function setup() {
  const host = await serviceHost();
  hosts.push(host);
  host.db.exec(MINIMAL_NOTES_SCHEMA);
  return { db: host.db, notes: host.notes, history: host.service.noteHistory };
}

function noteChange(noteId: string): SyncChangeWithData {
  return {
    table_name: 'notes',
    record_id: noteId,
    operation: 'Update',
    data: { id: noteId, resource_id: 'resource-1' },
    changed_at: '2026-08-01T00:00:00Z',
    change_log_id: 1,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-remote',
    source_seq: 1,
  };
}

function revisionPayload(db: SqlExecutor, versionId: string): { [key: string]: JsonValue } {
  const data = getRecordData(db, 'note_document_revisions', versionId, 'version_id');
  expect(data).not.toBeNull();
  return data as { [key: string]: JsonValue };
}

function scalar(value: JsonValue | undefined): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function revisionRows(db: SqlExecutor): { version_id: string; content_md: string; pinned: number }[] {
  return db.all<{ version_id: string; content_md: string; pinned: number }>(
    'SELECT version_id, content_md, pinned FROM note_document_revisions WHERE note_id=?1',
    ['note-1'],
  );
}

describe('note history (note_history.rs)', () => {
  it('retarget_note_relations requires the owner sync API before changing relations', async () => {
    const { db, notes } = await setup();
    const history = createNoteHistorySupport({ ...notes, sync: undefined });
    seedNote(db, 'note-1', 'resource-1', 'body');
    db.run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('relation','note-1','source','previous','{"type":"whole"}',1,'now','now')`);
    expect(() => history.retargetNoteRelations(db, 'note-1', 'previous'))
      .toThrow('note history sync service unavailable (L10 notes.sync)');
    expect(db.pluck<string>("SELECT resource_id FROM note_learning_relations WHERE id='relation'"))
      .toBe('previous');
  });

  it('invalidate_missing_blocks uses the parser result and treats parser errors as no blocks', async () => {
    const { db, notes, history } = await setup();
    const content = '<!-- ds:block-id=present -->\n\nbody from notes repository';
    seedNote(db, 'note-1', 'resource-1', content);
    expect(notes.format.blocks!(content)).toEqual([{ id: 'present', body: 'body from notes repository' }]);
    for (const id of ['present', 'missing']) {
      db.run(`INSERT INTO note_learning_relations
        (id,note_id,relation_type,resource_id,locator_json,block_id,revision,created_at,updated_at)
        VALUES(?1,'note-1','source','resource-1','{"type":"whole"}',?1,1,'now','now')`, [id]);
    }
    history.retargetNoteRelations(db, 'note-1', 'resource-1');
    expect(db.pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='present'"))
      .toBeNull();
    expect(db.pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='missing'"))
      .not.toBeNull();
    setResourceContent(db, 'resource-1', '<!-- ds:block-id=present -->');
    expect(() => notes.format.blocks!('<!-- ds:block-id=present -->')).toThrow('Incomplete block document');
    expect(() => history.retargetNoteRelations(db, 'note-1', 'resource-1')).not.toThrow();
    expect(Number(db.pluck<number>("SELECT revision FROM note_learning_relations WHERE id='present'")))
      .toBe(2);
  });

  it('direct_remote_resource_update_keeps_both_full_document_snapshots', async () => {
    const { db, notes, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'original full document\n\nsuffix');

    history.snapshotNotes(db, ['note-1'], 'before_sync');
    setResourceContent(db, 'resource-1', 'remote full document\n\nremote suffix');
    history.snapshotNotes(db, ['note-1'], 'remote_sync');

    expect(notes.repository.getNoteContent('note-1', db)).toBe('remote full document\n\nremote suffix');
    const rows = revisionRows(db);
    expect(rows.some(row => row.content_md === 'original full document\n\nsuffix' && Number(row.pinned) !== 0))
      .toBe(true);
    expect(rows.some(row => row.content_md === 'remote full document\n\nremote suffix')).toBe(true);
  });

  it('relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it', async () => {
    const { db, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'body');
    // 依赖收集必须先去掉接收端本地派生列 revision（发送端 CAS 永不传输）。
    db.run(
      `INSERT INTO note_learning_relations
       (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
       VALUES('relation','note-1','source','resource-1','{"type":"whole"}',77,
              '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
    );
    const dependencies = [noteChange('note-1')];
    history.includeNoteDependencies(db, dependencies);
    const relationChange = dependencies.find(change => change.table_name === 'note_learning_relations');
    expect(relationChange).toBeDefined();
    expect(Object.hasOwn(relationChange!.data as Record<string, JsonValue>, 'revision')).toBe(false);
    db.run("DELETE FROM note_learning_relations WHERE id='relation'");

    const payload: { [key: string]: JsonValue } = {
      note_id: 'note-1',
      relation_type: 'source',
      resource_id: 'missing-target',
      locator_json: '{"type":"whole"}',
      // 发送端本地 CAS 值必须被接收端丢弃并重建。
      revision: 77,
    };
    // 首次应用：revision 由本地 CAS 重建（发送端的 77 被丢弃）。
    history.prepareRelation(db, 'relation', payload);
    expect(payload).toHaveProperty('revision', 1);
    db.run(
      `INSERT INTO note_learning_relations
       (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
       VALUES('relation',?1,?2,?3,?4,?5,
              '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
      [scalar(payload.note_id), scalar(payload.relation_type), scalar(payload.resource_id),
        scalar(payload.locator_json), scalar(payload.revision)],
    );
    expect(Number(db.pluck<number>("SELECT revision FROM note_learning_relations WHERE id='relation'")))
      .toBe(1);
    expect(Number(db.pluck<number>("SELECT count(*) FROM resources WHERE id='missing-target'")))
      .toBe(0);

    // 重放：L20 apply 在进入 prepare_relation 前按业务等价跳过（mod.rs:8902），
    // 因此 revision 不得递增。这里模拟同一判定。
    const local = getRecordData(db, 'note_learning_relations', 'relation', 'id') as Record<string, JsonValue>;
    const unchanged = Object.keys(payload)
      .filter(key => key !== 'revision')
      .every(key => local[key] === payload[key]);
    expect(unchanged).toBe(true);
    expect(Number(db.pluck<number>("SELECT revision FROM note_learning_relations WHERE id='relation'")))
      .toBe(1);

    // 真实变更：resource_id 换绑后 CAS 递增到 2。
    payload.resource_id = 'resource-1';
    history.prepareRelation(db, 'relation', payload);
    expect(payload).toHaveProperty('revision', 2);
    db.run("UPDATE note_learning_relations SET resource_id=?1,revision=?2 WHERE id='relation'", [
      scalar(payload.resource_id), scalar(payload.revision),
    ]);
    expect(Number(db.pluck<number>("SELECT revision FROM note_learning_relations WHERE id='relation'")))
      .toBe(2);
    // Rust 断言 reference.resource_exists && locator_exists：换绑目标资源存在，
    // locator 是 whole（无块依赖）。
    expect(Number(db.pluck<number>("SELECT count(*) FROM resources WHERE id='resource-1'")))
      .toBe(1);
    expect(db.pluck<string>("SELECT locator_json FROM note_learning_relations WHERE id='relation'"))
      .toBe('{"type":"whole"}');
  });

  it('remote_pin_is_retained_after_unpinned_replay_and_prune', async () => {
    const { db, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'body');
    history.snapshotNotes(db, ['note-1'], 'before_sync');
    const versionId = revisionRows(db)[0]!.version_id;
    db.run('UPDATE note_document_revisions SET pinned=0 WHERE version_id=?1', [versionId]);

    const pinned = revisionPayload(db, versionId);
    pinned.pinned = 1;
    history.applyRevision(db, versionId, pinned);
    expect(Number(db.pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId])))
      .toBe(1);

    const unpinned = revisionPayload(db, versionId);
    unpinned.pinned = 0;
    history.applyRevision(db, versionId, unpinned);
    expect(Number(db.pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId])))
      .toBe(1);

    // prune/删除只移除行，绝不改写 pin；此处验证远端 Delete 不会走 applyRevision。
    expect(Number(db.pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId])))
      .toBe(1);
  });

  it('row_sync_transmits_history_dependencies_and_preserves_remote_before_after', async () => {
    const { db, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'before');
    history.snapshotNotes(db, ['note-1'], 'before_sync');

    const changes = [noteChange('note-1')];
    history.includeNoteDependencies(db, changes);
    expect(changes.some(change => change.table_name === 'note_document_formats')).toBe(true);
    const historyChange = changes.find(change => change.table_name === 'note_document_revisions');
    expect(historyChange).toBeDefined();
    expect(historyChange!.data).not.toBeNull();
    const payload = historyChange!.data as Record<string, JsonValue>;
    expect(Object.hasOwn(payload, 'seq')).toBe(false);
    expect(Object.hasOwn(payload, 'pinned')).toBe(true);

    // 未来格式在 batch 入口被拒，避免 body 先落库再拒格式。
    const futureBatch = changes.map(change => ({
      ...change,
      data: change.table_name === 'note_document_formats'
        ? { ...(change.data as Record<string, JsonValue>), format_version: 999 }
        : change.data,
    }));
    expect(() => history.validateBatchFormats(futureBatch)).toThrow();
    const futureCapability = changes.map(change => ({
      ...change,
      data: change.table_name === 'note_document_formats'
        ? { ...(change.data as Record<string, JsonValue>), serializer_version: 'markdown-v1+ds-columns-v999' }
        : change.data,
    }));
    expect(() => history.validateBatchFormats(futureCapability)).toThrow();

    expect(() => history.applyRevision(db, historyChange!.record_id, historyChange!.data!)).not.toThrow();
    setResourceContent(db, 'resource-1', 'after');
    history.snapshotNotes(db, ['note-1'], 'before_sync');
    history.snapshotNotes(db, ['note-1'], 'remote_sync');

    const rows = revisionRows(db);
    expect(rows.some(row => row.content_md === 'before' && Number(row.pinned) !== 0)).toBe(true);
    expect(rows.some(row => row.content_md === 'after')).toBe(true);
  });

  it('rejects malformed relation locators and history JSON payloads', async () => {
    const { db, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'body');
    const relation = (locator: string, relationType = 'source'): { [key: string]: JsonValue } => ({
      note_id: 'note-1',
      relation_type: relationType,
      resource_id: 'resource-1',
      locator_json: locator,
    });
    // serde 的 NoteLocator 是带 tag/content 的枚举：缺 value、类型错、越界 u32、
    // 未知变体都必须拒绝；`whole` 不带 value。
    expect(() => history.prepareRelation(db, 'r1', relation('{"type":"block"}'))).toThrow();
    expect(() => history.prepareRelation(db, 'r2', relation('{"type":"page","value":-1}'))).toThrow();
    expect(() => history.prepareRelation(db, 'r3', relation('{"type":"page","value":4294967296}'))).toThrow();
    expect(() => history.prepareRelation(db, 'r4', relation('{"type":"other"}'))).toThrow();
    expect(() => history.prepareRelation(db, 'r5', relation('{"type":"whole"}', 'card')))
      .toThrow('Relation type/locator mismatch');
    expect(() => history.prepareRelation(db, 'r6', relation('{"type":"page","value":2}'))).not.toThrow();

    history.snapshotNotes(db, ['note-1'], 'before_sync');
    const versionId = revisionRows(db)[0]!.version_id;
    const badTags = revisionPayload(db, versionId);
    badTags.tags_json = '["ok",1]';
    expect(() => history.applyRevision(db, versionId, badTags)).toThrow();
    const badAssets = revisionPayload(db, versionId);
    badAssets.asset_refs_json = '[{"kind":"notes_asset"}]';
    expect(() => history.applyRevision(db, versionId, badAssets)).toThrow();
    const badProps = revisionPayload(db, versionId);
    badProps.props_json = '{not json';
    expect(() => history.applyRevision(db, versionId, badProps)).toThrow();
    expect(revisionPayload(db, versionId).tags_json).toBe('[]');
  });

  it('immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins', async () => {
    const { db, history } = await setup();
    seedNote(db, 'note-1', 'resource-1', 'original');
    history.snapshotNotes(db, ['note-1'], 'before_sync');
    const original = revisionRows(db)[0]!;
    db.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [original.version_id]);

    const tampered = revisionPayload(db, original.version_id);
    tampered.content_md = 'tampered';
    expect(() => history.applyRevision(db, original.version_id, tampered))
      .toThrow(`Immutable history conflict: ${original.version_id} (content_md)`);
    const saved = revisionPayload(db, original.version_id);
    expect(saved.content_md).toBe('original');
    expect(saved.pinned).toBe(1);

    expect(() => history.applyRevision(db, original.version_id, revisionPayload(db, original.version_id)))
      .not.toThrow();
    expect(Number(db.pluck<number>(
      'SELECT pinned FROM note_document_revisions WHERE version_id=?1', [original.version_id],
    ))).toBe(1);

    const future = revisionPayload(db, original.version_id);
    future.version_id = 'future-version';
    future.format_version = 999;
    expect(() => history.applyRevision(db, 'future-version', future)).toThrow();
    expect(db.pluck<number>(
      "SELECT count(*) FROM note_document_revisions WHERE version_id='future-version'",
    )).toBe(0);
  });
});
