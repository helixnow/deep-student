/** Port of dstu-vfs embedding_dim_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type DimensionCascadeCleanup,
  type EmbeddingDimRepository,
  type EmbeddingModelConfig,
  type VfsEmbeddingDim,
  type VfsIndexProfile,
} from '../api.ts';
import { databaseResult } from './errors.ts';

export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;
export const INDEX_PROFILE_SCHEMA_VERSION = 1;
export const PRESET_DIMENSIONS: readonly number[] = [256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];
export const MODALITY_TEXT = 'text';
export const MODALITY_MULTIMODAL = 'multimodal';

const DIM_COLUMNS = `dimension, modality, lance_table_name, record_count, created_at, last_used_at,
  model_config_id, model_name, active_profile_id, model_fingerprint, embedding_protocol,
  active_generation, ann_metric, ann_index_version`;

function nowMs(): number { return Date.now(); }

function sha256(parts: readonly string[]): string {
  const hash = createHasherSync('SHA-256');
  for (const part of parts) hash.update(part);
  return hash.digestHex();
}

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
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function rowToDim(row: Row): VfsEmbeddingDim {
  return {
    dimension: readInteger(row, 'dimension', 0),
    modality: readText(row, 'modality', 1),
    lanceTableName: readText(row, 'lance_table_name', 2),
    recordCount: readInteger(row, 'record_count', 3),
    createdAt: readInteger(row, 'created_at', 4),
    lastUsedAt: readInteger(row, 'last_used_at', 5),
    modelConfigId: optionalText(row.model_config_id),
    modelName: optionalText(row.model_name),
    activeProfileId: optionalText(row.active_profile_id),
    modelFingerprint: optionalText(row.model_fingerprint),
    embeddingProtocol: optionalText(row.embedding_protocol) ?? 'legacy',
    activeGeneration: optionalInteger(row.active_generation) ?? 0,
    annMetric: optionalText(row.ann_metric) ?? 'legacy_l2',
    annIndexVersion: optionalInteger(row.ann_index_version) ?? 0,
  };
}

function rowToProfile(row: Row): VfsIndexProfile {
  return {
    id: readText(row, 'id', 0),
    modelFingerprint: readText(row, 'model_fingerprint', 1),
    modelConfigId: optionalText(row.model_config_id),
    modelName: optionalText(row.model_name),
    dimension: readInteger(row, 'dimension', 4),
    modality: readText(row, 'modality', 5),
    embeddingProtocol: readText(row, 'embedding_protocol', 6),
    schemaVersion: readInteger(row, 'schema_version', 7),
    lanceTableName: readText(row, 'lance_table_name', 8),
    activeGeneration: readInteger(row, 'active_generation', 9),
    state: readText(row, 'state', 10),
    annMetric: readText(row, 'ann_metric', 11),
    annIndexVersion: readInteger(row, 'ann_index_version', 12),
    createdAt: readInteger(row, 'created_at', 13),
    updatedAt: readInteger(row, 'updated_at', 14),
  };
}

/** Rust `committed_profile_segment_count`: segments visible through unit profile/generation. */
function committedProfileSegmentCount(conn: SqlExecutor, profileId: string, modality: string): number {
  const ledgerMatch = modality === 'text'
    ? `s.modality = 'text'
       AND u.text_profile_id = s.index_profile_id
       AND u.text_generation = s.generation`
    : modality === 'image' || modality === 'multimodal'
      ? `s.modality IN ('image', 'multimodal')
         AND u.mm_profile_id = s.index_profile_id
         AND u.mm_generation = s.generation`
      : null;
  if (ledgerMatch === null) {
    throw invalidArgument('modality', `Unsupported embedding modality: ${modality}`);
  }
  return Number(conn.pluck<number>(
    `SELECT COUNT(*)
     FROM vfs_index_segments s
     JOIN vfs_index_units u ON u.id = s.unit_id
     WHERE s.index_profile_id = ?1
       AND ${ledgerMatch}`,
    [profileId]) ?? 0);
}

function normalizedPublicBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try { url = new URL(trimmed); }
  catch { return trimmed.replace(/\/+$/, '').toLowerCase(); }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath === '' ? '/' : normalizedPath;
  return url.toString().replace(/\/+$/, '');
}

function generateIndexProfileId(fingerprint: string, dimension: number, modality: string,
  protocol: string): string {
  const parts: string[] = ['vfs-index-profile-id-v1\0'];
  for (const value of [fingerprint, modality, String(dimension), protocol, String(INDEX_PROFILE_SCHEMA_VERSION)]) {
    parts.push(value, '\0');
  }
  return `profile_${sha256(parts)}`;
}

function validateDimensionAndModality(dimension: number, modality: string): void {
  if (dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
    throw invalidArgument('dimension',
      `Dimension ${dimension} out of valid range [${MIN_DIMENSION}, ${MAX_DIMENSION}]`);
  }
  embeddingProtocolForModality(modality);
}

function ensureBindingIsCompatible(existing: VfsEmbeddingDim | null, requestedFingerprint: string | null,
  targetTableName: string): void {
  if (existing === null || requestedFingerprint === null) return;
  if (existing.recordCount <= 0) return;
  const sameSpace = existing.modelFingerprint === requestedFingerprint;
  if (sameSpace || existing.lanceTableName !== targetTableName) return;
  throw invalidArgument('model_config_id',
    `Vector space ${existing.modality}:${existing.dimension} already contains ${existing.recordCount} rows in Lance table ${existing.lanceTableName} under fingerprint ${existing.modelFingerprint === null ? 'None' : `Some(${JSON.stringify(existing.modelFingerprint)})`}; refusing to bind fingerprint ${requestedFingerprint} into the same table. Rebuild into a new index profile first.`);
}

export function embeddingProtocolForModality(modality: string): string {
  if (modality === 'text') return 'text-embedding-v1';
  if (modality === 'image' || modality === 'multimodal') return 'multimodal-embedding-v1';
  throw invalidArgument('modality', `Unsupported embedding modality: ${modality}`);
}

export function modelFingerprintWithTransport(modelConfigId: string, modelName: string, protocol: string,
  providerType: string | null, providerScope: string | null, baseUrl: string | null,
  apiProtocol: string | null, modelAdapter: string | null): string {
  const normalizedBaseUrl = baseUrl === null ? '' : normalizedPublicBaseUrl(baseUrl);
  const parts: string[] = ['vfs-index-profile-v2\0'];
  for (const [label, value] of [
    ['protocol', protocol],
    ['config_id', modelConfigId],
    ['model', modelName],
    ['provider_type', providerType ?? ''],
    ['provider_scope', providerScope ?? ''],
    ['base_url', normalizedBaseUrl],
    ['api_protocol', apiProtocol ?? ''],
    ['model_adapter', modelAdapter ?? ''],
  ] as const) {
    parts.push(label, '\0', value, '\0');
  }
  return `sha256:${sha256(parts)}`;
}

export function modelFingerprint(modelConfigId: string, modelName: string, protocol: string): string {
  return modelFingerprintWithTransport(modelConfigId, modelName, protocol, null, null, null, null, null);
}

export function modelFingerprintForConfig(config: EmbeddingModelConfig, modality: string): string {
  const protocol = embeddingProtocolForModality(modality);
  return modelFingerprintWithTransport(config.id, config.model, protocol,
    config.providerType ?? null, config.providerScope ?? null, config.baseUrl,
    config.apiProtocol ?? null, config.modelAdapter);
}

export function generateLanceTableName(modality: string, dimension: number): string {
  return `vfs_emb_${modality}_${dimension}`;
}

