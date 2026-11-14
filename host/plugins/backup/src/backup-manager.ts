import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync,
} from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { hasRefineryHistory, integrityCheck, maxRefineryVersion } from '../repository/backup-verify.ts';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { AssetVerifyErrorResponse } from '../api.ts';
import type { AssetType } from './asset-catalog.ts';
import { backupAssets, defaultAssetOptions, verifyAssets, type AssetBackupOptions } from './assets.ts';
import {
  MANIFEST_FILENAME, classifyRecoveryKind, generateBackupId, loadManifest, markFull, markPartial,
  newManifest, normalizeBackupIdForDir, refreshIncludedComponents, saveManifest, sha256File, sha256FileAsync,
  updateCoverage, validateForSlotRestore, validateSafeRelativePath, validateUntrusted,
  type AssetBackupResult, type BackupFile, type BackupManifest,
} from './manifest.ts';
import { databasePath, userHomeDir } from './paths.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { ioMessage } from './io.ts';
import { archivePathRequiresExplicitTrust } from './manifest.ts';
import { prepareBackupRestoreDestination } from './restore-files.ts';
import type { VfsMaintenanceService } from '../../vfs-repos/api.ts';
import { DATABASE_IDS, type CoordinatedId } from './migrations.ts';
import {
  copyCryptoFileToStaging, MAX_BACKUP_MASTER_KEY_BYTES, MAX_BACKUP_SECURE_FILE_BYTES, MAX_BACKUP_SECURE_FILES,
  MAX_BACKUP_SECURE_TOTAL_BYTES, validateStagedMasterKey,
} from './crypto-restore.ts';

export interface BackupContext {
  readonly ctx: Context;
  readonly backupRoot: string;
  readonly activeDir: string;
  readonly baseDir: string;
}

export interface BackupVerifyResult {
  isValid: boolean;
  databaseErrors: string[];
  assetErrors: AssetVerifyErrorResponse[];
}

export interface CreateBackupOptions {
  includeAssets: boolean;
  assetTypes?: readonly string[] | null;
  assetOptions?: Partial<AssetBackupOptions>;
  selectedDatabases?: readonly CoordinatedId[];
  backupIdSuffix?: string;
  missingDatabaseStyle?: 'full' | 'tiered';
  onProgress?: (phase: 'scan' | 'checkpoint' | 'compress' | 'verify', message: string, processed: number, total: number) => void;
  checkContinue?: () => void;
}

export function listBackups(
  root: string,
  warn: (message: string) => void = () => undefined,
): BackupManifest[] {
  if (!existsSync(root)) return [];
  const backups: BackupManifest[] = [];
  // Rust mod.rs:5705-5709：read_dir 失败为 BackupError::Io（"IO error: {e}"）；`path.is_dir()` 不报错。
  let entries: string[];
  try { entries = readdirSync(root); }
  catch (error) { throw new Error(`IO error: ${ioMessage(error)}`); }
  for (const entry of entries) {
    const path = join(root, entry);
    let isDir: boolean;
    try { isDir = statSync(path).isDirectory(); }
    catch { isDir = false; }
    if (!isDir) continue;
    const manifestPath = join(path, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = loadManifest(manifestPath);
      const manifestId = manifest.backup_id;
      normalizeBackupIdForDir(manifest, entry);
      if (manifestId !== entry) {
        warn(`备份清单 backup_id 与目录名不一致，将以目录名为准: manifest.backup_id=${manifestId}, dir=${entry}`);
      }
      backups.push(manifest);
    } catch (error) {
      warn(`无法加载备份清单 ${manifestPath}: ${ioMessage(error)}`);
      continue;
    }
  }
  backups.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return backups;
}

/** `BackupManager::cleanup_old_backups`：只清理已验证的完整快照，失败记录 warn 后继续。 */
export async function cleanupOldBackups(
  root: string,
  keepCount: number,
  warn: (message: string) => void,
): Promise<string[]> {
  const backups = listBackups(root, warn)
    .filter(backup => !backup.is_incremental && backup.snapshot_kind === 'full');
  const deleted: string[] = [];
  if (backups.length <= keepCount) return deleted;
  for (const backup of backups.slice(keepCount)) {
    try {
      await deleteBackup(root, backup.backup_id);
      deleted.push(backup.backup_id);
    } catch (error) {
      warn(`删除旧备份失败 ${backup.backup_id}: ${ioMessage(error)}`);
    }
  }
  return deleted;
}

export function findBackup(
  root: string,
  backupId: string,
  notFound: '备份不存在' | '未找到备份' = '备份不存在',
  warn: (message: string) => void = () => undefined,
): BackupManifest {
  const manifest = listBackups(root, warn).find(candidate => candidate.backup_id === backupId);
  if (!manifest) throw new Error(`${notFound}: ${backupId}`);
  return manifest;
}

