/** commands_sync.rs:5395-5441,5813-5908. Read-only aggregation; no cursor acknowledgement. */
import { join } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage } from '../../sync-support/api.ts';
import type { UnsyncedItemKind } from '../../../../contracts/ipc/generated/L20-sync.ts';
import type { AsyncTombstoneReader } from './tombstone-needs.ts';
import type { PayloadCodec } from './payload.ts';
import { parseBlobManifest, parseAssetManifest } from './file-manifest.ts';
import {
  mergeBlobManifests, mergeAssetManifests, classifyBlobs, classifyAssets, unsyncedTimestampAfter,
} from './unsynced-classification.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const kindOrder: Record<UnsyncedItemKind, number> = {
  downloadPending: 0, legacyPlaintext: 1, caseConflict: 2, sanitizedNameConflict: 3, invalidKey: 4,
};

export async function fetchUnsyncedManifests<T>(
  storage: CloudStorage, codec: PayloadCodec, legacyKey: string, prefix: string, label: string,
  parse: (bytes: Uint8Array) => T,
): Promise<T[]> {
  const manifests: T[] = [];
  let bytes;
  try { bytes = await storage.get(legacyKey); }
  catch (error) { throw new CommandError(`获取旧${label}清单失败: ${message(error)}`); }
  if (bytes !== null) {
    let decoded;
    try { decoded = await codec.decode(bytes); }
    catch (error) { throw new CommandError(`旧${label}清单无法解密（请检查加密密码）: ${message(error)}`); }
    try { manifests.push(parse(decoded)); }
    catch (error) { throw new CommandError(`旧${label}清单损坏: ${message(error)}`); }
  }
  let listed;
  try { listed = await storage.listOutcome(prefix); }
  catch (error) { throw new CommandError(`列举${label}清单失败: ${message(error)}`); }
  if (listed.truncated) throw new CommandError(`${label}清单列表被截断，无法给出可信的未同步清单`);
  for (const file of listed.files) {
    if (!file.key.endsWith('.json')) continue;
    try { bytes = await storage.get(file.key); }
    catch (error) { throw new CommandError(`读取${label}清单 ${file.key} 失败: ${message(error)}`); }
    if (bytes === null) throw new CommandError(`已列举的${label}清单消失: ${file.key}`);
    let decoded;
    try { decoded = await codec.decode(bytes); }
    catch (error) { throw new CommandError(`${label}清单 ${file.key} 无法解密: ${message(error)}`); }
    try { manifests.push(parse(decoded)); }
    catch (error) { throw new CommandError(`${label}清单 ${file.key} 损坏: ${message(error)}`); }
  }
  return manifests;
}

export interface UnsyncedItemsOptions {
  activeDir: string;
  appDataDir: string;
  codec: PayloadCodec;
  encryptionEnabled: boolean;
  tombstones: AsyncTombstoneReader;
}

/** Registered through syncSupport's asynchronous tombstone decoding.
 * bigint sizes are preserved here and converted only at the command's IPC response boundary.
 */
export async function collectUnsyncedItems(storage: CloudStorage, options: UnsyncedItemsOptions) {
  const { codec, tombstones } = options;
  const blobs = mergeBlobManifests(await fetchUnsyncedManifests(storage, codec,
    'data_governance/blobs_manifest.json', 'data_governance/file_manifests/blobs', ' blob ', parseBlobManifest));
  let deletedBlobs;
  try { deletedBlobs = await tombstones.downloadBlobTombstones(adaptTombstoneStorage(storage), codec); }
  catch (error) { throw new CommandError(`获取 blob tombstone 失败: ${message(error)}`); }
  for (const [hash, tombstone] of Object.entries(deletedBlobs.entries)) {
    const entry = blobs.entries.get(hash);
    if (entry && !unsyncedTimestampAfter(entry.updated_at, tombstone.deleted_at)) blobs.entries.delete(hash);
  }
  const assets = mergeAssetManifests(await fetchUnsyncedManifests(storage, codec,
    'data_governance/assets_manifest.json', 'data_governance/file_manifests/assets', '资产', parseAssetManifest));
  let deletedAssets;
  try { deletedAssets = await tombstones.downloadAssetTombstones(adaptTombstoneStorage(storage), codec); }
  catch (error) { throw new CommandError(`获取资产 tombstone 失败: ${message(error)}`); }
  for (const [key, tombstone] of Object.entries(deletedAssets.entries)) {
    const entry = assets.entries.get(key);
    if (entry && !unsyncedTimestampAfter(entry.updated_at, tombstone.deleted_at)) assets.entries.delete(key);
  }
  const items = [
    ...classifyBlobs(blobs, join(options.activeDir, 'vfs_blobs'), options.encryptionEnabled),
    ...classifyAssets(assets, options.activeDir, options.appDataDir, options.encryptionEnabled),
  ];
  items.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || compareUtf8(a.key, b.key));
  return {
    items: items.slice(0, 500).map(({ counterpart, size, ...item }) => ({
      ...item, ...(counterpart === null ? {} : { counterpart }), ...(size === null ? {} : { size }),
    })),
    itemsTruncated: items.length > 500, totalUnsynced: items.length,
    blobEntriesTotal: blobs.entries.size, assetEntriesTotal: assets.entries.size,
    encryptionEnabled: options.encryptionEnabled,
    generatedAt: toRfc3339Opts(nowEpochNanos(), 'AutoSi', true),
  };
}
