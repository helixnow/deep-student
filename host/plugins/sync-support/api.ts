/**
 * `syncSupport` —— 同步引擎（L20 `dstu_sync::data_governance::sync`）中相对独立的支撑模块。
 *
 * Rust 来源（只读）：
 * - `crates/dstu-sync/src/data_governance/sync/tombstone.rs`（清单 + 不可变事件 + 水位 + 本地应用）
 * - `crates/dstu-sync/src/data_governance/sync/note_history.rs`（笔记历史依赖收集与不可变版本应用）
 * - `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs`（派生计数重算）
 * - `crates/dstu-sync/src/data_governance/sync/state.rs`（sync_state.db 持久化）
 * - `crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs`（记录级冲突解析）
 *
 * 消费方：L20 `dstu.sync` 的 SyncManager（`ctx.syncSupport`）。
 */
import type {} from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type { NotesService } from '../notes/api.ts';
import type { PomodoroRepository } from '../vfs-repos/api.ts';
import type { ChangeOperation, SyncChangeWithData as SyncChange } from '../sync/api.ts';
import type { WireJson } from './src/json.ts';
import type { TombstoneLocalFiles } from './src/tombstone-files.ts';

export type { TombstoneLocalFiles };

export type { ChangeOperation };
/** Internal service payload: bigint preserves serde_json i64/u64; not an IPC value. */
export type JsonValue = WireJson;
export interface SyncChangeWithData extends Omit<SyncChange, 'data'> {
  data: JsonValue | null;
}
export type { NotesService };

/** 五个同步支撑模块；按插件架构统一 lowerCamelCase 服务名。 */
export const syncSupportService = { name: 'syncSupport', version: '1.0.0' } as const;

// ------------------------------------------------------------------ 错误

/**
 * `sync/mod.rs:400-475` `SyncError` 中本 lane 实际产生的变体。
 *
 * `message` 与 Rust `Display` 逐字一致（`Database error: …` / `Network error: …` /
 * `Clock drift suspected: …`），便于 L20 直接作为命令 `Err(String)` 的文案。
 */
export type { SyncSupportErrorKind } from './src/errors.ts';

export { SyncSupportError, isClockDriftSuspected, clockDriftSuspected } from './src/errors.ts';

// ------------------------------------------------------------------ 编码

/**
 * `tombstone.rs:48-64` `PayloadCodec`：tombstone 清单也可 E2EE。
 *
 * 生产实现由 L20 的 SyncManager 提供（有密码时走 DSBK 容器），`plainCodec` 保留明文行为。
 */