export async function deleteBackup(root: string, backupId: string): Promise<void> {
  const path = join(root, backupId);
  // Rust `BackupError::FileNotFound` 的 Display 前缀会进入命令错误文案。
  if (!existsSync(path)) throw new Error(`File not found: 备份不存在: ${backupId}`);
  await rm(path, { recursive: true, force: true });
}

function backupFilePath(root: string, relative: string): string {
  validateSafeRelativePath(relative);
  return join(root, relative);
}

function fileEntry(root: string, relative: string, databaseId?: string): BackupFile {
  const path = backupFilePath(root, relative);
  const metadata = statSync(path);
  return {
    path: relative,
    size: metadata.size,
    sha256: sha256File(path, metadata.size),
    ...(databaseId === undefined ? {} : { database_id: databaseId }),
  };
}

/** {@link fileEntry} 的异步版本：数据库快照可达 GB 级，哈希不能阻塞 Host 事件循环。 */
async function fileEntryAsync(root: string, relative: string, databaseId?: string): Promise<BackupFile> {
  const path = backupFilePath(root, relative);
  const metadata = await stat(path);
  return {
    path: relative,
    size: metadata.size,
    sha256: await sha256FileAsync(path, metadata.size),
    ...(databaseId === undefined ? {} : { database_id: databaseId }),
  };
}

async function snapshotDatabase(ctx: Context, src: string, dest: string): Promise<void> {
  let source: DatabaseHandle;
  try { source = ctx.storage.openFile(src, { label: `backup:${basename(src)}`, mustExist: true }); }
  catch (e) { throw new Error(`打开源库失败: ${ioMessage(e)}`); }
  try {
    try { source.checkpoint('TRUNCATE'); }
    catch (e) { ctx.logger('backup').warn(`数据库 checkpoint 失败，继续在线备份: ${ioMessage(e)}`); }
    mkdirSync(dirname(dest), { recursive: true });
    await source.backupTo(dest);
  } finally {
    ctx.storage.close(source);
  }
  const handle = ctx.storage.openFile(dest, { label: `backup-dest:${basename(dest)}`, mustExist: true });
  try { handle.checkpoint('TRUNCATE'); } finally { ctx.storage.close(handle); }
}

function schemaVersionOf(ctx: Context, path: string): number {
  const db = ctx.storage.openFile(path, { label: 'backup-schema-version', mustExist: true });
  try {
    if (!hasRefineryHistory(db)) return 0;
    return maxRefineryVersion(db);
  } finally {
    ctx.storage.close(db);
  }
}

async function copyStrict(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  const [copied, original] = await Promise.all([stat(dest), stat(src)]);
  if (copied.size !== original.size) throw new Error(`复制字节数不匹配: ${src} -> ${dest}`);
}

function collectFiles(root: string, relativeRoot: string): string[] {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`备份域根必须是普通目录: ${relativeRoot}`);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`备份域不允许符号链接: ${path}`);
      if (metadata.isDirectory()) walk(path);
      else if (metadata.isFile()) files.push(path.slice(root.length + 1).replace(/\\/g, '/'));
      else throw new Error(`备份域包含非常规条目: ${path}`);
    }
  };
  walk(absolute);
  return files.sort();
}

/**
 * `BackupManager::backup_crypto_keys`（backup/mod.rs:3320-3445）：返回备份的密钥文件数；
 * 调用方 mod.rs:3234-3262 据此设置 key_policy 并记录 crypto 覆盖。
 */
