import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteFormatRepository, COLUMNS_CAPABILITY } from '../repository/format.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import { noteTransferRepository as transfer } from '../repository/transfer.ts';
import { blocks, roots } from '../src/structure.ts';
import type { VfsNote } from '../api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

const COLUMNS = ':::ds-columns{version=1 layout=cornell}\n\n:::column\n\n## Cues\n\nQuestion\n\n:::end-column\n\n:::column\n\n## Notes\n\nAnswer\n\n:::end-column\n\n:::end-ds-columns\n';

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
  const database = storage.database('vfs');
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions; DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations; DELETE FROM note_links; DELETE FROM note_tags;
    DELETE FROM folder_items; DELETE FROM notes; DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log; DELETE FROM resources; PRAGMA foreign_keys=ON;`);
}, 30000);

function db() { return storage.database('vfs'); }
function create(content: string): VfsNote {
  return noteRepository.createNote({ title: 'Columns', content, tags: [] }, db());
}

describe('note_columns_tests', () => {
  it('columns_are_one_root_node_and_fenced_escaped_quoted_examples_are_literals', () => {
    const parsed = roots(`${COLUMNS}\n## Summary\n\nFull width\n`);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.columns).toBe(true);
    const stable = `<!-- ds:block-id=cols -->\n\n${COLUMNS}`;
    const stableBlocks = blocks(stable);
    expect(stableBlocks).toHaveLength(1);
    expect(stableBlocks[0]!.id).toBe('cols');
    expect(stableBlocks[0]!.body.endsWith(':::end-ds-columns')).toBe(true);
    for (const literal of [
      `\`\`\`md\n${COLUMNS}\`\`\`\n`,
      '\\:::ds-columns{version=99 layout=equal}\n',
      '> :::ds-columns{version=99 layout=equal}\n',
    ]) {
      expect(roots(literal).every((root) => !root.columns)).toBe(true);
    }
    for (const malformed of [
      COLUMNS.replace('version=1', 'version=99'),
      COLUMNS.replace(':::end-ds-columns\n', ''),
      COLUMNS.replace(':::column\n\n## Notes', ':::ds-columns{version=1 layout=equal}\n\n## Notes'),
      COLUMNS.replace(':::end-ds-columns', ':::column\n\nthird\n\n:::end-column\n\n:::end-ds-columns'),
    ]) {
      expect(() => roots(malformed)).toThrow();
    }
  });

  it('enabling_columns_is_lossless_pins_baseline_and_demands_capable_cas_saves', () => {
    const note = create('Original\n');
    const initial = revisions.list(db(), note.id, null, 1).items[0]!.version_id;
    expect(() => noteRepository.updateNoteWithCapabilities(db(), note.id, {
      content: COLUMNS, expectedUpdatedAt: note.updatedAt,
    }, [COLUMNS_CAPABILITY])).toThrow();
    const enabled = noteFormatRepository.enableColumns(db(), note.id, note.updatedAt);
    expect(enabled.updatedAt).not.toBe(note.updatedAt);
    expect(noteRepository.getNoteContent(note.id, db())).toBe('Original\n');
    const format = noteFormatRepository.get(db(), note.id);
    expect(format.serializer_version).toBe('markdown-v1+ds-columns-v1');
    expect(format.baseline_version_id).toBe(initial);
    expect(revisions.get(db(), note.id, initial).pinned).toBe(true);
    expect(() => noteRepository.updateNote(note.id, {
      content: 'legacy clobber', expectedUpdatedAt: enabled.updatedAt,
    }, db())).toThrow();
    expect(() => noteRepository.updateNoteWithCapabilities(db(), note.id, {
      content: COLUMNS, expectedUpdatedAt: note.updatedAt,
    }, [COLUMNS_CAPABILITY])).toThrow();
    const saved = noteRepository.updateNoteWithCapabilities(db(), note.id, {
      content: COLUMNS, expectedUpdatedAt: enabled.updatedAt,
    }, [COLUMNS_CAPABILITY]);
    expect(saved.id).toBe(note.id);
    expect(noteRepository.getNoteContent(note.id, db())).toBe(COLUMNS);
  });

  it('stable_columns_transfer_requires_both_page_optins_and_moves_entire_container_atomically', () => {
    const source = create(COLUMNS);
    const marked = `<!-- ds:block-id=cols -->\n${COLUMNS}`;
    const migratedSource = noteFormatRepository.migrate(db(), source.id, source.updatedAt, marked);
    expect(noteFormatRepository.get(db(), source.id).serializer_version).toBe('blocks-v1+ds-columns-v1');
    const target = create('');
    const migratedTarget = noteFormatRepository.migrate(db(), target.id, target.updatedAt, '');
    const request = {
      operation_id: 'columns-move',
      source_note_id: migratedSource.id,
      target_note_id: migratedTarget.id,
      expected_source_updated_at: migratedSource.updatedAt,
      expected_target_updated_at: migratedTarget.updatedAt,
      source_content: '',
      target_content: marked,
      block_ids: ['cols'],
    };
    expect(() => transfer.transfer(db(), request)).toThrow();
    expect(noteRepository.getNoteContent(source.id, db())).toBe(marked);
    const enabled = noteFormatRepository.enableColumns(db(), target.id, migratedTarget.updatedAt);
    const updated = { ...request, expected_target_updated_at: enabled.updatedAt };
    expect(() => transfer.transfer(db(), {
      ...updated, target_content: updated.target_content.replace('Answer', 'Edited during move'),
    })).toThrow();
    const moved = transfer.transfer(db(), updated);
    expect(noteRepository.getNoteContent(source.id, db())).toBe('');
    expect(noteRepository.getNoteContent(target.id, db())).toBe(marked);
    transfer.undo(db(), 'columns-move', moved.source_updated_at, moved.target_updated_at);
    expect(noteRepository.getNoteContent(source.id, db())).toBe(marked);
  });

  it('history_selection_cannot_cut_column_containers_and_full_restore_preserves_capability', () => {
    const note = create(COLUMNS);
    const version = revisions.list(db(), note.id, null, 1).items[0]!.version_id;
    expect(() => revisions.restoreSelectionCopy(db(), note.id, version, { start_line: 5, end_line: 7 })).toThrow();
    const copy = revisions.restoreCopy(db(), note.id, version);
    expect(noteRepository.getNoteContent(copy.id, db())).toBe(COLUMNS);
    expect(noteFormatRepository.get(db(), copy.id).serializer_version).toBe('markdown-v1+ds-columns-v1');
  });
});
