import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { compareBytes, concatBytes, u16be, u32be, u64be } from '../../../platform/util/bytes.ts';

export const MAX_SOURCE_SEQ = (1n << 63n) - 1n;
export type WriterKey = `${string}@${string}`;
export interface VersionSlot { contiguousSeq: bigint; headSegmentSha256: string }

export function lpEncode(input: string | Uint8Array): Uint8Array {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  if (bytes.length > 0xffff) throw new RangeError('Length prefix exceeds u16');
  return concatBytes([u16be(bytes.length), bytes]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

export function formatWriterKey(deviceId: string, incarnationId: string): WriterKey {
  if (!deviceId || !incarnationId || deviceId.includes('@') || incarnationId.includes('@')) {
    throw new Error('Writer components must be nonempty and contain no @');
  }
  return `${deviceId}@${incarnationId}`;
}

export function parseWriterKey(key: WriterKey | string): { deviceId: string; incarnationId: string } {
  const parts = key.split('@');
  if (parts.length !== 2) throw new Error('Invalid writer key');
  const deviceId = parts[0]!;
  const incarnationId = parts[1]!;
  formatWriterKey(deviceId, incarnationId);
  return { deviceId, incarnationId };
}

function validateSeq(seq: bigint): void {
  if (seq < 0n || seq > MAX_SOURCE_SEQ) throw new RangeError('Source sequence exceeds signed u63');
}

export class MultiIncarnationVersionVector {
  private slots = new Map<WriterKey, VersionSlot>();
  private current = new Map<string, string>();
  private newIncarnation: () => string;

  constructor(initial: Partial<Record<WriterKey, VersionSlot>> = {}, newIncarnation: () => string = () => globalThis.crypto.randomUUID()) {
    this.newIncarnation = newIncarnation;
    for (const [key, slot] of Object.entries(initial)) {
      if (slot) {
        parseWriterKey(key);
        validateSeq(slot.contiguousSeq);
        this.slots.set(key as WriterKey, { ...slot });
      }
    }
  }

  get(writer: WriterKey): VersionSlot | undefined {
    const slot = this.slots.get(writer);
    return slot ? { ...slot } : undefined;
  }

  toJSON(): Partial<Record<WriterKey, VersionSlot>> {
    return Object.fromEntries([...this.slots].map(([key, slot]) => [key, { ...slot }]));
  }

  /** Remote contiguous watermarks only advance; segment hashes are not operation identities. */
  observe(deviceId: string, incarnationId: string, contiguousSeq: bigint, headSegmentSha256 = ''): WriterKey {
    validateSeq(contiguousSeq);
    const key = formatWriterKey(deviceId, incarnationId);
    const previous = this.slots.get(key);
    if (!previous || contiguousSeq >= previous.contiguousSeq) {
      this.slots.set(key, { contiguousSeq, headSegmentSha256 });
    }
    return key;
  }

  rotateIncarnation(deviceId: string, incarnationId = this.newIncarnation()): WriterKey {
    const key = formatWriterKey(deviceId, incarnationId);
    if (this.slots.has(key)) throw new Error('Incarnation already exists');
    this.slots.set(key, { contiguousSeq: 0n, headSegmentSha256: '' });
    this.current.set(deviceId, incarnationId);
    return key;
  }

  /** Call when opening a local writer with its restored durable source-sequence counter. */
  resumeWriter(deviceId: string, incarnationId: string, durableSeq: bigint): WriterKey {
    validateSeq(durableSeq);
    const key = formatWriterKey(deviceId, incarnationId);
    const known = this.slots.get(key);
    if (known && durableSeq < known.contiguousSeq) return this.rotateIncarnation(deviceId);
    this.current.set(deviceId, incarnationId);
    return this.observe(deviceId, incarnationId, durableSeq, known?.headSegmentSha256);
  }

  nextSequence(deviceId: string): { writerKey: WriterKey; seq: bigint } {
    const incarnationId = this.current.get(deviceId);
    if (!incarnationId) throw new Error('Local writer has not been resumed');
    const key = formatWriterKey(deviceId, incarnationId);
    const seq = this.slots.get(key)!.contiguousSeq + 1n;
    validateSeq(seq);
    this.observe(deviceId, incarnationId, seq);
    return { writerKey: key, seq };
  }
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHasherSync('SHA-256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function u64(value: bigint): Uint8Array {
  validateSeq(value);
  return u64be(value);
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Ordinal exceeds u32');
  return u32be(value);
}

export interface OperationIdentity {
  deviceId: string;
  incarnationId: string;
  seq: bigint;
  ordinal: number;
}

export interface CanonicalOperation extends OperationIdentity {
  db: string;
  table: string;
  recordId: string;
  op: number;
  hlc: string;
  /** Already canonicalized UTF-8 JSON (or its bytes); no implicit JSON serialization. */
  canonicalPayload: string | Uint8Array;
}

export function computeCanonicalOpHash(operation: CanonicalOperation): Uint8Array {
  const { db, table, recordId, op, hlc, deviceId, incarnationId, seq, ordinal, canonicalPayload } = operation;
  if (!Number.isInteger(op) || op < 0 || op > 255) throw new RangeError('Operation exceeds u8');
  const payload = typeof canonicalPayload === 'string' ? utf8Encode(canonicalPayload) : canonicalPayload;
  return sha256(Uint8Array.of(0), lpEncode(db), lpEncode(table), lpEncode(recordId), Uint8Array.of(op),
    lpEncode(hlc), lpEncode(deviceId), lpEncode(incarnationId), u64(seq), u32(ordinal), sha256(payload));
}

export interface RangeLeaf {
  deviceId: string;
  incarnationId: string;
  fromSeq: bigint;
  uptoSeq: bigint;
  opsRoot: Uint8Array;
}

export function computeRangeLeafHash(range: RangeLeaf): Uint8Array {
  if (range.fromSeq > range.uptoSeq) throw new RangeError('Inverted range');
  if (range.opsRoot.length !== 32) throw new Error('Expected SHA-256 range root');
  return sha256(Uint8Array.of(2), lpEncode(range.deviceId), lpEncode(range.incarnationId),
    u64(range.fromSeq), u64(range.uptoSeq), range.opsRoot);
}

/** Ordered binary Merkle tree: 0x01 separates internal nodes from operation/range leaves. */
export function computeMerkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array());
  let level: Uint8Array[] = leaves.map((leaf) => new Uint8Array(leaf));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(Uint8Array.of(1), level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

export class HistoryForkError extends Error {
  constructor(identity: OperationIdentity) {
    super(`Conflicting operation: ${identity.deviceId}@${identity.incarnationId}/${identity.seq}/${identity.ordinal}`);
    this.name = 'HistoryForkError';
  }
}

export interface HashedOperation extends OperationIdentity { opHash: Uint8Array }
interface StoredRange extends RangeLeaf { rangeLeafHash: Uint8Array }

function identityKey(identity: OperationIdentity): string {
  validateSeq(identity.seq);
  u32(identity.ordinal);
  return JSON.stringify([identity.deviceId, identity.incarnationId, identity.seq.toString(), identity.ordinal]);
}

function sameWriter(a: { deviceId: string; incarnationId: string }, b: { deviceId: string; incarnationId: string }): boolean {
  return a.deviceId === b.deviceId && a.incarnationId === b.incarnationId;
}

function compareIdentity(a: OperationIdentity, b: OperationIdentity): number {
  return compareBytes(utf8Encode(a.deviceId), utf8Encode(b.deviceId))
    || compareBytes(utf8Encode(a.incarnationId), utf8Encode(b.incarnationId))
    || (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.ordinal - b.ordinal);
}

export class DeduplicatedMerkleLedger {
  private operations = new Map<string, HashedOperation>();
  private ranges: StoredRange[] = [];
  // Exact fork checking after compaction needs identity witnesses. This in-memory
  // index retains only hashes, not payloads or Merkle leaves; persistence belongs to the caller.
  private identities = new Map<string, Uint8Array>();

  get operationCount(): number { return this.operations.size; }
  get rangeCount(): number { return this.ranges.length; }

  add(operation: HashedOperation): 'added' | 'duplicate' {
    const key = identityKey(operation);
    if (operation.opHash.length !== 32) throw new Error('Expected SHA-256 operation hash');
    const existing = this.identities.get(key);
    if (existing) {
      if (!sameBytes(existing, operation.opHash)) throw new HistoryForkError(operation);
      return 'duplicate';
    }
    if (this.ranges.some((range) => sameWriter(range, operation) && operation.seq >= range.fromSeq && operation.seq <= range.uptoSeq)) {
      throw new Error('Compacted operation requires its checkpoint identity witness');
    }
    const stored = { ...operation, opHash: new Uint8Array(operation.opHash) };
    this.identities.set(key, stored.opHash);
    this.operations.set(key, stored);
    return 'added';
  }

  root(): Uint8Array {
    const leaves = [
      ...[...this.operations.values()].map((op) => ({ ...op, hash: op.opHash })),
      ...this.ranges.map((range) => ({ ...range, seq: range.fromSeq, ordinal: -1, hash: range.rangeLeafHash })),
    ].sort(compareIdentity);
    return computeMerkleRoot(leaves.map((leaf) => leaf.hash));
  }

  rangeDigest(deviceId: string, incarnationId: string, fromSeq: bigint, uptoSeq: bigint): Uint8Array {
    const range = this.ranges.find((item) => sameWriter(item, { deviceId, incarnationId }) && item.fromSeq === fromSeq && item.uptoSeq === uptoSeq);
    if (range) return new Uint8Array(range.rangeLeafHash);
    return computeRangeLeafHash(this.describeRange(deviceId, incarnationId, fromSeq, uptoSeq));
  }

  compactRange(deviceId: string, incarnationId: string, fromSeq: bigint, uptoSeq: bigint): RangeLeaf & { rangeLeafHash: Uint8Array } {
    const description = this.describeRange(deviceId, incarnationId, fromSeq, uptoSeq);
    const rangeLeafHash = computeRangeLeafHash(description);
    for (const [key, operation] of this.operations) {
      if (sameWriter(operation, description) && operation.seq >= fromSeq && operation.seq <= uptoSeq) this.operations.delete(key);
    }
    this.ranges.push({ ...description, rangeLeafHash });
    return { ...description, opsRoot: new Uint8Array(description.opsRoot), rangeLeafHash: new Uint8Array(rangeLeafHash) };
  }

  /** Checkpoint path: same declared boundary and opsRoot produce the same leaf/root. */
  installRange(range: RangeLeaf): void {
    const rangeLeafHash = computeRangeLeafHash(range);
    const existing = this.ranges.find((item) => sameWriter(item, range) && item.fromSeq === range.fromSeq && item.uptoSeq === range.uptoSeq);
    if (existing) {
      if (!sameBytes(existing.rangeLeafHash, rangeLeafHash)) throw new Error('Conflicting checkpoint range');
      return;
    }
    this.assertNoOverlap(range);
    if ([...this.operations.values()].some((op) => sameWriter(op, range) && op.seq >= range.fromSeq && op.seq <= range.uptoSeq)) {
      const expected = this.describeRange(range.deviceId, range.incarnationId, range.fromSeq, range.uptoSeq);
      if (!sameBytes(expected.opsRoot, range.opsRoot)) throw new Error('Checkpoint does not match local operations');
      this.compactRange(range.deviceId, range.incarnationId, range.fromSeq, range.uptoSeq);
      return;
    }
    this.ranges.push({ ...range, opsRoot: new Uint8Array(range.opsRoot), rangeLeafHash });
  }

  private assertNoOverlap(range: Omit<RangeLeaf, 'opsRoot'>): void {
    validateSeq(range.fromSeq);
    validateSeq(range.uptoSeq);
    if (range.fromSeq > range.uptoSeq) throw new RangeError('Inverted range');
    if (this.ranges.some((item) => sameWriter(item, range) && item.fromSeq <= range.uptoSeq && range.fromSeq <= item.uptoSeq)) {
      throw new Error('Compaction ranges overlap');
    }
  }

  private describeRange(deviceId: string, incarnationId: string, fromSeq: bigint, uptoSeq: bigint): RangeLeaf {
    const range = { deviceId, incarnationId, fromSeq, uptoSeq };
    this.assertNoOverlap(range);
    const ops = [...this.operations.values()].filter((op) => sameWriter(op, range) && op.seq >= fromSeq && op.seq <= uptoSeq).sort(compareIdentity);
    // A checkpoint must not swallow a missing source sequence. Multiple ordinals per sequence are allowed.
    let expected = fromSeq;
    let previous: bigint | undefined;
    for (const op of ops) {
      if (op.seq !== previous) {
        if (op.seq !== expected) throw new Error('Cannot compact an incomplete range');
        expected++;
        previous = op.seq;
      }
    }
    if (expected !== uptoSeq + 1n) throw new Error('Cannot compact an incomplete range');
    return { ...range, opsRoot: computeMerkleRoot(ops.map((op) => op.opHash)) };
  }
}
