/** Port of dstu-vfs index_unit_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type CreateUnitInput,
  type IndexState,
  type IndexUnitRepository,
  type SyncMultimodalUnitsResult,
  type SyncUnitsResult,
  type UnitStats,
  type VfsIndexUnit,
} from '../api.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { databaseResult } from './errors.ts';
import { IndexSegmentRepo } from './index-segments.ts';
import { exactInteger, safeIntegerQuery } from './sql-integers.ts';

const MODALITY_TEXT = 'text';
const MODALITY_MULTIMODAL = 'multimodal';

const UNIT_COLUMNS = `id, resource_id, unit_index, image_blob_hash, image_mime_type,
  text_content, text_source, content_hash, text_required, text_state, text_error,
  text_indexed_at, text_chunk_count, text_embedding_dim, text_profile_id, text_generation,
  mm_required, mm_state, mm_error, mm_indexed_at, mm_embedding_dim, mm_profile_id,
  mm_generation, created_at, updated_at`;

// R12-09: unit rows are read with safeIntegers so text/mm generation keeps full i64 precision.
const SELECT_UNIT_BY_ID = safeIntegerQuery(
  `SELECT ${UNIT_COLUMNS} FROM vfs_index_units WHERE id = ?1`, 'vfsRepos.indexUnit.getById');
const SELECT_UNITS_BY_RESOURCE = safeIntegerQuery(
  `SELECT ${UNIT_COLUMNS} FROM vfs_index_units WHERE resource_id = ?1 ORDER BY unit_index ASC`,
  'vfsRepos.indexUnit.getByResource');
const SELECT_PENDING_TEXT_UNITS = safeIntegerQuery(
  `SELECT ${UNIT_COLUMNS} FROM vfs_index_units
   WHERE text_required = 1 AND text_state = 'pending'
   ORDER BY updated_at DESC LIMIT ?1`, 'vfsRepos.indexUnit.listPendingText');
const SELECT_PENDING_MM_UNITS = safeIntegerQuery(
  `SELECT ${UNIT_COLUMNS} FROM vfs_index_units
   WHERE mm_required = 1 AND mm_state = 'pending'
   ORDER BY updated_at DESC LIMIT ?1`, 'vfsRepos.indexUnit.listPendingMm');
const SELECT_UNIT_BY_RESOURCE_INDEX = safeIntegerQuery(
  `SELECT ${UNIT_COLUMNS} FROM vfs_index_units
   WHERE resource_id = ?1 AND unit_index = ?2`, 'vfsRepos.indexUnit.getByResourceAndIndex');

const KNOWN_STATES = new Set<IndexState>(['pending', 'indexing', 'indexed', 'failed', 'disabled']);

function nowMs(): number { return Date.now(); }
function generateUnitId(): string { return `unit_${nanoid(10)}`; }

function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function invalidState(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_OPERATION', `INVALID_STATE: ${message}`);
}
function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function otherMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INTERNAL', message);
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return databaseMessage(`Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function optionalInteger(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : null;
}
function readOptionalText(row: Row, name: string): string | null {
  return optionalText(row[name]);
}
function readOptionalInteger(row: Row, name: string): number | null {
  return optionalInteger(row[name]);
}
function readBoolean(row: Row, name: string): boolean {
  return readInteger(row, name, 0) !== 0;
}

function parseState(raw: string): IndexState {
  if (KNOWN_STATES.has(raw as IndexState)) return raw as IndexState;
  logWarn(`[IndexUnitRepo] Unknown index state '${raw}' in vfs_index_units; treating as disabled`);
  return 'disabled';
}

function computeContentHash(imageHash: string | null, text: string | null): string {
  const hash = createHasherSync('SHA-256');
  if (imageHash !== null) hash.update(imageHash);
  hash.update('|');
  if (text !== null) hash.update(text);
  return hash.digestHex();
}

function rowToUnit(row: Row): VfsIndexUnit {
  return {
    id: readText(row, 'id', 0),
    resourceId: readText(row, 'resource_id', 1),
    unitIndex: readInteger(row, 'unit_index', 2),
    imageBlobHash: readOptionalText(row, 'image_blob_hash'),
    imageMimeType: readOptionalText(row, 'image_mime_type'),
    textContent: readOptionalText(row, 'text_content'),
    textSource: readOptionalText(row, 'text_source'),
    contentHash: readOptionalText(row, 'content_hash'),
    textRequired: readBoolean(row, 'text_required'),
    textState: parseState(readText(row, 'text_state', 9)),
    textError: readOptionalText(row, 'text_error'),
    textIndexedAt: readOptionalInteger(row, 'text_indexed_at'),
    textChunkCount: optionalInteger(row.text_chunk_count) ?? 0,
    textEmbeddingDim: readOptionalInteger(row, 'text_embedding_dim'),
    textProfileId: readOptionalText(row, 'text_profile_id'),
    textGeneration: exactInteger(row.text_generation) ?? 0,
    mmRequired: readBoolean(row, 'mm_required'),
    mmState: parseState(readText(row, 'mm_state', 17)),
    mmError: readOptionalText(row, 'mm_error'),
    mmIndexedAt: readOptionalInteger(row, 'mm_indexed_at'),
    mmEmbeddingDim: readOptionalInteger(row, 'mm_embedding_dim'),
    mmProfileId: readOptionalText(row, 'mm_profile_id'),
    mmGeneration: exactInteger(row.mm_generation) ?? 0,
    createdAt: readInteger(row, 'created_at', 23),
    updatedAt: readInteger(row, 'updated_at', 24),
  };
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T, failurePrefix: string): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
    } catch (rollbackError) {
      const detail = error instanceof Error ? error.message : String(error);
      const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw databaseMessage(`${detail}; ${failurePrefix}: ${rollbackDetail}`);
    }
    throw error;
  }
}

function insertUnit(conn: SqlExecutor, input: CreateUnitInput, id: string, now: number,
  textRequired: boolean, mmRequired: boolean, contentHash: string): void {
  conn.run(`INSERT INTO vfs_index_units (
      id, resource_id, unit_index, image_blob_hash, image_mime_type,
      text_content, text_source, content_hash,
      text_required, text_state, text_chunk_count,
      mm_required, mm_state,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?13, ?14)`,
  [id, input.resourceId, input.unitIndex, input.imageBlobHash, input.imageMimeType,
    input.textContent, input.textSource, contentHash, textRequired ? 1 : 0,
    textRequired ? 'pending' : 'disabled', mmRequired ? 1 : 0,
    mmRequired ? 'pending' : 'disabled', now, now]);
}

function createInner(conn: SqlExecutor, input: CreateUnitInput): VfsIndexUnit {
  const id = generateUnitId();
  const now = nowMs();
  const textRequired = input.textContent !== null && input.textContent !== '';
  const mmRequired = input.imageBlobHash !== null;
  const contentHash = computeContentHash(input.imageBlobHash, input.textContent);
  insertUnit(conn, input, id, now, textRequired, mmRequired, contentHash);
  const created = conn.get(SELECT_UNIT_BY_ID, [id]);
  if (created === undefined) throw notFound('Unit', id);
  return rowToUnit(created);
}

function updateUnit(conn: SqlExecutor, unit: VfsIndexUnit): void {
  const now = nowMs();
  const contentHash = computeContentHash(unit.imageBlobHash, unit.textContent);
  conn.run(`UPDATE vfs_index_units SET
      image_blob_hash = ?2,
      image_mime_type = ?3,
      text_content = ?4,
      text_source = ?5,
      content_hash = ?6,
      text_required = ?7,
      text_state = ?8,
      text_error = ?9,
      text_indexed_at = ?10,
      text_chunk_count = ?11,
      text_embedding_dim = ?12,
      text_profile_id = ?19,
      text_generation = ?20,
      mm_required = ?13,
      mm_state = ?14,
      mm_error = ?15,
      mm_indexed_at = ?16,
      mm_embedding_dim = ?17,
      mm_profile_id = ?21,
      mm_generation = ?22,
      updated_at = ?18
    WHERE id = ?1`,
  [unit.id, unit.imageBlobHash, unit.imageMimeType, unit.textContent, unit.textSource,
    contentHash, unit.textRequired ? 1 : 0, unit.textState, unit.textError, unit.textIndexedAt,
    unit.textChunkCount, unit.textEmbeddingDim, unit.mmRequired ? 1 : 0, unit.mmState,
    unit.mmError, unit.mmIndexedAt, unit.mmEmbeddingDim, now, unit.textProfileId,
    unit.textGeneration, unit.mmProfileId, unit.mmGeneration]);
}

function getById(conn: SqlExecutor, id: string): VfsIndexUnit | null {
  const row = conn.get(SELECT_UNIT_BY_ID, [id]);
  return row === undefined ? null : rowToUnit(row);
}

function getByResource(conn: SqlExecutor, resourceId: string): VfsIndexUnit[] {
  return conn.all(SELECT_UNITS_BY_RESOURCE, [resourceId]).map(rowToUnit);
}

export class IndexUnitRepo implements IndexUnitRepository {
  private readonly segments = new IndexSegmentRepo();

  create(conn: SqlExecutor, input: CreateUnitInput): VfsIndexUnit {
    return databaseResult(() => createInner(conn, input));
  }

  getById(conn: SqlExecutor, id: string): VfsIndexUnit | null {
    return databaseResult(() => getById(conn, id));
  }

  getByResource(conn: SqlExecutor, resourceId: string): VfsIndexUnit[] {
    return databaseResult(() => getByResource(conn, resourceId));
  }

  update(conn: SqlExecutor, unit: VfsIndexUnit): void {
    databaseResult(() => updateUnit(conn, unit));
  }

  setIndexProfile(conn: SqlExecutor, unitId: string, modality: string,
    profileId: string, generation: number | bigint): void {
    databaseResult(() => {
      if (generation < 0) throw invalidArgument('generation', 'Generation must be non-negative');
      let profileColumn: string;
      let generationColumn: string;
      if (modality === 'text') {
        profileColumn = 'text_profile_id';
        generationColumn = 'text_generation';
      } else if (modality === 'image' || modality === 'multimodal') {
        profileColumn = 'mm_profile_id';
        generationColumn = 'mm_generation';
      } else {
        throw invalidArgument('modality', `Unsupported modality: ${modality}`);
      }
      const writable = Number(conn.pluck<number>(
        `SELECT EXISTS(
            SELECT 1
            FROM vfs_index_profiles p
            JOIN vfs_embedding_dims d
              ON d.active_profile_id = p.id
             AND d.dimension = p.dimension
             AND d.modality = p.modality
            WHERE p.id = ?1
              AND p.modality = ?2
              AND p.state IN ('active', 'building')
        )`,
        [profileId, modality === 'image' ? MODALITY_MULTIMODAL : modality]) ?? 0) !== 0;
      if (!writable) {
        throw invalidState(`Index profile ${profileId} is no longer writable for modality ${modality}`);
      }
      const updated = conn.run(
        `UPDATE vfs_index_units SET ${profileColumn} = ?2, ${generationColumn} = ?3,
           updated_at = ?4 WHERE id = ?1`, [unitId, profileId, generation, nowMs()]).changes;
      if (updated === 0) throw notFound('IndexUnit', unitId);
    });
  }

  delete(conn: SqlExecutor, id: string): boolean {
    return databaseResult(() => {
      this.segments.enqueueLanceOrphansByUnit(conn, id, null);
      return this.deleteUnsafe(conn, id);
    });
  }

  deleteUnsafe(conn: SqlExecutor, id: string): boolean {
    return databaseResult(() => conn.run('DELETE FROM vfs_index_units WHERE id = ?1', [id]).changes > 0);
  }

  deleteByResource(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => purgeIndexArtifactsByResource(conn, resourceId));
  }

  deleteByResourceUnsafe(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => conn.run(
      'DELETE FROM vfs_index_units WHERE resource_id = ?1', [resourceId]).changes);
  }

  purgeIndexArtifactsByResource(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => purgeIndexArtifactsByResource(conn, resourceId));
  }

  sweepOrphanIndexUnits(conn: SqlExecutor): number {
    return databaseResult(() => {
      conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
        SELECT s.lance_row_id, u.resource_id
        FROM vfs_index_segments s
        JOIN vfs_index_units u ON s.unit_id = u.id
        WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = u.resource_id)
        ON CONFLICT(lance_row_id) DO UPDATE SET
            resource_id = excluded.resource_id,
            enqueued_at = excluded.enqueued_at,
            next_retry_at = 0,
            last_error = NULL`);
      return conn.run(`DELETE FROM vfs_index_units
        WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = vfs_index_units.resource_id)`).changes;
    });
  }

  setTextState(conn: SqlExecutor, id: string, state: IndexState, error: string | null): void {
    databaseResult(() => {
      const now = nowMs();
      const indexedAt = state === 'indexed' ? now : null;
      conn.run(`UPDATE vfs_index_units SET
          text_state = ?2,
          text_error = ?3,
          text_indexed_at = COALESCE(?4, text_indexed_at),
          updated_at = ?5
        WHERE id = ?1`, [id, state, error, indexedAt, now]);
    });
  }

  setTextIndexed(conn: SqlExecutor, id: string, chunkCount: number, embeddingDim: number): void {
    databaseResult(() => {
      const now = nowMs();
      conn.run(`UPDATE vfs_index_units SET
          text_state = 'indexed',
          text_error = NULL,
          text_indexed_at = ?2,
          text_chunk_count = ?3,
          text_embedding_dim = ?4,
          updated_at = ?2
        WHERE id = ?1`, [id, now, chunkCount, embeddingDim]);
    });
  }

  setMmState(conn: SqlExecutor, id: string, state: IndexState, error: string | null): void {
    databaseResult(() => {
      const now = nowMs();
      const indexedAt = state === 'indexed' ? now : null;
      conn.run(`UPDATE vfs_index_units SET
          mm_state = ?2,
          mm_error = ?3,
          mm_indexed_at = COALESCE(?4, mm_indexed_at),
          updated_at = ?5
        WHERE id = ?1`, [id, state, error, indexedAt, now]);
    });
  }

  setMmIndexed(conn: SqlExecutor, id: string, embeddingDim: number): void {
    databaseResult(() => {
      const now = nowMs();
      conn.run(`UPDATE vfs_index_units SET
          mm_state = 'indexed',
          mm_error = NULL,
          mm_indexed_at = ?2,
          mm_embedding_dim = ?3,
          updated_at = ?2
        WHERE id = ?1`, [id, now, embeddingDim]);
    });
  }

  listPendingText(conn: SqlExecutor, limit: number): VfsIndexUnit[] {
    return databaseResult(() => conn.all(SELECT_PENDING_TEXT_UNITS, [limit]).map(rowToUnit));
  }

  listPendingMm(conn: SqlExecutor, limit: number): VfsIndexUnit[] {
    return databaseResult(() => conn.all(SELECT_PENDING_MM_UNITS, [limit]).map(rowToUnit));
  }

  getStats(conn: SqlExecutor): UnitStats {
    return databaseResult(() => {
      const stats: UnitStats = {
        total: 0, textPending: 0, textIndexing: 0, textIndexed: 0, textFailed: 0,
        textDisabled: 0, mmPending: 0, mmIndexing: 0, mmIndexed: 0, mmFailed: 0, mmDisabled: 0,
      };
      stats.total = Number(conn.pluck<number>('SELECT COUNT(*) FROM vfs_index_units') ?? 0);
      const apply = (state: string, count: number, prefix: 'text' | 'mm'): void => {
        const key = `${prefix}${state.charAt(0).toUpperCase()}${state.slice(1)}` as keyof UnitStats;
        if (key in stats) stats[key] = count;
      };
      for (const row of conn.all<Row>(
        'SELECT text_state AS state, COUNT(*) AS count FROM vfs_index_units GROUP BY text_state')) {
        apply(readText(row, 'state', 0), readInteger(row, 'count', 1), 'text');
      }
      for (const row of conn.all<Row>(
        'SELECT mm_state AS state, COUNT(*) AS count FROM vfs_index_units GROUP BY mm_state')) {
        apply(readText(row, 'state', 0), readInteger(row, 'count', 1), 'mm');
      }
      return stats;
    });
  }

  getByResourceAndIndex(conn: SqlExecutor, resourceId: string, unitIndex: number): VfsIndexUnit | null {
    return databaseResult(() => {
      const row = conn.get(SELECT_UNIT_BY_RESOURCE_INDEX, [resourceId, unitIndex]);
      return row === undefined ? null : rowToUnit(row);
    });
  }

  batchCreate(conn: SqlExecutor, inputs: readonly CreateUnitInput[]): VfsIndexUnit[] {
    if (inputs.length === 0) return [];
    return databaseResult(() => withSavepoint(conn, 'vfs_unit_batch_create', () => {
      const units: VfsIndexUnit[] = [];
      for (const input of inputs) {
        const id = generateUnitId();
        const now = nowMs();
        const textRequired = input.textContent !== null && input.textContent !== '';
        const mmRequired = input.imageBlobHash !== null;
        const contentHash = computeContentHash(input.imageBlobHash, input.textContent);
        insertUnit(conn, input, id, now, textRequired, mmRequired, contentHash);
        units.push({
          id,
          resourceId: input.resourceId,
          unitIndex: input.unitIndex,
          imageBlobHash: input.imageBlobHash,
          imageMimeType: input.imageMimeType,
          textContent: input.textContent,
          textSource: input.textSource,
          contentHash,
          textRequired,
          textState: textRequired ? 'pending' : 'disabled',
          textError: null,
          textIndexedAt: null,
          textChunkCount: 0,
          textEmbeddingDim: null,
          textProfileId: null,
          textGeneration: 0,
          mmRequired,
          mmState: mmRequired ? 'pending' : 'disabled',
          mmError: null,
          mmIndexedAt: null,
          mmEmbeddingDim: null,
          mmProfileId: null,
          mmGeneration: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      return units;
    }, 'unit batch rollback failed'));
  }

  syncUnits(conn: SqlExecutor, resourceId: string, inputs: readonly CreateUnitInput[]): SyncUnitsResult {
    return databaseResult(() => withSavepoint(conn, 'vfs_sync_units', () => {
      const existing = getByResource(conn, resourceId);
      const existingMap = new Map<number, VfsIndexUnit>(existing.map(unit => [unit.unitIndex, unit]));
      const result: VfsIndexUnit[] = [];
      const inputIndices = new Set(inputs.map(input => input.unitIndex));
      const orphanedLanceRowIds: string[] = [];

      for (const input of inputs) {
        const newHash = computeContentHash(input.imageBlobHash, input.textContent);
        const existingUnit = existingMap.get(input.unitIndex);
        if (existingUnit !== undefined) {
          if (existingUnit.contentHash === newHash) {
            result.push(existingUnit);
          } else {
            const textRequired = input.textContent !== null && input.textContent !== '';
            const mmRequired = input.imageBlobHash !== null;
            const textChanged = existingUnit.textContent !== input.textContent
              || existingUnit.textRequired !== textRequired;
            const imageChanged = existingUnit.imageBlobHash !== input.imageBlobHash
              || existingUnit.mmRequired !== mmRequired;
            const updated: VfsIndexUnit = {
              ...existingUnit,
              imageBlobHash: input.imageBlobHash,
              imageMimeType: input.imageMimeType,
              textContent: input.textContent,
              textSource: input.textSource,
              contentHash: newHash,
              textRequired,
              mmRequired,
            };
            if (textChanged) {
              orphanedLanceRowIds.push(...this.segments.listLanceRowIdsByUnitAndModality(
                conn, existingUnit.id, MODALITY_TEXT));
              this.segments.replaceByUnitAndModality(conn, resourceId, existingUnit.id, MODALITY_TEXT, []);
              updated.textState = textRequired ? 'pending' : 'disabled';
              updated.textError = null;
              updated.textIndexedAt = null;
              updated.textChunkCount = 0;
              updated.textEmbeddingDim = null;
              updated.textProfileId = null;
            }
            if (imageChanged) {
              orphanedLanceRowIds.push(...this.segments.listLanceRowIdsByUnitAndModality(
                conn, existingUnit.id, MODALITY_MULTIMODAL));
              this.segments.replaceByUnitAndModality(conn, resourceId, existingUnit.id, MODALITY_MULTIMODAL, []);
              updated.mmState = mmRequired ? 'pending' : 'disabled';
              updated.mmError = null;
              updated.mmIndexedAt = null;
              updated.mmEmbeddingDim = null;
              updated.mmProfileId = null;
            }
            updateUnit(conn, updated);
            result.push(updated);
          }
        } else {
          result.push(createInner(conn, input));
        }
      }

      for (const [index, existingUnit] of existingMap) {
        if (!inputIndices.has(index)) {
          const ids = this.segments.listLanceRowIdsByUnit(conn, existingUnit.id);
          for (const rowId of ids) this.segments.enqueueLanceOrphan(conn, rowId, resourceId);
          orphanedLanceRowIds.push(...ids);
          this.deleteUnsafe(conn, existingUnit.id);
        }
      }
      return { units: result, orphanedLanceRowIds };
    }, 'sync_units rollback failed'));
  }

  syncMultimodalUnits(conn: SqlExecutor, resourceId: string, inputs: readonly CreateUnitInput[],
    forceRebuild: boolean): SyncMultimodalUnitsResult {
    return databaseResult(() => {
      const existing = getByResource(conn, resourceId);
      const existingMap = new Map<number, VfsIndexUnit>(existing.map(unit => [unit.unitIndex, unit]));
      const seen = new Set<number>();
      const units: VfsIndexUnit[] = [];
      const orphanedLanceRowIds: string[] = [];

      for (const input of inputs) {
        if (seen.has(input.unitIndex)) {
          throw otherMessage(`duplicate multimodal page index ${input.unitIndex} for resource ${resourceId}`);
        }
        seen.add(input.unitIndex);
        if (input.imageBlobHash === null) {
          throw otherMessage(`multimodal page ${input.unitIndex} for resource ${resourceId} is missing blob_hash`);
        }
        const existingUnit = existingMap.get(input.unitIndex);
        if (existingUnit !== undefined) {
          const imageChanged = existingUnit.imageBlobHash !== input.imageBlobHash
            || existingUnit.imageMimeType !== input.imageMimeType;
          const updated: VfsIndexUnit = {
            ...existingUnit,
            imageBlobHash: input.imageBlobHash,
            imageMimeType: input.imageMimeType,
            mmRequired: true,
          };
          if (imageChanged || forceRebuild) {
            orphanedLanceRowIds.push(...this.segments.listLanceRowIdsByUnitAndModality(
              conn, existingUnit.id, MODALITY_MULTIMODAL));
            this.segments.replaceByUnitAndModality(conn, resourceId, existingUnit.id, MODALITY_MULTIMODAL, []);
            updated.mmState = 'pending';
            updated.mmError = null;
            updated.mmIndexedAt = null;
            updated.mmEmbeddingDim = null;
            updated.mmProfileId = null;
          }
          updateUnit(conn, updated);
          const reloaded = getById(conn, updated.id);
          if (reloaded === null) throw notFound('Unit', updated.id);
          units.push(reloaded);
        } else {
          units.push(createInner(conn, input));
        }
      }

      for (const [index, existingUnit] of existingMap) {
        if (seen.has(index)) continue;
        const ids = this.segments.listLanceRowIdsByUnitAndModality(
          conn, existingUnit.id, MODALITY_MULTIMODAL);
        orphanedLanceRowIds.push(...ids);
        this.segments.replaceByUnitAndModality(conn, resourceId, existingUnit.id, MODALITY_MULTIMODAL, []);
        const updated: VfsIndexUnit = {
          ...existingUnit,
          imageBlobHash: null,
          imageMimeType: null,
          mmRequired: false,
          mmState: 'disabled',
          mmError: null,
          mmIndexedAt: null,
          mmEmbeddingDim: null,
        };
        updateUnit(conn, updated);
      }

      return { units, orphanedLanceRowIds };
    });
  }

  clearMultimodalIndex(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => {
      const removed = this.segments.enqueueAndDeleteByResourceAndModality(
        conn, resourceId, MODALITY_MULTIMODAL);
      conn.run(`UPDATE vfs_index_units SET
          mm_required = 0,
          mm_state = 'disabled',
          mm_error = NULL,
          mm_indexed_at = NULL,
          mm_embedding_dim = NULL,
          mm_profile_id = NULL,
          updated_at = ?2
        WHERE resource_id = ?1`, [resourceId, nowMs()]);
      return removed;
    });
  }
}
