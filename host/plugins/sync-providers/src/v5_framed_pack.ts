import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { concatBytes, readU16be, readU32be, readU64be, u16be, u32be, u64be, writeU16be, writeU32be, writeU64be } from '../../../platform/util/bytes.ts';
import { aesGcmOpen, aesGcmSeal } from './aes-gcm.ts';
import { hmacSha256, randomBytes } from './hashing.ts';
import { computeKeyedChunkId, deriveObjectDek, equalBytes, lpEncode } from './v5_keyring.ts';
import type { ObjectKeyContext } from './v5_keyring.ts';

export const HEADER_SIZE = 64;
export const FRAME_PLAIN_SIZE = 65536;
export const FRAME_CIPHER_SIZE = 65552;
export type ObjectMagic = 'DSPK' | 'DSSG' | 'DSIX' | 'DSCK';
export class TruncatedStreamError extends Error {}
export class TruncatedObjectError extends TruncatedStreamError {}
export class TrailingDataError extends Error {}
export class ContentIntegrityError extends Error {}
export interface ObjectHeader {
  magic: ObjectMagic; contentEpoch: number; objectSalt: Uint8Array; entryOrFrameCount: number;
  totalPlaintextLen: bigint; totalCiphertextLen: bigint;
}
export function encodeObjectHeader(header: ObjectHeader, masterKey: Uint8Array): Uint8Array {
  if (!['DSPK', 'DSSG', 'DSIX', 'DSCK'].includes(header.magic) || header.objectSalt.length !== 16 || masterKey.length !== 32) throw new Error('Invalid header inputs');
  const bytes = new Uint8Array(HEADER_SIZE);
  bytes.set(utf8Encode(header.magic)); bytes[4] = 3; bytes[5] = 1;
  writeU16be(bytes, header.contentEpoch, 6); bytes.set(header.objectSalt, 8);
  writeU32be(bytes, FRAME_PLAIN_SIZE, 24); writeU32be(bytes, header.entryOrFrameCount, 28);
  writeU64be(bytes, header.totalPlaintextLen, 32); writeU64be(bytes, header.totalCiphertextLen, 40);
  bytes.set(hmacSha256(masterKey, bytes.subarray(0, 48)).subarray(0, 16), 48);
  return bytes;
}
/** T2: no caller can obtain parsed trusted header fields without MAC verification. */
export function decodeObjectHeader(input: Uint8Array, masterKey: Uint8Array): ObjectHeader {
  if (input.length < HEADER_SIZE) throw new TruncatedObjectError('Short header');
  if (input.length > HEADER_SIZE) throw new TrailingDataError('Expected exactly 64 header bytes');
  const bytes = new Uint8Array(input);
  if (masterKey.length !== 32 || !equalBytes(hmacSha256(masterKey, bytes.subarray(0, 48)).subarray(0, 16), bytes.subarray(48))) throw new ContentIntegrityError('Header MAC mismatch');
  const magic = String.fromCharCode(...bytes.subarray(0, 4)) as ObjectMagic;
  if (!['DSPK', 'DSSG', 'DSIX', 'DSCK'].includes(magic) || bytes[4] !== 3 || bytes[5] !== 1 || readU32be(bytes, 24) !== FRAME_PLAIN_SIZE) throw new ContentIntegrityError('Unsupported object format');
  return { magic, contentEpoch: readU16be(bytes, 6), objectSalt: bytes.subarray(8, 24), entryOrFrameCount: readU32be(bytes, 28), totalPlaintextLen: readU64be(bytes, 32), totalCiphertextLen: readU64be(bytes, 40) };
}
export interface FrameContext {
  magic: string; contentEpoch: number; repoId: string; containerId: string; entryIndex: number; chunkId: Uint8Array; plaintextLength: number;
}
export function frameNonce(entryIndex: number, frameIndex: number | bigint): Uint8Array {
  return concatBytes([u32be(entryIndex), u64be(BigInt(frameIndex))]);
}
export function encodeFrameAad(context: FrameContext, frameIndex: number | bigint, isFinal: boolean): Uint8Array {
  return concatBytes([lpEncode('DSFRM3'), lpEncode(context.magic), u16be(context.contentEpoch), lpEncode(context.repoId), lpEncode(context.containerId), u32be(context.entryIndex), lpEncode(context.chunkId), u64be(BigInt(frameIndex)), u64be(BigInt(context.plaintextLength)), Uint8Array.of(Number(isFinal))]);
}
export function computeEntryRangeOffsets(entryDataOffset: number, plaintextLength: number): { offset: number; length: number; frameCount: number; endExclusive: number; frameOffset: (index: number) => number } {
  if (!Number.isSafeInteger(entryDataOffset) || entryDataOffset < 0 || !Number.isSafeInteger(plaintextLength) || plaintextLength < 0) throw new RangeError('Unsafe entry length or offset');
  const frameCount = Math.max(1, Math.ceil(plaintextLength / FRAME_PLAIN_SIZE));
  const length = plaintextLength + 16 * frameCount;
  if (!Number.isSafeInteger(entryDataOffset + length)) throw new RangeError('Unsafe range');
  return { offset: entryDataOffset, length, frameCount, endExclusive: entryDataOffset + length, frameOffset: index => {
    if (!Number.isInteger(index) || index < 0 || index >= frameCount) throw new RangeError('Frame index out of range');
    return entryDataOffset + index * FRAME_CIPHER_SIZE;
  } };
}
export function encryptFramedEntry(plaintext: Uint8Array, dek: Uint8Array, context: FrameContext): Uint8Array {
  if (plaintext.length !== context.plaintextLength) throw new Error('Plaintext length mismatch');
  const { frameCount } = computeEntryRangeOffsets(0, plaintext.length);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    // Each frame is `ciphertext ‖ 16-byte tag`.
    frames.push(aesGcmSeal(dek, frameNonce(context.entryIndex, i), encodeFrameAad(context, i, i === frameCount - 1),
      plaintext.subarray(i * FRAME_PLAIN_SIZE, (i + 1) * FRAME_PLAIN_SIZE)));
  }
  return concatBytes(frames);
}
/** T3/T4/T6: fixed frame count, authenticated final flag, no trailing bytes, keyed content verification. */
export function decryptFramedEntry(ciphertext: Uint8Array, dek: Uint8Array, context: FrameContext, kCid: Uint8Array): Uint8Array {
  const { length, frameCount } = computeEntryRangeOffsets(0, context.plaintextLength);
  if (ciphertext.length < length) throw new TruncatedStreamError('Final authenticated frame missing');
  if (ciphertext.length > length) throw new TrailingDataError('Bytes after final frame');
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = ciphertext.subarray(i * FRAME_CIPHER_SIZE, Math.min((i + 1) * FRAME_CIPHER_SIZE, length));
    frames.push(aesGcmOpen(dek, frameNonce(context.entryIndex, i), encodeFrameAad(context, i, i === frameCount - 1), frame));
  }
  const plaintext = concatBytes(frames);
  if (!equalBytes(computeKeyedChunkId(kCid, plaintext), context.chunkId)) throw new ContentIntegrityError('Keyed chunk ID mismatch');
  return plaintext;
}
export interface FastCdcParameters { gearSeed: string; min: number; avg: number; max: number }
/** The seed is pinned by the verified repo-head, not chosen by a remote object. */
export function verifyFastCdcParameters(actual: FastCdcParameters, pinned: FastCdcParameters): void {
  if (!pinned.gearSeed || actual.gearSeed !== pinned.gearSeed || actual.min !== 65536 || actual.avg !== 262144 || actual.max !== 1048576 || actual.min !== pinned.min || actual.avg !== pinned.avg || actual.max !== pinned.max) throw new ContentIntegrityError('FastCDC parameters differ from repository constants');
}
export interface PackEntryLocation { entryIndex: number; entryDataOffset: number; plaintextLength: number; entryCiphertextLength: number; chunkId: Uint8Array; contentEpoch: number }
export interface PackContext extends ObjectKeyContext { magic: ObjectMagic; containerId: string; contentEpoch: number }
export function encodeFramedPack(plaintexts: Uint8Array[], masterKey: Uint8Array, kCid: Uint8Array, context: PackContext): { bytes: Uint8Array; entries: PackEntryLocation[] } {
  const objectSalt = randomBytes(16);
  const dek = deriveObjectDek(masterKey, objectSalt, context);
  let offset = HEADER_SIZE;
  const entries: PackEntryLocation[] = [];
  const encrypted = plaintexts.map((plaintext, entryIndex) => {
    const chunkId = computeKeyedChunkId(kCid, plaintext);
    const ciphertext = encryptFramedEntry(plaintext, dek, { ...context, entryIndex, chunkId, plaintextLength: plaintext.length });
    entries.push({ entryIndex, entryDataOffset: offset, plaintextLength: plaintext.length, entryCiphertextLength: ciphertext.length, chunkId, contentEpoch: context.contentEpoch });
    offset += ciphertext.length; return ciphertext;
  });
  const header = encodeObjectHeader({ magic: context.magic, contentEpoch: context.contentEpoch, objectSalt, entryOrFrameCount: entries.length,
    totalPlaintextLen: plaintexts.reduce((n, p) => n + BigInt(p.length), 0n), totalCiphertextLen: BigInt(offset - HEADER_SIZE) }, masterKey);
  return { bytes: concatBytes([header, ...encrypted]), entries };
}
export interface RangeReader { getRange(key: string, offset: number, length: number): Promise<Uint8Array> }
export async function readPackEntryRange(reader: RangeReader, packKey: string, headerBytes: Uint8Array, statSize: number | bigint, location: PackEntryLocation, masterKey: Uint8Array, kCid: Uint8Array, context: PackContext, fastCdc: { actual: FastCdcParameters; pinned: FastCdcParameters }, footerLength = 0): Promise<Uint8Array> {
  const header = decodeObjectHeader(headerBytes, masterKey); // T2 before reading frames
  const expectedSize = 64n + header.totalCiphertextLen + BigInt(footerLength);
  if (BigInt(statSize) < expectedSize) throw new TruncatedObjectError('T1: truncated object');
  if (BigInt(statSize) > expectedSize) throw new TrailingDataError('T1: oversized object');
  verifyFastCdcParameters(fastCdc.actual, fastCdc.pinned); // T7
  if (header.magic !== context.magic || header.contentEpoch !== context.contentEpoch || location.contentEpoch !== header.contentEpoch || location.entryIndex < 0 || location.entryIndex >= header.entryOrFrameCount) throw new ContentIntegrityError('Index/header context mismatch');
  const range = computeEntryRangeOffsets(location.entryDataOffset, location.plaintextLength);
  if (range.length !== location.entryCiphertextLength || range.offset < 64 || BigInt(range.endExclusive) > 64n + header.totalCiphertextLen || BigInt(location.plaintextLength) > header.totalPlaintextLen) throw new ContentIntegrityError('Index entry outside pack');
  const ciphertext = await reader.getRange(packKey, range.offset, range.length); // exactly one request
  if (ciphertext.length < range.length) throw new TruncatedObjectError('T5: short Range response');
  return decryptFramedEntry(ciphertext, deriveObjectDek(masterKey, header.objectSalt, context), { ...context, ...location }, kCid);
}
