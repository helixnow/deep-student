import { basename, join } from 'node:path';
import { copyFile, lstat, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import type { AssetTypeInfo, AssetScanResponse } from '../api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { ioMessage, isPathWithin } from './io.ts';

import { catalog, type AssetType } from './asset-catalog.ts';
export { catalog, type AssetType };
export function assetTypes(): AssetTypeInfo[] {
  return catalog.map(([id, name, priority]) => ({ id, name, relative_path: id, priority }));
}
export function defaultAssetBackupConfig() {
  return { asset_types: catalog.map(([id]) => id), compute_checksum: true,
    max_file_size: 500 * 1024 * 1024, max_total_size: 10 * 1024 * 1024 * 1024,
    skip_symlinks: true, skip_sensitive_files: true, preserve_directory_structure: true,
    allowed_extensions: [] as string[], excluded_extensions: [] as string[] };
}
export function isSensitiveFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (!name) return false;
  const patterns = ['.env', 'credentials', '.pem', '.key', '.p12', '.pfx', 'secret', 'password', 'token', '.htpasswd',
    '.ssh', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.aws', '.npmrc', '.pypirc', 'auth.json', 'secrets.json', 'config.json'];
  if (patterns.some(pattern => name.includes(pattern))) return true;
  const lower = path.toLowerCase();
  return ['/.ssh/', '\\.ssh\\', '/secrets/', '\\secrets\\', '/credentials/', '\\credentials\\'].some(part => lower.includes(part));
}
export async function scanAssets(root: string, requested?: string[] | null): Promise<AssetScanResponse> {
  let types = requested?.filter(type => catalog.some(([id]) => id === type)) ?? [];
  if (!types.length) types = catalog.map(([id]) => id);
  const by_type: AssetScanResponse['by_type'] = {};
  for (const type of types) {
    const path = join(root, type);
    let metadata;
    try { metadata = await lstat(path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`IO 错误: ${ioMessage(e)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`配置无效: 资产扫描根不是普通目录: ${path}`);
    const stats = { file_count: 0, total_size: 0 };
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir)) {
        const path = join(dir, entry);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) throw new Error(`资产扫描不允许符号链接: ${path}`);
        if (metadata.isDirectory()) await scan(path);
        else if (metadata.isFile()) { stats.file_count++; stats.total_size += metadata.size; }
        else throw new Error(`资产扫描包含非常规条目: ${path}`);
      }
    }
    try { await scan(path); }
    catch (e) { throw new Error(`IO 错误: ${ioMessage(e)}`); }
    by_type[type] = stats;
  }
  return { by_type, total_files: Object.values(by_type).reduce((n, s) => n + s.file_count, 0),
    total_size: Object.values(by_type).reduce((n, s) => n + s.total_size, 0) };
}

// ------------------------------------------------------------------ 资产备份/验证

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename as pathBasename, extname, join as joinPath } from 'node:path';
import { pathIsAtOrBelow, persistentDomainRegistry, type AssetBackupResult, type BackedUpAsset } from './manifest.ts';
import type { AssetVerifyErrorResponse } from '../api.ts';

export interface AssetBackupOptions {
  asset_types: AssetType[];
  compute_checksum: boolean;
  max_file_size: number;
  max_total_size: number;
  skip_symlinks: boolean;
  skip_sensitive_files: boolean;
  preserve_directory_structure: boolean;
  allowed_extensions: string[];
  excluded_extensions: string[];
}

export function defaultAssetOptions(types: AssetType[] = catalog.map(([id]) => id)): AssetBackupOptions {
  return {
    asset_types: types, compute_checksum: true,
    max_file_size: 500 * 1024 * 1024, max_total_size: 10 * 1024 * 1024 * 1024,
    skip_symlinks: true, skip_sensitive_files: true, preserve_directory_structure: true,
    allowed_extensions: [], excluded_extensions: [],
  };
}

function skipReason(path: string, size: number, config: AssetBackupOptions): string | null {
  if (size > config.max_file_size) return 'file_too_large';
  if (config.skip_sensitive_files && isSensitiveFile(path)) return 'sensitive_file';
  const extension = extname(path).replace(/^\./, '').toLowerCase();
  if (config.allowed_extensions.length > 0
    && !config.allowed_extensions.some(e => e.toLowerCase() === extension)) return 'extension_not_allowed';
  if (config.excluded_extensions.some(e => e.toLowerCase() === extension)) return 'extension_excluded';
  return null;
}

export async function backupAssets(root: string, destDir: string, config: AssetBackupOptions): Promise<AssetBackupResult> {
  const result: AssetBackupResult = {
    files: [], total_files: 0, total_size: 0, skipped_files: 0, skip_reasons: {},
    incomplete_asset_types: [], by_asset_type: {},
    started_at: new Date().toISOString(), completed_at: '',
  };
  if (config.asset_types.length === 0) throw new Error('配置无效: asset_types 不能为空');
  await mkdir(destDir, { recursive: true });

  const sorted = [...config.asset_types].sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const assetType of sorted) {
    const src = join(root, assetType);
    let metadata;
    try { metadata = await lstat(src); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`IO 错误: ${ioMessage(e)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`配置无效: 资产根不是普通目录: ${src}`);
    }
    const assetDest = config.preserve_directory_structure ? join(destDir, 'assets', assetType) : join(destDir, 'assets');
    await mkdir(assetDest, { recursive: true });
    await walk(src, assetDest, src, assetType, config, result);
  }
  result.completed_at = new Date().toISOString();
  result.total_files = result.files.length;
  return result;
}

function priorityOf(type: AssetType): number {
  return type === 'audio' || type === 'videos' ? 1 : 0;
}

async function walk(current: string, destBase: string, srcBase: string, assetType: AssetType, config: AssetBackupOptions, result: AssetBackupResult): Promise<void> {
  let entries: string[];
  try { entries = await readdir(current); }
  catch (e) { throw new Error(`IO 错误: 无法读取资产目录 ${current}: ${ioMessage(e)}`); }
  for (const name of entries.sort()) {
    const path = join(current, name);
    let linkMetadata;
    try { linkMetadata = await lstat(path); }
    catch (e) { throw new Error(`IO 错误: 读取资产条目元数据失败 ${path}: ${ioMessage(e)}`); }
    if (linkMetadata.isSymbolicLink()) {
      if (config.skip_symlinks) {
        result.skipped_files += 1;
        if (!result.incomplete_asset_types.includes(assetType)) result.incomplete_asset_types.push(assetType);
        result.skip_reasons.symlink = (result.skip_reasons.symlink ?? 0) + 1;
        continue;
      }
      throw new Error(`配置无效: 资产备份不允许跟随符号链接: ${path}`);
    }
    if (linkMetadata.isDirectory()) {
      const relative = path.slice(srcBase.length).replace(/^[\\/]/, '');
      await mkdir(join(destBase, relative), { recursive: true });
      await walk(path, destBase, srcBase, assetType, config, result);
      continue;
    }
    if (!linkMetadata.isFile()) throw new Error(`配置无效: 资产条目不是普通文件或目录: ${path}`);
    if (assetType === 'workspaces' && ['.db', '-wal', '-shm'].some(suffix => path.endsWith(suffix))) continue;
    const size = linkMetadata.size;
    const reason = skipReason(path, size, config);
    if (reason !== null) {
      result.skipped_files += 1;
      if (!result.incomplete_asset_types.includes(assetType)) result.incomplete_asset_types.push(assetType);
      result.skip_reasons[reason] = (result.skip_reasons[reason] ?? 0) + 1;
      continue;
    }
    const nextTotal = result.total_size + size;
    if (nextTotal > config.max_total_size) {
      throw new Error(`超出总大小限制: 当前 ${nextTotal} 字节，限制 ${config.max_total_size} 字节`);
    }
    const relative = path.slice(srcBase.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
    const dest = join(destBase, relative);
    await mkdir(join(dest, '..'), { recursive: true });
    await copyFile(path, dest);
    if ((await stat(dest)).size !== size) throw new Error(`文件复制失败: ${path} -> ${dest}, 错误: 目标文件大小不匹配`);
    const checksum = config.compute_checksum ? await sha256ExactAsync(dest, size) : undefined;
    if (config.compute_checksum && await sha256ExactAsync(path, size) !== checksum) {
      throw new Error(`校验和错误: 资产复制前后内容不一致: ${path}`);
    }
    const originalPath = `${assetType}/${relative}`;
    const backupPath = `assets/${assetType}/${relative}`;
    result.files.push({
      asset_type: assetType, relative_path: backupPath, original_path: originalPath, size,
      ...(checksum === undefined ? {} : { checksum }),
      modified_at: linkMetadata.mtime.toISOString(), is_directory: false,
    });
    result.total_size = nextTotal;
    const stats = result.by_asset_type[assetType] ?? { file_count: 0, total_size: 0 };
    stats.file_count += 1; stats.total_size += size;
    result.by_asset_type[assetType] = stats;
  }
}

async function sha256ExactAsync(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedSize) throw new Error('资产文件在校验期间增长');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedSize) throw new Error(`资产文件在校验期间大小变化: expected=${expectedSize}, actual=${total}`);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function verifyAssets(backupDir: string, assets: readonly BackedUpAsset[]): Promise<AssetVerifyErrorResponse[]> {
  const errors: AssetVerifyErrorResponse[] = [];
  for (const asset of assets) {
    if (asset.is_directory) continue;
    let path: string;
    try { path = safeExistingFileUnderRoot(backupDir, asset.relative_path); }
    catch (e) {
      errors.push({ path: asset.relative_path, error_type: 'unsafe_path', message: ioMessage(e) });
      continue;
    }
    const metadata = await stat(path);
    if (metadata.size !== asset.size) {
      errors.push({
        path: asset.relative_path, error_type: 'size_mismatch',
        message: `文件大小不匹配: expected=${asset.size}, actual=${metadata.size}`,
      });
      continue;
    }
    if (asset.checksum) {
      const actual = await sha256ExactAsync(path, asset.size);
      if (actual !== asset.checksum) {
        errors.push({
          path: asset.relative_path, error_type: 'checksum_mismatch',
          message: `校验和不匹配: expected=${asset.checksum}, actual=${actual}`,
        });
      }
    }
  }
  return errors;
}

export function safeExistingFileUnderRoot(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new Error(`不安全的路径（绝对路径或目录穿越）: ${relative}`);
  }
  const rootReal = realpathSync(root);
  const path = joinPath(rootReal, normalized);
  const real = realpathSync(path);
  if (!isPathWithin(rootReal, real)) throw new Error(`路径越界: ${relative}`);
  return real;
}

// ------------------------------------------------------------------ 资产恢复（assets.rs:1042–1370）

export class AssetRestoreError extends Error {
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.name = 'AssetRestoreError';
    this.cancelled = cancelled;
  }
}