export function backupCryptoKeys(ctx: Context, backupDir: string, manifest: BackupManifest): number {
  const log = ctx.logger('backup');
  const appRoot = ctx.app.dataDir;
  const masterKey = join(appRoot, '.master_key');
  const secureDir = join(appRoot, '.secure');
  const masterStat = safeLstat(masterKey);
  if (masterStat && (masterStat.isSymbolicLink() || !masterStat.isFile())) {
    throw new Error('应用主密钥路径不是普通文件，拒绝跟随符号链接备份');
  }
  const secureStat = safeLstat(secureDir);
  if (secureStat && (secureStat.isSymbolicLink() || !secureStat.isDirectory())) {
    throw new Error('应用安全存储路径不是普通目录，拒绝跟随符号链接备份');
  }
  let count = 0;
  if (masterStat || secureStat) {
    const cryptoDest = join(backupDir, 'crypto');
    mkdirSync(cryptoDest, { recursive: true });
    if (masterStat) {
      const dest = join(cryptoDest, '.master_key');
      try { copyCryptoFileToStaging(masterKey, dest, MAX_BACKUP_MASTER_KEY_BYTES); }
      catch (error) { throw new Error(`备份 .master_key 失败: ${ioMessage(error)}`); }
      validateStagedMasterKey(dest);
      count += 1;
      log.info('[Backup] 已备份 .master_key');
    }
    if (secureStat) {
      const secureDest = join(cryptoDest, '.secure');
      mkdirSync(secureDest, { recursive: true });
      let secureCount = 0;
      let secureTotal = 0;
      for (const name of readdirSync(secureDir)) {
        const path = join(secureDir, name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) throw new Error(`安全存储包含符号链接，拒绝备份: ${path}`);
        if (!metadata.isFile()) throw new Error(`安全存储包含非常规条目，拒绝备份: ${path}`);
        // OAuth 刷新令牌是设备本地会话，跨机恢复会与令牌轮换竞争。
        if (name === 'internal.oauth.openai_codex.session.enc') {
          log.info('[Backup] 已跳过设备本地 Codex OAuth 会话');
          continue;
        }
        const isSeed = name === '.key_seed';
        const dot = name.lastIndexOf('.');
        const isEncrypted = dot > 0 && name.slice(dot + 1).toLowerCase() === 'enc';
        if (!isSeed && !isEncrypted) throw new Error(`安全存储包含未识别文件，拒绝声明完整 crypto 覆盖: ${path}`);
        secureCount += 1;
        if (secureCount > MAX_BACKUP_SECURE_FILES) throw new Error(`安全存储文件数超限: ${secureCount}`);
        let copied: number;
        try { copied = copyCryptoFileToStaging(path, join(secureDest, name), MAX_BACKUP_SECURE_FILE_BYTES); }
        catch (error) { throw new Error(`备份 .secure/${name} 失败: ${ioMessage(error)}`); }
        secureTotal += copied;
        if (secureTotal > MAX_BACKUP_SECURE_TOTAL_BYTES) throw new Error(`安全存储总大小超限: ${secureTotal} bytes`);
      }
      count += secureCount;
      log.info(`[Backup] 已备份 .secure/ 目录: ${secureCount} 个文件`);
    }
  }

  if (count > 0) {
    log.info(`加密密钥备份完成: ${count} 个文件`);
    manifest.key_policy = 'included_local';
  } else {
    manifest.key_policy = 'not_present';
  }
  const cryptoFiles = collectFiles(backupDir, 'crypto');
  if (cryptoFiles.length === 0) {
    updateCoverage(manifest, 'crypto', existsSync(join(backupDir, 'crypto')) ? 'empty' : 'absent', []);
  } else {
    for (const relative of cryptoFiles) manifest.files.push(fileEntry(backupDir, relative));
    updateCoverage(manifest, 'crypto', 'complete', cryptoFiles);
  }
  return count;
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function validateMasterKey(path: string): void {
  const content = rustTrim(readFileSync(path, 'utf8'));
  const decoded = Buffer.from(content, 'base64');
  if (decoded.length !== 32) throw new Error(`备份主密钥长度无效: expected=32, actual=${decoded.length}`);
}

/** `backup_audit_db`（mod.rs:4053-4093）与调用方 3266-3275：存在时必须是普通文件，返回是否已备份。 */
export async function backupAuditDb(ctx: Context, backupDir: string, manifest: BackupManifest): Promise<boolean> {
  const log = ctx.logger('backup');
  const source = join(ctx.storage.locations.activeDir, 'databases', 'audit.db');
  const metadata = safeLstat(source);
  if (metadata == null) {
    updateCoverage(manifest, 'audit', 'absent', []);
    log.debug('审计数据库不存在，记录 absent');
    return false;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`审计数据库必须是普通文件: ${source}`);
  const dest = join(backupDir, 'databases', 'audit.db');
  await snapshotDatabase(ctx, source, dest);
  log.info(`[Backup] 已备份 audit.db: ${source} -> ${dest}`);
  const file = await fileEntryAsync(backupDir, 'databases/audit.db');
  manifest.files.push(file);
  updateCoverage(manifest, 'audit', 'complete', [file.path]);
  log.info('审计数据库备份完成');
  return true;
}

async function backupWorkspaces(ctx: Context, backupDir: string, manifest: BackupManifest): Promise<void> {
  const srcDir = join(ctx.storage.locations.activeDir, 'workspaces');
  const stat = safeLstat(srcDir);
  if (!stat) { updateCoverage(manifest, 'workspaces-root', 'absent', []); return; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`工作区数据库根必须是普通目录: ${srcDir}`);
  const destDir = join(backupDir, 'workspaces');
  const files: BackupFile[] = [];
  for (const name of readdirSync(srcDir).sort()) {
    if (!name.startsWith('ws_') || !name.endsWith('.db')) continue;
    const src = join(srcDir, name);
    const metadata = lstatSync(src);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`工作区数据库必须是普通文件: ${src}`);
    const dest = join(destDir, name);
    await snapshotDatabase(ctx, src, dest);
    files.push(await fileEntryAsync(backupDir, `workspaces/${name}`));
  }
  manifest.files.push(...files);
  updateCoverage(manifest, 'workspaces-root', files.length > 0 ? 'complete' : 'empty', files.map(file => file.path));
}

