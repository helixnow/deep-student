import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeKeyedChunkId, createKeyring, deriveObjectDek, KeyringRollbackDetectedError, lpEncode, RemoteRollbackDetectedError, repoHeadSha256, repoHeadSigningBytes, RepoHeadWatermarkStore, revokeDeviceAndRotateMasterKey, rotatePassphraseSlot, signRepoHead, unlockKeyring } from '../src/v5_keyring.ts';
import type { RepoWatermark, SlotCredential } from '../src/v5_keyring.ts';
import { ContentIntegrityError, computeEntryRangeOffsets, decodeObjectHeader, decryptFramedEntry, encodeFrameAad, encodeFramedPack, encodeObjectHeader, FRAME_CIPHER_SIZE, frameNonce, readPackEntryRange, TrailingDataError, TruncatedObjectError, TruncatedStreamError, verifyFastCdcParameters } from '../src/v5_framed_pack.ts';
import { assertGcSnapshotUnchanged, computeGcLivePackSet, decodeIndexEntry, decodeShardedIndex, encodeIndexEntry, encodeShardedIndex, foldDeviceOperationsToCheckpoint, GcSnapshotChangedError, INDEX_ENTRY_SIZE, IndexChainManager, PENDING_TTL_MS, shardedObjectPath } from '../src/v5_index_and_checkpoint.ts';
import type { DeviceOperation, IndexEntry } from '../src/v5_index_and_checkpoint.ts';

const context = { magic: 'DSPK' as const, repoId: 'repo', deviceId: 'dev', incarnationId: 'inc', containerId: 'pack', contentEpoch: 0 };
const cdc = { gearSeed: 'repo-seed-1', min: 65536, avg: 262144, max: 1048576 };
const fastCdc = { actual: cdc, pinned: cdc };
function credentials(): SlotCredential[] {
  return [{ id: 'password', kind: 'passphrase', kek: randomBytes(32) }, { id: 'device-a', kind: 'device', deviceId: 'a', kek: randomBytes(32) }, { id: 'device-b', kind: 'device', deviceId: 'b', kek: randomBytes(32) }];
}
function indexEntry(index: number, epoch = 0): IndexEntry {
  return { chunkId: new Uint8Array(createHash('sha256').update(String(index)).digest()), contentEpoch: epoch, compression: 0, packTableIndex: 0, entryDataOffset: 64n, plaintextLength: 1, entryCiphertextLength: 17, entryIndex: index };
}