export interface PayloadCodec {
  encode(plaintext: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decode(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Existing synchronous codecs remain supported, including synchronous decodeTombstoneFile. */
export interface SyncPayloadCodec extends PayloadCodec {
  encode(plaintext: Uint8Array): Uint8Array;
  decode(data: Uint8Array): Uint8Array;
}

/** F4 DSBK sessions and L20's E2EE codec can be passed directly to all tombstone I/O ports. */
export interface AsyncPayloadCodec extends PayloadCodec {
  encode(plaintext: Uint8Array): Promise<Uint8Array>;
  decode(data: Uint8Array): Promise<Uint8Array>;
}

/** `PlainCodec`：永不加密（单元测试与向后兼容场景）。 */
export { plainCodec } from './src/codec.ts';

// ------------------------------------------------------------------ tombstone 数据形状

/** `tombstone.rs:75-92`。`seq` 是 Rust `u64`。 */
export interface TombstoneEvent {
  format_version: number;
  device_id: string;
  seq: bigint;
  operation_id: string;
  kind: string;
  object_id: string;
  deleted_at: string;
  size?: bigint | number | null;
  relative_path?: string | null;
  payload_hash: string;
}

/** `tombstone.rs:101-109`。`size` 是 Rust `Option<u64>`。 */
export interface BlobTombstoneEntry {
  deleted_at: string;
  device_id: string;
  size?: bigint | number | null;
  relative_path?: string | null;
}

/** `tombstone.rs:111-117`。`entries` 是 Rust `HashMap`，JSON 对象表示。 */
export interface BlobTombstones {
  entries: Record<string, BlobTombstoneEntry>;
  updated_at: string;
}

/** `tombstone.rs:119-125`。 */
export interface AssetTombstoneEntry {
  deleted_at: string;
  device_id: string;
  size?: bigint | number | null;
}

/** `tombstone.rs:127-133`。 */
export interface AssetTombstones {
  entries: Record<string, AssetTombstoneEntry>;
  updated_at: string;
}

/** `tombstone.rs:135-139`。 */
export interface WorkspaceTombstoneEntry {
  deleted_at: string;
  device_id: string;
}

/** `tombstone.rs:141-147`。 */
export interface WorkspaceTombstones {
  entries: Record<string, WorkspaceTombstoneEntry>;
  updated_at: string;
}

/** `tombstone.rs:811-815` `TombstoneWatermarkAdvance`。 */
export interface TombstoneWatermarkAdvance {
  source_device_id: string;
  last_applied_offset: bigint;
}

/** 水位来源 → 已应用偏移（Rust `SyncStateStore::get_tombstone_watermark`）。 */
export type TombstoneWatermarkLookup = (sourceDeviceId: string) => bigint;

/** `cloud_storage::traits::ListOutcome`（`api.ts` of L23 已发布同一形状）。 */
export interface TombstoneListOutcome {
  files: readonly { key: string; size: number | bigint; last_modified?: unknown; lastModified?: string; etag?: string | null }[];
  truncated: boolean;
}

/**
 * 首次发布的最小存储接口，保留 snake_case 方法名。
 * L23 的 camelCase `CloudStorage` 通过新增的 `adaptTombstoneStorage` 接入。
 */
export interface TombstoneStorage {
  instance_binding_hint(): string;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list_outcome(prefix: string): Promise<TombstoneListOutcome>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<unknown | null>;
}

/** L23 `CloudStorage` 结构上满足；仅增补，不改已发布的存储接口。 */
export interface ProviderTombstoneStorage extends Omit<TombstoneStorage, 'instance_binding_hint' | 'list_outcome'> {
  instanceBindingHint(): string;
  listOutcome(prefix: string): Promise<TombstoneListOutcome>;
}

export { adaptTombstoneStorage } from './src/storage.ts';

// ------------------------------------------------------------------ 服务：同步状态

/**
 * `state.rs:17-553` `SyncStateStore`。所有方法同步（Rust 用 `Mutex<Connection>`，
 * here = F3 `DatabaseHandle`，better-sqlite3 同步执行）。
 *
 * 与 Rust 的差异：`open_default` 的路径解析由 F3 storage 的 `sync_state` 注册库承担。
 */
export interface SyncStateStore {
  bindInstance(instanceId: string, provider: string, endpointHint: string): void;
  getTombstoneWatermark(instanceId: string, sourceDeviceId: string, kind: string): bigint;
  setTombstoneWatermark(instanceId: string, sourceDeviceId: string, kind: string, lastAppliedOffset: bigint): void;
  reserveTombstoneEventSeq(
    instanceId: string,
    deviceId: string,
    kind: string,
    operationId: string,
    cloudMaxSeq: bigint,
  ): bigint;
  reserveTombstoneEventSeqWithExisting(
    instanceId: string,
    deviceId: string,
    kind: string,
    operationId: string,
    cloudMaxSeq: bigint,
    cloudExistingSeq: bigint | null,
  ): bigint;
  deviceRotationsForNew(newDeviceId: string): [string, string][];
  nextUploadSeq(instanceId: string, deviceId: string, cloudMaxSeq: bigint): bigint;
  markPublishedSeq(instanceId: string, deviceId: string, seq: bigint): void;
  publishedMaxSeq(instanceId: string, deviceId: string): bigint;
  getCursor(instanceId: string, uploaderDeviceId: string): bigint;
  setCursor(instanceId: string, uploaderDeviceId: string, lastSeq: bigint): void;
  cursors(instanceId: string): Map<string, bigint>;
  isLegacyProcessed(instanceId: string, objectKey: string): boolean;
  markLegacyProcessed(instanceId: string, objectKey: string): void;
  recordDeviceRotation(oldDeviceId: string, newDeviceId: string, reason: string): void;
  /**
   * `state.rs:528-552`：清空本机数据后重置所有"已消费"状态（`upload_seq` 故意保留）。
   * 对应 F2 启动时通过 `storageStartupSync` 调用的 `reset_default_after_local_purge`。
   */
  resetDefaultAfterLocalPurge(): void;
}

// ------------------------------------------------------------------ 服务：tombstone

/**
 * `tombstone.rs` 公开面。异步方法与 Rust 一样直接接收 `storage`/`codec`
 * （不让服务持有云存储实例，L20 每次同步按配置创建）。
 */
export interface TombstoneSupport {
  readonly LEGACY_BLOB_TOMBSTONE_KEY: string;
  readonly LEGACY_ASSET_TOMBSTONE_KEY: string;
  readonly LEGACY_WS_TOMBSTONE_KEY: string;
  readonly BLOB_TOMBSTONE_PREFIX: string;
  readonly ASSET_TOMBSTONE_PREFIX: string;
  readonly WS_TOMBSTONE_PREFIX: string;
  readonly TOMBSTONE_EVENTS_PREFIX: string;
  readonly DEFAULT_TOMBSTONE_RETENTION_DAYS: number;

  deviceIdShortHash(deviceId: string): string;
  deviceComponent(deviceId: string): string;
  tombstoneDevicePathId(deviceId: string): string;
  eventOperationId(kind: string, deviceId: string, objectId: string, deletedAt: string): string;
  eventPayloadHash(event: TombstoneEvent): string;
  eventDevicePrefix(kind: string, deviceId: string): string;
  eventDeviceLegacyPrefix(kind: string, deviceId: string): string;
  eventKey(event: TombstoneEvent): string;
  eventLegacyKey(event: TombstoneEvent): string;
  eventKeyMatches(event: TombstoneEvent, key: string): boolean;
  eventSeqFromKey(key: string): bigint | null;
  eventOperationFromKey(key: string): string | null;
  blobDeviceTombstoneKey(deviceId: string): string;
  blobDeviceTombstoneLegacyKey(deviceId: string): string;
  assetDeviceTombstoneKey(deviceId: string): string;
  assetDeviceTombstoneLegacyKey(deviceId: string): string;
  workspaceDeviceTombstoneKey(deviceId: string): string;
  workspaceDeviceTombstoneLegacyKey(deviceId: string): string;
  deletedAtIsNewer(candidate: string, current: string): boolean;
  mergeBlobTombstones(destination: BlobTombstones, source: BlobTombstones): void;
  mergeAssetTombstones(destination: AssetTombstones, source: AssetTombstones): void;
  mergeWorkspaceTombstones(destination: WorkspaceTombstones, source: WorkspaceTombstones): void;
  /** 经注入的本地文件端口（`ctx.files`）读取 mtime；无法判定时 false。 */
  pathModifiedAfter(path: string, timestamp: string): Promise<boolean>;
  validateTombstoneTimestamp(timestamp: string, label: string): void;
  tombstoneDeletedAtUsable(deletedAt: string, label: string): boolean;
  /** Raw JSON (Rust `serde_json::from_slice`); callers normalize each manifest shape. */
  decodeTombstoneFile(codec: SyncPayloadCodec, bytes: Uint8Array, label: string): unknown | null;
  decodeTombstoneFile(codec: AsyncPayloadCodec, bytes: Uint8Array, label: string): Promise<unknown | null>;
  decodeTombstoneFile(codec: PayloadCodec, bytes: Uint8Array, label: string): unknown | null | Promise<unknown | null>;
  tombstonePathStem(prefix: string, key: string): string;
  tombstonePathIdMatchesDevice(pathId: string, deviceId: string): boolean;
  sourceDeviceFromTombstoneEntries(
    key: string,
    prefix: string,
    deviceIds: Iterable<string | null | undefined>,
  ): string;
  tombstoneOffsetFromDeletedAt(deletedAt: string): bigint;
  filterBlobTombstonesAfter(manifest: BlobTombstones, watermark: bigint): [BlobTombstones, bigint];
  filterAssetTombstonesAfter(manifest: AssetTombstones, watermark: bigint): [AssetTombstones, bigint];
  filterWorkspaceTombstonesAfter(manifest: WorkspaceTombstones, watermark: bigint): [WorkspaceTombstones, bigint];
  validateBlobRelativePath(blobsDir: string, hash: string, relativePath: string): Promise<string>;
  findBlobByHash(blobsDir: string, hash: string): Promise<string | null>;
  pruneTombstones<T>(entries: Map<string, T>, retentionDays: number, extractDeletedAt: (entry: T) => string): number;

  downloadBlobTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<BlobTombstones>;
  downloadBlobTombstonesAfter(
    storage: TombstoneStorage,
    codec: PayloadCodec,
    watermarkFor: TombstoneWatermarkLookup,
  ): Promise<[BlobTombstones, TombstoneWatermarkAdvance[]]>;
  downloadBlobTombstonesForDevice(storage: TombstoneStorage, codec: PayloadCodec, deviceId: string): Promise<BlobTombstones>;
  downloadAssetTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<AssetTombstones>;
  downloadAssetTombstonesAfter(
    storage: TombstoneStorage,
    codec: PayloadCodec,
    watermarkFor: TombstoneWatermarkLookup,
  ): Promise<[AssetTombstones, TombstoneWatermarkAdvance[]]>;
  downloadAssetTombstonesForDevice(storage: TombstoneStorage, codec: PayloadCodec, deviceId: string): Promise<AssetTombstones>;
  downloadWorkspaceTombstones(storage: TombstoneStorage, codec: PayloadCodec): Promise<WorkspaceTombstones>;
  downloadWorkspaceTombstonesAfter(
    storage: TombstoneStorage,
    codec: PayloadCodec,
    watermarkFor: TombstoneWatermarkLookup,
  ): Promise<[WorkspaceTombstones, TombstoneWatermarkAdvance[]]>;
  downloadWorkspaceTombstonesForDevice(
    storage: TombstoneStorage,
    codec: PayloadCodec,
    deviceId: string,
  ): Promise<WorkspaceTombstones>;

  uploadBlobTombstones(storage: TombstoneStorage, codec: PayloadCodec, deviceId: string, manifest: BlobTombstones): Promise<void>;
  uploadAssetTombstones(storage: TombstoneStorage, codec: PayloadCodec, deviceId: string, manifest: AssetTombstones): Promise<void>;
  uploadWorkspaceTombstones(
    storage: TombstoneStorage,
    codec: PayloadCodec,
    deviceId: string,
    manifest: WorkspaceTombstones,
  ): Promise<void>;

  applyBlobTombstones(
    storage: TombstoneStorage,
    tombstones: BlobTombstones,
    blobsDir: string,
    blobsCloudPrefix: string,
    deleteCloud: boolean,
  ): Promise<string[]>;
}

// ------------------------------------------------------------------ 服务：note_history

/**
 * `note_history.rs` 全部 `pub(super)` 函数。`db` 是 vfs 库的执行器；
 * 写入通过 L10 `notes.sync` / `notes.revisions`，沿用调用方的同一事务执行器。
 */
export interface NoteHistorySupport {
  /** 判断 `note_document_revisions.version_id` 列是否存在（整个模块的开关）。 */
  available(db: SqlExecutor): boolean;
  includeNoteDependencies(db: SqlExecutor, changes: SyncChangeWithData[]): void;
  prepareRelation(db: SqlExecutor, id: string, obj: Record<string, JsonValue>): void;
  retargetNoteRelations(db: SqlExecutor, noteId: string, previousResourceId: string): void;
  applyRevision(db: SqlExecutor, id: string, data: JsonValue): void;
  affectedNotes(db: SqlExecutor, table: string, id: string): string[];
  snapshotNotes(db: SqlExecutor, ids: readonly string[], source: string): void;
  validateBatchFormats(changes: readonly SyncChangeWithData[]): void;
  validateIncoming(db: SqlExecutor, table: string, id: string, data: JsonValue): void;
}

// ------------------------------------------------------------------ 服务：番茄计数

/** L10 notes.format.blocks 的已发布解析形状；关系失效由 notes.sync 在所有者内部调用。 */
export interface NoteBlockParser {
  blocks(content: string): readonly { id: string; body: string }[];
}

/** `pomodoro_counts.rs` 派生缓存重算（`todo_items.completed_pomodoros`）。 */
export interface PomodoroCountsSupport {
  changesAffectTodoPomodoroCounts(changes: readonly SyncChangeWithData[]): boolean;
  recomputeIfRelevant(db: SqlExecutor, changes: readonly SyncChangeWithData[]): void;
  recompute(db: SqlExecutor): void;
}

// ------------------------------------------------------------------ 服务：冲突解析

/** `conflict_resolver.rs:49-58`。 */
export type ConflictPolicy = 'keep_cloud' | 'keep_local' | 'keep_latest';

/** `conflict_resolver.rs:74-79`。 */
export type ConflictSide = 'local' | 'cloud';

/** `conflict_resolver.rs:60-71`。 */
export interface ConflictOutcome {
  winner: ConflictSide;
  loser: ConflictSide;
  winner_data: JsonValue;
  loser_data: JsonValue;
}

/** `conflict_resolver.rs:92-103`：`conflicts_by_table` 是 Rust `HashMap`。 */
export interface ConflictAwareApplyResult {
  applied: number;
  rejected: number;
  conflicts_saved: number;
  conflicts_by_table: Record<string, number>;
}

/** `conflict_resolver.rs:81-90`。 */
export interface ConflictRecordToSave {
  table_name: string;
  record_id: string;
  side: ConflictSide;
  data: JsonValue;
  winning_device_id?: string | null;
  losing_device_id?: string | null;
}

/**
 * `history.rs` 的快照能力（`snapshot_record_with_data` / `new_batch_id`）。
 *
 * Rust 中 `conflict_resolver` 与本模块同 crate；TS 中 `history.rs` 归 L20，
 * 因此以端口形式在调用点注入（不得静默降级：Cloud 胜覆盖前必须能落快照）。
 */
export interface SyncHistoryPort {
  newBatchId(): string;
  /** `history::snapshot_record_with_data`，`reason` = `policy_override`。 */
  snapshotRecord(
    db: SqlExecutor,
    batchId: string,
    reason: string,
    tableName: string,
    recordId: string,
    current: JsonValue | null,
  ): boolean;
}

/** `conflict_resolver.rs:111-119`。 */
export interface ConflictResolver {
  readonly historyBatchId: string;
  resolveOne(db: SqlExecutor, change: SyncChangeWithData, idColumn: string): ConflictOutcome | null;
}

/** `conflict_resolver.rs` 公开面。 */
export interface ConflictSupport {
  createResolver(policy: ConflictPolicy, history: SyncHistoryPort): ConflictResolver;
  ensureConflictTable(db: SqlExecutor): void;
  computeDataHash(data: JsonValue): string;
  saveConflictRecord(db: SqlExecutor, record: ConflictRecordToSave): boolean;
  /** `ConflictAwareApplyResult.is_clean()`。 */
  isClean(result: ConflictAwareApplyResult): boolean;
  /** `conflict_resolver.rs:518-563`：用于去重键的规范化。 */
  canonicalizeForCompare(value: JsonValue): JsonValue;
}

// ------------------------------------------------------------------ 服务

export interface SyncSupportService {
  readonly version: 1;
  readonly state: SyncStateStore;
  readonly tombstones: TombstoneSupport;
  readonly noteHistory: NoteHistorySupport;
  readonly pomodoroCounts: PomodoroCountsSupport;
  readonly conflicts: ConflictSupport;
}

/** 构造参数：state 由 F3 sync_state 库支持；notes 由 L10 提供；日志必须注入。 */
export interface SyncSupportOptions {
  state: SyncStateStore;
  notes: NotesService | (() => NotesService | undefined);
  /** L11 single-writer operation, invoked inside the caller's apply transaction. */
  pomodoros?: () => Pick<PomodoroRepository, 'recomputeCompletedPomodorosForSyncBatch'> | undefined;
  logger: { warn(message: string): void; info(message: string): void };
  /** tombstone 的本地文件端口（插件里由 `ctx.files` 支撑）；缺省时本地文件操作一律失败。 */
  localFiles?: TombstoneLocalFiles;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    syncSupport: SyncSupportService;
  }
}
