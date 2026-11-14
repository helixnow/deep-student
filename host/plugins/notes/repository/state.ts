import type {
  NoteStateKey, NoteStateList, NoteStateType,
} from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { ExactNoteState, NoteStateRepository, NoteStateRevision } from '../api.ts';
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import { isJsonFloat, parseJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { conflict, invalid } from './errors.ts';
import { noteTransaction } from './transaction.ts';
import { decodeJson } from './json.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';

/** The contract generator adds serde map alternatives for unit enums; wire values are strings. */
function stateType(entry: { type: NoteStateKey['type'] }): NoteStateType {
  return entry.type as NoteStateType;
}

function validate(conn: SqlExecutor, entry: NoteStateKey): void {
  if (utf8ByteLength(entry.key) === 0 || utf8ByteLength(entry.key) > 512) {
    invalid('State key must contain 1..512 bytes');
  }
  if (!conn.get('SELECT id FROM notes WHERE id=?1 AND deleted_at IS NULL', [entry.note_id])) {
    invalid('Note missing or deleted');
  }
}

interface StateRow {
  value_json: string;
  revision: bigint;
  deleted: bigint;
  updated_at: string;
}

// D3: i64 revision is read exactly; only the two-sided safe range becomes Number.
const stateRowQuery = defineQuery<readonly [string, string, string], StateRow>(
  'SELECT value_json,revision,deleted,updated_at FROM note_state WHERE note_id=?1 AND state_type=?2 AND state_key=?3',
  { name: 'notes.state.get', options: { safeIntegers: true } },
);
const stateListQuery = defineQuery<readonly [string, string, boolean], StateRow & { state_key: string }>(
  'SELECT state_key,value_json,revision,deleted,updated_at FROM note_state WHERE note_id=?1 AND state_type=?2 AND (?3 OR deleted=0) ORDER BY state_key',
  { name: 'notes.state.list', options: { safeIntegers: true } },
);

function revisionValue(revision: bigint): NoteStateRevision {
  return revision >= BigInt(Number.MIN_SAFE_INTEGER) && revision <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(revision) : revision;
}

/** IPC/event view: JsonFloat becomes its JSON number; bigint is left to the kernel wire boundary. */
function plainValue(value: DbJson): unknown {
  if (isJsonFloat(value)) return value.value;
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
  }
  return value;
}

/**
 * note_transfer_repo.rs::decode::<Value> (arbitrary_precision + preserve_order):
 * serde syntax errors first, then the exact value (bigint integers, JsonFloat floats).
 */
function decodeValue(raw: string): DbJson {
  decodeJson(raw);
  return parseJsonLossless(raw);
}

/** Wire form of a state row for commands and `notes:state-changed`. */
export function noteStateWire(row: ExactNoteState): ExactNoteState {
  return { ...row, value: plainValue(row.value as DbJson) };
}

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** note_transfer_repo.rs::json: BigInt and lossless floats keep their exact JSON number text. */
function encodeValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? rawJSON(item.toString())
    : isJsonFloat(item) ? rawJSON(item.source) : item);
}

function state(entry: NoteStateKey, row: StateRow): ExactNoteState {
  return { note_id: entry.note_id, type: stateType(entry), key: entry.key,
    value: decodeValue(row.value_json), revision: revisionValue(row.revision),
    deleted: Number(row.deleted) !== 0, updated_at: row.updated_at };
}

export const noteStateRepository: NoteStateRepository = {
  get(conn, entry) {
    validate(conn, entry);
    const row = conn.get(stateRowQuery, [entry.note_id, stateType(entry), entry.key]);
    return row === undefined ? null : state(entry, row);
  },
  list(conn, request: NoteStateList) {
    validate(conn, { note_id: request.note_id, type: request.type, key: 'list' });
    return conn.all(stateListQuery, [request.note_id, stateType(request), request.include_deleted ?? false])
      .map(row => state({ note_id: request.note_id, type: stateType(request), key: row.state_key }, row));
  },
  put(conn, request) {
    return write(conn, request, request.expected_revision ?? null, request.value, false);
  },
  delete(conn, request) {
    return write(conn, request, request.expected_revision, null, true);
  },
};

function write(
  conn: SqlExecutor, entry: NoteStateKey, expected: NoteStateRevision | null, value: unknown, deleted: boolean,
): ExactNoteState {
  return noteTransaction(conn, () => {
    validate(conn, entry);
    const json = encodeValue(value);
    const changed = expected !== null
      ? conn.run("UPDATE note_state SET value_json=?1,revision=revision+1,deleted=?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE note_id=?3 AND state_type=?4 AND state_key=?5 AND revision=?6", [json, deleted, entry.note_id, stateType(entry), entry.key, expected]).changes
      : conn.run("INSERT INTO note_state(note_id,state_type,state_key,value_json,revision,deleted,updated_at) VALUES(?1,?2,?3,?4,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(note_id,state_type,state_key) DO NOTHING", [entry.note_id, stateType(entry), entry.key, json]).changes;
    if (changed !== 1) conflict('notes.state_conflict');
    return noteStateRepository.get(conn, entry) ?? invalid('State missing after write');
  });
}
