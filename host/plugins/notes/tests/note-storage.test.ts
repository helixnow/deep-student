import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteFormatRepository } from '../repository/format.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import { noteStateRepository as state } from '../repository/state.ts';
import { noteRelationRepository as relations } from '../repository/relations.ts';
import { noteTransferRepository as transfer } from '../repository/transfer.ts';
import { noteReviewRepository as review } from '../repository/review.ts';
import type { ReviewSaveRequest } from '../repository/review.ts';
import { blocks } from '../src/structure.ts';
import type { NoteRelationPut, TransferBlocksRequest } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';

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
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  const database = storage.database('vfs');
  for (const trigger of ['fail_receipt', 'fail_target_history', 'fail_review_receipt', 'fail_history', 'fail_restore']) {
    database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations;
    DELETE FROM note_transfer_operations;
    DELETE FROM note_review_save_receipts;
    DELETE FROM note_review_save_operations;
    DELETE FROM note_state;
    DELETE FROM note_editor_lease_acks;
    DELETE FROM note_editor_write_grants;
    DELETE FROM note_editor_lease_notes;
    DELETE FROM note_editor_leases;
    DELETE FROM note_editor_participants;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;`);
}, 30000);

function db(): SqlExecutor {
  return storage.database('vfs');
}

function block(id: string, body: string): string {
  return `<!-- ds:block-id=${id} -->\n\n${body}\n`;
}

function create(content: string, title = 'Storage test'): VfsNote {
  return noteRepository.createNote({ title, content, tags: [] }, db());
}

function request(
  source: VfsNote,
  target: VfsNote,
  sourceContent: string,
  targetContent: string,
): TransferBlocksRequest {
  return {
    operation_id: 'move-1',
    source_note_id: source.id,
    target_note_id: target.id,
    expected_source_updated_at: source.updatedAt,
    expected_target_updated_at: target.updatedAt,
    source_content: sourceContent,
    target_content: targetContent,
    block_ids: ['a'],
  };
}

function body(note: VfsNote): string {
  return noteRepository.getNoteContent(note.id, db()) ?? '';
}

describe('note_storage_tests', () => {
  it('stable_parser_rejects_partial_duplicate_and_nested_markers', () => {
    expect(blocks(block('a', '# Heading'))).toHaveLength(1);
    expect(blocks(block('a', '```md\n<!-- ds:block-id=fake -->\n```'))).toHaveLength(1);
    expect(() => blocks('```\n<!-- ds:block-id=a -->\n```\n')).toThrow();
    expect(() => blocks('> <!-- ds:block-id=a -->\n> body\n')).toThrow();
    expect(() => blocks(`${block('a', '# Heading')}\nunmarked`)).toThrow();
    expect(() => blocks(`${block('a', 'one')}\n${block('a', 'two')}`)).toThrow();
    expect(() => blocks('<!-- ds:block-id=a -->\n')).toThrow();
    expect(() => blocks(block('a', '[ref]: https://example.com'))).toThrow();
  });

  it('transfer_is_idempotent_and_undo_restores_exact_bytes_and_assets', () => {
    const moved = block('a', '![image](notes_assets/_global/source/image.png)');
    const remain = block('b', '# Remain');
    const targetBefore = block('c', 'Target');
    const sourceBefore = `${moved}\n${remain}`;
    const source = create(sourceBefore);
    const target = create(targetBefore);
    const req = request(source, target, remain, `${targetBefore}\n${moved}`);
    const receipt = transfer.transfer(db(), req);
    expect(body(source)).toBe(req.source_content);
    expect(body(target)).toBe(req.target_content);
    expect(transfer.transfer(db(), req)).toEqual(receipt);
    expect(() => transfer.transfer(db(), { ...req, block_ids: ['b'] })).toThrow();
    expect(revisions.assetIsReferenced(db(), 'notes_assets/_global/source/image.png')).toBe(true);
    const undone = transfer.undo(db(), req.operation_id, receipt.source_updated_at, receipt.target_updated_at);
    expect(undone.undone).toBe(true);
    expect(body(source)).toBe(sourceBefore);
    expect(body(target)).toBe(targetBefore);
    expect(transfer.undo(db(), req.operation_id, receipt.source_updated_at, receipt.target_updated_at)).toEqual(undone);
    expect(transfer.transfer(db(), req)).toEqual(undone);
  });

  it('transfer_rejects_body_tampering_and_target_occ_rolls_back_source', () => {
    const a = block('a', 'Original');
    const b = block('b', 'Retained');
    const c = block('c', 'Target');
    const source = create(`${a}\n${b}`);
    const target = create(c);
    let req = request(source, target, b, `${c}\n${a}`);
    req.target_content = req.target_content.replace('Original', 'Tampered');
    expect(() => transfer.transfer(db(), req)).toThrow();
    req.target_content = `${c}\n${a}`;
    req.source_content = b.replace('Retained', 'Hidden edit');
    expect(() => transfer.transfer(db(), req)).toThrow();
    req.source_content = b;
    req.expected_target_updated_at = 'stale';
    const count = Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count ?? 0);
    expect(() => transfer.transfer(db(), req)).toThrow();
    expect(noteRepository.getNote(source.id, db())!.updatedAt).toBe(source.updatedAt);
    expect(body(source)).toBe(`${a}\n${block('b', 'Retained')}`);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count ?? 0)).toBe(count);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_transfer_operations')?.count ?? 0)).toBe(0);
  });

  it('receipt_failure_rolls_back_both_pages_history_and_resource_cleanup', () => {
    const a = block('a', 'Image ![](notes_assets/_global/a/x.png)');
    const c = block('c', 'Target');
    const source = create(a);
    const target = create(c);
    db().exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON note_transfer_operations BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => transfer.transfer(db(), request(source, target, '', `${c}\n${a}`))).toThrow();
    for (const note of [source, target]) {
      const current = noteRepository.getNote(note.id, db())!;
      expect(current.resourceId).toBe(note.resourceId);
      expect(current.updatedAt).toBe(note.updatedAt);
    }
    expect(body(source)).toBe(a);
    expect(body(target)).toBe(c);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count ?? 0)).toBe(2);
  });

  it('undo_never_clobbers_a_later_edit_even_with_fresh_caller_tokens', () => {
    const a = block('a', 'Source');
    const c = block('c', 'Target');
    const source = create(a);
    const target = create(c);
    const receipt = transfer.transfer(db(), request(source, target, '', `${c}\n${a}`));
    const edited = noteRepository.updateNote(target.id, { content: block('c', 'Later edit') }, db());
    expect(() => transfer.undo(db(), 'move-1', receipt.source_updated_at, receipt.target_updated_at)).toThrow();
    expect(() => transfer.undo(db(), 'move-1', receipt.source_updated_at, edited.updatedAt)).toThrow();
    expect(body(source)).toBe('');
    expect(body(target)).toBe(block('c', 'Later edit'));
  });

  it('migration_is_explicit_lossless_and_baseline_is_retained', () => {
    const note = create('# Heading\n\nBody\n');
    const marked = '<!-- ds:block-id=a -->\n# Heading\n\n<!-- ds:block-id=b -->\nBody\n';
    expect(() => noteRepository.updateNote(note.id, { content: marked }, db())).toThrow();
    expect(() => noteFormatRepository.migrate(db(), note.id, note.updatedAt, marked.replace('Body', 'Changed'))).toThrow();
    const migrated = noteFormatRepository.migrate(db(), note.id, note.updatedAt, marked);
    const format = noteFormatRepository.get(db(), note.id);
    expect(format.content_format).toBe('markdown-blocks');
    expect(revisions.get(db(), note.id, format.baseline_version_id!).content_md).toBe('# Heading\n\nBody\n');
    expect(() => noteRepository.updateNote(note.id, { content: 'marker stripped' }, db())).toThrow();
    db().run('UPDATE note_document_formats SET format_version=99 WHERE note_id=?1', [note.id]);
    expect(() => noteRepository.updateNote(note.id, { content: marked }, db())).toThrow();
    expect(noteRepository.getNote(note.id, db())!.updatedAt).toBe(migrated.updatedAt);
  });

  it('per_entry_cas_and_tombstone_prevent_lost_reviews_and_aba', () => {
    const note = create('');
    const key = { note_id: note.id, type: 'review', key: 'review-a' } as const;
    const put = (expected: number | null) => ({ ...key, expected_revision: expected, value: { candidate: 'hello' } });
    const created = state.put(db(), put(null));
    expect(created.revision).toBe(1);
    expect(state.get(db(), key)!.revision).toBe(1);
    expect(() => state.put(db(), put(null))).toThrow();
    const updated = state.put(db(), put(1));
    expect(updated.revision).toBe(2);
    expect(() => state.put(db(), put(1))).toThrow();
    const deleted = state.delete(db(), { ...key, expected_revision: 2 });
    expect(deleted.revision).toBe(3);
    expect(deleted.deleted).toBe(true);
    expect(() => state.put(db(), put(null))).toThrow();
    expect(() => state.put(db(), put(1))).toThrow();
    expect(state.put(db(), put(3)).revision).toBe(4);
    state.put(db(), { ...key, key: 'review-b', expected_revision: null, value: 'independent' });
    expect(state.list(db(), { note_id: note.id, type: 'review', include_deleted: false })).toHaveLength(2);
  });

  it('relationships_follow_note_resource_replacement_and_invalidate_deleted_blocks', () => {
    const owner = create('');
    const target = create(block('a', 'Target'));
    const created = relations.put(db(), null, {
      id: 'relation-a', note_id: owner.id, block_id: null, type: 'source',
      resource_id: target.resourceId, locator: { type: 'block', value: 'a' },
      expected_revision: null,
    });
    expect(created.reference.locator_exists).toBe(true);
    const updated = noteRepository.updateNote(target.id, { content: block('a', 'Changed') }, db());
    const relation = relations.get(db(), null, 'relation-a')!;
    expect(relation.resource_id).toBe(updated.resourceId);
    expect(relation.invalidated_at).toBeNull();
    expect(relation.reference.locator_exists).toBe(true);
    expect(() => relations.delete(db(), 'relation-a', created.revision)).toThrow();
    noteRepository.updateNote(target.id, { content: '' }, db());
    const invalid = relations.get(db(), null, 'relation-a')!;
    expect(invalid.invalidated_at).not.toBeNull();
    expect(invalid.reference.locator_exists).toBe(false);
    expect(relations.delete(db(), 'relation-a', invalid.revision)).toBe(true);
  });

  it('contract_serializes_type_and_deserializes_flat_state_requests', async () => {
    const note = create('');
    const input = {
      note_id: note.id, type: 'review', key: 'review_a', expected_revision: null, value: { text: 'draft' },
    };
    const parsed = JSON.parse(JSON.stringify(input));
    expect(parsed.type).toBe('review');
    expect(state.put(db(), parsed).revision).toBe(1);
    expect(JSON.stringify({ type: 'page', value: 12 })).toBe('{"type":"page","value":12}');
    await expect(host.invoke('notes_state_get', {
      request: { note_id: 'a', type: 'future', key: 'x' },
    })).rejects.toBeTruthy();
  });

  it('anki_reference_uses_real_card_and_document_rows_and_observes_deletion', () => {
    const anki = storage.openFile(':memory:', { profile: 'plain' });
    try {
      anki.exec(`CREATE TABLE document_tasks(id TEXT PRIMARY KEY,document_id TEXT,deleted_at TEXT);
        CREATE TABLE anki_cards(id TEXT PRIMARY KEY,task_id TEXT,deleted_at TEXT);
        INSERT INTO document_tasks VALUES('task-a','document-a',NULL);
        INSERT INTO anki_cards VALUES('card-a','task-a',NULL);`);
      const owner = create('');
      const request: NoteRelationPut = {
        id: 'anki-relation', note_id: owner.id, block_id: null, type: 'card',
        resource_id: 'document-a', locator: { type: 'card', value: 'card-a' },
        expected_revision: null,
      };
      expect(relations.put(db(), anki, request).reference.locator_exists).toBe(true);
      expect(relations.referenceStatus(db(), anki, 'document-b', { type: 'card', value: 'card-a' } as const).locator_exists).toBe(false);
      anki.run("UPDATE anki_cards SET deleted_at='deleted' WHERE id='card-a'");
      const status = relations.get(db(), anki, 'anki-relation')!.reference;
      expect(status.resource_exists).toBe(true);
      expect(status.locator_exists).toBe(false);
      expect(relations.invalidateResource(db(), 'document-a')).toBe(1);
      expect(relations.get(db(), anki, 'anki-relation')!.invalidated_at).not.toBeNull();
    } finally {
      storage.close(anki);
    }
  });

  it('future_body_header_is_not_overwritten_even_when_format_metadata_is_legacy', () => {
    const note = create('old');
    db().run("UPDATE resources SET data='<!-- ds:note-schema=99 -->\nfuture document' WHERE id=?1", [note.resourceId]);
    expect(() => noteRepository.updateNote(note.id, { content: 'old client autosave' }, db())).toThrow();
    expect(body(note)).toContain('ds:note-schema=99');
  });

  it('second_page_history_failure_rolls_back_source_and_all_retention_changes', () => {
    const a = block('a', 'Move me');
    const c = block('c', 'Target');
    const source = create(a);
    const target = create(c);
    db().exec(`CREATE TRIGGER fail_target_history BEFORE INSERT ON note_document_revisions
      WHEN NEW.note_id='${target.id}' BEGIN SELECT RAISE(ABORT,'target history failed'); END`);
    expect(() => transfer.transfer(db(), request(source, target, '', `${c}\n${a}`))).toThrow();
    expect(body(source)).toBe(a);
    expect(body(target)).toBe(c);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count ?? 0)).toBe(2);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_transfer_operations')?.count ?? 0)).toBe(0);
  });
});

describe('note_review_tests', () => {
  it('save_as_create_and_update_retries_never_duplicate_or_clobber_a_newer_edit', () => {
    const source = create('original', 'Source');
    let request: ReviewSaveRequest = {
      operationId: 'review-op', sourceNoteId: source.id, markdown: 'first result',
      expectedUpdatedAt: null, capabilities: [],
    };
    const first = review.saveAs(db(), request);
    expect(review.saveAs(db(), request)).toEqual(first);
    const createRequest = { ...request };
    request = { ...request, markdown: 'second result' };
    expect(() => review.saveAs(db(), request)).toThrow();
    request = { ...request, expectedUpdatedAt: first.updatedAt };
    const second = review.saveAs(db(), request);
    expect(second.noteId).toBe(first.noteId);
    expect(second.revision).toBe(2);
    expect(review.saveAs(db(), request)).toEqual(second);
    expect(review.saveAs(db(), createRequest)).toEqual(first);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM notes')?.count ?? 0)).toBe(2);
    noteRepository.updateNote(second.noteId, {
      content: 'other WebView edit', expectedUpdatedAt: second.updatedAt,
    }, db());
    request = { ...request, markdown: 'stale candidate', expectedUpdatedAt: second.updatedAt };
    expect(() => review.saveAs(db(), request)).toThrow();
    expect(noteRepository.getNoteContent(first.noteId, db())).toBe('other WebView edit');
    expect(noteRepository.getNoteContent(source.id, db())).toBe('original');
  });

  it('save_as_revision_is_exact_i64_beyond_2_pow_53', () => {
    const source = create('original', 'Source');
    let request: ReviewSaveRequest = {
      operationId: 'review-i64', sourceNoteId: source.id, markdown: 'first result',
      expectedUpdatedAt: null, capabilities: [],
    };
    const first = review.saveAs(db(), request);
    db().run("UPDATE note_review_save_operations SET revision=9007199254740992 WHERE operation_id='review-i64'");
    request = { ...request, markdown: 'second result', expectedUpdatedAt: first.updatedAt };
    const second = review.saveAs(db(), request);
    expect(second.revision).toBe(9007199254740993n);
    expect(review.saveAs(db(), request).revision).toBe(9007199254740993n);
    expect(db().get<{ result_json: string }>(
      'SELECT result_json FROM note_review_save_receipts WHERE operation_id=?1 AND expected_updated_at=?2',
      ['review-i64', first.updatedAt])?.result_json).toContain('"revision":9007199254740993,');
    expect(review.saveAs(db(), { ...request, markdown: 'first result', expectedUpdatedAt: null }).revision).toBe(1);
  });

  it('save_as_receipt_failure_rolls_back_copy_folder_history_and_identity', () => {
    const source = create('original', 'Source');
    const request: ReviewSaveRequest = {
      operationId: 'failed-review', sourceNoteId: source.id, markdown: 'copy',
      expectedUpdatedAt: null, capabilities: [],
    };
    db().exec("CREATE TRIGGER fail_review_receipt BEFORE INSERT ON note_review_save_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
    expect(() => review.saveAs(db(), request)).toThrow();
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM notes')?.count ?? 0)).toBe(1);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_review_save_operations')?.count ?? 0)).toBe(0);
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM folder_items')?.count ?? 0)).toBe(0);
    // X6-AP-0357: note_review_tests.rs:122-124 removes the failure and retries
    // the same operation id, proving rollback did not leave a stale receipt/identity.
    db().exec('DROP TRIGGER fail_review_receipt');
    expect(() => review.saveAs(db(), request)).not.toThrow();
  });
});
