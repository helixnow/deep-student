import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { timingSafeEqual, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { concatBytes, readU16be, u16be, u64be, writeU16be } from '../../../platform/util/bytes.ts';
import { aesGcmOpen, aesGcmSeal } from './aes-gcm.ts';
import { hmacSha256, randomBytes, sha256Hex } from './hashing.ts';

export const KEYRING_PATH = 'sync-v2/.keyring';
export function lpEncode(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? utf8Encode(value) : value;
  if (bytes.length > 65535) throw new RangeError('lp length exceeds u16');
  return concatBytes([u16be(bytes.length), bytes]);
}
export function computeKeyedChunkId(kCid: Uint8Array, plaintext: Uint8Array): Uint8Array {
  requireKey(kCid); return hmacSha256(kCid, plaintext);
}
function requireKey(key: Uint8Array): void {
  if (key.length !== 32) throw new RangeError('Expected a 32-byte key');
}
export interface ObjectKeyContext { magic: string; repoId: string; deviceId: string; incarnationId: string }
export function deriveObjectDek(masterKey: Uint8Array, objectSalt: Uint8Array, context: ObjectKeyContext): Uint8Array {
  requireKey(masterKey);
  if (objectSalt.length !== 16) throw new RangeError('Expected a 16-byte object salt');
  const info = concatBytes(['ds/obj/v3', context.magic, context.repoId, context.deviceId, context.incarnationId].map(lpEncode));
  return hkdf(sha256, masterKey, objectSalt, info, 32);
}

export interface KeyringSecrets { kCid: Uint8Array; masterKeys: Map<number, Uint8Array> }
export interface KeySlot { id: string; kind: 'passphrase' | 'device'; deviceId?: string; nonce: Uint8Array; wrapped: Uint8Array }
export interface V5Keyring { magic: 'DSKEYRING3'; repoId: string; generation: bigint; contentEpoch: number; slots: KeySlot[] }
export interface SlotCredential { id: string; kind: 'passphrase' | 'device'; deviceId?: string; kek: Uint8Array }
function slotAad(repoId: string, slot: Pick<KeySlot, 'id' | 'kind' | 'deviceId'>): Uint8Array {
  return concatBytes(['DSKEYRING3', repoId, slot.id, slot.kind, slot.deviceId ?? ''].map(lpEncode));
}
function encodeSecrets(secrets: KeyringSecrets): Uint8Array {
  requireKey(secrets.kCid);
  const output = new Uint8Array(34 + secrets.masterKeys.size * 34);
  output.set(secrets.kCid); writeU16be(output, secrets.masterKeys.size, 32);
  let offset = 34;
  for (const [epoch, key] of [...secrets.masterKeys].sort(([a], [b]) => a - b)) {
    requireKey(key); writeU16be(output, epoch, offset); output.set(key, offset + 2); offset += 34;
  }
  return output;
}
function wrap(repoId: string, credential: SlotCredential, secrets: KeyringSecrets): KeySlot {
  requireKey(credential.kek);
  const nonce = randomBytes(12);
  // `ciphertext ‖ 16-byte tag`, the layout the slot has always used.
  return { id: credential.id, kind: credential.kind, deviceId: credential.deviceId, nonce,
    wrapped: aesGcmSeal(credential.kek, nonce, slotAad(repoId, credential), encodeSecrets(secrets)) };
}
/** KEKs are derived once by the platform Argon2id bridge, never per object. */
export function createKeyring(repoId: string, credentials: SlotCredential[]): { keyring: V5Keyring; secrets: KeyringSecrets } {
  if (credentials.filter(s => s.kind === 'passphrase').length !== 1 || new Set(credentials.map(s => s.id)).size !== credentials.length) throw new Error('Require one passphrase slot and unique slot IDs');
  const secrets = { kCid: randomBytes(32), masterKeys: new Map([[0, randomBytes(32)]]) };
  return { keyring: { magic: 'DSKEYRING3', repoId, generation: 1n, contentEpoch: 0, slots: credentials.map(c => wrap(repoId, c, secrets)) }, secrets };
}
export function unlockKeyring(keyring: V5Keyring, slotId: string, kek: Uint8Array): KeyringSecrets {
  requireKey(kek);
  if (keyring.magic !== 'DSKEYRING3') throw new Error('Invalid keyring magic');
  const slot = keyring.slots.find(s => s.id === slotId);
  if (!slot || slot.wrapped.length < 16) throw new Error('Missing or invalid slot');
  const bytes = aesGcmOpen(kek, slot.nonce, slotAad(keyring.repoId, slot), slot.wrapped);
  if (bytes.length < 34 || bytes.length !== 34 + readU16be(bytes, 32) * 34) throw new Error('Invalid slot payload');
  const masterKeys = new Map<number, Uint8Array>();
  for (let offset = 34; offset < bytes.length; offset += 34) {
    const epoch = readU16be(bytes, offset);
    if (masterKeys.has(epoch)) throw new Error('Duplicate epoch');
    masterKeys.set(epoch, bytes.slice(offset + 2, offset + 34));
  }
  if (!masterKeys.has(keyring.contentEpoch)) throw new Error('Missing current master key');
  return { kCid: bytes.slice(0, 32), masterKeys };
}
export function rotatePassphraseSlot(keyring: V5Keyring, oldKek: Uint8Array, newKek: Uint8Array): V5Keyring {
  const slot = keyring.slots.find(s => s.kind === 'passphrase');
  if (!slot) throw new Error('Missing passphrase slot');
  const secrets = unlockKeyring(keyring, slot.id, oldKek);
  const replacement = wrap(keyring.repoId, { ...slot, kek: newKek }, secrets);
  return { ...keyring, generation: keyring.generation + 1n, slots: keyring.slots.map(s => s === slot ? replacement : s) };
}
export function revokeDeviceAndRotateMasterKey(keyring: V5Keyring, deviceId: string, credentials: SlotCredential[]): V5Keyring {
  if (keyring.contentEpoch === 65535) throw new RangeError('Content epoch exhausted');
  const remaining = keyring.slots.filter(s => !(s.kind === 'device' && s.deviceId === deviceId));
  if (remaining.length === keyring.slots.length) throw new Error('Device slot not found');
  const matched = remaining.map(slot => {
    const credential = credentials.find(c => c.id === slot.id && c.kind === slot.kind && c.deviceId === slot.deviceId);
    if (!credential) throw new Error(`Missing KEK for surviving slot ${slot.id}`);
    return credential;
  });
  if (!matched.length) throw new Error('Cannot revoke last slot');
  const secrets = unlockKeyring(keyring, matched[0]!.id, matched[0]!.kek);
  secrets.masterKeys.set(keyring.contentEpoch + 1, randomBytes(32));
  return { ...keyring, generation: keyring.generation + 1n, contentEpoch: keyring.contentEpoch + 1,
    slots: matched.map(c => wrap(keyring.repoId, c, secrets)) };
}

export class KeyringRollbackDetectedError extends Error {}
export class RemoteRollbackDetectedError extends Error {}
export interface RepoHead { repoId: string; generation: bigint; keyringGeneration: bigint; keyringSha256: string; prevSha256: string; payload: Uint8Array; signature: Uint8Array }
/** `ownerPublicKey` is the raw 32-byte Ed25519 public key (the bytes behind DSPAIR2 `ownerPubkeyHex`). */
export interface PairingAnchor { magic: 'DSPAIR2'; repoId: string; repoHeadGen: bigint; repoHeadSha256: string; ownerPublicKey: Uint8Array }
export interface RepoWatermark { generation: bigint; sha256: string; keyringGeneration: bigint; keyringSha256: string }
export interface WatermarkPersistence { load(repoId: string): Promise<RepoWatermark | undefined>; save(repoId: string, value: RepoWatermark): Promise<void> }
export function repoHeadSigningBytes(head: Omit<RepoHead, 'signature'>): Uint8Array {
  return concatBytes([lpEncode('DSHEAD3'), lpEncode(head.repoId), u64be(head.generation), u64be(head.keyringGeneration), lpEncode(head.keyringSha256), lpEncode(head.prevSha256), lpEncode(head.payload)]);
}

/** The WebCrypto subset used for Ed25519 (structural, so neither DOM nor Node typings are needed). */
interface Ed25519Subtle {
  importKey(format: 'raw' | 'pkcs8', keyData: Uint8Array, algorithm: { name: 'Ed25519' }, extractable: false, keyUsages: Array<'sign' | 'verify'>): Promise<unknown>;
  sign(algorithm: { name: 'Ed25519' }, key: never, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: { name: 'Ed25519' }, key: never, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}
function subtle(): Ed25519Subtle {
  const found = (globalThis as unknown as { crypto?: { subtle?: Ed25519Subtle } }).crypto?.subtle;
  if (!found) throw new Error('WebCrypto is unavailable: repository-head signatures need crypto.subtle');
  return found;
}
/** RFC 8410 PKCS#8 wrapper of a raw Ed25519 seed; WebCrypto cannot import the seed directly. */
const ED25519_PKCS8_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
/** `ownerPrivateKey` is the raw 32-byte Ed25519 seed. */
export async function signRepoHead(head: Omit<RepoHead, 'signature'>, ownerPrivateKey: Uint8Array): Promise<RepoHead> {
  requireKey(ownerPrivateKey);
  const key = await subtle().importKey('pkcs8', concatBytes([ED25519_PKCS8_PREFIX, ownerPrivateKey]), { name: 'Ed25519' }, false, ['sign']);
  return { ...head, signature: new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key as never, repoHeadSigningBytes(head))) };
}
async function verifyRepoHeadSignature(head: RepoHead, ownerPublicKey: Uint8Array): Promise<boolean> {
  if (ownerPublicKey.length !== 32 || head.signature.length !== 64) return false;
  const key = await subtle().importKey('raw', ownerPublicKey, { name: 'Ed25519' }, false, ['verify']);
  return subtle().verify({ name: 'Ed25519' }, key as never, head.signature, repoHeadSigningBytes(head));
}
export function repoHeadSha256(head: RepoHead): string {
  return sha256Hex(concatBytes([repoHeadSigningBytes(head), lpEncode(head.signature)]));
}
/** Persist in the local watermark table; verification must precede all remote reads. */
export class RepoHeadWatermarkStore {
  private persistence: WatermarkPersistence;
  private anchor: PairingAnchor;
  private pendingAdvance: Promise<void> = Promise.resolve();
  constructor(persistence: WatermarkPersistence, anchor: PairingAnchor) {
    if (anchor.magic !== 'DSPAIR2') throw new Error('Out-of-band DSPAIR2 anchor required');
    this.persistence = persistence; this.anchor = anchor;
  }
  verifyAndAdvance(head: RepoHead): Promise<void> {
    const operation = this.pendingAdvance.then(() => this.verifyAndPersist(head));
    this.pendingAdvance = operation.then(() => undefined, (_error: unknown) => undefined);
    return operation;
  }
  private async verifyAndPersist(head: RepoHead): Promise<void> {
    if (head.repoId !== this.anchor.repoId || !await verifyRepoHeadSignature(head, this.anchor.ownerPublicKey)) throw new Error('Invalid owner signature or repository');
    const sha256 = repoHeadSha256(head);
    if (head.generation < this.anchor.repoHeadGen || (head.generation === this.anchor.repoHeadGen && sha256 !== this.anchor.repoHeadSha256)) throw new RemoteRollbackDetectedError('DSPAIR2 anchor mismatch');
    const previous = await this.persistence.load(head.repoId);
    if (previous) {
      if (head.generation < previous.generation || (head.generation === previous.generation && sha256 !== previous.sha256)) throw new RemoteRollbackDetectedError('Repository head rollback or fork');
      if (head.keyringGeneration < previous.keyringGeneration || (head.keyringGeneration === previous.keyringGeneration && head.keyringSha256 !== previous.keyringSha256)) throw new KeyringRollbackDetectedError('Keyring rollback or fork');
      if (head.generation === previous.generation + 1n && head.prevSha256 !== previous.sha256) throw new RemoteRollbackDetectedError('Broken head chain');
    }
    await this.persistence.save(head.repoId, { generation: head.generation, sha256, keyringGeneration: head.keyringGeneration, keyringSha256: head.keyringSha256 });
  }
  async verifyKeyring(repoId: string, generation: bigint, serialized: Uint8Array): Promise<void> {
    const expected = await this.persistence.load(repoId);
    if (!expected || repoId !== this.anchor.repoId || generation !== expected.keyringGeneration || sha256Hex(serialized) !== expected.keyringSha256) throw new KeyringRollbackDetectedError('Keyring differs from verified repo head');
  }
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean { return timingSafeEqual(a, b); }
