/**
 * 备份清单模型（`backup/mod.rs` 的 `BackupManifest` 及 coverage ledger）：常量与类型、持久域登记、
 * 严格解析与各级校验、覆盖证据更新。纯函数，不读写文件；清单读写与哈希在 `manifest.ts`。
 */
import { catalog } from './asset-catalog.ts';
import { DATABASE_IDS, latestVersion } from './migrations.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { isAbsolute } from '../../../platform/util/path.ts';

export const MANIFEST_VERSION = '3.0.0';
export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_MAX_SUPPORTED_MAJOR = 3;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 100_000;
export const MAX_MANIFEST_PATH_BYTES = 4096;
export const MAX_MANIFEST_TOTAL_FILE_BYTES = 20n * 1024n * 1024n * 1024n;

export const INCREMENTAL_BACKUP_REMOVED_MESSAGE = 'Incremental backup has been removed; use full backup or cloud sync';
export const INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE = 'Incremental backup restore is no longer supported; use a full backup';
export const PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE = 'E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE';
export const ATOMIC_RESTORE_UNAVAILABLE_CODE = 'E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE';

export type SnapshotKind = 'full' | 'partial_overlay' | 'legacy_candidate';
export type BackupKeyPolicy = 'included_local' | 'included_encrypted' | 'not_present' | 'excluded_portable' | 'legacy_unknown';
export type CoverageStatus = 'complete' | 'empty' | 'absent' | 'excluded' | 'failed';
export type RestoreScope = 'active_data_space' | 'application_data' | 'user_home';
export type RestoreTrustPolicy = 'data' | 'explicit' | 'untrusted_executable';
export type AssetTypeId = typeof catalog[number][0];

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
  database_id?: string | null;
}

export interface BackedUpAsset {
  asset_type: AssetTypeId;
  relative_path: string;
  original_path: string;
  size: number;
  checksum?: string;
  modified_at?: string;
  is_directory: boolean;
}

export interface AssetBackupResult {
  files: BackedUpAsset[];
  total_files: number;
  total_size: number;
  skipped_files: number;
  skip_reasons: Record<string, number>;
  incomplete_asset_types: AssetTypeId[];
  by_asset_type: Record<string, { file_count: number; total_size: number }>;
  started_at: string;
  completed_at: string;
}

export interface DomainCoverage {
  status: CoverageStatus;
  paths: string[];
  file_count: number;
  total_size: number;
  executable: boolean;
  optional: boolean;
  encrypted: boolean;
  restore_target: string;
  restore_scope: RestoreScope;
  restore_trust: RestoreTrustPolicy;
  detail?: string;
}

export interface CoverageLedger {
  version: number;
  domains: Record<string, DomainCoverage>;
}

export interface BackupManifest {
  version: string;
  app_version: string;
  created_at: string;
  platform: string;
  schema_versions: Record<string, number>;
  files: BackupFile[];
  is_incremental: boolean;
  incremental_base: string | null;
  backup_id: string;
  assets?: AssetBackupResult;
  snapshot_kind: SnapshotKind;
  snapshot_epoch: string;
  required_components: string[];
  included_components: string[];
  key_policy: BackupKeyPolicy;
  coverage?: CoverageLedger;
}

export interface DomainRestoreFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface DomainRestorePlan {
  domain_id: string;
  status: CoverageStatus;
  archive_paths: string[];
  files: DomainRestoreFile[];
  file_count: number;
  total_size: number;
  restore_target: string;
  restore_scope: RestoreScope;
  executable: boolean;
  optional: boolean;
  encrypted: boolean;
  restore_trust: RestoreTrustPolicy;
}

export interface PersistentDomainSpec {
  id: string;
  archive_root: string;
  restore_target: string;
  presence_required: boolean;
  executable: boolean;
  optional: boolean;
  encrypted: boolean;
  restore_scope: RestoreScope;
  restore_trust: RestoreTrustPolicy;
}

/** `DatabaseId::all_ordered()` 的 serde 形状。 */
const DATABASE_IDS_ORDERED = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const;

