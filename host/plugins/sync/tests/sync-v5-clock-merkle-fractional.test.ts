import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hlc, HlcClock, MAX_DRIFT_MS, MAX_HLC_COUNTER, MAX_HLC_MILLIS } from '../src/hlc.ts';
import { comparePositionRecords, generatePositionKeyBetween, splitTieGroupForInsertion } from '../src/fractional-index.ts';
import {
  computeCanonicalOpHash, computeMerkleRoot, computeRangeLeafHash, DeduplicatedMerkleLedger,
  formatWriterKey, HistoryForkError, lpEncode, MAX_SOURCE_SEQ, MultiIncarnationVersionVector, parseWriterKey,
} from '../src/version-vector.ts';
import type { CanonicalOperation, HashedOperation } from '../src/version-vector.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const operation = (seq = 1n, ordinal = 0): CanonicalOperation => ({
  db: 'chat_v2', table: 'records', recordId: '记录', op: 1, hlc: new Hlc(100n, 0).toString(),
  deviceId: 'device', incarnationId: 'inc1', seq, ordinal, canonicalPayload: '{"a":1}',
});
const hashed = (seq = 1n, ordinal = 0): HashedOperation => ({ ...operation(seq, ordinal), opHash: computeCanonicalOpHash(operation(seq, ordinal)) });

describe('causality-preserving writable HLC', () => {
  it('retains the legacy codec and drift constant', () => {
    expect(MAX_DRIFT_MS).toBe(60_000);
    expect(Hlc.ZERO.toString()).toBe('000000000000000-00000');
    expect(Hlc.parse('18446744073709551615-65535')?.millis).toBe((1n << 64n) - 1n);
    const hlc = new Hlc(123456n, 12);
    expect(Hlc.fromU64(hlc.toU64())).toEqual(hlc);
  });

  it('fully absorbs 10:05 so the causally later edit is strictly greater', () => {
    const wall = BigInt((10 * 60 + 4) * 60 * 1000);
    const remote = new Hlc(wall + 60_000n, 44);
    const clock = new HlcClock();
    const received = clock.receive(remote, wall);
    expect(received.decision).toBe('absorb');
    expect(received.preservedRemoteHlc).toBe(remote);
    expect(received.localHlc).toEqual(remote);
    expect(clock.tick(wall).toU64()).toBeGreaterThan(remote.toU64());
  });

  it('isolates 10:05 from a 10:00 wall, then force-absorbs unchanged remote HLC', () => {
    const wall = 36_000_000n;
    const remote = new Hlc(wall + 300_000n, 17);
    const clock = new HlcClock();
    const before = clock.tick(wall);
    const result = clock.receive(remote, wall);
    expect(result).toEqual({ decision: 'defer_skew', localHlc: before, preservedRemoteHlc: remote, driftMs: 300_000n });
    expect(result.preservedRemoteHlc).toBe(remote);
    expect(clock.tick(wall).millis).toBe(wall);
    clock.forceAbsorb(remote, wall);
    expect(clock.tick(wall).toU64()).toBeGreaterThan(remote.toU64());
  });

  it('absorbs after physical time catches up without rewriting remote', () => {
    const remote = new Hlc(120_001n, 9);
    const clock = new HlcClock();
    expect(clock.receive(remote, 60_000n).decision).toBe('defer_skew');
    expect(clock.receive(remote, 60_001n).decision).toBe('absorb');
    expect(clock.tick(60_001n).toU64()).toBeGreaterThan(remote.toU64());
  });

  it('clamps local forward jumps using monotonic elapsed time and tolerates rollback', () => {
    const clock = new HlcClock();
    clock.tick(1000n);
    expect(clock.tick(99_999_999n, 10n).millis).toBe(1010n);
    expect(clock.tick(0n).millis).toBe(1010n);
    expect(clock.tick(1010n).counter).toBe(2);
  });

  it('carries counter overflow and validates candidates before assigning state', () => {
    expect(() => new HlcClock(new Hlc(100n, MAX_HLC_COUNTER + 1))).toThrow(RangeError);
    const clock = new HlcClock(new Hlc(100n, MAX_HLC_COUNTER));
    expect(clock.tick(100n)).toEqual(new Hlc(101n, 0));
    expect(() => clock.tick(MAX_HLC_MILLIS + 1n)).toThrow(RangeError);
    expect(() => clock.forceAbsorb(new Hlc(MAX_HLC_MILLIS + 1n, 0), 0n)).toThrow(RangeError);
    expect(() => clock.receive(new Hlc(1n, -1), 0n)).toThrow(RangeError);
    expect(() => clock.tick(100n, -1n)).toThrow(RangeError);
    expect(clock.tick(100n)).toEqual(new Hlc(101n, 1));
    const exhausted = new HlcClock(new Hlc(MAX_HLC_MILLIS, MAX_HLC_COUNTER));
    expect(() => exhausted.tick(0n)).toThrow(RangeError);
    expect(exhausted.receive(new Hlc(0n, 0), 0n).localHlc).toEqual(new Hlc(MAX_HLC_MILLIS, MAX_HLC_COUNTER));
  });

  it('never loses local counter when absorbing older or concurrent clocks', () => {
    const clock = new HlcClock(new Hlc(100n, 20));
    clock.receive(new Hlc(100n, 10), 90n);
    expect(clock.tick(90n)).toEqual(new Hlc(100n, 21));
    clock.receive(new Hlc(100n, 30), 90n);
    expect(clock.tick(90n)).toEqual(new Hlc(100n, 31));
  });
});

