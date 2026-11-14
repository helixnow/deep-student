/**
 * Index unit / segment SQL used by the indexing service.
 *
 * `index_unit_repo.rs` and `index_segment_repo.rs` belong to L11, whose api.ts
 * does not publish them yet. These functions are the minimal subset required by
 * `vfs/indexing.rs`; callers receive plain records.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { nanoid } from 'nanoid';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { nowMs } from './index-state.ts';
import { requireVfsTableOwners, type IndexUnitProfileWrites } from './owners.ts';

export const MODALITY_TEXT = 'text';
export const MODALITY_MULTIMODAL = 'multimodal';

export type UnitTextState = 'pending' | 'indexing' | 'indexed' | 'failed' | 'disabled';

export interface VfsResourceRecord {
  id: string;
  hash: string;
  resourceType: string;
  sourceId: string | null;
  sourceTable: string | null;
  storageMode: string | null;
  data: string | null;
  metadataJson: string | null;
}

export interface VfsIndexUnit {
  id: string;
  resourceId: string;
  unitIndex: number;
  imageBlobHash: string | null;
  imageMimeType: string | null;
  textContent: string | null;
  textSource: string | null;
  textRequired: boolean;
  textState: UnitTextState;
  textError: string | null;
  textIndexedAt: number | null;
  textChunkCount: number;
  textEmbeddingDim: number | null;
  textProfileId: string | null;
  textGeneration: number | bigint;
  mmRequired: boolean;
  mmState: UnitTextState;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSegmentInput {
  unitId: string;
  segmentIndex: number;
  modality: string;
  embeddingDim: number;
  lanceRowId: string;
  contentText: string | null;
  contentHash?: string | null;
  startPos: number | null;
  endPos: number | null;
  metadataJson: string | null;
}

export interface VfsIndexSegment {
  id: string;
  unitId: string;
  segmentIndex: number;
  modality: string;
  embeddingDim: number;
  lanceRowId: string;
  contentText: string | null;
  indexProfileId: string | null;
  generation: number | bigint;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

function boolean(value: unknown): boolean {
  return integer(value) !== 0;
}

function unitState(value: unknown): UnitTextState {
  const state = text(value);
  return state === 'pending' || state === 'indexing' || state === 'indexed'
    || state === 'failed' || state === 'disabled'
    ? state
    : 'disabled';
}

function rowToUnit(row: Row): VfsIndexUnit {
  return {
    id: text(row['id']),
    resourceId: text(row['resource_id']),
    unitIndex: integer(row['unit_index']),
    imageBlobHash: nullableText(row['image_blob_hash']),
    imageMimeType: nullableText(row['image_mime_type']),
    textContent: nullableText(row['text_content']),
    textSource: nullableText(row['text_source']),
    textRequired: boolean(row['text_required']),
    textState: unitState(row['text_state']),
    textError: nullableText(row['text_error']),
    textIndexedAt: row['text_indexed_at'] === null || row['text_indexed_at'] === undefined
      ? null
      : integer(row['text_indexed_at']),
    textChunkCount: integer(row['text_chunk_count']),
    textEmbeddingDim: row['text_embedding_dim'] === null || row['text_embedding_dim'] === undefined
      ? null
      : integer(row['text_embedding_dim']),
    textProfileId: nullableText(row['text_profile_id']),
    textGeneration: typeof row['text_generation'] === 'bigint'
      && (row['text_generation'] > BigInt(Number.MAX_SAFE_INTEGER)
        || row['text_generation'] < BigInt(Number.MIN_SAFE_INTEGER))
      ? row['text_generation'] : integer(row['text_generation']),
    mmRequired: boolean(row['mm_required']),
    mmState: unitState(row['mm_state']),
    createdAt: integer(row['created_at']),
    updatedAt: integer(row['updated_at']),
  };
}

export function getFullResource(db: SqlExecutor, resourceId: string): VfsResourceRecord | undefined {
  const row = db.get(
    `SELECT id, hash, type, source_id, source_table, storage_mode, data, metadata_json
     FROM resources WHERE id = ?1`,
    [resourceId],
  );
  if (row === undefined) return undefined;
  return {
    id: text(row['id']),
    hash: nullableText(row['hash']) ?? '',
    resourceType: text(row['type']),
    sourceId: nullableText(row['source_id']),
    sourceTable: nullableText(row['source_table']),
    storageMode: nullableText(row['storage_mode']),
    data: nullableText(row['data']),
    metadataJson: nullableText(row['metadata_json']),
  };
}

export function getResourceOcrText(db: SqlExecutor, resourceId: string): string | null {
  try {
    const value = db.pluck<unknown>('SELECT ocr_text FROM resources WHERE id = ?1', [resourceId]);
    const content = nullableText(value);
    return content === null || rustTrim(content) === '' ? null : content;
  } catch {
    // Rust `query_row(...).ok().flatten()`: a missing table/row reads as absent.
    return null;
  }
}

export function getNoteRecord(
  db: SqlExecutor,
  noteId: string,
): { deleted: boolean } | undefined {
  const row = db.get('SELECT deleted_at FROM notes WHERE id = ?1', [noteId]);
  if (row === undefined) return undefined;
  return { deleted: row['deleted_at'] !== null && row['deleted_at'] !== undefined };
}

export function getNoteFolderId(db: SqlExecutor, noteId: string): string | null {
  try {
    const row = db.get(
      'SELECT folder_id FROM note_locations WHERE note_id = ?1',
      [noteId],
    );
    return row === undefined ? null : nullableText(row['folder_id']);
  } catch {
    // Rust `query_row(...).optional().ok().flatten()`: missing tables read as no folder.
    return null;
  }
}

export function getUnitsByResource(db: SqlExecutor, resourceId: string): VfsIndexUnit[] {
  return db.all(defineQuery<[string], Row>(
    'SELECT * FROM vfs_index_units WHERE resource_id = ?1 ORDER BY unit_index ASC',
    { options: { safeIntegers: true } },
  ), [resourceId]).map(rowToUnit);
}

export function ensurePrimaryUnit(db: SqlExecutor, resourceId: string): string {
  const existing = db.get(
    'SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = 0',
    [resourceId],
  );
  if (existing !== undefined) return text(existing['id']);
  const id = `unit_${nanoid(10)}`;
  const now = nowMs();
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_required, text_state,
        mm_required, mm_state, created_at, updated_at)
     VALUES (?1, ?2, 0, '', 1, 'indexing', 0, 'disabled', ?3, ?3)`,
    [id, resourceId, now],
  );
  return id;
}

export function insertUnit(
  db: SqlExecutor,
  resourceId: string,
  unitIndex: number,
  textContent: string,
  textSource: string | null,
): string {
  const id = `unit_${nanoid(10)}`;
  const now = nowMs();
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
        mm_required, mm_state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 'pending', 0, 'disabled', ?6, ?6)`,
    [id, resourceId, unitIndex, textContent, textSource, now],
  );
  return id;
}

export function setUnitIndexProfile(
  db: SqlExecutor,
  unitId: string,
  modality: string,
  profileId: string,
  generation: number | bigint,
): void {
  const owner: IndexUnitProfileWrites = requireVfsTableOwners(db).embeddingUnits;
  owner.setIndexProfile(db, unitId, modality, profileId, generation);
}

export function setUnitTextState(
  db: SqlExecutor,
  unitId: string,
  state: UnitTextState,
  error: string | null,
  embeddingDim?: number | null,
): void {
  if (embeddingDim === undefined) {
    requireVfsTableOwners(db).embeddingUnits.setTextState(db, unitId, state, error);
    return;
  }
  const now = nowMs();
  db.run(
    `UPDATE vfs_index_units
     SET text_state = ?1, text_error = ?2, text_embedding_dim = ?3, updated_at = ?4
     WHERE id = ?5`,
    [state, error, embeddingDim, now, unitId],
  );
}

export function markUnitTextIndexed(
  db: SqlExecutor,
  unitId: string,
  chunkCount: number,
  dimension: number,
): void {
  requireVfsTableOwners(db).embeddingUnits.setTextIndexed(db, unitId, chunkCount, dimension);
}

export function markTextUnitsState(
  db: SqlExecutor,
  resourceId: string,
  state: UnitTextState,
  error: string | null,
  options: { requiredOnly?: boolean } = {},
): void {
  const now = nowMs();
  const requiredClause = options.requiredOnly === true ? ' AND text_required = 1' : '';
  db.run(
    `UPDATE vfs_index_units
     SET text_state = ?1, text_error = ?2, updated_at = ?3
     WHERE resource_id = ?4${requiredClause}`,
    [state, error, now, resourceId],
  );
}

export function markTextUnitsFailedWithoutDim(
  db: SqlExecutor,
  resourceId: string,
  error: string | null,
  requiredOnly = false,
): void {
  const now = nowMs();
  const requiredClause = requiredOnly ? ' AND text_required = 1' : '';
  db.run(
    `UPDATE vfs_index_units
     SET text_state = 'failed', text_error = ?1, text_embedding_dim = NULL, updated_at = ?2
     WHERE resource_id = ?3${requiredClause}`,
    [error, now, resourceId],
  );
}

export function getPendingTextUnits(db: SqlExecutor, resourceId: string): VfsIndexUnit[] {
  return db.all(defineQuery<[string], Row>(
    `SELECT * FROM vfs_index_units
     WHERE resource_id = ?1 AND text_required = 1 AND text_state = 'pending'
     ORDER BY unit_index ASC`,
    { options: { safeIntegers: true } },
  ), [resourceId]).map(rowToUnit);
}

/** `index_unit_repo::purge_index_artifacts_by_resource`: enqueue Lance rows, then delete units. */
export function purgeIndexArtifactsByResource(db: SqlExecutor, resourceId: string): number {
  return requireVfsTableOwners(db).embeddingUnits.purgeIndexArtifactsByResource(db, resourceId);
}

