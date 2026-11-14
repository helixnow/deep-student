// note_revision_repo.rs: local full-document history and immutable restore identities.
const randomUUID = () => globalThis.crypto.randomUUID();
import type {
  NoteFormat, NoteHistoryCurrent, NoteRevision, NoteRevisionSummary,
} from '../../../../contracts/ipc/generated/L10-notes.ts';
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { ExactNoteHistoryPage, NoteHistorySequence } from '../api.ts';
import { conflict, invalid, NoteDatabaseError } from './errors.ts';
import { decodeJson, decodeJsonExact, NoteSerializationError } from './json.ts';
import { noteTransaction } from './transaction.ts';
import { noteFormatRepository } from './format.ts';
import { noteRepository } from './notes.ts';
import { blocks, marker, roots } from '../src/structure.ts';
import { now, nowEpochNanos, parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { rustTrim, takeChars } from '../../../platform/util/index.ts';
import { JsonReader, JsonSyntaxError } from '../../../platform/util/api.ts';

export interface NoteAssetRef { kind: string; value: string }

/** note_revision_repo.rs asset discovery: owned assets, quoted attributes, external references. */
export function extractAssetRefs(content: string): NoteAssetRef[] {
  const refs = new Map<string, NoteAssetRef>();
  const add = (kind: string, value: string) => {
    refs.set(`${kind}\u0000${value}`, { kind, value });
  };
  const owned = /notes_assets[/\\][^\s<>"'()\[\]{},?#]+/g;
  for (const matched of content.matchAll(owned)) {
    let value = matched[0];
    try {
      value = decodeURIComponent(value);
    } catch {
      value = matched[0];
    }
    add('notes_asset', value.replace(/\\/g, '/'));
  }
  const quoted = /[<"']([^<>"']*notes_assets[/\\][^<>"']+)[>"']/g;
  for (const matched of content.matchAll(quoted)) {
    const raw = matched[1] ?? '';
    const start = raw.indexOf('notes_assets');
    if (start < 0) continue;
    let value = raw.slice(start);
    try {
      value = decodeURIComponent(value);
    } catch {
      value = raw.slice(start);
    }
    add('notes_asset', value.replace(/\\/g, '/'));
  }
  const external = /(?:https?:\/\/|pdfref:\/\/|file:\/\/)[^\s<>"'()\[\]{}]+/g;
  for (const matched of content.matchAll(external)) {
    const value = matched[0];
    if (value.includes('notes_assets')) continue;
    add(value.startsWith('http') ? 'remote_url' : 'external_resource', value);
  }
  return [...refs.values()].sort((a, b) => (a.kind === b.kind ? compare(a.value, b.value) : compare(a.kind, b.kind)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

function documentAssetRefs(content: string, props: unknown): NoteAssetRef[] {
  const refs = new Map<string, NoteAssetRef>();
  for (const ref of extractAssetRefs(content)) refs.set(`${ref.kind}\u0000${ref.value}`, ref);
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const value of Object.values(props as Record<string, unknown>)) {
      if (typeof value === 'string') {
        for (const ref of extractAssetRefs(value)) refs.set(`${ref.kind}\u0000${ref.value}`, ref);
      }
    }
  }
  return [...refs.values()].sort((a, b) => (a.kind === b.kind ? compare(a.value, b.value) : compare(a.kind, b.kind)));
}

interface RevisionRow {
  version_id: string;
  note_id: string;
  parent_version_id: string | null;
  restored_from_version_id: string | null;
  title: string;
  source: string;
  created_at: string;
  pinned: number | bigint | boolean;
  content_bytes: number | bigint;
  content_md: string;
  tags_json: string;
  props_json: string | null;
  asset_refs_json: string;
  content_format: string;
  format_version: number;
  serializer_version: string;
}

function summary(row: Pick<RevisionRow, keyof NoteRevisionSummary>): NoteRevisionSummary {
  return {
    version_id: row.version_id,
    note_id: row.note_id,
    parent_version_id: row.parent_version_id,
    restored_from_version_id: row.restored_from_version_id,
    title: row.title,
    source: row.source,
    created_at: row.created_at,
    pinned: Boolean(row.pinned),
    // SQLite's BLOB length limit is below 2^31; unlike seq, this is exact as number.
    content_bytes: Number(row.content_bytes),
  };
}

const SUMMARY_COLUMNS = 'version_id, note_id, parent_version_id, restored_from_version_id, title, source, created_at, pinned, length(CAST(content_md AS BLOB)) AS content_bytes';
const HISTORY_PAGE = defineQuery<readonly [string, NoteHistorySequence | null, number, number], RevisionRow & { seq: bigint }>(
  `SELECT seq, ${SUMMARY_COLUMNS} FROM note_document_revisions
   WHERE note_id=?1 AND (?2 IS NULL OR seq < ?2) AND (?4=0 OR pinned=1)
   ORDER BY seq DESC LIMIT ?3`,
  { name: 'notes.history.page', options: { safeIntegers: true } },
);
const HISTORY_MAX_SEQUENCE = defineQuery<readonly [string], { seq: bigint }>(
  'SELECT MAX(seq) AS seq FROM note_document_revisions WHERE note_id=?1',
  { name: 'notes.history.max-sequence', options: { safeIntegers: true } },
);

/** serde_json's type description used by its `invalid type:` messages. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  switch (typeof value) {
    case 'string': return `string ${JSON.stringify(value)}`;
    case 'number':
      return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    case 'boolean': return `boolean \`${value}\``;
    case 'object': return 'map';
    default: return 'unit';
  }
}

function invalidType(value: unknown, expected: string): never {
  throw new NoteSerializationError(`invalid type: ${jsonType(value)}, expected ${expected}`);
}

/** serde_json::from_str::<Vec<String>>. */
function decodeStringArray(text: string): string[] {
  try {
    const reader = new JsonReader(text);
    reader.beginArray();
    const values: string[] = [];
    while (reader.nextItem()) values.push(reader.readString());
    reader.end();
    return values;
  } catch (error) {
    if (error instanceof JsonSyntaxError) throw new NoteSerializationError(error.message);
    throw error;
  }
}

/** serde_json::from_str::<Vec<NoteAssetRef>> (deny_unknown_fields is off). */
function decodeAssetRefs(text: string): NoteAssetRef[] {
  const parsed = decodeJson(text);
  if (!Array.isArray(parsed)) invalidType(parsed, 'a sequence');
  return parsed.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      invalidType(item, 'struct NoteAssetRef');
    }
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const value = record.value;
    if (typeof kind !== 'string') invalidType(kind === undefined ? null : kind, 'a string');
    if (typeof value !== 'string') invalidType(value === undefined ? null : value, 'a string');
    return { kind, value };
  });
}

/** NoteRevision with serde `Option<Value>` props under arbitrary_precision: `undefined` is
 * SQL NULL (None); JSON `null` text stays Some(Null). Numbers are raw atoms (IPC only via getExact). */
type ExactRevision = Omit<NoteRevision, 'props'> & { props: unknown };

function missing(versionId: string): never {
  // VfsError::NotFound Display; note_storage maps it to AppError::database.
  throw new NoteDatabaseError(`Note revision (missing or pruned) not found: ${versionId}`);
}

export const noteRevisionRepository = {
  transaction<T>(conn: SqlExecutor, work: () => T): T {
    return noteTransaction(conn, work);
  },

  snapshot(conn: SqlExecutor, noteId: string, source: string): string {
    return this.snapshotRestored(conn, noteId, source, null);
  },

  snapshotRestored(conn: SqlExecutor, noteId: string, source: string, restoredFrom: string | null): string {
    const note = noteRepository.getNoteIncludingDeleted(noteId, conn, true);
    if (note === null) missing(noteId);
    const props = note.props === null ? undefined : note.props;
    const content = conn.one<{ data: string }>('SELECT data FROM resources WHERE id=?1', [note.resourceId]).data;
    const format = noteFormatRepository.get(conn, noteId);
    const latest = conn.get<{ version_id: string; edit_bucket: number; created_at: string }>(
      'SELECT version_id, edit_bucket, created_at FROM note_document_revisions WHERE note_id=?1 ORDER BY seq DESC LIMIT 1', [noteId]);
    if (latest !== undefined) {
      const previous = this.read(conn, noteId, latest.version_id, true);
      if (previous.content_md === content
        && previous.title === note.title
        && deepEqual(previous.tags, note.tags)
        && deepEqual(previous.props, props)
        && previous.content_format === format.content_format
        && previous.format_version === format.format_version
        && previous.serializer_version === format.serializer_version
        && restoredFrom === null) {
        return latest.version_id;
      }
    }
    const id = `nrev_${randomUUID().replace(/-/g, '')}`;
    // One chrono `Utc::now()` sample feeds both the bucket and created_at.
    const instant = now();
    const policy = this.getRetention(conn);
    const bucket = policy.edit_bucket_seconds === 0
      ? -1 : Math.floor(instant.millis / 1000 / policy.edit_bucket_seconds);
    conn.run(`INSERT INTO note_document_revisions
       (version_id, note_id, parent_version_id, title, content_md, tags_json, props_json,
         asset_refs_json, source, created_at, edit_bucket, content_format, format_version, serializer_version, restored_from_version_id)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`, [
      id, noteId, latest?.version_id ?? null, note.title, content, JSON.stringify(note.tags),
      props === undefined ? null : JSON.stringify(props),
      JSON.stringify(documentAssetRefs(content, props)), source, toRfc3339Opts(instant.epochNanos, 'Nanos', true), bucket,
      format.content_format, format.format_version, format.serializer_version, restoredFrom,
    ]);
    if (source === 'edit') {
      if (latest !== undefined) {
        const policyUpdated = conn.one<{ updated_at: string }>('SELECT updated_at FROM note_history_retention WHERE id=1').updated_at;
        const previousCreated = parseRfc3339(latest.created_at);
        const policyChangedAt = parseRfc3339(policyUpdated);
        const samePolicy = policyUpdated.length === 0
          || (previousCreated !== null && policyChangedAt !== null
            && previousCreated.epochNanos >= policyChangedAt.epochNanos);
        if (policy.edit_bucket_seconds > 0 && latest.edit_bucket === bucket && samePolicy) {
          conn.run("DELETE FROM note_document_revisions WHERE version_id=?1 AND source='edit' AND pinned=0 AND version_id NOT IN (SELECT baseline_version_id FROM note_document_formats WHERE baseline_version_id IS NOT NULL)", [latest.version_id]);
        }
      }
      if (policy.max_edit_versions !== null) {
        conn.run(`DELETE FROM note_document_revisions WHERE note_id=?1 AND source='edit' AND pinned=0
           AND seq NOT IN (SELECT seq FROM note_document_revisions WHERE note_id=?1 AND source='edit' AND pinned=0
             AND version_id NOT IN (SELECT baseline_version_id FROM note_document_formats WHERE baseline_version_id IS NOT NULL)
             ORDER BY seq DESC LIMIT ?2)
           AND version_id NOT IN (SELECT baseline_version_id FROM note_document_formats WHERE baseline_version_id IS NOT NULL)`,
        [noteId, policy.max_edit_versions]);
      }
      this.discardUnpublishedHistoryLogs(conn);
    }
    return id;
  },

  discardUnpublishedHistoryLogs(conn: SqlExecutor): void {
    conn.run("DELETE FROM __change_log WHERE table_name='note_document_revisions' AND operation IN ('INSERT','UPDATE') AND COALESCE(sync_version,0)=0 AND NOT EXISTS(SELECT 1 FROM note_document_revisions r WHERE r.version_id=__change_log.record_id)", []);
  },

  list(conn: SqlExecutor, noteId: string, cursor: NoteHistorySequence | null, limit: number): ExactNoteHistoryPage {
    return this.listFiltered(conn, noteId, cursor, limit, false);
  },

  listFiltered(conn: SqlExecutor, noteId: string, cursor: NoteHistorySequence | null, requestedLimit: number, pinnedOnly: boolean): ExactNoteHistoryPage {
    const limit = Math.min(100, Math.max(1, requestedLimit));
    const rows = conn.all(HISTORY_PAGE, [noteId, cursor, limit + 1, pinnedOnly ? 1 : 0]);
    const seq = rows.length > limit ? rows[limit - 1]!.seq : null;
    const nextCursor = seq !== null && seq >= BigInt(Number.MIN_SAFE_INTEGER) && seq <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(seq) : seq;
    return { items: rows.slice(0, limit).map(summary), next_cursor: nextCursor };
  },

  get(conn: SqlExecutor, noteId: string, versionId: string): NoteRevision {
    return this.read(conn, noteId, versionId, false);
  },

  /** notes_history_get IPC output: props keep arbitrary_precision number text as raw atoms;
   * None and Some(Null) both serialize as `null`. */
  getExact(conn: SqlExecutor, noteId: string, versionId: string): NoteRevision {
    const revision = this.read(conn, noteId, versionId, true);
    return revision.props === undefined ? { ...revision, props: null } : revision;
  },

  read(conn: SqlExecutor, noteId: string, versionId: string, exactProps: boolean): ExactRevision {
    const row = conn.get<RevisionRow>(
      `SELECT ${SUMMARY_COLUMNS}, content_md, tags_json, props_json, asset_refs_json,
       content_format, format_version, serializer_version
       FROM note_document_revisions WHERE note_id=?1 AND version_id=?2`, [noteId, versionId]);
    if (row === undefined) missing(versionId);
    return {
      ...summary(row),
      content_md: row.content_md,
      tags: decodeStringArray(row.tags_json),
      props: row.props_json === null ? (exactProps ? undefined : null)
        : exactProps ? decodeJsonExact(row.props_json) : decodeJson(row.props_json),
      asset_refs: decodeAssetRefs(row.asset_refs_json),
      content_format: row.content_format,
      format_version: row.format_version,
      serializer_version: row.serializer_version,
    };
  },

  setPinned(conn: SqlExecutor, noteId: string, versionId: string, pinned: boolean): NoteRevisionSummary {
    return this.transaction(conn, () => {
      const revision = this.get(conn, noteId, versionId);
      conn.run('UPDATE note_document_revisions SET pinned=?1 WHERE note_id=?2 AND version_id=?3', [pinned, noteId, versionId]);
      return { ...summary(revision), pinned };
    });
  },

  getAndPin(conn: SqlExecutor, noteId: string, versionId: string): NoteRevision {
    return this.readAndPin(conn, noteId, versionId, false);
  },

  readAndPin(conn: SqlExecutor, noteId: string, versionId: string, exactProps: boolean): ExactRevision {
    return this.transaction(conn, () => {
      const revision = this.read(conn, noteId, versionId, exactProps);
      conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [versionId]);
      return { ...revision, pinned: true };
    });
  },

  restoreCopy(conn: SqlExecutor, noteId: string, versionId: string) {
    return this.restoreSelectionCopy(conn, noteId, versionId, null);
  },

  restoreSelectionCopy(conn: SqlExecutor, noteId: string, versionId: string, selection: { start_line: number; end_line: number } | null) {
    return this.transaction(conn, () => {
      const revision = this.readAndPin(conn, noteId, versionId, true);
      noteFormatRepository.ensureSupported({
        note_id: noteId, content_format: revision.content_format, format_version: revision.format_version,
        serializer_version: revision.serializer_version, baseline_version_id: null,
      });
      const content = this.selectedContent(revision, selection);
      const currentId = this.snapshot(conn, noteId, 'before_restore');
      conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1', [currentId]);
      const base = takeChars(revision.title, 450);
      const title = noteRepository.generateUniqueNoteTitle(conn, `${base}（历史副本）`, null);
      const note = noteRepository.createNoteInFolder({ title, content, tags: revision.tags }, null, conn);
      noteFormatRepository.insert(conn, {
        note_id: note.id, content_format: revision.content_format,
        format_version: revision.format_version, serializer_version: revision.serializer_version,
        baseline_version_id: null,
      });
      const withProps = revision.props === undefined ? note
        : this.exactNote(conn, noteRepository.updateNoteMetadata(note.id, { props: revision.props }, conn));
      conn.run('DELETE FROM note_document_revisions WHERE note_id=?1', [note.id]);
      this.discardUnpublishedHistoryLogs(conn);
      this.snapshotRestored(conn, note.id, 'restore_copy', versionId);
      return withProps;
    });
  },

  /** Restore returns VfsNote serialized with the arbitrary_precision props text it just stored. */
  exactNote(conn: SqlExecutor, note: import('../api.ts').VfsNote): import('../api.ts').VfsNote {
    const exact = noteRepository.getNoteIncludingDeleted(note.id, conn, true);
    if (exact === null) missing(note.id);
    return exact;
  },

  selectedContent(revision: Pick<NoteRevision, 'note_id' | 'content_md' | 'content_format' | 'format_version' | 'serializer_version'>, selection: { start_line: number; end_line: number } | null): string {
    const format = {
      note_id: revision.note_id, content_format: revision.content_format,
      format_version: revision.format_version, serializer_version: revision.serializer_version,
      baseline_version_id: null,
    };
    noteFormatRepository.ensureSupported(format);
    const detected = noteFormatRepository.detect(revision.note_id, revision.content_md);
    if (detected.content_format !== format.content_format && rustTrim(revision.content_md).length > 0) {
      invalid('History body does not match its format envelope');
    }
    if (format.content_format === 'markdown-blocks') blocks(revision.content_md);
    if (noteFormatRepository.requiredCapabilities(detected).length > 0
      && noteFormatRepository.requiredCapabilities(format).length === 0) {
      invalid('History format lacks required columns capability');
    }
    if (selection === null) return revision.content_md;
    const content = revision.content_md;
    const starts = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) === 10) starts.push(index + 1);
    }
    if (selection.start_line === 0 || selection.end_line < selection.start_line || selection.end_line > starts.length) {
      invalid('History line selection is out of range');
    }
    const start = starts[selection.start_line - 1]!;
    const end = selection.end_line < starts.length ? starts[selection.end_line]! - 1 : content.length;
    if (start === 0 && end === content.length) return content;

    const spans: Array<[number, number]> = [];
    let pendingMarker: number | null = null;
    let covered = 0;
    for (const root of roots(content)) {
      if (rustTrim(content.slice(covered, root.start)).length > 0) {
        invalid('Select the full document when it contains reference definitions');
      }
      covered = root.end;
      const raw = content.slice(root.start, root.end);
      if (marker(raw) !== null) {
        pendingMarker = root.start;
        continue;
      }
      const effectiveEnd = root.start + raw.replace(/[\n\r]+$/, '').length;
      spans.push([pendingMarker ?? root.start, effectiveEnd]);
      pendingMarker = null;
    }
    if (pendingMarker !== null || rustTrim(content.slice(covered)).length > 0) {
      invalid('Incomplete history structure');
    }
    if (spans.some(([spanStart, spanEnd]) => (start > spanStart && start < spanEnd) || (end > spanStart && end < spanEnd))) {
      invalid('Select complete root blocks; the range cuts a Markdown or columns structure');
    }
    const selected = content.slice(start, end);
    noteFormatRepository.detect(format.note_id, selected);
    if (format.content_format === 'markdown-blocks') blocks(selected);
    return selected;
  },

  current(conn: SqlExecutor, noteId: string): NoteHistoryCurrent {
    const row = conn.get<{ data: string; updated_at: string; title: string }>(
      `SELECT r.data, n.updated_at, n.title FROM notes n JOIN resources r ON r.id=n.resource_id
       WHERE n.id=?1 AND n.deleted_at IS NULL`, [noteId]);
    if (row === undefined) invalid('Current note missing or deleted');
    return { content_md: row.data, updated_at: row.updated_at, title: row.title };
  },

  setRetention(conn: SqlExecutor, policy: { edit_bucket_seconds: number; max_edit_versions: number | null }): { edit_bucket_seconds: number; max_edit_versions: number | null } {
    let next = { ...policy };
    if (next.max_edit_versions === 0) next = { ...next, max_edit_versions: null };
    if (next.edit_bucket_seconds < 0 || next.edit_bucket_seconds > 86400
      || (next.max_edit_versions !== null && (next.max_edit_versions < 1 || next.max_edit_versions > 100000))) {
      invalid('Retention interval must be 0..86400; version budget must be null or 1..100000');
    }
    conn.run(`UPDATE note_history_retention SET edit_bucket_seconds=?1, max_edit_versions=?2, updated_at=?3
      WHERE id=1`, [next.edit_bucket_seconds, next.max_edit_versions, toRfc3339Opts(nowEpochNanos(), 'Nanos', true)]);
    return next;
  },

  restoreCurrent(conn: SqlExecutor, noteId: string, versionId: string, expected: string, selection: { start_line: number; end_line: number } | null): import('../api.ts').VfsNote {
    return this.transaction(conn, () => {
      const live = this.current(conn, noteId);
      if (live.updated_at !== expected) conflict('notes.conflict');
      const currentFormat = noteFormatRepository.get(conn, noteId);
      noteFormatRepository.ensureSupported(currentFormat);
      noteFormatRepository.detect(noteId, live.content_md);
      const revision = this.readAndPin(conn, noteId, versionId, true);
      const content = this.selectedContent(revision, selection);
      const before = this.snapshot(conn, noteId, 'before_restore');
      this.setPinned(conn, noteId, before, true);
      const beforeSeq = conn.one(HISTORY_MAX_SEQUENCE, [noteId]).seq;
      const format = {
        note_id: noteId, content_format: revision.content_format,
        format_version: revision.format_version, serializer_version: revision.serializer_version,
        baseline_version_id: currentFormat.baseline_version_id,
      };
      const note = noteRepository.updateNoteWithFormat(conn, noteId, {
        content, title: revision.title, tags: revision.tags, expectedUpdatedAt: expected,
      }, format);
      const withProps = this.exactNote(conn, noteRepository.updateNoteMetadata(noteId, {
        props: revision.props === undefined ? {} : revision.props, expectedUpdatedAt: note.updatedAt,
      }, conn));
      conn.run('DELETE FROM note_document_revisions WHERE note_id=?1 AND seq>?2', [noteId, beforeSeq]);
      this.discardUnpublishedHistoryLogs(conn);
      this.snapshotRestored(conn, noteId, 'restore_current', versionId);
      return withProps;
    });
  },

  retainedAssetPaths(conn: SqlExecutor): Set<string> {
    const paths = new Set<string>();
    for (const row of conn.all<{ data: string | null; props: string | null }>(
      `SELECT COALESCE(r.data, '') AS data, n.props FROM notes n JOIN resources r ON r.id = n.resource_id`)) {
      const props: unknown = row.props === null ? null : decodeJson(row.props);
      for (const ref of documentAssetRefs(row.data ?? '', props)) {
        if (ref.kind === 'notes_asset') paths.add(ref.value);
      }
    }
    for (const row of conn.all<{ asset_refs_json: string }>('SELECT asset_refs_json FROM note_document_revisions')) {
      for (const ref of decodeAssetRefs(row.asset_refs_json)) {
        if (ref.kind === 'notes_asset') paths.add(ref.value);
      }
    }
    for (const row of conn.all<{ asset_refs_json: string }>('SELECT asset_refs_json FROM note_transfer_operations')) {
      for (const ref of decodeAssetRefs(row.asset_refs_json)) {
        if (ref.kind === 'notes_asset') paths.add(ref.value);
      }
    }
    for (const row of conn.all<{ data: string }>(
      `SELECT DISTINCT r.data FROM note_learning_relations l JOIN resources r ON r.id=l.resource_id WHERE r.data IS NOT NULL`)) {
      for (const ref of extractAssetRefs(row.data)) {
        if (ref.kind === 'notes_asset') paths.add(ref.value);
      }
    }
    return paths;
  },

  assetIsReferenced(conn: SqlExecutor, relativePath: string): boolean {
    const path = relativePath.replace(/\\/g, '/').replace(/^active\//, '').replace(/^\.\//, '');
    if (!path.startsWith('notes_assets/')) return false;
    return this.retainedAssetPaths(conn).has(path);
  },

  getRetention(conn: SqlExecutor): { edit_bucket_seconds: number; max_edit_versions: number | null } {
    const row = conn.one<{ edit_bucket_seconds: number; max_edit_versions: number | null }>(
      'SELECT edit_bucket_seconds, max_edit_versions FROM note_history_retention WHERE id=1');
    return { edit_bucket_seconds: Number(row.edit_bucket_seconds), max_edit_versions: row.max_edit_versions === null ? null : Number(row.max_edit_versions) };
  },
};
