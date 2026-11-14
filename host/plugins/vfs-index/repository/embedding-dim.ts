/**
 * VFS embedding dimension / index profile repository.
 *
 * Mirrors `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs`. SQL lives only in
 * this directory; callers receive plain rows.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { now } from '../../../platform/time/index.ts';
import { requireVfsTableOwners } from './owners.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';

export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;
export const INDEX_PROFILE_SCHEMA_VERSION = 1;
export const PRESET_DIMENSIONS = [256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096] as const;

export interface VfsEmbeddingDim {
  dimension: number;
  modality: string;
  lance_table_name: string;
  record_count: number;
  created_at: number;
  last_used_at: number;
  model_config_id: string | null;
  model_name: string | null;
  active_profile_id: string | null;
  model_fingerprint: string | null;
  embedding_protocol: string;
  active_generation: number;
  ann_metric: string;
  ann_index_version: number;
}

export interface VfsIndexProfile {
  id: string;
  model_fingerprint: string;
  model_config_id: string | null;
  model_name: string | null;
  dimension: number;
  modality: string;
  embedding_protocol: string;
  schema_version: number;
  lance_table_name: string;
  active_generation: number;
  state: string;
  ann_metric: string;
  ann_index_version: number;
  created_at: number;
  updated_at: number;
}

export class VfsRepositoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VfsRepositoryError';
    this.code = code;
  }
}

const unspecified = (error: unknown): never => {
  const text = error instanceof Error ? error.message : String(error);
  throw new VfsRepositoryError('VFS_STORAGE', `Database error: ${text}`);
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && rustTrim(value) !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function nowMs(): number {
  return now().millis;
}

export function rowToDim(row: Row): VfsEmbeddingDim {
  return {
    dimension: integer(row['dimension']),
    modality: text(row['modality']),
    lance_table_name: text(row['lance_table_name']),
    record_count: integer(row['record_count']),
    created_at: integer(row['created_at']),
    last_used_at: integer(row['last_used_at']),
    model_config_id: nullableText(row['model_config_id']),
    model_name: nullableText(row['model_name']),
    active_profile_id: nullableText(row['active_profile_id']),
    model_fingerprint: nullableText(row['model_fingerprint']),
    embedding_protocol: nullableText(row['embedding_protocol']) ?? 'legacy',
    active_generation: integer(row['active_generation']),
    ann_metric: nullableText(row['ann_metric']) ?? 'legacy_l2',
    ann_index_version: integer(row['ann_index_version']),
  };
}

export function rowToProfile(row: Row): VfsIndexProfile {
  return {
    id: text(row['id']),
    model_fingerprint: text(row['model_fingerprint']),
    model_config_id: nullableText(row['model_config_id']),
    model_name: nullableText(row['model_name']),
    dimension: integer(row['dimension']),
    modality: text(row['modality']),
    embedding_protocol: text(row['embedding_protocol']),
    schema_version: integer(row['schema_version']),
    lance_table_name: text(row['lance_table_name']),
    active_generation: integer(row['active_generation']),
    state: text(row['state']),
    ann_metric: text(row['ann_metric']),
    ann_index_version: integer(row['ann_index_version']),
    created_at: integer(row['created_at']),
    updated_at: integer(row['updated_at']),
  };
}

export function embeddingProtocolForModality(modality: string): string {
  if (modality === 'text') return 'text-embedding-v1';
  if (modality === 'image' || modality === 'multimodal') return 'multimodal-embedding-v1';
  throw new VfsRepositoryError(
    'VFS_INVALID_ARGUMENT',
    `Invalid argument 'modality': Unsupported embedding modality: ${modality}`,
  );
}

export function normalizedPublicBaseUrl(raw: string): string {
  const trimmed = rustTrim(raw);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath === '' ? '/' : normalizedPath;
  return url.toString().replace(/\/+$/, '');
}

export interface TransportFingerprintInput {
  providerType?: string | null;
  providerScope?: string | null;
  baseUrl?: string | null;
  apiProtocol?: string | null;
  modelAdapter?: string | null;
}

export function modelFingerprintWithTransport(
  modelConfigId: string,
  modelName: string,
  protocol: string,
  transport: TransportFingerprintInput = {},
): string {
  const hash = createHasherSync('SHA-256');
  hash.update('vfs-index-profile-v2\0');
  const normalizedBaseUrl = transport.baseUrl === undefined || transport.baseUrl === null
    ? ''
    : normalizedPublicBaseUrl(transport.baseUrl);
  const entries: Array<[string, string]> = [
    ['protocol', protocol],
    ['config_id', modelConfigId],
    ['model', modelName],
    ['provider_type', transport.providerType ?? ''],
    ['provider_scope', transport.providerScope ?? ''],
    ['base_url', normalizedBaseUrl],
    ['api_protocol', transport.apiProtocol ?? ''],
    ['model_adapter', transport.modelAdapter ?? ''],
  ];
  for (const [label, value] of entries) {
    hash.update(label);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return `sha256:${hash.digestHex()}`;
}

export function modelFingerprint(modelConfigId: string, modelName: string, protocol: string): string {
  return modelFingerprintWithTransport(modelConfigId, modelName, protocol);
}

export function generateLanceTableName(modality: string, dimension: number): string {
  return `vfs_emb_${modality}_${dimension}`;
}

export function generateProfileLanceTableName(
  modality: string,
  dimension: number,
  fingerprint: string,
): string {
  const source = fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint;
  const suffix = Array.from(source)
    .filter((ch) => /[A-Za-z0-9]/.test(ch))
    .slice(0, 16)
    .join('');
  return `vfs_emb_${modality}_${dimension}_${suffix}`;
}

export function generateIndexProfileId(
  fingerprint: string,
  dimension: number,
  modality: string,
  protocol: string,
): string {
  const hash = createHasherSync('SHA-256');
  hash.update('vfs-index-profile-id-v1\0');
  for (const value of [
    fingerprint,
    modality,
    String(dimension),
    protocol,
    String(INDEX_PROFILE_SCHEMA_VERSION),
  ]) {
    hash.update(value);
    hash.update('\0');
  }
  return `profile_${hash.digestHex()}`;
}

export function committedProfileSegmentCount(
  db: SqlExecutor,
  profileId: string,
  modality: string,
): number {
  const ledgerMatch = modality === 'text'
    ? "s.modality = 'text' AND u.text_profile_id = s.index_profile_id AND u.text_generation = s.generation"
    : modality === 'image' || modality === 'multimodal'
      ? "s.modality IN ('image', 'multimodal') AND u.mm_profile_id = s.index_profile_id AND u.mm_generation = s.generation"
      : undefined;
  if (ledgerMatch === undefined) {
    throw new VfsRepositoryError(
      'VFS_INVALID_ARGUMENT',
      `Invalid argument 'modality': Unsupported embedding modality: ${modality}`,
    );
  }
  try {
    return integer(db.pluck<number>(
      `SELECT COUNT(*) FROM vfs_index_segments s
       JOIN vfs_index_units u ON u.id = s.unit_id
       WHERE s.index_profile_id = ?1 AND ${ledgerMatch}`,
      [profileId],
    ));
  } catch (error) {
    return unspecified(error);
  }
}

export function getByKey(
  db: SqlExecutor,
  dimension: number,
  modality: string,
): VfsEmbeddingDim | undefined {
  const row = db.get('SELECT * FROM vfs_embedding_dims WHERE dimension = ?1 AND modality = ?2', [
    dimension,
    modality,
  ]);
  return row === undefined ? undefined : rowToDim(row);
}

export function listAll(db: SqlExecutor): VfsEmbeddingDim[] {
  return db.all('SELECT * FROM vfs_embedding_dims ORDER BY modality, dimension').map(rowToDim);
}

export function listByModality(db: SqlExecutor, modality: string): VfsEmbeddingDim[] {
  return db
    .all('SELECT * FROM vfs_embedding_dims WHERE modality = ?1 ORDER BY dimension', [modality])
    .map(rowToDim);
}

export function getActiveProfile(
  db: SqlExecutor,
  dimension: number,
  modality: string,
): VfsIndexProfile | undefined {
  const row = db.get(
    `SELECT p.* FROM vfs_embedding_dims d
     JOIN vfs_index_profiles p ON p.id = d.active_profile_id
     WHERE d.dimension = ?1 AND d.modality = ?2
       AND p.state IN ('active', 'building', 'queryable')`,
    [dimension, modality],
  );
  return row === undefined ? undefined : rowToProfile(row);
}

export function getProfileById(db: SqlExecutor, profileId: string): VfsIndexProfile | undefined {
  const row = db.get('SELECT * FROM vfs_index_profiles WHERE id = ?1', [profileId]);
  return row === undefined ? undefined : rowToProfile(row);
}

export function profileIsReferenced(db: SqlExecutor, profileId: string): boolean {
  return Number(db.pluck<number>(
    `SELECT EXISTS(SELECT 1 FROM vfs_index_segments WHERE index_profile_id = ?1)
            OR EXISTS(SELECT 1 FROM vfs_embedding_dims WHERE active_profile_id = ?1)`,
    [profileId],
  )) !== 0;
}

export function listActiveProfiles(db: SqlExecutor, modality?: string | null): VfsIndexProfile[] {
  const base = `SELECT DISTINCT p.* FROM vfs_index_profiles p
    WHERE p.state IN ('active', 'building', 'queryable')
      AND (EXISTS (SELECT 1 FROM vfs_embedding_dims d WHERE d.active_profile_id = p.id)
           OR EXISTS (SELECT 1 FROM vfs_index_segments s WHERE s.index_profile_id = p.id))`;
  const rows = modality === undefined || modality === null
    ? db.all(`${base} ORDER BY p.modality, p.dimension, p.id`)
    : db.all(`${base} AND p.modality = ?1 ORDER BY p.modality, p.dimension, p.id`, [modality]);
  return rows.map(rowToProfile);
}

export function setAnnStatus(
  db: SqlExecutor,
  dimension: number,
  modality: string,
  metric: string,
  version: number,
): void {
  requireVfsTableOwners(db).embeddingDims.setAnnStatus(db, dimension, modality, metric, version);
}

export function setProfileAnnStatus(
  db: SqlExecutor,
  profileId: string,
  metric: string,
  version: number,
): void {
  requireVfsTableOwners(db).embeddingDims.setProfileAnnStatus(db, profileId, metric, version);
}

export interface RegisterWithModelOptions {
  dimension: number;
  modality: string;
  modelConfigId?: string | null;
  modelName?: string | null;
  fingerprintOverride?: string | null;
}

/**
 * `register_with_model_fingerprint`: SAVEPOINT + full rollback on error.
 * Returns the compatibility registry row (Rust returns `VfsEmbeddingDim`).
 */