describe('rocicorp-compatible pure Base-62 positions', () => {
  it('uses variable-length integers for 5,000 tail appends', () => {
    let left: string | null = null;
    for (let i = 0; i < 5000; i++) {
      const key = generatePositionKeyBetween(left, null);
      expect(key).toMatch(/^[0-9A-Za-z]+$/);
      expect(key.length).toBeLessThanOrEqual(4);
      if (left !== null) expect(key > left).toBe(true);
      left = key;
    }
  });

  it('matches known integer-boundary and fractional examples', () => {
    expect(generatePositionKeyBetween(null, null)).toBe('a0');
    expect(generatePositionKeyBetween('a0', null)).toBe('a1');
    expect(generatePositionKeyBetween('az', null)).toBe('b00');
    expect(generatePositionKeyBetween(null, 'a0')).toBe('Zz');
    expect(generatePositionKeyBetween(null, 'Z0')).toBe('Yzz');
    expect(generatePositionKeyBetween('Zz', 'a0')).toBe('ZzV');
    expect(generatePositionKeyBetween('a0', 'a1')).toBe('a0V');
    expect(generatePositionKeyBetween('a0', 'a0V')).toBe('a0G');
    expect(generatePositionKeyBetween('a0V', 'a0W')).toBe('a0VV');
    expect(generatePositionKeyBetween(null, 'a0V')).toBe('a0');
  });

  it('supports repeated tight gaps and deterministic scattered insertions', () => {
    let right = 'a1';
    for (let i = 0; i < 250; i++) {
      const next = generatePositionKeyBetween('a0', right);
      expect(next > 'a0' && next < right).toBe(true);
      right = next;
    }
    const keys = ['a0'];
    for (let i = 0; i < 500; i++) {
      const at = (i * 37) % (keys.length + 1);
      const key = generatePositionKeyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      if (at > 0) expect(key > keys[at - 1]!).toBe(true);
      if (at < keys.length) expect(key < keys[at]!).toBe(true);
      keys.splice(at, 0, key);
    }
  });

  it('orders tie-break fields using UTF-8 bytes rather than locale or UTF-16', () => {
    const a = { positionKey: 'a0V', deviceId: '\uE000', id: 'a' };
    const b = { ...a, deviceId: '\u{10000}' };
    expect(comparePositionRecords(a, b)).toBeLessThan(0);
    expect(comparePositionRecords(a, { ...a, id: 'b' })).toBeLessThan(0);
    expect(comparePositionRecords(a, { ...a, positionKey: 'a1', deviceId: 'a' })).toBeLessThan(0);
    expect(comparePositionRecords(a, a)).toBe(0);
  });

  it.each(['a1', null])('splits a tied gap atomically before %s', (nextDistinctKey) => {
    const tie = { positionKey: 'a0V' };
    const { advancedRightKey, insertedMidKey } = splitTieGroupForInsertion(tie, tie, nextDistinctKey);
    expect(tie.positionKey < insertedMidKey && insertedMidKey < advancedRightKey).toBe(true);
    if (nextDistinctKey !== null) expect(advancedRightKey < nextDistinctKey).toBe(true);
    expect(tie.positionKey).toBe('a0V');
  });

  it('rejects tied/reversed bounds, invalid alphabets and fractions ending in zero', () => {
    for (const [left, right] of [['a1', 'a0'], ['a0', 'a0'], ['a0!', 'a1'], ['a0V0', 'a1']]) {
      expect(() => generatePositionKeyBetween(left!, right!)).toThrow();
    }
    expect(() => splitTieGroupForInsertion({ positionKey: 'a0' }, { positionKey: 'a1' }, null)).toThrow();
  });
});

