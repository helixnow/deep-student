/**
 * `state.rs:17-553` `SyncStateStore` 的 TS 实现。
 *
 * 与 Rust 的差异只在连接来源：Rust `open_default()` 自己解析
 * `dirs::data_local_dir()/deep-student/sync/sync_state.db` 并建表；这里由 F3
 * `ctx.storage.database('sync_state')` 提供同一文件（PRAGMA busy_timeout 5000）。
 * 插件传入打开函数：Rust 只在同步命令内 `open_default()`，所以首次读写 state 时
 * 才打开并执行同一份 `CREATE TABLE IF NOT EXISTS`；直接传入句柄时构造即建表。
 */
import type { DatabaseHandle, SqlExecutor, TransactionOptions, SyncTransaction } from '../../../platform/storage/api.ts';
import type { SyncStateStore } from '../api.ts';
import { databaseError, networkError } from './errors.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import {
  PURGE_RESET_TABLES,
  deleteAllFromTable,
  deleteAllLegacyProcessed,
  deleteAllTombstoneWatermarks,
  initSyncStateSchema,
  insertDeviceRotation,
  insertEventSeq,
  insertInstanceBinding,
  insertLegacyProcessed,
  resetConsumeCursors,
  selectCursor,
  selectCursors,
  selectDeviceRotations,
  selectEventMaxSeq,
  selectEventSeq,
  selectInstanceBinding,
  selectLegacyProcessed,
  selectTombstoneWatermark,
  selectUploadSeq,
  stateRows,
  upsertCursor,
  upsertTombstoneWatermark,
  upsertUploadSeq,
} from '../repository/state.ts';

const DEFAULT_INSTANCE_ID = 'default';
const I64_MAX = 9_223_372_036_854_775_807n;

/** `i64::try_from(u64).unwrap_or(i64::MAX)`。 */
export function toI64(value: bigint): bigint {
  return value > I64_MAX ? I64_MAX : value;
}

/** `i64::max(0) as u64`。 */
export function fromI64(value: number | bigint): bigint {
  const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  return big > 0n ? big : 0n;
}