/** `index_segment_repo::replace_by_unit_and_modality`. */
export function replaceSegmentsByUnitAndModality(
  db: SqlExecutor,
  resourceId: string,
  unitId: string,
  modality: string,
  inputs: readonly CreateSegmentInput[],
): VfsIndexSegment[] {
  return requireVfsTableOwners(db).embeddingSegments.replaceByUnitAndModality(
    db, resourceId, unitId, modality,
    inputs.map((input) => ({ ...input, contentHash: input.contentHash ?? null })),
  );
}

export function batchCreateSegments(
  db: SqlExecutor,
  inputs: readonly CreateSegmentInput[],
): VfsIndexSegment[] {
  return requireVfsTableOwners(db).embeddingSegments.batchCreate(
    db, inputs.map((input) => ({ ...input, contentHash: input.contentHash ?? null })),
  );
}

/** `embedding_dim_repo::register` + `increment_count` (idempotent row creation). */
export function registerAndIncrementEmbeddingDim(
  db: SqlExecutor,
  dimension: number,
  modality: string,
  count: number,
): void {
  const owner = requireVfsTableOwners(db);
  owner.embeddingDims.register(db, dimension, modality);
  owner.embeddingDims.incrementCount(db, dimension, modality, count);
}

export interface FtsRow {
  embeddingId: string;
  resourceId: string;
  chunkText: string;
  chunkIndex: number;
}

