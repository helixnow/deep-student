/** tombstone.rs：legacy/每设备清单 I/O、迁移、事件合并与双写。 */

import { decodeUtf8Strict } from '../../../platform/util/portable.ts';

import type { AssetTombstones, BlobTombstones, PayloadCodec, SyncPayloadCodec, AsyncPayloadCodec, TombstoneStorage, TombstoneWatermarkAdvance, TombstoneWatermarkLookup, WorkspaceTombstones } from '../api.ts';

import { SyncSupportError, databaseError, networkError } from './errors.ts';

import { toRfc3339 } from '../../../platform/time/index.ts';

import {
  ASSET_TOMBSTONE_PREFIX,
  BLOB_TOMBSTONE_PREFIX,
  LEGACY_ASSET_TOMBSTONE_KEY,
  LEGACY_BLOB_TOMBSTONE_KEY,
  LEGACY_WS_TOMBSTONE_KEY,
  WS_TOMBSTONE_PREFIX,
  assetDeviceTombstoneKey,
  assetDeviceTombstoneLegacyKey,
  blobDeviceTombstoneKey,
  blobDeviceTombstoneLegacyKey,
  errorMessage,
  filterAssetTombstonesAfter,
  filterBlobTombstonesAfter,
  filterWorkspaceTombstonesAfter,
  mergeAssetTombstones,
  mergeBlobTombstones,
  mergeWorkspaceTombstones,
  normalizeAssetManifest,
  normalizeBlobManifest,
  normalizeWorkspaceManifest,
  sourceDeviceFromTombstoneEntries,
  stringifyAssetTombstones,
  stringifyBlobTombstones,
  stringifyWorkspaceTombstones,
  workspaceDeviceTombstoneKey,
  workspaceDeviceTombstoneLegacyKey,
} from './tombstone-model.ts';

import type {
  TombstoneLogger,
} from './tombstone-model.ts';

import {
  downloadEvents,
  downloadEventsAfter,
  publishEvents,
} from './tombstone-events.ts';
import { utf8Encode } from './portable.ts';

// ------------------------------------------------------------------ 通用 I/O