describe('multi-incarnation version vectors and canonical hashes', () => {
  it('length-prefixes UTF-8 byte lengths and disambiguates adjacent fields', () => {
    expect([...lpEncode('中')]).toEqual([0, 3, 0xe4, 0xb8, 0xad]);
    expect([...lpEncode(Uint8Array.of(0, 255))]).toEqual([0, 2, 0, 255]);
    expect(() => lpEncode(new Uint8Array(65536))).toThrow(RangeError);
    expect(Buffer.concat([lpEncode('ab'), lpEncode('c')])).not.toEqual(Buffer.concat([lpEncode('a'), lpEncode('bc')]));
  });

  it('parses unambiguous writer keys', () => {
    expect(parseWriterKey(formatWriterKey('dev', 'inc'))).toEqual({ deviceId: 'dev', incarnationId: 'inc' });
    expect(() => formatWriterKey('a@b', 'c')).toThrow();
    expect(() => parseWriterKey('dev@inc@other')).toThrow();
  });

  it('preserves old incarnation slots and automatically rotates a restored writer', () => {
    const vector = new MultiIncarnationVersionVector({}, () => 'inc2');
    vector.observe('device', 'inc1', 10n, 'old-head');
    expect(vector.resumeWriter('device', 'inc1', 5n)).toBe('device@inc2');
    expect(vector.nextSequence('device')).toEqual({ writerKey: 'device@inc2', seq: 1n });
    vector.observe('device', 'inc1', 12n, 'new-head');
    expect(vector.get('device@inc1')).toEqual({ contiguousSeq: 12n, headSegmentSha256: 'new-head' });
    expect(vector.get('device@inc2')?.contiguousSeq).toBe(1n);
    vector.observe('device', 'inc1', 2n, 'stale');
    expect(vector.get('device@inc1')?.contiguousSeq).toBe(12n);
    expect(Object.keys(vector.toJSON())).toHaveLength(2);
  });

  it('allows repackaged segment heads without treating them as history forks', () => {
    const vector = new MultiIncarnationVersionVector();
    vector.observe('d', 'i', 4n, 'head1');
    vector.observe('d', 'i', 4n, 'head2');
    expect(vector.get('d@i')?.headSegmentSha256).toBe('head2');
    vector.resumeWriter('d', 'i', 4n);
    expect(vector.nextSequence('d').seq).toBe(5n);
  });

  it('enforces signed SQLite sequence bounds without mutating a writer on overflow', () => {
    const vector = new MultiIncarnationVersionVector();
    expect(() => vector.observe('d', 'i', -1n)).toThrow(RangeError);
    expect(() => vector.observe('d', 'i', MAX_SOURCE_SEQ + 1n)).toThrow(RangeError);
    vector.resumeWriter('d', 'i', MAX_SOURCE_SEQ);
    expect(() => vector.nextSequence('d')).toThrow(RangeError);
    expect(vector.get('d@i')?.contiguousSeq).toBe(MAX_SOURCE_SEQ);
  });

  it('matches an independent byte-level canonical hash formula', () => {
    const op = operation(0x0102030405060708n, 0x12345678);
    const lp = (text: string): Buffer => {
      const body = Buffer.from(text);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(body.length);
      return Buffer.concat([length, body]);
    };
    const sequence = Buffer.alloc(8);
    sequence.writeBigUInt64BE(op.seq);
    const ordinal = Buffer.from('12345678', 'hex');
    const expected = createHash('sha256').update(Buffer.concat([
      Buffer.from([0]), lp(op.db), lp(op.table), lp(op.recordId), Buffer.from([op.op]), lp(op.hlc),
      lp(op.deviceId), lp(op.incarnationId), sequence, ordinal,
      createHash('sha256').update(op.canonicalPayload).digest(),
    ])).digest('hex');
    expect(hex(computeCanonicalOpHash(op))).toBe(expected);
    expect(computeCanonicalOpHash(op)).toEqual(computeCanonicalOpHash({ ...op, canonicalPayload: Buffer.from(op.canonicalPayload) }));
  });

  it('binds every identity, scope, clock and payload field', () => {
    const original = operation();
    const variants: Partial<CanonicalOperation>[] = [
      { db: 'other' }, { table: 'other' }, { recordId: 'other' }, { op: 2 }, { hlc: 'other' },
      { deviceId: 'other' }, { incarnationId: 'other' }, { seq: 2n }, { ordinal: 1 }, { canonicalPayload: '{}' },
    ];
    for (const variant of variants) expect(hex(computeCanonicalOpHash({ ...original, ...variant }))).not.toBe(hex(computeCanonicalOpHash(original)));
    expect(() => computeCanonicalOpHash({ ...original, op: 256 })).toThrow(RangeError);
    expect(() => computeCanonicalOpHash({ ...original, ordinal: 2 ** 32 })).toThrow(RangeError);
  });
});

