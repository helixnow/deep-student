/** Port of dstu-vfs index_segment_repo.rs. All functions take the caller's connection. */
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type CreateSegmentInput,
  type IndexSegmentRepository,
  type LanceTableExpectedCount,
  type ModalityDimStats,
  type VfsIndexSegment,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { exactInteger, safeIntegerQuery } from './sql-integers.ts';

const SEGMENT_COLUMNS = `id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
  content_text, content_hash, start_pos, end_pos, metadata_json, index_profile_id,
  generation, created_at, updated_at`;

function nowMs(): number { return Date.now(); }
function generateSegmentId(): string { return `seg_${nanoid(10)}`; }

function notFound(id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `Segment not found: ${id}`, { resourceType: 'Segment', id });
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
function readOptionalText(row: Row, name: string, index: number): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readOptionalInteger(row: Row, name: string, index: number): number | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  return readInteger(row, name, index);
}
/** i64 generation (R12-09): exact, never rounded through Number. */
function readGeneration(row: Row, name: string, index: number): number | bigint {
  const value = row[name];
  if (value === null || value === undefined) return 0;
  const exact = exactInteger(value);
  if (exact === null) throw columnError(index, name, value);
  return exact;
}

const SELECT_SEGMENT_BY_ID = safeIntegerQuery(
  `SELECT ${SEGMENT_COLUMNS} FROM vfs_index_segments WHERE id = ?1`, 'vfsRepos.segment.getById');
const SELECT_SEGMENTS_BY_UNIT = safeIntegerQuery(
  `SELECT ${SEGMENT_COLUMNS} FROM vfs_index_segments WHERE unit_id = ?1 ORDER BY segment_index ASC`,
  'vfsRepos.segment.getByUnit');
const SELECT_SEGMENTS_BY_UNIT_MODALITY = safeIntegerQuery(
  `SELECT ${SEGMENT_COLUMNS} FROM vfs_index_segments
   WHERE unit_id = ?1 AND modality = ?2 ORDER BY segment_index ASC`, 'vfsRepos.segment.getByUnitAndModality');
const SELECT_UNIT_PROFILE_BY_MODALITY = safeIntegerQuery(
  `SELECT
      CASE WHEN ?2 IN ('image', 'multimodal') THEN mm_profile_id ELSE text_profile_id END AS profile_id,
      CASE WHEN ?2 IN ('image', 'multimodal') THEN mm_generation ELSE text_generation END AS generation
   FROM vfs_index_units WHERE id = ?1`, 'vfsRepos.segment.unitProfile');
const SELECT_UNIT_PROFILE_BY_FLAG = safeIntegerQuery(
  `SELECT
      CASE WHEN ?2 THEN mm_profile_id ELSE text_profile_id END AS profile_id,
      CASE WHEN ?2 THEN mm_generation ELSE text_generation END AS generation
   FROM vfs_index_units WHERE id = ?1`, 'vfsRepos.segment.batchUnitProfile');

function rowToSegment(row: Row): VfsIndexSegment {
  return {
    id: readText(row, 'id', 0),
    unitId: readText(row, 'unit_id', 1),
    segmentIndex: readInteger(row, 'segment_index', 2),
    modality: readText(row, 'modality', 3),
    embeddingDim: readInteger(row, 'embedding_dim', 4),
    lanceRowId: readText(row, 'lance_row_id', 5),
    contentText: readOptionalText(row, 'content_text', 6),
    contentHash: readOptionalText(row, 'content_hash', 7),
    startPos: readOptionalInteger(row, 'start_pos', 8),
    endPos: readOptionalInteger(row, 'end_pos', 9),
    metadataJson: readOptionalText(row, 'metadata_json', 10),
    indexProfileId: readOptionalText(row, 'index_profile_id', 11),
    generation: readGeneration(row, 'generation', 12),
    createdAt: readInteger(row, 'created_at', 13),
    updatedAt: readInteger(row, 'updated_at', 14),
  };
}

/** Rust `VfsIndexSegment` row defaults: missing profile → None, missing generation → 0. */
function rowToSegmentTolerant(row: Row): VfsIndexSegment {
  const segment = rowToSegment(row);
  return segment;
}

function normalizeDimsModality(modality: string): string {
  return modality === 'image' ? 'multimodal' : modality;
}