async function copyPersistentFile(source: string, backupDir: string, archivePath: string, manifest: BackupManifest, domainId: string): Promise<void> {
  const metadata = safeLstat(source);
  if (!metadata) { updateCoverage(manifest, domainId, 'absent', []); return; }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`持久域必须是普通文件: ${source}`);
  await copyStrict(source, join(backupDir, archivePath));
  const file = await fileEntryAsync(backupDir, archivePath);
  manifest.files.push(file);
  updateCoverage(manifest, domainId, 'complete', [file.path]);
}

async function copyPersistentDirectory(source: string, backupDir: string, archiveRoot: string, manifest: BackupManifest, domainId: string): Promise<void> {
  const rootMetadata = safeLstat(source);
  if (!rootMetadata) { updateCoverage(manifest, domainId, 'absent', []); return; }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`持久域必须是普通目录: ${source}`);
  const dest = join(backupDir, archiveRoot);
  const copy = async (dir: string, relative: string): Promise<void> => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const metadata = lstatSync(path);
      const target = relative === '' ? name : `${relative}/${name}`;
      if (metadata.isSymbolicLink()) throw new Error(`持久域不允许符号链接: ${path}`);
      if (metadata.isDirectory()) { mkdirSync(join(dest, target), { recursive: true }); await copy(path, target); }
      else if (metadata.isFile()) await copyStrict(path, join(dest, target));
      else throw new Error(`持久域包含非常规条目: ${path}`);
    }
  };
  mkdirSync(dest, { recursive: true });
  await copy(source, '');
  const files = collectFiles(backupDir, archiveRoot);
  for (const relative of files) manifest.files.push(await fileEntryAsync(backupDir, relative));
  updateCoverage(manifest, domainId, files.length > 0 ? 'complete' : 'empty', files);
}

async function backupPersistentDomains(ctx: Context, backupDir: string, manifest: BackupManifest): Promise<void> {
  const active = ctx.storage.locations.activeDir;
  await copyPersistentFile(join(active, 'webview_settings.json'), backupDir, 'persistent/webview_settings.json', manifest, 'webview-settings');
  await copyPersistentFile(join(active, 'custom_grading_modes.json'), backupDir, 'persistent/custom_grading_modes.json', manifest, 'custom-grading-modes');
  // backup/mod.rs:2920-2922：home_dir() 为 None 时退回 app_data_dir（活动槽）。
  const skillsHome = userHomeDir(ctx) ?? active;
  await copyPersistentDirectory(join(skillsHome, '.deep-student', 'skills'), backupDir, 'persistent/user_skills', manifest, 'user-skills');
}