describe('deduplication-first interval-compressible Merkle ledger', () => {
  it.each([2, 3, 10])('keeps the root unchanged after %i identical deliveries', (count) => {
    const ledger = new DeduplicatedMerkleLedger();
    const op = hashed();
    expect(ledger.add(op)).toBe('added');
    const root = hex(ledger.root());
    for (let i = 1; i < count; i++) expect(ledger.add(op)).toBe('duplicate');
    expect(hex(ledger.root())).toBe(root);
    expect(ledger.operationCount).toBe(1);
  });

  it('detects forks before changing its root, but permits other ordinals/incarnations', () => {
    const ledger = new DeduplicatedMerkleLedger();
    const op = hashed();
    ledger.add(op);
    const root = hex(ledger.root());
    expect(() => ledger.add({ ...op, opHash: new Uint8Array(32) })).toThrow(HistoryForkError);
    expect(hex(ledger.root())).toBe(root);
    expect(ledger.add(hashed(1n, 1))).toBe('added');
    expect(ledger.add({ ...op, incarnationId: 'inc2' })).toBe('added');
  });

  it('is independent of delivery order, non-XOR, and copies externally owned hashes', () => {
    const forward = new DeduplicatedMerkleLedger();
    const reverse = new DeduplicatedMerkleLedger();
    const ops = [hashed(1n), hashed(2n), hashed(3n)];
    for (const op of ops) forward.add(op);
    for (const op of [...ops].reverse()) reverse.add(op);
    expect(forward.root()).toEqual(reverse.root());
    const root = hex(forward.root());
    ops[0]!.opHash.fill(0);
    expect(hex(forward.root())).toBe(root);
    expect(root).not.toBe('00'.repeat(32));
  });

  it('folds operations into one range leaf preserving its interval digest', () => {
    const ledger = new DeduplicatedMerkleLedger();
    for (let seq = 1n; seq <= 20n; seq++) ledger.add(hashed(seq));
    ledger.add(hashed(3n, 1));
    const before = ledger.rangeDigest('device', 'inc1', 1n, 20n);
    const range = ledger.compactRange('device', 'inc1', 1n, 20n);
    expect(ledger.operationCount).toBe(0);
    expect(ledger.rangeCount).toBe(1);
    expect(range.rangeLeafHash).toEqual(before);
    expect(ledger.rangeDigest('device', 'inc1', 1n, 20n)).toEqual(before);
    expect(ledger.root()).toEqual(before);
    expect(ledger.add(hashed(3n))).toBe('duplicate');
    expect(ledger.root()).toEqual(before);
    expect(() => ledger.add({ ...hashed(3n), opHash: new Uint8Array(32) })).toThrow(HistoryForkError);
  });

  it('converges replay and checkpoint paths at identical manifest boundaries', () => {
    const replay = new DeduplicatedMerkleLedger();
    const checkpoint = new DeduplicatedMerkleLedger();
    for (let seq = 1n; seq <= 5n; seq++) replay.add(hashed(seq));
    const range = replay.compactRange('device', 'inc1', 1n, 4n);
    checkpoint.installRange(range);
    checkpoint.installRange(range);
    checkpoint.add(hashed(5n));
    expect(() => checkpoint.add(hashed(1n))).toThrow('identity witness');
    expect(checkpoint.root()).toEqual(replay.root());
    expect(checkpoint.rangeCount).toBe(1);
    const partialReplay = new DeduplicatedMerkleLedger();
    for (let seq = 1n; seq <= 4n; seq++) partialReplay.add(hashed(seq));
    partialReplay.installRange(range);
    expect(partialReplay.root()).toEqual(range.rangeLeafHash);
  });

  it('uses the specified range domain and byte layout', () => {
    const opsRoot = computeMerkleRoot([hashed().opHash, hashed(2n).opHash]);
    const from = Buffer.alloc(8); from.writeBigUInt64BE(1n);
    const upto = Buffer.alloc(8); upto.writeBigUInt64BE(2n);
    const expected = createHash('sha256').update(Buffer.concat([
      Buffer.from([2]), lpEncode('device'), lpEncode('inc1'), from, upto, opsRoot,
    ])).digest('hex');
    expect(hex(computeRangeLeafHash({ deviceId: 'device', incarnationId: 'inc1', fromSeq: 1n, uptoSeq: 2n, opsRoot }))).toBe(expected);
  });

  it('rejects incomplete/overlapping intervals without consuming operations', () => {
    const ledger = new DeduplicatedMerkleLedger();
    ledger.add(hashed(1n)); ledger.add(hashed(3n));
    const before = hex(ledger.root());
    expect(() => ledger.compactRange('device', 'inc1', 1n, 3n)).toThrow('incomplete');
    expect(hex(ledger.root())).toBe(before);
    ledger.add(hashed(2n));
    ledger.compactRange('device', 'inc1', 1n, 2n);
    expect(() => ledger.compactRange('device', 'inc1', 2n, 3n)).toThrow('overlap');
    expect(ledger.operationCount).toBe(1);
  });
});
