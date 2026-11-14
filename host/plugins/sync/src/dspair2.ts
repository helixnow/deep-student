import { gcm } from '@noble/ciphers/aes';
import { fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { sha256HexSync, sha256Sync } from '../../../platform/crypto/sync.ts';
import { concatBytes } from '../../../platform/util/bytes.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';

const PAIRING_AAD = utf8Encode('DSPAIR2');
function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
/** Unpadded base64url, canonical form only (what `createDSPAIR2Pairing` emits). */
function decodePacket(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error('Invalid pairing packet');
  const bytes = fromBase64(encoded, { alphabet: 'url' });
  if (toBase64(bytes, { alphabet: 'url' }) !== encoded) throw new Error('Invalid pairing packet');
  return bytes;
}

export interface RepoHeadAnchor {
  repoId: string; repoHeadGeneration: bigint; repoHeadSha256: string; ownerPubkeyHex: string;
}
export interface PairingPayload { repoHeadAnchor: RepoHeadAnchor; secrets: DbJson }
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const forbidden = /^(device[_-]?id|incarnation[_-]?id|host[_-]?identity.*|.*private[_-]?key.*)$/i;
function rejectIdentity(value: DbJson): void {
  if (Array.isArray(value)) for (const item of value) rejectIdentity(item);
  else if (isJsonObject(value)) for (const [key, item] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error(`Device identity must not be paired: ${key}`);
    rejectIdentity(item);
  }
}
function validatePayload(value: unknown): asserts value is PairingPayload {
  rejectIdentity(value as DbJson);
  const anchor = (value as PairingPayload)?.repoHeadAnchor;
  if (!anchor || typeof anchor.repoId !== 'string' || !anchor.repoId
    || !['bigint', 'number'].includes(typeof anchor.repoHeadGeneration)
    || BigInt(anchor.repoHeadGeneration) < 0n
    || !/^[a-f0-9]{64}$/i.test(anchor.repoHeadSha256) || !/^[a-f0-9]{64}$/i.test(anchor.ownerPubkeyHex)
    || !Object.hasOwn(value as object, 'secrets')) throw new Error('Invalid repository anchor');
}
function normalizeSecret(secret: string): string {
  if (/^DS2-(?:[A-Z2-7]{5}-){3}[A-Z2-7]{5}$/.test(secret)) return secret.replace(/-/g, '').slice(3);
  if (/^[a-f0-9]{32}$/.test(secret)) return secret;
  throw new Error('Invalid DSPAIR2 secret');
}
function pairingKey(secret: string): Uint8Array {
  return sha256Sync(`DSPAIR2\0${normalizeSecret(secret)}`);
}
export interface PairingOffer { protocol: 'DSPAIR2'; secret: string; expiresAt: number; packet: string }
export function createDSPAIR2Pairing(payload: PairingPayload, options: {
  mode?: 'qr' | 'short-code'; now?: number; ttlMs?: number;
} = {}): PairingOffer {
  validatePayload(payload);
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? 600_000);
  if (!Number.isSafeInteger(expiresAt) || (options.ttlMs ?? 600_000) <= 0) throw new Error('Invalid pairing TTL');
  // Twenty independent 5-bit symbols: exactly 100 bits, without modulo bias.
  const symbols = [...randomBytes(20)].map(byte => alphabet[byte & 31]).join('');
  const secret = options.mode === 'short-code' ? `DS2-${symbols.match(/.{5}/g)!.join('-')}` : toHex(randomBytes(16));
  const iv = randomBytes(12);
  const sealed = gcm(pairingKey(secret), iv, PAIRING_AAD)
    .encrypt(utf8Encode(stringifyJsonLossless({ expiresAt, payload: payload as unknown as DbJson })));
  // Wire layout is iv ‖ tag ‖ ciphertext; the cipher returns ciphertext ‖ tag.
  const packet = concatBytes([iv, sealed.subarray(sealed.length - 16), sealed.subarray(0, sealed.length - 16)]);
  return { protocol: 'DSPAIR2', secret, expiresAt, packet: `DSPAIR2.${toBase64(packet, { alphabet: 'url' })}` };
}
export function decodeDSPAIR2Pairing(packet: string, secret: string, now = Date.now()): PairingPayload {
  if (!packet.startsWith('DSPAIR2.')) throw new Error('Invalid pairing protocol');
  const bytes = decodePacket(packet.slice(8));
  if (bytes.length < 29) throw new Error('Invalid pairing packet');
  const plain = gcm(pairingKey(secret), bytes.subarray(0, 12), PAIRING_AAD)
    .decrypt(concatBytes([bytes.subarray(28), bytes.subarray(12, 28)]));
  const decoded = parseJsonLossless(utf8Decode(plain));
  if (!isJsonObject(decoded) || typeof decoded.expiresAt !== 'number' || now >= decoded.expiresAt) throw new Error('Pairing expired');
  validatePayload(decoded.payload);
  const payload = decoded.payload;
  payload.repoHeadAnchor.repoHeadGeneration = BigInt(payload.repoHeadAnchor.repoHeadGeneration);
  return payload;
}
/** Receiver owns this in-memory session and consumes the offer once, only after authentication. */
export function createDSPAIR2Receiver() {
  const consumed = new Set<string>();
  return { consume(packet: string, secret: string, now = Date.now()): PairingPayload {
    const payload = decodeDSPAIR2Pairing(packet, secret, now);
    const digest = sha256HexSync(decodePacket(packet.slice(8)));
    if (consumed.has(digest)) throw new Error('Pairing already consumed');
    consumed.add(digest);
    return payload;
  } };
}