export function searchFtsRows(db: SqlExecutor, query: string, topK: number): FtsRow[] {
  return db.all<Row>(
    `SELECT s.id, u.resource_id, s.content_text, s.segment_index
     FROM vfs_index_segments s
     JOIN vfs_index_units u ON s.unit_id = u.id
     WHERE s.content_text LIKE '%' || ?1 || '%'
     LIMIT ?2`,
    [query, topK],
  ).map((row) => ({
    embeddingId: text(row['id']),
    resourceId: text(row['resource_id']),
    chunkText: nullableText(row['content_text']) ?? '',
    chunkIndex: integer(row['segment_index']),
  }));
}

export function embeddingStats(db: SqlExecutor): {
  totalEmbeddings: number;
  totalResourcesIndexed: number;
} {
  const totalEmbeddings = integer(
    db.pluck<unknown>('SELECT COUNT(*) FROM vfs_index_segments'),
  );
  const totalResourcesIndexed = integer(
    db.pluck<unknown>(
      `SELECT COUNT(DISTINCT u.resource_id)
       FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id = u.id`,
    ),
  );
  return { totalEmbeddings, totalResourcesIndexed };
}

/** `index_unit_repo::clear_multimodal_index`: enqueue rows, delete segments, disable mm. */
export function clearMultimodalIndex(db: SqlExecutor, resourceId: string): number {
  return requireVfsTableOwners(db).embeddingUnits.clearMultimodalIndex(db, resourceId);
}

