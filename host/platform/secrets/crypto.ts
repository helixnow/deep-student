/** Portable API-key encryption, using the desktop AES-256-GCM wire format. */
import { gcm } from '@noble/ciphers/aes';
import type { FilesService } from '../files/api.ts';
import type { CryptoService as Crypto } from '../crypto/api.ts';
import { fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from '../crypto/encoding.ts';
import { sha256Sync } from '../crypto/sync.ts';
import { posix } from '../util/path.ts';
import type { CryptoService, EncryptedData } from './api.ts';

/** Match desktop's serde-compatible object/sequence and optional u8 version check. */
export function parseEncryptedData(s: string): EncryptedData | null {
  let value: unknown;
  try {
    value = JSON.parse(s, (_k, v, ctx?: { source?: string }) => (typeof v === 'number' ? { __num: ctx?.source ?? String(v) } : v));
  } catch { return null; }
  const asU8 = (v: unknown): number | null | undefined => {
    if (v === null || v === undefined) return v as null | undefined;
    if (typeof v === 'object' && v !== null && '__num' in v) {
      const src = String((v as { __num: string }).__num);
      if (/^[0-9]+$/.test(src) && Number(src) <= 255) return Number(src);
    }
    return undefined;
  };
  if (Array.isArray(value)) {
    if (value.length < 2 || value.length > 3) return null;
    const [c, n, v] = value;
    if (typeof c !== 'string' || typeof n !== 'string') return null;
    if (value.length === 3) {
      const version = asU8(v);
      if (version === undefined && v !== null) return null;
      return { ciphertext: c, nonce: n, version: version ?? null };
    }
    return { ciphertext: c, nonce: n, version: null };
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.ciphertext !== 'string' || typeof o.nonce !== 'string') return null;
  let version: number | null = null;
  if ('version' in o && o.version !== null) {
    const v = asU8(o.version);
    if (v === undefined || v === null) return null;
    version = v;
  }
  return { ciphertext: o.ciphertext, nonce: o.nonce, version };
}

export function isEncryptedFormat(value: string): boolean {
  return parseEncryptedData(value) !== null;
}

export async function openMobileCrypto(files: FilesService, crypto: Crypto, dir: string, rotate = false): Promise<CryptoService> {
  const keyPath = posix.join(dir, '.master_key');
  let master: Uint8Array;
  if (!rotate && await files.exists(keyPath)) {
    master = fromBase64((await files.readText(keyPath)).trim());
    if (master.length !== 32) throw new Error('Invalid master key length: expected 32 bytes');
  } else {
    master = crypto.randomBytes(32);
    await files.mkdir(dir, { recursive: true });
    await files.writeAtomic(keyPath, toBase64(master));
  }
  const service: CryptoService = {
    keyPath,
    keyFingerprint: toHex(sha256Sync(master)).slice(0, 8),
    encryptApiKey(plaintext) {
      if (plaintext === '') return { ciphertext: '', nonce: '', version: 2 };
      const nonce = crypto.randomBytes(12);
      return { ciphertext: toBase64(gcm(master, nonce).encrypt(utf8Encode(plaintext))), nonce: toBase64(nonce), version: 2 };
    },
    decryptApiKey(data) {
      if (data.version !== 2) return utf8Decode(fromBase64(data.ciphertext), { fatal: true });
      if (data.ciphertext === '' && data.nonce === '') return '';
      const nonce = fromBase64(data.nonce);
      if (nonce.length !== 12) throw new Error('Invalid nonce length: expected 12 bytes');
      return utf8Decode(gcm(master, nonce).decrypt(fromBase64(data.ciphertext)), { fatal: true });
    },
    migratePlaintextKey: plaintext => JSON.stringify(service.encryptApiKey(plaintext)),
    verifyKeyIntegrity: () => service.decryptApiKey(service.encryptApiKey('integrity-check')) === 'integrity-check',
    rotateMasterKey: newDir => openMobileCrypto(files, crypto, newDir, true),
  };
  return service;
}
