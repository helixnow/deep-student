import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { malformedPropsTotal } from '../repository/props.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  await host.install(paths, vfsRepos, notes);
}, 120000);
afterAll(async () => { await host.dispose(); storage.dispose(); });

describe('L10-V2-08 history summaries and exact i64 sequence boundaries', () => {
  it('full_body_survives_resource_cleanup_and_copy_preserves_metadata exposes UTF-8 content_bytes through list/get/pin commands', async () => {
    const db = storage.database('vfs');
    const note = host.ctx.notes.repository.createNote({ title: 'summary byte length', content: '中🙂\n' }, db);
    const page = await host.invoke<{ items: Array<{ version_id: string; content_bytes: number; pinned: boolean }> }>(
      'notes_history_list', { noteId: note.id });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.content_bytes).toBe(8);
    expect(page.items[0]!.pinned).toBe(false);
    const versionId = page.items[0]!.version_id;
    expect(await host.invoke('notes_history_get', { noteId: note.id, versionId }))
      .toMatchObject({ content_md: '中🙂\n', content_bytes: 8, pinned: false });
    expect(await host.invoke('notes_history_set_pinned', { noteId: note.id, versionId, pinned: true }))
      .toEqual({ ...page.items[0], content_bytes: 8, pinned: true });
  });

  it('legacy_baseline_is_captured_before_first_write_and_pagination_is_stable preserves adjacent large seq cursors internally', async () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const revisions = host.ctx.notes.revisions;
    const note = repo.createNote({ title: 'large seq cursor', content: 'first' }, db);
    const firstId = revisions.list(db, note.id, null, 1).items[0]!.version_id;
    db.run('UPDATE note_document_revisions SET seq=?1 WHERE version_id=?2', [9007199254740992n, firstId]);
    repo.updateNote(note.id, { content: 'second' }, db);
    const page = revisions.list(db, note.id, null, 1);
    expect(page.next_cursor).toBe(9007199254740993n);
    expect(page.items[0]!.version_id).not.toBe(firstId);
    const next = revisions.list(db, note.id, page.next_cursor, 1);
    expect(next.items.map(item => item.version_id)).toEqual([firstId]);
    expect(next.next_cursor).toBeNull();
    // Rust/Tauri emits a JSON number. Only the boundary copy rounds the cursor.
    expect(await host.invoke('notes_history_list', { noteId: note.id, limit: 1 }))
      .toMatchObject({ next_cursor: 9007199254740992 });
    expect(revisions.list(db, note.id, null, 1).next_cursor).toBe(9007199254740993n);
  });

  it('current_restore_cas_preserves_live_and_source_and_restores_full_envelope keeps the precise before-restore high-water mark', async () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const revisions = host.ctx.notes.revisions;
    const note = repo.createNote({ title: 'large seq restore', content: 'original' }, db);
    const versionId = revisions.list(db, note.id, null, 1).items[0]!.version_id;
    const live = repo.updateNote(note.id, { content: 'live edit' }, db);
    const liveVersion = revisions.list(db, note.id, null, 1).items[0]!.version_id;
    // 2^53+3 rounds upward as Number: it would keep one intermediate snapshot.
    db.run('UPDATE note_document_revisions SET seq=?1 WHERE version_id=?2', [9007199254740995n, liveVersion]);
    await host.invoke('notes_history_restore_current', { noteId: note.id, versionId, expectedUpdatedAt: live.updatedAt });
    const history = revisions.list(db, note.id, null, 100).items;
    expect(history.map(item => item.version_id)).toContain(versionId);
    expect(history.map(item => item.version_id)).toContain(liveVersion);
    expect(history.filter(item => item.source === 'format_migration')).toHaveLength(0);
    expect(history.filter(item => item.source === 'restore_current')).toHaveLength(1);
    expect(repo.getNoteContent(note.id, db)).toBe('original');
    expect(revisions.get(db, note.id, liveVersion).content_md).toBe('live edit');
  });
});

