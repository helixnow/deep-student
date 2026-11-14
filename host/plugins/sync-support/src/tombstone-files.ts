/** tombstone.rs：本地路径校验、文件删除计划、云端对象定位与保留策略。 */

import * as path from '../../../platform/util/path.ts';

import type { FilesService } from '../../../platform/files/api.ts';

import type { BlobTombstoneEntry, BlobTombstones, TombstoneStorage } from '../api.ts';

import { databaseError, ioError, networkError } from './errors.ts';

import { parseFlexibleTimestampMillis as parseFlexibleTimestamp } from '../../../platform/time/index.ts';

import {
  errorMessage,
  tombstoneDeletedAtUsable,
} from './tombstone-model.ts';

import type {
  TombstoneLogger,
} from './tombstone-model.ts';

/**
 * tombstone 的本地文件端口：元数据查询与删除都经这里异步完成，不在事件循环上做同步 I/O。
 * 插件里由 `ctx.files` 支撑（`filesTombstonePort`），桌面与移动端同一份实现。
 */
export interface TombstoneLocalFiles {
  /** 跟随符号链接的 mtime（毫秒）；不存在或读不到时 null。 */
  mtimeMs(target: string): Promise<number | null>;
  /** 不跟随符号链接；不存在或读不到时 null。 */
  lstat(target: string): Promise<{ readonly symlink: boolean; readonly directory: boolean } | null>;
  /** 目录项名，顺序同 `readdir`；错误原样抛出。 */
  readDir(target: string): Promise<string[]>;
  exists(target: string): Promise<boolean>;
  remove(target: string): Promise<void>;
}

export type TombstoneFilesService = Pick<FilesService, 'stat' | 'readDir' | 'exists' | 'rm'>;

/** `ctx.files` 支撑的端口；服务缺席时每个操作都抛错（`pathModifiedAfter` 按“无法判定”返回 false）。 */
export function filesTombstonePort(files: () => TombstoneFilesService | undefined): TombstoneLocalFiles {
  const service = (): TombstoneFilesService => {
    const current = files();
    if (current === undefined) throw new Error('files service unavailable');
    return current;
  };
  return {
    async mtimeMs(target) {
      try { return (await service().stat(target)).modifiedMs; } catch { return null; }
    },
    async lstat(target) {
      try {
        const stats = await service().stat(target, { followSymlinks: false });
        return { symlink: stats.kind === 'symlink', directory: stats.kind === 'directory' };
      } catch {
        return null;
      }
    },
    readDir: async target => (await service().readDir(target)).map(entry => entry.name),
    async exists(target) {
      try { return await service().exists(target); } catch { return false; }
    },
    remove: target => service().rm(target),
  };
}

/** 未注入文件端口时的占位：任何本地文件操作都失败，不会把“读不到”误当成“文件不存在”。 */
export const unavailableTombstoneLocalFiles: TombstoneLocalFiles = filesTombstonePort(() => undefined);

function modifiedAfter(mtimeMs: number | null, timestamp: string): boolean {
  if (mtimeMs === null) return false;
  const parsed = parseFlexibleTimestamp(timestamp);
  if (parsed === null) return false;
  return mtimeMs > parsed;
}

/** 本地文件 mtime 是否晚于 tombstone 时间戳（无法判定时 false）。 */
export async function pathModifiedAfter(files: TombstoneLocalFiles, filePath: string, timestamp: string): Promise<boolean> {
  return modifiedAfter(await files.mtimeMs(filePath), timestamp);
}

// ------------------------------------------------------------------ 本地应用

export async function applyBlobTombstones(
  storage: TombstoneStorage,
  tombstones: BlobTombstones,
  blobsDir: string,
  blobsCloudPrefix: string,
  deleteCloud: boolean,
  logger: TombstoneLogger,
  files: TombstoneLocalFiles,
): Promise<string[]> {
  const affected: string[] = [];
  interface Plan { hash: string; entry: BlobTombstoneEntry; localPath: string | null }
  const plan: Plan[] = [];
  for (const [hash, entry] of Object.entries(tombstones.entries)) {
    if (!/^[0-9a-f]{64}$/iu.test(hash) || hash.length !== 64) {
      databaseError(`拒绝非法 blob tombstone hash: ${JSON.stringify(hash)}`);
    }
    if (!tombstoneDeletedAtUsable(entry.deleted_at, `blob/${hash}`, logger)) continue;
    const localPath = entry.relative_path !== null && entry.relative_path !== undefined
      ? await validateBlobRelativePathWith(files, blobsDir, hash, entry.relative_path)
      : await findBlobByHashWith(files, blobsDir, hash);
    plan.push({ hash, entry, localPath });
  }

  for (const { hash, entry, localPath } of plan) {
    if (localPath !== null && modifiedAfter(await files.mtimeMs(localPath), entry.deleted_at)) {
      logger.info(`[sync] 跳过过期 blob tombstone，本地文件更新: ${hash} deleted_at=${entry.deleted_at}`);
      continue;
    }
    if (localPath !== null && await files.exists(localPath)) {
      try {
        await files.remove(localPath);
      } catch (error) {
        ioError(error);
      }
    }

    if (!deleteCloud) {
      affected.push(hash);
      continue;
    }

    if (entry.relative_path !== null && entry.relative_path !== undefined) {
      const key = `${blobsCloudPrefix}/${entry.relative_path}`;
      await deleteCloudBlob(storage, key);
    } else if (localPath !== null) {
      const relative = path.relative(blobsDir, localPath);
      if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const key = `${blobsCloudPrefix}/${relative.split(path.sep).join('/')}`;
        await deleteCloudBlob(storage, key);
      } else {
        logger.warn(`[sync] tombstone ${hash} 无 relative_path 且本地未找到，跳过云端删除`);
      }
    } else {
      const key = await findCloudBlobKeyByHash(storage, blobsCloudPrefix, hash);
      if (key === null) {
        logger.warn(`[sync] tombstone ${hash} 无 relative_path 且云端未找到匹配对象，跳过云端删除`);
      } else {
        await deleteCloudBlob(storage, key);
      }
    }
    affected.push(hash);
  }
  return affected;
}