export function registerWithModelFingerprint(
  db: SqlExecutor,
  options: RegisterWithModelOptions,
): VfsEmbeddingDim {
  const owner = requireVfsTableOwners(db);
  const registered = owner.embeddingDims.registerWithModelFingerprint(
    db,
    options.dimension,
    options.modality,
    options.modelConfigId ?? null,
    options.modelName ?? null,
    options.fingerprintOverride ?? null,
  );
  return {
    dimension: registered.dimension,
    modality: registered.modality,
    lance_table_name: registered.lanceTableName,
    record_count: registered.recordCount,
    created_at: registered.createdAt,
    last_used_at: registered.lastUsedAt,
    model_config_id: registered.modelConfigId,
    model_name: registered.modelName,
    active_profile_id: registered.activeProfileId,
    model_fingerprint: registered.modelFingerprint,
    embedding_protocol: registered.embeddingProtocol,
    active_generation: registered.activeGeneration,
    ann_metric: registered.annMetric,
    ann_index_version: registered.annIndexVersion,
  };
}

export function registerWithModel(
  db: SqlExecutor,
  dimension: number,
  modality: string,
  modelConfigId: string | null,
  modelName: string | null,
): VfsEmbeddingDim {
  return registerWithModelFingerprint(db, {
    dimension,
    modality,
    modelConfigId,
    modelName,
  });
}