export function sanitizeRelativePath(pathText: string): string {
  const normalized = rustTrim(pathText).replace(/\\/g, '/');
  const hasDrivePrefix = normalized.length >= 3
    && normalized[1] === ':' && normalized[2] === '/'
    && /[A-Za-z]/.test(normalized[0]!);
  if (normalized === '' || normalized.startsWith('/') || normalized.startsWith('//')
    || hasDrivePrefix || normalized.includes('../') || normalized === '..') {
    throw new AssetRestoreError(`不安全的路径（绝对路径或目录穿越）: ${pathText}`);
  }
  return normalized;
}

async function prepareAssetDestination(root: string, unsafeRelativePath: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new AssetRestoreError(`资产恢复根路径必须是普通目录: ${root}`);
  }
  const normalized = sanitizeRelativePath(unsafeRelativePath);
  const components = normalized.split('/');
  let current = root;
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    if (component === '' || component === '.' || component === '..') {
      throw new AssetRestoreError(`不安全的资产目标路径: ${unsafeRelativePath}`);
    }
    current = joinPath(current, component);
    const isLast = index + 1 === components.length;
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AssetRestoreError(ioMessage(error));
      if (!isLast) await mkdir(current);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      throw new AssetRestoreError(`资产恢复目标不允许包含符号链接: ${unsafeRelativePath}`);
    }
    if (!isLast && !metadata.isDirectory()) {
      throw new AssetRestoreError(`资产恢复目标父路径不是目录: ${current}`);
    }
    if (isLast && !metadata.isFile()) {
      throw new AssetRestoreError(`资产恢复目标不是普通文件: ${current}`);
    }
  }
  return current;
}