describe('Sync V5 Lane C acceptance G1–G11', () => {
  it('rejects empty, missing-endpoint, internal-gap and inverted checkpoint ranges', () => {
    const op = (seq: bigint, ordinal = 0): DeviceOperation => ({ deviceId: 'a', incarnationId: 'inc', sourceSeq: seq,
      ordinal, db: 'db', table: 'notes', recordId: '1', columns: {}, opHash: createHash('sha256').update(`${seq}:${ordinal}`).digest() });
    for (const ops of [[], [op(1n)], [op(2n), op(3n)], [op(1n), op(3n)], [op(1n), op(2n), { ...op(3n), deviceId: 'b' }]]) {
      expect(() => foldDeviceOperationsToCheckpoint(ops, 'a', 'inc', 1n, 3n)).toThrow('CHECKPOINT_GAP_ERROR');
    }
    expect(() => foldDeviceOperationsToCheckpoint([], 'a', 'inc', 3n, 1n)).toThrow('CHECKPOINT_GAP_ERROR');
    expect(foldDeviceOperationsToCheckpoint([op(2n), op(1n, 1), op(1n), op(3n)], 'a', 'inc', 1n, 3n).uptoSeq).toBe(3n);
  });
  it('G1: O(1)-in-data password rotation changes only passphrase slot and generation', () => {
    const creds = credentials(); const { keyring, secrets } = createKeyring('repo', creds);
    const newKek = randomBytes(32);
    const next = rotatePassphraseSlot(keyring, creds[0]!.kek, newKek);
    expect(next.generation).toBe(2n); expect(next.contentEpoch).toBe(0);
    expect(next.slots[1]).toBe(keyring.slots[1]); expect(next.slots[2]).toBe(keyring.slots[2]);
    const unlocked = unlockKeyring(next, 'password', newKek);
    expect(unlocked.kCid).toEqual(secrets.kCid); expect(unlocked.masterKeys).toEqual(secrets.masterKeys);
    expect(() => unlockKeyring(next, 'password', creds[0]!.kek)).toThrow();
    expect(keyring.generation).toBe(1n);
  });

  it('G2: revocation rotates MK, preserves historical keys and stable cross-epoch chunk IDs', async () => {
    const creds = credentials(); const { keyring, secrets } = createKeyring('repo', creds);
    const plaintext = randomBytes(65537); const oldKey = secrets.masterKeys.get(0)!;
    const oldPack = encodeFramedPack([plaintext], oldKey, secrets.kCid, context);
    const next = revokeDeviceAndRotateMasterKey(keyring, 'a', [creds[0]!, creds[2]!]);
    expect(next.contentEpoch).toBe(1); expect(next.generation).toBe(2n);
    expect(next.slots.some(s => s.deviceId === 'a')).toBe(false);
    expect(() => unlockKeyring(next, 'device-a', creds[1]!.kek)).toThrow();
    for (const c of [creds[0]!, creds[2]!]) {
      const unlocked = unlockKeyring(next, c.id, c.kek);
      expect(unlocked.kCid).toEqual(secrets.kCid); expect(unlocked.masterKeys.get(0)).toEqual(oldKey);
      expect(unlocked.masterKeys.get(1)).not.toEqual(oldKey);
      expect(computeKeyedChunkId(unlocked.kCid, plaintext)).toEqual(oldPack.entries[0]!.chunkId);
      expect(await readPackEntryRange({ getRange: async (_key, off, len) => oldPack.bytes.slice(off, off + len) }, 'old', oldPack.bytes.slice(0, 64), oldPack.bytes.length, oldPack.entries[0]!, unlocked.masterKeys.get(0)!, unlocked.kCid, context, fastCdc)).toEqual(new Uint8Array(plaintext));
    }
    expect(secrets.masterKeys.has(1)).toBe(false);
    expect(() => revokeDeviceAndRotateMasterKey(keyring, 'a', [creds[0]!])).toThrow(/Missing KEK/);
  });

  it('G3: lp removes all concatenation ambiguity and salts/incarnations isolate DEKs', () => {
    expect(Buffer.from(lpEncode('学')).readUInt16BE()).toBe(3);
    expect(() => lpEncode(new Uint8Array(65536))).toThrow(RangeError);
    const mk = randomBytes(32); const salt = randomBytes(16);
    const a = { ...context, repoId: 'ab', magic: 'c' }; const b = { ...context, repoId: 'a', magic: 'bc' };
    expect(deriveObjectDek(mk, salt, a)).not.toEqual(deriveObjectDek(mk, salt, b));
    expect(deriveObjectDek(mk, salt, context)).not.toEqual(deriveObjectDek(mk, randomBytes(16), context));
    expect(deriveObjectDek(mk, salt, context)).not.toEqual(deriveObjectDek(mk, salt, { ...context, incarnationId: 'restored' }));
    const frame = { ...context, chunkId: randomBytes(32), entryIndex: 0, plaintextLength: 1 };
    expect(encodeFrameAad({ ...frame, ...a }, 0, true)).not.toEqual(encodeFrameAad({ ...frame, ...b }, 0, true));
    expect(Buffer.from(frameNonce(0x12345678, 0x0102030405060708n)).toString('hex')).toBe('123456780102030405060708');
  });

  it('G4: exact 64B header layout, MAC-before-read, suite and epoch binding', async () => {
    const mk = randomBytes(32); const cid = randomBytes(32); const pack = encodeFramedPack([Buffer.from('x')], mk, cid, context);
    const header = Buffer.from(pack.bytes.slice(0, 64));
    expect(header.length).toBe(64); expect(header.toString('ascii', 0, 4)).toBe('DSPK');
    expect(header[4]).toBe(3); expect(header[5]).toBe(1); expect(header.readUInt16BE(6)).toBe(0);
    expect(header.readUInt32BE(24)).toBe(65536); expect(header.readUInt32BE(28)).toBe(1);
    expect(header.readBigUInt64BE(32)).toBe(1n); expect(header.readBigUInt64BE(40)).toBe(17n);
    const parsed = decodeObjectHeader(header, mk);
    expect(encodeObjectHeader(parsed, mk)).toEqual(new Uint8Array(header));
    let reads = 0; header[24] = (header[24] ?? 0) ^ 1;
    await expect(readPackEntryRange({ getRange: async () => { reads++; return new Uint8Array(); } }, 'p', header, pack.bytes.length, pack.entries[0]!, mk, cid, context, fastCdc)).rejects.toThrow(ContentIntegrityError);
    expect(reads).toBe(0);
    for (const magic of ['DSPK', 'DSSG', 'DSIX', 'DSCK'] as const) expect(decodeObjectHeader(encodeObjectHeader({ ...parsed, magic }, mk), mk).magic).toBe(magic);
  });

  it.each([0, 1, 65535, 65536, 65537, 1048576])('G5: %i bytes exact one-Range roundtrip and closed-form offsets', async length => {
    const mk = randomBytes(32); const kCid = randomBytes(32); const plain = randomBytes(length);
    const pack = encodeFramedPack([randomBytes(7), plain, randomBytes(17)], mk, kCid, context);
    const entry = pack.entries[1]!; const range = computeEntryRangeOffsets(entry.entryDataOffset, length);
    const calls: number[][] = [];
    const result = await readPackEntryRange({ getRange: async (_key, offset, count) => { calls.push([offset, count]); return pack.bytes.slice(offset, offset + count); } }, 'pack', pack.bytes.slice(0, 64), pack.bytes.length, entry, mk, kCid, context, fastCdc);
    expect(Buffer.from(result).equals(plain)).toBe(true); expect(calls).toEqual([[87, length + 16 * Math.max(1, Math.ceil(length / 65536))]]);
    expect(range.endExclusive).toBe(entry.entryDataOffset + entry.entryCiphertextLength);
    for (let i = 0; i < range.frameCount; i++) expect(range.frameOffset(i)).toBe(entry.entryDataOffset + i * FRAME_CIPHER_SIZE);
    expect(() => range.frameOffset(range.frameCount)).toThrow(RangeError);
  });

  it('G6: T1/T3/T4/T5/T6/T7 reject truncation, trailing data, substitutions and CDC drift', async () => {
    const mk = randomBytes(32); const kCid = randomBytes(32); const plain = randomBytes(65537);
    const pack = encodeFramedPack([plain, plain], mk, kCid, context); const entry = pack.entries[0]!;
    const header = decodeObjectHeader(pack.bytes.slice(0, 64), mk); const dek = deriveObjectDek(mk, header.objectSalt, context);
    const encrypted = pack.bytes.slice(entry.entryDataOffset, entry.entryDataOffset + entry.entryCiphertextLength);
    const frame = { ...context, ...entry };
    expect(() => decryptFramedEntry(encrypted.slice(0, -1), dek, frame, kCid)).toThrow(TruncatedStreamError);
    expect(() => decryptFramedEntry(encrypted.slice(0, FRAME_CIPHER_SIZE), dek, frame, kCid)).toThrow(TruncatedStreamError);
    expect(() => decryptFramedEntry(Buffer.concat([encrypted, Buffer.from([0])]), dek, frame, kCid)).toThrow(TrailingDataError);
    expect(() => decryptFramedEntry(encrypted, dek, frame, randomBytes(32))).toThrow(ContentIntegrityError);
    expect(() => decryptFramedEntry(encrypted, dek, { ...frame, entryIndex: 1 }, kCid)).toThrow();
    expect(() => decryptFramedEntry(encrypted, dek, { ...frame, repoId: 'other' }, kCid)).toThrow();
    expect(() => decryptFramedEntry(encrypted, dek, { ...frame, chunkId: randomBytes(32) }, kCid)).toThrow();
    const swapped = Buffer.concat([encrypted.slice(FRAME_CIPHER_SIZE), encrypted.slice(0, FRAME_CIPHER_SIZE)]);
    expect(() => decryptFramedEntry(swapped, dek, frame, kCid)).toThrow();
    const reader = { getRange: async () => encrypted.slice(0, -1) };
    const args = ['p', pack.bytes.slice(0, 64), pack.bytes.length, entry, mk, kCid, context, fastCdc] as const;
    await expect(readPackEntryRange(reader, ...args)).rejects.toThrow(TruncatedObjectError);
    await expect(readPackEntryRange(reader, 'p', args[1], pack.bytes.length - 1, entry, mk, kCid, context, fastCdc)).rejects.toThrow(TruncatedObjectError);
    await expect(readPackEntryRange(reader, 'p', args[1], pack.bytes.length + 1, entry, mk, kCid, context, fastCdc)).rejects.toThrow(TrailingDataError);
    expect(() => verifyFastCdcParameters({ ...cdc, gearSeed: 'bad' }, cdc)).toThrow(ContentIntegrityError);
    expect(() => verifyFastCdcParameters({ ...cdc, min: 1 }, cdc)).toThrow(ContentIntegrityError);
  });

  it('G7: DSPAIR2 anchor, owner signature, persistent head/keyring watermarks and fork detection', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyring = Buffer.from('keyring-2'); const keyringSha256 = createHash('sha256').update(keyring).digest('hex');
    // The signer takes the raw 32-byte seed and the anchor the raw 32-byte public key (the DER tails).
    const seed = new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
    const ownerPublicKey = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const head = await signRepoHead({ repoId: 'repo', generation: 10n, keyringGeneration: 2n, keyringSha256, prevSha256: '', payload: Buffer.from('constants') }, seed);
    expect(Buffer.from(head.signature)).toEqual(sign(null, repoHeadSigningBytes(head), privateKey));
    const storage = new Map<string, RepoWatermark>();
    const persistence = { load: async (id: string) => storage.get(id), save: async (id: string, value: RepoWatermark) => { storage.set(id, value); } };
    const anchor = { magic: 'DSPAIR2' as const, repoId: 'repo', repoHeadGen: 10n, repoHeadSha256: repoHeadSha256(head), ownerPublicKey };
    const store = new RepoHeadWatermarkStore(persistence, anchor);
    await store.verifyAndAdvance(head); await store.verifyKeyring('repo', 2n, keyring);
    await expect(store.verifyKeyring('repo', 1n, keyring)).rejects.toThrow(KeyringRollbackDetectedError);
    await expect(store.verifyKeyring('repo', 2n, Buffer.from('old'))).rejects.toThrow(KeyringRollbackDetectedError);
    const next = await signRepoHead({ ...head, generation: 11n, prevSha256: repoHeadSha256(head) }, seed);
    await store.verifyAndAdvance(next);
    await expect(new RepoHeadWatermarkStore(persistence, anchor).verifyAndAdvance(head)).rejects.toThrow(RemoteRollbackDetectedError);
    await expect(store.verifyAndAdvance({ ...next, payload: Buffer.from('tampered') })).rejects.toThrow(/signature/);
    await expect(store.verifyAndAdvance(await signRepoHead({ ...next, generation: 12n, keyringGeneration: 1n, prevSha256: repoHeadSha256(next) }, seed))).rejects.toThrow(KeyringRollbackDetectedError);
    await expect(new RepoHeadWatermarkStore({ load: async () => undefined, save: async () => undefined }, anchor).verifyAndAdvance(await signRepoHead({ ...head, generation: 9n }, seed))).rejects.toThrow(RemoteRollbackDetectedError);
    await expect(store.verifyAndAdvance(await signRepoHead({ ...next, generation: 12n, prevSha256: 'bad' }, seed))).rejects.toThrow(RemoteRollbackDetectedError);
  });

  it('G8: 16-shard binary index has exact 104B records and authenticated DSIX container', () => {
    const entries = Array.from({ length: 100 }, (_, i) => indexEntry(i));
    expect(encodeIndexEntry(entries[0]!).length).toBe(INDEX_ENTRY_SIZE);
    expect(decodeIndexEntry(encodeIndexEntry(entries[0]!))).toEqual(entries[0]);
    const index = { entries, packKeys: ['sync-v2/packs/dev/a/abc.dspk'], supersedes: ['old.dsix'] };
    const bytes = encodeShardedIndex(index); const decoded = decodeShardedIndex(bytes);
    expect(decoded.entries.length).toBe(100); expect(decoded.packKeys).toEqual(index.packKeys); expect(decoded.supersedes).toEqual(index.supersedes);
    expect(encodeShardedIndex(decoded)).toEqual(bytes);
    const mk = randomBytes(32); const kCid = randomBytes(32); const ctx = { ...context, magic: 'DSIX' as const };
    const pack = encodeFramedPack([bytes], mk, kCid, ctx); const header = decodeObjectHeader(pack.bytes.slice(0, 64), mk);
    expect(decryptFramedEntry(pack.bytes.slice(64), deriveObjectDek(mk, header.objectSalt, ctx), { ...ctx, ...pack.entries[0]! }, kCid)).toEqual(bytes);
    const corrupt = Buffer.from(bytes); corrupt[7] = (corrupt[7] ?? 0) ^ 1;
    expect(() => decodeShardedIndex(corrupt)).toThrow(/offset/);
    expect(() => decodeShardedIndex(bytes.slice(0, -1))).toThrow();
    expect(() => decodeShardedIndex(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
    const badRecord = Buffer.from(encodeIndexEntry(entries[0]!)); badRecord[103] = 1;
    expect(() => decodeIndexEntry(badRecord)).toThrow(/reserved/);
  });

  it('G9: 1,000 syncs stay <=9 live DSIX objects and compact explicit supersedes with correct pack remapping', () => {
    let manager = new IndexChainManager('dev'); const live = new Set<string>();
    const expectedPacks = new Map(Array.from({ length: 1000 }, (_, i) => [Buffer.from(indexEntry(i).chunkId).toString('hex'), `pack-${i}`]));
    let last: ReturnType<typeof manager.appendDelta> | undefined;
    for (let i = 0; i < 1000; i++) {
      last = manager.appendDelta({ entries: [indexEntry(i)], packKeys: [`pack-${i}`] });
      live.add(last.base.key); live.add(last.published.key);
      for (const old of last.supersedes) live.delete(old);
      expect(last.deltas.length).toBeLessThanOrEqual(8); expect(live.size).toBeLessThanOrEqual(9);
      expect(last.published.index.supersedes).toEqual(last.supersedes);
      if (i === 500) manager = new IndexChainManager('dev', manager.getState());
    }
    const ids = new Set<string>();
    for (const object of [last!.base, ...last!.deltas]) for (const e of decodeShardedIndex(object.bytes).entries) {
      const hex = Buffer.from(e.chunkId).toString('hex'); ids.add(hex);
      expect(object.index.packKeys[e.packTableIndex]).toBe(expectedPacks.get(hex));
    }
    expect(ids.size).toBe(1000);
    for (const nibble of '0123456789abcdef') expect(shardedObjectPath('packs', 'dev', `${nibble}123`)).toBe(`sync-v2/packs/dev/${nibble}/${nibble}123.dspk`);
    expect(shardedObjectPath('segments', 'dev', 'abc')).toBe('sync-v2/segments/dev/a/abc.dsseg');
    expect(() => shardedObjectPath('packs', '../dev', 'abc')).toThrow();
    const oversized = new IndexChainManager('dev').appendDelta({ entries: Array.from({ length: 4097 }, (_, i) => indexEntry(i)), packKeys: ['p'] });
    expect(oversized.deltas).toEqual([]); expect(oversized.base.index.entries.length).toBe(4097);
  });

  it('G10: checkpoint isolates writer/incarnation/range and preserves column/delete semilattice and range digest', () => {
    function op(seq: bigint, overrides: Partial<DeviceOperation> = {}): DeviceOperation {
      return { deviceId: 'a', incarnationId: 'inc', sourceSeq: seq, ordinal: 0, db: 'db', table: 'notes', recordId: '1', columns: { title: { value: `v${seq}`, hlc: `000${seq}`, writerDeviceId: 'a', sourceSeq: seq } }, opHash: createHash('sha256').update(String(seq)).digest(), chunkRefs: [`cid-${seq}`], ...overrides };
    }
    const input = [op(1n), op(2n, { deleteHlc: '0002', columns: {} }), op(3n, { columns: { body: { value: 'new', hlc: '0003', writerDeviceId: 'a', sourceSeq: 3n }, foreign: { value: 'forbidden', hlc: '9999', writerDeviceId: 'b', sourceSeq: 3n } } }),
      op(4n, { deviceId: 'b' }), op(5n, { incarnationId: 'other' }), op(6n), op(1n)];
    const checkpoint = foldDeviceOperationsToCheckpoint(input, 'a', 'inc', 1n, 3n);
    expect(checkpoint.rows.length).toBe(1);
    expect(Object.keys(checkpoint.rows[0]!.columns)).toEqual(['body']); expect(checkpoint.rows[0]!.columns.body!.value).toBe('new');
    expect(checkpoint.rows[0]!.deletion?.hlc).toBe('0002'); expect(checkpoint.chunkRefs).toEqual(['cid-1', 'cid-2', 'cid-3']);
    expect(foldDeviceOperationsToCheckpoint([...input].reverse(), 'a', 'inc', 1n, 3n)).toEqual(checkpoint);
    expect(checkpoint.rangeLeafHash.length).toBe(32);
    expect(() => foldDeviceOperationsToCheckpoint([op(1n), op(1n, { opHash: randomBytes(32) })], 'a', 'inc', 1n, 3n)).toThrow(/HistoryFork/);
    const huge = (1n << 63n) - 1n;
    expect(foldDeviceOperationsToCheckpoint([op(huge)], 'a', 'inc', huge, huge).rows[0]!.columns.title!.sourceSeq).toBe(huge);
    expect(foldDeviceOperationsToCheckpoint([op(1n, { table: '__plugin_sync_records' })], 'a', 'inc', 1n, 1n).rows[0]!.table).toBe('__plugin_sync_records');
  });

  it('G11: prepublication pending protects cross-epoch reused old packs through manifest handover and TTL', () => {
    const now = 1_000_000_000; const intent = { deviceId: 'a', attemptId: 'attempt', createdAtMs: now, packKeys: ['old-epoch-pack', 'new-pack'] };
    const before = [{ generation: 1n, packKeys: ['base-pack'], checkpointPackKeys: ['checkpoint-pack'] }];
    expect([...computeGcLivePackSet(before, [intent], now)]).toEqual(['base-pack', 'checkpoint-pack', 'old-epoch-pack', 'new-pack']);
    expect(computeGcLivePackSet(before, [intent], now + PENDING_TTL_MS).has('old-epoch-pack')).toBe(true);
    const after = [{ generation: 2n, packKeys: ['base-pack', ...intent.packKeys] }];
    expect(computeGcLivePackSet(after, [], now + 1).has('old-epoch-pack')).toBe(true);
    expect(computeGcLivePackSet(before, [intent], now + PENDING_TTL_MS + 1).has('old-epoch-pack')).toBe(false);
    expect(computeGcLivePackSet([{ generation: 0n, packKeys: ['retired'], status: 'retired' }], [], now).has('retired')).toBe(false);
    expect(() => computeGcLivePackSet(before, [{ ...intent, createdAtMs: NaN }], now)).toThrow(/abort GC/);
    const snapshot = { manifestGenerations: new Map([['a', 1n]]), pendingKeys: new Set(['a/attempt']) };
    expect(() => assertGcSnapshotUnchanged(snapshot, snapshot)).not.toThrow();
    expect(() => assertGcSnapshotUnchanged(snapshot, { ...snapshot, pendingKeys: new Set(['a/attempt', 'b/new']) })).toThrow(GcSnapshotChangedError);
    expect(() => assertGcSnapshotUnchanged(snapshot, { ...snapshot, manifestGenerations: new Map([['a', 2n]]) })).toThrow(GcSnapshotChangedError);
  });
});
