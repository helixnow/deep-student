import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { rustTrim } from '../../../platform/util/portable.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage, utcNow } from './io.ts';
import {
  MANIFEST_VERSION, MAX_MANIFEST_BYTES, newCoverageLedger, parseManifest, validateForSlotRestore, validateSafeRelativePath,
  validateUntrusted, type BackupManifest,
} from './manifest-model.ts';

export * from './manifest-model.ts';

export function generateBackupId(suffix?: string | null, now = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const timestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand8 = randomUUID().replace(/-/g, '').slice(0, 8);
  const millis = pad(now.getUTCMilliseconds(), 3);
  const trimmedSuffix = suffix == null ? null : rustTrim(suffix);
  return trimmedSuffix ? `${timestamp}_${rand8}_${millis}_${trimmedSuffix}` : `${timestamp}_${rand8}_${millis}`;
}

export function newManifest(appVersion: string): BackupManifest {
  return {
    version: MANIFEST_VERSION,
    app_version: appVersion,
    created_at: toRfc3339(),
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    schema_versions: {},
    files: [],
    is_incremental: false,
    incremental_base: null,
    backup_id: generateBackupId(),
    snapshot_kind: 'partial_overlay',
    snapshot_epoch: randomUUID(),
    required_components: [],
    included_components: [],
    key_policy: 'not_present',
    coverage: newCoverageLedger(),
  };
}

export function loadManifest(path: string): BackupManifest {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('清单必须是普通文件，不能是目录或符号链接');
  }
  if (metadata.size > MAX_MANIFEST_BYTES) throw new Error(`清单文件过大: ${metadata.size} > ${MAX_MANIFEST_BYTES} bytes`);
  const manifest = parseManifest(JSON.parse(readFileSync(path, 'utf8')));
  validateUntrusted(manifest);
  if (manifest.snapshot_kind === 'full') validateForSlotRestore(manifest);
  return manifest;
}

export function saveManifest(
  path: string,
  manifest: BackupManifest,
  logger?: { warn(message: string): void },
): void {
  const json = JSON.stringify(manifest, null, 2);
  const temp = path.replace(/\.json$/, '.json.tmp');
  try {
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, json);
      // backup/mod.rs:1625：先 sync_all 再改名，断电后不会留下已改名但内容为空的清单。
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (e) {
    try { unlinkSync(temp); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn(`清理临时清单文件失败 ${temp}: ${ioMessage(cleanupError)}`);
      }
    }
    throw new Error(ioMessage(e));
  }
}

/** `calculate_file_sha256_exact`。 */
export function sha256File(path: string, expectedSize: number): string {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(8192);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > expectedSize) throw new Error('文件在校验期间增长');
      hash.update(buffer.subarray(0, read));
    }
    if (total !== expectedSize) throw new Error(`文件在校验期间大小变化: expected=${expectedSize}, actual=${total}`);
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function sha256FileFull(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const HASH_CHUNK_BYTES = 1 << 20;

/** {@link sha256File} 的异步版本：备份/导入热路径用，不阻塞 Host 事件循环。 */
export async function sha256FileAsync(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedSize) throw new Error('文件在校验期间增长');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedSize) throw new Error(`文件在校验期间大小变化: expected=${expectedSize}, actual=${total}`);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/** {@link sha256FileFull} 的异步流式版本。 */
export async function sha256FileFullAsync(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export function manifestDir(backupRoot: string, backupId: string): string {
  return join(backupRoot, backupId);
}

export function isSafeExistingRelative(backupRoot: string, relative: string): string {
  validateSafeRelativePath(relative);
  const rootStat = lstatSync(backupRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`备份根路径必须是普通目录: ${backupRoot}`);
  let resolved = backupRoot;
  const components = relative.split('/');
  for (let index = 0; index < components.length; index++) {
    resolved = join(resolved, components[index]!);
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`备份路径不允许符号链接: ${resolved}`);
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error(`备份路径包含非目录组件: ${resolved}`);
  }
  return resolved;
}

export function utcManifestNow(): string { return utcNow(); }
