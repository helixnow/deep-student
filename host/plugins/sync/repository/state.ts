/**
 * 同步状态存储（`state.rs` 移植）。
 *
 * 连接由 F3 `ctx.storage.openFile(paths.syncStateDatabase, { profile: 'plain' })`
 * 打开并完成建表，之后所有操作复用同一连接（等价 Rust `SyncStateStore` 的
 * `Arc<Mutex<Connection>>`）。
 */
import type { DatabaseHandle, SqlExecutor, StorageService } from '../../../platform/storage/api.ts';
import { SyncError } from '../src/errors.ts';
import { toRfc3339 as nowRfc3339 } from '../../../platform/time/index.ts';

const DEFAULT_INSTANCE_ID = 'default';

/** `SyncStateStore::init` (state.rs:59-117). Reused by the pre-storage provider. */
export const SYNC_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS upload_seq (
      instance_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS consume_cursor (
      instance_id TEXT NOT NULL,
      uploader_device_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, uploader_device_id)
  );
  CREATE TABLE IF NOT EXISTS legacy_processed_key (
      instance_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, object_key)
  );
  CREATE TABLE IF NOT EXISTS tombstone_watermark (
      instance_id TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_applied_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, source_device_id, kind)
  );
  CREATE TABLE IF NOT EXISTS tombstone_event_publish (
      instance_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, device_id, kind, operation_id),
      UNIQUE (instance_id, device_id, kind, seq)
  );
  CREATE TABLE IF NOT EXISTS instance_binding (
      instance_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint_hint TEXT NOT NULL,
      bound_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_history (
      old_device_id TEXT NOT NULL,
      new_device_id TEXT NOT NULL,
      rotated_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (old_device_id, new_device_id)
  );
`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

/** `reset_default_after_local_purge` 清空顺序（state.rs:538-547），`upload_seq` 保留。 */
export const PURGE_RESET_TABLES: readonly string[] = [
  'consume_cursor',
  'legacy_processed_key',
  'tombstone_watermark',
  'instance_binding',
  'device_history',
];

function toI64(value: bigint): bigint {
  return value > 9223372036854775807n ? 9223372036854775807n : value;
}

export class SyncStateStore {
  private readonly db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.db = db;
    try {
      db.exec(SYNC_STATE_SCHEMA);
    } catch (error) {
      databaseError(`初始化 sync_state.db 失败: ${message(error)}`);
    }
  }

  static defaultInstanceId(): string {
    return DEFAULT_INSTANCE_ID;
  }

  /** `open_default`：由调用方提供 `ctx.storage` 与 `paths.syncStateDatabase`。 */
  static openDefault(storage: StorageService, path: string): SyncStateStore {
    let db: DatabaseHandle;
    try {
      db = storage.openFile(path, { profile: 'plain' });
    } catch (error) {
      databaseError(`打开 sync_state.db 失败: ${message(error)}`);
    }
    return new SyncStateStore(db);
  }

  bindInstance(instanceId: string, provider: string, endpointHint: string): void {
    let existing;
    try {
      existing = this.db.get<{ provider: string; endpoint_hint: string }>(
        'SELECT provider, endpoint_hint FROM instance_binding WHERE instance_id=?1',
        [instanceId],
      );
    } catch (error) {
      databaseError(`读取实例绑定失败: ${message(error)}`);
    }
    if (existing !== undefined) {
      if (existing.provider !== provider || existing.endpoint_hint !== endpointHint) {
        throw new SyncError(
          `Network error: 云同步实例绑定不匹配：远端 instance_id=${instanceId} 之前绑定到 ${existing.provider} / ${existing.endpoint_hint}，当前为 ${provider} / ${endpointHint}。请重置同步基线或确认这是同一份云端数据后再继续。`,
        );
      }
      return;
    }
    try {
      this.db.run(
        `INSERT INTO instance_binding(instance_id, provider, endpoint_hint, bound_at)
         VALUES(?1, ?2, ?3, ?4)`,
        [instanceId, provider, endpointHint, nowRfc3339()],
      );
    } catch (error) {
      databaseError(`写入实例绑定失败: ${message(error)}`);
    }
  }

  getTombstoneWatermark(instanceId: string, sourceDeviceId: string, kind: string): bigint {
    let watermark;
    try {
      watermark = this.db.pluck<number | bigint | null>(
        `SELECT last_applied_offset FROM tombstone_watermark
         WHERE instance_id=?1 AND source_device_id=?2 AND kind=?3`,
        [instanceId, sourceDeviceId, kind],
      );
    } catch (error) {
      databaseError(`读取 tombstone 水位失败: ${message(error)}`);
    }
    return BigInt(Math.max(0, Number(watermark ?? 0)));
  }

  setTombstoneWatermark(
    instanceId: string,
    sourceDeviceId: string,
    kind: string,
    lastAppliedOffset: bigint,
  ): void {
    try {
      this.db.run(
        `INSERT INTO tombstone_watermark(instance_id, source_device_id, kind, last_applied_offset, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(instance_id, source_device_id, kind)
         DO UPDATE SET last_applied_offset=max(tombstone_watermark.last_applied_offset, excluded.last_applied_offset),
                       updated_at=excluded.updated_at`,
        [instanceId, sourceDeviceId, kind, toI64(lastAppliedOffset), nowRfc3339()],
      );
    } catch (error) {
      databaseError(`写入 tombstone 水位失败: ${message(error)}`);
    }
  }

  reserveTombstoneEventSeq(
    instanceId: string,
    deviceId: string,
    kind: string,
    operationId: string,
    cloudMaxSeq: bigint,
  ): bigint {
    return this.reserveTombstoneEventSeqWithExisting(
      instanceId,
      deviceId,
      kind,
      operationId,
      cloudMaxSeq,
      null,
    );
  }

  reserveTombstoneEventSeqWithExisting(
    instanceId: string,
    deviceId: string,
    kind: string,
    operationId: string,
    cloudMaxSeq: bigint,
    cloudExistingSeq: bigint | null,
  ): bigint {
    try {
      return this.db.transaction(tx => {
        const existing = tx.pluck<number | bigint | null>(
          `SELECT seq FROM tombstone_event_publish
           WHERE instance_id=?1 AND device_id=?2 AND kind=?3 AND operation_id=?4`,
          [instanceId, deviceId, kind, operationId],
        );
        if (existing !== null && existing !== undefined) {
          return BigInt(Math.max(0, Number(existing)));
        }
        const localMax = tx.pluck<number | bigint | null>(
          `SELECT COALESCE(MAX(seq), 0) FROM tombstone_event_publish
           WHERE instance_id=?1 AND device_id=?2 AND kind=?3`,
          [instanceId, deviceId, kind],
        ) ?? 0;
        const next = cloudExistingSeq !== null && cloudExistingSeq > 0n
          ? toI64(cloudExistingSeq)
          : (BigInt(Number(localMax)) > toI64(cloudMaxSeq) ? BigInt(Number(localMax)) : toI64(cloudMaxSeq)) + 1n;
        tx.run(
          `INSERT INTO tombstone_event_publish
           (instance_id, device_id, kind, operation_id, seq, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [instanceId, deviceId, kind, operationId, next, nowRfc3339()],
        );
        return next < 0n ? 0n : next;
      }, { behavior: 'immediate' });
    } catch (error) {
      if (error instanceof SyncError) throw error;
      databaseError(`保留 tombstone 事件序号失败: ${message(error)}`);
    }
  }

  deviceRotationsForNew(newDeviceId: string): Array<[string, string]> {
    let rows;
    try {
      rows = this.db.all<{ old_device_id: string; reason: string }>(
        'SELECT old_device_id, reason FROM device_history WHERE new_device_id=?1',
        [newDeviceId],
      );
    } catch (error) {
      databaseError(`读取设备轮换历史失败: ${message(error)}`);
    }
    return rows.map(row => [row.old_device_id, row.reason]);
  }

  nextUploadSeq(instanceId: string, deviceId: string, cloudMaxSeq: bigint): bigint {
    let local;
    try {
      local = this.db.pluck<number | bigint | null>(
        'SELECT last_seq FROM upload_seq WHERE instance_id=?1 AND device_id=?2',
        [instanceId, deviceId],
      );
    } catch (error) {
      databaseError(`读取上传序号失败: ${message(error)}`);
    }
    const localValue = BigInt(Number(local ?? 0));
    const max = localValue > toI64(cloudMaxSeq) ? localValue : toI64(cloudMaxSeq);
    return max + 1n;
  }

  markPublishedSeq(instanceId: string, deviceId: string, seq: bigint): void {
    try {
      this.db.run(
        `INSERT INTO upload_seq(instance_id, device_id, last_seq, updated_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(instance_id, device_id)
         DO UPDATE SET last_seq=max(upload_seq.last_seq, excluded.last_seq),
                       updated_at=excluded.updated_at`,
        [instanceId, deviceId, toI64(seq), nowRfc3339()],
      );
    } catch (error) {
      databaseError(`写入已发布上传序号失败: ${message(error)}`);
    }
  }

  publishedMaxSeq(instanceId: string, deviceId: string): bigint {
    let seq;
    try {
      seq = this.db.pluck<number | bigint | null>(
        'SELECT last_seq FROM upload_seq WHERE instance_id=?1 AND device_id=?2',
        [instanceId, deviceId],
      );
    } catch (error) {
      databaseError(`读取发布序号失败: ${message(error)}`);
    }
    return BigInt(Math.max(0, Number(seq ?? 0)));
  }

  getCursor(instanceId: string, uploaderDeviceId: string): bigint {
    let seq;
    try {
      seq = this.db.pluck<number | bigint | null>(
        'SELECT last_seq FROM consume_cursor WHERE instance_id=?1 AND uploader_device_id=?2',
        [instanceId, uploaderDeviceId],
      );
    } catch (error) {
      databaseError(`读取消费游标失败: ${message(error)}`);
    }
    return BigInt(Math.max(0, Number(seq ?? 0)));
  }

  setCursor(instanceId: string, uploaderDeviceId: string, lastSeq: bigint): void {
    try {
      this.db.run(
        `INSERT INTO consume_cursor(instance_id, uploader_device_id, last_seq, updated_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(instance_id, uploader_device_id)
         DO UPDATE SET last_seq=max(consume_cursor.last_seq, excluded.last_seq),
                       updated_at=excluded.updated_at`,
        [instanceId, uploaderDeviceId, toI64(lastSeq), nowRfc3339()],
      );
    } catch (error) {
      databaseError(`写入消费游标失败: ${message(error)}`);
    }
  }

  cursors(instanceId: string): Map<string, bigint> {
    let rows;
    try {
      rows = this.db.all<{ uploader_device_id: string; last_seq: number | bigint }>(
        'SELECT uploader_device_id, last_seq FROM consume_cursor WHERE instance_id=?1',
        [instanceId],
      );
    } catch (error) {
      databaseError(`读取消费游标失败: ${message(error)}`);
    }
    const result = new Map<string, bigint>();
    for (const row of rows) result.set(row.uploader_device_id, BigInt(Math.max(0, Number(row.last_seq))));
    return result;
  }

  isLegacyProcessed(instanceId: string, objectKey: string): boolean {
    try {
      return this.db.pluck(
        'SELECT 1 FROM legacy_processed_key WHERE instance_id=?1 AND object_key=?2',
        [instanceId, objectKey],
      ) !== undefined;
    } catch (error) {
      databaseError(`读取 legacy processed key 失败: ${message(error)}`);
    }
  }

  markLegacyProcessed(instanceId: string, objectKey: string): void {
    try {
      this.db.run(
        `INSERT OR IGNORE INTO legacy_processed_key(instance_id, object_key, processed_at)
         VALUES(?1, ?2, ?3)`,
        [instanceId, objectKey, nowRfc3339()],
      );
    } catch (error) {
      databaseError(`写入 legacy processed key 失败: ${message(error)}`);
    }
  }

  recordDeviceRotation(oldDeviceId: string, newDeviceId: string, reason: string): void {
    try {
      this.db.transaction(tx => {
        const now = nowRfc3339();
        tx.run(
          `INSERT OR REPLACE INTO device_history(old_device_id, new_device_id, rotated_at, reason)
           VALUES(?1, ?2, ?3, ?4)`,
          [oldDeviceId, newDeviceId, now, reason],
        );
        tx.run('UPDATE consume_cursor SET last_seq=0, updated_at=?1', [now]);
        tx.run('DELETE FROM legacy_processed_key');
        tx.run('DELETE FROM tombstone_watermark');
      }, { behavior: 'immediate' });
    } catch (error) {
      if (error instanceof SyncError) throw error;
      databaseError(`提交设备轮换事务失败: ${message(error)}`);
    }
  }

  /** `reset_default_after_local_purge`：保留 upload_seq。 */
  static resetDefaultAfterLocalPurge(storage: StorageService, path: string): void {
    const store = SyncStateStore.openDefault(storage, path);
    store.transaction(tx => {
      for (const table of PURGE_RESET_TABLES) {
        tx.run(`DELETE FROM ${table}`);
      }
    });
  }

  private transaction(fn: (tx: SqlExecutor) => void): void {
    try {
      this.db.transaction(fn, { behavior: 'immediate' });
    } catch (error) {
      if (error instanceof SyncError) throw error;
      databaseError(`提交清空同步基线事务失败: ${message(error)}`);
    }
  }
}
