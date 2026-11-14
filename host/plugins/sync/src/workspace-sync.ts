/** Full workspace file synchronization, sync/mod.rs:10631-11072. */
import { fs } from '../src/local-runtime.ts';
import { basename, dirname, join } from '../../../platform/util/path.ts';
import type { StorageService } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { adaptTombstoneStorage, type SyncStateStore } from '../../sync-support/api.ts';
import { calculateFileHash, isCloudRateLimited, type CloudStorage } from '../../sync-providers/api.ts';
import { createWorkspaceSnapshot, checkpointWorkspace, verifyWorkspaceIntegrity } from '../repository/workspace-files.ts';
import type { FilePayloadCodec } from './payload.ts';
import type { SyncLogger } from './log.ts';
import { SyncError } from './errors.ts';
import { dbJsonEquals } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps } from './lww.ts';
import { ensureRemoteInstanceId } from './manifest-upload.ts';
import { encryptUploadObject, downloadFileObject, putFileAndVerifySize, ensureFileUploadEncryptionPolicy } from './file-transfer.ts';
import {
  downloadWorkspacesManifest, publishWorkspaceManifest, timestampAfter, WORKSPACE_OBJECT_PREFIX,
  type WorkspaceManifest, type WorkspaceManifestOptions,
} from './workspace-manifest.ts';

export interface WorkspaceSyncOptions extends WorkspaceManifestOptions {
  codec: FilePayloadCodec;
  localStorage: StorageService;
  openState(): SyncStateStore;
  isCancelled(): boolean;
  logger: SyncLogger;
}
export type FileTransferProgress = (item: string, done: number, total: number) => void;
export type FileSyncDirection = 'Upload' | 'Download' | 'Bidirectional';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const database = (text: string) => new SyncError(`Database error: ${text}`);
const increment = (value: bigint) => value === 18446744073709551615n ? value : value + 1n;

function discard(path: string): void {
  try { fs.rmSync(path, { force: true }); }
  catch { // boundary-allow empty-catch: mod.rs:10811,10830,10882,10889,10957,10961 explicitly ignores removal failures.
  }
}
export function validateWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id) || utf8ByteLength(id) > 255) throw database(`拒绝非法 workspace 文件 ID: ${JSON.stringify(id)}`);
}
export function validateRemoteObjectKey(key: string, prefix: string): void {
  const parts = key.split('/');
  if (key === '' || utf8ByteLength(key) > 2048 || key.includes('\\') || key.includes('//') ||
      !key.startsWith(`${prefix.replace(/^\/+|\/+$/gu, '')}/`) || parts[0] === '.' || parts.includes('..')) {
    throw database(`拒绝越界或非法的云端对象 key: ${JSON.stringify(key)}`);
  }
}
export function localFileWins(localTime: string, cloudTime: string, localHash: string, cloudHash: string): boolean {
  return rustTrim(cloudTime) === '' || compareLwwTimestamps(localTime, '', localHash, cloudTime, '', cloudHash) > 0;
}
function modified(path: string): string {
  try { return toRfc3339(fs.statBigSync(path).mtimeNs); }
  catch { return toRfc3339(); }
}
function fileSize(path: string, fallback: bigint): bigint {
  try { return fs.statBigSync(path).size; }
  catch { return fallback; }
}
export function saveConflictCopy(path: string, deviceId: string): void {
  if (!fs.existsSync(path)) return;
  const stamp = toRfc3339Opts(nowEpochNanos(), 'Millis', true).replace(/[-:TZ.]/gu, '');
  const dest = join(dirname(path), `${basename(path) || 'file'}.conflict-${deviceId}-${stamp}`);
  try { fs.copyFileSync(path, dest); }
  catch (error) { throw database(`保存冲突副本失败 ${JSON.stringify(dest)}: ${ioMessage(error)}`); }
}
function copyManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return { updated_at: manifest.updated_at, entries: new Map([...manifest.entries].map(([id, entry]) => [id, { ...entry }])) };
}

