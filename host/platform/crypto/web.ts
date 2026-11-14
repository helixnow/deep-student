/**
 * `ctx.crypto` 的 Web 实现：移动端（Capacitor WebView / Web Worker）与任何具备 WebCrypto 的运行时。
 *
 * - 异步摘要、HMAC、AES-GCM、随机数只调用注入的 WebCrypto 对象（默认 `globalThis.crypto`）；
 * - WebCrypto 没有同步与增量摘要，`digestSync` / `sha256Sync` / `hmacSync` / `createHasher` 用 `sync.ts`（纯 JS 的 `@noble/hashes`）；
 * - 不得 import 任何 Node 模块，也不得使用 `Buffer` / `process`（`tests/portability.test.ts` 守护）。
 */
import {
  CryptoError,
  type AesGcmDecryptParams,
  type AesGcmEncryptParams,
  type BinaryInput,
  type CryptoService,
  type DigestAlgorithm,
  type Hasher,
} from './api.ts';
import {
  assertAesGcm,
  assertLength,
  assertRandomIntRange,
  fromBase64,
  fromHex,
  timingSafeEqual,
  toBase64,
  toBytes,
  toHex,
  utf8Decode,
  utf8Encode,
} from './encoding.ts';
import { assertDigestAlgorithm, createHasherSync, digestSync, hmacSync, sha256HexSync, sha256Sync } from './sync.ts';

/** 本实现用到的 WebCrypto 子集（结构类型，避免依赖 DOM lib 或 Node 的类型声明）。 */
export interface WebSubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: string } | { name: 'AES-GCM' },
    extractable: false,
    keyUsages: Array<'sign' | 'encrypt' | 'decrypt'>,
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: never, data: Uint8Array): Promise<ArrayBuffer>;
  encrypt(algorithm: AesGcmAlgorithm, key: never, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: AesGcmAlgorithm, key: never, data: Uint8Array): Promise<ArrayBuffer>;
}

interface AesGcmAlgorithm {
  name: 'AES-GCM';
  iv: Uint8Array;
  additionalData?: Uint8Array;
  tagLength: number;
}

export interface WebCryptoLike {
  readonly subtle: WebSubtleLike;
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID(): string;
}

export interface WebCryptoOptions {
  /** 默认 `globalThis.crypto`。 */
  readonly crypto?: WebCryptoLike;
}

/** WebCrypto `getRandomValues` 单次最多 65536 字节。 */
const RANDOM_CHUNK = 65_536;

const HMAC_BLOCK_BYTES: Record<DigestAlgorithm, number> = {
  'SHA-1': 64,
  'SHA-256': 64,
  'SHA-384': 128,
  'SHA-512': 128,
};

/**
 * 非安全上下文（局域网 http 调试页及其 Worker）只有 `getRandomValues`：缺的成员在创建时报出来，
 * 否则第一次摘要才抛 `Cannot read properties of undefined`。
 */
function requireWebCrypto(candidate: Partial<WebCryptoLike> | undefined): WebCryptoLike {
  const missing = [
    typeof candidate?.subtle?.digest !== 'function' ? 'crypto.subtle' : undefined,
    typeof candidate?.getRandomValues !== 'function' ? 'crypto.getRandomValues' : undefined,
    typeof candidate?.randomUUID !== 'function' ? 'crypto.randomUUID' : undefined,
  ].filter(name => name !== undefined);
  if (missing.length > 0) {
    throw new Error(`WebCrypto is unavailable (missing ${missing.join(', ')}): they only exist in a secure context (https://, capacitor:// or http://localhost)`);
  }
  return candidate as WebCryptoLike;
}

export function createWebCrypto(options: WebCryptoOptions = {}): CryptoService {
  const webCrypto = requireWebCrypto(options.crypto ?? (globalThis as unknown as { crypto?: WebCryptoLike }).crypto);
  const subtle = webCrypto.subtle;

  const digest = async (algorithm: DigestAlgorithm, data: BinaryInput): Promise<Uint8Array> => {
    assertDigestAlgorithm(algorithm);
    return new Uint8Array(await subtle.digest(algorithm, toBytes(data)));
  };

  const randomBytes = (length: number): Uint8Array => {
    assertLength(length, 'randomBytes length');
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += RANDOM_CHUNK) {
      webCrypto.getRandomValues(out.subarray(offset, Math.min(length, offset + RANDOM_CHUNK)));
    }
    return out;
  };

  const aesKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<unknown> =>
    subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [usage]);

  const service: CryptoService = {
    implementation: 'web',
    digest,
    sha256: (data) => digest('SHA-256', data),
    sha256Hex: async (data) => toHex(await digest('SHA-256', data)),
    sha1Hex: async (data) => toHex(await digest('SHA-1', data)),
    digestSync,
    sha256Sync,
    sha256HexSync,
    createHasher: createHasherSync,
    async hmac(algorithm, key, data) {
      assertDigestAlgorithm(algorithm);
      const raw = toBytes(key);
      // WebCrypto 拒绝零长度 HMAC 密钥；按 RFC 2104 空密钥补零到块长，与全零块密钥等价。
      const keyData = raw.length === 0 ? new Uint8Array(HMAC_BLOCK_BYTES[algorithm]) : raw;
      const handle = await subtle.importKey('raw', keyData, { name: 'HMAC', hash: algorithm }, false, ['sign']);
      return new Uint8Array(await subtle.sign('HMAC', handle as never, toBytes(data)));
    },
    hmacSync,
    randomBytes,
    randomUUID: () => webCrypto.randomUUID(),
    randomInt(min, max) {
      assertRandomIntRange(min, max);
      const range = max - min;
      // 48 位随机数上的拒绝采样：只接受 [0, limit)，limit 是 range 的整数倍。
      const limit = 2 ** 48 - (2 ** 48 % range);
      for (;;) {
        const bytes = randomBytes(6);
        let value = 0;
        for (const byte of bytes) value = value * 256 + byte;
        if (value < limit) return min + (value % range);
      }
    },
    async aesGcmEncrypt(params: AesGcmEncryptParams) {
      const tagLength = params.tagLength ?? 16;
      assertAesGcm(params.key, params.iv, tagLength);
      const key = await aesKey(params.key, 'encrypt');
      const algorithm: AesGcmAlgorithm = {
        name: 'AES-GCM',
        iv: params.iv,
        tagLength: tagLength * 8,
        ...(params.additionalData ? { additionalData: params.additionalData } : {}),
      };
      return new Uint8Array(await subtle.encrypt(algorithm, key as never, toBytes(params.plaintext)));
    },
    async aesGcmDecrypt(params: AesGcmDecryptParams) {
      const tagLength = params.tagLength ?? 16;
      assertAesGcm(params.key, params.iv, tagLength);
      if (params.ciphertext.length < tagLength) throw new CryptoError('DecryptFailed', 'ciphertext shorter than the authentication tag');
      const key = await aesKey(params.key, 'decrypt');
      const algorithm: AesGcmAlgorithm = {
        name: 'AES-GCM',
        iv: params.iv,
        tagLength: tagLength * 8,
        ...(params.additionalData ? { additionalData: params.additionalData } : {}),
      };
      try {
        return new Uint8Array(await subtle.decrypt(algorithm, key as never, params.ciphertext));
      } catch (error) {
        throw new CryptoError('DecryptFailed', `AES-GCM authentication failed: ${error instanceof Error ? error.name : String(error)}`);
      }
    },
    timingSafeEqual,
    toHex,
    fromHex,
    toBase64,
    fromBase64,
    utf8Encode,
    utf8Decode,
  };
  return service;
}
