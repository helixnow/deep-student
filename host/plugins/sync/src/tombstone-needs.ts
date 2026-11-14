/** L20's narrow consumption of the published L20b asynchronous tombstone API.
 * Production index wiring passes syncSupport.tombstones directly, without codec casts.
 * Rust: commands_sync.rs:5846,5871; tombstone.rs PayloadCodec.
 */
import type { BlobTombstones, AssetTombstones, TombstoneStorage, WorkspaceTombstones, TombstoneWatermarkAdvance, TombstoneSupport } from '../../sync-support/api.ts';
import type { PayloadCodec } from './payload.ts';

export interface AsyncTombstoneReader {
  downloadBlobTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<BlobTombstones>;
  downloadAssetTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<AssetTombstones>;
}

/** `tombstone.rs` `path_modified_after` stats a local file; the published port may resolve it off the event loop, so callers always await. */
export interface LocalPathModifiedAfter {
  pathModifiedAfter(path: string, timestamp: string): boolean | Promise<boolean>;
}

export interface AsyncWorkspaceTombstones extends Pick<TombstoneSupport, 'validateTombstoneTimestamp'>, LocalPathModifiedAfter {
  downloadWorkspaceTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<WorkspaceTombstones>;
  downloadWorkspaceTombstonesAfter(storage: TombstoneStorage, codec: PayloadCodec, watermark: (device: string) => bigint):
    Promise<[WorkspaceTombstones, TombstoneWatermarkAdvance[]]>;
}

export interface AsyncBlobTombstones extends Pick<AsyncTombstoneReader, 'downloadBlobTombstones'>,
  Pick<TombstoneSupport, 'validateTombstoneTimestamp' | 'applyBlobTombstones'> {
  downloadBlobTombstonesAfter(storage: TombstoneStorage, codec: PayloadCodec, watermark: (device: string) => bigint):
    Promise<[BlobTombstones, TombstoneWatermarkAdvance[]]>;
}
export interface AsyncAssetTombstones extends Pick<AsyncTombstoneReader, 'downloadAssetTombstones'>,
  Pick<TombstoneSupport, 'validateTombstoneTimestamp'>, LocalPathModifiedAfter {
  downloadAssetTombstonesAfter(storage: TombstoneStorage, codec: PayloadCodec, watermark: (device: string) => bigint):
    Promise<[AssetTombstones, TombstoneWatermarkAdvance[]]>;
}
export interface AsyncTombstoneWriter extends Pick<TombstoneSupport, 'pruneTombstones' | 'DEFAULT_TOMBSTONE_RETENTION_DAYS'> {
  downloadBlobTombstonesForDevice(storage: TombstoneStorage, codec: PayloadCodec, device: string): Promise<BlobTombstones>;
  downloadAssetTombstonesForDevice(storage: TombstoneStorage, codec: PayloadCodec, device: string): Promise<AssetTombstones>;
  downloadWorkspaceTombstonesForDevice(storage: TombstoneStorage, codec: PayloadCodec, device: string): Promise<WorkspaceTombstones>;
  uploadBlobTombstones(storage: TombstoneStorage, codec: PayloadCodec, device: string, manifest: BlobTombstones): Promise<void>;
  uploadAssetTombstones(storage: TombstoneStorage, codec: PayloadCodec, device: string, manifest: AssetTombstones): Promise<void>;
  uploadWorkspaceTombstones(storage: TombstoneStorage, codec: PayloadCodec, device: string, manifest: WorkspaceTombstones): Promise<void>;
}
