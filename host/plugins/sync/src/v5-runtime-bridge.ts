import { fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { concatBytes } from '../../../platform/util/bytes.ts';
import { utf8ByteLength } from '../../../platform/util/utf8.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import {
  computeKeyedChunkId,
  decodeObjectHeader,
  decodeShardedIndex,
  decryptFramedEntry,
  deriveObjectDek,
  encodeFramedPack,
  IndexChainManager,
  readPackEntryRange,
  type CloudStorage,
  type IndexChainState,
  type KeyringSecrets,
  type PackContext,
  type PackEntryLocation,
  type RangeReader,
  type RuntimeCloudStorageConfig,
} from '../../sync-providers/api.ts';
import { appendUnknownOp, applyRowWithColumnLifecycle, recordReceivedOp, transitionOpMaterializationState } from '../repository/v5-vaults.ts';
import {
  deleteV5ColumnVersion,
  deleteV5PendingGcKey,
  deleteV5QuarantineRecord,
  ensureV5RuntimeStateDb,
  ensureV5TargetDatabaseTables,
  getV5ChangeLogBindingSeq,
  getV5RowMetaRow,
  hasV5ChangeLogBinding,
  insertV5ChangeLogBinding,
  insertV5PendingGcKey,
  insertV5QuarantineRecord,
  insertV5RuntimeOp,
  insertV5RuntimeReceipt,
  isolateV5OversizeOutboxOps,
  listV5ColumnVersionNames,
  listV5PendingChangeLogRows,
  listV5PendingGcKeys,
  listV5PendingLocalCaptureOps,
  listV5QuarantinePayloads,
  listV5UnknownFieldRecordIds,
  listV5UnknownFieldTables,
  listV5UnpublishedOps,
  markV5OpLocalCaptured,
  markV5OpPublished,
  readV5ColumnVersion,
  readV5RuntimeSeq,
  readV5UnknownFieldsJson,
  recordV5OversizeQuarantine,
  updateOrDeleteV5UnknownFields,
  updateV5RowMetaVersions,
  updateV5RuntimeHlc,
  updateV5RuntimeSeqAndHlc,
  upsertV5ColumnVersion,
  upsertV5RowMeta,
} from '../repository/v5-runtime-bridge.ts';
import { primaryKeyColumns, tableColumnNames, tableExists } from '../repository/sqlite-values.ts';
import { getRecordData, SYNC_FIELD_DELTAS_KEY } from '../repository/record-data.ts';
import { changeLogMaxId } from '../repository/apply-refcounts.ts';
import { suppressEchoChangeLog } from '../repository/apply-shared.ts';
import { parseSyncChange, serializeSyncChange, type EngineChange } from './change-payload.ts';
import { createPairingCode, applyPairingCode, type PairingSettings } from './device-pairing.ts';
import { createDSPAIR2Pairing, createDSPAIR2Receiver, type RepoHeadAnchor } from './dspair2.ts';
import { Hlc, HlcClock } from './hlc.ts';
import { compareLwwTimestamps } from './lww.ts';
import { readUnknownFieldsForRoundTrip, type UnknownFieldVersion } from './unknown-fields.ts';
import { computeCanonicalOpHash, MultiIncarnationVersionVector, type WriterKey } from './version-vector.ts';

type Versions = Record<string, UnknownFieldVersion>;
export interface V5RuntimeOperation {
  deviceId: string; incarnationId: string; seq: bigint; change: string; versions: Versions;
}
interface ChunkReference {
  deviceId: string; incarnationId: string; seq: bigint; chunk: string; packKey: string;
  context: PackContext; location: PackEntryLocation;
}
interface RemoteHead { chain: IndexChainState; refs?: ChunkReference[]; incarnationId: string; retired?: string[][]; pendingGc?: string[] }
interface RestoredHead extends RemoteHead { refs: ChunkReference[] }
class MissingCommittedIndex extends Error {}
interface SealedObject { context: PackContext; location: PackEntryLocation; bytes: string }

/** A sparse, merged interval set; holes never advance a contiguous watermark. */
export class DeduplicatedIntervalTree {
  private writers = new Map<string, Array<[bigint, bigint]>>();
  has(writer: string, seq: bigint): boolean {
    return (this.writers.get(writer) ?? []).some(([lo, hi]) => seq >= lo && seq <= hi);
  }
  add(writer: string, seq: bigint): void {
    const ranges = [...(this.writers.get(writer) ?? []), [seq, seq] as [bigint, bigint]]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const merged: Array<[bigint, bigint]> = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1n) last[1] = last[1] > range[1] ? last[1] : range[1];
      else merged.push([...range]);
    }
    this.writers.set(writer, merged);
  }
  contiguous(writer: string): bigint {
    const first = this.writers.get(writer)?.[0];
    return first && first[0] <= 1n ? first[1] : 0n;
  }
}

