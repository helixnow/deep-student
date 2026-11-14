// note_repo.rs: VFS note metadata CRUD, FTS search, tags, links, trash and folder placement.
import { nanoid } from 'nanoid';
import type { VfsNote, ResourceLocation } from '../api.ts';
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import {
  databaseFailure, invalid, invalidParam, NoteDocumentError, notFound,
} from './errors.ts';
import { noteTransaction } from './transaction.ts';
import { noteRelationRepository } from './relations.ts';
import { parsePropsCell, normalizeNoteProps } from './props.ts';
import { noteFormatRepository } from './format.ts';
import { noteRevisionRepository } from './revisions.ts';
import { noteResourceRepos, vfsRepoCall } from './resource-deps.ts';
import { notesLog } from './log.ts';
import { decodeJson } from './json.ts';
import { charCount, rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { nowEpochNanos, parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';

let defaultConnection: SqlExecutor | null = null;

/** The plugin wires the VFS handle once; tests pass an executor explicitly. */
export function configureNotesRepository(conn: SqlExecutor | null): void {
  defaultConnection = conn;
}

function connection(conn?: SqlExecutor): SqlExecutor {
  const resolved = conn ?? defaultConnection;
  if (resolved === null) databaseFailure('VFS database not configured');
  return resolved;
}

export interface ParsedNoteLink {
  raw_target: string;
  heading: string | null;
  alias: string | null;
  position: number;
  kind: 'wikilink' | 'noteref';
}

export interface NoteBacklink {
  sourceId: string; sourceTitle: string; heading: string | null; alias: string | null;
  position: number; sourceUpdatedAt: string;
}

export interface NoteOutgoingLink {
  targetId: string | null; targetTitle: string; heading: string | null; alias: string | null;
  position: number; linkType: string; resolved: boolean;
}

export interface NoteUnresolvedLink {
  sourceId: string; sourceTitle: string; targetTitle: string; heading: string | null;
  alias: string | null; position: number; linkType: string;
}

interface NoteRow {
  id: string;
  resource_id: string;
  title: string;
  tags: string;
  is_favorite: number | boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  props?: string | null;
}

export interface NoteMetadataUpdate {
  title?: string | null;
  tags?: string[] | null;
  isFavorite?: boolean | null;
  props?: unknown;
  expectedUpdatedAt?: string | null;
}

export interface UpdateNoteParams {
  title?: string | null;
  content?: string | null;
  tags?: string[] | null;
  expectedUpdatedAt?: string | null;
}

export function nextUpdatedAt(current: string): string {
  const now = Date.now();
  const parsed = parseRfc3339(current)?.millis ?? null;
  const next = parsed !== null ? Math.max(now, parsed + 1) : now;
  return toRfc3339Opts(BigInt(next) * 1_000_000n, 'Millis', true);
}

function rowToNote(row: NoteRow): VfsNote {
  return noteFromRow(row, false);
}

function noteFromRow(row: NoteRow, exactProps: boolean): VfsNote {
  let tags: string[] = [];
  try {
    const parsed = decodeJson(row.tags);
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) tags = parsed;
    else notesLog.warn(`[VFS::NoteRepo] Failed to parse tags JSON for note ${row.id}: not a string array`);
  } catch (error) {
    notesLog.warn(`[VFS::NoteRepo] Failed to parse tags JSON for note ${row.id}: ${String(error)}; Raw JSON: ${row.tags}`);
  }
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    tags,
    isFavorite: Number(row.is_favorite) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    props: parsePropsCell(row.id, row.props, exactProps),
  };
}

function validateTitle(title: string): void {
  if (rustTrim(title).length === 0) invalidParam('title', '标题不能为空');
  if (charCount(title) > 500) invalidParam('title', '标题过长（最多 500 个字符）');
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(title)) {
    invalidParam('title', '标题不能包含换行等控制字符');
  }
}

function validateTags(tags: readonly string[]): void {
  if (tags.length > 100) invalidParam('tags', '标签数量超出上限（最多 100 个）');
  for (const tag of tags) {
    if (charCount(tag) > 100) invalidParam('tags', '标签过长（最多 100 个字符）');
    if (/[\u0000-\u001f\u007f-\u009f]/.test(tag)) invalidParam('tags', '标签不能包含控制字符');
  }
}