export function setUnitMmStateRow(
  db: SqlExecutor,
  unitId: string,
  state: string,
  error: string | null,
  _at: number,
): void {
  requireVfsTableOwners(db).embeddingUnits.setMmState(db, unitId, state as UnitTextState, error);
}

export function setResourceMmState(
  db: SqlExecutor,
  resourceId: string,
  state: string,
  error: string | null,
): void {
  const owner = requireVfsTableOwners(db);
  if (state === 'failed') {
    owner.indexStates.markMmFailed(db, resourceId, error ?? 'multimodal indexing failed');
  } else {
    owner.indexStates.setMmIndexState(db, resourceId, state, error);
  }
}

export function listMultimodalDimensions(db: SqlExecutor): Array<{ dimension: number; record_count: number }> {
  return db.all<Row>(
    `SELECT dimension, record_count FROM vfs_embedding_dims
     WHERE modality = ?1 ORDER BY dimension ASC`,
    [MODALITY_MULTIMODAL],
  ).map((row) => ({
    dimension: integer(row['dimension']),
    record_count: integer(row['record_count']),
  }));
}

// ------------------------------------------------------------------ generations
//
// `lance_store.rs::next_unit_generation` / `retain_active_unit_generations`.
// Keeping these queries here means generated/immutable SQL never leaks into
// `src/`. Unit generations are i64 in Rust; read them with `safeIntegers` so a
// value beyond 2^53 is not silently rounded before it is bound back.

const I64_MAX = 9223372036854775807n;

const unitGenerationQueries = {
  text: defineQuery<[string], bigint>(
    'SELECT text_generation FROM vfs_index_units WHERE id = ?1',
    { name: 'vfs.indexUnit.nextTextGeneration', options: { safeIntegers: true } },
  ),
  mm: defineQuery<[string], bigint>(
    'SELECT mm_generation FROM vfs_index_units WHERE id = ?1',
    { name: 'vfs.indexUnit.nextMmGeneration', options: { safeIntegers: true } },
  ),
} as const;

const unitGenerationStateQueries = {
  text: defineQuery<[string], UnitGenerationStateRow>(
    `SELECT u.text_profile_id AS profile_id, u.text_generation AS generation,
            CASE WHEN r.id IS NULL THEN 1
                 WHEN r.deleted_at IS NULL AND COALESCE(r.index_state, 'pending') <> 'disabled'
                 THEN 1 ELSE 0 END AS allowed
     FROM vfs_index_units u
     LEFT JOIN resources r ON r.id = u.resource_id
     WHERE u.id = ?1`,
    { name: 'vfs.indexUnit.textGenerationState', options: { safeIntegers: true } },
  ),
  mm: defineQuery<[string], UnitGenerationStateRow>(
    `SELECT u.mm_profile_id AS profile_id, u.mm_generation AS generation,
            CASE WHEN r.id IS NULL THEN 1
                 WHEN r.deleted_at IS NULL AND COALESCE(r.mm_index_state, 'pending') <> 'disabled'
                 THEN 1 ELSE 0 END AS allowed
     FROM vfs_index_units u
     LEFT JOIN resources r ON r.id = u.resource_id
     WHERE u.id = ?1`,
    { name: 'vfs.indexUnit.mmGenerationState', options: { safeIntegers: true } },
  ),
} as const;