export function persistentDomainRegistry(): PersistentDomainSpec[] {
  const domains: PersistentDomainSpec[] = DATABASE_IDS_ORDERED.map(id => ({
    id: `database:${id}`,
    archive_root: `${id}.db`,
    restore_target: id === 'vfs' ? 'databases/vfs.db' : `${id}.db`,
    presence_required: true,
    executable: false,
    optional: false,
    encrypted: false,
    restore_scope: 'active_data_space',
    restore_trust: 'data',
  }));
  domains.push({
    id: 'workspaces-root', archive_root: 'workspaces', restore_target: 'workspaces',
    presence_required: false, executable: false, optional: true, encrypted: false,
    restore_scope: 'active_data_space', restore_trust: 'data',
  });
  for (const [id] of catalog) {
    domains.push({
      id: `asset-root:${id}`, archive_root: `assets/${id}`, restore_target: id,
      presence_required: false, executable: false, optional: true, encrypted: false,
      restore_scope: 'active_data_space', restore_trust: 'data',
    });
  }
  domains.push(
    {
      id: 'crypto', archive_root: 'crypto', restore_target: '.',
      presence_required: false, executable: false, optional: true, encrypted: true,
      restore_scope: 'application_data', restore_trust: 'explicit',
    },
    {
      id: 'audit', archive_root: 'databases/audit.db', restore_target: 'databases/audit.db',
      presence_required: false, executable: false, optional: true, encrypted: false,
      restore_scope: 'application_data', restore_trust: 'explicit',
    },
    {
      id: 'webview-settings', archive_root: 'persistent/webview_settings.json', restore_target: 'webview_settings.json',
      presence_required: false, executable: false, optional: true, encrypted: false,
      restore_scope: 'active_data_space', restore_trust: 'data',
    },
    {
      id: 'custom-grading-modes', archive_root: 'persistent/custom_grading_modes.json', restore_target: 'custom_grading_modes.json',
      presence_required: false, executable: false, optional: true, encrypted: false,
      restore_scope: 'active_data_space', restore_trust: 'data',
    },
    {
      id: 'agents', archive_root: 'assets/workspaces/agents', restore_target: 'workspaces/agents',
      presence_required: false, executable: true, optional: true, encrypted: false,
      restore_scope: 'active_data_space', restore_trust: 'untrusted_executable',
    },
    {
      id: 'user-skills', archive_root: 'persistent/user_skills', restore_target: '~/.deep-student/skills',
      presence_required: false, executable: true, optional: true, encrypted: true,
      restore_scope: 'user_home', restore_trust: 'untrusted_executable',
    },
  );
  return domains;
}

export function pathIsAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function domainOwnsArchivePath(spec: PersistentDomainSpec, path: string): boolean {
  if (pathIsAtOrBelow(path, spec.archive_root)) return true;
  if (spec.id.startsWith('asset-root:') && pathIsAtOrBelow(path, spec.id.slice('asset-root:'.length))) return true;
  return spec.id === 'agents' && pathIsAtOrBelow(path, 'workspaces/agents');
}

export function archivePathRequiresExplicitTrust(path: string): boolean {
  return persistentDomainRegistry().some(spec =>
    spec.restore_trust === 'untrusted_executable' && domainOwnsArchivePath(spec, path));
}

/** `BackupManifest::domain_restore_plan`（backup/mod.rs:1682）。 */
export function domainRestorePlan(manifest: BackupManifest, domainId: string): DomainRestorePlan | null {
  const spec = persistentDomainRegistry().find(domain => domain.id === domainId);
  const coverage = manifest.coverage?.domains[domainId];
  if (!spec || !coverage) return null;
  const files: DomainRestoreFile[] = [];
  for (const path of coverage.paths) {
    const file = manifest.files.find(candidate => candidate.path === path);
    if (file) {
      files.push({ path, size: file.size, sha256: file.sha256 });
      continue;
    }
    const asset = manifest.assets?.files.find(candidate =>
      candidate.relative_path === path && !candidate.is_directory);
    if (asset) {
      files.push({ path, size: asset.size, sha256: asset.checksum ?? null });
    }
  }
  return {
    domain_id: domainId,
    status: coverage.status,
    archive_paths: [...coverage.paths],
    files,
    file_count: coverage.file_count,
    total_size: coverage.total_size,
    restore_target: spec.restore_target,
    restore_scope: spec.restore_scope,
    executable: spec.executable,
    optional: spec.optional,
    encrypted: spec.encrypted,
    restore_trust: spec.restore_trust,
  };
}

/** `assert_no_unconsumed_complete_domains`（restore_plan.rs）。 */
export function assertNoUnconsumedCompleteDomains(
  manifest: BackupManifest,
  consumedDomainIds: readonly string[],
): void {
  const coverage = manifest.coverage;
  if (!coverage) {
    throw new Error(`[E_RESTORE_DOMAIN_UNCONSUMED] 备份缺少 coverage ledger，无法证明 Complete 域均被消费`);
  }
  const consumed = new Set(consumedDomainIds);
  const unconsumed = Object.entries(coverage.domains)
    .filter(([domainId, evidence]) => evidence.status === 'complete' && !consumed.has(domainId))
    .map(([domainId]) => domainId);
  if (unconsumed.length > 0) {
    throw new Error(`[E_RESTORE_DOMAIN_UNCONSUMED] Complete 持久域未被任何恢复路径消费: ${unconsumed.join(', ')}`);
  }
}