export function tableHasOnlyUnreferencedRetiredProfiles(
  db: SqlExecutor,
  tableName: string,
): boolean {
  const row = db.get(
    `SELECT COUNT(*) AS profile_count,
            COALESCE(SUM(CASE
              WHEN p.state = 'retired'
               AND NOT EXISTS (SELECT 1 FROM vfs_index_segments s WHERE s.index_profile_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM vfs_embedding_dims d WHERE d.active_profile_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM vfs_index_units u WHERE u.text_profile_id = p.id OR u.mm_profile_id = p.id)
              THEN 0 ELSE 1 END), 0) AS unsafe_profile_count
     FROM vfs_index_profiles p
     WHERE p.lance_table_name = ?1`,
    [tableName],
  );
  const profileCount = integer(row?.['profile_count']);
  const unsafeProfileCount = integer(row?.['unsafe_profile_count']);
  const dimensionStillPoints = integer(db.pluck<number>(
    'SELECT EXISTS(SELECT 1 FROM vfs_embedding_dims WHERE lance_table_name = ?1)',
    [tableName],
  )) !== 0;
  return profileCount > 0 && unsafeProfileCount === 0 && !dimensionStillPoints;
}

export function retiredProfileTableCandidates(db: SqlExecutor): string[] {
  const names = db
    .all<Row>(
      `SELECT DISTINCT lance_table_name FROM vfs_index_profiles
       WHERE state = 'retired' ORDER BY lance_table_name`,
    )
    .map((row) => text(row['lance_table_name']));
  const candidates: string[] = [];
  for (const name of names) {
    if (tableHasOnlyUnreferencedRetiredProfiles(db, name)) candidates.push(name);
  }
  return candidates;
}

export function optimizeTableNames(db: SqlExecutor, modality: string): string[] {
  const names = listByModality(db, modality).map((dim) => dim.lance_table_name);
  const profiles = db
    .all<Row>(
      `SELECT DISTINCT lance_table_name FROM vfs_index_profiles
       WHERE modality = ?1 AND state IN ('active', 'building', 'queryable')
       ORDER BY lance_table_name`,
      [modality],
    )
    .map((row) => text(row['lance_table_name']));
  names.push(...profiles);
  return names.sort().filter((name, index) => index === 0 || name !== names[index - 1]);
}