function enqueueLanceOrphan(conn: SqlExecutor, lanceRowId: string, resourceId: string | null): void {
  conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
    VALUES (?1, ?2)
    ON CONFLICT(lance_row_id) DO UPDATE SET
        resource_id = COALESCE(excluded.resource_id, resource_id),
        enqueued_at = excluded.enqueued_at,
        next_retry_at = 0,
        last_error = NULL`, [lanceRowId, resourceId]);
}

function enqueueLanceOrphansByUnit(conn: SqlExecutor, unitId: string, modality: string | null): number {
  const conflict = `ON CONFLICT(lance_row_id) DO UPDATE SET
      resource_id = COALESCE(excluded.resource_id, resource_id),
      enqueued_at = excluded.enqueued_at,
      next_retry_at = 0,
      last_error = NULL`;
  if (modality !== null) {
    return conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
      SELECT s.lance_row_id, u.resource_id
      FROM vfs_index_segments s
      LEFT JOIN vfs_index_units u ON u.id = s.unit_id
      WHERE s.unit_id = ?1 AND s.modality = ?2
      ${conflict}`, [unitId, modality]).changes;
  }
  return conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
    SELECT s.lance_row_id, u.resource_id
    FROM vfs_index_segments s
    LEFT JOIN vfs_index_units u ON u.id = s.unit_id
    WHERE s.unit_id = ?1
    ${conflict}`, [unitId]).changes;
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

function createInner(conn: SqlExecutor, input: CreateSegmentInput): VfsIndexSegment {
  const id = generateSegmentId();
  const now = nowMs();
  const unitProfile = conn.get(SELECT_UNIT_PROFILE_BY_MODALITY, [input.unitId, input.modality]);
  let indexProfileId = unitProfile === undefined ? null : readOptionalText(unitProfile, 'profile_id', 0);
  const generation = unitProfile === undefined ? 0 : readGeneration(unitProfile, 'generation', 1);
  if (indexProfileId === null) {
    indexProfileId = conn.pluck<string | null>(
      `SELECT active_profile_id FROM vfs_embedding_dims
       WHERE dimension = ?1 AND modality = ?2`,
      [input.embeddingDim, normalizeDimsModality(input.modality)]) ?? null;
  }

  conn.run(`INSERT INTO vfs_index_segments (
      id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
      content_text, content_hash, start_pos, end_pos, metadata_json,
      index_profile_id, generation, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  [id, input.unitId, input.segmentIndex, input.modality, input.embeddingDim, input.lanceRowId,
    input.contentText, input.contentHash, input.startPos, input.endPos, input.metadataJson,
    indexProfileId, generation, now, now]);

  const created = conn.get(SELECT_SEGMENT_BY_ID, [id]);
  if (created === undefined) throw notFound(id);
  return rowToSegmentTolerant(created);
}

