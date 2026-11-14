// dstu-sync/data_governance/sync/note_history.rs: sync-only note writes.
// L20 may only reach these through the public `notes.sync` service.
import type { NoteFormat } from '../api.ts';
import {
  defineQuery, type SqlExecutor, type SqlParam, type SqlValue,
} from '../../../platform/storage/api.ts';
import {
  dbJsonEquals, isJsonFloat, parseJsonLossless, stringifyJsonLossless, type DbJson,
} from '../../../platform/util/lossless-json.ts';
import { decodeBase64Standard } from '../../../platform/util/base64-core.ts';
import { NoteDatabaseError } from './errors.ts';
import { decodeJson, NoteSerializationError } from './json.ts';
import { noteFormatRepository } from './format.ts';
import { noteRelationRepository } from './relations.ts';
import { noteTransaction } from './transaction.ts';

const I64_MAX = 9_223_372_036_854_775_807n;
const SYNC_FIELD_DELTAS_KEY = '__sync_field_deltas';

/** F3 precise reads: i64 columns beyond 2^53 stay exact, never round-trip through Number. */
const revisionRowQuery = defineQuery<readonly [string], Record<string, SqlValue>>(
  'SELECT * FROM note_document_revisions WHERE version_id=?1',
  { name: 'notes.sync.revisionRow', options: { safeIntegers: true } },
);
const relationRevisionQuery = defineQuery<readonly [string], { revision: bigint }>(
  'SELECT revision FROM note_learning_relations WHERE id=?1',
  { name: 'notes.sync.relationRevision', options: { safeIntegers: true } },
);

function databaseError(message: string): never {
  throw new NoteDatabaseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tableHasColumn(conn: SqlExecutor, table: string, column: string): boolean {
  return Number(conn.pluck<number>(
    'SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2', [table, column]) ?? 0) !== 0;
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\u0000')) {
    databaseError('字段名不能为空或包含 NUL');
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function jsonParam(value: unknown): SqlParam {
  if (value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'bigint' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return value;
  if (isJsonFloat(value)) return value.value;
  if (Array.isArray(value) || isRecord(value)) {
    if (isRecord(value) && Object.keys(value).length === 1
      && typeof value.$dsblob === 'string') {
      const decoded = decodeBase64Standard(value.$dsblob);
      if (decoded.error !== undefined) databaseError(`字段的 blob 编码无效: ${decoded.error}`);
      return decoded.bytes;
    }
    return stringifyJsonLossless(value as DbJson);
  }
  databaseError('字段的 JSON 值无法转换为 SQLite 参数');
}

/** `Buffer.compare(a, b) === 0`（同长度 + 逐字节相等）。 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** serde_json equality for local SQLite values versus incoming wire JSON. */
function jsonEquals(left: SqlValue | undefined, right: unknown): boolean {
  if (left instanceof Uint8Array) {
    return right instanceof Uint8Array && bytesEqual(left, right);
  }
  return dbJsonEquals(left as DbJson | undefined, right as DbJson | undefined);
}

/**
 * `*_json` columns compare by parsed value, as serde_json does in Rust.
 * Both sides use L20's lossless parser: JSON.parse would collapse
 * 9007199254740992 and 9007199254740993 into the same Number.
 */
function jsonFieldEquals(left: SqlValue | undefined, right: unknown): boolean {
  const parse = (value: unknown): DbJson => {
    if (typeof value !== 'string') return value === undefined ? null : value as DbJson;
    try {
      return parseJsonLossless(value);
    } catch (error) {
      databaseError(error instanceof Error ? error.message : String(error));
    }
  };
  return dbJsonEquals(parse(left), parse(right));
}

interface NoteLocator {
  type: 'whole' | 'block' | 'page' | 'card' | 'question';
  value?: string | number;
}

function parseNoteLocator(raw: string): NoteLocator {
  const parsed = decodeJson(raw);
  if (!isRecord(parsed)) throw new NoteSerializationError('invalid type: expected enum NoteLocator');
  const type = parsed.type;
  if (type === 'whole') return { type };
  if (type === 'block' || type === 'card' || type === 'question') {
    if (typeof parsed.value !== 'string') {
      throw new NoteSerializationError('invalid type: expected a string');
    }
    return { type, value: parsed.value };
  }
  if (type === 'page') {
    const value = parsed.value;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new NoteSerializationError('invalid type: expected u32');
    }
    return { type, value };
  }
  throw new NoteSerializationError(
    'unknown variant, expected one of `whole`, `block`, `page`, `card`, `question`');
}

function parsePin(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === 0n) return false;
  if (value === true || value === 1 || value === 1n) return true;
  databaseError('Invalid history pin');
}

function parseStringArray(value: string): string[] {
  const parsed = decodeJson(value);
  if (!Array.isArray(parsed)) throw new NoteSerializationError('invalid type: expected a sequence');
  return parsed.map((item) => {
    if (typeof item !== 'string') throw new NoteSerializationError('invalid type: expected a string');
    return item;
  });
}

function parseAssetRefs(value: string): void {
  const parsed = decodeJson(value);
  if (!Array.isArray(parsed)) throw new NoteSerializationError('invalid type: expected a sequence');
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.kind !== 'string' || typeof item.value !== 'string') {
      throw new NoteSerializationError('invalid type: expected struct NoteAssetRef');
    }
  }
}