/** Preserve opaque registers' original versions when an old writer edits known columns. */
export function mergeKnownRowWithUnknownVault(db: SqlExecutor, change: EngineChange, version: UnknownFieldVersion): {
  data: Record<string, DbJson>; versions: Versions;
} {
  const data = isJsonObject(change.data) ? { ...change.data } : {};
  const deltas = data[SYNC_FIELD_DELTAS_KEY];
  delete data[SYNC_FIELD_DELTAS_KEY];
  const versions: Versions = {};
  for (const [col, value] of Object.entries(data)) {
    const previous = readV5ColumnVersion(db, change.database_name ?? 'vfs', change.table_name, change.record_id, col);
    const supplied = isJsonObject(deltas) ? deltas[col] : undefined;
    if (isJsonObject(supplied) && typeof supplied.hlc === 'string' && typeof supplied.dev === 'string') {
      versions[col] = { hlc: supplied.hlc, dev: supplied.dev };
    } else if (previous && previous.value_hash === valueHash(value)) {
      versions[col] = { hlc: previous.col_hlc, dev: previous.col_dev };
    } else versions[col] = { ...version };
  }
  const opaque = readUnknownFieldsForRoundTrip(db, change.table_name, change.record_id);
  const known = new Set(tableColumnNames(db, change.table_name));
  for (const [key, value] of Object.entries(opaque.values)) if (!known.has(key)) {
    data[key] = value;
    if (!opaque.fieldDeltas[key]) throw new Error(`Opaque column lacks original version: ${key}`);
    versions[key] = opaque.fieldDeltas[key]!;
  }
  return { data, versions };
}

export function applyIncomingRowV5(db: SqlExecutor, change: EngineChange, versions: Versions): boolean {
  if (!isJsonObject(change.data)) throw new Error('V5 row payload must be an object');
  return applyRowWithColumnLifecycle(db, change.table_name, change.record_id, change, change.data, versions);
}
export function applyIncomingTombstoneV5(db: SqlExecutor, change: EngineChange): boolean {
  return applyRowWithColumnLifecycle(db, change.table_name, change.record_id, change, {}, {}, {
    hlc: change.changed_at, dev: change.source_device_id ?? '', seq: change.source_seq ?? 0n,
  });
}

/** An opaque version may already be in row_meta: equality means received, not materialized. */
export function rehydrateUnknownFieldsV5(db: DatabaseHandle, table: string, databaseName = 'vfs'): void {
  if (!tableExists(db, table)) return;
  const known = new Set(tableColumnNames(db, table));
  for (const row of listV5UnknownFieldRecordIds(db, table)) {
    db.transaction(tx => {
      const opaque = readUnknownFieldsForRoundTrip(tx, table, row.record_id);
      const meta = getV5RowMetaRow(tx, table, row.record_id);
      const stored = meta ? parseJsonLossless(meta.col_versions_json) as unknown as Versions : {};
      const data: Record<string, DbJson> = {}, versions: Versions = {};
      const compare = (a: UnknownFieldVersion, b: UnknownFieldVersion) => compareLwwTimestamps(a.hlc, a.dev, '', b.hlc, b.dev, '');
      for (const [col, version] of Object.entries(opaque.fieldDeltas)) {
        if (!known.has(col) || (stored[col] && compare(stored[col]!, version) > 0)) continue;
        if (meta?.floor_deleted_hlc && compare(version, { hlc: meta.floor_deleted_hlc, dev: meta.floor_deleted_dev ?? '' }) <= 0) continue;
        data[col] = opaque.values[col]!; versions[col] = version; delete stored[col];
      }
      if (!Object.keys(data).length) return;
      updateV5RowMetaVersions(tx, stringifyJsonLossless(stored as unknown as DbJson), table, row.record_id);
      const remaining = parseJsonLossless(readV5UnknownFieldsJson(tx, table, row.record_id)) as Record<string, DbJson>;
      for (const col of Object.keys(data)) delete remaining[col];
      updateOrDeleteV5UnknownFields(tx, table, row.record_id, remaining);
      const preLogMax = changeLogMaxId(tx);
      applyRowWithColumnLifecycle(tx, table, row.record_id, 'Update', data, versions);
      if (preLogMax !== null) suppressEchoChangeLog(tx, Math.floor(Date.now() / 1000), preLogMax);
      for (const [col, value] of Object.entries(data)) {
        const version = versions[col]!;
        upsertV5ColumnVersion(tx, databaseName, table, row.record_id, col, version.hlc, valueHash(value), version.dev);
      }
    });
  }
}

export interface SyncV5RuntimeOptions {
  repoId: string; deviceId: string; stateDb: DatabaseHandle;
  databases: ReadonlyMap<string, DatabaseHandle>;
  /** Native range reader or an explicitly adapted legacy provider. */
  storage: CloudStorage & RangeReader; secrets: KeyringSecrets; contentEpoch?: number;
  now?: () => number;
  supersededRetentionGenerations?: number;
  maxPackPlaintextBytes?: number;
}

export const MAX_V5_PACK_PLAINTEXT_BYTES = 4 * 1024 * 1024;

const encode = (value: unknown): string => stringifyJsonLossless(value as DbJson);
const decode = <T>(value: string): T => parseJsonLossless(value) as unknown as T;
const hex = (value: Uint8Array): string => toHex(value);
const valueHash = (value: DbJson): string => sha256HexSync(encode(value));
/** Uniform six-digit PIN: rejection sampling over the largest multiple of 10^6 below 2^32. */
function randomPin(): string {
  for (;;) {
    const value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (value < 4_294_000_000) return String(value % 1_000_000).padStart(6, '0');
  }
}
const writer = (op: { deviceId: string; incarnationId: string }): WriterKey => `${op.deviceId}@${op.incarnationId}`;
const cdc = { gearSeed: 'sync-v5-runtime-v1', min: 65536, avg: 262144, max: 1048576 };