export function generateProfileLanceTableName(modality: string, dimension: number, fingerprint: string): string {
  const withoutPrefix = fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint;
  const suffix = [...withoutPrefix].filter(ch => /[A-Za-z0-9]/.test(ch)).slice(0, 16).join('');
  return `vfs_emb_${modality}_${dimension}_${suffix}`;
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
      throw databaseMessage(`${errorMessage(error)}; ${failurePrefix}: ${errorMessage(rollbackError)}`);
    }
    throw error;
  }
}

function registerWithModelFingerprintInner(this: EmbeddingDimRepo, conn: SqlExecutor, dimension: number, modality: string,
  modelConfigId: string | null, modelName: string | null, fingerprintOverride: string | null): VfsEmbeddingDim {
  validateDimensionAndModality(dimension, modality);
  const now = nowMs();
  const protocol = embeddingProtocolForModality(modality);
  const effectiveModelId = modelConfigId === null || modelConfigId === '' ? null : modelConfigId;
  const effectiveModelName = (modelName === null || modelName === ''
    ? null : modelName) ?? effectiveModelId;
  const fingerprint = effectiveModelId === null ? null
    : (fingerprintOverride ?? modelFingerprint(effectiveModelId, effectiveModelName ?? effectiveModelId, protocol));

  const existing = this.getByKey(conn, dimension, modality);
  const sameSpace = existing !== null && existing.modelFingerprint === fingerprint;
  const previousProfileId = existing?.activeProfileId ?? null;
  let previousProfileAssigned = false;
  if (previousProfileId !== null) {
    const column = modality === 'text' ? 'text_profile_id' : 'mm_profile_id';
    previousProfileAssigned = Number(conn.pluck<number>(
      `SELECT EXISTS(SELECT 1 FROM vfs_index_units WHERE ${column} = ?1)`,
      [previousProfileId]) ?? 0) !== 0;
  }
  const previousProfileHasCommittedManifest = previousProfileId !== null
    && committedProfileSegmentCount(conn, previousProfileId, modality) > 0;
  const switchingSpace = !sameSpace && fingerprint !== null;
  const switchingCommittedSpace = switchingSpace && previousProfileHasCommittedManifest;

  let reusableProfile: { id: string; lanceTableName: string } | null = null;
  if (fingerprint !== null) {
    const row = conn.get<Row>(
      `SELECT id, lance_table_name FROM vfs_index_profiles
       WHERE model_fingerprint = ?1 AND dimension = ?2 AND modality = ?3
         AND embedding_protocol = ?4 AND schema_version = ?5`,
      [fingerprint, dimension, modality, protocol, INDEX_PROFILE_SCHEMA_VERSION]);
    if (row !== undefined) {
      reusableProfile = { id: readText(row, 'id', 0), lanceTableName: readText(row, 'lance_table_name', 1) };
    }
  }

  let tableName: string;
  if (existing !== null && sameSpace) tableName = existing.lanceTableName;
  else if (fingerprint !== null && reusableProfile !== null) tableName = reusableProfile.lanceTableName;
  else if (fingerprint !== null) tableName = generateProfileLanceTableName(modality, dimension, fingerprint);
  else if (existing !== null) tableName = existing.lanceTableName;
  else tableName = generateLanceTableName(modality, dimension);

  ensureBindingIsCompatible(existing, fingerprint, tableName);

  let profileId: string;
  if (sameSpace) {
    profileId = previousProfileId ?? `profile_legacy_${modality}_${dimension}`;
  } else if (fingerprint !== null) {
    profileId = reusableProfile?.id ?? generateIndexProfileId(fingerprint, dimension, modality, protocol);
  } else {
    profileId = `profile_unbound_${modality}_${dimension}`;
  }

  conn.run(`INSERT INTO vfs_embedding_dims (
      dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
    ) VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5, ?6)
    ON CONFLICT(dimension, modality) DO UPDATE SET
      last_used_at = ?4,
      model_config_id = COALESCE(?5, model_config_id),
      model_name = COALESCE(?6, model_name),
      lance_table_name = excluded.lance_table_name`,
  [dimension, modality, tableName, now, modelConfigId, modelName]);

  const effectiveFingerprint = fingerprint ?? `unbound:${modality}:${dimension}:${protocol}`;
  if (switchingCommittedSpace) {
    if (previousProfileId !== null) {
      conn.run(`UPDATE vfs_index_profiles SET state = 'queryable', updated_at = ?2
        WHERE id = ?1 AND state <> 'retired'`, [previousProfileId, now]);
    }
  } else if (!sameSpace) {
    if (previousProfileId !== null) {
      conn.run(`UPDATE vfs_index_profiles SET state = 'retired', updated_at = ?2 WHERE id = ?1`,
        [previousProfileId, now]);
    }
  }

  if (sameSpace) {
    conn.run(`UPDATE vfs_index_profiles SET
        model_fingerprint = ?2, model_config_id = COALESCE(?3, model_config_id),
        model_name = COALESCE(?4, model_name), embedding_protocol = ?5,
        lance_table_name = ?6, state = 'active', updated_at = ?7
      WHERE id = ?1`,
    [profileId, effectiveFingerprint, effectiveModelId, modelName, protocol, tableName, now]);
  } else {
    const newState = switchingCommittedSpace ? 'building' : 'active';
    conn.run(`INSERT INTO vfs_index_profiles (
        id, model_fingerprint, model_config_id, model_name, dimension, modality,
        embedding_protocol, schema_version, lance_table_name, active_generation,
        state, ann_metric, ann_index_version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, 'exact', 0, ?11, ?11)
      ON CONFLICT(model_fingerprint, dimension, modality, embedding_protocol, schema_version)
      DO UPDATE SET model_name = COALESCE(excluded.model_name, model_name),
                    model_config_id = COALESCE(excluded.model_config_id, model_config_id),
                    state = excluded.state, updated_at = excluded.updated_at`,
    [profileId, effectiveFingerprint, effectiveModelId, modelName, dimension, modality, protocol,
      INDEX_PROFILE_SCHEMA_VERSION, tableName, newState, now]);
  }

  conn.run(`UPDATE vfs_embedding_dims
    SET active_profile_id = ?3,
        model_fingerprint = ?4,
        embedding_protocol = ?5,
        lance_table_name = ?6,
        model_config_id = COALESCE(?7, model_config_id),
        model_name = COALESCE(?8, model_name)
    WHERE dimension = ?1 AND modality = ?2`,
  [dimension, modality, profileId, effectiveFingerprint, protocol, tableName, effectiveModelId, modelName]);

  if (switchingSpace && previousProfileAssigned && previousProfileId !== null) {
    const [stateColumn, profileColumn] = modality === 'text'
      ? ['text_state', 'text_profile_id'] : ['mm_state', 'mm_profile_id'];
    conn.run(`UPDATE vfs_index_units SET ${stateColumn} = 'pending', updated_at = ?2
      WHERE ${profileColumn} = ?1`, [previousProfileId, now]);
    const [resourceState, retryColumn, retryAtColumn, errorColumn] = modality === 'text'
      ? ['index_state', 'index_retry_count', 'index_next_retry_at', 'index_error']
      : ['mm_index_state', 'mm_index_retry_count', 'mm_index_next_retry_at', 'mm_index_error'];
    conn.run(`UPDATE resources SET ${resourceState} = 'pending', ${retryColumn} = 0,
        ${retryAtColumn} = 0, ${errorColumn} = NULL
      WHERE id IN (SELECT resource_id FROM vfs_index_units WHERE ${profileColumn} = ?1)`,
    [previousProfileId]);
  }

  const result = this.getByKey(conn, dimension, modality);
  if (result === null) throw notFound('EmbeddingDim', `${dimension}:${modality}`);
  return result;
}

