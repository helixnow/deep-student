/** File deletion application and watermark ordering, mod.rs:12654-12945. */
import { fs } from '../src/local-runtime.ts';
import type { StorageService } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339, parseFlexibleTimestamp } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { calculateFileHash, type CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage, type SyncStateStore } from '../../sync-support/api.ts';
import { blobHashesWithLocalRefs } from '../repository/blob-file-refs.ts';
import { syncVfsBlobs, downloadBlobsManifest, publishBlobManifest, type BlobSyncOptions } from './blob-sync.ts';
import { syncAssetDirectories } from './asset-sync.ts';
import { assetLocalPath } from './asset-paths.ts';
import { isSyncedAssetKey } from './asset-filenames.ts';
import { downloadAssetsManifest, publishAssetManifest, validateAssetObjectKey, isContentAddressedAssetObject, ASSET_LEGACY_PREFIX, type AssetSyncOptions } from './asset-manifest.ts';
import { isPortableAssetEnabled } from './portable-assets.ts';
import { timestampAfter } from './workspace-manifest.ts';
import { saveConflictCopy, type FileSyncDirection, type FileTransferProgress } from './workspace-sync.ts';
import { ensureRemoteInstanceId } from './manifest-upload.ts';
import type { AsyncAssetTombstones, AsyncBlobTombstones } from './tombstone-needs.ts';
import { SyncError } from './errors.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface BlobTombstoneSyncOptions extends BlobSyncOptions {
  tombstones: AsyncBlobTombstones;
  localStorage: StorageService;
  openState(): SyncStateStore;
}
export interface AssetTombstoneSyncOptions extends AssetSyncOptions {
  tombstones: AsyncAssetTombstones;
  openState(): SyncStateStore;
}
export async function syncBlobsWithTombstones(storage: CloudStorage, root: string, direction: FileSyncDirection, options: BlobTombstoneSyncOptions, progress?: FileTransferProgress | null) {
  const instance = await ensureRemoteInstanceId(storage, options, options.openState), state = options.openState();
  const cloud = await downloadBlobsManifest(storage, options);
  const remote = adaptTombstoneStorage(storage), { tombstones, codec, logger } = options;
  const [deleted, advances] = await tombstones.downloadBlobTombstonesAfter(remote, codec, device => state.getTombstoneWatermark(instance, device, 'blobs'));
  for (const [hash, entry] of Object.entries(deleted.entries)) tombstones.validateTombstoneTimestamp(entry.deleted_at, `blob/${hash}`);
  const excluded = new Set<string>(), resurrection = new Map<string, string>();
  if (Object.keys(deleted.entries).length > 0) {
    const referenced = blobHashesWithLocalRefs(options.localStorage, root, Object.keys(deleted.entries), logger);
    const effective = structuredClone(deleted);
    for (const [hash, entry] of Object.entries(effective.entries)) {
      if (referenced.has(hash)) {
        const now = nowEpochNanos(), parsed = parseFlexibleTimestamp(entry.deleted_at);
        const after = parsed === null ? now : parsed.epochNanos + 1_000_000n;
        resurrection.set(hash, toRfc3339(after > now ? after : now));
        logger.warn(`[sync] 拒绝消费 blob tombstone（本地仍有引用，blob 将在上传阶段复活）: ${hash} deleted_at=${entry.deleted_at}`);
        delete effective.entries[hash]; continue;
      }
      const current = cloud.entries.get(hash);
      if (current && timestampAfter(rustTrim(current.updated_at) === '' ? cloud.updated_at : current.updated_at, entry.deleted_at)) {
        logger.info(`[sync] 跳过过期 blob tombstone，云端清单更新: ${hash} cloud_manifest_updated_at>${entry.deleted_at}`);
        delete effective.entries[hash];
      }
    }
    const applied = await tombstones.applyBlobTombstones(remote, effective, root, 'data_governance/blobs', direction !== 'Download');
    for (const hash of applied) excluded.add(hash);
    if (direction !== 'Download') {
      const before = cloud.entries.size;
      for (const hash of applied) cloud.entries.delete(hash);
      if (cloud.entries.size !== before) { cloud.updated_at = toRfc3339(); await publishBlobManifest(storage, cloud, options); }
    }
  }
  for (const advance of advances) state.setTombstoneWatermark(instance, advance.source_device_id, 'blobs', advance.last_applied_offset);
  return syncVfsBlobs(storage, root, direction, options, progress, excluded, resurrection);
}
export async function syncAssetsWithTombstones(storage: CloudStorage, active: string, app: string, direction: FileSyncDirection, options: AssetTombstoneSyncOptions, progress?: FileTransferProgress | null) {
  const instance = await ensureRemoteInstanceId(storage, options, options.openState), state = options.openState();
  const cloud = await downloadAssetsManifest(storage, options, false);
  const remote = adaptTombstoneStorage(storage), { tombstones, codec, logger } = options;
  const [deleted, advances] = await tombstones.downloadAssetTombstonesAfter(remote, codec, device => state.getTombstoneWatermark(instance, device, 'assets'));
  for (const [key, entry] of Object.entries(deleted.entries)) tombstones.validateTombstoneTimestamp(entry.deleted_at, `asset/${key}`);
  const excluded = new Set<string>();
  if (Object.keys(deleted.entries).length > 0) {
    const applied: string[] = [];
    for (const [key, entry] of Object.entries(deleted.entries)) {
      // RUST-FIX(RF-W32-asset-top-allowlist): Rust applies tombstones for any key (mod.rs:12834); a future deleted_at then removes e.g. active/databases/vfs.db.
      if (!isSyncedAssetKey(key)) { logger.warn(`[sync] 跳过同步资产目录之外的 asset tombstone: ${JSON.stringify(key)}`); continue; }
      if (!isPortableAssetEnabled(key, options)) continue;
      if (options.mobile && key.startsWith('app_data/plugins/')) continue;
      const current = cloud.entries.get(key);
      if (current && timestampAfter(current.updated_at, entry.deleted_at)) {
        logger.info(`[sync] 跳过过期 asset tombstone，云端文件更新: ${key} cloud_updated_at>${entry.deleted_at}`); continue;
      }
      const path = assetLocalPath(active, app, key);
      if (path !== null && await tombstones.pathModifiedAfter(path, entry.deleted_at)) {
        logger.info(`[sync] 跳过过期 asset tombstone，本地文件更新: ${key} deleted_at=${entry.deleted_at}`); continue;
      }
      applied.push(key);
    }
    const live = { entries: new Map(cloud.entries), updated_at: cloud.updated_at };
    for (const key of applied) live.entries.delete(key);
    const deletedKeys = new Set<string>();
    for (const key of applied) {
      if (direction !== 'Download') {
        const object = cloud.entries.get(key)?.object_key ?? `${ASSET_LEGACY_PREFIX}/${key}`; validateAssetObjectKey(object);
        const shared = isContentAddressedAssetObject(object) && [...live.entries.values()].some(entry => entry.object_key === object);
        if (shared) logger.info(`[sync] 资产 tombstone 后仍有活跃引用，保留共享对象: ${key} -> ${object}`);
        else if (!deletedKeys.has(object)) {
          deletedKeys.add(object);
          try { await storage.delete(object); }
          catch (error) { throw new SyncError(`Network error: 删除云端资产失败 ${object}: ${message(error)}`); }
        }
      }
      const local = assetLocalPath(active, app, key);
      if (local !== null && fs.existsSync(local)) {
        const baseline = cloud.entries.get(key)?.sha256;
        let matches = false;
        if (baseline !== undefined) {
          try { matches = (await calculateFileHash(local)).toLowerCase() === baseline.toLowerCase(); }
          catch { matches = false; }
        }
        if (!matches) saveConflictCopy(local, options.deviceId);
        try { fs.rmSync(local); }
        catch (error) { throw new SyncError(`IO error: ${ioMessage(error)}`); }
      }
    }
    for (const key of applied) excluded.add(key);
    if (direction !== 'Download' && live.entries.size !== cloud.entries.size) {
      live.updated_at = toRfc3339(); await publishAssetManifest(storage, live, options);
    }
  }
  for (const advance of advances) state.setTombstoneWatermark(instance, advance.source_device_id, 'assets', advance.last_applied_offset);
  return syncAssetDirectories(storage, active, app, direction, options, progress, excluded);
}