export async function createBackup(context: BackupContext, options: CreateBackupOptions): Promise<BackupManifest> {
  const { ctx, backupRoot, activeDir } = context;
  if (!existsSync(backupRoot)) mkdirSync(backupRoot, { recursive: true });
  let backupId = '';
  let backupDir = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    backupId = generateBackupId(options.backupIdSuffix);
    backupDir = join(backupRoot, backupId);
    try { mkdirSync(backupDir); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 9) continue;
      throw new Error(ioMessage(e));
    }
  }
  if (!backupDir) throw new Error('无法生成唯一备份目录（多次尝试均冲突）');

  const manifest = newManifest(ctx.app.version);
  manifest.backup_id = backupId;
  try {
    options.onProgress?.('scan', '正在备份核心数据库', 0, 4);
    const selected = options.selectedDatabases ?? DATABASE_IDS;
    const total = selected.length;
    let index = 0;
    for (const id of selected) {
      options.checkContinue?.();
      const src = databasePath(activeDir, id);
      const stat = safeLstat(src);
      if (!stat) {
        throw new Error(options.missingDatabaseStyle === 'tiered'
          ? `已选择的数据库不存在 ${id}: ${src}`
          : `完整备份缺少核心数据库 ${id}: ${src}`);
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(options.missingDatabaseStyle === 'tiered'
          ? `已选择的数据库不是普通文件 ${id}: ${src}`
          : `核心数据库必须是普通文件 ${id}: ${src}`);
      }
      const dest = join(backupDir, `${id}.db`);
      await snapshotDatabase(ctx, src, dest);
      const file = await fileEntryAsync(backupDir, `${id}.db`, id);
      manifest.files.push(file);
      updateCoverage(manifest, `database:${id}`, 'complete', [file.path]);
      manifest.schema_versions[id] = schemaVersionOf(ctx, src);
      index += 1;
      options.onProgress?.('checkpoint', `已备份数据库 ${id}`, index, total);
    }

    options.checkContinue?.();
    backupCryptoKeys(ctx, backupDir, manifest);
    options.checkContinue?.();
    await backupAuditDb(ctx, backupDir, manifest);
    options.checkContinue?.();
    await backupWorkspaces(ctx, backupDir, manifest);
    options.checkContinue?.();
    await backupPersistentDomains(ctx, backupDir, manifest);
    markPartial(manifest);

    if (options.includeAssets) {
      options.onProgress?.('compress', '正在备份资产文件', 0, 1);
      const filtered = options.assetTypes && options.assetTypes.length > 0
        ? options.assetTypes.filter((type): type is AssetType => defaultAssetOptions().asset_types.includes(type as AssetType))
        : [];
      // Rust `commands_backup.rs:1980-1997`：显式 assetTypes 全部无效时回退默认资产集合，
      // 而不是把空集合交给资产扫描。
      const requested = filtered.length > 0 ? filtered : defaultAssetOptions().asset_types;
      const assetOptions: AssetBackupOptions = {
        ...defaultAssetOptions(requested),
        ...options.assetOptions,
        asset_types: requested,
      };
      let assets: AssetBackupResult;
      try { assets = await backupAssets(activeDir, backupDir, assetOptions); }
      catch (e) { throw new Error(`资产备份失败，已中止本次备份: ${ioMessage(e)}`); }
      manifest.assets = assets;

      const selected = new Set(requested);
      for (const type of defaultAssetOptions().asset_types) {
        if (!selected.has(type)) {
          updateCoverage(manifest, `asset-root:${type}`, 'excluded', [], 'asset type was not selected');
          continue;
        }
        const paths = assets.files.filter(asset => asset.asset_type === type && !asset.is_directory).map(asset => asset.relative_path);
        const checksumComplete = assetOptions.compute_checksum && assets.files
          .filter(asset => asset.asset_type === type && !asset.is_directory)
          .every(asset => /^[0-9a-fA-F]{64}$/.test(asset.checksum ?? ''));
        const incomplete = assets.incomplete_asset_types.includes(type);
        let status: 'complete' | 'failed' | 'empty' | 'absent';
        if (incomplete || !checksumComplete) status = 'failed';
        else if (paths.length > 0) status = 'complete';
        else {
          const root = join(activeDir, type);
          const stat = safeLstat(root);
          status = stat ? (stat.isDirectory() && !stat.isSymbolicLink() ? 'empty' : 'failed') : 'absent';
        }
        updateCoverage(manifest, `asset-root:${type}`, status, status === 'complete' || status === 'failed' ? paths : [],
          status === 'failed' ? 'asset filtering or checksum evidence was incomplete' : undefined);
      }

      if (selected.has('workspaces')) {
        const agentPaths = assets.files
          .filter(asset => !asset.is_directory && asset.original_path.startsWith('workspaces/agents/'))
          .map(asset => asset.relative_path);
        const workspacesStatus = manifest.coverage?.domains['asset-root:workspaces']?.status ?? 'failed';
        let status: 'complete' | 'failed' | 'empty' | 'absent';
        if (workspacesStatus === 'failed') status = 'failed';
        else if (agentPaths.length > 0) status = 'complete';
        else {
          const stat = safeLstat(join(activeDir, 'workspaces', 'agents'));
          status = stat ? (stat.isDirectory() && !stat.isSymbolicLink() ? 'empty' : 'failed') : 'absent';
        }
        updateCoverage(manifest, 'agents', status, status === 'complete' || status === 'failed' ? agentPaths : [],
          'restored agent definitions remain untrusted until explicit review');
      } else {
        updateCoverage(manifest, 'agents', 'excluded', [], 'workspaces assets were not selected');
      }
    } else {
      for (const type of defaultAssetOptions().asset_types) {
        updateCoverage(manifest, `asset-root:${type}`, 'excluded', [], 'asset type was not selected');
      }
      updateCoverage(manifest, 'agents', 'excluded', [], 'workspaces assets were not selected');
    }

    try { markFull(manifest); } catch { markPartial(manifest); }
    refreshIncludedComponents(manifest);

    options.onProgress?.('verify', '正在校验备份', 0, 1);
    validateUntrusted(manifest);
    if (manifest.snapshot_kind === 'full') validateForSlotRestore(manifest);
    saveManifest(join(backupDir, MANIFEST_FILENAME), manifest, ctx.logger('backup'));
    const verification = await verifyWithAssets(ctx, backupRoot, manifest);
    if (!verification.isValid) {
      const detail = [...verification.databaseErrors, ...verification.assetErrors.map(e => `资产校验失败 [${e.path}]: ${e.message}`)].join('\n');
      try { rmSync(join(backupDir, MANIFEST_FILENAME), { force: true }); }
      catch (e) { ctx.logger('backup').warn(`删除未通过校验的清单失败: ${ioMessage(e)}`); }
      throw new Error(`备份验证失败（${verification.databaseErrors.length + verification.assetErrors.length} 个错误）。备份可能已损坏，请使用其他备份或重新创建备份。\n详情:\n${detail}`);
    }
    options.onProgress?.('verify', '备份完成', 1, 1);
    return manifest;
  } catch (error) {
    try { await rm(backupDir, { recursive: true, force: true }); }
    catch (e) { ctx.logger('backup').warn(`清理失败备份目录失败: ${ioMessage(e)}`); }
    throw error;
  }
}

export async function verifyWithAssets(ctx: Context, backupRoot: string, manifest: BackupManifest): Promise<BackupVerifyResult> {
  return verifyDirectoryWithAssets(ctx, join(backupRoot, manifest.backup_id), manifest);
}

