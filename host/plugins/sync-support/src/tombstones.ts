/** TombstoneSupport 服务组装与原有导出入口；实现按职责拆分。 */

import type { SyncStateStore, TombstoneSupport } from '../api.ts';

import {
  ASSET_TOMBSTONE_PREFIX,
  BLOB_TOMBSTONE_PREFIX,
  DEFAULT_TOMBSTONE_RETENTION_DAYS,
  LEGACY_ASSET_TOMBSTONE_KEY,
  LEGACY_BLOB_TOMBSTONE_KEY,
  LEGACY_WS_TOMBSTONE_KEY,
  TOMBSTONE_EVENTS_PREFIX,
  WS_TOMBSTONE_PREFIX,
  assetDeviceTombstoneKey,
  assetDeviceTombstoneLegacyKey,
  blobDeviceTombstoneKey,
  blobDeviceTombstoneLegacyKey,
  deletedAtIsNewer,
  deviceComponent,
  deviceIdShortHash,
  eventDeviceLegacyPrefix,
  eventDevicePrefix,
  eventKey,
  eventKeyMatches,
  eventLegacyKey,
  eventOperationFromKey,
  eventOperationId,
  eventPayloadHash,
  eventSeqFromKey,
  filterAssetTombstonesAfter,
  filterBlobTombstonesAfter,
  filterWorkspaceTombstonesAfter,
  mergeAssetTombstones,
  mergeBlobTombstones,
  mergeWorkspaceTombstones,
  sourceDeviceFromTombstoneEntries,
  tombstoneDeletedAtUsable,
  tombstoneDevicePathId,
  tombstoneOffsetFromDeletedAt,
  tombstonePathIdMatchesDevice,
  tombstonePathStem,
  validateTombstoneTimestamp,
  workspaceDeviceTombstoneKey,
  workspaceDeviceTombstoneLegacyKey,
} from './tombstone-model.ts';

import type {
  TombstoneLogger,
} from './tombstone-model.ts';

import {
  decodeTombstoneFile,
  downloadAssetTombstones,
  downloadAssetTombstonesAfter,
  downloadAssetTombstonesForDevice,
  downloadBlobTombstones,
  downloadBlobTombstonesAfter,
  downloadBlobTombstonesForDevice,
  downloadWorkspaceTombstones,
  downloadWorkspaceTombstonesAfter,
  downloadWorkspaceTombstonesForDevice,
  uploadAssetTombstones,
  uploadBlobTombstones,
  uploadWorkspaceTombstones,
} from './tombstone-manifests.ts';

import {
  applyBlobTombstones,
  findBlobByHashWith,
  pathModifiedAfter,
  pruneTombstones,
  unavailableTombstoneLocalFiles,
  validateBlobRelativePathWith,
  type TombstoneLocalFiles,
} from './tombstone-files.ts';

/**
 * 构造 `TombstoneSupport`：Rust 的 `SyncStateStore::open_default()` 在 TS 中由
 * 服务注入同一个 `state` 实例，因此上传方法不需要调用方再传状态。
 */
