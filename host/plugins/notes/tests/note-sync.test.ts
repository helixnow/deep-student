import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NoteFormat, VfsNote } from '../api.ts';
import {
  isOperatorSearchableKey, malformedPropsTotal, parsePropsCell, snippet,
} from '../api.ts';
import { NoteDocumentError } from '../repository/errors.ts';
import { noteFormatRepository } from '../repository/format.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository } from '../repository/revisions.ts';
import { noteSyncRepository } from '../repository/sync.ts';

const I64_MAX = 9_223_372_036_854_775_807n;

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // R5 N4: real L11 vfsRepo wired by the production notes plugin, not a test copy of L11 SQL.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  storage.database('vfs').exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions; DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations; DELETE FROM note_links; DELETE FROM note_tags;
    DELETE FROM folder_items; DELETE FROM notes; DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log; DELETE FROM resources; PRAGMA foreign_keys=ON;`);
}, 30000);

function db(): SqlExecutor { return storage.database('vfs'); }

function create(content: string): VfsNote {
  return noteRepository.createNote({ title: '同步测试', content, tags: ['tag'] }, db());
}

function revisionPayload(versionId: string): Record<string, unknown> {
  const row = db().get<Record<string, unknown>>(
    'SELECT * FROM note_document_revisions WHERE version_id=?1', [versionId]);
  if (row === undefined) throw new Error('revision missing');
  const payload = { ...row };
  delete payload.seq;
  delete payload.edit_bucket;
  return payload;
}

function latestVersion(note: VfsNote): string {
  return noteRevisionRepository.list(db(), note.id, null, 1).items[0]!.version_id;
}

describe('notes.format.blocks', () => {
  it('returns the real root-block parse and preserves invalid errors', () => {
    const stable = noteFormatRepository.blocks!('<!-- ds:block-id=a -->\n\nParagraph\n');
    expect(stable).toEqual([{ id: 'a', body: 'Paragraph' }]);
    const detected = noteFormatRepository.detect('note-1', stable.map((block) =>
      `<!-- ds:block-id=${block.id} -->\n\n${block.body}`).join('\n\n'));
    expect(detected.content_format).toBe('markdown-blocks');
    expect(() => noteFormatRepository.blocks!('unmarked paragraph')).toThrow(NoteDocumentError);
    expect(() => noteFormatRepository.blocks!('unmarked\n\n<!-- ds:block-id=a -->\n\nbody'))
      .toThrow(NoteDocumentError);
  });
});

describe('notes.sync relation surface', () => {
  it('prepareRelation validates locator/type and rebuilds the local CAS revision', () => {
    const note = create('body');
    const payload: Record<string, unknown> = {
      note_id: note.id, relation_type: 'source', resource_id: 'target',
      locator_json: '{"type":"whole"}', revision: 77,
    };
    noteSyncRepository.prepareRelation(db(), 'relation', payload);
    expect(payload.revision).toBe(1);
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('relation',?1,'source','target','{"type":"whole"}',1,'now','now')`, [note.id]);
    noteSyncRepository.prepareRelation(db(), 'relation', payload);
    expect(payload.revision).toBe(2);

    for (const [locator, type] of [
      ['{"type":"block"}', 'source'],
      ['{"type":"page","value":-1}', 'source'],
      ['{"type":"page","value":4294967296}', 'source'],
      ['{"type":"other"}', 'source'],
      ['{"type":"whole"}', 'card'],
    ] as const) {
      expect(() => noteSyncRepository.prepareRelation(db(), 'bad', {
        relation_type: type, locator_json: locator,
      })).toThrow();
    }
    expect(() => noteSyncRepository.prepareRelation(db(), 'ok', {
      relation_type: 'mistake', locator_json: '{"type":"question","value":"q1"}',
    })).not.toThrow();
  });

  it('reads i64 relation revisions exactly instead of rounding through Number', () => {
    const note = create('body');
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('big',?1,'source','target','{"type":"whole"}',?2,'now','now')`,
    [note.id, 9_007_199_254_740_992n]);
    const payload: Record<string, unknown> = {
      relation_type: 'source', locator_json: '{"type":"whole"}',
    };
    noteSyncRepository.prepareRelation(db(), 'big', payload);
    expect(payload.revision).toBe(9_007_199_254_740_993n);

    db().run("UPDATE note_learning_relations SET revision=?1 WHERE id='big'", [I64_MAX]);
    expect(() => noteSyncRepository.prepareRelation(db(), 'big', {
      relation_type: 'source', locator_json: '{"type":"whole"}',
    })).toThrow('Relation revision exhausted');
  });

  it('retarget_note_relations updates non-card rows, bumps CAS and invalidates missing blocks', () => {
    const note = create('<!-- ds:block-id=present -->\n\nPresent\n');
    const other = create('target');
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,block_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('present',?1,'present','source','previous','{"type":"whole"}',1,'now','now')`, [note.id]);
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,block_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('missing',?1,'missing','source','previous','{"type":"whole"}',1,'now','now')`, [note.id]);
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,block_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('card',?1,NULL,'card','previous','{"type":"card","value":"c1"}',1,'now','now')`, [note.id]);
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,block_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('target-missing',?1,NULL,'source',?2,'{"type":"block","value":"gone"}',1,'now','now')`,
    [other.id, note.resourceId]);

    noteSyncRepository.retargetNoteRelations(db(), note.id, 'previous');

    expect(db().pluck<string>("SELECT resource_id FROM note_learning_relations WHERE id='present'"))
      .toBe(note.resourceId);
    expect(db().pluck<string>("SELECT resource_id FROM note_learning_relations WHERE id='card'"))
      .toBe('previous');
    expect(db().pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='present'"))
      .toBeNull();
    expect(db().pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='missing'"))
      .not.toBeNull();
    expect(db().pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='target-missing'"))
      .not.toBeNull();
    expect(Number(db().pluck<number>("SELECT revision FROM note_learning_relations WHERE id='present'")))
      .toBe(2);
    expect(Number(db().pluck<number>("SELECT revision FROM note_learning_relations WHERE id='missing'")))
      .toBe(3);
  });

  it('retarget_note_relations treats parser errors as an empty block set', () => {
    const note = create('<!-- ds:block-id=present -->\n\nPresent\n');
    db().run(`INSERT INTO note_learning_relations
      (id,note_id,block_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('present',?1,'present','source',?2,'{"type":"whole"}',1,'now','now')`,
    [note.id, note.resourceId]);
    db().run('UPDATE resources SET data=?1 WHERE id=?2', ['unmarked body', note.resourceId]);
    expect(() => noteSyncRepository.retargetNoteRelations(db(), note.id, note.resourceId)).not.toThrow();
    expect(db().pluck<string | null>("SELECT invalidated_at FROM note_learning_relations WHERE id='present'"))
      .not.toBeNull();
  });
});

describe('notes.sync history surface', () => {
  it('apply_revision inserts normalized rows and validates envelope + JSON', () => {
    const note = create('original');
    const versionId = latestVersion(note);
    const base = revisionPayload(versionId);
    const payload = { ...base };
    db().run('DELETE FROM note_document_revisions WHERE version_id=?1', [versionId]);

    payload.pinned = 1;
    noteSyncRepository.applyRevision(db(), versionId, payload);
    const inserted = db().get<{ pinned: number; edit_bucket: number; content_md: string }>(
      'SELECT pinned,edit_bucket,content_md FROM note_document_revisions WHERE version_id=?1', [versionId])!;
    expect(inserted.pinned).toBe(1);
    expect(inserted.edit_bucket).toBe(0);
    expect(inserted.content_md).toBe('original');

    const missing = { ...revisionPayload(versionId) };
    delete missing.title;
    expect(() => noteSyncRepository.applyRevision(db(), versionId, missing)).toThrow();
    const identity = revisionPayload(versionId);
    identity.version_id = 'other';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, identity)).toThrow();
    const future = revisionPayload(versionId);
    future.format_version = 999;
    expect(() => noteSyncRepository.applyRevision(db(), versionId, future)).toThrow();

    db().run('DELETE FROM note_document_revisions WHERE version_id=?1', [versionId]);
    const badTags = { ...base };
    badTags.tags_json = '["ok",1]';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, badTags)).toThrow();
    const badAssets = { ...base };
    badAssets.asset_refs_json = '[{"kind":"notes_asset"}]';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, badAssets)).toThrow();
    const badProps = { ...base };
    badProps.props_json = '{not json';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, badProps)).toThrow();
    expect(db().pluck<number>('SELECT COUNT(*) FROM note_document_revisions')).toBe(0);
  });

  it('apply_revision rejects immutable conflicts and only upgrades pins', () => {
    const note = create('original');
    const versionId = latestVersion(note);
    db().run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [versionId]);

    const tampered = revisionPayload(versionId);
    tampered.content_md = 'tampered';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, tampered))
      .toThrow(`Immutable history conflict: ${versionId} (content_md)`);
    expect(db().pluck<string>('SELECT content_md FROM note_document_revisions WHERE version_id=?1', [versionId]))
      .toBe('original');

    const unpinned = revisionPayload(versionId);
    unpinned.pinned = 0;
    noteSyncRepository.applyRevision(db(), versionId, unpinned);
    expect(Number(db().pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId])))
      .toBe(1);
    db().run('UPDATE note_document_revisions SET pinned=0 WHERE version_id=?1', [versionId]);
    const pinned = revisionPayload(versionId);
    pinned.pinned = true;
    noteSyncRepository.applyRevision(db(), versionId, pinned);
    expect(Number(db().pluck<number>('SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId])))
      .toBe(1);
  });

  it('apply_revision compares *_json columns by parsed value', () => {
    const note = create('original');
    const versionId = latestVersion(note);
    const payload = revisionPayload(versionId);
    payload.tags_json = '[ "tag" ]';
    expect(() => noteSyncRepository.applyRevision(db(), versionId, payload)).not.toThrow();
  });

  it('apply_revision preserves large JSON integers and rolls back caller transactions', () => {
    const note = create('original');
    const versionId = latestVersion(note);
    const localProps = '{"nested":{"n":9007199254740992},"other":1}';
    db().run('UPDATE note_document_revisions SET props_json=?1 WHERE version_id=?2',
      [localProps, versionId]);
    const original = revisionPayload(versionId);

    expect(() => noteSyncRepository.applyRevision(db(), versionId, {
      ...original, props_json: '{"other":1,"nested":{"n":9007199254740992}}',
    })).not.toThrow();
    expect(() => noteSyncRepository.applyRevision(db(), versionId, {
      ...original, props_json: '{"nested":{"n":9007199254740993},"other":1}',
    })).toThrow(`Immutable history conflict: ${versionId} (props_json)`);
    expect(db().pluck<string>('SELECT props_json FROM note_document_revisions WHERE version_id=?1',
      [versionId])).toBe(localProps);

    db().run('UPDATE note_document_revisions SET pinned=0 WHERE version_id=?1', [versionId]);
    expect(() => storage.database('vfs').transaction((tx) => {
      const pinned = revisionPayload(versionId);
      pinned.pinned = 1;
      noteSyncRepository.applyRevision(tx, versionId, pinned);
      throw new Error('rollback pin upgrade');
    })).toThrow('rollback pin upgrade');
    expect(Number(db().pluck<number>(
      'SELECT pinned FROM note_document_revisions WHERE version_id=?1', [versionId]))).toBe(0);

    db().run('DELETE FROM note_document_revisions WHERE version_id=?1', [versionId]);
    noteSyncRepository.applyRevision(db(), versionId, {
      ...original, props_json: '{"nested":{"n":9007199254740993},"other":1}',
    });
    expect(db().pluck<string>('SELECT props_json FROM note_document_revisions WHERE version_id=?1',
      [versionId])).toBe('{"nested":{"n":9007199254740993},"other":1}');
  });

  it('apply_revision compares INTEGER history columns beyond 2^53 exactly (S03)', () => {
    const note = create('original');
    const versionId = latestVersion(note);
    db().exec('ALTER TABLE note_document_revisions ADD COLUMN content_bytes INTEGER');
    db().run('UPDATE note_document_revisions SET content_bytes=?1 WHERE version_id=?2',
      [9_007_199_254_740_993n, versionId]);
    const replay = { ...revisionPayload(versionId), content_bytes: 9_007_199_254_740_993n };
    expect(() => noteSyncRepository.applyRevision(db(), versionId, replay)).not.toThrow();
    expect(() => noteSyncRepository.applyRevision(db(), versionId, {
      ...replay, content_bytes: 9_007_199_254_740_992n,
    })).toThrow(`Immutable history conflict: ${versionId} (content_bytes)`);
  });

  it('update_inferred_format persists body metadata and clears updated_at', () => {
    const note = create('legacy body');
    const before = db().get<NoteFormat & { updated_at: string }>(
      'SELECT content_format,format_version,serializer_version,baseline_version_id,updated_at FROM note_document_formats WHERE note_id=?1',
      [note.id])!;
    expect(before.content_format).toBe('markdown-legacy');
    db().run('UPDATE resources SET data=?1 WHERE id=?2', [
      '<!-- ds:block-id=a -->\n\nParagraph\n', note.resourceId]);

    const detected = noteSyncRepository.updateInferredFormat(db(), note.id);
    const after = db().get<NoteFormat & { updated_at: string }>(
      'SELECT content_format,format_version,serializer_version,baseline_version_id,updated_at FROM note_document_formats WHERE note_id=?1',
      [note.id])!;
    expect(detected.content_format).toBe('markdown-blocks');
    expect(after.content_format).toBe('markdown-blocks');
    expect(after.updated_at).toBe('');
    expect(after.baseline_version_id).toBe(before.baseline_version_id);
  });

  it('update_inferred_format preserves an explicit ds-columns capability', () => {
    const note = create('<!-- ds:block-id=a -->\n\nParagraph\n');
    db().run("UPDATE note_document_formats SET serializer_version='blocks-v1+ds-columns-v1' WHERE note_id=?1",
      [note.id]);
    db().run('UPDATE resources SET data=?1 WHERE id=?2', ['legacy body', note.resourceId]);
    noteSyncRepository.updateInferredFormat(db(), note.id);
    const after = db().get<{ content_format: string; serializer_version: string; updated_at: string }>(
      'SELECT content_format,serializer_version,updated_at FROM note_document_formats WHERE note_id=?1',
      [note.id])!;
    expect(after.content_format).toBe('markdown-legacy');
    expect(after.serializer_version).toBe('markdown-v1+ds-columns-v1');
    expect(after.updated_at).toBe('');
  });
});

describe('note props public diagnostics', () => {
  it('operator syntax covers the shared key vectors but admits storable gaps', () => {
    for (const key of ['status', 'Status', '优先级', 'due_date', 'sprint-42', 'p0', '_internal', 'k']) {
      expect(isOperatorSearchableKey(key)).toBe(true);
    }
    for (const key of ['my key', 'a:b', 'emoji🙂', '-lead', '得 分', '']) {
      expect(isOperatorSearchableKey(key)).toBe(false);
    }
  });

  it('parsePropsCell is silent for SQL NULL and counts each malformed shape', () => {
    const before = malformedPropsTotal();
    expect(parsePropsCell('note-null', null)).toBeNull();
    expect(parsePropsCell('note-null', undefined)).toBeNull();
    expect(malformedPropsTotal()).toBe(before);
    expect(parsePropsCell('note', '{not json')).toBeNull();
    expect(parsePropsCell('note', '[1,2]')).toBeNull();
    expect(parsePropsCell('note', '{}')).toBeNull();
    expect(malformedPropsTotal()).toBe(before + 3);
    expect(parsePropsCell('note', '{"status":"done","n":2,"ok":true}'))
      .toEqual({ status: 'done', n: 2, ok: true });
    expect(malformedPropsTotal()).toBe(before + 3);
  });

  it('snippet truncates on a character boundary and keeps short values verbatim', () => {
    expect(snippet('short')).toBe('short');
    const long = '微'.repeat(119) + '🙂' + 'tail';
    const cut = snippet(long);
    expect(cut.endsWith('…')).toBe(true);
    expect([...cut.slice(0, -1)]).toHaveLength(120);
    expect(cut).toBe(`${'微'.repeat(119)}🙂…`);
  });
});