async function copyFileWithRetry(source: string, destination: string): Promise<void> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await copyFile(source, destination);
      const sourceSize = (await stat(source)).size;
      const destinationSize = (await stat(destination)).size;
      if (sourceSize === destinationSize) return;
      lastError = `复制后大小不一致: ${source} -> ${destination}, expected=${sourceSize}, actual=${destinationSize}`;
    } catch (error) {
      lastError = `复制资产失败: ${source} -> ${destination}: ${ioMessage(error)}`;
    }
    try { await rm(destination, { force: true }); }
    catch (cleanupError) { // boundary-allow empty-catch: Rust 用 `let _ = fs::remove_file(dest)` 静默忽略半成品清理失败
      void cleanupError;
    }
  }
  throw new AssetRestoreError(`资产恢复失败: ${lastError ?? '复制资产失败（未知错误）'}`);
}

export function assetRequiresExplicitTrust(asset: BackedUpAsset): boolean {
  return persistentDomainRegistry().some(spec =>
    spec.restore_trust === 'untrusted_executable'
    && (pathIsAtOrBelow(asset.relative_path, spec.archive_root)
      || (spec.id === 'agents' && pathIsAtOrBelow(asset.relative_path, 'workspaces/agents'))
      || pathIsAtOrBelow(asset.original_path, spec.restore_target)));
}