export function newCoverageLedger(): CoverageLedger {
  const domains: Record<string, DomainCoverage> = {};
  for (const spec of persistentDomainRegistry()) {
    domains[spec.id] = {
      status: 'excluded', paths: [], file_count: 0, total_size: 0,
      executable: spec.executable, optional: spec.optional, encrypted: spec.encrypted,
      restore_target: spec.restore_target, restore_scope: spec.restore_scope, restore_trust: spec.restore_trust,
    };
  }
  return { version: 1, domains };
}

export function parseManifestMajor(version: string): number {
  const components = version.split('.');
  if (components.length !== 3 || components.some(c => c === '' || !/^\d+$/.test(c))) {
    throw new Error(`备份清单版本格式无效: ${version}`);
  }
  const major = Number(components[0]);
  if (major < 1 || major > MANIFEST_MAX_SUPPORTED_MAJOR) {
    throw new Error(`不支持的备份清单版本: ${version}`);
  }
  return major;
}

export function validateSafeRelativePath(path: string): void {
  if (path === '' || utf8ByteLength(path) > MAX_MANIFEST_PATH_BYTES) {
    throw new Error('备份清单包含空路径或超长路径');
  }
  if (isAbsolute(path)) throw new Error(`备份清单包含不安全路径: ${path}`);
  for (const component of path.split(/[\\/]/)) {
    if (component === '' || component === '.' || component === '..') {
      throw new Error(`备份清单包含不安全路径: ${path}`);
    }
  }
}

function manifestedPathSizes(manifest: BackupManifest): Map<string, number> {
  const paths = new Map<string, number>();
  for (const file of manifest.files) {
    if (paths.has(file.path)) throw new Error(`备份清单包含重复路径: ${file.path}`);
    paths.set(file.path, file.size);
  }
  for (const asset of manifest.assets?.files ?? []) {
    if (asset.is_directory) continue;
    if (paths.has(asset.relative_path)) throw new Error(`备份清单包含重复路径: ${asset.relative_path}`);
    paths.set(asset.relative_path, asset.size);
  }
  return paths;
}

function validateCoverageLedger(manifest: BackupManifest, requireFull: boolean): void {
  const coverage = manifest.coverage;
  if (!coverage) throw new Error('manifest v3 缺少 coverage ledger');
  if (coverage.version !== 1) throw new Error(`不支持的 coverage ledger 版本: ${coverage.version}`);
  const manifested = manifestedPathSizes(manifest);
  const registry = persistentDomainRegistry();
  const registryIds = new Set(registry.map(spec => spec.id));
  const keys = Object.keys(coverage.domains);
  if (keys.length !== registryIds.size || keys.some(key => !registryIds.has(key))) {
    throw new Error('覆盖账本域集合与持久域注册表不一致');
  }
  const covered = new Set<string>();
  for (const spec of registry) {
    const evidence = coverage.domains[spec.id];
    if (!evidence) throw new Error(`覆盖账本缺少持久域: ${spec.id}`);
    if (evidence.executable !== spec.executable || evidence.optional !== spec.optional
      || evidence.encrypted !== spec.encrypted || evidence.restore_target !== spec.restore_target
      || evidence.restore_scope !== spec.restore_scope || evidence.restore_trust !== spec.restore_trust) {
      throw new Error(`持久域安全元数据与注册表不一致: ${spec.id}`);
    }
    if (requireFull && (evidence.status === 'failed' || evidence.status === 'excluded')) {
      throw new Error(`完整快照持久域未覆盖: ${spec.id} (${evidence.status})`);
    }
    if (requireFull && spec.presence_required && evidence.status !== 'complete') {
      throw new Error(`必需持久域缺少完整文件证据: ${spec.id} (${evidence.status})`);
    }
    const pathsAllowed = evidence.status === 'complete' || evidence.status === 'failed';
    if ((!pathsAllowed && evidence.paths.length > 0)
      || (evidence.status === 'complete' && evidence.paths.length === 0)
      || evidence.file_count !== evidence.paths.length) {
      throw new Error(`持久域覆盖计数与状态不一致: ${spec.id}`);
    }
    let total = 0n;
    const unique = new Set<string>();
    for (const path of evidence.paths) {
      if (!domainOwnsArchivePath(spec, path)) throw new Error(`持久域覆盖路径越界: ${spec.id} / ${path}`);
      if (unique.has(path)) throw new Error(`持久域覆盖包含重复路径: ${spec.id} / ${path}`);
      unique.add(path);
      covered.add(path);
      const size = manifested.get(path);
      if (size === undefined) throw new Error(`持久域覆盖引用未声明文件: ${spec.id} / ${path}`);
      total += BigInt(size);
    }
    if (total !== BigInt(evidence.total_size)) {
      throw new Error(`持久域覆盖大小不一致: ${spec.id} expected=${evidence.total_size}, actual=${total}`);
    }
  }
  if (requireFull) {
    for (const path of manifested.keys()) {
      if (!covered.has(path)) throw new Error(`完整快照包含未归属持久域的文件: ${path}`);
    }
  }
}