export interface ConfirmedRemoteWriteEnvelope {
  opId: string; remoteMaterializedSeq: bigint; payload: DbJson;
}
/** Return only acknowledged writes not already piggybacked; retain opId for idempotent SQLite replay. */
export function verifyCausalTakeover(localAppliedSeq: bigint, confirmedRemoteWriteEnvelopes: readonly ConfirmedRemoteWriteEnvelope[]): ConfirmedRemoteWriteEnvelope[] {
  const pending = new Map<string, ConfirmedRemoteWriteEnvelope>();
  for (const envelope of confirmedRemoteWriteEnvelopes) if (envelope.remoteMaterializedSeq > localAppliedSeq) {
    pending.set(envelope.opId, envelope);
  }
  return [...pending.values()].sort((a, b) => a.remoteMaterializedSeq < b.remoteMaterializedSeq ? -1 : a.remoteMaterializedSeq > b.remoteMaterializedSeq ? 1 : 0);
}
export type PreMountDrainState = 'LocalFirstMode' | 'DrainingMetadata' | 'ActiveRemoteMode' | 'LocalTakeover';
export interface MaterializedAck { writerKey: string; latestSeq: bigint }
export interface PreMountDrainTransport {
  drainMetadata(signal: AbortSignal): Promise<MaterializedAck | { busy: true }>;
  streamAttachments(signal: AbortSignal): Promise<void>;
  onBackgroundError?(error: unknown): void;
}
export class PreMountDrainController {
  readonly timeoutMs = 1500;
  state: PreMountDrainState = 'LocalFirstMode';
  ack: MaterializedAck | undefined;
  private abort: AbortController | undefined;
  private transport: PreMountDrainTransport;
  private confirmed: ConfirmedRemoteWriteEnvelope[] = [];
  constructor(transport: PreMountDrainTransport) { this.transport = transport; }
  cancel(): void { this.abort?.abort(); this.state = 'LocalFirstMode'; }
  async start(): Promise<PreMountDrainState> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    this.ack = undefined;
    this.state = 'DrainingMetadata';
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('Drain cancelled')), { once: true });
      });
      const result = await Promise.race([this.transport.drainMetadata(abort.signal), cancelled]);
      if (this.abort !== abort) return this.state;
      if ('busy' in result || abort.signal.aborted) {
        abort.abort(); this.state = 'LocalFirstMode';
      } else {
        this.ack = result;
        this.state = 'ActiveRemoteMode';
        // Deliberately never await attachment packs at the mount barrier.
        void Promise.resolve().then(() => this.transport.streamAttachments(abort.signal))
          .catch(error => this.transport.onBackgroundError?.(error));
      }
    } catch (error) {
      if (this.abort === abort) { abort.abort(); this.state = 'LocalFirstMode'; }
    } finally { clearTimeout(timer); }
    return this.state;
  }
  confirmWrite(envelope: ConfirmedRemoteWriteEnvelope): void { this.confirmed.push(envelope); }
  async takeover(localAppliedSeq: bigint, replay: (envelope: ConfirmedRemoteWriteEnvelope) => void | Promise<void>): Promise<void> {
    this.abort?.abort();
    this.state = 'LocalTakeover';
    for (const envelope of verifyCausalTakeover(localAppliedSeq, this.confirmed)) await replay(envelope);
    this.confirmed = [];
    this.state = 'LocalFirstMode';
  }
}