export function createTombstoneSupport(
  state: SyncStateStore,
  logger: TombstoneLogger,
  files: TombstoneLocalFiles = unavailableTombstoneLocalFiles,
): TombstoneSupport {
  return {
    LEGACY_BLOB_TOMBSTONE_KEY,
    LEGACY_ASSET_TOMBSTONE_KEY,
    LEGACY_WS_TOMBSTONE_KEY,
    BLOB_TOMBSTONE_PREFIX,
    ASSET_TOMBSTONE_PREFIX,
    WS_TOMBSTONE_PREFIX,
    TOMBSTONE_EVENTS_PREFIX,
    DEFAULT_TOMBSTONE_RETENTION_DAYS,
    deviceIdShortHash,
    deviceComponent,
    tombstoneDevicePathId,
    eventOperationId,
    eventPayloadHash,
    eventDevicePrefix,
    eventDeviceLegacyPrefix,
    eventKey,
    eventLegacyKey,
    eventKeyMatches,
    eventSeqFromKey,
    eventOperationFromKey,
    blobDeviceTombstoneKey,
    blobDeviceTombstoneLegacyKey,
    assetDeviceTombstoneKey,
    assetDeviceTombstoneLegacyKey,
    workspaceDeviceTombstoneKey,
    workspaceDeviceTombstoneLegacyKey,
    deletedAtIsNewer,
    mergeBlobTombstones,
    mergeAssetTombstones,
    mergeWorkspaceTombstones,
    pathModifiedAfter: (target, timestamp) => pathModifiedAfter(files, target, timestamp),
    validateTombstoneTimestamp,
    tombstoneDeletedAtUsable: (deletedAt, label) =>
      tombstoneDeletedAtUsable(deletedAt, label, logger),
    decodeTombstoneFile,
    tombstonePathStem,
    tombstonePathIdMatchesDevice,
    sourceDeviceFromTombstoneEntries,
    tombstoneOffsetFromDeletedAt,
    filterBlobTombstonesAfter: (manifest, watermark) =>
      filterBlobTombstonesAfter(manifest, watermark, logger),
    filterAssetTombstonesAfter: (manifest, watermark) =>
      filterAssetTombstonesAfter(manifest, watermark, logger),
    filterWorkspaceTombstonesAfter,
    validateBlobRelativePath: (blobsDir, hash, relativePath) => validateBlobRelativePathWith(files, blobsDir, hash, relativePath),
    findBlobByHash: (blobsDir, hash) => findBlobByHashWith(files, blobsDir, hash),
    pruneTombstones,
    downloadBlobTombstones: (storage, codec) => downloadBlobTombstones(storage, codec, logger),
    downloadBlobTombstonesAfter: (storage, codec, watermarkFor) =>
      downloadBlobTombstonesAfter(storage, codec, watermarkFor, logger),
    downloadBlobTombstonesForDevice,
    downloadAssetTombstones: (storage, codec) => downloadAssetTombstones(storage, codec),
    downloadAssetTombstonesAfter: (storage, codec, watermarkFor) =>
      downloadAssetTombstonesAfter(storage, codec, watermarkFor, logger),
    downloadAssetTombstonesForDevice,
    downloadWorkspaceTombstones,
    downloadWorkspaceTombstonesAfter: (storage, codec, watermarkFor) =>
      downloadWorkspaceTombstonesAfter(storage, codec, watermarkFor, logger),
    downloadWorkspaceTombstonesForDevice,
    uploadBlobTombstones: (storage, codec, deviceId, manifest) =>
      uploadBlobTombstones(storage, codec, state, deviceId, manifest, logger),
    uploadAssetTombstones: (storage, codec, deviceId, manifest) =>
      uploadAssetTombstones(storage, codec, state, deviceId, manifest, logger),
    uploadWorkspaceTombstones: (storage, codec, deviceId, manifest) =>
      uploadWorkspaceTombstones(storage, codec, state, deviceId, manifest, logger),
    applyBlobTombstones: (storage, tombstones, blobsDir, blobsCloudPrefix, deleteCloud) =>
      applyBlobTombstones(storage, tombstones, blobsDir, blobsCloudPrefix, deleteCloud, logger, files),
  };
}

export {
  LEGACY_BLOB_TOMBSTONE_KEY,
  LEGACY_ASSET_TOMBSTONE_KEY,
  LEGACY_WS_TOMBSTONE_KEY,
  BLOB_TOMBSTONE_PREFIX,
  ASSET_TOMBSTONE_PREFIX,
  WS_TOMBSTONE_PREFIX,
  TOMBSTONE_EVENTS_PREFIX,
  DEFAULT_TOMBSTONE_RETENTION_DAYS,
  TOMBSTONE_EVENT_FORMAT_VERSION,
  deviceIdShortHash,
  deviceComponent,
  tombstoneDevicePathId,
  eventOperationId,
  eventPayloadHash,
  eventDevicePrefix,
  eventDeviceLegacyPrefix,
  eventKey,
  eventLegacyKey,
  eventKeyMatches,
  eventSeqFromKey,
  eventOperationFromKey,
  blobDeviceTombstoneKey,
  blobDeviceTombstoneLegacyKey,
  assetDeviceTombstoneKey,
  assetDeviceTombstoneLegacyKey,
  workspaceDeviceTombstoneKey,
  workspaceDeviceTombstoneLegacyKey,
  deletedAtIsNewer,
  mergeBlobTombstones,
  mergeAssetTombstones,
  mergeWorkspaceTombstones,
  validateTombstoneTimestamp,
  tombstoneDeletedAtUsable,
  tombstonePathStem,
  tombstonePathIdMatchesDevice,
  sourceDeviceFromTombstoneEntries,
  tombstoneOffsetFromDeletedAt,
  filterBlobTombstonesAfter,
  filterAssetTombstonesAfter,
  filterWorkspaceTombstonesAfter,
  normalizeBlobManifest,
  normalizeAssetManifest,
  normalizeWorkspaceManifest,
  parseTombstoneEvent,
} from './tombstone-model.ts';

export type {
  TombstoneLogger,
} from './tombstone-model.ts';

export {
  publishEvents,
  downloadEvents,
} from './tombstone-events.ts';

export type {
  PublishEventInput,
} from './tombstone-events.ts';

export {
  decodeTombstoneFile,
  downloadBlobTombstones,
  downloadBlobTombstonesAfter,
  downloadBlobTombstonesForDevice,
  downloadAssetTombstones,
  downloadAssetTombstonesAfter,
  downloadAssetTombstonesForDevice,
  downloadWorkspaceTombstones,
  downloadWorkspaceTombstonesAfter,
  downloadWorkspaceTombstonesForDevice,
  uploadBlobTombstones,
  uploadAssetTombstones,
  uploadWorkspaceTombstones,
} from './tombstone-manifests.ts';

export {
  pathModifiedAfter,
  applyBlobTombstones,
  validateBlobRelativePathWith,
  findBlobByHashWith,
  filesTombstonePort,
  pruneTombstones,
} from './tombstone-files.ts';
