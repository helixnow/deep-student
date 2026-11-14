/**
 * 同步与增量摘要的纯函数（`@noble/hashes`，纯 JS，不依赖 Node 或 WebCrypto），给拿不到 `ctx` 的插件
 * helper 直接 import，替换 `createHash('sha256').update(x).digest('hex')`。`ctx.crypto` 的 Web 实现的
 * `digestSync` / `hmacSync` / `createHasher` 也是这里的同一份代码。输出与 `node:crypto` 逐字节一致
 * （`tests/sync.test.ts`）。
 *
 * 性能边界（Apple Silicon、Node 26、机器有负载时实测 SHA-256）：纯 JS 约 100–190 MB/s，`node:crypto`
 * （OpenSSL）约 2–2.8 GB/s，1 KB 以上慢 7–20 倍；同步执行期间所在线程（Host Worker）完全阻塞：
 *   64 B ≈ 1 µs，1 KB ≈ 8 µs，64 KB ≈ 0.5 ms，1 MB ≈ 5 ms，16 MB ≈ 90 ms，64 MB ≈ 0.6 s。
 * 规则：单次输入 ≤ 64 KB（参数、清单、配置指纹）用这里；更大的、或大小由用户数据决定的（文件、附件、
 * PDF、上传）用异步 `ctx.crypto.sha256`（桌面 OpenSSL、移动端原生 WebCrypto），流式数据用
 * `ctx.crypto.createHasher`。
 */
import { hmac as nobleHmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { CryptoError, type BinaryInput, type DigestAlgorithm, type Hasher } from './api.ts';
import { toBytes, toHex } from './encoding.ts';

type NobleHash = typeof sha256;

const NOBLE: Record<DigestAlgorithm, NobleHash> = {
  'SHA-1': sha1,
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512,
};

function nobleOf(algorithm: DigestAlgorithm): NobleHash {
  const hash = NOBLE[algorithm];
  if (hash === undefined) throw new CryptoError('InvalidArgument', `unsupported digest algorithm ${String(algorithm)}`);
  return hash;
}

/** 校验算法名（不支持时抛 `CryptoError('InvalidArgument')`），供异步路径在调用 WebCrypto 前复用。 */
export function assertDigestAlgorithm(algorithm: DigestAlgorithm): void {
  nobleOf(algorithm);
}

export function digestSync(algorithm: DigestAlgorithm, data: BinaryInput): Uint8Array {
  return nobleOf(algorithm)(toBytes(data));
}

/** 字符串按 UTF-8 编码。 */
export function sha256Sync(data: BinaryInput): Uint8Array {
  return sha256(toBytes(data));
}

/** 小写 hex，等价于 `createHash('sha256').update(data).digest('hex')`。 */
export function sha256HexSync(data: BinaryInput): string {
  return toHex(sha256(toBytes(data)));
}

export function hmacSync(algorithm: DigestAlgorithm, key: BinaryInput, data: BinaryInput): Uint8Array {
  return nobleHmac(nobleOf(algorithm), toBytes(key), toBytes(data));
}

/** 增量摘要，等价于 `createHash(alg).update(a).update(b).digest()`。 */
export function createHasherSync(algorithm: DigestAlgorithm): Hasher {
  const state = nobleOf(algorithm).create();
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
      return state.digest();
    },
    digestHex() {
      return toHex(hasher.digest());
    },
  };
  return hasher;
}
