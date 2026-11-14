/**
 * `ctx.crypto` 桌面实现（`node:crypto`）与 Cordis 插件。接口与语义见 ./api.ts 与 ../API.md「crypto」。
 * 输出与 `web.ts` 的 Web 实现逐字节一致；返回值统一转成普通 `Uint8Array`，不把 Buffer 泄漏给调用方。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomInt as nodeRandomInt,
  randomUUID as nodeRandomUUID,
  type CipherGCMTypes,
} from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import { CryptoError, type CryptoService, type DigestAlgorithm, type Hasher } from './api.ts';
import {
  assertAesGcm,
  assertLength,
  assertRandomIntRange,
  fromBase64,
  fromHex,
  plainBytes,
  timingSafeEqual,
  toBase64,
  toBytes,
  toHex,
  utf8Decode,
  utf8Encode,
} from './encoding.ts';

export type * from './api.ts';
export { CryptoError } from './api.ts';
export * from './encoding.ts';
export { createWebCrypto } from './web.ts';
export { createHasherSync, sha256HexSync, sha256Sync } from './sync.ts';
export type { WebCryptoLike, WebCryptoOptions, WebSubtleLike } from './web.ts';

const NODE_ALGORITHMS: Record<DigestAlgorithm, string> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

function nodeAlgorithm(algorithm: DigestAlgorithm): string {
  const name = NODE_ALGORITHMS[algorithm];
  if (name === undefined) throw new CryptoError('InvalidArgument', `unsupported digest algorithm ${String(algorithm)}`);
  return name;
}

function digestSync(algorithm: DigestAlgorithm, data: Uint8Array | string): Uint8Array {
  return plainBytes(createHash(nodeAlgorithm(algorithm)).update(toBytes(data)).digest());
}

function hmacSync(algorithm: DigestAlgorithm, key: Uint8Array | string, data: Uint8Array | string): Uint8Array {
  return plainBytes(createHmac(nodeAlgorithm(algorithm), toBytes(key)).update(toBytes(data)).digest());
}

function createNodeHasher(algorithm: DigestAlgorithm): Hasher {
  const state = createHash(nodeAlgorithm(algorithm));
  let finished = false;
  const ensureOpen = () => {
    if (finished) throw new CryptoError('HasherFinalized', 'hasher already finalized');
  };
  const hasher: Hasher = {
    update(data) {
      ensureOpen();
      state.update(toBytes(data));
      return hasher;
    },
    digest() {
      ensureOpen();
      finished = true;
      return plainBytes(state.digest());
    },
    digestHex() {
      return toHex(hasher.digest());
    },
  };
  return hasher;
}

function gcmCipher(keyLength: number): CipherGCMTypes {
  return `aes-${keyLength * 8}-gcm` as CipherGCMTypes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createNodeCrypto(): CryptoService {
  return {
    implementation: 'node',
    digest: async (algorithm, data) => digestSync(algorithm, data),
    sha256: async (data) => digestSync('SHA-256', data),
    sha256Hex: async (data) => toHex(digestSync('SHA-256', data)),
    sha1Hex: async (data) => toHex(digestSync('SHA-1', data)),
    digestSync,
    sha256Sync: (data) => digestSync('SHA-256', data),
    sha256HexSync: (data) => toHex(digestSync('SHA-256', data)),
    createHasher: createNodeHasher,
    hmac: async (algorithm, key, data) => hmacSync(algorithm, key, data),
    hmacSync,
    randomBytes(length) {
      assertLength(length, 'randomBytes length');
      return plainBytes(nodeRandomBytes(length));
    },
    randomUUID: () => nodeRandomUUID(),
    randomInt(min, max) {
      assertRandomIntRange(min, max);
      return nodeRandomInt(min, max);
    },
    async aesGcmEncrypt(params) {
      const tagLength = params.tagLength ?? 16;
      assertAesGcm(params.key, params.iv, tagLength);
      const cipher = createCipheriv(gcmCipher(params.key.length), params.key, params.iv, { authTagLength: tagLength });
      if (params.additionalData) cipher.setAAD(params.additionalData);
      return concat([cipher.update(toBytes(params.plaintext)), cipher.final(), cipher.getAuthTag()]);
    },
    async aesGcmDecrypt(params) {
      const tagLength = params.tagLength ?? 16;
      assertAesGcm(params.key, params.iv, tagLength);
      const sealed = params.ciphertext;
      if (sealed.length < tagLength) throw new CryptoError('DecryptFailed', 'ciphertext shorter than the authentication tag');
      try {
        const decipher = createDecipheriv(gcmCipher(params.key.length), params.key, params.iv, { authTagLength: tagLength });
        if (params.additionalData) decipher.setAAD(params.additionalData);
        decipher.setAuthTag(sealed.subarray(sealed.length - tagLength));
        return concat([decipher.update(sealed.subarray(0, sealed.length - tagLength)), decipher.final()]);
      } catch (error) {
        throw new CryptoError('DecryptFailed', `AES-GCM authentication failed: ${error instanceof Error ? error.message : String(error)}`);
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
}

/** Cordis 插件：`ctx.crypto`（桌面）。无依赖；移动端 profile 用 `mobile.ts` 的 Web 实现。 */
export default definePlugin({
  meta: { id: 'dstu.platform.crypto', lane: 'W14-portable', provides: ['crypto'], platforms: ['desktop'] },
  apply(ctx: Context) {
    ctx.reflect.provide('crypto', createNodeCrypto());
  },
});
