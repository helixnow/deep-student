import { toHex, utf8Decode } from '../../../platform/crypto/encoding.ts';
import { readU16be, readU32be, readU64be, u32be, u64be, writeU16be, writeU32be, writeU64be } from '../../../platform/util/bytes.ts';
import { bytesEqual, compareBytes, concatBytes } from './bytes.ts';
import { sha256Bytes, sha256Hex } from './hashing.ts';
import { lpEncode } from './v5_keyring.ts';
import { computeEntryRangeOffsets } from './v5_framed_pack.ts';

export const INDEX_ENTRY_SIZE = 104;
export const SHARD_TABLE_SIZE = 16 * 12;
export interface IndexEntry {
  chunkId: Uint8Array; contentEpoch: number; compression: number; packTableIndex: number;
  entryDataOffset: bigint; plaintextLength: number; entryCiphertextLength: number;
  /** Needed to reconstruct the frame nonce; stored in the first four reserved bytes. */
  entryIndex: number;
}
export interface BinaryIndex { entries: IndexEntry[]; packKeys: string[]; supersedes: string[] }
export function encodeIndexEntry(entry: IndexEntry): Uint8Array {
  if (entry.chunkId.length !== 32 || entry.compression !== 0 || computeEntryRangeOffsets(0, entry.plaintextLength).length !== entry.entryCiphertextLength) throw new Error('Invalid or unsupported index entry');
  const b = new Uint8Array(INDEX_ENTRY_SIZE);
  b.set(entry.chunkId); writeU16be(b, entry.contentEpoch, 32); b[34] = entry.compression;
  writeU32be(b, entry.packTableIndex, 35); writeU64be(b, entry.entryDataOffset, 39);
  writeU32be(b, entry.plaintextLength, 47); writeU32be(b, entry.entryCiphertextLength, 51);
  writeU32be(b, entry.entryIndex, 55); // bytes 59..103 reserved, zero
  return b;
}
export function decodeIndexEntry(bytes: Uint8Array): IndexEntry {
  if (bytes.length !== INDEX_ENTRY_SIZE) throw new Error('Index entry must be 104 bytes');
  const b = new Uint8Array(bytes);
  if (b.subarray(59).some(byte => byte !== 0)) throw new Error('Nonzero reserved index bytes');
  const entry = { chunkId: b.subarray(0, 32), contentEpoch: readU16be(b, 32), compression: b[34]!, packTableIndex: readU32be(b, 35), entryDataOffset: readU64be(b, 39), plaintextLength: readU32be(b, 47), entryCiphertextLength: readU32be(b, 51), entryIndex: readU32be(b, 55) };
  encodeIndexEntry(entry); return entry;
}
/** Plaintext DSIX payload, sealed by the common DSIX 64B-header framed container. */
export function encodeShardedIndex(index: BinaryIndex): Uint8Array {
  const entries = [...index.entries].sort((a, b) => compareBytes(a.chunkId, b.chunkId));
  const table = new Uint8Array(SHARD_TABLE_SIZE);
  let position = 0;
  for (let shard = 0; shard < 16; shard++) {
    const start = position;
    while (position < entries.length && entries[position]!.chunkId[0]! >> 4 === shard) position++;
    writeU64be(table, BigInt(SHARD_TABLE_SIZE + start * INDEX_ENTRY_SIZE), shard * 12);
    writeU32be(table, position - start, shard * 12 + 8);
  }
  const records = entries.map((entry, i) => {
    if (entry.packTableIndex >= index.packKeys.length || (i > 0 && compareBytes(entries[i - 1]!.chunkId, entry.chunkId) === 0)) throw new Error('Invalid pack reference or duplicate chunk');
    return encodeIndexEntry(entry);
  });
  return concatBytes([table, ...records, u32be(index.packKeys.length), ...index.packKeys.map(lpEncode), u32be(index.supersedes.length), ...index.supersedes.map(lpEncode)]);
}
export function decodeShardedIndex(input: Uint8Array): BinaryIndex {
  const b = new Uint8Array(input);
  if (b.length < SHARD_TABLE_SIZE + 8) throw new Error('Truncated index');
  const entries: IndexEntry[] = [];
  let offset = SHARD_TABLE_SIZE;
  for (let shard = 0; shard < 16; shard++) {
    if (readU64be(b, shard * 12) !== BigInt(offset)) throw new Error('Invalid shard offset');
    const count = readU32be(b, shard * 12 + 8);
    if (count > Math.floor((b.length - offset) / INDEX_ENTRY_SIZE)) throw new Error('Truncated shard');
    for (let i = 0; i < count; i++) {
      const entry = decodeIndexEntry(b.subarray(offset, offset + INDEX_ENTRY_SIZE)); offset += INDEX_ENTRY_SIZE;
      if (entry.chunkId[0]! >> 4 !== shard || (entries.length && compareBytes(entries[entries.length - 1]!.chunkId, entry.chunkId) >= 0)) throw new Error('Unsorted shard');
      entries.push(entry);
    }
  }
  function readStrings(): string[] {
    if (offset + 4 > b.length) throw new Error('Truncated index table');
    const count = readU32be(b, offset); offset += 4;
    if (count > Math.floor((b.length - offset) / 2)) throw new Error('Invalid string count');
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 2 > b.length) throw new Error('Truncated index string');
      const length = readU16be(b, offset); offset += 2;
      if (offset + length > b.length) throw new Error('Truncated index string');
      result.push(utf8Decode(b.subarray(offset, offset + length))); offset += length;
    }
    return result;
  }
  const packKeys = readStrings(); const supersedes = readStrings();
  if (offset !== b.length || entries.some(e => e.packTableIndex >= packKeys.length)) throw new Error('Trailing index bytes or invalid pack reference');
  return { entries, packKeys, supersedes };
}
export interface IndexObject { key: string; index: BinaryIndex; bytes: Uint8Array }
export interface IndexChainUpdate { base: IndexObject; deltas: IndexObject[]; published: IndexObject; supersedes: string[] }
export interface IndexChainState { generation: bigint; base: IndexObject; deltas: IndexObject[] }
export class IndexChainManager {
  private deviceId: string;
  private generation = 0n;
  private base: IndexObject;
  private deltas: IndexObject[] = [];
  constructor(deviceId: string, restored?: IndexChainState) {
    validatePathComponent(deviceId); this.deviceId = deviceId;
    if (restored) {
      if (restored.deltas.length > 8 || restored.generation < 0n) throw new Error('Invalid restored index chain');
      this.generation = restored.generation; this.base = restored.base; this.deltas = [...restored.deltas];
    } else this.base = this.makeObject('base', { entries: [], packKeys: [], supersedes: [] });
  }
  getState(): IndexChainState { return { generation: this.generation, base: this.base, deltas: [...this.deltas] }; }
  private makeObject(kind: 'base' | 'delta', index: BinaryIndex): IndexObject {
    const bytes = encodeShardedIndex(index);
    const hash = sha256Hex(bytes).slice(0, 8);
    return { key: `sync-v2/indices/${this.deviceId}/${kind}_${this.generation}_${hash}.dsix`, index, bytes };
  }
  appendDelta(index: Omit<BinaryIndex, 'supersedes'>): IndexChainUpdate {
    this.generation++;
    const delta = this.makeObject('delta', { ...index, supersedes: [] });
    this.deltas.push(delta);
    let published = delta; let supersedes: string[] = [];
    if (this.deltas.length > 8 || this.deltas.reduce((sum, item) => sum + item.index.entries.length, 0) > 4096) {
      const sources = [this.base, ...this.deltas];
      const packs: string[] = []; const packPositions = new Map<string, number>();
      const chunks = new Map<string, IndexEntry>();
      for (const source of sources) for (const entry of source.index.entries) {
        const key = source.index.packKeys[entry.packTableIndex]!;
        let packTableIndex = packPositions.get(key);
        if (packTableIndex === undefined) { packTableIndex = packs.length; packPositions.set(key, packTableIndex); packs.push(key); }
        chunks.set(toHex(entry.chunkId), { ...entry, packTableIndex });
      }
      supersedes = sources.map(s => s.key);
      this.base = this.makeObject('base', { entries: [...chunks.values()], packKeys: packs, supersedes });
      this.deltas = []; published = this.base;
    }
    return { base: this.base, deltas: [...this.deltas], published, supersedes };
  }
}
function validatePathComponent(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid path component');
}
export function shardedObjectPath(prefix: 'packs' | 'segments', deviceId: string, hexId: string): string {
  validatePathComponent(deviceId);
  if (!/^[0-9a-f]+$/i.test(hexId) || !['packs', 'segments'].includes(prefix)) throw new Error('Invalid object path');
  return `sync-v2/${prefix}/${deviceId}/${hexId.charAt(0).toLowerCase()}/${hexId}.${prefix === 'packs' ? 'dspk' : 'dsseg'}`;
}