/** note_history.rs::prepare_relation; rewrites the sender CAS value from local state. */
function prepareRelation(conn: SqlExecutor, id: string, data: Record<string, unknown>): void {
  const rawLocator = data.locator_json;
  if (typeof rawLocator !== 'string') databaseError('Relation locator missing');
  const locator = parseNoteLocator(rawLocator);
  const kind = data.relation_type;
  if (typeof kind !== 'string') databaseError('Relation type missing');
  if ((kind !== 'source' && kind !== 'card' && kind !== 'mistake')
    || (kind === 'card' && locator.type !== 'card')
    || (kind === 'mistake' && locator.type !== 'question')) {
    databaseError('Relation type/locator mismatch');
  }
  const row = conn.get(relationRevisionQuery, [id]);
  const current = row === undefined ? 0n : BigInt(row.revision);
  const revision = current + 1n;
  if (revision > I64_MAX) databaseError('Relation revision exhausted');
  // Negative i64 revisions are legal (no CHECK); only the two-sided safe range may become Number.
  data.revision = revision >= BigInt(Number.MIN_SAFE_INTEGER) && revision <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(revision) : revision;
}

/** note_history.rs::retarget_note_relations; one savepoint for retarget + block invalidation. */
function retargetNoteRelations(conn: SqlExecutor, noteId: string, previous: string): void {
  if (!tableHasColumn(conn, 'note_learning_relations', 'revision')) return;
  noteTransaction(conn, () => {
    const note = conn.get<{ resource_id: string; updated_at: string }>(
      'SELECT resource_id,updated_at FROM notes WHERE id=?1', [noteId]);
    if (note === undefined) databaseError('Query returned no rows');
    if (note.resource_id !== previous) {
      conn.run(`UPDATE note_learning_relations SET resource_id=?1,revision=revision+1,updated_at=MAX(updated_at,?2)
        WHERE resource_id=?3 AND json_extract(locator_json,'$.type')!='card'`,
      [note.resource_id, note.updated_at, previous]);
    }
    const active = conn.get<{ active: number | boolean }>(
      'SELECT deleted_at IS NULL AS active FROM notes WHERE id=?1', [noteId]);
    if (active === undefined) databaseError('Query returned no rows');
    if (Number(active.active) !== 0) noteRelationRepository.invalidateMissingBlocks(conn, noteId);
  });
}