function batchCreateInner(conn: SqlExecutor, inputs: readonly CreateSegmentInput[]): VfsIndexSegment[] {
  const unitProfileCache = new Map<string, { profileId: string | null; generation: number | bigint } | null>();
  const dimsProfileCache = new Map<string, string | null>();
  const segments: VfsIndexSegment[] = [];
  for (const input of inputs) {
    const id = generateSegmentId();
    const now = nowMs();
    const isMm = input.modality === 'image' || input.modality === 'multimodal';
    const unitKey = `${input.unitId}\u0000${isMm ? '1' : '0'}`;
    let unitProfile = unitProfileCache.get(unitKey);
    if (unitProfile === undefined) {
      const row = conn.get(SELECT_UNIT_PROFILE_BY_FLAG, [input.unitId, isMm ? 1 : 0]);
      unitProfile = row === undefined ? null
        : { profileId: readOptionalText(row, 'profile_id', 0), generation: readGeneration(row, 'generation', 1) };
      unitProfileCache.set(unitKey, unitProfile);
    }
    let indexProfileId = unitProfile === null ? null : unitProfile.profileId;
    const generation = unitProfile === null ? 0 : unitProfile.generation;
    if (indexProfileId === null) {
      const dimsModality = normalizeDimsModality(input.modality);
      const dimsKey = `${input.embeddingDim}\u0000${dimsModality}`;
      let cached = dimsProfileCache.get(dimsKey);
      if (cached === undefined) {
        cached = conn.pluck<string | null>(
          `SELECT active_profile_id FROM vfs_embedding_dims
           WHERE dimension = ?1 AND modality = ?2`,
          [input.embeddingDim, dimsModality]) ?? null;
        dimsProfileCache.set(dimsKey, cached);
      }
      indexProfileId = cached;
    }

    conn.run(`INSERT INTO vfs_index_segments (
        id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
        content_text, content_hash, start_pos, end_pos, metadata_json,
        index_profile_id, generation, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    [id, input.unitId, input.segmentIndex, input.modality, input.embeddingDim, input.lanceRowId,
      input.contentText, input.contentHash, input.startPos, input.endPos, input.metadataJson,
      indexProfileId, generation, now, now]);

    segments.push({
      id,
      unitId: input.unitId,
      segmentIndex: input.segmentIndex,
      modality: input.modality,
      embeddingDim: input.embeddingDim,
      lanceRowId: input.lanceRowId,
      contentText: input.contentText,
      contentHash: input.contentHash,
      startPos: input.startPos,
      endPos: input.endPos,
      metadataJson: input.metadataJson,
      indexProfileId,
      generation,
      createdAt: now,
      updatedAt: now,
    });
  }
  return segments;
}

export class IndexSegmentRepo implements IndexSegmentRepository {
  enqueueLanceOrphan(conn: SqlExecutor, lanceRowId: string, resourceId: string | null): void {
    databaseResult(() => enqueueLanceOrphan(conn, lanceRowId, resourceId));
  }

  enqueueLanceOrphansByUnit(conn: SqlExecutor, unitId: string, modality: string | null): number {
    return databaseResult(() => enqueueLanceOrphansByUnit(conn, unitId, modality));
  }

  normalizeDimsModality(modality: string): string {
    return normalizeDimsModality(modality);
  }

  create(conn: SqlExecutor, input: CreateSegmentInput): VfsIndexSegment {
    return databaseResult(() => createInner(conn, input));
  }

  batchCreate(conn: SqlExecutor, inputs: readonly CreateSegmentInput[]): VfsIndexSegment[] {
    if (inputs.length === 0) return [];
    return databaseResult(() => withSavepoint(conn, 'vfs_segment_batch_create',
      () => batchCreateInner(conn, inputs), 'segment batch rollback failed'));
  }

  getById(conn: SqlExecutor, id: string): VfsIndexSegment | null {
    return databaseResult(() => {
      const row = conn.get(SELECT_SEGMENT_BY_ID, [id]);
      return row === undefined ? null : rowToSegmentTolerant(row);
    });
  }

  getByUnit(conn: SqlExecutor, unitId: string): VfsIndexSegment[] {
    return databaseResult(() => conn.all(SELECT_SEGMENTS_BY_UNIT, [unitId]).map(rowToSegmentTolerant));
  }

  getByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): VfsIndexSegment[] {
    return databaseResult(() => conn.all(SELECT_SEGMENTS_BY_UNIT_MODALITY, [unitId, modality])
      .map(rowToSegmentTolerant));
  }

  deleteByUnit(conn: SqlExecutor, unitId: string): number {
    return databaseResult(() => {
      enqueueLanceOrphansByUnit(conn, unitId, null);
      return this.deleteByUnitUnsafe(conn, unitId);
    });
  }

  deleteByUnitUnsafe(conn: SqlExecutor, unitId: string): number {
    return databaseResult(() => conn.run(
      'DELETE FROM vfs_index_segments WHERE unit_id = ?1', [unitId]).changes);
  }

  deleteByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): number {
    return databaseResult(() => {
      enqueueLanceOrphansByUnit(conn, unitId, modality);
      return this.deleteByUnitAndModalityUnsafe(conn, unitId, modality);
    });
  }

  deleteByUnitAndModalityUnsafe(conn: SqlExecutor, unitId: string, modality: string): number {
    return databaseResult(() => conn.run(
      'DELETE FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2',
      [unitId, modality]).changes);
  }

  replaceByUnitAndModality(conn: SqlExecutor, resourceId: string, unitId: string,
    modality: string, inputs: readonly CreateSegmentInput[]): VfsIndexSegment[] {
    return databaseResult(() => {
      if (inputs.some(input => input.unitId !== unitId || input.modality !== modality)) {
        throw otherMessage(`segment replacement scope mismatch: unit=${unitId}, modality=${modality}`);
      }
      const keepIds = new Set(inputs.map(input => input.lanceRowId));
      for (const keepId of keepIds) {
        conn.run('DELETE FROM __lance_orphan_queue WHERE lance_row_id = ?1', [keepId]);
      }
      for (const oldId of this.listLanceRowIdsByUnitAndModality(conn, unitId, modality)) {
        if (!keepIds.has(oldId)) enqueueLanceOrphan(conn, oldId, resourceId);
      }
      this.deleteByUnitAndModalityUnsafe(conn, unitId, modality);
      return this.batchCreate(conn, inputs);
    });
  }

  enqueueAndDeleteByResourceAndModality(conn: SqlExecutor, resourceId: string, modality: string): number {
    return databaseResult(() => {
      conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
        SELECT s.lance_row_id, u.resource_id
        FROM vfs_index_segments s
        JOIN vfs_index_units u ON u.id = s.unit_id
        WHERE u.resource_id = ?1 AND s.modality = ?2
        ON CONFLICT(lance_row_id) DO UPDATE SET
            resource_id = excluded.resource_id,
            enqueued_at = excluded.enqueued_at,
            next_retry_at = 0,
            last_error = NULL`, [resourceId, modality]);
      return conn.run(`DELETE FROM vfs_index_segments
        WHERE modality = ?2
          AND unit_id IN (SELECT id FROM vfs_index_units WHERE resource_id = ?1)`,
      [resourceId, modality]).changes;
    });
  }

  deleteByLanceRowId(conn: SqlExecutor, lanceRowId: string): boolean {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT u.resource_id AS resource_id FROM vfs_index_segments s
         LEFT JOIN vfs_index_units u ON u.id = s.unit_id
         WHERE s.lance_row_id = ?1`, [lanceRowId]);
      const resourceId = row === undefined ? null : readOptionalText(row, 'resource_id', 0);
      enqueueLanceOrphan(conn, lanceRowId, resourceId);
      return this.deleteByLanceRowIdUnsafe(conn, lanceRowId);
    });
  }

  deleteByLanceRowIdUnsafe(conn: SqlExecutor, lanceRowId: string): boolean {
    return databaseResult(() => conn.run(
      'DELETE FROM vfs_index_segments WHERE lance_row_id = ?1', [lanceRowId]).changes > 0);
  }

  delete(conn: SqlExecutor, id: string): boolean {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT s.lance_row_id AS lance_row_id, u.resource_id AS resource_id
         FROM vfs_index_segments s
         LEFT JOIN vfs_index_units u ON u.id = s.unit_id
         WHERE s.id = ?1`, [id]);
      if (row !== undefined) {
        enqueueLanceOrphan(conn, readText(row, 'lance_row_id', 0), readOptionalText(row, 'resource_id', 1));
      }
      return conn.run('DELETE FROM vfs_index_segments WHERE id = ?1', [id]).changes > 0;
    });
  }

  countByModalityAndDim(conn: SqlExecutor, modality: string, embeddingDim: number): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM vfs_index_segments WHERE modality = ?1 AND embedding_dim = ?2',
      [modality, embeddingDim]) ?? 0));
  }

  listLanceRowIdsByUnit(conn: SqlExecutor, unitId: string): string[] {
    return databaseResult(() => conn.all<Row>(
      'SELECT lance_row_id FROM vfs_index_segments WHERE unit_id = ?1', [unitId])
      .map(row => readText(row, 'lance_row_id', 0)));
  }

  listLanceRowIdsByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): string[] {
    return databaseResult(() => conn.all<Row>(
      'SELECT lance_row_id FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2',
      [unitId, modality]).map(row => readText(row, 'lance_row_id', 0)));
  }

  getModalityDimStats(conn: SqlExecutor): ModalityDimStats[] {
    return databaseResult(() => conn.all<Row>(
      `SELECT modality, embedding_dim, COUNT(*) AS count
       FROM vfs_index_segments GROUP BY modality, embedding_dim`)
      .map(row => ({
        modality: readText(row, 'modality', 0),
        embeddingDim: readInteger(row, 'embedding_dim', 1),
        count: readInteger(row, 'count', 2),
      })));
  }

  listExpectedLanceRowCounts(conn: SqlExecutor): LanceTableExpectedCount[] {
    return databaseResult(() => conn.all<Row>(
      `SELECT
          COALESCE(
              p.lance_table_name,
              d.lance_table_name,
              'vfs_emb_' ||
                  CASE WHEN s.modality = 'image' THEN 'multimodal' ELSE s.modality END ||
                  '_' || s.embedding_dim
          ) AS lance_table_name,
          COUNT(*) AS segment_count,
          SUM(CASE WHEN q.lance_row_id IS NOT NULL THEN 1 ELSE 0 END) AS pending_orphan_count
       FROM vfs_index_segments s
       LEFT JOIN vfs_index_profiles p ON p.id = s.index_profile_id
       LEFT JOIN vfs_embedding_dims d
          ON d.dimension = s.embedding_dim
         AND d.modality = CASE WHEN s.modality = 'image' THEN 'multimodal' ELSE s.modality END
       LEFT JOIN __lance_orphan_queue q ON q.lance_row_id = s.lance_row_id
       GROUP BY lance_table_name
       ORDER BY lance_table_name`)
      .map(row => ({
        lanceTableName: readText(row, 'lance_table_name', 0),
        segmentCount: readInteger(row, 'segment_count', 1),
        pendingOrphanCount: Number(row.pending_orphan_count ?? 0),
      })));
  }

  countPendingLanceOrphans(conn: SqlExecutor): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM __lance_orphan_queue') ?? 0));
  }
}