/** `i64::saturating_add(1)`。 */
function saturatingAddOne(value: bigint): bigint {
  return value >= I64_MAX ? I64_MAX : value + 1n;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SqliteSyncStateStore implements SyncStateStore {
  private handle: DatabaseHandle | undefined;
  private readonly open: (() => DatabaseHandle) | undefined;

  constructor(source: DatabaseHandle | (() => DatabaseHandle)) {
    if (typeof source === 'function') {
      this.open = source;
    } else {
      initSyncStateSchema(source);
      this.handle = source;
    }
  }

  /** `open_default()` 的打开与建表（state.rs:31-37）；失败不缓存，下次调用重新打开。 */
  private get _db(): DatabaseHandle {
    if (this.handle !== undefined) return this.handle;
    let db: DatabaseHandle;
    try {
      db = this.open!();
    } catch (error) {
      if (isOwnError(error)) throw error;
      databaseError(`打开 sync_state.db 失败: ${errorMessage(error)}`);
    }
    initSyncStateSchema(db);
    this.handle = db;
    return db;
  }

  static defaultInstanceId(): string {
    return DEFAULT_INSTANCE_ID;
  }

  bindInstance(instanceId: string, provider: string, endpointHint: string): void {
    const existing = guard('读取实例绑定失败', () =>
      this._db.get(selectInstanceBinding, [instanceId]));
    if (existing !== undefined) {
      if (existing.provider !== provider || existing.endpoint_hint !== endpointHint) {
        networkError(
          `云同步实例绑定不匹配：远端 instance_id=${instanceId} 之前绑定到 ${existing.provider} / ` +
          `${existing.endpoint_hint}，当前为 ${provider} / ${endpointHint}。` +
          '请重置同步基线或确认这是同一份云端数据后再继续。',
        );
      }
      return;
    }
    guard('写入实例绑定失败', () =>
      this._db.run(insertInstanceBinding, [instanceId, provider, endpointHint, toRfc3339()]));
  }

  getTombstoneWatermark(instanceId: string, sourceDeviceId: string, kind: string): bigint {
    const row = guard('读取 tombstone 水位失败', () =>
      this._db.get(selectTombstoneWatermark, [instanceId, sourceDeviceId, kind]));
    return row === undefined ? 0n : fromI64(row.last_applied_offset);
  }

  setTombstoneWatermark(
    instanceId: string,
    sourceDeviceId: string,
    kind: string,
    lastAppliedOffset: bigint,
  ): void {
    guard('写入 tombstone 水位失败', () =>
      this._db.run(upsertTombstoneWatermark, [
        instanceId, sourceDeviceId, kind, toI64(lastAppliedOffset), toRfc3339(),
      ]));
  }

  reserveTombstoneEventSeq(
    instanceId: string,
    deviceId: string,
    kind: string,
    operationId: string,
    cloudMaxSeq: bigint,
  ): bigint {
    return this.reserveTombstoneEventSeqWithExisting(
      instanceId, deviceId, kind, operationId, cloudMaxSeq, null,
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
    // DEFERRED 读→写升级在争用下会立即失败（绕过 busy_timeout）；
    // 先取写者（BEGIN IMMEDIATE）再读，与 Rust 注释一致。
    const next = stateTransaction(this._db, ' tombstone 事件序号', tx => {
      const existing = readEventSeq(tx, instanceId, deviceId, kind, operationId);
      if (existing !== null) return existing;
      const localMax = guard('读取 tombstone 最大序号失败', () =>
        tx.get(selectEventMaxSeq, [instanceId, deviceId, kind]));
      const local = fromI64(localMax?.max_seq ?? 0);
      const computed = cloudExistingSeq !== null && cloudExistingSeq > 0n
        ? toI64(cloudExistingSeq)
        : saturatingAddOne(local > toI64(cloudMaxSeq) ? local : toI64(cloudMaxSeq));
      guard('保留 tombstone 事件序号失败', () =>
        tx.run(insertEventSeq, [
          instanceId, deviceId, kind, operationId, computed, toRfc3339(),
        ]));
      return computed;
    }, { behavior: 'immediate' });
    return fromI64(next);
  }

  deviceRotationsForNew(newDeviceId: string): [string, string][] {
    const rows = stateRows(this._db, selectDeviceRotations, [newDeviceId], {
      prepare: '读取设备轮换历史失败', query: '查询设备轮换历史失败', row: '解析设备轮换历史失败',
    });
    const result: [string, string][] = [];
    for (const row of rows) {
      result.push(guard('解析设备轮换历史失败', () => [
        textColumn(row.old_device_id, 0, 'old_device_id'),
        textColumn(row.reason, 1, 'reason'),
      ]));
    }
    return result;
  }

  nextUploadSeq(instanceId: string, deviceId: string, cloudMaxSeq: bigint): bigint {
    const row = guard('读取上传序号失败', () =>
      this._db.get(selectUploadSeq, [instanceId, deviceId]));
    const local = row === undefined ? 0n : fromI64(row.last_seq);
    const baseline = local > toI64(cloudMaxSeq) ? local : toI64(cloudMaxSeq);
    return saturatingAddOne(baseline);
  }

  markPublishedSeq(instanceId: string, deviceId: string, seq: bigint): void {
    guard('写入已发布上传序号失败', () =>
      this._db.run(upsertUploadSeq, [instanceId, deviceId, toI64(seq), toRfc3339()]));
  }

  publishedMaxSeq(instanceId: string, deviceId: string): bigint {
    const row = guard('读取发布序号失败', () =>
      this._db.get(selectUploadSeq, [instanceId, deviceId]));
    return row === undefined ? 0n : fromI64(row.last_seq);
  }

  getCursor(instanceId: string, uploaderDeviceId: string): bigint {
    const row = guard('读取消费游标失败', () =>
      this._db.get(selectCursor, [instanceId, uploaderDeviceId]));
    return row === undefined ? 0n : fromI64(row.last_seq);
  }

  setCursor(instanceId: string, uploaderDeviceId: string, lastSeq: bigint): void {
    guard('写入消费游标失败', () =>
      this._db.run(upsertCursor, [instanceId, uploaderDeviceId, toI64(lastSeq), toRfc3339()]));
  }

  cursors(instanceId: string): Map<string, bigint> {
    const rows = stateRows(this._db, selectCursors, [instanceId], {
      prepare: '读取消费游标失败', query: '查询消费游标失败', row: '遍历消费游标失败',
    });
    const out = new Map<string, bigint>();
    for (const row of rows) {
      const device = guard('读取游标设备失败', () => textColumn(row.uploader_device_id, 0, 'uploader_device_id'));
      const seq = guard('读取游标序号失败', () => integerColumn(row.last_seq, 1, 'last_seq'));
      out.set(device, fromI64(seq));
    }
    return out;
  }

  isLegacyProcessed(instanceId: string, objectKey: string): boolean {
    const row = guard('读取 legacy processed key 失败', () =>
      this._db.get(selectLegacyProcessed, [instanceId, objectKey]));
    return row !== undefined;
  }

  markLegacyProcessed(instanceId: string, objectKey: string): void {
    guard('写入 legacy processed key 失败', () =>
      this._db.run(insertLegacyProcessed, [instanceId, objectKey, toRfc3339()]));
  }

  recordDeviceRotation(oldDeviceId: string, newDeviceId: string, reason: string): void {
    stateTransaction(this._db, '设备轮换', tx => {
      guard('记录设备轮换失败', () =>
        tx.run(insertDeviceRotation, [oldDeviceId, newDeviceId, toRfc3339(), reason]));
      guard('重置消费游标失败', () => tx.run(resetConsumeCursors, [toRfc3339()]));
      guard('清理 legacy processed key 失败', () => tx.run(deleteAllLegacyProcessed));
      guard('重置 tombstone 水位失败', () => tx.run(deleteAllTombstoneWatermarks));
    });
  }

  resetDefaultAfterLocalPurge(): void {
    // Rust 每次调用都 `open_default()`（独立连接）；这里复用句柄并重新执行建表，
    // 保证"库被外部重建/首次调用"两种情形都与 Rust 相同。
    initSyncStateSchema(this._db);
    stateTransaction(this._db, '清空同步基线', tx => {
      for (const table of PURGE_RESET_TABLES) {
        guard(`清空同步状态表 ${table} 失败`, () => deleteAllFromTable(tx, table));
      }
    });
  }
}

/** F3 owns BEGIN/COMMIT/rollback; the callback boundary identifies a COMMIT failure. */
function stateTransaction<T>(
  db: DatabaseHandle,
  label: string,
  body: (tx: SyncTransaction) => T,
  options?: TransactionOptions,
): T {
  let phase = '开始';
  try {
    return db.transaction(tx => {
      const result = body(tx); // Each statement supplies its own Rust error context.
      phase = '提交';
      return result;
    }, options);
  } catch (error) {
    if (isOwnError(error)) throw error;
    return databaseError(`${phase}${label}事务失败: ${errorMessage(error)}`);
  }
}

function readEventSeq(
  tx: SqlExecutor,
  instanceId: string,
  deviceId: string,
  kind: string,
  operationId: string,
): bigint | null {
  const row = guard('读取 tombstone 事件序号失败', () =>
    tx.get(selectEventSeq, [instanceId, deviceId, kind, operationId]));
  return row === undefined ? null : fromI64(row.seq);
}

/** rusqlite 0.40.1 error.rs::InvalidColumnType, with safeIntegers preserving SQLite INTEGER vs REAL. */
function invalidColumn(value: unknown, index: number, name: string): never {
  const type = value === null ? 'Null'
    : typeof value === 'string' ? 'Text'
      : typeof value === 'bigint' ? 'Integer'
        : typeof value === 'number' ? 'Real' : 'Blob';
  throw new Error(`Invalid column type ${type} at index: ${index}, name: ${name}`);
}

function textColumn(value: unknown, index: number, name: string): string {
  return typeof value === 'string' ? value : invalidColumn(value, index, name);
}

function integerColumn(value: unknown, index: number, name: string): bigint {
  return typeof value === 'bigint' ? value : invalidColumn(value, index, name);
}

/** 只把本模块抛出的 `SyncSupportError` 透传，其余异常按 Rust 的失败上下文重新包装。 */
function isOwnError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SyncSupportError';
}

function guard<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isOwnError(error)) throw error;
    databaseError(`${context}: ${errorMessage(error)}`);
  }
}