/**
 * 验证指定目录中的备份内容。`zip_export::validate_imported_backup_dir` 的
 * `verify_internal(&manifest, target_dir)` 直接使用解压目录，目录名可以与
 * 清单里的 `backup_id` 不同（导入时允许用户指定新 ID）。
 */
export async function verifyDirectoryWithAssets(
  ctx: Context, backupDir: string, manifest: BackupManifest,
): Promise<BackupVerifyResult> {
  if (!existsSync(backupDir)) {
    return { isValid: false, databaseErrors: [`备份目录不存在: ${backupDir}`], assetErrors: [] };
  }
  const databaseErrors: string[] = [];
  try { validateUntrusted(manifest); }
  catch (e) { databaseErrors.push(ioMessage(e)); }
  for (const file of manifest.files) {
    let path: string;
    try { path = resolveExistingBackupFile(backupDir, file.path); }
    catch (e) { databaseErrors.push(ioMessage(e)); continue; }
    const metadata = await stat(path);
    if (metadata.size !== file.size) {
      databaseErrors.push(`文件大小不匹配 ${file.path}: expected=${file.size}, actual=${metadata.size}`);
      continue;
    }
    const actual = await sha256FileAsync(path, file.size);
    if (actual !== file.sha256) {
      databaseErrors.push(`校验和不匹配 ${file.path}: expected=${file.sha256}, actual=${actual}`);
      continue;
    }
    const isWorkspaceDatabase = file.path.startsWith('workspaces/')
      && !file.path.slice('workspaces/'.length).includes('/')
      && file.path.slice('workspaces/'.length).startsWith('ws_')
      && file.path.endsWith('.db');
    const governed = file.database_id != null || file.path === 'databases/audit.db' || isWorkspaceDatabase;
    if (governed) {
      // Rust 的 `verify_database_integrity` 在函数内部 `Connection::open`，
      // 打开失败与完整性检查失败同样归入该文件的验证错误。
      try {
        const db = ctx.storage.openFile(path, { label: `verify:${file.path}`, mustExist: true });
        try {
          const result = integrityCheck(db);
          if (result !== 'ok') databaseErrors.push(`数据库完整性检查失败 ${file.path}: 完整性检查失败: ${String(result)}`);
        } finally { ctx.storage.close(db); }
      } catch (e) {
        databaseErrors.push(`数据库完整性检查失败 ${file.path}: ${ioMessage(e)}`);
      }
    }
  }
  let assetErrors: AssetVerifyErrorResponse[] = [];
  if (manifest.assets) {
    try { assetErrors = await verifyAssets(backupDir, manifest.assets.files); }
    catch (e) { assetErrors = [{ path: 'assets', error_type: 'verify_failed', message: ioMessage(e) }]; }
  }
  if (manifest.key_policy === 'included_local') {
    const cryptoCoverage = manifest.coverage?.domains.crypto;
    if (!cryptoCoverage) databaseErrors.push('加密材料验证失败: 密钥策略声明 included_local 但缺少 crypto 覆盖');
    else if (cryptoCoverage.status !== 'complete') databaseErrors.push('加密材料验证失败: 密钥策略声明 included_local 但 crypto 域不完整');
    else {
      for (const relative of cryptoCoverage.paths) {
        const allowed = relative === 'crypto/.master_key' || relative === 'crypto/.secure/.key_seed'
          || (relative.startsWith('crypto/.secure/') && relative.toLowerCase().endsWith('.enc'));
        if (!allowed) databaseErrors.push(`加密材料验证失败: crypto 域包含未识别文件: ${relative}`);
      }
      if (cryptoCoverage.paths.includes('crypto/.master_key')) {
        try { validateMasterKey(join(backupDir, 'crypto', '.master_key')); }
        catch (e) { databaseErrors.push(`加密材料验证失败: 主密钥验证失败: ${ioMessage(e)}`); }
      }
      const hasSeed = cryptoCoverage.paths.includes('crypto/.secure/.key_seed');
      const encrypted = cryptoCoverage.paths.filter(path => path.startsWith('crypto/.secure/') && path.toLowerCase().endsWith('.enc'));
      if (hasSeed) {
        try { await ctx.secrets.validateBackupSeedFile(join(backupDir, 'crypto', '.secure', '.key_seed')); }
        catch (e) { databaseErrors.push(`加密材料验证失败: 安全存储种子不可用于恢复: ${ioMessage(e)}`); }
      }
      if (encrypted.length > 0 && !hasSeed) {
        databaseErrors.push('加密材料验证失败: crypto 域包含加密凭据但缺少 .key_seed');
      } else if (encrypted.length > 0) {
        // Rust 在隔离副本中实际解密每个凭据，避免 SecureStore 迁移种子时改动刚校验过的备份。
        let sandbox: string | null = null;
        try {
          sandbox = await mkdtemp(join(tmpdir(), 'dstu-verify-crypto-'));
          const sandboxSecure = join(sandbox, '.secure');
          await mkdir(sandboxSecure, { recursive: true });
          await copyFile(join(backupDir, 'crypto', '.secure', '.key_seed'), join(sandboxSecure, '.key_seed'));
          for (const relative of encrypted) {
            const source = resolveExistingBackupFile(backupDir, relative);
            await copyFile(source, join(sandboxSecure, basename(relative)));
          }
          const store = ctx.secrets.openStore(sandbox);
          for (const relative of encrypted) {
            const key = basename(relative).replace(/\.enc$/i, '');
            try {
              const value = await store.getSecret(key);
              if (value === null) databaseErrors.push(`加密材料验证失败: 加密凭据验证时消失: ${relative}`);
            } catch (e) {
              databaseErrors.push(`加密材料验证失败: 加密凭据无法实际解密 ${relative}: ${ioMessage(e)}`);
            }
          }
        } catch (e) {
          databaseErrors.push(`加密材料验证失败: ${ioMessage(e)}`);
        } finally {
          if (sandbox !== null) await rm(sandbox, { recursive: true, force: true });
        }
      }
    }
  }
  if (!existsSync(join(backupDir, MANIFEST_FILENAME))) databaseErrors.push('清单文件不存在');
  return { isValid: databaseErrors.length === 0 && assetErrors.length === 0, databaseErrors, assetErrors };
}