export async function restoreAssets(
  backupDir: string,
  appDataDir: string,
  assets: readonly BackedUpAsset[],
): Promise<number> {
  let restored = 0;
  for (const asset of assets) {
    if (asset.is_directory) continue;
    const source = safeExistingFileUnderRoot(backupDir, asset.relative_path);
    const destination = await prepareAssetDestination(appDataDir, asset.original_path);
    await copyFileWithRetry(source, destination);
    restored += 1;
  }
  return restored;
}

export async function restoreAssetsWithProgress(
  backupDir: string,
  appDataDir: string,
  assets: readonly BackedUpAsset[],
  onProgress: (restored: number, total: number) => boolean,
): Promise<number> {
  const total = assets.filter(asset => !asset.is_directory && !assetRequiresExplicitTrust(asset)).length;
  let restored = 0;
  for (const asset of assets) {
    if (asset.is_directory || assetRequiresExplicitTrust(asset)) continue;
    // Rust assets.rs:1254-1268：源/目标路径失败分别报错。
    let source: string;
    try { source = safeExistingFileUnderRoot(backupDir, asset.relative_path); }
    catch { throw new AssetRestoreError('资产源路径非法'); }
    let destination: string;
    try { destination = await prepareAssetDestination(appDataDir, asset.original_path); }
    catch { throw new AssetRestoreError('资产目标路径非法'); }
    await copyFileWithRetry(source, destination);
    restored += 1;
    if (!onProgress(restored, total)) throw new AssetRestoreError('用户取消恢复（资产阶段）', true);
  }
  return restored;
}

async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  for (const name of await readdir(dir)) {
    const path = joinPath(dir, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new AssetRestoreError(`资产恢复源不允许符号链接: ${path}`);
    if (metadata.isDirectory()) count += await countFilesRecursive(path);
    else if (metadata.isFile()) count += 1;
    else throw new AssetRestoreError(`资产恢复源包含非常规条目: ${path}`);
  }
  return count;
}

async function copyDirRecursive(sourceDir: string, destinationDir: string): Promise<number> {
  await mkdir(destinationDir, { recursive: true });
  let count = 0;
  for (const name of await readdir(sourceDir)) {
    const source = joinPath(sourceDir, name);
    const destination = joinPath(destinationDir, name);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink()) throw new AssetRestoreError(`资产恢复源不允许符号链接: ${source}`);
    if (metadata.isDirectory()) count += await copyDirRecursive(source, destination);
    else if (metadata.isFile()) { await copyFileWithRetry(source, destination); count += 1; }
    else throw new AssetRestoreError(`资产恢复源包含非常规条目: ${source}`);
  }
  return count;
}

export async function restoreAssetsFromDir(assetsDir: string, appDataDir: string): Promise<number> {
  const rootMetadata = await lstat(assetsDir);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new AssetRestoreError(`资产恢复根必须是普通目录: ${assetsDir}`);
  }
  let restored = 0;
  for (const name of await readdir(assetsDir)) {
    const path = joinPath(assetsDir, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AssetRestoreError(`资产恢复根包含非目录条目: ${path}`);
    }
    restored += await copyDirRecursive(path, joinPath(appDataDir, name));
  }
  return restored;
}

export async function restoreAssetsFromDirWithProgress(
  assetsDir: string,
  appDataDir: string,
  onProgress: (restored: number, total: number) => boolean,
): Promise<number> {
  const rootMetadata = await lstat(assetsDir);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new AssetRestoreError(`资产恢复根必须是普通目录: ${assetsDir}`);
  }
  const total = await countFilesRecursive(assetsDir);
  let restored = 0;
  const visit = async (sourceDir: string, destinationDir: string): Promise<void> => {
    await mkdir(destinationDir, { recursive: true });
    for (const name of await readdir(sourceDir)) {
      const source = joinPath(sourceDir, name);
      const destination = joinPath(destinationDir, name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) throw new AssetRestoreError(`资产恢复源不允许符号链接: ${source}`);
      if (metadata.isDirectory()) await visit(source, destination);
      else if (metadata.isFile()) {
        await copyFileWithRetry(source, destination);
        restored += 1;
        if (!onProgress(restored, total)) throw new AssetRestoreError('用户取消恢复（资产阶段）', true);
      } else {
        throw new AssetRestoreError(`资产恢复源包含非常规条目: ${source}`);
      }
    }
  };
  for (const name of await readdir(assetsDir)) {
    const path = joinPath(assetsDir, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AssetRestoreError(`资产恢复根包含非目录条目: ${path}`);
    }
    await visit(path, joinPath(appDataDir, name));
  }
  return restored;
}