/**
 * `BackupManager::validate_legacy_candidate_for_upgrade`：历史 v1/v2 包的
 * fail-closed 升级门。通过仅代表可进入显式迁移/检查路径，绝不推导空域。
 */
export function validateLegacyCandidateForUpgrade(manifest: BackupManifest): void {
  validateUntrusted(manifest);
  const major = parseManifestMajor(manifest.version);
  if (!(major === 1 || major === 2)
    || manifest.snapshot_kind !== 'legacy_candidate'
    || manifest.coverage !== undefined
    || manifest.key_policy !== 'legacy_unknown') {
    throw new Error('仅规范化后的 v1/v2 LegacyCandidate 可进入升级验证');
  }
  if (manifest.is_incremental) throw new Error(INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);

  // 任一条目被信任之前先拒绝跨两个历史文件列表的重复路径。
  manifestPathSizes(manifest);

  const databaseIds = new Set<string>();
  for (const file of manifest.files) {
    if (!/^[0-9a-fA-F]{64}$/.test(file.sha256)) {
      throw new Error(`旧版备份文件缺少有效 SHA-256: ${file.path}`);
    }
    if (file.database_id != null) {
      const databaseId = file.database_id;
      if (!DATABASE_IDS_ORDERED.includes(databaseId as (typeof DATABASE_IDS_ORDERED)[number])
        || file.path !== `${databaseId}.db`
        || databaseIds.has(databaseId)) {
        throw new Error(`旧版核心数据库声明无效或重复: ${databaseId} / ${file.path}`);
      }
      databaseIds.add(databaseId);
      continue;
    }

    const path = file.path;
    const knownAssetPath = catalog.some(([id]) => {
      const root = id;
      return path.startsWith(`${root}/`) || path.startsWith(`assets/${root}/`);
    });
    const knownWorkspaceDatabase = path.startsWith('workspaces/')
      && !path.slice('workspaces/'.length).includes('/')
      && path.slice('workspaces/'.length).startsWith('ws_')
      && path.endsWith('.db');
    const knownCrypto = path === 'crypto/.master_key'
      || path === 'crypto/.secure/.key_seed'
      || (path.startsWith('crypto/.secure/')
        && !path.slice('crypto/.secure/'.length).includes('/')
        && path.slice('crypto/.secure/'.length).toLowerCase().endsWith('.enc'));
    const knownPersistent = path === 'persistent/webview_settings.json'
      || path === 'persistent/custom_grading_modes.json'
      || path.startsWith('persistent/user_skills/');
    const knownAuxiliary = path === 'databases/audit.db'
      || knownCrypto
      || knownPersistent
      || path.startsWith('lance/')
      || path.startsWith('databases/lance/');
    if (!knownAssetPath && !knownWorkspaceDatabase && !knownAuxiliary) {
      throw new Error(`旧版备份包含未分类文件: ${path}`);
    }
  }
  for (const database of DATABASE_IDS_ORDERED) {
    if (!databaseIds.has(database)) throw new Error(`旧版备份缺少核心数据库: ${database}`);
  }

  if (manifest.assets) {
    let totalSize = 0n;
    let fileCount = 0;
    for (const asset of manifest.assets.files) {
      if (asset.is_directory) continue;
      const root = asset.asset_type;
      if (!asset.relative_path.startsWith(`assets/${root}/`)
        || !asset.original_path.startsWith(`${root}/`)) {
        throw new Error(`旧版资产路径与类型不一致: ${asset.relative_path}`);
      }
      if (asset.checksum == null) {
        throw new Error(`旧版资产缺少 SHA-256，不能升级: ${asset.relative_path}`);
      }
      if (!/^[0-9a-fA-F]{64}$/.test(asset.checksum)) {
        throw new Error(`旧版资产 SHA-256 无效: ${asset.relative_path}`);
      }
      totalSize += BigInt(asset.size);
      fileCount += 1;
    }
    if (fileCount !== manifest.assets.total_files || totalSize !== BigInt(manifest.assets.total_size)) {
      throw new Error('旧版资产统计与逐文件证据不一致');
    }
  }
}