describe('D005-02 history props keep serde_json arbitrary_precision Value numbers (dstu-vfs Cargo.toml:50)', () => {
  const setup = (title: string, propsJson: string | null) => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const revisions = host.ctx.notes.revisions;
    const note = repo.createNote({ title, content: 'source body' }, db);
    const versionId = revisions.list(db, note.id, null, 1).items[0]!.version_id;
    const live = repo.updateNote(note.id, { content: 'live body' }, db);
    // After the live edit: its snapshot dedupe reads only the latest revision.
    db.run('UPDATE note_document_revisions SET props_json=?1 WHERE version_id=?2', [propsJson, versionId]);
    return { db, note, versionId, live };
  };
  const state = (db: ReturnType<typeof storage.database>, noteId: string, versionId: string) => ({
    note: db.get('SELECT props, updated_at FROM notes WHERE id=?1', [noteId]),
    pinned: db.pluck('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId]),
    history: db.pluck('SELECT COUNT(*) FROM note_document_revisions WHERE note_id=?1', [noteId]),
  });

  it('current_restore_cas_preserves_live_and_source_and_restores_full_envelope persists props number text unrounded in notes and new history', async () => {
    // note_history_restore.rs:198-214 restores revision.props through update_note_metadata;
    // serde_json scan_decimal keeps digits, scan_exponent writes lowercase `e` and an explicit `+`.
    const stored = '{"big":9007199254740993,"neg":-9223372036854775809,"huge":1e400,"tiny":-1.5E-400,"dec":1.50,"e":2E5}';
    const persisted = '{"big":9007199254740993,"neg":-9223372036854775809,"huge":1e+400,"tiny":-1.5e-400,"dec":1.50,"e":2e+5}';
    const { db, note, versionId, live } = setup('exact history props', stored);
    // Live props written outside the JS number path must also survive the before_restore snapshot.
    db.run('UPDATE notes SET props=?1 WHERE id=?2', ['{"live":9007199254740993}', note.id]);
    host.events.length = 0;
    await host.invoke('notes_history_restore_current', { noteId: note.id, versionId, expectedUpdatedAt: live.updatedAt });
    expect(db.pluck('SELECT props FROM notes WHERE id=?1', [note.id])).toBe(persisted);
    // VfsNote serializes the same Value text to the frontend (arbitrary_precision writes it verbatim).
    const changed = host.events.find(event => event.event === `dstu:change:/${note.id}`);
    expect(changed?.payloadJson).toContain(`"props":${persisted}`);
    const rows = db.all<{ source: string; props_json: string | null; restored_from_version_id: string | null }>(
      `SELECT source, props_json, restored_from_version_id FROM note_document_revisions
       WHERE note_id=?1 AND source IN ('before_restore','restore_current') ORDER BY seq`, [note.id]);
    expect(rows).toEqual([
      { source: 'before_restore', props_json: '{"live":9007199254740993}', restored_from_version_id: null },
      { source: 'restore_current', props_json: persisted, restored_from_version_id: versionId },
    ]);
    expect(db.pluck('SELECT props_json FROM note_document_revisions WHERE version_id=?1', [versionId])).toBe(stored);
  });

  it('current_restore_cas_preserves_live_and_source_and_restores_full_envelope restore_copy keeps the same Value text', async () => {
    const { db, note, versionId } = setup('exact history copy', '{"big":9007199254740993}');
    const node = await host.invoke<{ id: string }>('notes_history_restore_copy', { noteId: note.id, versionId });
    expect(db.pluck('SELECT props FROM notes WHERE id=?1', [node.id])).toBe('{"big":9007199254740993}');
    expect(db.pluck("SELECT props_json FROM note_document_revisions WHERE note_id=?1 AND source='restore_copy'", [node.id]))
      .toBe('{"big":9007199254740993}');
  });

  it('current_restore_cas_preserves_live_and_source_and_restores_full_envelope restores SQL NULL props as None', async () => {
    const { db, note, versionId } = setup('null history props', null);
    const changed = host.ctx.notes.repository.updateNoteMetadata(note.id, { props: { a: 'changed' } }, db);
    await host.invoke('notes_history_restore_current', { noteId: note.id, versionId, expectedUpdatedAt: changed.updatedAt });
    expect(db.pluck('SELECT props FROM notes WHERE id=?1', [note.id])).toBeNull();
    expect(db.pluck("SELECT props_json FROM note_document_revisions WHERE note_id=?1 AND source='restore_current'", [note.id])).toBeNull();
  });

  it.each([
    // Some(Value::Null) is not the `None => json!({})` default.
    ['null', { error_type: 'Validation', message: 'props 必须是键值对象' }],
    ['{"n":{"deep":[1e400]}}', { error_type: 'Validation', message: '属性值只支持字符串、数字或布尔' }],
    ['{"n":1', { error_type: 'Database', message: 'Serialization error: EOF while parsing an object at line 1 column 6' }],
  ])('current_restore_cas_preserves_live_and_source_and_restores_full_envelope rejects stored props %s and rolls back', async (raw, expected) => {
    const { db, note, versionId, live } = setup('rejected history props', raw);
    const before = state(db, note.id, versionId);
    await expect(host.invoke('notes_history_restore_current', { noteId: note.id, versionId, expectedUpdatedAt: live.updatedAt }))
      .rejects.toMatchObject(expected);
    expect(state(db, note.id, versionId)).toEqual(before);
    expect(before.pinned).toBe(0);
  });
});