export async function syncWorkspaceDatabases(
  cloud: CloudStorage, activeDir: string, direction: FileSyncDirection, options: WorkspaceSyncOptions,
  progress?: FileTransferProgress | null,
): Promise<void> {
  const { codec, logger, localStorage, tombstones } = options;
  const root = join(activeDir, 'workspaces');
  const manifest = await downloadWorkspacesManifest(cloud, options);
  const instance = await ensureRemoteInstanceId(cloud, options, options.openState);
  const state = options.openState();
  const [deleted, advances] = await tombstones.downloadWorkspaceTombstonesAfter(adaptTombstoneStorage(cloud), codec,
    device => state.getTombstoneWatermark(instance, device, 'workspaces'));
  for (const [id, entry] of Object.entries(deleted.entries)) {
    validateWorkspaceId(id); tombstones.validateTombstoneTimestamp(entry.deleted_at, `workspace/${id}`);
  }
  let changed = false;
  for (const [id, entry] of Object.entries(deleted.entries)) {
    const path = join(root, `${id}.db`); const remote = manifest.entries.get(id);
    if (remote && timestampAfter(remote.updated_at, entry.deleted_at)) {
      logger.info(`[sync] 跳过过期 workspace tombstone，云端数据库更新: ${id} cloud_updated_at>${entry.deleted_at}`); continue;
    }
    if (await tombstones.pathModifiedAfter(path, entry.deleted_at)) {
      logger.info(`[sync] 跳过过期 workspace tombstone，本地数据库更新: ${id} deleted_at=${entry.deleted_at}`); continue;
    }
    if (direction !== 'Download') {
      const key = remote?.object_key ?? `${WORKSPACE_OBJECT_PREFIX}/${id}.db`;
      validateRemoteObjectKey(key, WORKSPACE_OBJECT_PREFIX);
      try { await cloud.delete(key); }
      catch (error) { throw new SyncError(`Network error: 删除云端工作区数据库失败 ${key}: ${message(error)}`); }
    }
    if (fs.existsSync(path)) {
      saveConflictCopy(path, options.deviceId);
      try { fs.rmSync(path); } catch (error) { throw new SyncError(`IO error: ${ioMessage(error)}`); }
    }
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(path + suffix)) {
      try { fs.rmSync(path + suffix); } catch (error) { throw new SyncError(`IO error: ${ioMessage(error)}`); }
    }
    if (manifest.entries.delete(id)) changed = true;
  }
  if (direction !== 'Download' && changed) {
    manifest.updated_at = toRfc3339(); await publishWorkspaceManifest(cloud, manifest, options);
  }
  for (const advance of advances) state.setTombstoneWatermark(instance, advance.source_device_id, 'workspaces', advance.last_applied_offset);

  const local = new Map<string, { path: string; sha256: string; size: bigint; updated_at: string }>();
  if (fs.existsSync(root)) {
    let files;
    try { files = fs.readdirSync(root); }
    catch (error) { throw database(`读取工作区目录失败: ${ioMessage(error)}`); }
    for (const name of files) {
      if (!name.startsWith('ws_') || !name.endsWith('.db')) continue;
      const id = name.replace(/(?:\.db)+$/u, ''); const path = join(root, name);
      checkpointWorkspace(localStorage, path);
      let sha256;
      try { sha256 = await calculateFileHash(path); }
      catch (error) { throw database(`计算工作区数据库校验和失败 ${JSON.stringify(path)}: ${message(error)}`); }
      local.set(id, { path, sha256, size: fileSize(path, 0n), updated_at: modified(path) });
    }
  }
  const next = copyManifest(manifest); const failures: string[] = [];
  if (direction !== 'Download') {
    await ensureFileUploadEncryptionPolicy(cloud, codec.encrypted);
    for (const [id, entry] of local) {
      const remote = manifest.entries.get(id);
      const unchanged = remote && (remote.source_sha256 === entry.sha256 || remote.sha256 === entry.sha256);
      const shouldUpload = !remote || (unchanged && codec.encrypted && remote.cipher_sha256 === null) ||
        (!unchanged && localFileWins(entry.updated_at, remote.updated_at, entry.sha256, remote.source_sha256 ?? remote.sha256));
      if (!shouldUpload) continue;
      let snapshot;
      try { snapshot = createWorkspaceSnapshot(localStorage, entry.path, id); }
      catch (error) { logger.warn(`[sync] 工作区数据库快照失败: ${id}: ${message(error)}`); failures.push(`${id}: ${message(error)}`); continue; }
      try {
        let sha256;
        try { sha256 = await calculateFileHash(snapshot); }
        catch (error) { failures.push(`${id}: ${message(error)}`); continue; }
        const size = fileSize(snapshot, entry.size); const key = `${WORKSPACE_OBJECT_PREFIX}/${id}/${sha256}.db`;
        let encrypted;
        try { encrypted = await encryptUploadObject(snapshot, codec); }
        catch (error) { logger.warn(`[sync] 工作区数据库加密失败: ${id}: ${message(error)}`); failures.push(`${id}: ${message(error)}`); continue; }
        try {
          await putFileAndVerifySize(cloud, key, encrypted?.path ?? snapshot, encrypted?.size ?? size,
            progress ? (done, total) => progress(`工作区数据库 ${id}`, done, total) : null, '工作区数据库', options.isCancelled, logger);
          next.entries.set(id, {
            sha256, size, updated_at: entry.updated_at, source_sha256: entry.sha256, device_id: options.deviceId,
            object_key: key, base_sha256: remote ? remote.source_sha256 ?? remote.sha256 : null,
            revision: remote ? increment(remote.revision) : 1n,
            cipher_sha256: encrypted?.sha256 ?? null, cipher_size: encrypted?.size ?? null,
          });
          logger.info(`[sync] 工作区数据库已上传: ${id}`);
        } catch (error) {
          if (isCloudRateLimited(message(error))) throw error;
          logger.warn(`[sync] 工作区数据库上传失败（跳过）: ${id}: ${message(error)}`); failures.push(`${id}: ${message(error)}`);
        } finally { await encrypted?.dispose(); }
      } finally { discard(snapshot); }
    }
  }
  if (direction !== 'Upload') {
    if (!fs.existsSync(root)) {
      try { fs.mkdirSync(root, { recursive: true }); }
      catch { // boundary-allow empty-catch: mod.rs:10897 ignores create_dir_all failure; download reports the actual write error.
      }
    }
    for (const [id, entry] of manifest.entries) {
      validateWorkspaceId(id);
      const current = local.get(id);
      const unchanged = current && (current.sha256 === entry.source_sha256 || current.sha256 === entry.sha256);
      if (current && (unchanged || localFileWins(current.updated_at, entry.updated_at, current.sha256, entry.source_sha256 ?? entry.sha256))) continue;
      const dest = join(root, `${id}.db`);
      if (fs.existsSync(dest)) {
        try { saveConflictCopy(dest, options.deviceId); }
        catch (error) { logger.warn(`[sync] 保存工作区数据库冲突副本失败: ${id}: ${message(error)}`); }
      }
      const key = entry.object_key ?? `${WORKSPACE_OBJECT_PREFIX}/${id}.db`;
      validateRemoteObjectKey(key, WORKSPACE_OBJECT_PREFIX);
      try {
        await downloadFileObject(cloud, key, dest, entry.sha256, entry.cipher_sha256, codec, options.isCancelled,
          progress ? (done, total) => progress(`工作区数据库 ${id}`, done, total) : null, `工作区数据库 ${id}`);
      } catch (error) {
        if (isCloudRateLimited(message(error))) throw error;
        logger.warn(`[sync] 工作区数据库下载失败（跳过）: ${id}: ${message(error)}`); failures.push(`${id}: ${message(error)}`); continue;
      }
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dest + suffix)) discard(dest + suffix);
      try { verifyWorkspaceIntegrity(localStorage, dest); }
      catch (error) {
        discard(dest); logger.warn(`[sync] 工作区数据库完整性检查失败（已删除）: ${id}: ${message(error)}`);
        failures.push(`${id}: ${message(error)}`); continue;
      }
      logger.info(`[sync] 工作区数据库已下载: ${id}`);
    }
  }
  const entriesEqual = next.entries.size === manifest.entries.size && [...next.entries].every(([id, entry]) => dbJsonEquals({ ...entry }, manifest.entries.has(id) ? { ...manifest.entries.get(id)! } : undefined));
  if (direction !== 'Download' && !entriesEqual) {
    let merged;
    try { merged = await downloadWorkspacesManifest(cloud, options); }
    catch (error) {
      if (isCloudRateLimited(message(error))) throw error;
      logger.warn(`[sync] 写前刷新工作区清单失败，退回本地视图: ${message(error)}`); merged = copyManifest(manifest);
    }
    for (const [id, entry] of next.entries) {
      if (dbJsonEquals({ ...entry }, manifest.entries.has(id) ? { ...manifest.entries.get(id)! } : undefined)) continue;
      const theirs = merged.entries.get(id);
      if (theirs) {
        if (entry.base_sha256 !== (theirs.source_sha256 ?? theirs.sha256) || (theirs.revision !== 0n && entry.revision !== increment(theirs.revision))) {
          const file = local.get(id); if (file) saveConflictCopy(file.path, options.deviceId);
          failures.push(`${id}: 云端 base hash/revision 已变化，本地版本保留为冲突副本`); continue;
        }
      } else if (entry.base_sha256 !== null) {
        const file = local.get(id); if (file) saveConflictCopy(file.path, options.deviceId);
        failures.push(`${id}: 云端基线已被删除，本地版本保留为冲突副本`); continue;
      }
      const theirsNewer = theirs && localFileWins(theirs.updated_at, entry.updated_at, theirs.sha256, entry.sha256);
      const upgradesEncryption = entry.cipher_sha256 !== null && theirs?.cipher_sha256 === null;
      if (!theirsNewer || upgradesEncryption) merged.entries.set(id, { ...entry });
    }
    for (const id of manifest.entries.keys()) if (!next.entries.has(id)) merged.entries.delete(id);
    merged.updated_at = toRfc3339(); await publishWorkspaceManifest(cloud, merged, options);
  }
  if (failures.length) throw new SyncError(`Network error: 工作区数据库同步部分失败: ${failures.join('; ')}`);
}