export function validateUntrusted(manifest: BackupManifest): void {
  const major = parseManifestMajor(manifest.version);
  if (major >= 3 && !manifest.coverage) {
    throw new Error('manifest v3 缺少 coverage ledger，不能降级为 legacy');
  }
  const id = manifest.backup_id;
  if (id === '' || id.length > 128 || id.startsWith('.') || id.includes('..') || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error('备份清单包含非法 backup_id');
  }
  if (manifest.files.length > MAX_MANIFEST_FILES) {
    throw new Error(`备份清单文件数超限: ${manifest.files.length} > ${MAX_MANIFEST_FILES}`);
  }
  let total = 0n;
  for (const file of manifest.files) {
    validateSafeRelativePath(file.path);
    total += BigInt(file.size);
    if (total > MAX_MANIFEST_TOTAL_FILE_BYTES) throw new Error(`备份清单文件总大小超限: ${total} bytes`);
  }
  if (manifest.assets) {
    if (manifest.assets.files.length > MAX_MANIFEST_FILES) {
      throw new Error(`备份清单资产数超限: ${manifest.assets.files.length} > ${MAX_MANIFEST_FILES}`);
    }
    for (const asset of manifest.assets.files) {
      validateSafeRelativePath(asset.relative_path);
      validateSafeRelativePath(asset.original_path);
      total += BigInt(asset.size);
      if (total > MAX_MANIFEST_TOTAL_FILE_BYTES) throw new Error(`备份清单文件与资产总大小超限: ${total} bytes`);
    }
  }
  if (major >= 3) validateCoverageLedger(manifest, manifest.snapshot_kind === 'full');
}

/** `BackupManager::check_manifest_compatibility`（backup/mod.rs:4822）。 */
export function checkManifestCompatibility(manifest: BackupManifest): void {
  parseManifestMajor(manifest.version);
  if (manifest.is_incremental) throw new Error(INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);
  for (const dbName of Object.keys(manifest.schema_versions)) {
    if (!(DATABASE_IDS as readonly string[]).includes(dbName)) {
      throw new Error(
        `备份中包含当前应用未知的数据库 "${dbName}"。为避免数据丢失，当前版本不会忽略该数据库。请升级应用到与备份兼容的版本后重试恢复。`,
      );
    }
  }
  for (const file of manifest.files) {
    if (!file.path.endsWith('.db')) continue;
    const dbId = file.database_id;
    if (dbId == null) continue;
    if (!(DATABASE_IDS as readonly string[]).includes(dbId)) {
      throw new Error(
        `备份中包含当前应用未知的数据库 "${dbId}"（文件: ${file.path}）。请升级应用到与备份兼容的版本后重试恢复。`,
      );
    }
  }
  for (const [dbName, backupSchemaVersion] of Object.entries(manifest.schema_versions)) {
    const maxKnownVersion = latestVersion(dbName as typeof DATABASE_IDS[number]);
    if (backupSchemaVersion > maxKnownVersion) {
      throw new Error(
        `备份中数据库 ${dbName} 的 schema 版本 (v${backupSchemaVersion}) 高于当前应用支持的最新版本 (v${maxKnownVersion})。请升级应用到与备份兼容的版本后重试。`,
      );
    }
  }
}