export function resolveExistingBackupFile(backupDir: string, relative: string): string {
  validateSafeRelativePath(relative);
  const rootStat = lstatSync(backupDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`备份根路径必须是普通目录: ${backupDir}`);
  let resolved = backupDir;
  const components = relative.split('/');
  for (let index = 0; index < components.length; index++) {
    resolved = join(resolved, components[index]!);
    let stat;
    try { stat = lstatSync(resolved); }
    catch (e) { throw new Error(`无法检查备份路径 ${resolved}: ${ioMessage(e)}`); }
    if (stat.isSymbolicLink()) throw new Error(`备份路径不允许符号链接: ${resolved}`);
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error(`备份路径包含非目录组件: ${resolved}`);
  }
  return resolved;
}

export function backupInfo(manifest: BackupManifest): {
  path: string; created_at: string; size: number; backup_type: string;
  recovery_kind: string; restorable: boolean; databases: string[];
} {
  const assetSize = manifest.assets?.total_size ?? 0;
  let filesSize = 0n;
  for (const file of manifest.files) filesSize += BigInt(file.size);
  const size = filesSize + BigInt(assetSize);
  if (size > ((1n << 64n) - 1n)) {
    throw new Error('[E_RESTORE_DISK_BUDGET_OVERFLOW] 恢复备份文件大小统计溢出，已拒绝继续');
  }
  const classification = classifyRecoveryKind(manifest);
  const backupType = manifest.is_incremental ? 'incremental'
    : manifest.snapshot_kind === 'full' ? 'full'
      : manifest.snapshot_kind === 'partial_overlay' ? 'partial_overlay' : 'legacy_unknown';
  return {
    path: manifest.backup_id,
    created_at: manifest.created_at,
    size: Number(size),
    backup_type: backupType,
    recovery_kind: classification.kind,
    restorable: classification.restorable,
    databases: manifest.files.flatMap(file => file.database_id == null ? [] : [file.database_id]),
  };
}


// ------------------------------------------------------------------ 恢复（backup/mod.rs）

const VFS_LANCE_COMPONENT = 'rebuildable-root:databases/lance/vfs';

/** `has_complete_vfs_lance_component`。 */
export function hasCompleteVfsLanceComponent(manifest: BackupManifest, restoreAssets: boolean): boolean {
  return restoreAssets && manifest.included_components.includes(VFS_LANCE_COMPONENT);
}

/**
 * `prepare_vfs_index_restore`：先删除候选槽中的 Lance 目录；只有备份声明
 * 完整 Lance 组件时才保留空目录等待随包文件恢复，否则重置 SQLite 账本。
 */
export async function prepareVfsIndexRestore(
  ctx: Context,
  manifest: BackupManifest,
  targetDir: string,
  restoreAssets: boolean,
): Promise<void> {
  const lanceDir = join(targetDir, 'databases', 'lance', 'vfs');
  if (existsSync(lanceDir)) await rm(lanceDir, { recursive: true, force: true });
  if (hasCompleteVfsLanceComponent(manifest, restoreAssets)) {
    await mkdir(lanceDir, { recursive: true });
    return;
  }
  resetRebuildableVfsIndex(ctx, targetDir);
}

/** `finalize_vfs_index_restore`。 */
export function finalizeVfsIndexRestore(
  ctx: Context,
  manifest: BackupManifest,
  targetDir: string,
  restoreAssets: boolean,
): void {
  if (hasCompleteVfsLanceComponent(manifest, restoreAssets)) return;
  resetRebuildableVfsIndex(ctx, targetDir);
}