async function deleteCloudBlob(storage: TombstoneStorage, key: string): Promise<void> {
  try {
    await storage.delete(key);
  } catch (error) {
    networkError(`删除云端 blob 失败 ${key}: ${errorMessage(error)}`);
  }
}

/** `relative_path` 的形状校验（`<hash[0..2]>/<hash>.<ext>`），返回桶目录与目标文件路径。 */
function blobTargetPaths(blobsDir: string, hash: string, relativePath: string): { bucketPath: string; target: string } {
  const separators = path.sep === '\\' ? /[\\/]/u : /\//u;
  const components = relativePath.split(separators);
  const normal = (value: string): boolean => value !== '' && value !== '.' && value !== '..';
  if (components.length !== 2 || !components.every(normal)) {
    databaseError(`拒绝不安全的 blob tombstone 相对路径: ${JSON.stringify(relativePath)}`);
  }
  const [bucket, fileName] = components as [string, string];
  if (isAbsoluteLike(relativePath) || bucket !== hash.slice(0, 2) || path.parse(fileName).name !== hash) {
    databaseError(`blob tombstone 路径与内容 hash 不匹配: ${JSON.stringify(relativePath)}`);
  }

  const bucketPath = path.join(blobsDir, bucket);
  return { bucketPath, target: path.join(bucketPath, fileName) };
}

/** 验证 `relative_path` 是 `<hash[0..2]>/<hash>.<ext>`，且目标不是符号链接。 */
export async function validateBlobRelativePathWith(
  files: TombstoneLocalFiles, blobsDir: string, hash: string, relativePath: string,
): Promise<string> {
  const { bucketPath, target } = blobTargetPaths(blobsDir, hash, relativePath);
  if ((await files.lstat(bucketPath))?.symlink === true) {
    databaseError(`blob tombstone 目标桶不能是符号链接: ${bucketPath}`);
  }
  if ((await files.lstat(target))?.symlink === true) {
    databaseError(`blob tombstone 目标不能是符号链接: ${target}`);
  }
  return target;
}

function isAbsoluteLike(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:/u.test(value);
}

function blobBucket(blobsDir: string, hash: string): string | null {
  if (hash.length !== 64 || !/^[0-9a-f]{64}$/iu.test(hash)) return null;
  return path.join(blobsDir, hash.slice(0, 2));
}

/** 按 hash 在 `blobsDir/<hash[0..2]>/` 下按 stem 找文件（保留真实扩展名）。 */
export async function findBlobByHashWith(files: TombstoneLocalFiles, blobsDir: string, hash: string): Promise<string | null> {
  const bucket = blobBucket(blobsDir, hash);
  if (bucket === null) return null;
  const stats = await files.lstat(bucket);
  if (stats === null || stats.symlink || !stats.directory) return null;
  for (const name of await files.readDir(bucket)) {
    if (path.parse(name).name === hash) return path.join(bucket, name);
  }
  return null;
}

async function findCloudBlobKeyByHash(
  storage: TombstoneStorage,
  blobsCloudPrefix: string,
  hash: string,
): Promise<string | null> {
  if (hash.length < 2) return null;
  const bucket = `${blobsCloudPrefix.replace(/\/+$/u, '')}/${hash.slice(0, 2)}`;
  let outcome;
  try {
    outcome = await storage.list_outcome(bucket);
  } catch (error) {
    return networkError(`列举云端 blob 桶失败 ${bucket}: ${errorMessage(error)}`);
  }
  if (outcome.truncated) networkError(`云端 blob 桶列表被截断，拒绝确认 tombstone: ${bucket}`);
  for (const file of outcome.files) {
    if (path.parse(file.key).name === hash) return file.key;
  }
  return null;
}

/** 权威 replace 快照上线前不按时间裁剪（离线设备仍需要删除记录）。 */
export function pruneTombstones<T>(
  _entries: Map<string, T>,
  _retentionDays: number,
  _extractDeletedAt: (entry: T) => string,
): number {
  return 0;
}