export function validateForSlotRestore(manifest: BackupManifest): void {
  validateUntrusted(manifest);
  // Rust `check_manifest_compatibility` 在版本兼容检查中优先拒绝增量备份，
  // 旧版增量包也必须得到同一个诚实拒绝，而不是被降级为 legacy 错误。
  if (manifest.is_incremental) throw new Error(INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);
  const major = parseManifestMajor(manifest.version);
  if (major < 3 || !manifest.coverage) {
    throw new Error('旧版备份缺少可证明空域的 coverage ledger，仅可作为 LegacyCandidate 检查');
  }
  if (manifest.key_policy === 'included_encrypted') {
    throw new Error('备份的敏感数据仍处于密码加密封存状态；请在导入 ZIP 时提供备份密码完成解封，再执行整槽恢复');
  }
  if (manifest.snapshot_kind !== 'full') {
    throw new Error(`备份不是可替换数据槽的完整快照: ${manifest.snapshot_kind}`);
  }
  if (rustTrim(manifest.snapshot_epoch) === '') throw new Error('完整快照缺少 snapshot_epoch');
  if (manifest.key_policy === 'legacy_unknown') throw new Error('完整快照缺少明确的 key_policy');
  validateCoverageLedger(manifest, true);
  const cryptoStatus = manifest.coverage.domains.crypto?.status;
  if (manifest.key_policy === 'included_local' && cryptoStatus !== 'complete') {
    throw new Error('key_policy=included_local 但 crypto 域没有完整文件证据');
  }
  if (manifest.key_policy === 'not_present' && cryptoStatus !== 'absent' && cryptoStatus !== 'empty') {
    throw new Error('key_policy=not_present 与 crypto 覆盖状态不一致');
  }
  if (manifest.key_policy === 'excluded_portable') {
    throw new Error('可替换数据槽的完整快照不得排除或隐式声明密钥策略');
  }

  const paths = new Set<string>();
  const databaseIds = new Set<string>();
  for (const file of manifest.files) {
    if (paths.has(file.path)) throw new Error(`备份清单包含重复路径: ${file.path}`);
    paths.add(file.path);
    if (!/^[0-9a-fA-F]{64}$/.test(file.sha256)) throw new Error(`备份文件 SHA-256 格式无效: ${file.path}`);
    if (file.database_id != null) {
      if (!DATABASE_IDS_ORDERED.includes(file.database_id as never)) {
        throw new Error(`备份包含未知数据库 ID: ${file.database_id}`);
      }
      if (file.path !== `${file.database_id}.db`) {
        throw new Error(`数据库 ${file.database_id} 必须绑定规范路径 ${file.database_id}.db，实际为 ${file.path}`);
      }
      if (databaseIds.has(file.database_id)) throw new Error(`数据库 ID 重复: ${file.database_id}`);
      databaseIds.add(file.database_id);
    } else if (file.path.startsWith('crypto/') || file.path.startsWith('persistent/')) {
      // persistent-domain plans own these files
    } else if (file.path.endsWith('.db')) {
      if (file.path !== 'databases/audit.db') {
        const name = file.path.startsWith('workspaces/') ? file.path.slice('workspaces/'.length) : undefined;
        if (name === undefined || name.includes('/') || !name.startsWith('ws_') || !name.endsWith('.db')) {
          throw new Error(`未分类数据库文件禁止恢复: ${file.path}`);
        }
      }
    } else {
      const root = file.path.split('/')[0] ?? '';
      const knownRoot = catalog.some(([id]) => id === root)
        || root === 'lance' || root === 'assets' || root === 'crypto' || root === 'persistent';
      if (!knownRoot) throw new Error(`完整快照包含未分类文件: ${file.path}`);
    }
  }
  for (const id of DATABASE_IDS_ORDERED) {
    if (!databaseIds.has(id)) throw new Error(`完整快照缺少核心数据库: ${id}`);
  }
  for (const asset of manifest.assets?.files ?? []) {
    const root = asset.asset_type;
    if (!asset.relative_path.startsWith(`assets/${root}/`) || !asset.original_path.startsWith(`${root}/`)) {
      throw new Error(`资产路径未绑定到声明类型 ${asset.asset_type}: source=${asset.relative_path}, destination=${asset.original_path}`);
    }
    if (asset.asset_type === 'workspaces'
      && (asset.original_path.endsWith('.db') || asset.original_path.endsWith('-wal') || asset.original_path.endsWith('-shm'))) {
      throw new Error(`工作区 SQLite 文件只能通过一致性快照恢复: ${asset.original_path}`);
    }
    if (!asset.is_directory && !/^[0-9a-fA-F]{64}$/.test(asset.checksum ?? '')) {
      throw new Error(`完整快照资产缺少有效 SHA-256: ${asset.relative_path}`);
    }
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`解析清单失败: ${what} 必须是对象`);
  return value as Record<string, unknown>;
}
function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`解析清单失败: ${what} 必须是字符串`);
  return value;
}
function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`解析清单失败: ${what} 必须是数字`);
  return value;
}
function asBool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`解析清单失败: ${what} 必须是布尔值`);
  return value;
}
function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`解析清单失败: ${what} 必须是数组`);
  return value;
}

function parseBackupFile(value: unknown): BackupFile {
  const obj = asRecord(value, 'file');
  const file: BackupFile = {
    path: asString(obj.path, 'file.path'),
    size: asNumber(obj.size, 'file.size'),
    sha256: asString(obj.sha256, 'file.sha256'),
  };
  if (obj.database_id != null) file.database_id = asString(obj.database_id, 'file.database_id');
  return file;
}

function parseAsset(value: unknown): BackedUpAsset {
  const obj = asRecord(value, 'asset');
  const asset: BackedUpAsset = {
    asset_type: asString(obj.asset_type, 'asset.asset_type') as AssetTypeId,
    relative_path: asString(obj.relative_path, 'asset.relative_path'),
    original_path: asString(obj.original_path, 'asset.original_path'),
    size: asNumber(obj.size, 'asset.size'),
    is_directory: obj.is_directory === undefined ? false : asBool(obj.is_directory, 'asset.is_directory'),
  };
  if (obj.checksum != null) asset.checksum = asString(obj.checksum, 'asset.checksum');
  if (obj.modified_at != null) asset.modified_at = asString(obj.modified_at, 'asset.modified_at');
  return asset;
}

