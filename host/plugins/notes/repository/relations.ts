// note_relation_repo.rs: typed learning relations keyed by resource ID + locator.
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  NoteLocator__De, NoteReferenceStatus, NoteRelationType,
} from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { ExactNoteRelation, ExactNoteRelationPut, NoteRelationRevision } from '../api.ts';
import { conflict, databaseFailure, invalid, NoteDatabaseError } from './errors.ts';
import { decodeJson, NoteSerializationError } from './json.ts';
import { noteRepository } from './notes.ts';
import { noteTransaction } from './transaction.ts';
import { blocks } from '../src/structure.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export type AnkiConnection = SqlExecutor | null;

const RELATION_TYPES = new Set<NoteRelationType>(['source', 'card', 'mistake']);
const LOCATOR_TYPES = new Set<NoteLocator__De['type']>(['whole', 'block', 'page', 'card', 'question']);

function locator(raw: NoteLocator__De): unknown {
  return raw;
}

function invalidType(value: unknown, expected: string): never {
  throw new NoteSerializationError(
    `invalid type: ${value === null ? 'null' : typeof value}, expected ${expected}`);
}

/** serde: `#[serde(tag = "type", content = "value", rename_all = "snake_case")]`. */
function locatorFromJson(raw: string): NoteLocator__De {
  const parsed: unknown = decodeJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalidType(parsed, 'enum NoteLocator');
  }
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !LOCATOR_TYPES.has(type as NoteLocator__De['type'])) {
    throw new NoteSerializationError(
      `unknown variant \`${String(type)}\`, expected one of \`whole\`, \`block\`, \`page\`, \`card\`, \`question\``);
  }
  if (type === 'whole') return { type: 'whole' };
  const value = record.value;
  if (type === 'page') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      invalidType(value, 'u32');
    }
    return { type: 'page', value };
  }
  if (typeof value !== 'string') invalidType(value, 'a string');
  return { type, value } as NoteLocator__De;
}

function relationType(raw: string): NoteRelationType {
  if (!RELATION_TYPES.has(raw as NoteRelationType)) {
    throw new NoteSerializationError(
      `unknown variant \`${raw}\`, expected one of \`source\`, \`card\`, \`mistake\``);
  }
  return raw as NoteRelationType;
}

function result(changed: number, code: string): void {
  if (changed !== 1) conflict(code);
}

function referenceStatus(conn: SqlExecutor, anki: AnkiConnection, resourceId: string, value: NoteLocator__De): NoteReferenceStatus {
  if (value.type === 'card') {
    if (anki === null) invalid('Anki database connection required for card references');
    const resourceExists = Number(anki.get<{ present: number }>(
      'SELECT EXISTS(SELECT 1 FROM document_tasks WHERE document_id=?1 AND deleted_at IS NULL) AS present',
      [resourceId])?.present ?? 0) !== 0;
    const locatorExists = Number(anki.get<{ present: number }>(
      `SELECT EXISTS(SELECT 1 FROM anki_cards c JOIN document_tasks t ON t.id=c.task_id
        WHERE t.document_id=?1 AND c.id=?2 AND c.deleted_at IS NULL AND t.deleted_at IS NULL) AS present`,
      [resourceId, value.value])?.present ?? 0) !== 0;
    return { resource_exists: resourceExists, locator_exists: locatorExists };
  }

  const resource = conn.get<{ type: string; data: string | null }>(
    `SELECT type, data FROM resources r WHERE id=?1 AND deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM notes n WHERE n.resource_id=r.id AND n.deleted_at IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM files f WHERE f.resource_id=r.id AND f.deleted_at IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM exam_sheets e WHERE e.resource_id=r.id AND e.deleted_at IS NOT NULL)`,
    [resourceId]);
  if (resource === undefined) return { resource_exists: false, locator_exists: false };

  let locatorExists = false;
  switch (value.type) {
    case 'whole':
      locatorExists = true;
      break;
    case 'block':
      locatorExists = resource.type === 'note' && (() => {
        try {
          return blocks(resource.data ?? '').some((block) => block.id === value.value);
        } catch (error) {
          if (error instanceof NoteDatabaseError) throw error;
          return false;
        }
      })();
      break;
    case 'page':
      locatorExists = value.value > 0 && Number(conn.get<{ present: number }>(
        'SELECT EXISTS(SELECT 1 FROM files WHERE resource_id=?1 AND deleted_at IS NULL AND page_count>=?2) AS present',
        [resourceId, value.value])?.present ?? 0) !== 0;
      break;
    case 'question':
      locatorExists = Number(conn.get<{ present: number }>(
        `SELECT EXISTS(SELECT 1 FROM questions q JOIN exam_sheets e ON e.id=q.exam_id
          WHERE e.resource_id=?1 AND e.deleted_at IS NULL AND q.id=?2 AND q.deleted_at IS NULL) AS present`,
        [resourceId, value.value])?.present ?? 0) !== 0;
      break;
    default:
      locatorExists = false;
  }
  return { resource_exists: true, locator_exists: locatorExists };
}

