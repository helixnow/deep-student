/** Tombstone publication orchestration, mod.rs:12397-12570. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage } from '../../sync-support/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { AsyncTombstoneWriter } from './tombstone-needs.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';

export interface DeletionOptions extends ValidateRemoteFormatOptions { tombstones: AsyncTombstoneWriter }
type BlobDeletion = [hash: string, path: string | null, size: bigint | null, deletedAt: string];
type AssetDeletion = [key: string, size: bigint | null, deletedAt: string];
type WorkspaceDeletion = [id: string, deletedAt: string];
function prune<T extends { deleted_at: string }>(entries: Record<string, T>, tombstones: AsyncTombstoneWriter): Record<string, T> {
  const map = new Map(Object.entries(entries));
  tombstones.pruneTombstones(map, tombstones.DEFAULT_TOMBSTONE_RETENTION_DAYS, entry => entry.deleted_at);
  return Object.fromEntries(map);
}
async function publishBlobDeletions(storage: CloudStorage, entries: () => readonly BlobDeletion[], options: DeletionOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  const remote = adaptTombstoneStorage(storage), { codec, deviceId, tombstones } = options;
  const manifest = await tombstones.downloadBlobTombstonesForDevice(remote, codec, deviceId);
  for (const [hash, relative_path, size, deleted_at] of entries()) manifest.entries[hash] = { deleted_at, device_id: deviceId, size, relative_path };
  manifest.entries = prune(manifest.entries, tombstones);
  await tombstones.uploadBlobTombstones(remote, codec, deviceId, manifest);
}
export async function markBlobDeleted(storage: CloudStorage, hash: string, path: string | null, size: bigint | null, options: DeletionOptions): Promise<void> {
  await publishBlobDeletions(storage, () => [[hash, path, size, toRfc3339()]], options);
}
export async function markBlobDeletions(storage: CloudStorage, entries: readonly BlobDeletion[], options: DeletionOptions): Promise<void> {
  if (entries.length === 0) return;
  await publishBlobDeletions(storage, () => entries, options);
}
async function publishAssetDeletions(storage: CloudStorage, entries: () => readonly AssetDeletion[], options: DeletionOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  const remote = adaptTombstoneStorage(storage), { codec, deviceId, tombstones } = options;
  const manifest = await tombstones.downloadAssetTombstonesForDevice(remote, codec, deviceId);
  for (const [key, size, deleted_at] of entries()) manifest.entries[key] = { deleted_at, device_id: deviceId, size };
  manifest.entries = prune(manifest.entries, tombstones);
  await tombstones.uploadAssetTombstones(remote, codec, deviceId, manifest);
}
export async function markAssetDeleted(storage: CloudStorage, key: string, size: bigint | null, options: DeletionOptions): Promise<void> {
  await publishAssetDeletions(storage, () => [[key, size, toRfc3339()]], options);
}
export async function markAssetDeletions(storage: CloudStorage, entries: readonly AssetDeletion[], options: DeletionOptions): Promise<void> {
  if (entries.length === 0) return;
  await publishAssetDeletions(storage, () => entries, options);
}
async function publishWorkspaceDeletions(storage: CloudStorage, entries: () => readonly WorkspaceDeletion[], options: DeletionOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  const remote = adaptTombstoneStorage(storage), { codec, deviceId, tombstones } = options;
  const manifest = await tombstones.downloadWorkspaceTombstonesForDevice(remote, codec, deviceId);
  for (const [id, deleted_at] of entries()) manifest.entries[id.startsWith('ws_') ? id : `ws_${id}`] = { deleted_at, device_id: deviceId };
  manifest.entries = prune(manifest.entries, tombstones);
  await tombstones.uploadWorkspaceTombstones(remote, codec, deviceId, manifest);
}
export async function markWorkspaceDeleted(storage: CloudStorage, id: string, options: DeletionOptions): Promise<void> {
  await publishWorkspaceDeletions(storage, () => [[id, toRfc3339()]], options);
}
export async function markWorkspaceDeletions(storage: CloudStorage, entries: readonly WorkspaceDeletion[], options: DeletionOptions): Promise<void> {
  if (entries.length === 0) return;
  await publishWorkspaceDeletions(storage, () => entries, options);
}