function resetRebuildableVfsIndex(ctx: Context, targetDir: string): void {
  const owner = ctx.get('vfsMaintenance') as VfsMaintenanceService | undefined;
  if (owner === undefined) throw new Error('VFS 恢复重置服务尚未安装: vfsMaintenance.resetRebuildableIndex');
  owner.resetRebuildableIndex(targetDir);
  const dbPath = join(targetDir, 'databases', 'vfs.db');
  if (existsSync(dbPath)) {
    ctx.logger('backup').info(`[Restore] VFS 派生向量索引未随备份完整恢复，已重置账本并等待本机重建: ${dbPath}`);
  }
}

async function restoreDbAtPath(ctx: Context, source: string, destination: string): Promise<void> {
  if (!existsSync(source)) throw new Error(`备份文件不存在: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });

  let sourceHandle: DatabaseHandle;
  try { sourceHandle = ctx.storage.openFile(source, { label: `restore-src:${basename(source)}`, mustExist: true }); }
  catch (error) { throw new Error(`打开备份数据库失败: ${source} (${ioMessage(error)})`); }
  try {
    try { sourceHandle.checkpoint('TRUNCATE'); }
    catch (error) { ctx.logger('backup').warn(`备份数据库 checkpoint 失败，继续恢复: ${ioMessage(error)}`); }
    if (existsSync(destination)) {
      const existing = ctx.storage.openFile(destination, { label: `restore-dest:${basename(destination)}` });
      try { existing.checkpoint('TRUNCATE'); } finally { ctx.storage.close(existing); }
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${destination}${suffix}`;
        if (existsSync(sidecar)) rmSync(sidecar, { force: true });
      }
    }
    try { await sourceHandle.backupTo(destination); }
    catch (error) { throw new Error(`恢复数据库失败: ${ioMessage(error)}`); }
  } finally {
    ctx.storage.close(sourceHandle);
  }

  const target = ctx.storage.openFile(destination, { label: `restore-verify:${basename(destination)}`, mustExist: true });
  try {
    try { target.checkpoint('TRUNCATE'); }
    catch (error) { ctx.logger('backup').warn(`恢复后 checkpoint 失败: ${ioMessage(error)}`); }
    const result = integrityCheck(target);
    if (result !== 'ok') throw new Error(`恢复后完整性检查失败: ${result}`);
  } finally {
    ctx.storage.close(target);
  }
}

/** `restore_single_database_to_dir`。 */
export async function restoreSingleDatabaseToDir(
  ctx: Context,
  dbId: CoordinatedId,
  backupDir: string,
  targetDir: string,
): Promise<void> {
  const source = join(backupDir, `${dbId}.db`);
  if (!existsSync(source)) throw new Error(`备份文件不存在: ${source}`);
  await restoreDbAtPath(ctx, source, databasePath(targetDir, dbId));
}

/** `restore_workspace_manifest_files_to_dir`：只恢复清单声明的 ws_*.db。 */
export async function restoreWorkspaceManifestFilesToDir(
  ctx: Context,
  manifest: BackupManifest,
  backupDir: string,
  targetDir: string,
): Promise<number> {
  const workspaceTarget = join(targetDir, 'workspaces');
  mkdirSync(workspaceTarget, { recursive: true });
  let restored = 0;
  for (const file of manifest.files) {
    if (file.database_id != null || !file.path.startsWith('workspaces/')) continue;
    const source = resolveExistingBackupFile(backupDir, file.path);
    const name = basename(file.path);
    if (name === '' || name === '.' || name === '..') {
      throw new Error(`工作区数据库路径无文件名: ${file.path}`);
    }
    const destination = prepareBackupRestoreDestination(workspaceTarget, name);
    await restoreDbAtPath(ctx, source, destination);
    const restoredSize = statSync(destination).size;
    if (restoredSize !== file.size) {
      throw new Error(
        `工作区数据库恢复后大小不匹配 ${file.path}: expected=${file.size}, actual=${restoredSize}`,
      );
    }
    restored += 1;
  }
  return restored;
}

/** `restore_non_database_manifest_files`。 */
export async function restoreNonDatabaseManifestFiles(
  manifest: BackupManifest,
  backupDir: string,
  targetDir: string,
): Promise<number> {
  let restored = 0;
  for (const file of manifest.files) {
    if (file.path.endsWith('.db')) continue;
    if (archivePathRequiresExplicitTrust(file.path)) continue;
    const root = file.path.split('/')[0];
    if (root === 'crypto' || root === 'persistent') continue;
    const source = resolveExistingBackupFile(backupDir, file.path);
    const destination = prepareBackupRestoreDestination(targetDir, file.path);
    await copyFile(source, destination);
    const restoredSize = (await stat(destination)).size;
    if (restoredSize !== file.size) {
      throw new Error(
        `文件恢复后大小不匹配 ${file.path}: expected=${file.size}, actual=${restoredSize}`,
      );
    }
    restored += 1;
  }
  return restored;
}