function generationColumn(modality: string): { profile: string; generation: string; state: string } | undefined {
  if (modality === MODALITY_TEXT) {
    return { profile: 'text_profile_id', generation: 'text_generation', state: 'index_state' };
  }
  if (modality === 'image' || modality === MODALITY_MULTIMODAL) {
    return { profile: 'mm_profile_id', generation: 'mm_generation', state: 'mm_index_state' };
  }
  return undefined;
}

/**
 * `next_unit_generation`: `Option<i64>` when the unit exists, `undefined` when it
 * does not. `saturating_add(1)` and the full i64 are preserved as bigint.
 */
export function nextUnitGenerationValue(
  db: SqlExecutor,
  unitId: string,
  modality: string,
): bigint | undefined {
  const key = modality === MODALITY_TEXT ? 'text' : modality === 'image' || modality === MODALITY_MULTIMODAL ? 'mm' : undefined;
  if (key === undefined) {
    throw new Error(`Unsupported modality: ${modality}`);
  }
  const current = db.pluck<bigint>(unitGenerationQueries[key], [unitId]);
  if (current === undefined) return undefined;
  const next = current === I64_MAX ? I64_MAX : current + 1n;
  return next;
}

export interface UnitGenerationState {
  profileId: string | null;
  /** i64 read through `safeIntegers`; equality with Lance rows is exact. */
  generation: bigint;
  allowed: boolean;
}

interface UnitGenerationStateRow {
  profile_id: string | null;
  generation: bigint;
  allowed: bigint;
}

function unitGenerationStateQuery(modality: string): typeof unitGenerationStateQueries.text | undefined {
  if (modality === MODALITY_TEXT) return unitGenerationStateQueries.text;
  if (modality === 'image' || modality === MODALITY_MULTIMODAL) return unitGenerationStateQueries.mm;
  return undefined;
}

/** Unit provenance consulted before returning a Lance hit (per unit_id, cached by callers). */
export function unitGenerationState(
  db: SqlExecutor,
  unitId: string,
  modality: string,
): UnitGenerationState | undefined {
  const query = unitGenerationStateQuery(modality);
  if (query === undefined) return undefined;
  try {
    const row = db.get(query, [unitId]);
    if (row === undefined) return undefined;
    return {
      profileId: nullableText(row['profile_id']),
      generation: row['generation'],
      allowed: Number(row['allowed']) !== 0,
    };
  } catch {
    // Rust `query_row(...).optional().ok().flatten()` treats lookup errors as "no state".
    return undefined;
  }
}

/** Exact i64 comparison without a Number round-trip. */
export function generationEquals(left: number | bigint, right: number | bigint): boolean {
  return typeof left === 'bigint' || typeof right === 'bigint'
    ? BigInt(left) === BigInt(right)
    : left === right;
}

export function generationIsZero(value: number | bigint): boolean {
  return typeof value === 'bigint' ? value === 0n : value === 0;
}

export function generationIsNegative(value: number | bigint): boolean {
  return typeof value === 'bigint' ? value < 0n : value < 0;
}

/** Legacy rows (generation 0, empty unit_id) stay readable while the resource is live. */
export function resourceAllowsLegacyGeneration(
  db: SqlExecutor,
  resourceId: string,
  modality: string,
): boolean | undefined {
  const columns = generationColumn(modality);
  if (columns === undefined) return undefined;
  try {
    const row = db.get(
      `SELECT deleted_at IS NULL AND COALESCE(${columns.state}, 'pending') <> 'disabled' AS allowed
       FROM resources WHERE id = ?1`,
      [resourceId],
    );
    return row === undefined ? undefined : integer(row['allowed']) !== 0;
  } catch {
    // Rust `.optional().ok().flatten().unwrap_or(true)`.
    return undefined;
  }
}