interface RelationRow {
  id: string;
  note_id: string;
  block_id: string | null;
  relation_type: string;
  resource_id: string;
  locator_json: string;
  revision: bigint | number;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
}

const relationQuery = defineQuery<readonly [string], RelationRow>(
  `SELECT id, note_id, block_id, relation_type, resource_id, locator_json, revision,
     invalidated_at, created_at, updated_at FROM note_learning_relations WHERE id=?1`,
  { name: 'notes.relation.get', options: { safeIntegers: true } },
);

function relation(row: RelationRow, conn: SqlExecutor, anki: AnkiConnection): ExactNoteRelation {
  // note_relation_repo.rs:117 decodes revision with r.get::<_, i64>(6).
  // INTEGER columns are bigint with safeIntegers; SQLite promotes i64 overflow
  // to REAL, which rusqlite rejects before decoding the locator/reference.
  if (typeof row.revision === 'number') {
    databaseFailure('Invalid column type Real at index: 6, name: revision');
  }
  const revision = row.revision >= BigInt(Number.MIN_SAFE_INTEGER) && row.revision <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(row.revision) : row.revision;
  const value = locatorFromJson(row.locator_json);
  return {
    id: row.id, note_id: row.note_id, block_id: row.block_id,
    type: relationType(row.relation_type), resource_id: row.resource_id,
    locator: value, revision, invalidated_at: row.invalidated_at,
    created_at: row.created_at, updated_at: row.updated_at,
    reference: referenceStatus(conn, anki, row.resource_id, value),
  };
}

