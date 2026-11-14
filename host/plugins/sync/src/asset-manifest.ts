/** Asset manifest publication and merge, mod.rs:10242,12148-12239. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage } from '../../sync-support/api.ts';
import type { AsyncTombstoneReader } from './tombstone-needs.ts';
import type { FilePayloadCodec } from './payload.ts';
import type { SyncLogger } from './log.ts';
import { parseAssetManifest } from './file-manifest.ts';
import type { AssetEntry, FileManifest } from './unsynced-classification.ts';
import { stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { putAndReread } from './manifest-upload.ts';
import { compareFileText, timestampAfter } from './workspace-manifest.ts';
import { localFileWins, validateRemoteObjectKey } from './workspace-sync.ts';
import { SyncError } from './errors.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import type { PortableAssetOptions } from './portable-assets.ts';

export interface AssetSyncOptions extends ValidateRemoteFormatOptions, PortableAssetOptions {
  codec: FilePayloadCodec;
  tombstones: Pick<AsyncTombstoneReader, 'downloadAssetTombstones'>;
  logger: SyncLogger;
  isCancelled(): boolean;
}
export const ASSET_MANIFEST_PREFIX = 'data_governance/file_manifests/assets';
export const ASSET_OBJECT_PREFIX = 'data_governance/asset_objects';
export const ASSET_LEGACY_PREFIX = 'data_governance/assets';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function isContentAddressedAssetObject(key: string): boolean {
  try { validateRemoteObjectKey(key, ASSET_OBJECT_PREFIX); return true; }
  catch { return false; }
}
export function validateAssetObjectKey(key: string): void {
  if (isContentAddressedAssetObject(key)) return;
  try { validateRemoteObjectKey(key, ASSET_LEGACY_PREFIX); }
  catch { throw new SyncError(`Database error: 拒绝越界或非法的资产对象 key: ${JSON.stringify(key)}`); }
}
export async function publishAssetManifest(storage: CloudStorage, manifest: FileManifest<AssetEntry>, options: ValidateRemoteFormatOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  let bytes;
  try {
    const entries: Record<string, DbJson> = Object.fromEntries([...manifest.entries].map(([key, entry]) => [key,
      Object.fromEntries(Object.entries(entry).filter(([, value]) => value != null)),
    ]));
    bytes = encodeUtf8(stringifyJsonLossless({ entries, updated_at: manifest.updated_at }));
  } catch (error) { throw new SyncError(`Database error: 序列化资产清单失败: ${message(error)}`); }
  await putAndReread(storage, `${ASSET_MANIFEST_PREFIX}/${globalThis.crypto.randomUUID()}.json`, await options.codec.encode(bytes), '文件级资产清单');
}
export async function downloadAssetsManifest(storage: CloudStorage, options: AssetSyncOptions, filterTombstones = true): Promise<FileManifest<AssetEntry>> {
  const manifests: FileManifest<AssetEntry>[] = [];
  let bytes;
  try { bytes = await storage.get('data_governance/assets_manifest.json'); }
  catch (error) { throw new SyncError(`Network error: 获取旧资产清单失败: ${message(error)}`); }
  if (bytes !== null) {
    let decoded;
    try { decoded = await options.codec.decode(bytes); }
    catch (error) { throw new SyncError(`Database error: 旧资产清单无法解密，已停止同步（请检查加密密码）: ${message(error)}`); }
    try { manifests.push(parseAssetManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 旧资产清单损坏: ${message(error)}`); }
  }
  let list;
  try { list = await storage.listOutcome(ASSET_MANIFEST_PREFIX); }
  catch (error) { throw new SyncError(`Network error: 列举资产清单失败: ${message(error)}`); }
  if (list.truncated) throw new SyncError('Network error: 资产清单列表被截断，无法安全合并');
  for (const file of list.files) {
    if (!file.key.endsWith('.json')) continue;
    try { bytes = await storage.get(file.key); }
    catch (error) { throw new SyncError(`Network error: 读取资产清单 ${file.key} 失败: ${message(error)}`); }
    if (bytes === null) throw new SyncError(`Network error: 已列举的资产清单消失: ${file.key}`);
    let decoded;
    try { decoded = await options.codec.decode(bytes); }
    catch (error) { throw new SyncError(`Database error: 资产清单 ${file.key} 无法解密: ${message(error)}`); }
    try { manifests.push(parseAssetManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 资产清单 ${file.key} 损坏: ${message(error)}`); }
  }
  const merged: FileManifest<AssetEntry> = { entries: new Map(), updated_at: '' };
  for (const manifest of manifests) {
    if (compareFileText(manifest.updated_at, merged.updated_at) > 0) merged.updated_at = manifest.updated_at;
    for (const [key, entry] of manifest.entries) {
      const current = merged.entries.get(key);
      if (!current || entry.revision > current.revision || (entry.revision === current.revision && localFileWins(entry.updated_at, current.updated_at, entry.sha256, current.sha256))) merged.entries.set(key, entry);
    }
  }
  if (filterTombstones) {
    const deleted = await options.tombstones.downloadAssetTombstones(adaptTombstoneStorage(storage), options.codec);
    for (const [key, tombstone] of Object.entries(deleted.entries)) {
      const entry = merged.entries.get(key);
      if (entry && !timestampAfter(entry.updated_at, tombstone.deleted_at)) merged.entries.delete(key);
    }
  }
  return merged;
}
