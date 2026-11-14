/** note_history.rs orchestration. L10 owns all note/relation/history writes (D1/D4). */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NotesService, NoteFormat, NoteSyncRepository } from '../../notes/api.ts';
import type { NoteHistorySupport } from '../../sync-support/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { SyncError } from '../src/errors.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { isJsonObject } from '../../../platform/util/lossless-json.ts';
import type { NoteHistoryHooks } from './apply.ts';
import { tableHasColumn } from './change-log.ts';

type NoteHistoryReader = Pick<NoteHistorySupport, 'available' | 'affectedNotes'>;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function databaseError(detail: string): never { throw new SyncError(`Database error: ${detail}`); }
function wrap<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof SyncError) throw error;
    databaseError(message(error));
  }
}
function syncOwner(notes: NotesService): NoteSyncRepository {
  if (notes.sync === undefined) databaseError('note sync repository unavailable (notes.sync)');
  return notes.sync;
}
function detectFormat(notes: NotesService, noteId: string, content: string): NoteFormat {
  return wrap(() => notes.format.detect(noteId, content));
}
function ensureSupported(notes: NotesService, format: NoteFormat): void { wrap(() => notes.format.ensureSupported(format)); }
function parseFormat(data: DbJson): NoteFormat {
  if (!isJsonObject(data)) databaseError('Missing note format envelope');
  const noteId = data.note_id, contentFormat = data.content_format, formatVersion = data.format_version, serializer = data.serializer_version;
  if (typeof noteId !== 'string') databaseError('Note format identity mismatch');
  if (typeof contentFormat !== 'string') databaseError('Missing note format envelope');
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) databaseError('Missing note format envelope');
  if (typeof serializer !== 'string') databaseError('Missing note format envelope');
  return { note_id: noteId, content_format: contentFormat, format_version: formatVersion,
    serializer_version: serializer, baseline_version_id: typeof data.baseline_version_id === 'string' ? data.baseline_version_id : null };
}
function validateBatchFormatsImpl(notes: NotesService, changes: readonly EngineChange[]): void {
  for (const change of changes) {
    if (change.table_name !== 'note_document_formats' || change.operation === 'Delete') continue;
    if (change.data === null) databaseError('Missing note format envelope');
    const format = parseFormat(change.data); ensureSupported(notes, format);
    if (format.note_id !== change.record_id) databaseError('Note format identity mismatch');
    const note = changes.find(item => item.table_name === 'notes' && item.record_id === format.note_id)?.data;
    const resourceId = note != null && isJsonObject(note) ? note.resource_id : null;
    const body = typeof resourceId === 'string' ? changes.find(item => item.table_name === 'resources' && item.record_id === resourceId)?.data : null;
    const content = body != null && isJsonObject(body) ? body.data : null;
    if (typeof content === 'string') {
      const detected = detectFormat(notes, format.note_id, content);
      const detectedCapabilities = wrap(() => notes.format.requiredCapabilities(detected));
      const capabilities = wrap(() => notes.format.requiredCapabilities(format));
      if (detected.content_format !== format.content_format || (detectedCapabilities.length > 0 && capabilities.length === 0)) databaseError('Note format/body capability mismatch');
    }
  }
}
function validateIncomingImpl(notes: NotesService, reader: NoteHistoryReader, db: SqlExecutor, table: string, id: string, data: DbJson): void {
  if (!wrap(() => reader.available(db))) return;
  if (table === 'note_document_formats') ensureSupported(notes, parseFormat(data));
  if (table === 'resources') {
    let affected: string[] = [];
    if ((isJsonObject(data) && data.type === 'note') || wrap(() => reader.affectedNotes(db, table, id)).length > 0) {
      const content = isJsonObject(data) ? data.data : null;
      if (typeof content === 'string') detectFormat(notes, id, content);
      affected = wrap(() => reader.affectedNotes(db, table, id));
    }
    for (const note of affected) ensureSupported(notes, wrap(() => notes.format.get(db, note)));
    return;
  }
  for (const note of wrap(() => reader.affectedNotes(db, table, id))) ensureSupported(notes, wrap(() => notes.format.get(db, note)));
}
function snapshotNotesImpl(notes: NotesService, db: SqlExecutor, ids: readonly string[], source: string): void {
  for (const id of ids) {
    if (source === 'remote_sync') wrap(() => syncOwner(notes).updateInferredFormat(db, id));
    const version = wrap(() => notes.revisions.snapshot(db, id, source));
    if (source === 'before_sync') wrap(() => notes.revisions.setPinned(db, id, version, true));
  }
}
/** Hooks receive the caller's transaction, never a separately opened connection. */
export function createNoteHistoryHooks(
  notes: NotesService | (() => NotesService | undefined),
  reader: () => NoteHistoryReader,
): NoteHistoryHooks {
  const resolve = (): NotesService => {
    const service = typeof notes === 'function' ? notes() : notes;
    if (service === undefined) databaseError('note history service unavailable (L10 note_format_repo)');
    return service;
  };
  return {
    validateBatchFormats: (_db, changes) => validateBatchFormatsImpl(resolve(), changes),
    validateIncoming: (db, table, id, data) => {
      // note_history.rs:371-373 gates the entire feature before consulting owners.
      if (!tableHasColumn(db, 'note_document_revisions', 'version_id')) return;
      validateIncomingImpl(resolve(), reader(), db, table, id, data);
    },
    affectedNotes: (db, table, id) => {
      // note_history.rs:264-266: legacy/ad-hoc databases have no history feature.
      if (!tableHasColumn(db, 'note_document_revisions', 'version_id')) return [];
      return wrap(() => reader().affectedNotes(db, table, id));
    },
    snapshotNotes: (db, ids, source) => snapshotNotesImpl(resolve(), db, ids, source),
    retargetNoteRelations: (db, note, previous) => wrap(() => syncOwner(resolve()).retargetNoteRelations(db, note, previous)),
    prepareRelation: (db, id, data) => wrap(() => syncOwner(resolve()).prepareRelation(db, id, data)),
    applyRevision: (db, id, data) => wrap(() => syncOwner(resolve()).applyRevision(db, id, data)),
  };
}