export class EmbeddingDimRepo implements EmbeddingDimRepository {
  embeddingProtocolForModality(modality: string): string {
    return embeddingProtocolForModality(modality);
  }

  modelFingerprint(modelConfigId: string, modelName: string, protocol: string): string {
    return modelFingerprint(modelConfigId, modelName, protocol);
  }

  modelFingerprintWithTransport(modelConfigId: string, modelName: string, protocol: string,
    providerType: string | null, providerScope: string | null, baseUrl: string | null,
    apiProtocol: string | null, modelAdapter: string | null): string {
    return modelFingerprintWithTransport(modelConfigId, modelName, protocol, providerType,
      providerScope, baseUrl, apiProtocol, modelAdapter);
  }

  modelFingerprintForConfig(config: EmbeddingModelConfig, modality: string): string {
    return modelFingerprintForConfig(config, modality);
  }

  generateLanceTableName(modality: string, dimension: number): string {
    return generateLanceTableName(modality, dimension);
  }

  generateProfileLanceTableName(modality: string, dimension: number, fingerprint: string): string {
    return generateProfileLanceTableName(modality, dimension, fingerprint);
  }

  register(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDim {
    return databaseResult(() => {
      validateDimensionAndModality(dimension, modality);
      const now = nowMs();
      const tableName = generateLanceTableName(modality, dimension);
      conn.run(`INSERT INTO vfs_embedding_dims (
          dimension, modality, lance_table_name, record_count, created_at, last_used_at, model_config_id, model_name
        ) VALUES (?1, ?2, ?3, 0, ?4, ?4, NULL, NULL)
        ON CONFLICT(dimension, modality) DO UPDATE SET last_used_at = ?4`,
      [dimension, modality, tableName, now]);
      const dim = this.getByKey(conn, dimension, modality);
      if (dim === null) throw notFound('EmbeddingDim', `${dimension}:${modality}`);
      return dim;
    });
  }

  registerWithModel(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): VfsEmbeddingDim {
    return this.registerWithModelFingerprint(conn, dimension, modality, modelConfigId, modelName, null);
  }

  registerWithModelFingerprint(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null, fingerprintOverride: string | null): VfsEmbeddingDim {
    return databaseResult(() => withSavepoint(conn, 'vfs_register_model_profile',
      () => registerWithModelFingerprintInner.call(this, conn, dimension, modality, modelConfigId,
        modelName, fingerprintOverride), 'profile registration rollback failed'));
  }

  getByKey(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDim | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${DIM_COLUMNS} FROM vfs_embedding_dims
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality]);
      return row === undefined ? null : rowToDim(row);
    });
  }

  listAll(conn: SqlExecutor): VfsEmbeddingDim[] {
    return databaseResult(() => conn.all(`SELECT ${DIM_COLUMNS} FROM vfs_embedding_dims
      ORDER BY modality, dimension`).map(rowToDim));
  }

  listByModality(conn: SqlExecutor, modality: string): VfsEmbeddingDim[] {
    return databaseResult(() => conn.all(`SELECT ${DIM_COLUMNS} FROM vfs_embedding_dims
      WHERE modality = ?1 ORDER BY dimension`, [modality]).map(rowToDim));
  }

  updateCount(conn: SqlExecutor, dimension: number, modality: string, count: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_embedding_dims SET record_count = ?3, last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality, count, nowMs()]);
    });
  }

  incrementCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_embedding_dims SET record_count = record_count + ?3, last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality, delta, nowMs()]);
    });
  }

  decrementCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_embedding_dims SET record_count = MAX(0, record_count - ?3), last_used_at = ?4
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality, delta, nowMs()]);
    });
  }

  delete(conn: SqlExecutor, dimension: number, modality: string): boolean {
    return databaseResult(() => conn.run(
      'DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2',
      [dimension, modality]).changes > 0);
  }

  createDimension(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): VfsEmbeddingDim {
    return databaseResult(() => {
      validateDimensionAndModality(dimension, modality);
      return this.registerWithModel(conn, dimension, modality, modelConfigId, modelName);
    });
  }

  getActiveProfile(conn: SqlExecutor, dimension: number, modality: string): VfsIndexProfile | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT p.* FROM vfs_embedding_dims d
        JOIN vfs_index_profiles p ON p.id = d.active_profile_id
        WHERE d.dimension = ?1 AND d.modality = ?2
          AND p.state IN ('active', 'building', 'queryable')`, [dimension, modality]);
      return row === undefined ? null : rowToProfile(row);
    });
  }

  getProfileById(conn: SqlExecutor, profileId: string): VfsIndexProfile | null {
    return databaseResult(() => {
      const row = conn.get('SELECT * FROM vfs_index_profiles WHERE id = ?1', [profileId]);
      return row === undefined ? null : rowToProfile(row);
    });
  }

  beginProfileRebuild(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): VfsIndexProfile {
    return databaseResult(() => {
      this.registerWithModel(conn, dimension, modality, modelConfigId, modelName);
      const profile = this.getActiveProfile(conn, dimension, modality);
      if (profile === null) {
        throw notFound('IndexProfile', `${modality}:${dimension}:${modelConfigId}`);
      }
      return profile;
    });
  }

  activateProfile(conn: SqlExecutor, profileId: string, minSegmentCount: number): VfsIndexProfile {
    return databaseResult(() => {
      const profile = this.getProfileById(conn, profileId);
      if (profile === null) throw notFound('IndexProfile', profileId);
      const segmentCount = committedProfileSegmentCount(conn, profileId, profile.modality);
      const required = Math.max(minSegmentCount, 1);
      if (segmentCount < required) {
        throw invalidState(`Profile ${profileId} has ${segmentCount} validated segments; ${required} required`);
      }
      conn.run("UPDATE vfs_index_profiles SET state = 'active', updated_at = ?2 WHERE id = ?1",
        [profileId, nowMs()]);
      const updated = this.getProfileById(conn, profileId);
      if (updated === null) throw notFound('IndexProfile', profileId);
      return updated;
    });
  }

  listActiveProfiles(conn: SqlExecutor, modality: string | null): VfsIndexProfile[] {
    return databaseResult(() => {
      const base = `SELECT DISTINCT p.* FROM vfs_index_profiles p
        WHERE p.state IN ('active', 'building', 'queryable')`;
      const visibility = `AND (EXISTS (SELECT 1 FROM vfs_embedding_dims d WHERE d.active_profile_id = p.id)
          OR EXISTS (SELECT 1 FROM vfs_index_segments s WHERE s.index_profile_id = p.id))
        ORDER BY p.modality, p.dimension, p.id`;
      return modality === null
        ? conn.all(`${base} ${visibility}`).map(rowToProfile)
        : conn.all(`${base} AND p.modality = ?1 ${visibility}`, [modality]).map(rowToProfile);
    });
  }

  setAnnStatus(conn: SqlExecutor, dimension: number, modality: string, metric: string, version: number): void {
    databaseResult(() => {
      const now = nowMs();
      conn.run(`UPDATE vfs_embedding_dims
        SET ann_metric = ?3, ann_index_version = ?4, last_used_at = ?5
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality, metric, version, now]);
      conn.run(`UPDATE vfs_index_profiles
        SET ann_metric = ?2, ann_index_version = ?3, updated_at = ?4
        WHERE id = (SELECT active_profile_id FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?5)`,
      [dimension, metric, version, now, modality]);
    });
  }

  setProfileAnnStatus(conn: SqlExecutor, profileId: string, metric: string, version: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_index_profiles SET ann_metric = ?2, ann_index_version = ?3, updated_at = ?4
        WHERE id = ?1`, [profileId, metric, version, nowMs()]);
    });
  }

  deleteDimensionCascade(conn: SqlExecutor, dimension: number, modality: string): number {
    return this.deleteDimensionCascadeCollect(conn, dimension, modality).deletedSegments;
  }

  deleteDimensionCascadeCollect(conn: SqlExecutor, dimension: number, modality: string): DimensionCascadeCleanup {
    return databaseResult(() => {
      conn.exec('BEGIN');
      try {
        const segmentModalityFilter = modality === 'text' ? "('text')" : "('image', 'multimodal')";
        const lanceTableNames = conn.all<Row>(
          `SELECT DISTINCT lance_table_name FROM (
             SELECT lance_table_name FROM vfs_embedding_dims
              WHERE dimension = ?1 AND modality = ?2
             UNION
             SELECT lance_table_name FROM vfs_index_profiles
              WHERE dimension = ?1 AND modality = ?2
           )`, [dimension, modality]).map(row => readText(row, 'lance_table_name', 0));
        lanceTableNames.sort();

        conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
          SELECT s.lance_row_id, u.resource_id
          FROM vfs_index_segments s
          LEFT JOIN vfs_index_units u ON u.id = s.unit_id
          WHERE s.embedding_dim = ?1 AND s.modality IN ${segmentModalityFilter}
          ON CONFLICT(lance_row_id) DO UPDATE SET
              resource_id = COALESCE(excluded.resource_id, resource_id),
              enqueued_at = excluded.enqueued_at,
              next_retry_at = 0,
              last_error = NULL`, [dimension]);

        const deletedSegments = conn.run(
          `DELETE FROM vfs_index_segments
           WHERE embedding_dim = ?1 AND modality IN ${segmentModalityFilter}`, [dimension]).changes;

        const now = nowMs();
        if (modality === 'multimodal') {
          conn.run(`UPDATE vfs_index_units SET
              mm_state = 'pending',
              mm_embedding_dim = NULL,
              mm_profile_id = NULL,
              mm_error = NULL,
              updated_at = ?1
            WHERE mm_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments
                WHERE modality IN ('image', 'multimodal')
            )`, [now, dimension]);
          conn.run(`UPDATE vfs_index_units SET mm_profile_id = NULL, updated_at = ?1
            WHERE mm_profile_id IN (
                SELECT id FROM vfs_index_profiles WHERE dimension = ?2 AND modality = ?3
            )`, [now, dimension, modality]);
        } else {
          conn.run(`UPDATE vfs_index_units SET
              text_state = 'pending',
              text_embedding_dim = NULL,
              text_profile_id = NULL,
              text_chunk_count = 0,
              text_error = NULL,
              updated_at = ?1
            WHERE text_embedding_dim = ?2
            AND id NOT IN (
                SELECT DISTINCT unit_id FROM vfs_index_segments WHERE modality = 'text'
            )`, [now, dimension]);
          conn.run(`UPDATE vfs_index_units SET text_profile_id = NULL, updated_at = ?1
            WHERE text_profile_id IN (
                SELECT id FROM vfs_index_profiles WHERE dimension = ?2 AND modality = ?3
            )`, [now, dimension, modality]);
        }

        conn.run('DELETE FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2',
          [dimension, modality]);
        conn.run('DELETE FROM vfs_index_profiles WHERE dimension = ?1 AND modality = ?2',
          [dimension, modality]);
        conn.exec('COMMIT');
        return { deletedSegments, lanceTableNames };
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VFS::EmbeddingDimRepo] Cascade rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  hasIndexingUnitsForDimension(conn: SqlExecutor, dimension: number, modality: string): boolean {
    return databaseResult(() => {
      const isMultimodal = modality === 'multimodal';
      const stateColumn = isMultimodal ? 'mm_state' : 'text_state';
      const dimColumn = isMultimodal ? 'mm_embedding_dim' : 'text_embedding_dim';
      const count = Number(conn.pluck<number>(
        `SELECT COUNT(*) FROM vfs_index_units
         WHERE ${stateColumn} = 'indexing' AND EXISTS (
             SELECT 1 FROM vfs_index_segments
             WHERE vfs_index_segments.unit_id = vfs_index_units.id
             AND vfs_index_segments.embedding_dim = ?1
             AND vfs_index_segments.modality = ?2
         )`, [dimension, modality]) ?? 0);
      const count2 = Number(conn.pluck<number>(
        `SELECT COUNT(*) FROM vfs_index_units
         WHERE ${stateColumn} = 'indexing' AND ${dimColumn} = ?1`, [dimension]) ?? 0);
      return count > 0 || count2 > 0;
    });
  }

  listLanceTableNames(conn: SqlExecutor): string[] {
    return databaseResult(() => conn.all<Row>('SELECT lance_table_name FROM vfs_embedding_dims')
      .map(row => readText(row, 'lance_table_name', 0)));
  }

  updateModelBinding(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): boolean {
    return databaseResult(() => {
      if (this.getByKey(conn, dimension, modality) === null) return false;
      this.registerWithModel(conn, dimension, modality, modelConfigId, modelName);
      return true;
    });
  }

  clearModelBinding(conn: SqlExecutor, dimension: number, modality: string): boolean {
    return databaseResult(() => {
      const existing = this.getByKey(conn, dimension, modality);
      if (existing !== null && existing.recordCount > 0) {
        throw invalidArgument('model_config_id',
          'Cannot clear a model binding while the vector space contains rows; rebuild or delete the dimension first');
      }
      return conn.run(`UPDATE vfs_embedding_dims SET
          model_config_id = NULL, model_name = NULL, last_used_at = ?3
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality, nowMs()]).changes > 0;
    });
  }

  listByModel(conn: SqlExecutor, modelConfigId: string): VfsEmbeddingDim[] {
    return databaseResult(() => conn.all(`SELECT ${DIM_COLUMNS} FROM vfs_embedding_dims
      WHERE model_config_id = ?1 ORDER BY modality, dimension`, [modelConfigId]).map(rowToDim));
  }

  listWithModelBinding(conn: SqlExecutor): VfsEmbeddingDim[] {
    return databaseResult(() => conn.all(`SELECT ${DIM_COLUMNS} FROM vfs_embedding_dims
      WHERE model_config_id IS NOT NULL AND record_count > 0
      ORDER BY modality, dimension`).map(rowToDim));
  }

  refreshCountsFromSegments(conn: SqlExecutor): void {
    databaseResult(() => {
      const now = nowMs();
      conn.run(`UPDATE vfs_embedding_dims SET
          record_count = (
              SELECT COUNT(*) FROM vfs_index_segments
              WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
              AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
          ),
          last_used_at = CASE
              WHEN (
                  SELECT COUNT(*) FROM vfs_index_segments
                  WHERE vfs_index_segments.modality = vfs_embedding_dims.modality
                  AND vfs_index_segments.embedding_dim = vfs_embedding_dims.dimension
              ) > 0 THEN ?1
              ELSE last_used_at
          END`, [now]);

      const committedManifestExists = `EXISTS (
          SELECT 1
          FROM vfs_index_segments s
          JOIN vfs_index_units u ON u.id = s.unit_id
          WHERE s.index_profile_id = vfs_index_profiles.id
            AND (
                (vfs_index_profiles.modality = 'text'
                 AND s.modality = 'text'
                 AND u.text_profile_id = s.index_profile_id
                 AND u.text_generation = s.generation)
                OR
                (vfs_index_profiles.modality IN ('image', 'multimodal')
                 AND s.modality IN ('image', 'multimodal')
                 AND u.mm_profile_id = s.index_profile_id
                 AND u.mm_generation = s.generation)
            )
      )`;
      conn.run(`UPDATE vfs_index_profiles
        SET state = 'retired', updated_at = ?1
        WHERE state = 'queryable'
          AND NOT ${committedManifestExists}
          AND NOT EXISTS (
              SELECT 1 FROM vfs_embedding_dims d
              WHERE d.active_profile_id = vfs_index_profiles.id
          )`, [now]);
      conn.run(`UPDATE vfs_index_profiles
        SET state = 'active', updated_at = ?1
        WHERE state = 'building'
          AND ${committedManifestExists}`, [now]);
    });
  }
}