/** Explicit L20/L23 bridge. Existing legacy runSync is deliberately not switched implicitly. */
export class SyncV5RuntimeCoordinator {
  readonly versionVector = new MultiIncarnationVersionVector();
  readonly intervals = new DeduplicatedIntervalTree();
  readonly incarnationId: string;
  private clock: HlcClock;
  private queue: Promise<unknown> = Promise.resolve();
  private options: SyncV5RuntimeOptions;
  constructor(options: SyncV5RuntimeOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.deviceId) || !/^[A-Za-z0-9_-]+$/.test(options.repoId)) throw new Error('Invalid repository/device ID');
    if (typeof options.storage.getRange !== 'function') throw new Error('Native V5 range reads required');
    const maxPackBytes = options.maxPackPlaintextBytes ?? MAX_V5_PACK_PLAINTEXT_BYTES;
    if (!Number.isSafeInteger(maxPackBytes) || maxPackBytes <= 0 || maxPackBytes > MAX_V5_PACK_PLAINTEXT_BYTES) throw new Error('Invalid V5 pack plaintext limit');
    this.options = options;
    if (!Number.isSafeInteger(options.supersededRetentionGenerations ?? 2) || (options.supersededRetentionGenerations ?? 2) < 0) throw new Error('Invalid index retention');
    const { state, receipts } = ensureV5RuntimeStateDb(
      options.stateDb,
      options.repoId,
      options.deviceId,
      globalThis.crypto.randomUUID(),
      Hlc.ZERO.toString(),
      payloadJson => parseSyncChange(decode<V5RuntimeOperation>(payloadJson).change),
    );
    this.incarnationId = state.incarnation;
    this.clock = new HlcClock(Hlc.parse(state.hlc)!);
    // Reserved outbox sequences are not acknowledgements; rebuild only from receipts.
    this.versionVector.resumeWriter(options.deviceId, state.incarnation, 0n);
    for (const target of new Set(options.databases.values())) {
      ensureV5TargetDatabaseTables(target);
    }
    for (const row of receipts) {
      this.observe({ deviceId: row.device, incarnationId: row.incarnation, seq: BigInt(row.seq) });
    }
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => undefined); return next;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private root(): string { return `sync-v5/${this.options.repoId}/`; }
  private headKey(): string { return `${this.root()}heads/${this.options.deviceId}_${this.incarnationId}.json`; }
  private indexPath(incarnationId: string, key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(incarnationId) || !/^sync-v2\/indices\/[A-Za-z0-9_-]+\/(?:base|delta)_[0-9]+_[a-f0-9]+\.dsix$/.test(key)) throw new Error('Invalid V5 index path');
    return `${this.root()}indices/${incarnationId}/${key.split('/').slice(2).join('/')}`;
  }
  private key(epoch = this.options.contentEpoch ?? 0): Uint8Array {
    const key = this.options.secrets.masterKeys.get(epoch);
    if (!key) throw new Error(`Missing master key epoch ${epoch}`);
    return key;
  }
  private seal(value: unknown): Uint8Array {
    const context: PackContext = { magic: 'DSIX', repoId: this.options.repoId, deviceId: this.options.deviceId,
      incarnationId: this.incarnationId, containerId: globalThis.crypto.randomUUID(), contentEpoch: this.options.contentEpoch ?? 0 };
    const pack = encodeFramedPack([utf8Encode(encode(value))], this.key(), this.options.secrets.kCid, context);
    return utf8Encode(encode({ context, location: { ...pack.entries[0]!, chunkId: hex(pack.entries[0]!.chunkId) }, bytes: toBase64(pack.bytes) }));
  }
  private unseal<T>(bytes: Uint8Array): T {
    const sealed = decode<SealedObject>(utf8Decode(bytes));
    const context = sealed.context;
    if (context.repoId !== this.options.repoId || context.magic !== 'DSIX') throw new Error('Repository/index mismatch');
    const location = { ...sealed.location, chunkId: fromHex(sealed.location.chunkId as unknown as string) };
    const packed = fromBase64(sealed.bytes);
    const header = decodeObjectHeader(packed.subarray(0, 64), this.key(context.contentEpoch));
    if (BigInt(packed.length) !== 64n + header.totalCiphertextLen || header.entryOrFrameCount !== 1 || header.magic !== 'DSIX' || header.contentEpoch !== context.contentEpoch) throw new Error('Invalid sealed index header');
    const plain = decryptFramedEntry(packed.subarray(64), deriveObjectDek(this.key(context.contentEpoch), header.objectSalt, context), { ...context, ...location }, this.options.secrets.kCid);
    return decode<T>(utf8Decode(plain));
  }
  private observe(op: { deviceId: string; incarnationId: string; seq: bigint }): void {
    this.intervals.add(writer(op), op.seq);
    this.versionVector.observe(op.deviceId, op.incarnationId, this.intervals.contiguous(writer(op)));
  }
  private receipt(op: V5RuntimeOperation, tx: SqlExecutor = this.options.stateDb): void {
    insertV5RuntimeReceipt(tx, this.options.repoId, op.deviceId, op.incarnationId, op.seq.toString());
  }
  /** Capture local registers synchronously; the business row is already owned by the editor. */
  private captureLocal(tx: SqlExecutor, op: V5RuntimeOperation): void {
    const change = parseSyncChange(op.change);
    recordReceivedOp(tx, { source_device_id: op.deviceId, incarnation_id: op.incarnationId, source_seq: op.seq,
      op_hash: this.opHash(op, change) }, 'materialized');
    const meta = getV5RowMetaRow(tx, change.table_name, change.record_id);
    const versions = meta ? decode<Versions>(meta.col_versions_json) : {};
    let floor = meta?.floor_deleted_hlc ?? null, floorDev = meta?.floor_deleted_dev ?? null;
    if (change.operation === 'Delete') {
      if (!floor || compareLwwTimestamps(change.changed_at, op.deviceId, '', floor, floorDev ?? '', '') > 0) {
        floor = change.changed_at; floorDev = op.deviceId;
      }
      for (const [col] of Object.entries(versions)) {
        const v = versions[col]!;
        if (compareLwwTimestamps(v.hlc, v.dev, '', floor!, floorDev ?? '', '') <= 0) {
          delete versions[col];
          deleteV5ColumnVersion(tx, change.database_name ?? 'vfs', change.table_name, change.record_id, col);
        }
      }
    } else if (isJsonObject(change.data)) {
      const known = new Set(tableColumnNames(tx, change.table_name));
      const pk = new Set(primaryKeyColumns(tx, change.table_name));
      for (const [col, value] of Object.entries(change.data)) {
        if (pk.has(col)) continue;
        const v = op.versions[col]!;
        if ((versions[col] && compareLwwTimestamps(v.hlc, v.dev, '', versions[col]!.hlc, versions[col]!.dev, '') < 0)
          || (floor && compareLwwTimestamps(v.hlc, v.dev, '', floor, floorDev ?? '', '') <= 0)) continue;
        versions[col] = v;
        if (known.has(col)) {
          upsertV5ColumnVersion(tx, change.database_name ?? 'vfs', change.table_name, change.record_id, col, v.hlc, valueHash(value), v.dev);
        }
      }
    }
    upsertV5RowMeta(tx, change.table_name, change.record_id, floor, floorDev, encode(versions));
  }
  private opHash(op: V5RuntimeOperation, change: EngineChange): Uint8Array {
    return computeCanonicalOpHash({ ...op, ordinal: 0, db: change.database_name ?? 'vfs', table: change.table_name,
      recordId: change.record_id, op: change.operation === 'Delete' ? 2 : 1, hlc: change.changed_at, canonicalPayload: encode(op) });
  }
  private materializeRemote(op: V5RuntimeOperation): boolean {
    const change = parseSyncChange(op.change);
    const parsedHlc = Hlc.parse(change.changed_at);
    if (!parsedHlc) throw new Error('Invalid remote V5 HLC');
    parsedHlc.toU64();
    for (const version of Object.values(op.versions)) {
      try {
        const hlc = Hlc.parse(version.hlc);
        if (!hlc) throw new Error('Invalid HLC');
        hlc.toU64();
      } catch { throw new Error('Invalid remote V5 column HLC'); }
    }
    const db = this.options.databases.get(change.database_name ?? 'vfs');
    if (!db) throw new Error(`No database route: ${change.database_name}`);
    const identity = { source_device_id: op.deviceId, incarnation_id: op.incarnationId, source_seq: op.seq };
    const opHash = this.opHash(op, change);
    try { db.transaction(tx => {
      const received = recordReceivedOp(tx, { ...identity, op_hash: opHash });
      if (!received.shouldMaterialize) return;
      if (!tableExists(tx, change.table_name)) {
        appendUnknownOp(tx, identity, change);
        insertV5QuarantineRecord(tx, op.deviceId, op.incarnationId, op.seq.toString(), encode(op));
        return;
      }
      const preLogMax = changeLogMaxId(tx);
      if (change.operation === 'Delete') applyIncomingTombstoneV5(tx, change);
      else applyIncomingRowV5(tx, change, op.versions);
      if (preLogMax !== null) suppressEchoChangeLog(tx, Math.floor(this.now() / 1000), preLogMax);
      // Only persist registers accepted by the lifecycle LWW merge (not stale input).
      const meta = getV5RowMetaRow(tx, change.table_name, change.record_id);
      const accepted = meta ? decode<Versions>(meta.col_versions_json) : {};
      if (change.operation === 'Delete') {
        for (const row of listV5ColumnVersionNames(tx, change.database_name ?? 'vfs', change.table_name, change.record_id)) {
          if (!accepted[row.col_name]) {
            deleteV5ColumnVersion(tx, change.database_name ?? 'vfs', change.table_name, change.record_id, row.col_name);
          }
        }
      }
      const known = new Set(tableColumnNames(tx, change.table_name));
      if (isJsonObject(change.data)) for (const [col, value] of Object.entries(change.data)) {
        if (!known.has(col) || !accepted[col] || !op.versions[col]) continue;
        const a = accepted[col]!, b = op.versions[col]!;
        if (compareLwwTimestamps(a.hlc, a.dev, '', b.hlc, b.dev, '') !== 0) continue;
        upsertV5ColumnVersion(tx, change.database_name ?? 'vfs', change.table_name, change.record_id, col, a.hlc, valueHash(value), a.dev);
      }
      transitionOpMaterializationState(tx, identity, 'materialized');
      deleteV5QuarantineRecord(tx, op.deviceId, op.incarnationId, op.seq.toString());
    }); } catch (error) {
      if (!(error instanceof Error) || !/FOREIGN KEY constraint failed/i.test(error.message)) throw error;
      db.transaction(tx => {
        recordReceivedOp(tx, { ...identity, op_hash: opHash }, 'pending_fk');
        insertV5QuarantineRecord(tx, op.deviceId, op.incarnationId, op.seq.toString(), encode(op));
      });
      return false;
    }
    const wall = BigInt(this.now());
    let nextHlc: string;
    try {
      const received = this.clock.receive(parsedHlc, wall);
      nextHlc = (received.decision === 'absorb' ? received.localHlc : this.clock.tick(wall)).toString();
    } catch { nextHlc = this.clock.tick(wall).toString(); }
    this.options.stateDb.transaction(tx => {
      updateV5RuntimeHlc(tx, nextHlc, this.options.repoId, this.options.deviceId);
      this.receipt(op, tx);
    });
    this.observe(op);
    return true;
  }
  private async collectGarbage(): Promise<void> {
    for (const row of listV5PendingGcKeys(this.options.stateDb, this.options.repoId)) {
      try { await this.options.storage.delete(row.obj_key); }
      catch { continue; } // Keep the durable intent for the next publication/restart.
      deleteV5PendingGcKey(this.options.stateDb, this.options.repoId, row.obj_key);
    }
  }
  /** Only the state database is written here: operation identity commits before business capture. */
  private enqueueLocal(changes: readonly EngineChange[]): { validCount: number; newOversize: number; quarantinedOversize: number; quarantinedLogIds: Array<{ databaseName: string; logId: number | bigint }> } {
    const { stateDb: db, repoId, deviceId } = this.options;
    let validCount = 0, newOversize = 0, quarantinedOversize = 0;
    const quarantinedLogIds: Array<{ databaseName: string; logId: number | bigint }> = [];
    if (!changes.length) return { validCount, newOversize, quarantinedOversize, quarantinedLogIds };
    db.transaction(tx => {
      let seq = readV5RuntimeSeq(tx, repoId, deviceId);
      for (const input of changes) {
        const dbName = input.database_name ?? 'vfs';
        if (input.change_log_id != null) {
          const bound = getV5ChangeLogBindingSeq(tx, repoId, deviceId, dbName, String(input.change_log_id), input.table_name, input.record_id, input.operation);
          if (bound) { validCount++; continue; }
        }
        const nextSeq = seq + 1n;
        if (nextSeq > (1n << 63n) - 1n) throw new RangeError('Source sequence exhausted');
        const hlc = this.clock.tick(BigInt(this.now())).toString();
        const target = this.options.databases.get(dbName);
        if (!target) throw new Error(`No database route: ${input.database_name}`);
        const merged = input.operation === 'Delete' ? { data: null, versions: {} } : mergeKnownRowWithUnknownVault(target, input, { hlc, dev: deviceId, seq: nextSeq });
        const change = { ...input, data: merged.data, changed_at: hlc, source_device_id: deviceId, source_seq: nextSeq };
        const op: V5RuntimeOperation = { deviceId, incarnationId: this.incarnationId, seq: nextSeq, change: serializeSyncChange(change), versions: merged.versions };
        const payload = encode(op), byteLen = utf8ByteLength(payload);
        if (byteLen > (this.options.maxPackPlaintextBytes ?? MAX_V5_PACK_PLAINTEXT_BYTES)) {
          quarantinedOversize++;
          const key = [repoId, deviceId, dbName, input.change_log_id ?? -1, input.table_name, input.record_id, input.operation] as const;
          if (recordV5OversizeQuarantine(tx, key, byteLen)) newOversize++;
          if (input.change_log_id != null) quarantinedLogIds.push({ databaseName: dbName, logId: input.change_log_id });
          continue;
        }
        seq = nextSeq;
        validCount++;
        insertV5RuntimeOp(tx, repoId, deviceId, this.incarnationId, seq.toString(), payload);
        if (input.change_log_id != null) {
          insertV5ChangeLogBinding(tx, repoId, deviceId, dbName, String(input.change_log_id), input.table_name, input.record_id, input.operation, this.incarnationId, seq.toString());
        }
        updateV5RuntimeSeqAndHlc(tx, seq.toString(), hlc, repoId, deviceId);
      }
    });
    return { validCount, newOversize, quarantinedOversize, quarantinedLogIds };
  }
  private capturePendingLocal(): void {
    const { stateDb: db, repoId, deviceId } = this.options;
    for (const row of listV5PendingLocalCaptureOps(db, repoId, deviceId)) {
      const op = decode<V5RuntimeOperation>(row.payload); op.seq = BigInt(op.seq);
      const change = parseSyncChange(op.change);
      const target = this.options.databases.get(change.database_name ?? 'vfs');
      if (!target) throw new Error(`No database route: ${change.database_name}`);
      target.transaction(tx => this.captureLocal(tx, op));
      markV5OpLocalCaptured(db, repoId, deviceId, op.incarnationId, op.seq.toString());
    }
  }
  captureUnboundLocalChangeLogs(): void {
    const changes: EngineChange[] = [];
    for (const [databaseName, db] of this.options.databases) {
      if (!tableExists(db, '__change_log') || !tableExists(db, '__sync_row_meta')) continue;
      for (const row of listV5PendingChangeLogRows(db)) {
        const operation = row.operation.toUpperCase() === 'DELETE' ? 'Delete' : row.operation.toUpperCase() === 'INSERT' ? 'Insert' : 'Update';
        if (hasV5ChangeLogBinding(this.options.stateDb, this.options.repoId, this.options.deviceId, databaseName, String(row.id), row.table_name, row.record_id, operation)) continue;
        if (!tableExists(db, row.table_name)) continue;
        const data = operation === 'Delete' ? null : getRecordData(db, row.table_name, row.record_id, 'id');
        if (operation !== 'Delete' && data === null) continue;
        changes.push({ ...row, operation, data, database_name: databaseName, change_log_id: row.id });
      }
    }
    this.enqueueLocal(changes);
    this.capturePendingLocal();
  }
  publishChangesToV5Cloud(changes: readonly EngineChange[], options?: { isolateOversize?: boolean }): Promise<{ published: number; quarantinedOversize?: number; quarantinedLogIds?: Array<{ databaseName: string; logId: number | bigint }> }> {
    return this.exclusive(async () => {
      const { stateDb: db, repoId, deviceId } = this.options;
      const queued = this.enqueueLocal(changes);
      this.capturePendingLocal();
      if (!options?.isolateOversize && queued.newOversize && !queued.validCount) throw new RangeError('V5 operation exceeds pack plaintext limit');
      const result = (published: number) => options?.isolateOversize
        ? { published, quarantinedOversize: queued.quarantinedOversize, quarantinedLogIds: queued.quarantinedLogIds }
        : { published };
      await this.collectGarbage();
      // Old versions could leave oversized frames in the outbox. Isolate, never head-of-line block.
      isolateV5OversizeOutboxOps(db, repoId, deviceId, this.options.maxPackPlaintextBytes ?? MAX_V5_PACK_PLAINTEXT_BYTES);
      const pending = listV5UnpublishedOps(db, repoId, deviceId);
      if (!pending.length) return result(0);
      const ops = pending.map(row => { const op = decode<V5RuntimeOperation>(row.payload); op.seq = BigInt(op.seq); return op; });
      const previous = await this.options.storage.get(this.headKey());
      const head = previous ? await this.restoreHead(this.unseal<RemoteHead>(previous)) : undefined;
      for (const key of head?.pendingGc ?? []) insertV5PendingGcKey(db, repoId, this.indexPath(this.incarnationId, key));
      const chain = new IndexChainManager(deviceId, head?.chain);
      const refs = head?.refs ?? [];
      const known = new Set(refs.map(ref => `${writer(ref)}:${ref.seq}`));
      const fresh = ops.filter(op => !known.has(`${writer(op)}:${op.seq}`));
      if (fresh.length) {
        const plains = fresh.map(op => utf8Encode(encode(op)));
        const limit = this.options.maxPackPlaintextBytes ?? MAX_V5_PACK_PLAINTEXT_BYTES;
        // Validate before uploading anything: an operation is the atomic frame payload.
        if (plains.some(plain => plain.length > limit)) throw new RangeError('V5 operation exceeds pack plaintext limit');
        const packKeys: string[] = [];
        const entries: Parameters<IndexChainManager['appendDelta']>[0]['entries'] = [];
        for (let start = 0; start < plains.length;) {
          let end = start, size = 0;
          while (end < plains.length && size + plains[end]!.length <= limit) size += plains[end++]!.length;
          const batch = plains.slice(start, end);
          const containerId = hex(computeKeyedChunkId(this.options.secrets.kCid, concatBytes(batch)));
          const packKey = `${this.root()}packs/${deviceId}/${this.incarnationId}/${this.options.contentEpoch ?? 0}/${containerId}.pack`;
          const context: PackContext = { magic: 'DSPK', repoId, deviceId, incarnationId: this.incarnationId, containerId, contentEpoch: this.options.contentEpoch ?? 0 };
          const pack = encodeFramedPack(batch, this.key(), this.options.secrets.kCid, context);
          if (!await this.options.storage.exists(packKey)) await this.options.storage.put(packKey, pack.bytes);
          const packTableIndex = packKeys.length;
          packKeys.push(packKey);
          pack.entries.forEach((entry, i) => {
            const op = fresh[start + i]!;
            refs.push({ deviceId, incarnationId: this.incarnationId, seq: op.seq, chunk: hex(entry.chunkId), packKey, context, location: entry });
            entries.push({ ...entry, compression: 0, packTableIndex, entryDataOffset: BigInt(entry.entryDataOffset) });
          });
          start = end;
        }
        const update = chain.appendDelta({ packKeys, entries });
        // Namespace the existing index manager's per-writer paths by repository/incarnation.
        const indexPath = (key: string) => this.indexPath(this.incarnationId, key);
        const state = chain.getState();
        for (const index of [state.base, ...state.deltas]) {
          const path = indexPath(index.key);
          if (!await this.options.storage.exists(path)) {
            const chunks = new Set(index.index.entries.map(entry => hex(entry.chunkId)));
            await this.options.storage.put(path, this.seal({ binary: toBase64(index.bytes),
              refs: this.serializeRefs(refs.filter(ref => chunks.has(ref.chunk))) }));
          }
        }
        const retired = [...(head?.retired ?? [])];
        if (update.supersedes.length) retired.push(update.supersedes);
        const garbage: string[] = [];
        while (retired.length > (this.options.supersededRetentionGenerations ?? 2)) garbage.push(...retired.shift()!);
        // Commit point: the complete new chain is visible before any old index is collected.
        await this.options.storage.put(this.headKey(), this.seal({ incarnationId: this.incarnationId, chain: this.serializeChain(state), retired, pendingGc: garbage }));
        // Retired generations in the committed head also recover an interruption before GC intent is persisted.
        db.transaction(tx => {
          for (const key of garbage) if (![state.base, ...state.deltas].some(index => index.key === key)) {
            insertV5PendingGcKey(tx, repoId, indexPath(key));
          }
        });
        // Index compaction retains historical operations for new devices: their packs remain live.
      }
      await this.collectGarbage();
      db.transaction(tx => {
        updateV5RuntimeHlc(tx, this.clock.tick(BigInt(this.now())).toString(), repoId, deviceId);
        for (const op of ops) {
          this.receipt(op, tx);
          markV5OpPublished(tx, repoId, deviceId, op.incarnationId, op.seq.toString());
        }
      });
      for (const op of ops) this.observe(op);
      return result(ops.length);
    });
  }
  private serializeChain(chain: IndexChainState): unknown {
    return { generation: chain.generation, base: { key: chain.base.key }, deltas: chain.deltas.map(index => ({ key: index.key })) };
  }
  private serializeRefs(refs: ChunkReference[]): unknown {
    return refs.map(ref => ({ ...ref, location: { ...ref.location, chunkId: hex(ref.location.chunkId) } }));
  }
  private async restoreHead(raw: RemoteHead): Promise<RestoredHead> {
    const frameRefs: ChunkReference[] = [];
    const restore = async (value: unknown) => {
      const item = value as { key: string };
      let sealed: Uint8Array | null;
      try { sealed = await this.options.storage.get(this.indexPath(raw.incarnationId, item.key)); }
      catch (error) {
        const missing = error as { code?: string; status?: number; error_type?: string; value?: { type?: string; error_type?: string } };
        if (missing.code === 'notFound' || missing.code === 'NotFound' || missing.error_type === 'NotFound'
          || missing.value?.type === 'NotFound' || missing.value?.error_type === 'NotFound' || missing.status === 404) {
          throw new MissingCommittedIndex(`Missing committed V5 index: ${item.key}`);
        }
        throw error;
      }
      if (!sealed) throw new MissingCommittedIndex(`Missing committed V5 index: ${item.key}`);
      const payload = this.unseal<{ binary: string; refs?: ChunkReference[] }>(sealed);
      frameRefs.push(...(payload.refs ?? []));
      const bytes = fromBase64(payload.binary); return { key: item.key, bytes, index: decodeShardedIndex(bytes) };
    };
    if (raw.chain.deltas.length > 8) throw new Error('V5 index chain exceeds 1 base + 8 deltas');
    const base = await restore(raw.chain.base), deltas = await Promise.all(raw.chain.deltas.map(restore));
    const refs = [...(raw.refs ?? []), ...frameRefs].map(ref => ({ ...ref, seq: BigInt(ref.seq), location: { ...ref.location, chunkId: fromHex(ref.location.chunkId as unknown as string) } }));
    const indexed = new Map([base, ...deltas].flatMap(source => source.index.entries.map(entry => [hex(entry.chunkId), { entry, packKey: source.index.packKeys[entry.packTableIndex] }] as const)));
    for (const ref of refs) {
      const hit = indexed.get(ref.chunk);
      if (!hit || hex(ref.location.chunkId) !== ref.chunk || hit.packKey !== ref.packKey
        || hit.entry.entryDataOffset !== BigInt(ref.location.entryDataOffset) || hit.entry.entryIndex !== ref.location.entryIndex
        || hit.entry.plaintextLength !== ref.location.plaintextLength || hit.entry.entryCiphertextLength !== ref.location.entryCiphertextLength
        || hit.entry.contentEpoch !== ref.location.contentEpoch) throw new Error('V5 operation reference differs from binary index');
    }
    return { incarnationId: raw.incarnationId, chain: { generation: BigInt(raw.chain.generation), base, deltas }, refs, retired: raw.retired, pendingGc: raw.pendingGc };
  }
  pullAndApplyFromV5Cloud(): Promise<{ applied: number; downloadedEntries: number }> {
    return this.exclusive(async () => {
      this.captureUnboundLocalChangeLogs();
      // Re-run schema materialization locally without downloading an already received frame.
      const pending = new Map<string, V5RuntimeOperation>();
      const identity = (op: V5RuntimeOperation) => `${writer(op)}:${op.seq}`;
      for (const [databaseName, db] of this.options.databases) {
        for (const row of listV5QuarantinePayloads(db)) {
          const op = decode<V5RuntimeOperation>(row.payload); op.seq = BigInt(op.seq);
          if (this.intervals.has(writer(op), op.seq)) this.materializeRemote(op);
          else pending.set(identity(op), op);
        }
        for (const row of listV5UnknownFieldTables(db)) rehydrateUnknownFieldsV5(db, row.table_name, databaseName);
      }
      let applied = 0, downloadedEntries = 0;
      for (const info of await this.options.storage.list(`${this.root()}heads/`)) {
        let head: RestoredHead | undefined;
        for (let attempt = 0; attempt <= 3; attempt++) {
          const bytes = await this.options.storage.get(info.key);
          if (!bytes) throw new Error(`Missing V5 head: ${info.key}`);
          try { head = await this.restoreHead(this.unseal<RemoteHead>(bytes)); break; }
          catch (error) { if (!(error instanceof MissingCommittedIndex) || attempt === 3) throw error; }
        }
        const headers = new Map<string, { bytes: Uint8Array; size: number | bigint }>();
        for (const ref of head!.refs) {
          if (this.intervals.has(writer(ref), ref.seq)) continue;
          if (pending.has(`${writer(ref)}:${ref.seq}`)) continue;
          let header = headers.get(ref.packKey);
          if (!header) {
            const stat = await this.options.storage.stat(ref.packKey);
            if (!stat) throw new Error(`Missing V5 pack: ${ref.packKey}`);
            header = { bytes: await this.options.storage.getRange(ref.packKey, 0, 64), size: stat.size };
            headers.set(ref.packKey, header);
          }
          const plain = await readPackEntryRange(this.options.storage, ref.packKey, header.bytes, header.size, ref.location,
            this.key(ref.context.contentEpoch), this.options.secrets.kCid, ref.context, { actual: cdc, pinned: cdc });
          downloadedEntries++;
          const op = decode<V5RuntimeOperation>(utf8Decode(plain)); op.seq = BigInt(op.seq);
          const change = parseSyncChange(op.change);
          if (writer(op) !== writer(ref) || op.seq !== ref.seq || change.source_device_id !== op.deviceId || BigInt(change.source_seq ?? -1) !== op.seq) throw new Error('Operation/index identity mismatch');
          const hlc = Hlc.parse(change.changed_at);
          if (!hlc) throw new Error('Invalid remote V5 HLC');
          hlc.toU64();
          pending.set(identity(op), op);
        }
      }
      const ordered = [...pending.values()].sort((a, b) => {
        const ah = Hlc.parse(parseSyncChange(a.change).changed_at), bh = Hlc.parse(parseSyncChange(b.change).changed_at);
        if (!ah || !bh) throw new Error('Invalid remote V5 HLC');
        if (ah.toU64() !== bh.toU64()) return ah.toU64() < bh.toU64() ? -1 : 1;
        return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1
          : a.incarnationId < b.incarnationId ? -1 : a.incarnationId > b.incarnationId ? 1 : a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
      });
      let retry = ordered;
      while (retry.length) {
        const blocked: V5RuntimeOperation[] = [];
        for (const op of retry) {
          if (this.materializeRemote(op)) applied++;
          else blocked.push(op);
        }
        if (blocked.length === retry.length) break;
        retry = blocked;
      }
      return { applied, downloadedEntries };
    });
  }

  async pairingAnchorV5(ownerPubkeyHex: string): Promise<RepoHeadAnchor> {
    const bytes = await this.options.storage.get(this.headKey());
    if (!bytes) throw new Error('Missing pairing head');
    const head = this.unseal<RemoteHead>(bytes);
    return { repoId: this.options.repoId, repoHeadGeneration: BigInt(head.chain.generation),
      repoHeadSha256: sha256HexSync(bytes), ownerPubkeyHex };
  }

  async verifyPairingAnchorV5(headKey: string, anchor: RepoHeadAnchor): Promise<void> {
    if (anchor.repoId !== this.options.repoId || !headKey.startsWith(`${this.root()}heads/`)) throw new Error('Pairing repository mismatch');
    const bytes = await this.options.storage.get(headKey);
    if (!bytes || sha256HexSync(bytes) !== anchor.repoHeadSha256) throw new Error('Pairing anchor mismatch');
    const head = await this.restoreHead(this.unseal<RemoteHead>(bytes));
    if (head.chain.generation !== BigInt(anchor.repoHeadGeneration)) throw new Error('Pairing anchor generation mismatch');
  }

  /** Sender creates transport bytes only; the receiver never uses this coordinator. */
  async createPairingOfferV5(args: {
    sourceSettings: PairingSettings; anchor: RepoHeadAnchor; cloudConfig: RuntimeCloudStorageConfig; pin?: string;
  }) {
    await this.verifyPairingAnchorV5(this.headKey(), args.anchor);
    const pin = args.pin ?? randomPin();
    const config = await createPairingCode(args.sourceSettings, { pin });
    const offer = createDSPAIR2Pairing({ repoHeadAnchor: args.anchor, secrets: {
      config: config.pairingCode, cloudConfig: args.cloudConfig as unknown as DbJson, headKey: this.headKey(), kCid: hex(this.options.secrets.kCid),
      masterKeys: [...this.options.secrets.masterKeys].map(([epoch, key]) => [epoch, hex(key)]), contentEpoch: this.options.contentEpoch ?? 0,
    } });
    return { pin, ...offer };
  }
}