async function getDeviceTombstoneBytes(
  storage: TombstoneStorage,
  hashedKey: string,
  legacyKey: string,
  label: string,
): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(hashedKey);
  } catch (error) {
    return networkError(`获取本机 ${label} tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (bytes !== null) return bytes;
  if (legacyKey === hashedKey) return null;
  try {
    return await storage.get(legacyKey);
  } catch (error) {
    return networkError(`获取本机 ${label} tombstone 清单失败: ${errorMessage(error)}`);
  }
}

async function putTombstoneManifestAndReread(
  storage: TombstoneStorage,
  key: string,
  payload: Uint8Array,
  context: string,
): Promise<void> {
  try {
    await storage.put(key, payload);
  } catch (error) {
    networkError(`${context} 上传失败: ${errorMessage(error)}`);
  }
  let readBack: Uint8Array | null;
  try {
    readBack = await storage.get(key);
  } catch (error) {
    return networkError(`${context} 上传后回读失败: ${errorMessage(error)}`);
  }
  if (readBack === null) networkError(`${context} 上传后对象不存在，已停止并不得报成功`);
  if (!bytesEqual(readBack, payload)) networkError(`${context} 上传后回读不一致，已停止并不得报成功`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * 迁移后删除旧明文对象（尽力而为：失败只记 warning，不影响已发布的新清单）。
 */
async function deleteLegacyDeviceTombstone(
  storage: TombstoneStorage,
  hashedKey: string,
  legacyKey: string,
  logger: TombstoneLogger,
): Promise<void> {
  if (hashedKey === legacyKey) return;
  let existing: unknown | null;
  try {
    existing = await storage.stat(legacyKey);
  } catch (error) {
    logger.warn(`[sync] 迁移 tombstone 时探测旧对象 ${legacyKey} 失败: ${errorMessage(error)}`);
    return;
  }
  if (existing === null) return;
  try {
    await storage.delete(legacyKey);
  } catch (error) {
    logger.warn(`[sync] 迁移 tombstone 后删除旧对象 ${legacyKey} 失败（新清单已发布）: ${errorMessage(error)}`);
  }
}

/** [P2 fail-close] 解密失败/清单损坏必须硬错误，不得当作"无 tombstone"。 */
export function decodeTombstoneFile(codec: SyncPayloadCodec, bytes: Uint8Array, label: string): unknown | null;
export function decodeTombstoneFile(codec: AsyncPayloadCodec, bytes: Uint8Array, label: string): Promise<unknown | null>;
export function decodeTombstoneFile(codec: PayloadCodec, bytes: Uint8Array, label: string): unknown | null | Promise<unknown | null>;
export function decodeTombstoneFile(
  codec: PayloadCodec,
  bytes: Uint8Array,
  label: string,
): unknown | null | Promise<unknown | null> {
  let decoded: Uint8Array | Promise<Uint8Array>;
  try {
    decoded = codec.decode(bytes);
  } catch (error) {
    return manifestDecodeError(label, error);
  }
  // Preserve the synchronous return/throw contract for existing codecs. A rejected
  // Promise has the same decryption context; JSON errors remain parse failures.
  if (decoded instanceof Uint8Array) return parseDecodedManifest(decoded, label);
  return decoded.then(
    data => parseDecodedManifest(data, label),
    error => manifestDecodeError(label, error),
  );
}

function manifestDecodeError(label: string, error: unknown): never {
  return databaseError(`${label} tombstone 清单无法解密，已停止同步（请检查加密密码）: ${errorMessage(error)}`);
}

function parseDecodedManifest(decoded: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeUtf8Strict(decoded)) as unknown;
  } catch (error) {
    return databaseError(
      `${label} tombstone 清单损坏，已停止同步且未推进水位: ${errorMessage(error)}`,
    );
  }
}

/**
 * 解密 + serde 形状校验：Rust `decode_tombstone_file::<T>` 的完整等价物。
 * 形状错误也必须带上 `<label> tombstone 清单损坏…` 上下文。
 */
async function decodeManifest<T>(
  codec: PayloadCodec,
  bytes: Uint8Array,
  label: string,
  normalize: (value: unknown) => T | null,
): Promise<T | null> {
  const parsed = await decodeTombstoneFile(codec, bytes, label);
  try {
    return normalize(parsed);
  } catch (error) {
    if (error instanceof SyncSupportError) {
      const prefix = 'Database error: ';
      const detail = error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message;
      databaseError(`${label} tombstone 清单损坏，已停止同步且未推进水位: ${detail}`);
    }
    databaseError(
      `${label} tombstone 清单损坏，已停止同步且未推进水位: ${errorMessage(error)}`,
    );
  }
}

async function listTombstoneKeys(
  storage: TombstoneStorage,
  prefix: string,
  label: string,
): Promise<string[]> {
  let outcome;
  try {
    outcome = await storage.list_outcome(prefix);
  } catch (error) {
    return networkError(`列举 ${label} tombstone 失败: ${errorMessage(error)}`);
  }
  if (outcome.truncated) networkError(`${label} tombstone 列表被截断，拒绝推进同步`);
  return outcome.files
    .map(file => file.key)
    .filter(key => key.startsWith(prefix) && key.endsWith('.json'));
}

// ------------------------------------------------------------------ 下载

function emptyBlobTombstones(): BlobTombstones {
  return { entries: {}, updated_at: '' };
}

function emptyAssetTombstones(): AssetTombstones {
  return { entries: {}, updated_at: '' };
}

function emptyWorkspaceTombstones(): WorkspaceTombstones {
  return { entries: {}, updated_at: '' };
}

export async function downloadBlobTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  logger: TombstoneLogger,
): Promise<BlobTombstones> {
  const merged = emptyBlobTombstones();
  await mergeLegacyBlob(storage, codec, merged, logger, () => undefined);
  for (const key of await listTombstoneKeys(storage, BLOB_TOMBSTONE_PREFIX, 'blob')) {
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(key);
    } catch (error) {
      return networkError(`获取 blob tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (bytes === null) continue;
    const manifest = await decodeManifest(codec, bytes, 'blob', normalizeBlobManifest);
    if (manifest !== null) mergeBlobTombstones(merged, manifest);
  }
  for (const event of await downloadEvents(storage, codec, 'blobs')) {
    mergeBlobTombstones(merged, {
      entries: {
        [event.object_id]: {
          deleted_at: event.deleted_at,
          device_id: event.device_id,
          size: event.size,
          relative_path: event.relative_path,
        },
      },
      updated_at: '',
    });
  }
  return merged;
}