describe('WP-139 notes_history_get / notes_get keep serde_json arbitrary_precision props on the wire', () => {
  let invokeSeq = 0;
  const dispatch = (cmd: string, args: unknown) => host.runtime.dispatchInvoke(
    { id: `wp139-${++invokeSeq}`, cmd, args, source: { window: 'main', webview: 'main' } });
  const historySetup = (title: string, propsJson: string | null) => {
    const db = storage.database('vfs');
    const note = host.ctx.notes.repository.createNote({ title, content: 'history body' }, db);
    const versionId = host.ctx.notes.revisions.list(db, note.id, null, 1).items[0]!.version_id;
    db.run('UPDATE note_document_revisions SET props_json=?1 WHERE version_id=?2', [propsJson, versionId]);
    return { db, note, versionId };
  };

  it.each([
    // note_revision_repo.rs:305-309 `serde_json::from_str::<Value>` under arbitrary_precision;
    // NoteRevision.props serializes the stored number text (scan_exponent lowercases `e`, adds `+`).
    ['{"big":9007199254740993}', '{"big":9007199254740993}'],
    ['{"lo":9007199254740992,"hi":9007199254740994}', '{"lo":9007199254740992,"hi":9007199254740994}'],
    ['{"neg":-9223372036854775809,"huge":1e400,"tiny":-1.5E-400,"dec":1.50,"e":2E5}',
      '{"neg":-9223372036854775809,"huge":1e+400,"tiny":-1.5e-400,"dec":1.50,"e":2e+5}'],
    // get does not validate props: nested Values are returned as stored.
    ['{"n":{"deep":[1e400,9007199254740993]}}', '{"n":{"deep":[1e+400,9007199254740993]}}'],
    ['{"课程":"数学","priority":2,"done":false}', '{"课程":"数学","priority":2,"done":false}'],
  ])('full_body_survives_resource_cleanup_and_copy_preserves_metadata notes_history_get writes props %s as Rust number tokens', async (stored, wire) => {
    const { db, note, versionId } = historySetup('exact history get', stored);
    const outcome = await dispatch('notes_history_get', { noteId: note.id, versionId });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const value = outcome.value as Record<string, unknown>;
    // Full response text: NoteRevision field order (summary flatten, then content_md, tags, props, …).
    const marker = '"__wp139_props__"';
    const expected = JSON.stringify({ ...value, props: '__wp139_props__' }).replace(marker, wire);
    expect(outcome.json).toBe(expected);
    expect(Object.keys(value)).toEqual([
      'version_id', 'note_id', 'parent_version_id', 'restored_from_version_id', 'title', 'source', 'created_at',
      'pinned', 'content_bytes', 'content_md', 'tags', 'props', 'asset_refs', 'content_format', 'format_version',
      'serializer_version',
    ]);
    expect(value).toMatchObject({ version_id: versionId, note_id: note.id, content_md: 'history body', tags: [] });
    // Read-only preview: the stored cell is untouched and the version stays unpinned.
    expect(db.get('SELECT props_json, pinned FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toEqual({ props_json: stored, pinned: 0 });
  });

  it.each([
    // Option<Value>: SQL NULL is None, JSON text `null` is Some(Value::Null); both serialize as `null`.
    ['SQL NULL', null],
    ['JSON null', 'null'],
  ])('full_body_survives_resource_cleanup_and_copy_preserves_metadata notes_history_get serializes %s props as null', async (_label, stored) => {
    const { note, versionId } = historySetup('null history get', stored);
    const outcome = await dispatch('notes_history_get', { noteId: note.id, versionId });
    expect(outcome).toMatchObject({ kind: 'ok' });
    if (outcome.kind !== 'ok') return;
    const value = outcome.value as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(value, 'props')).toBe(true);
    expect(value.props).toBeNull();
    // No raw atom in the payload: the kernel sends the plain projection without a text body.
    expect(outcome.json).toBeUndefined();
  });

  it('full_body_survives_resource_cleanup_and_copy_preserves_metadata notes_history_get keeps the props serde error', async () => {
    const { note, versionId } = historySetup('bad history get', '{"n":1e400');
    const outcome = await dispatch('notes_history_get', { noteId: note.id, versionId });
    expect(outcome).toEqual({
      kind: 'err',
      error: { error_type: 'Database', message: 'Serialization error: EOF while parsing an object at line 1 column 10', details: null },
    });
  });

  it.each([
    // notes_manager.rs:2082-2092 vfs_note_to_note_item drops props; row_to_note still parses them.
    ['{"big":9007199254740993,"huge":1e400}', 0],
    ['{"n":{"deep":[1e400]}}', 0],
    [null, 0],
    ['null', 1],
  ])('parse_props_cell_accepts_nonempty_object_and_preserves_json_types notes_get with stored props %s returns NoteItem without props', async (stored, malformed) => {
    const db = storage.database('vfs');
    const note = host.ctx.notes.repository.createNote({ title: `note get props ${String(stored)}`, content: 'note body' }, db);
    db.run('UPDATE notes SET props=?1 WHERE id=?2', [stored, note.id]);
    const before = malformedPropsTotal();
    const outcome = await dispatch('notes_get', { id: note.id });
    expect(malformedPropsTotal() - before).toBe(malformed);
    expect(outcome).toEqual({
      kind: 'ok',
      value: {
        id: note.id, title: note.title, content_md: 'note body', tags: [],
        created_at: note.createdAt, updated_at: note.updatedAt, is_favorite: false,
      },
    });
    expect(db.pluck('SELECT props FROM notes WHERE id=?1', [note.id])).toBe(stored);
  });
});

describe('L10-V2-09 history Vec<String> serde boundary', () => {
  it.each([
    ['[1]', 'invalid type: integer `1`, expected a string at line 1 column 2'],
    ['[1.0]', 'invalid type: floating point `1.0`, expected a string at line 1 column 4'],
    ['[1e0]', 'invalid type: floating point `1.0`, expected a string at line 1 column 4'],
    ['[-0]', 'invalid type: floating point `-0.0`, expected a string at line 1 column 3'],
    ['[1] trailing', 'invalid type: integer `1`, expected a string at line 1 column 2'],
    ['[1,', 'invalid type: integer `1`, expected a string at line 1 column 2'],
    ['["中",false]', 'invalid type: boolean `false`, expected a string at line 1 column 12'],
    ['[null]', 'invalid type: null, expected a string at line 1 column 5'],
    ['"tags"', 'invalid type: string "tags", expected a sequence at line 1 column 6'],
    ['{"x":1}', 'invalid type: map, expected a sequence at line 1 column 0'],
    ['[["nested"]]', 'invalid type: sequence, expected a string at line 1 column 1'],
    ['["ok"] true', 'trailing characters at line 1 column 8'],
  ])('full_body_survives_resource_cleanup_and_copy_preserves_metadata rejects malformed stored tags through the real command: %s', async (raw, display) => {
    const db = storage.database('vfs');
    const note = host.ctx.notes.repository.createNote({ title: 'typed history tags', content: 'body' }, db);
    const versionId = host.ctx.notes.revisions.list(db, note.id, null, 1).items[0]!.version_id;
    // get() decodes tags before props and asset_refs (note_revision_repo.rs:303-311).
    // A later corrupt cell must not replace the first typed tags error.
    db.run('UPDATE note_document_revisions SET tags_json=?1,props_json=?2 WHERE version_id=?3', [raw, '{', versionId]);
    const expected = { error_type: 'Database', message: `Serialization error: ${display}`, details: null };
    await expect(host.invoke('notes_history_get', { noteId: note.id, versionId })).rejects.toEqual(expected);
    await expect(host.invoke('notes_history_set_pinned', { noteId: note.id, versionId, pinned: true })).rejects.toEqual(expected);
    expect(db.get('SELECT tags_json,props_json,pinned FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toEqual({ tags_json: raw, props_json: '{', pinned: 0 });
  });

  it.each(['[]', '["","中","dup","dup"]'])('full_body_survives_resource_cleanup_and_copy_preserves_metadata preserves valid stored tags without normalization: %s', async raw => {
    const db = storage.database('vfs');
    const tags = raw === '[]' ? [] : ['', '中', 'dup', 'dup'];
    const note = host.ctx.notes.repository.createNote({ title: 'valid typed history tags', content: 'body' }, db);
    const versionId = host.ctx.notes.revisions.list(db, note.id, null, 1).items[0]!.version_id;
    db.run('UPDATE note_document_revisions SET tags_json=?1 WHERE version_id=?2', [raw, versionId]);
    expect(await host.invoke('notes_history_get', { noteId: note.id, versionId })).toMatchObject({ tags });
    expect(db.pluck('SELECT tags_json FROM note_document_revisions WHERE version_id=?1', [versionId])).toBe(raw);
  });
});