export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** notes_fts uses trigram: <3 characters falls back to LIKE. */
function buildFtsMatchQuery(keyword: string): string | null {
  const trimmed = rustTrim(keyword);
  if (charCount(trimmed) < 3) return null;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function makeSearchSnippet(text: string, keyword: string, maxChars: number): string | null {
  const trimmedText = rustTrim(text);
  if (trimmedText.length === 0) return null;
  const lowerText = trimmedText.toLowerCase();
  const lowerKeyword = rustTrim(keyword).toLowerCase();
  const byteIndex = lowerKeyword.length === 0 ? -1 : lowerText.indexOf(lowerKeyword);
  const charIndex = byteIndex < 0 ? 0 : charCount(lowerText.slice(0, byteIndex));
  const chars = [...trimmedText];
  const half = Math.floor(maxChars / 2);
  const startChar = Math.max(0, charIndex - half);
  const endChar = startChar + maxChars;
  let snippet = chars.slice(startChar, Math.min(endChar, chars.length)).join('');
  if (startChar > 0) snippet = `…${snippet}`;
  if (endChar < chars.length) snippet = `${snippet}…`;
  return snippet;
}

interface HitRow extends NoteRow { body: string }

function hit(row: HitRow, keyword: string): [VfsNote, string | null] {
  return [rowToNote(row), makeSearchSnippet(row.body, keyword, 160)];
}

function sha256(content: string): string {
  return vfsRepoCall(() => noteResourceRepos().resources.computeHash(content));
}

function computeHashWithSalt(content: string, salt: string): string {
  return vfsRepoCall(() => noteResourceRepos().resources.computeHashWithSalt(content, salt));
}

function createOrReuse(conn: SqlExecutor, type: 'note', data: string, hash: string, sourceId: string | null, sourceTable: string | null): { resourceId: string; isNew: boolean } {
  const result = vfsRepoCall(() => noteResourceRepos().resources.createOrReuseWithHash(
    conn, type, data, hash, sourceId, sourceTable, null));
  return { resourceId: result.resourceId, isNew: result.isNew };
}

function purgeIndexArtifacts(conn: SqlExecutor, resourceId: string): void {
  vfsRepoCall(() => noteResourceRepos().embeddingUnits.purgeIndexArtifactsByResource(conn, resourceId));
}

function markIndexPending(conn: SqlExecutor, resourceId: string): void {
  vfsRepoCall(() => noteResourceRepos().indexStates.markPending(conn, resourceId));
}

function checkLeaseWrite(conn: SqlExecutor, noteId: string): void {
  const blocked = conn.get<{ blocked: number }>(
    'SELECT EXISTS(SELECT 1 FROM note_editor_lease_notes ln WHERE ln.note_id=?1 AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=ln.token)) AS blocked',
    [noteId]);
  if (Number(blocked?.blocked ?? 0) !== 0) throw new NoteDocumentError('conflict', 'Stored revision changed; reload before retrying', 'notes.lease_conflict');
}

// ------------------------------------------------------------------ Markdown links

function byteLengthPrefix(content: string, end: number): number {
  return utf8ByteLength(content.slice(0, end));
}

function markdownCodeRanges(content: string): Array<[number, number]> {
  const bytes = new TextEncoder().encode(content);
  const ranges: Array<[number, number]> = [];
  let openFence: { char: number; length: number; start: number } | null = null;
  let lineStart = 0;
  let position = 0;
  while (position < bytes.length) {
    let lineEnd = bytes.indexOf(10, position);
    if (lineEnd < 0) lineEnd = bytes.length; else lineEnd += 1;
    const line = bytes.subarray(position, lineEnd);
    let indent = 0;
    while (indent < line.length && line[indent] === 32) indent += 1;
    let trimmedEnd = line.length;
    while (trimmedEnd > indent) {
      const byte = line[trimmedEnd - 1];
      if (byte === 10 || byte === 13 || byte === 32 || byte === 9) trimmedEnd -= 1;
      else break;
    }
    const trimmed = line.subarray(indent, trimmedEnd);
    if (openFence !== null) {
      let close = trimmed.length > 0 && trimmed.length >= openFence.length;
      if (close) {
        for (const byte of trimmed) {
          if (byte !== openFence.char) { close = false; break; }
        }
      }
      if (indent <= 3 && close) {
        ranges.push([openFence.start, lineEnd]);
        openFence = null;
      }
      lineStart = lineEnd;
      position = lineEnd;
      continue;
    }
    if (indent <= 3 && trimmed.length > 0 && (trimmed[0] === 96 || trimmed[0] === 126)) {
      const first = trimmed[0];
      let run = 0;
      while (run < trimmed.length && trimmed[run] === first) run += 1;
      let infoOk = true;
      if (first === 96) {
        for (let index = run; index < trimmed.length; index += 1) {
          if (trimmed[index] === 96) { infoOk = false; break; }
        }
      }
      if (run >= 3 && infoOk) {
        openFence = { char: first, length: run, start: lineStart };
        lineStart = lineEnd;
        position = lineEnd;
        continue;
      }
    }
    // Inline code: equal-length backtick runs pair with the nearest close.
    let index = 0;
    while (index < line.length) {
      if (line[index] !== 96) { index += 1; continue; }
      const runStart = index;
      while (index < line.length && line[index] === 96) index += 1;
      const runLength = index - runStart;
      let scan = index;
      let closeEnd: number | null = null;
      while (scan < line.length) {
        if (line[scan] !== 96) { scan += 1; continue; }
        const closeStart = scan;
        while (scan < line.length && line[scan] === 96) scan += 1;
        if (scan - closeStart === runLength) { closeEnd = scan; break; }
      }
      if (closeEnd !== null) {
        ranges.push([lineStart + runStart, lineStart + closeEnd]);
        index = closeEnd;
      }
    }
    lineStart = lineEnd;
    position = lineEnd;
  }
  if (openFence !== null) ranges.push([openFence.start, bytes.length]);
  return ranges;
}

export function extractNoteLinks(content: string): ParsedNoteLink[] {
  const SCHEME = 'note://';
  const links: ParsedNoteLink[] = [];
  const codeRanges = markdownCodeRanges(content);
  const inCode = (position: number) => codeRanges.some(([start, end]) => position >= start && position < end);
  const wikiRanges: Array<[number, number]> = [];

  let cursor = 0;
  while (true) {
    const relative = content.indexOf('[[', cursor);
    if (relative < 0) break;
    const start = relative;
    const innerStart = start + 2;
    const close = content.indexOf(']]', innerStart);
    if (close < 0) break;
    const inner = content.slice(innerStart, close);
    cursor = close + 2;
    if (inner.includes('\n')) continue;
    const startByte = byteLengthPrefix(content, start);
    const endByte = byteLengthPrefix(content, close + 2);
    wikiRanges.push([startByte, endByte]);
    if (inCode(startByte)) continue;
    const pipe = inner.indexOf('|');
    const targetPart = pipe < 0 ? inner : inner.slice(0, pipe);
    const alias = pipe < 0 ? null : rustTrim(inner.slice(pipe + 1)) || null;
    const hash = targetPart.indexOf('#');
    const targetRaw = hash < 0 ? targetPart : targetPart.slice(0, hash);
    const heading = hash < 0 ? null : rustTrim(targetPart.slice(hash + 1)) || null;
    const target = rustTrim(targetRaw);
    if (target.length === 0) continue;
    if (target.startsWith(SCHEME)) {
      const id = rustTrim(target.slice(SCHEME.length));
      if (id.length === 0) continue;
      links.push({ raw_target: id, heading, alias, position: startByte, kind: 'noteref' });
    } else {
      links.push({ raw_target: target, heading, alias, position: startByte, kind: 'wikilink' });
    }
  }

  cursor = 0;
  while (true) {
    const relative = content.indexOf(SCHEME, cursor);
    if (relative < 0) break;
    const start = relative;
    const idStart = start + SCHEME.length;
    let idEnd = idStart;
    while (idEnd < content.length && /[A-Za-z0-9_-]/.test(content.charAt(idEnd))) idEnd += 1;
    cursor = Math.max(idEnd, idStart);
    const startByte = byteLengthPrefix(content, start);
    if (wikiRanges.some(([rangeStart, rangeEnd]) => startByte >= rangeStart && startByte < rangeEnd)) continue;
    if (inCode(startByte)) continue;
    const id = content.slice(idStart, idEnd);
    if (id.length === 0) continue;
    links.push({ raw_target: id, heading: null, alias: null, position: startByte, kind: 'noteref' });
  }
  return links.sort((a, b) => a.position - b.position);
}

export const noteRepository = {
  getNote(id: string, conn?: SqlExecutor): VfsNote | null {
    const row = connection(conn).get<NoteRow>(
      `SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
       FROM notes WHERE id=?1 AND deleted_at IS NULL`, [id]);
    return row === undefined ? null : rowToNote(row);
  },

  /** `exactProps`: history snapshots keep arbitrary_precision props text (raw atoms; not for IPC). */
  getNoteIncludingDeleted(id: string, conn?: SqlExecutor, exactProps = false): VfsNote | null {
    const row = connection(conn).get<NoteRow>(
      `SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
       FROM notes WHERE id=?1`, [id]);
    return row === undefined ? null : noteFromRow(row, exactProps);
  },

  getNoteContent(id: string, conn?: SqlExecutor): string | null {
    const executor = connection(conn);
    const content = executor.get<{ data: string }>(
      `SELECT r.data FROM notes n JOIN resources r ON n.resource_id=r.id
       WHERE n.id=?1 AND n.deleted_at IS NULL`, [id]);
    if (content !== undefined) return content.data;
    const note = executor.get<{ resource_id: string }>(
      'SELECT id, resource_id FROM notes WHERE id=?1 AND deleted_at IS NULL', [id]);
    if (note !== undefined) {
      // note_repo.rs:1014-1020: a failed existence query counts as missing.
      let exists = false;
      try {
        exists = executor.get<{ present: number }>(
          'SELECT 1 AS present FROM resources WHERE id=?1', [note.resource_id]) !== undefined;
      } catch (error) {
        notesLog.debugError('[VFS::NoteRepo] resource existence check failed', error);
      }
      if (!exists) {
        notesLog.warn(`[VFS::NoteRepo] Missing resource for note ${id} (resource_id: ${note.resource_id})`);
        databaseFailure(`Missing resource for note ${id}`);
      }
    }
    return null;
  },

  rewriteTagsWithoutTouchingUpdatedAtWithConn(conn: SqlExecutor, noteId: string, tagsJson: string): void {
    conn.run('UPDATE notes SET tags = ?1 WHERE id = ?2', [tagsJson, noteId]);
  },

  getNoteWithContent(id: string, conn?: SqlExecutor): [VfsNote, string] | null {
    const note = this.getNote(id, conn);
    if (note === null) return null;
    return [note, this.getNoteContent(id, conn) ?? ''];
  },

  createNote(params: { title: string; content: string; tags?: string[] }, conn?: SqlExecutor): VfsNote {
    return this.createNoteWithConn(connection(conn), params);
  },

  createNoteWithConn(conn: SqlExecutor, params: { title: string; content: string; tags?: string[] }): VfsNote {
    validateTitle(params.title);
    const tags = params.tags ?? [];
    validateTags(tags);
    const noteId = `note_${nanoid(10)}`;
    const hash = computeHashWithSalt(params.content, noteId);
    try {
      conn.exec('SAVEPOINT create_note');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notesLog.error(`[VFS::NoteRepo] Failed to create savepoint for create_note: ${message}`);
      databaseFailure(`Failed to create savepoint: ${message}`);
    }
    let note: VfsNote;
    try {
      const resource = createOrReuse(conn, 'note', params.content, hash, noteId, 'notes');
      const now = toRfc3339Opts(nowEpochNanos(), 'Millis', true);
      conn.run('INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at) VALUES (?1,?2,?3,?4,0,?5,?6)',
        [noteId, resource.resourceId, params.title, JSON.stringify(tags), now, now]);
      vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.bindNoteSourceIdWithConn(conn, resource.resourceId, noteId));
      const parsed = extractNoteLinks(params.content);
      if (parsed.length > 0) this.replaceNoteLinks(conn, noteId, parsed);
      notesLog.info(`[VFS::NoteRepo] Created note: ${noteId} (resource: ${resource.resourceId})`);
      const format = noteFormatRepository.detect(noteId, params.content);
      noteFormatRepository.insert(conn, format);
      noteRevisionRepository.snapshot(conn, noteId, 'created');
      note = {
        id: noteId, resourceId: resource.resourceId, title: params.title, tags,
        isFavorite: false, createdAt: now, updatedAt: now, deletedAt: null, props: null,
      };
    } catch (error) {
      try {
        conn.exec('ROLLBACK TO create_note; RELEASE create_note');
      } catch (rollbackError) {
        notesLog.warnError('[VFS::NoteRepo] create_note rollback failed', rollbackError);
      }
      throw error;
    }
    // note_repo.rs:573-589: RELEASE errors are not body errors and do not
    // enter the rollback branch above.
    try {
      conn.exec('RELEASE create_note');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notesLog.error(`[VFS::NoteRepo] Failed to release savepoint create_note: ${message}`);
      databaseFailure(`Failed to release savepoint: ${message}`);
    }
    return note;
  },

  updateNote(id: string, params: UpdateNoteParams, conn?: SqlExecutor): VfsNote {
    return this.updateNoteWithFormat(connection(conn), id, params, null);
  },

  updateNoteWithCapabilities(conn: SqlExecutor, id: string, params: UpdateNoteParams, capabilities: readonly string[]): VfsNote {
    // Rust: expected_updated_at.is_none_or(str::is_empty) -> invalid.
    if (params.expectedUpdatedAt === undefined || params.expectedUpdatedAt === null
      || params.expectedUpdatedAt === '') {
      invalid('Capability-aware saves require expected_updated_at');
    }
    return this.updateNoteWithFormat(conn, id, params, null, capabilities);
  },

  updateNoteWithFormat(conn: SqlExecutor, id: string, params: UpdateNoteParams, formatUpgrade: import('../api.ts').NoteFormat | null, capabilities: readonly string[] = []): VfsNote {
    if (params.title !== undefined && params.title !== null) validateTitle(params.title);
    if (params.tags !== undefined && params.tags !== null) validateTags(params.tags);
    try {
      conn.exec('SAVEPOINT update_note');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notesLog.error(`[VFS::NoteRepo] Failed to create savepoint for update_note: ${message}`);
      databaseFailure(`Failed to create savepoint: ${message}`);
    }
    let updated: VfsNote;
    try {
      checkLeaseWrite(conn, id);
      const current = this.getNote(id, conn);
      if (current === null) notFound('Note', id);
      if (params.expectedUpdatedAt !== undefined && params.expectedUpdatedAt !== null && params.expectedUpdatedAt !== '') {
        if (params.expectedUpdatedAt !== current.updatedAt) {
          notesLog.warn(`[VFS::NoteRepo] Optimistic lock conflict for note ${id}: expected updated_at='${params.expectedUpdatedAt}', actual='${current.updatedAt}'`);
          throw new NoteDocumentError('conflict', 'The note has been updated elsewhere, please refresh.', 'notes.conflict');
        }
      }
      if (params.content !== undefined && params.content !== null && formatUpgrade === null) {
        noteFormatRepository.validateWriteCapabilities(conn, id, params.content, capabilities);
      }
      noteRevisionRepository.snapshot(conn, id, 'baseline');
      if (formatUpgrade !== null) noteFormatRepository.insert(conn, formatUpgrade);
      const now = nextUpdatedAt(current.updatedAt);
      let newResourceId: string | null = null;
      if (params.content !== undefined && params.content !== null) {
        const newHash = computeHashWithSalt(params.content, id);
        const currentResource = conn.get<{ id: string; hash: string }>(
          'SELECT id, hash FROM resources WHERE id=?1', [current.resourceId]);
        if (currentResource === undefined) notFound('Resource', current.resourceId);
        if (newHash !== currentResource.hash && sha256(params.content) !== currentResource.hash) {
          newResourceId = createOrReuse(conn, 'note', params.content, newHash, id, 'notes').resourceId;
        }
      }
      const newTitle = params.title ?? current.title;
      const newTags = params.tags ?? current.tags;
      const tagsJson = JSON.stringify(newTags);
      const finalResourceId = newResourceId ?? current.resourceId;
      const expected = params.expectedUpdatedAt == null ? null : rustTrim(params.expectedUpdatedAt) || null;
      const changed = expected !== null
        ? conn.run('UPDATE notes SET resource_id=?1, title=?2, tags=?3, updated_at=?4 WHERE id=?5 AND deleted_at IS NULL AND updated_at=?6',
          [finalResourceId, newTitle, tagsJson, now, id, expected]).changes
        : conn.run('UPDATE notes SET resource_id=?1, title=?2, tags=?3, updated_at=?4 WHERE id=?5 AND deleted_at IS NULL',
          [finalResourceId, newTitle, tagsJson, now, id]).changes;
      if (changed === 0) {
        if (expected !== null) throw new NoteDocumentError('conflict', 'The note has been updated elsewhere, please refresh.', 'notes.conflict');
        notFound('Note', id);
      }
      if (newResourceId !== null && current.resourceId !== finalResourceId) {
        conn.run('UPDATE note_learning_relations SET resource_id=?1, revision=revision+1, updated_at=?2 WHERE resource_id=?3 AND invalidated_at IS NULL AND NOT EXISTS (SELECT 1 FROM notes WHERE resource_id=?3)',
          [finalResourceId, now, current.resourceId]);
        const refs = conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE resource_id=?1', [current.resourceId]);
        if (Number(refs?.count ?? 0) === 0) {
          purgeIndexArtifacts(conn, current.resourceId);
          vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.purgeNoteResourceRowWithConn(conn, current.resourceId));
          notesLog.debug(`[VFS::NoteRepo] Deleted superseded resource ${current.resourceId} for note ${id}`);
        }
      }
      if (newResourceId !== null && params.content !== undefined && params.content !== null) {
        this.replaceNoteLinks(conn, id, extractNoteLinks(params.content));
      }
      noteRevisionRepository.snapshot(conn, id, formatUpgrade !== null ? 'format_migration' : 'edit');
      noteRelationRepository.invalidateMissingBlocks(conn, id);
      updated = {
        id, resourceId: finalResourceId, title: newTitle, tags: newTags,
        isFavorite: current.isFavorite, createdAt: current.createdAt, updatedAt: now,
        deletedAt: null, props: current.props,
      };
    } catch (error) {
      try {
        conn.exec('ROLLBACK TO update_note; RELEASE update_note');
      } catch (rollbackError) {
        notesLog.warnError('[VFS::NoteRepo] update_note rollback failed', rollbackError);
      }
      throw error;
    }
    // note_repo.rs:885-901: a failed RELEASE is returned without rollback.
    try {
      conn.exec('RELEASE update_note');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notesLog.error(`[VFS::NoteRepo] Failed to release savepoint update_note: ${message}`);
      databaseFailure(`Failed to release savepoint: ${message}`);
    }
    return updated;
  },

  updateNoteMetadata(id: string, update: NoteMetadataUpdate, conn?: SqlExecutor): VfsNote {
    return this.updateNoteMetadataWithConn(connection(conn), id, update);
  },

  updateNoteMetadataWithConn(conn: SqlExecutor, id: string, update: NoteMetadataUpdate): VfsNote {
    return noteRevisionRepository.transaction(conn, () => {
      const documentUpdate = update.title != null || update.tags != null || update.props !== undefined;
      if (documentUpdate) noteRevisionRepository.snapshot(conn, id, 'baseline');
      const note = this.updateNoteMetadataUncommitted(conn, id, update);
      if (documentUpdate) noteRevisionRepository.snapshot(conn, id, 'metadata');
      return note;
    });
  },

  updateNoteMetadataUncommitted(conn: SqlExecutor, id: string, update: NoteMetadataUpdate): VfsNote {
    if (update.title !== undefined && update.title !== null) validateTitle(update.title);
    if (update.tags !== undefined && update.tags !== null) validateTags(update.tags);
    const normalized = update.props === undefined ? undefined : normalizeNoteProps(update.props);
    const current = this.getNote(id, conn);
    if (current === null) notFound('Note', id);
    const expected = update.expectedUpdatedAt == null ? null : rustTrim(update.expectedUpdatedAt) || null;
    if (expected !== null && expected !== current.updatedAt) {
      throw new NoteDocumentError('conflict', 'The note has been updated elsewhere, please refresh.', 'notes.conflict');
    }
    if (update.title == null && update.tags == null && update.isFavorite == null && normalized === undefined) return current;
    const now = nextUpdatedAt(current.updatedAt);
    const assignments: string[] = [];
    const values: SqlParam[] = [];
    const push = (column: string, value: SqlParam) => {
      values.push(value);
      assignments.push(`${column} = ?${values.length}`);
    };
    if (update.title != null) push('title', update.title);
    if (update.tags != null) push('tags', JSON.stringify(update.tags));
    if (update.isFavorite != null) push('is_favorite', update.isFavorite ? 1 : 0);
    if (normalized !== undefined) push('props', normalized.raw);
    push('updated_at', now);
    values.push(id);
    let sql = `UPDATE notes SET ${assignments.join(', ')} WHERE id = ?${values.length} AND deleted_at IS NULL`;
    if (expected !== null) {
      values.push(expected);
      sql += ` AND updated_at = ?${values.length}`;
    }
    const changed = conn.run(sql, values).changes;
    if (changed === 0) {
      if (expected !== null) throw new NoteDocumentError('conflict', 'The note has been updated elsewhere, please refresh.', 'notes.conflict');
      notFound('Note', id);
    }
    const updated = this.getNote(id, conn);
    if (updated === null) notFound('Note', id);
    return updated;
  },

  setNoteProps(id: string, props: unknown, conn?: SqlExecutor): VfsNote {
    return this.updateNoteMetadataWithConn(connection(conn), id, { props });
  },

  listNotes(search: string | null, limit: number, offset: number, conn?: SqlExecutor): VfsNote[] {
    const executor = connection(conn);
    if (search !== null && rustTrim(search).length > 0) {
      const fts = this.searchNotesFts(executor, search, limit, offset);
      if (fts.length > 0) return fts;
    }
    if (search !== null) {
      const pattern = `%${escapeLikePattern(search)}%`;
      return executor.all<NoteRow>(
        `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
         FROM notes n WHERE n.deleted_at IS NULL
           AND (n.title LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM resources r WHERE r.id=n.resource_id AND r.data LIKE ?1 ESCAPE '\\'))
         ORDER BY n.updated_at DESC LIMIT ?2 OFFSET ?3`, [pattern, limit, offset]).map(rowToNote);
    }
    return executor.all<NoteRow>(
      `SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
       FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset]).map(rowToNote);
  },

  searchNotesFts(conn: SqlExecutor, keyword: string, limit: number, offset: number): VfsNote[] {
    const match = buildFtsMatchQuery(keyword);
    if (match === null) return [];
    try {
      return conn.all<NoteRow>(
        `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC LIMIT ?2 OFFSET ?3`,
        [match, limit, offset]).map(rowToNote);
    } catch (error) {
      notesLog.warn(`[VFS::NoteRepo] FTS list search failed (${String(error)}), falling back to LIKE`);
      return [];
    }
  },

  searchNotesWithSnippets(keyword: string, limit: number, conn?: SqlExecutor): Array<[VfsNote, string | null]> {
    const executor = connection(conn);
    const trimmed = rustTrim(keyword);
    if (trimmed.length === 0) return [];
    const match = buildFtsMatchQuery(trimmed);
    if (match !== null) {
      try {
        const rows = executor.all<HitRow>(
          `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at,
             COALESCE(r.data, '') AS body, n.props
           FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
           LEFT JOIN resources r ON r.id = n.resource_id
           WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
           ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC LIMIT ?2`, [match, limit]);
        if (rows.length > 0) return rows.map((row) => hit(row, trimmed));
      } catch (error) {
        notesLog.warn(`[VFS::NoteRepo] FTS search failed (${String(error)}), falling back to LIKE`);
      }
    }
    const pattern = `%${escapeLikePattern(trimmed)}%`;
    return executor.all<HitRow>(
      `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at,
         COALESCE(r.data, '') AS body, n.props
       FROM notes n LEFT JOIN resources r ON r.id=n.resource_id
       WHERE n.deleted_at IS NULL AND (n.title LIKE ?1 ESCAPE '\\' OR COALESCE(r.data, '') LIKE ?1 ESCAPE '\\')
       ORDER BY n.updated_at DESC LIMIT ?2`, [pattern, limit]).map((row) => hit(row, trimmed));
  },

  searchNotesByTags(keyword: string | null, tags: readonly string[], limit: number, conn?: SqlExecutor): Array<[VfsNote, string | null]> {
    const executor = connection(conn);
    const lowered = [...new Set(tags.map((tag) => rustTrim(tag).toLowerCase()).filter((tag) => tag.length > 0))].sort();
    if (lowered.length === 0) {
      return keyword !== null && rustTrim(keyword).length > 0 ? this.searchNotesWithSnippets(keyword, limit, executor) : [];
    }
    const trimmedKeyword = keyword === null ? null : rustTrim(keyword) || null;
    const placeholders = lowered.map(() => '?').join(',');
    let sql = `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at,
        COALESCE(r.data, '') AS body, n.props
      FROM notes n JOIN note_tags nt ON nt.note_id=n.id LEFT JOIN resources r ON r.id=n.resource_id
      WHERE n.deleted_at IS NULL AND LOWER(nt.tag) IN (${placeholders})`;
    const values: SqlParam[] = [...lowered];
    if (trimmedKeyword !== null) {
      const match = buildFtsMatchQuery(trimmedKeyword);
      if (match !== null) {
        sql += ' AND n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)';
        values.push(match);
      } else {
        const pattern = `%${escapeLikePattern(trimmedKeyword)}%`;
        sql += " AND (n.title LIKE ? ESCAPE '\\' OR COALESCE(r.data, '') LIKE ? ESCAPE '\\')";
        values.push(pattern, pattern);
      }
    }
    sql += ' GROUP BY n.id HAVING COUNT(DISTINCT LOWER(nt.tag)) = ? ORDER BY n.updated_at DESC, n.id ASC LIMIT ?';
    values.push(lowered.length, limit);
    const snippetKeyword = trimmedKeyword ?? '';
    return executor.all<HitRow>(sql, values).map((row) => hit(row, snippetKeyword));
  },

  noteIdsWithAllTags(tags: readonly string[], conn?: SqlExecutor): string[] {
    const lowered = [...new Set(tags.map((tag) => rustTrim(tag).toLowerCase()).filter((tag) => tag.length > 0))].sort();
    if (lowered.length === 0) return [];
    const placeholders = lowered.map(() => '?').join(',');
    return connection(conn).all<{ note_id: string }>(
      `SELECT nt.note_id FROM note_tags nt JOIN notes n ON n.id=nt.note_id AND n.deleted_at IS NULL
       WHERE LOWER(nt.tag) IN (${placeholders})
       GROUP BY nt.note_id HAVING COUNT(DISTINCT LOWER(nt.tag)) = ?`,
      [...lowered, lowered.length]).map((row) => row.note_id);
  },

  searchNoteTitles(keyword: string, limit: number, conn?: SqlExecutor): VfsNote[] {
    const trimmed = rustTrim(keyword);
    if (trimmed.length === 0) return [];
    const escaped = escapeLikePattern(trimmed);
    return connection(conn).all<NoteRow>(
      `SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
       FROM notes WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\\'
       ORDER BY CASE WHEN title LIKE ?2 ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(title) ASC, updated_at DESC LIMIT ?3`,
      [`%${escaped}%`, `${escaped}%`, limit]).map(rowToNote);
  },

  listTags(limit: number, conn?: SqlExecutor): string[] {
    const executor = connection(conn);
    try {
      const tags = executor.all<{ tag: string }>(
        `SELECT nt.tag FROM note_tags nt JOIN notes n ON n.id=nt.note_id AND n.deleted_at IS NULL
         GROUP BY nt.tag ORDER BY COUNT(*) DESC, nt.tag ASC LIMIT ?1`, [limit]).map((row) => row.tag);
      if (tags.length > 0) return tags;
    } catch (error) {
      notesLog.warn(`[VFS::NoteRepo] note_tags query failed (${String(error)}), falling back to JSON scan`);
    }
    const counts = new Map<string, number>();
    for (const row of executor.all<{ tags: string }>('SELECT tags FROM notes WHERE deleted_at IS NULL')) {
      let tags: string[] = [];
      try {
        const parsed = decodeJson(row.tags);
        if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) tags = parsed;
      } catch {
        tags = [];
      }
      for (const tag of tags) {
        const trimmed = rustTrim(tag);
        if (trimmed.length === 0) continue;
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([tag]) => tag);
  },

  deleteNote(id: string, conn?: SqlExecutor): void {
    const executor = connection(conn);
    // 与保存路径共用同一写屏障：活动编辑租约（或冻结中的写屏障）下拒绝软删除，
    // 否则正在编辑的草稿会被静默删除。
    checkLeaseWrite(executor, id);
    const now = toRfc3339Opts(nowEpochNanos(), 'Millis', true);
    const changed = executor.run('UPDATE notes SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL', [now, id]).changes;
    if (changed > 0) return;
    const exists = executor.get<{ present: number }>('SELECT 1 AS present FROM notes WHERE id=?1', [id]);
    if (exists !== undefined) return;
    notFound('Note', id);
  },

  /**
   * note_repo.rs::delete_note_if_version: OCC soft delete. Already-deleted rows
   * are idempotent; a live row with a different revision is a conflict.
   */
  deleteNoteIfVersion(id: string, expectedUpdatedAt: string, conn?: SqlExecutor): void {
    const executor = connection(conn);
    const now = nextUpdatedAt(expectedUpdatedAt);
    const changed = executor.run(
      'UPDATE notes SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL AND updated_at=?3',
      [now, id, expectedUpdatedAt],
    ).changes;
    if (changed === 1) return;
    const state = executor.get<{ updated_at: string; deleted_at: string | null }>(
      'SELECT updated_at, deleted_at FROM notes WHERE id=?1', [id]);
    if (state === undefined) notFound('Note', id);
    if (state.deleted_at !== null) return;
    throw new NoteDocumentError(
      'conflict',
      `The note changed before deletion (expected ${expectedUpdatedAt}, actual ${state.updated_at}).`,
      'notes.conflict',
    );
  },

  deleteNoteWithFolderItem(id: string, conn?: SqlExecutor): void {
    const executor = connection(conn);
    executor.exec('SAVEPOINT delete_note_with_folder_item');
    try {
      this.deleteNote(id, executor);
      const nowStr = toRfc3339Opts(nowEpochNanos(), 'Millis', true);
      vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.softDeleteNoteMembershipsWithConn(executor, id, nowStr, Date.now()));
      const resource = executor.get<{ resource_id: string }>('SELECT resource_id FROM notes WHERE id=?1', [id]);
      if (resource !== undefined) {
        const disabled = vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.disableNoteUnitsWithConn(executor, resource.resource_id));
        if (disabled > 0) notesLog.info(`[VFS::NoteRepo] Disabled ${disabled} index units for soft-deleted note ${id} (resource=${resource.resource_id})`);
      }
      notesLog.debug(`[VFS::NoteRepo] Soft deleted note ${id} and its folder_items`);
      executor.exec('RELEASE delete_note_with_folder_item');
    } catch (error) {
      try {
        executor.exec('ROLLBACK TO delete_note_with_folder_item; RELEASE delete_note_with_folder_item');
      } catch (rollbackError) {
        notesLog.warnError('[VFS::NoteRepo] delete_note_with_folder_item rollback failed', rollbackError);
      }
      throw error;
    }
  },

  restoreNote(id: string, conn?: SqlExecutor): void {
    const executor = connection(conn);
    const note = this.getNoteIncludingDeleted(id, executor);
    if (note === null) notFound('Note', id);
    noteTransaction(executor, () => this.restoreNoteWithConn(executor, id));
    try {
      markIndexPending(executor, note.resourceId);
    } catch (error) {
      notesLog.warn(`[VfsNoteRepo] Failed to mark note for re-indexing after restore: ${String(error)}`);
    }
  },

  restoreNoteWithConn(conn: SqlExecutor, id: string): void {
    const now = toRfc3339Opts(nowEpochNanos(), 'Millis', true);
    const nowMs = Date.now();
    const note = this.getNoteIncludingDeleted(id, conn);
    if (note === null) notFound('Note', id);
    noteRevisionRepository.snapshot(conn, id, 'baseline');
    let restoredTitle: string | null = null;
    for (let index = 0; index < 1000; index += 1) {
      const candidate = index === 0 ? note.title : `${note.title} (${index})`;
      const changed = conn.run(`UPDATE notes SET deleted_at=NULL, title=?1, updated_at=?2
        WHERE id=?3 AND deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM notes WHERE title=?1 AND deleted_at IS NULL AND id != ?3)`,
      [candidate, now, id]).changes;
      if (changed === 1) { restoredTitle = candidate; break; }
      const stillDeleted = conn.get<{ present: number }>('SELECT 1 AS present FROM notes WHERE id=?1 AND deleted_at IS NOT NULL', [id]);
      if (stillDeleted === undefined) notFound('Note', id);
    }
    if (restoredTitle === null) throw new NoteDocumentError('conflict', `恢复笔记失败：标题冲突重试次数过多 (${id})`, 'note.restore.title_conflict');
    vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.restoreLatestDeletedNoteMembershipWithConn(conn, id, nowMs));
    noteRevisionRepository.snapshot(conn, id, 'trash_restore');
  },

  generateUniqueNoteTitle(conn: SqlExecutor, baseTitle: string, excludeId: string | null): string {
    if (!this.noteTitleExists(conn, baseTitle, excludeId)) return baseTitle;
    for (let index = 1; index < 100; index += 1) {
      const candidate = `${baseTitle} (${index})`;
      if (!this.noteTitleExists(conn, candidate, excludeId)) return candidate;
    }
    return `${baseTitle} (${Date.now()})`;
  },

  noteTitleExists(conn: SqlExecutor, title: string, excludeId: string | null): boolean {
    const row = excludeId === null
      ? conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE title=?1 AND deleted_at IS NULL', [title])
      : conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE title=?1 AND deleted_at IS NULL AND id != ?2', [title, excludeId]);
    return Number(row?.count ?? 0) > 0;
  },

  purgeNote(id: string, conn?: SqlExecutor): void {
    this.purgeNoteWithConn(connection(conn), id);
  },

  purgeNoteWithConn(conn: SqlExecutor, id: string): void {
    const note = this.getNoteIncludingDeleted(id, conn);
    if (note === null) {
      const removed = vfsRepoCall(() => noteResourceRepos().folders.removeItemByItemId(conn, 'note', id));
      if (removed) return;
      notFound('Note', id);
    }
    conn.exec('SAVEPOINT vfs_note_purge_tx');
    try {
      vfsRepoCall(() => noteResourceRepos().folders.removeItemByItemId(conn, 'note', id));
      const deleted = conn.run('DELETE FROM notes WHERE id=?1', [id]).changes;
      if (deleted === 0) databaseFailure(`Note record disappeared during deletion: ${id}. This may indicate a race condition.`);
      const resourceIds = new Set<string>([note.resourceId]);
      for (const row of conn.all<{ id: string }>("SELECT id FROM resources WHERE source_id=?1 AND source_table='notes'", [id])) {
        resourceIds.add(row.id);
      }
      for (const resourceId of resourceIds) {
        const refs = conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE resource_id=?1', [resourceId]);
        if (Number(refs?.count ?? 0) > 0) continue;
        purgeIndexArtifacts(conn, resourceId);
        vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.purgeNoteResourceRowWithConn(conn, resourceId));
      }
      conn.exec('RELEASE vfs_note_purge_tx');
    } catch (error) {
      try {
        conn.exec('ROLLBACK TO vfs_note_purge_tx; RELEASE vfs_note_purge_tx');
      } catch (rollbackError) {
        notesLog.warnError('[VFS::NoteRepo] purge rollback failed', rollbackError);
      }
      if (error instanceof NoteDocumentError || error instanceof Error) throw error;
      databaseFailure(String(error));
    }
  },

  purgeNoteWithFolderItem(id: string, conn?: SqlExecutor): void {
    const executor = connection(conn);
    this.purgeNoteWithConn(executor, id);
    vfsRepoCall(() => noteResourceRepos().folders.removeItemByItemId(executor, 'note', id));
  },

  deletedNoteIds(conn?: SqlExecutor): string[] {
    return connection(conn)
      .all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL')
      .map((row) => row.id);
  },

  /** D1 seam: caller supplies the transaction/executor; SQL stays in this owner. */
  purgeDeletedNotesWithConn(conn: SqlExecutor): number {
    return this.purgeDeletedNotes(conn);
  },

  purgeDeletedNotes(conn?: SqlExecutor): number {
    const executor = connection(conn);
    const ids = executor.all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL').map((row) => row.id);
    if (ids.length === 0) return 0;
    return noteTransaction(executor, () => {
      let deleted = 0;
      for (const id of ids) {
        this.purgeNoteWithConn(executor, id);
        deleted += 1;
      }
      return deleted;
    });
  },

  setFavorite(id: string, favorite: boolean, conn?: SqlExecutor): void {
    connection(conn).run('UPDATE notes SET is_favorite=?1, updated_at=?2 WHERE id=?3',
      [favorite ? 1 : 0, toRfc3339Opts(nowEpochNanos(), 'Millis', true), id]);
  },

  listDeletedNotes(limit: number, offset: number, conn?: SqlExecutor): VfsNote[] {
    return connection(conn).all<NoteRow>(
      `SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
       FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset]).map(rowToNote);
  },

  countDeletedNotes(conn?: SqlExecutor): number {
    return Number(connection(conn).get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE deleted_at IS NOT NULL')?.count ?? 0);
  },

  createNoteInFolder(params: { title: string; content: string; tags?: string[] }, folderId: string | null, conn?: SqlExecutor): VfsNote {
    const executor = connection(conn);
    return noteTransaction(executor, () => this.createNoteInFolderUncommitted(executor, params, folderId));
  },

  createNoteInFolderUncommitted(conn: SqlExecutor, params: { title: string; content: string; tags?: string[] }, folderId: string | null): VfsNote {
    // note_repo.rs delegates folder validation and membership to VfsFolderRepo.
    if (folderId !== null && !vfsRepoCall(() => noteResourceRepos().folders.folderExists(conn, folderId))) {
      notFound('Folder', folderId);
    }
    const note = this.createNoteWithConn(conn, params);
    vfsRepoCall(() => noteResourceRepos().folders.addItemToFolder(conn, {
      id: `fi_${nanoid(10)}`,
      ...(folderId === null ? {} : { folderId }),
      itemType: 'note',
      itemId: note.id,
      sortOrder: 0,
      createdAt: Date.now(),
    }));
    return note;
  },

  listNotesByFolder(folderId: string | null, limit: number, offset: number, conn?: SqlExecutor): VfsNote[] {
    return connection(conn).all<NoteRow>(
      `SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
       FROM notes n JOIN folder_items fi ON fi.item_type='note' AND fi.item_id=n.id
       WHERE fi.folder_id IS ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
       GROUP BY n.id ORDER BY MIN(fi.sort_order) ASC, n.updated_at DESC LIMIT ?2 OFFSET ?3`,
      [folderId, limit, offset]).map(rowToNote);
  },

  getNoteLocation(id: string, conn?: SqlExecutor): ResourceLocation | null {
    const executor = connection(conn);
    const location = vfsRepoCall(
      () => noteResourceRepos().folders.getResourceLocation(executor, 'note', id));
    if (location === null) return null;
    // The published L11 shape omits optional fields; the IPC contract requires
    // explicit nulls (serde \`Option\` serializes to null).
    return {
      id: location.id,
      resourceType: location.resourceType,
      folderId: location.folderId ?? null,
      folderPath: location.folderPath,
      fullPath: location.fullPath,
      hash: location.hash ?? null,
    };
  },

  replaceNoteLinks(conn: SqlExecutor, sourceId: string, parsed: readonly ParsedNoteLink[]): number {
    conn.exec('SAVEPOINT replace_note_links');
    try {
      conn.run('DELETE FROM note_links WHERE source_id=?1', [sourceId]);
      let written = 0;
      for (const link of parsed) {
        const target = rustTrim(link.raw_target);
        if (target.length === 0) continue;
        let resolved: { id: string; title: string } | undefined;
        if (link.kind === 'noteref' || target.startsWith('note_')) {
          resolved = conn.get<{ id: string; title: string }>('SELECT id, title FROM notes WHERE id=?1 AND deleted_at IS NULL', [target]);
        }
        if (resolved === undefined && link.kind === 'wikilink') {
          resolved = conn.get<{ id: string; title: string }>(
            'SELECT id, title FROM notes WHERE deleted_at IS NULL AND title=?1 COLLATE NOCASE ORDER BY id ASC LIMIT 1', [target]);
        }
        const targetId = resolved?.id ?? null;
        const displayTitle = resolved?.title ?? target;
        conn.run(`INSERT OR REPLACE INTO note_links
          (source_id, position, target_id, target_title, target_title_norm, heading, alias, link_type)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        [sourceId, link.position, targetId, displayTitle, rustTrim(displayTitle).toLowerCase(), link.heading, link.alias, link.kind]);
        written += 1;
      }
      conn.exec('RELEASE replace_note_links');
      return written;
    } catch (error) {
      try {
        conn.exec('ROLLBACK TO replace_note_links; RELEASE replace_note_links');
      } catch (rollbackError) {
        notesLog.warnError('[VFS::NoteRepo] replace_note_links rollback failed', rollbackError);
      }
      throw error;
    }
  },

  replaceNoteLinksFromContent(sourceId: string, content: string, conn?: SqlExecutor): number {
    return this.replaceNoteLinks(connection(conn), sourceId, extractNoteLinks(content));
  },

  backlinksFor(id: string, conn?: SqlExecutor): NoteBacklink[] {
    const executor = connection(conn);
    const note = this.getNote(id, executor);
    if (note === null) notFound('Note', id);
    return executor.all<{
      source_id: string; title: string; heading: string | null; alias: string | null; position: number; updated_at: string;
    }>(`SELECT l.source_id, n.title, l.heading, l.alias, l.position, n.updated_at
       FROM note_links l JOIN notes n ON n.id=l.source_id AND n.deleted_at IS NULL
       WHERE l.source_id != ?1 AND (l.target_id=?1 OR (l.target_id IS NULL AND l.target_title_norm=?2))
       ORDER BY n.updated_at DESC, l.source_id ASC, l.position ASC`, [id, rustTrim(note.title).toLowerCase()])
      .map((row) => ({
        sourceId: row.source_id, sourceTitle: row.title, heading: row.heading, alias: row.alias,
        position: Number(row.position), sourceUpdatedAt: row.updated_at,
      }));
  },

  outgoingLinksFor(id: string, conn?: SqlExecutor): NoteOutgoingLink[] {
    return connection(conn).all<{
      target_id: string | null; target_title: string; heading: string | null; alias: string | null;
      position: number; link_type: string; resolved: number;
    }>(`SELECT l.target_id, COALESCE(t.title, l.target_title) AS target_title, l.heading, l.alias,
         l.position, l.link_type, (t.id IS NOT NULL) AS resolved
       FROM note_links l LEFT JOIN notes t ON t.id=l.target_id AND t.deleted_at IS NULL
       WHERE l.source_id=?1 ORDER BY l.position ASC`, [id])
      .map((row) => ({
        targetId: row.target_id, targetTitle: row.target_title, heading: row.heading,
        alias: row.alias, position: Number(row.position), linkType: row.link_type,
        resolved: Number(row.resolved) !== 0,
      }));
  },

  unresolvedLinks(limit: number, conn?: SqlExecutor): NoteUnresolvedLink[] {
    return connection(conn).all<{
      source_id: string; title: string; target_title: string; heading: string | null;
      alias: string | null; position: number; link_type: string;
    }>(`SELECT l.source_id, n.title, l.target_title, l.heading, l.alias, l.position, l.link_type
       FROM note_links l JOIN notes n ON n.id=l.source_id AND n.deleted_at IS NULL
       WHERE l.target_id IS NULL
       ORDER BY l.target_title_norm ASC, n.updated_at DESC, l.position ASC LIMIT ?1`, [limit])
      .map((row) => ({
        sourceId: row.source_id, sourceTitle: row.title, targetTitle: row.target_title,
        heading: row.heading, alias: row.alias, position: Number(row.position), linkType: row.link_type,
      }));
  },

  unlinkedMentionCandidates(id: string, limit: number, conn?: SqlExecutor): Array<[VfsNote, string | null]> {
    const executor = connection(conn);
    const note = this.getNote(id, executor);
    if (note === null) notFound('Note', id);
    const title = rustTrim(note.title);
    if (title.length === 0 || charCount(title) < 2) return [];
    const linked = new Set(executor.all<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM note_links WHERE target_id=?1 OR (target_id IS NULL AND target_title_norm=?2)`,
      [id, title.toLowerCase()]).map((row) => row.source_id));
    const fetch = Math.min(200, Math.max(limit, limit * 3));
    return this.searchNotesWithSnippets(title, fetch, executor)
      .filter(([candidate]) => candidate.id !== id && !linked.has(candidate.id))
      .slice(0, limit);
  },

  rebuildNoteLinks(batchSize: number): { noteCount: number; linkCount: number } {
    const executor = connection();
    const size = Math.min(2000, Math.max(1, batchSize));
    let lastId = '';
    let noteCount = 0;
    let linkCount = 0;
    for (;;) {
      const batch = executor.all<{ id: string; content: string }>(
        `SELECT n.id, COALESCE(r.data, '') AS content FROM notes n LEFT JOIN resources r ON r.id=n.resource_id
         WHERE n.deleted_at IS NULL AND n.id > ?1 ORDER BY n.id ASC LIMIT ?2`, [lastId, size]);
      if (batch.length === 0) break;
      // Rust uses BEGIN IMMEDIATE per batch (not a savepoint): the rebuild owns
      // its connection and must take the write lock before parsing the batch.
      executor.exec('BEGIN IMMEDIATE');
      try {
        let written = 0;
        for (const item of batch) written += this.replaceNoteLinks(executor, item.id, extractNoteLinks(item.content));
        executor.exec('COMMIT');
        linkCount += written;
      } catch (error) {
        try {
          executor.exec('ROLLBACK');
        } catch (rollbackError) {
          notesLog.warnError('[VFS::NoteRepo] rebuild_note_links rollback failed', rollbackError);
        }
        throw error;
      }
      noteCount += batch.length;
      lastId = batch[batch.length - 1]!.id;
    }
    return { noteCount, linkCount };
  },

  backfillNoteLinksOnce(batchSize: number): boolean {
    const executor = connection();
    const done = executor.get<{ value: string }>("SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'");
    if (done?.value === 'true') return false;
    const { noteCount, linkCount } = this.rebuildNoteLinks(batchSize);
    vfsRepoCall(() => noteResourceRepos().noteOwnerWrites.markNoteLinksBackfillDoneWithConn(executor, Date.now()));
    notesLog.info(`[VFS::NoteRepo] One-time note links backfill done: ${noteCount} notes, ${linkCount} links`);
    return true;
  },
};

export { makeSearchSnippet, buildFtsMatchQuery, rowToNote };
