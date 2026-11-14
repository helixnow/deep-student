// note_format_repo.rs: stable block format v1 with root-level HTML markers.
import type { NoteFormat } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { NoteDocumentError, invalid } from './errors.ts';
import { blocks as parseBlocks, marker, roots, type StableBlock } from '../src/structure.ts';
import { noteRepository } from './notes.ts';
import { noteRevisionRepository } from './revisions.ts';
import { rustTrimStart } from '../../../platform/util/index.ts';

export const COLUMNS_CAPABILITY = 'ds-columns-v1';

function format(row: {
  content_format: string; format_version: number; serializer_version: string; baseline_version_id: string | null;
}, noteId: string): NoteFormat {
  return {
    note_id: noteId,
    content_format: row.content_format,
    format_version: row.format_version,
    serializer_version: row.serializer_version,
    baseline_version_id: row.baseline_version_id,
  };
}

export const noteFormatRepository = {
  get(conn: SqlExecutor, noteId: string): NoteFormat {
    const stored = conn.get<{
      content_format: string; format_version: number; serializer_version: string; baseline_version_id: string | null;
    }>('SELECT content_format, format_version, serializer_version, baseline_version_id FROM note_document_formats WHERE note_id=?1', [noteId]);
    if (stored !== undefined) return format(stored, noteId);
    // History and restore copies also read trashed legacy pages lacking a format row.
    const content = conn.get<{ data: string }>(
      'SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1', [noteId])?.data;
    if (content === undefined) invalid('Note not found');
    return this.detect(noteId, content);
  },

  blocks(content: string): StableBlock[] {
    return parseBlocks(content);
  },

  detect(noteId: string, content: string): NoteFormat {
    const ranges = roots(content);
    if (ranges.some((range) => rustTrimStart(content.slice(range.start, range.end)).startsWith('<!-- ds:')
      && marker(content.slice(range.start, range.end)) === null)) {
      invalid('Unsupported note schema/marker; open with a compatible editor');
    }
    const stable = ranges.some((range) => marker(content.slice(range.start, range.end)) !== null);
    const columns = ranges.some((range) => range.columns);
    if (stable) parseBlocks(content);
    return {
      note_id: noteId,
      content_format: stable ? 'markdown-blocks' : 'markdown-legacy',
      format_version: 1,
      serializer_version: this.serializer(stable, columns),
      baseline_version_id: null,
    };
  },

  insert(conn: SqlExecutor, value: NoteFormat): void {
    conn.run("INSERT INTO note_document_formats(note_id,content_format,format_version,serializer_version,baseline_version_id,updated_at) VALUES(?1,?2,?3,?4,?5,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(note_id) DO UPDATE SET content_format=excluded.content_format,format_version=excluded.format_version,serializer_version=excluded.serializer_version,baseline_version_id=excluded.baseline_version_id,updated_at=excluded.updated_at",
      [value.note_id, value.content_format, value.format_version, value.serializer_version, value.baseline_version_id]);
  },

  ensureSupported(value: NoteFormat): void {
    if (value.format_version !== 1
      || (value.content_format !== 'markdown-legacy' && value.content_format !== 'markdown-blocks')
      || ![this.serializer(value.content_format === 'markdown-blocks', false),
        this.serializer(value.content_format === 'markdown-blocks', true)].includes(value.serializer_version)) {
      invalid('Unsupported future note format; write refused');
    }
  },

  validateWrite(conn: SqlExecutor, id: string, content: string): void {
    this.validateWriteCapabilities(conn, id, content, []);
  },

  serializer(stable: boolean, columns: boolean): string {
    return `${stable ? 'blocks-v1' : 'markdown-v1'}${columns ? '+ds-columns-v1' : ''}`;
  },

  requiredCapabilities(value: NoteFormat): string[] {
    return value.serializer_version.endsWith('+ds-columns-v1') ? [COLUMNS_CAPABILITY] : [];
  },

  validateWriteCapabilities(conn: SqlExecutor, id: string, content: string, capabilities: readonly string[]): void {
    const stored = this.get(conn, id);
    this.ensureSupported(stored);
    // Check the stored body too: sync/import may have changed the envelope.
    const old = noteRepository.getNoteContent(id, conn);
    if (old === null) invalid('Note missing');
    const oldDetected = this.detect(id, old);
    const proposed = this.detect(id, content);
    const enabled = this.requiredCapabilities(stored).length > 0;
    if (enabled && !capabilities.includes(COLUMNS_CAPABILITY)) {
      invalid('This page requires the ds-columns-v1 writer capability');
    }
    if (!enabled && (this.requiredCapabilities(proposed).length > 0 || this.requiredCapabilities(oldDetected).length > 0)) {
      invalid('Enable ds-columns-v1 explicitly with notes_enable_columns before saving');
    }
    if (stored.content_format === 'markdown-blocks') {
      parseBlocks(content);
    } else if (proposed.content_format === 'markdown-blocks') {
      invalid('Use notes_migrate_blocks to upgrade this page explicitly');
    }
  },

  migrate(conn: SqlExecutor, id: string, expected: string, content: string) {
    return noteRevisionRepository.transaction(conn, () => {
      const current = noteRepository.getNote(id, conn);
      if (current === null) invalid('Note missing');
      if (current.updatedAt !== expected) throw formatConflict('notes.conflict');
      const stored = this.get(conn, id);
      this.ensureSupported(stored);
      if (stored.content_format !== 'markdown-legacy') invalid('Page already uses stable blocks');
      parseBlocks(content);
      let stripped = '';
      let cursor = 0;
      for (const root of roots(content)) {
        if (marker(content.slice(root.start, root.end)) !== null) {
          stripped += content.slice(cursor, root.start);
          cursor = root.end;
        }
      }
      stripped += content.slice(cursor);
      const old = noteRepository.getNoteContent(id, conn);
      if (old === null) invalid('Note missing');
      if (stripped !== old) invalid('Migration may only insert root block markers, not change content');
      const baseline = noteRevisionRepository.snapshot(conn, id, 'format_baseline');
      return noteRepository.updateNoteWithFormat(conn, id, {
        content, expectedUpdatedAt: expected,
      }, {
        ...stored,
        content_format: 'markdown-blocks',
        serializer_version: this.serializer(true, this.requiredCapabilities(stored).length > 0),
        baseline_version_id: baseline,
      });
    });
  },

  enableColumns(conn: SqlExecutor, id: string, expected: string) {
    return noteRevisionRepository.transaction(conn, () => {
      const current = noteRepository.getNote(id, conn);
      if (current === null) invalid('Note missing');
      if (current.updatedAt !== expected) throw formatConflict('notes.conflict');
      const stored = this.get(conn, id);
      this.ensureSupported(stored);
      const content = noteRepository.getNoteContent(id, conn);
      if (content === null) invalid('Note missing');
      this.detect(id, content);
      if (this.requiredCapabilities(stored).length > 0) return current;
      const baseline = noteRevisionRepository.snapshot(conn, id, 'format_baseline');
      noteRevisionRepository.setPinned(conn, id, baseline, true);
      const updated = {
        ...stored,
        baseline_version_id: stored.baseline_version_id ?? baseline,
        serializer_version: this.serializer(stored.content_format === 'markdown-blocks', true),
      };
      return noteRepository.updateNoteWithFormat(conn, id, {
        content, expectedUpdatedAt: expected,
      }, updated);
    });
  },
};

function formatConflict(key: string): never {
  throw new NoteDocumentError('conflict', 'Stored revision changed; reload before retrying', key);
}