async function mergeLegacyBlob(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  merged: BlobTombstones,
  _logger: TombstoneLogger,
  _onError: () => void,
): Promise<void> {
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(LEGACY_BLOB_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy blob tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (bytes === null) return;
  const manifest = await decodeManifest(codec, bytes, 'legacy blob', normalizeBlobManifest);
  if (manifest !== null) mergeBlobTombstones(merged, manifest);
}

export async function downloadBlobTombstonesAfter(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  watermarkFor: TombstoneWatermarkLookup,
  logger: TombstoneLogger,
): Promise<[BlobTombstones, TombstoneWatermarkAdvance[]]> {
  const merged = emptyBlobTombstones();
  const advances: TombstoneWatermarkAdvance[] = [];

  let legacyBytes: Uint8Array | null;
  try {
    legacyBytes = await storage.get(LEGACY_BLOB_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy blob tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (legacyBytes !== null) {
    const manifest = await decodeManifest(codec, legacyBytes, 'legacy blob', normalizeBlobManifest);
    if (manifest !== null) {
      const source = 'legacy';
      const watermark = watermarkFor(source);
      const [filtered, maxOffset] = filterBlobTombstonesAfter(manifest, watermark, logger);
      if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
      mergeBlobTombstones(merged, filtered);
    }
  }

  for (const key of await listTombstoneKeys(storage, BLOB_TOMBSTONE_PREFIX, 'blob')) {
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.get(key);
    } catch (error) {
      return networkError(`获取 blob tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (bytes === null) continue;
    const manifest = await decodeManifest(codec, bytes, 'blob', normalizeBlobManifest);
    if (manifest === null) continue;
    const source = sourceDeviceFromTombstoneEntries(
      key, BLOB_TOMBSTONE_PREFIX, Object.values(manifest.entries).map(entry => entry.device_id),
    );
    const watermark = watermarkFor(source);
    const [filtered, maxOffset] = filterBlobTombstonesAfter(manifest, watermark, logger);
    if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
    mergeBlobTombstones(merged, filtered);
  }

  const [events, eventAdvances] = await downloadEventsAfter(storage, codec, 'blobs', watermarkFor, logger);
  advances.push(...eventAdvances);
  for (const event of events) {
    mergeBlobTombstones(merged, {
      entries: {
        [event.object_id]: {
          deleted_at: event.deleted_at,
          device_id: event.device_id,
          size: event.size,
          relative_path: event.relative_path,
        },
      },
      updated_at: '',
    });
  }
  return [merged, advances];
}

export async function downloadBlobTombstonesForDevice(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  deviceId: string,
): Promise<BlobTombstones> {
  const hashed = blobDeviceTombstoneKey(deviceId);
  const legacy = blobDeviceTombstoneLegacyKey(deviceId);
  const bytes = await getDeviceTombstoneBytes(storage, hashed, legacy, 'blob');
  if (bytes === null) return emptyBlobTombstones();
  return await decodeManifest(codec, bytes, 'local blob', normalizeBlobManifest) ?? emptyBlobTombstones();
}

export async function downloadAssetTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
): Promise<AssetTombstones> {
  const merged = emptyAssetTombstones();
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(LEGACY_ASSET_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy asset tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (bytes !== null) {
    const manifest = await decodeManifest(codec, bytes, 'legacy asset', normalizeAssetManifest);
    if (manifest !== null) mergeAssetTombstones(merged, manifest);
  }
  for (const key of await listTombstoneKeys(storage, ASSET_TOMBSTONE_PREFIX, 'asset')) {
    let raw: Uint8Array | null;
    try {
      raw = await storage.get(key);
    } catch (error) {
      return networkError(`获取 asset tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (raw === null) continue;
    const manifest = await decodeManifest(codec, raw, 'asset', normalizeAssetManifest);
    if (manifest !== null) mergeAssetTombstones(merged, manifest);
  }
  for (const event of await downloadEvents(storage, codec, 'assets')) {
    mergeAssetTombstones(merged, {
      entries: {
        [event.object_id]: {
          deleted_at: event.deleted_at,
          device_id: event.device_id,
          size: event.size,
        },
      },
      updated_at: '',
    });
  }
  return merged;
}

export async function downloadAssetTombstonesAfter(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  watermarkFor: TombstoneWatermarkLookup,
  logger: TombstoneLogger,
): Promise<[AssetTombstones, TombstoneWatermarkAdvance[]]> {
  const merged = emptyAssetTombstones();
  const advances: TombstoneWatermarkAdvance[] = [];

  let legacyBytes: Uint8Array | null;
  try {
    legacyBytes = await storage.get(LEGACY_ASSET_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy asset tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (legacyBytes !== null) {
    const manifest = await decodeManifest(codec, legacyBytes, 'legacy asset', normalizeAssetManifest);
    if (manifest !== null) {
      const source = 'legacy';
      const watermark = watermarkFor(source);
      const [filtered, maxOffset] = filterAssetTombstonesAfter(manifest, watermark, logger);
      if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
      mergeAssetTombstones(merged, filtered);
    }
  }

  for (const key of await listTombstoneKeys(storage, ASSET_TOMBSTONE_PREFIX, 'asset')) {
    let raw: Uint8Array | null;
    try {
      raw = await storage.get(key);
    } catch (error) {
      return networkError(`获取 asset tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (raw === null) continue;
    const manifest = await decodeManifest(codec, raw, 'asset', normalizeAssetManifest);
    if (manifest === null) continue;
    const source = sourceDeviceFromTombstoneEntries(
      key, ASSET_TOMBSTONE_PREFIX, Object.values(manifest.entries).map(entry => entry.device_id),
    );
    const watermark = watermarkFor(source);
    const [filtered, maxOffset] = filterAssetTombstonesAfter(manifest, watermark, logger);
    if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
    mergeAssetTombstones(merged, filtered);
  }

  const [events, eventAdvances] = await downloadEventsAfter(storage, codec, 'assets', watermarkFor, logger);
  advances.push(...eventAdvances);
  for (const event of events) {
    mergeAssetTombstones(merged, {
      entries: {
        [event.object_id]: {
          deleted_at: event.deleted_at,
          device_id: event.device_id,
          size: event.size,
        },
      },
      updated_at: '',
    });
  }
  return [merged, advances];
}

export async function downloadAssetTombstonesForDevice(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  deviceId: string,
): Promise<AssetTombstones> {
  const bytes = await getDeviceTombstoneBytes(
    storage, assetDeviceTombstoneKey(deviceId), assetDeviceTombstoneLegacyKey(deviceId), 'asset',
  );
  if (bytes === null) return emptyAssetTombstones();
  return await decodeManifest(codec, bytes, 'local asset', normalizeAssetManifest) ?? emptyAssetTombstones();
}

export async function downloadWorkspaceTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
): Promise<WorkspaceTombstones> {
  const merged = emptyWorkspaceTombstones();
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(LEGACY_WS_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy workspace tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (bytes !== null) {
    const manifest = await decodeManifest(codec, bytes, 'legacy workspace', normalizeWorkspaceManifest);
    if (manifest !== null) mergeWorkspaceTombstones(merged, manifest);
  }
  for (const key of await listTombstoneKeys(storage, WS_TOMBSTONE_PREFIX, 'workspace')) {
    let raw: Uint8Array | null;
    try {
      raw = await storage.get(key);
    } catch (error) {
      return networkError(`获取 workspace tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (raw === null) continue;
    const manifest = await decodeManifest(codec, raw, 'workspace', normalizeWorkspaceManifest);
    if (manifest !== null) mergeWorkspaceTombstones(merged, manifest);
  }
  for (const event of await downloadEvents(storage, codec, 'workspaces')) {
    mergeWorkspaceTombstones(merged, {
      entries: { [event.object_id]: { deleted_at: event.deleted_at, device_id: event.device_id } },
      updated_at: '',
    });
  }
  return merged;
}

export async function downloadWorkspaceTombstonesAfter(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  watermarkFor: TombstoneWatermarkLookup,
  logger: TombstoneLogger,
): Promise<[WorkspaceTombstones, TombstoneWatermarkAdvance[]]> {
  const merged = emptyWorkspaceTombstones();
  const advances: TombstoneWatermarkAdvance[] = [];

  let legacyBytes: Uint8Array | null;
  try {
    legacyBytes = await storage.get(LEGACY_WS_TOMBSTONE_KEY);
  } catch (error) {
    return networkError(`获取 legacy workspace tombstone 清单失败: ${errorMessage(error)}`);
  }
  if (legacyBytes !== null) {
    const manifest = await decodeManifest(codec, legacyBytes, 'legacy workspace', normalizeWorkspaceManifest);
    if (manifest !== null) {
      const source = 'legacy';
      const watermark = watermarkFor(source);
      const [filtered, maxOffset] = filterWorkspaceTombstonesAfter(manifest, watermark);
      if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
      mergeWorkspaceTombstones(merged, filtered);
    }
  }

  for (const key of await listTombstoneKeys(storage, WS_TOMBSTONE_PREFIX, 'workspace')) {
    let raw: Uint8Array | null;
    try {
      raw = await storage.get(key);
    } catch (error) {
      return networkError(`获取 workspace tombstone ${key} 失败: ${errorMessage(error)}`);
    }
    if (raw === null) continue;
    const manifest = await decodeManifest(codec, raw, 'workspace', normalizeWorkspaceManifest);
    if (manifest === null) continue;
    const source = sourceDeviceFromTombstoneEntries(
      key, WS_TOMBSTONE_PREFIX, Object.values(manifest.entries).map(entry => entry.device_id),
    );
    const watermark = watermarkFor(source);
    const [filtered, maxOffset] = filterWorkspaceTombstonesAfter(manifest, watermark);
    if (maxOffset > watermark) advances.push({ source_device_id: source, last_applied_offset: maxOffset });
    mergeWorkspaceTombstones(merged, filtered);
  }

  const [events, eventAdvances] = await downloadEventsAfter(
    storage, codec, 'workspaces', watermarkFor, logger,
  );
  advances.push(...eventAdvances);
  for (const event of events) {
    mergeWorkspaceTombstones(merged, {
      entries: { [event.object_id]: { deleted_at: event.deleted_at, device_id: event.device_id } },
      updated_at: '',
    });
  }
  return [merged, advances];
}

export async function downloadWorkspaceTombstonesForDevice(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  deviceId: string,
): Promise<WorkspaceTombstones> {
  const bytes = await getDeviceTombstoneBytes(
    storage, workspaceDeviceTombstoneKey(deviceId), workspaceDeviceTombstoneLegacyKey(deviceId), 'workspace',
  );
  if (bytes === null) return emptyWorkspaceTombstones();
  return await decodeManifest(codec, bytes, 'local workspace', normalizeWorkspaceManifest)
    ?? emptyWorkspaceTombstones();
}

// ------------------------------------------------------------------ 上传

export async function uploadBlobTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  state: Parameters<typeof publishEvents>[2],
  deviceId: string,
  manifest: BlobTombstones,
  logger: TombstoneLogger,
): Promise<void> {
  await publishEvents(
    storage, codec, state, deviceId, 'blobs',
    Object.entries(manifest.entries).map(([objectId, entry]) => ({
      objectId, deletedAt: entry.deleted_at, size: entry.size ?? null, relativePath: entry.relative_path ?? null,
    })),
  );
  // v3 兼容双写：旧客户端继续读取每设备清单；v4 客户端以不可变事件为准并双读。
  const next: BlobTombstones = { entries: manifest.entries, updated_at: toRfc3339() };
  const payload = await codec.encode(utf8Encode(stringifyBlobTombstones(next)));
  const key = blobDeviceTombstoneKey(deviceId);
  await putTombstoneManifestAndReread(storage, key, payload, 'blob tombstone 清单');
  await deleteLegacyDeviceTombstone(storage, key, blobDeviceTombstoneLegacyKey(deviceId), logger);
}

export async function uploadAssetTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  state: Parameters<typeof publishEvents>[2],
  deviceId: string,
  manifest: AssetTombstones,
  logger: TombstoneLogger,
): Promise<void> {
  await publishEvents(
    storage, codec, state, deviceId, 'assets',
    Object.entries(manifest.entries).map(([objectId, entry]) => ({
      objectId, deletedAt: entry.deleted_at, size: entry.size ?? null, relativePath: null,
    })),
  );
  const next: AssetTombstones = { entries: manifest.entries, updated_at: toRfc3339() };
  const payload = await codec.encode(utf8Encode(stringifyAssetTombstones(next)));
  const key = assetDeviceTombstoneKey(deviceId);
  await putTombstoneManifestAndReread(storage, key, payload, 'asset tombstone 清单');
  await deleteLegacyDeviceTombstone(storage, key, assetDeviceTombstoneLegacyKey(deviceId), logger);
}

export async function uploadWorkspaceTombstones(
  storage: TombstoneStorage,
  codec: PayloadCodec,
  state: Parameters<typeof publishEvents>[2],
  deviceId: string,
  manifest: WorkspaceTombstones,
  logger: TombstoneLogger,
): Promise<void> {
  await publishEvents(
    storage, codec, state, deviceId, 'workspaces',
    Object.entries(manifest.entries).map(([objectId, entry]) => ({
      objectId, deletedAt: entry.deleted_at, size: null, relativePath: null,
    })),
  );
  const next: WorkspaceTombstones = { entries: manifest.entries, updated_at: toRfc3339() };
  const payload = await codec.encode(utf8Encode(stringifyWorkspaceTombstones(next)));
  const key = workspaceDeviceTombstoneKey(deviceId);
  await putTombstoneManifestAndReread(storage, key, payload, 'workspace tombstone 清单');
  await deleteLegacyDeviceTombstone(storage, key, workspaceDeviceTombstoneLegacyKey(deviceId), logger);
}
