/** note_history.rs: dependency collection and sync orchestration.
 * All note/format/revision/relation mutations belong to L10 notes.sync and use
 * the caller's SqlExecutor, preserving the surrounding apply transaction.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue, NoteHistorySupport, NotesService, SyncChangeWithData } from '../api.ts';
import type { NoteFormat, NoteSyncRepository } from '../../notes/api.ts';
import { databaseError, SyncSupportError } from './errors.ts';
import { isJsonObject, toWireJson } from './json.ts';
import { tableHasColumn } from '../repository/pragma.ts';
import { getRecordData } from '../repository/records.ts';
import {
  selectAffectedNotesByNote, selectAffectedNotesByResource,
  selectFormatIds, selectRelationIds, selectRevisionIds,
} from '../repository/note-history.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrap<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof SyncSupportError) throw error;
    return databaseError(errorMessage(error));
  }
}

function syncOwner(notes: NotesService | undefined): NoteSyncRepository {
  if (notes?.sync === undefined) databaseError('note history sync service unavailable (L10 notes.sync)');
  return notes.sync;
}

function hasVersionId(db: SqlExecutor): boolean {
  return tableHasColumn(db, 'note_document_revisions', 'version_id');
}

function parseFormat(data: JsonValue): NoteFormat {
  if (!isJsonObject(data)) databaseError('Missing note format envelope');
  const noteId = data.note_id;
  const contentFormat = data.content_format;
  const formatVersion = data.format_version;
  const serializer = data.serializer_version;
  const baseline = data.baseline_version_id;
  if (typeof noteId !== 'string' || typeof contentFormat !== 'string'
    || typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)
    || typeof serializer !== 'string'
    || (baseline !== null && baseline !== undefined && typeof baseline !== 'string')) {
    databaseError('Missing note format envelope');
  }
  return {
    note_id: noteId, content_format: contentFormat, format_version: formatVersion,
    serializer_version: serializer, baseline_version_id: typeof baseline === 'string' ? baseline : null,
  };
}

/** note_history.rs:17-75: formats → ordered revisions → relations, inheriting the note log boundary. */
export function includeNoteDependencies(db: SqlExecutor, changes: SyncChangeWithData[]): void {
  if (!hasVersionId(db)) return;
  const seen = new Set(changes.map(change => `${change.table_name}\u0000${change.record_id}`));
  const notes = changes.filter(change => change.table_name === 'notes' && change.operation !== 'Delete' && change.data !== null);
  for (const note of notes) {
    const sources: readonly [string, string, (db: SqlExecutor, id: string) => string[]][] = [
      ['note_document_formats', 'note_id', (conn, id) => wrap(() => conn.all(selectFormatIds, [id])).map(row => row.note_id)],
      ['note_document_revisions', 'version_id', (conn, id) => wrap(() => conn.all(selectRevisionIds, [id])).map(row => row.version_id)],
      ['note_learning_relations', 'id', (conn, id) => wrap(() => conn.all(selectRelationIds, [id])).map(row => row.id)],
    ];
    for (const [table, key, read] of sources) {
      if (!tableHasColumn(db, table, key)) continue;
      for (const id of read(db, note.record_id)) {
        const identity = `${table}\u0000${id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        changes.push({ ...note, table_name: table, record_id: id, operation: 'Insert',
          data: toWireJson(getRecordData(db, table, id, key)) });
      }
    }
  }
}

/** note_history.rs:118-149: the owner performs retarget and block invalidation on this connection. */
export function retargetNoteRelations(notes: NotesService | undefined, db: SqlExecutor, noteId: string, previous: string): void {
  wrap(() => syncOwner(notes).retargetNoteRelations(db, noteId, previous));
}

/** note_history.rs:153-257: immutable history and pin mutations are owned by L10. */
export function applyRevision(notes: NotesService | undefined, db: SqlExecutor, id: string, data: JsonValue): void {
  wrap(() => syncOwner(notes).applyRevision(db, id, data));
}

export function affectedNotes(db: SqlExecutor, table: string, id: string): string[] {
  if (!hasVersionId(db)) return [];
  if (table === 'notes') return wrap(() => db.all(selectAffectedNotesByNote, [id])).map(row => row.id);
  if (table === 'resources') return wrap(() => db.all(selectAffectedNotesByResource, [id])).map(row => row.id);
  return [];
}

/** note_history.rs:279-316: infer before remote snapshot; pin after before_sync snapshot. */
export function snapshotNotes(notes: NotesService | undefined, db: SqlExecutor, ids: readonly string[], source: string): void {
  if (notes === undefined) databaseError('note history service unavailable (L10 notes)');
  for (const id of ids) {
    if (source === 'remote_sync') wrap(() => syncOwner(notes).updateInferredFormat(db, id));
    const version = wrap(() => notes.revisions.snapshot(db, id, source));
    if (source === 'before_sync') wrap(() => notes.revisions.setPinned(db, id, version, true));
  }
}

/** note_history.rs:318-368: reject future formats before applying note/resource rows. */
export function validateBatchFormats(notes: NotesService | undefined, changes: readonly SyncChangeWithData[]): void {
  if (notes === undefined) databaseError('note history service unavailable (L10 notes)');
  for (const change of changes) {
    if (change.table_name !== 'note_document_formats' || change.operation === 'Delete') continue;
    if (change.data === null) databaseError('Missing note format envelope');
    const format = parseFormat(change.data);
    wrap(() => notes.format.ensureSupported(format));
    if (format.note_id !== change.record_id) databaseError('Note format identity mismatch');
    const noteChange = changes.find(item => item.table_name === 'notes' && item.record_id === format.note_id);
    const noteData = noteChange?.data;
    const resourceId = isJsonObject(noteData) && typeof noteData.resource_id === 'string' ? noteData.resource_id : null;
    const bodyChange = resourceId === null ? undefined
      : changes.find(item => item.table_name === 'resources' && item.record_id === resourceId);
    const bodyData = bodyChange?.data;
    const body = isJsonObject(bodyData) && typeof bodyData.data === 'string' ? bodyData.data : null;
    if (body !== null) {
      const detected = wrap(() => notes.format.detect(format.note_id, body));
      if (detected.content_format !== format.content_format
        || (wrap(() => notes.format.requiredCapabilities(detected)).length > 0
          && wrap(() => notes.format.requiredCapabilities(format)).length === 0)) {
        databaseError('Note format/body capability mismatch');
      }
    }
  }
}

export function validateIncoming(notes: NotesService | undefined, db: SqlExecutor, table: string, id: string, data: JsonValue): void {
  if (!hasVersionId(db)) return;
  if (notes === undefined) databaseError('note history service unavailable (L10 notes)');
  if (table === 'note_document_formats') wrap(() => notes.format.ensureSupported(parseFormat(data)));
  if (table === 'resources') {
    const isNote = isJsonObject(data) && data.type === 'note';
    const affected = affectedNotes(db, table, id);
    if (isNote || affected.length > 0) {
      const body = isJsonObject(data) && typeof data.data === 'string' ? data.data : null;
      if (body !== null) wrap(() => notes.format.detect(id, body));
    }
    for (const note of affected) wrap(() => notes.format.ensureSupported(notes.format.get(db, note)));
    return;
  }
  for (const note of affectedNotes(db, table, id)) wrap(() => notes.format.ensureSupported(notes.format.get(db, note)));
}

export function createNoteHistorySupport(notes: NotesService | (() => NotesService | undefined)): NoteHistorySupport {
  const resolve = (): NotesService => {
    const service = typeof notes === 'function' ? notes() : notes;
    if (service === undefined) databaseError('note history service unavailable (L10 notes)');
    return service;
  };
  return {
    available: hasVersionId,
    includeNoteDependencies,
    prepareRelation: (db, id, obj) => wrap(() => syncOwner(resolve()).prepareRelation(db, id, obj)),
    retargetNoteRelations: (db, noteId, previous) => retargetNoteRelations(resolve(), db, noteId, previous),
    applyRevision: (db, id, data) => applyRevision(resolve(), db, id, data),
    affectedNotes,
    snapshotNotes: (db, ids, source) => snapshotNotes(resolve(), db, ids, source),
    validateBatchFormats: changes => validateBatchFormats(resolve(), changes),
    validateIncoming: (db, table, id, data) => validateIncoming(resolve(), db, table, id, data),
  };
}