/** note_history.rs::apply_revision; immutable identity, pin upgrade only. */
function applyRevision(conn: SqlExecutor, id: string, data: unknown): void {
  if (!isRecord(data)) databaseError('Invalid history object');
  const obj: Record<string, unknown> = { ...data };
  if (obj.version_id !== id) databaseError('History version identity mismatch');
  const incomingPin = parsePin(obj.pinned);
  for (const key of ['seq', 'pinned', 'edit_bucket', SYNC_FIELD_DELTAS_KEY]) delete obj[key];

  for (const key of [
    'note_id', 'title', 'content_md', 'tags_json', 'asset_refs_json',
    'source', 'created_at', 'content_format', 'serializer_version',
  ]) {
    if (typeof obj[key] !== 'string') databaseError(`History field missing: ${key}`);
  }
  const formatVersion = obj.format_version;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    databaseError('History format version missing');
  }
  const format: NoteFormat = {
    note_id: obj.note_id as string,
    content_format: obj.content_format as string,
    format_version: formatVersion,
    serializer_version: obj.serializer_version as string,
    baseline_version_id: null,
  };
  noteFormatRepository.ensureSupported(format);
  const detected = noteFormatRepository.detect(format.note_id, obj.content_md as string);
  if (detected.content_format !== format.content_format) {
    databaseError('History format/body mismatch');
  }
  if (noteFormatRepository.requiredCapabilities(detected).length > 0
    && noteFormatRepository.requiredCapabilities(format).length === 0) {
    databaseError('History envelope lacks required columns capability');
  }
  // Validate JSON before insert so a malformed row cannot poison reads/restores.
  parseStringArray(obj.tags_json as string);
  parseAssetRefs(obj.asset_refs_json as string);
  if (typeof obj.props_json === 'string') decodeJson(obj.props_json);

  const local = conn.get(revisionRowQuery, [id]);
  if (local !== undefined) {
    for (const [key, value] of Object.entries(obj)) {
      const equal = key.endsWith('_json')
        ? jsonFieldEquals(local[key], value)
        : jsonEquals(local[key], value);
      if (!equal) databaseError(`Immutable history conflict: ${id} (${key})`);
    }
    if (incomingPin) {
      conn.run('UPDATE note_document_revisions SET pinned=1 WHERE version_id=?1 AND pinned=0', [id]);
    }
    return;
  }

  obj.edit_bucket = 0;
  obj.pinned = incomingPin;
  const columns = Object.keys(obj);
  const sql = `INSERT INTO note_document_revisions (${columns.map(quoteIdentifier).join(',')})
    VALUES (${columns.map((_, index) => `?${index + 1}`).join(',')})`;
  conn.run(sql, columns.map((key) => jsonParam(obj[key])));
}

/**
 * note_history.rs::snapshot_notes inferred-format branch. Persists body-derived
 * metadata while preserving an explicitly enabled writer capability, and clears
 * `updated_at` so the remote envelope stays authoritative.
 */
function updateInferredFormat(conn: SqlExecutor, noteId: string): NoteFormat {
  return noteTransaction(conn, () => {
    // note_history.rs:285-286: the remote snapshot also covers soft-deleted notes
    // (a tombstone UPDATE carries deleted_at), so no deleted_at filter here.
    const row = conn.get<{ data: string | null }>(
      'SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1', [noteId]);
    if (row === undefined) databaseError('Query returned no rows');
    // rusqlite `r.get::<_, String>(0)` on NULL.
    if (row.data === null) databaseError('Invalid column type Null at index: 0, name: data');
    const content = row.data;
    const detected = noteFormatRepository.detect(noteId, content);
    const old = noteFormatRepository.get(conn, noteId);
    // Removing the last container must not silently disable ds-columns-v1.
    if (noteFormatRepository.requiredCapabilities(old).length > 0
      && noteFormatRepository.requiredCapabilities(detected).length === 0) {
      detected.serializer_version = noteFormatRepository.serializer(
        detected.content_format === 'markdown-blocks', true);
    }
    if (old.content_format !== detected.content_format
      || old.format_version !== detected.format_version
      || old.serializer_version !== detected.serializer_version) {
      detected.baseline_version_id = old.baseline_version_id;
      noteFormatRepository.insert(conn, detected);
      conn.run("UPDATE note_document_formats SET updated_at='' WHERE note_id=?1", [noteId]);
    }
    return detected;
  });
}

export const noteSyncRepository = {
  prepareRelation,
  retargetNoteRelations,
  applyRevision,
  updateInferredFormat,
};