export interface CheckpointColumn { value: unknown; hlc: string; writerDeviceId: string; sourceSeq: bigint }
export interface DeviceOperation {
  deviceId: string; incarnationId: string; sourceSeq: bigint; ordinal: number;
  db: string; table: string; recordId: string; columns: Record<string, CheckpointColumn>;
  deleteHlc?: string; chunkRefs?: string[]; opHash: Uint8Array;
}
export interface CheckpointRow {
  db: string; table: string; recordId: string; columns: Record<string, CheckpointColumn>;
  deletion?: { hlc: string; writerDeviceId: string; sourceSeq: bigint };
}
export interface DeviceCheckpoint {
  magic: 'DSCK'; subjectDeviceId: string; incarnationId: string; fromSeq: bigint; uptoSeq: bigint;
  rows: CheckpointRow[]; chunkRefs: string[]; rangeLeafHash: Uint8Array;
}
const MAX_SEQ = (1n << 63n) - 1n;
/** Merkle leaves are canonical op hashes supplied by the capture layer. */
function merkleRoot(hashes: Uint8Array[]): Uint8Array {
  if (!hashes.length) return sha256Bytes(new Uint8Array());
  let layer: Uint8Array[] = hashes.map(h => new Uint8Array(h));
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!; const right = layer[i + 1];
      next.push(right === undefined ? left : sha256Bytes(concatBytes([Uint8Array.of(1), left, right])));
    }
    layer = next;
  }
  return layer[0]!;
}
export function foldDeviceOperationsToCheckpoint(operations: DeviceOperation[], subjectDeviceId: string, incarnationId: string, fromSeq: bigint, uptoSeq: bigint): DeviceCheckpoint {
  if (uptoSeq < fromSeq) throw new Error('CHECKPOINT_GAP_ERROR: Invalid checkpoint range');
  if (fromSeq < 0n || uptoSeq > MAX_SEQ) throw new RangeError('Invalid checkpoint range');
  const selected = operations.filter(o => o.deviceId === subjectDeviceId && o.incarnationId === incarnationId && o.sourceSeq >= fromSeq && o.sourceSeq <= uptoSeq)
    .sort((a, b) => a.sourceSeq < b.sourceSeq ? -1 : a.sourceSeq > b.sourceSeq ? 1 : a.ordinal - b.ordinal);
  const rows = new Map<string, CheckpointRow>(); const refs = new Set<string>();
  const seen = new Map<string, Uint8Array>(); const hashes: Uint8Array[] = [];
  let nextSeq = fromSeq;
  for (const op of selected) {
    if (op.opHash.length !== 32 || !Number.isInteger(op.ordinal) || op.ordinal < 0 || op.ordinal > 0xffffffff) throw new Error('Invalid operation identity/hash');
    const opId = `${op.sourceSeq}:${op.ordinal}`;
    const oldHash = seen.get(opId);
    if (oldHash) {
      if (!bytesEqual(oldHash, op.opHash)) throw new Error('HistoryForkError');
      continue;
    }
    seen.set(opId, op.opHash); hashes.push(op.opHash);
    if (op.sourceSeq > nextSeq) throw new Error('CHECKPOINT_GAP_ERROR: Missing sequence');
    if (op.sourceSeq === nextSeq) nextSeq++;
    const key = toHex(concatBytes([lpEncode(op.db), lpEncode(op.table), lpEncode(op.recordId)]));
    let row = rows.get(key);
    if (!row) { row = { db: op.db, table: op.table, recordId: op.recordId, columns: Object.create(null) }; rows.set(key, row); }
    for (const [column, version] of Object.entries(op.columns)) {
      // A forwarded/observed foreign column is never part of this writer's projection.
      if (version.writerDeviceId !== subjectDeviceId || version.sourceSeq !== op.sourceSeq) continue;
      const old = row.columns[column];
      if (!old || version.hlc > old.hlc || (version.hlc === old.hlc && version.sourceSeq >= old.sourceSeq)) row.columns[column] = { ...version };
    }
    if (op.deleteHlc && (!row.deletion || op.deleteHlc > row.deletion.hlc || (op.deleteHlc === row.deletion.hlc && op.sourceSeq > row.deletion.sourceSeq))) row.deletion = { hlc: op.deleteHlc, writerDeviceId: subjectDeviceId, sourceSeq: op.sourceSeq };
    for (const ref of op.chunkRefs ?? []) refs.add(ref);
  }
  if (nextSeq <= uptoSeq) throw new Error('CHECKPOINT_GAP_ERROR: Missing sequence');
  // Drop obsolete generations while retaining the highest delete floor forever.
  for (const row of rows.values()) if (row.deletion) for (const [column, version] of Object.entries(row.columns)) if (version.hlc <= row.deletion.hlc) delete row.columns[column];
  const rangeLeafHash = sha256Bytes(concatBytes([Uint8Array.of(2), lpEncode(subjectDeviceId), lpEncode(incarnationId), u64be(fromSeq), u64be(uptoSeq), merkleRoot(hashes)]));
  return { magic: 'DSCK', subjectDeviceId, incarnationId, fromSeq, uptoSeq, rows: [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row), chunkRefs: [...refs].sort(), rangeLeafHash };
}