function parseAssets(value: unknown): AssetBackupResult {
  const obj = asRecord(value, 'assets');
  const skipReasons: Record<string, number> = {};
  if (obj.skip_reasons != null) {
    for (const [key, count] of Object.entries(asRecord(obj.skip_reasons, 'assets.skip_reasons'))) {
      skipReasons[key] = asNumber(count, `assets.skip_reasons.${key}`);
    }
  }
  const byType: Record<string, { file_count: number; total_size: number }> = {};
  if (obj.by_asset_type != null) {
    for (const [key, stats] of Object.entries(asRecord(obj.by_asset_type, 'assets.by_asset_type'))) {
      const record = asRecord(stats, `assets.by_asset_type.${key}`);
      byType[key] = { file_count: asNumber(record.file_count, 'file_count'), total_size: asNumber(record.total_size, 'total_size') };
    }
  }
  return {
    files: asArray(obj.files, 'assets.files').map(parseAsset),
    total_files: asNumber(obj.total_files, 'assets.total_files'),
    total_size: asNumber(obj.total_size, 'assets.total_size'),
    skipped_files: asNumber(obj.skipped_files, 'assets.skipped_files'),
    skip_reasons: skipReasons,
    incomplete_asset_types: asArray(obj.incomplete_asset_types ?? [], 'assets.incomplete_asset_types')
      .map(item => asString(item, 'incomplete_asset_types[]') as AssetTypeId),
    by_asset_type: byType,
    started_at: asString(obj.started_at, 'assets.started_at'),
    completed_at: asString(obj.completed_at, 'assets.completed_at'),
  };
}

function parseCoverage(value: unknown): CoverageLedger {
  const obj = asRecord(value, 'coverage');
  const domains: Record<string, DomainCoverage> = {};
  for (const [id, raw] of Object.entries(asRecord(obj.domains, 'coverage.domains'))) {
    const record = asRecord(raw, `coverage.domains.${id}`);
    const evidence: DomainCoverage = {
      status: asString(record.status, 'status') as CoverageStatus,
      paths: asArray(record.paths ?? [], 'paths').map(path => asString(path, 'paths[]')),
      file_count: asNumber(record.file_count, 'file_count'),
      total_size: asNumber(record.total_size, 'total_size'),
      executable: asBool(record.executable, 'executable'),
      optional: asBool(record.optional, 'optional'),
      encrypted: asBool(record.encrypted, 'encrypted'),
      restore_target: asString(record.restore_target, 'restore_target'),
      restore_scope: asString(record.restore_scope, 'restore_scope') as RestoreScope,
      restore_trust: asString(record.restore_trust, 'restore_trust') as RestoreTrustPolicy,
    };
    if (record.detail != null) evidence.detail = asString(record.detail, 'detail');
    domains[id] = evidence;
  }
  return { version: asNumber(obj.version, 'coverage.version'), domains };
}

export function parseManifest(value: unknown): BackupManifest {
  const obj = asRecord(value, 'manifest');
  const schemaVersions: Record<string, number> = {};
  if (obj.schema_versions != null) {
    for (const [key, version] of Object.entries(asRecord(obj.schema_versions, 'schema_versions'))) {
      schemaVersions[key] = asNumber(version, `schema_versions.${key}`);
    }
  }
  const manifest: BackupManifest = {
    version: asString(obj.version, 'version'),
    app_version: asString(obj.app_version, 'app_version'),
    created_at: asString(obj.created_at, 'created_at'),
    platform: asString(obj.platform, 'platform'),
    schema_versions: schemaVersions,
    files: asArray(obj.files, 'files').map(parseBackupFile),
    is_incremental: obj.is_incremental === undefined ? false : asBool(obj.is_incremental, 'is_incremental'),
    incremental_base: obj.incremental_base == null ? null : asString(obj.incremental_base, 'incremental_base'),
    backup_id: obj.backup_id === undefined ? '' : asString(obj.backup_id, 'backup_id'),
    snapshot_kind: (obj.snapshot_kind == null ? 'legacy_candidate' : asString(obj.snapshot_kind, 'snapshot_kind') === 'legacy_unknown' ? 'legacy_candidate' : asString(obj.snapshot_kind, 'snapshot_kind')) as SnapshotKind,
    snapshot_epoch: obj.snapshot_epoch === undefined ? '' : asString(obj.snapshot_epoch, 'snapshot_epoch'),
    required_components: asArray(obj.required_components ?? [], 'required_components').map(item => asString(item, 'required_components[]')),
    included_components: asArray(obj.included_components ?? [], 'included_components').map(item => asString(item, 'included_components[]')),
    key_policy: (obj.key_policy == null ? 'legacy_unknown' : asString(obj.key_policy, 'key_policy')) as BackupKeyPolicy,
  };
  if (obj.assets != null) manifest.assets = parseAssets(obj.assets);
  if (obj.coverage != null) manifest.coverage = parseCoverage(obj.coverage);

  const major = parseManifestMajor(manifest.version);
  if (major === 1 || major === 2) {
    manifest.snapshot_kind = 'legacy_candidate';
    manifest.coverage = undefined;
    manifest.key_policy = 'legacy_unknown';
    manifest.required_components = [];
  } else if (!manifest.coverage) {
    throw new Error('manifest v3 缺少 coverage ledger，拒绝按旧版候选加载');
  }
  return manifest;
}