export const noteRelationRepository = {
  referenceStatus,

  get(conn: SqlExecutor, anki: AnkiConnection, id: string): ExactNoteRelation | null {
    const row = conn.get(relationQuery, [id]);
    return row === undefined ? null : relation(row, conn, anki);
  },

  list(conn: SqlExecutor, anki: AnkiConnection, noteId: string): ExactNoteRelation[] {
    return conn.all<{ id: string }>('SELECT id FROM note_learning_relations WHERE note_id=?1 ORDER BY id', [noteId])
      .map((row) => this.get(conn, anki, row.id))
      .filter((row): row is ExactNoteRelation => row !== null);
  },

  put(conn: SqlExecutor, anki: AnkiConnection, request: ExactNoteRelationPut): ExactNoteRelation {
    return noteTransaction(conn, () => {
      const relationType = request.type as NoteRelationType;
      if (rustTrim(request.id).length === 0) invalid('Relation ID required');
      if ((relationType === 'card' && request.locator.type !== 'card')
        || (relationType === 'mistake' && request.locator.type !== 'question')) {
        invalid('card/mistake relations require the corresponding typed locator');
      }
      const content = noteRepository.getNoteContent(request.note_id, conn);
      if (content === null) invalid('Owner note missing');
      if (request.block_id !== null && request.block_id !== undefined
        && !blocks(content).some((block) => block.id === request.block_id)) {
        invalid('Owner block missing');
      }
      const status = referenceStatus(conn, anki, request.resource_id, request.locator);
      if (!status.resource_exists || !status.locator_exists) {
        invalid('Referenced resource or locator missing');
      }
      const raw = JSON.stringify(locator(request.locator));
      let changed: number;
      if (request.expected_revision !== null && request.expected_revision !== undefined) {
        changed = conn.run(
          `UPDATE note_learning_relations SET block_id=?1, relation_type=?2, resource_id=?3,
             locator_json=?4, revision=revision+1, invalidated_at=NULL,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=?5 AND note_id=?6 AND revision=?7`,
          [request.block_id ?? null, relationType, request.resource_id, raw,
            request.id, request.note_id, request.expected_revision]).changes;
      } else {
        changed = conn.run(
          `INSERT INTO note_learning_relations(id, note_id, block_id, relation_type, resource_id, locator_json, created_at, updated_at)
           VALUES(?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(id) DO NOTHING`,
          [request.id, request.note_id, request.block_id ?? null, relationType, request.resource_id, raw]).changes;
      }
      result(changed, 'notes.relation_conflict');
      const written = this.get(conn, anki, request.id);
      if (written === null) invalid('Relation missing after write');
      return written;
    });
  },

  delete(conn: SqlExecutor, id: string, expectedRevision: NoteRelationRevision): boolean {
    const changed = conn.run('DELETE FROM note_learning_relations WHERE id=?1 AND revision=?2',
      [id, expectedRevision]).changes;
    result(changed, 'notes.relation_conflict');
    return true;
  },

  invalidateResource(conn: SqlExecutor, resourceId: string): number {
    return conn.run(
      `UPDATE note_learning_relations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), revision=revision+1
       WHERE resource_id=?1 AND invalidated_at IS NULL`, [resourceId]).changes;
  },

  invalidateMissingBlocks(conn: SqlExecutor, noteId: string): void {
    const note = noteRepository.getNote(noteId, conn);
    if (note === null) invalid('Note missing');
    const content = noteRepository.getNoteContent(noteId, conn) ?? '';
    let ids = new Set<string>();
    try {
      ids = new Set(blocks(content).map((block) => block.id));
    } catch (error) {
      if (error instanceof NoteDatabaseError) throw error;
    }
    const rows = conn.all<{
      id: string; block_id: string | null; locator_json: string; note_id: string; resource_id: string;
    }>(`SELECT id, block_id, locator_json, note_id, resource_id FROM note_learning_relations
        WHERE (note_id=?1 OR resource_id=?2) AND invalidated_at IS NULL`, [noteId, note.resourceId]);
    for (const row of rows) {
      const value = locatorFromJson(row.locator_json);
      const missingOwner = row.note_id === noteId && row.block_id !== null && !ids.has(row.block_id);
      const missingTarget = row.resource_id === note.resourceId
        && value.type === 'block' && !ids.has(value.value);
      if (missingOwner || missingTarget) {
        conn.run(`UPDATE note_learning_relations SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), revision=revision+1 WHERE id=?1`, [row.id]);
      }
    }
  },
};

export interface NoteReferencingResource {
  noteId: string;
  title: string;
  updatedAt: string;
  via: string;
}

export function listNotesReferencing(conn: SqlExecutor, ids: readonly string[]): NoteReferencingResource[] {
  const escapedIds = ids.map((id) => rustTrim(id)).filter((id) => id.length > 0);
  const found = new Map<string, NoteReferencingResource>();
  for (const id of escapedIds) {
    const escaped = id.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%"resourceId":"${escaped}"%`;
    const origins = conn.all<{ id: string; title: string; updated_at: string }>(
      `SELECT id, title, updated_at FROM notes
       WHERE deleted_at IS NULL AND json_extract(props, '$._origin') LIKE ?1 ESCAPE '\\'`, [pattern]);
    for (const row of origins) {
      if (!found.has(row.id)) found.set(row.id, { noteId: row.id, title: row.title, updatedAt: row.updated_at, via: 'origin' });
    }
    const relations = conn.all<{ id: string; title: string; updated_at: string }>(
      `SELECT DISTINCT n.id, n.title, n.updated_at FROM note_learning_relations r
       JOIN notes n ON n.id = r.note_id
       WHERE n.deleted_at IS NULL AND r.resource_id = ?1`, [id]);
    for (const row of relations) {
      if (!found.has(row.id)) found.set(row.id, { noteId: row.id, title: row.title, updatedAt: row.updated_at, via: 'relation' });
    }
  }
  return [...found.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