export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
export interface ManifestPackReferences { generation: bigint; packKeys: string[]; checkpointPackKeys?: string[]; status?: 'active' | 'idle' | 'retired' }
export interface PendingPackIntent { deviceId: string; attemptId: string; packKeys: string[]; createdAtMs: number }
/** GC must additionally abort sweep if manifest generations or pending membership change. */
export function computeGcLivePackSet(activeManifests: ManifestPackReferences[], pendingIntents: PendingPackIntent[], nowMs: number): Set<string> {
  if (!Number.isFinite(nowMs)) throw new Error('Invalid GC time');
  const live = new Set<string>();
  for (const manifest of activeManifests) {
    if (manifest.status === 'retired') continue;
    for (const pack of [...manifest.packKeys, ...(manifest.checkpointPackKeys ?? [])]) live.add(pack);
  }
  for (const pending of pendingIntents) {
    if (!Number.isFinite(pending.createdAtMs)) throw new Error('Malformed pending intent: abort GC');
    if (nowMs <= pending.createdAtMs + PENDING_TTL_MS) for (const pack of pending.packKeys) live.add(pack);
  }
  return live;
}

export class GcSnapshotChangedError extends Error {}
export interface GcReferenceSnapshot { manifestGenerations: ReadonlyMap<string, bigint>; pendingKeys: ReadonlySet<string> }
/** Call under the maintenance lease immediately before sweep, not after DELETE. */
export function assertGcSnapshotUnchanged(before: GcReferenceSnapshot, after: GcReferenceSnapshot): void {
  if (before.manifestGenerations.size !== after.manifestGenerations.size || before.pendingKeys.size !== after.pendingKeys.size
    || [...before.manifestGenerations].some(([key, generation]) => after.manifestGenerations.get(key) !== generation)
    || [...before.pendingKeys].some(key => !after.pendingKeys.has(key))) throw new GcSnapshotChangedError('References changed during GC scan: abort sweep');
}