/** Keep native range implementations; legacy providers explicitly fall back to a full GET. */
export function storageWithV5Ranges(storage: CloudStorage): CloudStorage & RangeReader {
  if (typeof (storage as Partial<RangeReader>).getRange === 'function') return storage as CloudStorage & RangeReader;
  return new Proxy(storage, { get(target, property) {
    if (property === 'getRange') return async (key: string, offset: number, length: number) => {
      const bytes = await target.get(key);
      if (!bytes) throw new Error(`Missing V5 pack: ${key}`);
      return bytes.subarray(offset, offset + length);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as CloudStorage & RangeReader;
}

/** Receiver entry: all remote configuration and keys come from authenticated transport. */
export async function pairAndBootstrapDeviceV5(args: {
  packet: string; secret: string; pin: string; targetSettings: PairingSettings;
  target: Omit<SyncV5RuntimeOptions, 'secrets' | 'repoId' | 'storage' | 'contentEpoch'>;
  createStorage: (config: RuntimeCloudStorageConfig) => Promise<CloudStorage>;
}) {
  const payload = createDSPAIR2Receiver().consume(args.packet, args.secret);
  const secrets = payload.secrets as unknown as { config: string; cloudConfig: RuntimeCloudStorageConfig; headKey: string; kCid: string; masterKeys: [number, string][]; contentEpoch: number };
  const storage = storageWithV5Ranges(await args.createStorage(secrets.cloudConfig));
  const coordinator = new SyncV5RuntimeCoordinator({ ...args.target, storage, repoId: payload.repoHeadAnchor.repoId,
    secrets: { kCid: fromHex(secrets.kCid), masterKeys: new Map(secrets.masterKeys.map(([epoch, key]) => [Number(epoch), fromHex(key)])) }, contentEpoch: Number(secrets.contentEpoch) });
  await coordinator.verifyPairingAnchorV5(secrets.headKey, payload.repoHeadAnchor);
  await applyPairingCode(args.targetSettings, { pin: args.pin, pairingCode: secrets.config });
  await args.targetSettings.saveSecret('cloud_sync.v5_root', encode({ repoId: payload.repoHeadAnchor.repoId, kCid: secrets.kCid, masterKeys: secrets.masterKeys, contentEpoch: secrets.contentEpoch }));
  return { coordinator, sync: await coordinator.pullAndApplyFromV5Cloud() };
}