export function classifyRecoveryKind(manifest: BackupManifest): { kind: 'disaster_recovery' | 'partial_archive'; restorable: boolean } {
  try { validateForSlotRestore(manifest); return { kind: 'disaster_recovery', restorable: true }; }
  catch { return { kind: 'partial_archive', restorable: false }; }
}

export function manifestPathSizes(manifest: BackupManifest): Map<string, number> {
  return manifestedPathSizes(manifest);
}

export function updateCoverage(
  manifest: BackupManifest,
  domainId: string,
  status: CoverageStatus,
  paths: string[],
  detail?: string,
): void {
  const coverage = manifest.coverage;
  if (!coverage) throw new Error('manifest v3 缺少 coverage ledger');
  const spec = persistentDomainRegistry().find(domain => domain.id === domainId);
  if (!spec) throw new Error(`未知持久域: ${domainId}`);
  const sorted = [...new Set(paths)].sort();
  const manifested = manifestedPathSizes(manifest);
  let total = 0;
  for (const path of sorted) {
    const size = manifested.get(path);
    if (size === undefined) throw new Error(`覆盖证据引用了未纳入清单的文件: domain=${domainId}, path=${path}`);
    total += size;
  }
  if ((status === 'empty' || status === 'absent' || status === 'excluded') && sorted.length > 0) {
    throw new Error(`覆盖状态 ${status} 不得携带文件: ${domainId}`);
  }
  if (status === 'complete' && sorted.length === 0) {
    throw new Error(`complete 覆盖状态缺少文件证据: ${domainId}`);
  }
  coverage.domains[domainId] = {
    status, paths: sorted, file_count: sorted.length, total_size: total,
    executable: spec.executable, optional: spec.optional, encrypted: spec.encrypted,
    restore_target: spec.restore_target, restore_scope: spec.restore_scope, restore_trust: spec.restore_trust,
    ...(detail === undefined ? {} : { detail }),
  };
  refreshIncludedComponents(manifest);
}

export function refreshIncludedComponents(manifest: BackupManifest): void {
  const components = new Set<string>();
  for (const file of manifest.files) {
    if (file.database_id != null) { components.add(`database:${file.database_id}`); continue; }
    if (file.path.startsWith('workspaces/')) {
      const name = file.path.slice('workspaces/'.length).split('/')[0];
      if (name) components.add(`workspace:${name}`);
      continue;
    }
    if (file.path.startsWith('assets/')) {
      const root = file.path.slice('assets/'.length).split('/')[0];
      if (root) components.add(`asset-root:${root}`);
    }
  }
  for (const asset of manifest.assets?.files ?? []) components.add(`asset-root:${asset.asset_type}`);
  for (const [id, evidence] of Object.entries(manifest.coverage?.domains ?? {})) {
    if (evidence.status === 'complete' || evidence.status === 'empty' || evidence.status === 'absent') components.add(id);
  }
  manifest.included_components = [...components].sort();
}

export function markFull(manifest: BackupManifest): void {
  validateCoverageLedger(manifest, true);
  manifest.snapshot_kind = 'full';
  manifest.required_components = persistentDomainRegistry().map(spec => spec.id).sort();
  refreshIncludedComponents(manifest);
}

export function markPartial(manifest: BackupManifest): void {
  manifest.snapshot_kind = 'partial_overlay';
  manifest.required_components = [];
  refreshIncludedComponents(manifest);
}

export function normalizeBackupIdForDir(manifest: BackupManifest, dirName: string): void {
  if (manifest.backup_id !== dirName) manifest.backup_id = dirName;
}
