/**
 * `node:crypto` 在 Worker / 页面中的实现。
 *
 * 随机数与 UUID 取 `globalThis.crypto`（WebCrypto，需要安全上下文）；`createHash` / `createHmac` 必须同步，
 * WebCrypto 的 `subtle.digest` 是异步的，所以 sha256 / sha1 / md5 用纯 JS 实现（Host 用它们算 profile、权限的修订号）。
 * 其余算法（cipher、sign、密钥派生等）抛 `ERR_CRYPTO_UNSUPPORTED_ON_PLATFORM`：业务代码应走 `dstu.platform.crypto`。
 */
import { Buffer } from './buffer.ts';

type Input = string | ArrayBuffer | ArrayBufferView;
type Digest = (data: Uint8Array) => Uint8Array;

function unsupported(name: string): never {
  const error = new Error(`UNSUPPORTED_ON_PLATFORM: crypto.${name} is not available in the mobile Host; use the dstu.platform.crypto service`) as Error & { code: string };
  error.code = 'ERR_CRYPTO_UNSUPPORTED_ON_PLATFORM';
  throw error;
}

function webCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) unsupported('getRandomValues (WebCrypto needs a secure context)');
  return crypto;
}

function toBytes(data: Input, encoding?: string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, encoding);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Merkle–Damgård 填充：消息 + 0x80 + 0… + 64 位长度（大端或小端）。 */
function pad(data: Uint8Array, littleEndian: boolean): DataView {
  const length = (((data.length + 8) >>> 6) + 1) << 6;
  const out = new Uint8Array(length);
  out.set(data);
  out[data.length] = 0x80;
  const view = new DataView(out.buffer);
  const bits = data.length * 8;
  const high = Math.floor(bits / 2 ** 32);
  const low = bits >>> 0;
  if (littleEndian) {
    view.setUint32(length - 8, low, true);
    view.setUint32(length - 4, high, true);
  } else {
    view.setUint32(length - 8, high, false);
    view.setUint32(length - 4, low, false);
  }
  return view;
}

function words(state: readonly number[], littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(state.length * 4);
  const view = new DataView(out.buffer);
  state.forEach((word, i) => view.setUint32(i * 4, word >>> 0, littleEndian));
  return out;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const sha256: Digest = (data) => {
  const view = pad(data, false);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
  return words(h, false);
};

const sha1: Digest = (data) => {
  const view = pad(data, false);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
          : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
            : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0; h[4] = (h[4]! + e) | 0;
  }
  return words(h, false);
};

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

const md5: Digest = (data) => {
  const view = pad(data, true);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const m = new Uint32Array(16);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
    let [a, b, c, d] = h as [number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const round = i >>> 4;
      const [f, g] = round === 0 ? [(b & c) | (~b & d), i]
        : round === 1 ? [(d & b) | (~d & c), (5 * i + 1) % 16]
          : round === 2 ? [b ^ c ^ d, (3 * i + 5) % 16]
            : [c ^ (b | ~d), (7 * i) % 16];
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i]! + m[g]!) | 0, MD5_S[round * 4 + (i % 4)]!)) | 0;
      a = t;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
  }
  return words(h, true);
};

const DIGESTS: Record<string, { digest: Digest; blockSize: number }> = {
  sha256: { digest: sha256, blockSize: 64 },
  sha1: { digest: sha1, blockSize: 64 },
  md5: { digest: md5, blockSize: 64 },
};

function algorithm(name: string): { digest: Digest; blockSize: number } {
  const entry = DIGESTS[name.toLowerCase().replace('-', '')];
  if (!entry) unsupported(`createHash('${name}')`);
  return entry;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function output(bytes: Uint8Array, encoding?: string): Buffer | string {
  const buffer = Buffer.from(bytes);
  return encoding === undefined || encoding === 'buffer' ? buffer : buffer.toString(encoding);
}

/** 输入先收集，`digest()` 时一次计算（Host 的输入是 profile / 权限 JSON，体量小）。 */
export class Hash {
  #chunks: Uint8Array[] = [];
  #done = false;
  constructor(private readonly fn: Digest) {}

  update(data: Input, encoding?: string): this {
    if (this.#done) throw new Error('Digest already called');
    this.#chunks.push(toBytes(data, encoding).slice());
    return this;
  }

  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    if (this.#done) throw new Error('Digest already called');
    this.#done = true;
    return output(this.fn(concat(this.#chunks)), encoding);
  }

  copy(): Hash {
    const copy = new Hash(this.fn);
    for (const chunk of this.#chunks) copy.update(chunk);
    return copy;
  }
}

export class Hmac {
  #inner: Hash;
  #outerKey: Uint8Array;
  constructor(private readonly fn: Digest, blockSize: number, key: Input) {
    let bytes = toBytes(key);
    if (bytes.length > blockSize) bytes = fn(bytes);
    const padded = new Uint8Array(blockSize);
    padded.set(bytes);
    this.#outerKey = padded.map(byte => byte ^ 0x5c);
    this.#inner = new Hash(fn).update(padded.map(byte => byte ^ 0x36));
  }

  update(data: Input, encoding?: string): this {
    this.#inner.update(data, encoding);
    return this;
  }

  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    const inner = this.#inner.digest();
    return output(this.fn(concat([this.#outerKey, inner])), encoding);
  }
}

export function createHash(name: string): Hash {
  return new Hash(algorithm(name).digest);
}

export function createHmac(name: string, key: Input): Hmac {
  const { digest, blockSize } = algorithm(name);
  return new Hmac(digest, blockSize, key);
}

export function getHashes(): string[] {
  return Object.keys(DIGESTS);
}

export function randomBytes(size: number): Buffer;
export function randomBytes(size: number, callback: (error: Error | null, bytes: Buffer) => void): void;
export function randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void): Buffer | void {
  const out = Buffer.alloc(size);
  // getRandomValues 每次最多 65536 字节。
  for (let offset = 0; offset < size; offset += 65536) webCrypto().getRandomValues(out.subarray(offset, Math.min(size, offset + 65536)));
  if (!callback) return out;
  queueMicrotask(() => callback(null, out));
}

export function randomFillSync<T extends ArrayBufferView>(view: T): T {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let offset = 0; offset < bytes.length; offset += 65536) webCrypto().getRandomValues(bytes.subarray(offset, offset + 65536));
  return view;
}

export function randomInt(min: number, max?: number): number {
  const [low, high] = max === undefined ? [0, min] : [min, max];
  const range = high - low;
  if (!(range > 0) || range > 2 ** 32) throw new RangeError('randomInt range must be in (0, 2^32]');
  const limit = Math.floor(2 ** 32 / range) * range;
  const value = new Uint32Array(1);
  do webCrypto().getRandomValues(value); while (value[0]! >= limit);
  return low + (value[0]! % range);
}

export function randomUUID(): string {
  const crypto = webCrypto();
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) {
    const error = new RangeError('Input buffers must have the same byte length') as RangeError & { code: string };
    error.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
    throw error;
  }
  const x = toBytes(a);
  const y = toBytes(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const lazyWebCrypto = () => globalThis.crypto;
function webMember(target: object, key: PropertyKey): unknown {
  const value = Reflect.get(target, key, target);
  return typeof value === 'function' ? value.bind(target) : value;
}
export const webcrypto = new Proxy({} as Crypto, { get: (_target, key) => webMember(lazyWebCrypto() ?? {}, key) });
export const subtle = new Proxy({} as SubtleCrypto, { get: (_target, key) => webMember(lazyWebCrypto()?.subtle ?? {}, key) });
export const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => webCrypto().getRandomValues(array as never) as T;

export const createCipheriv = () => unsupported('createCipheriv');
export const createDecipheriv = () => unsupported('createDecipheriv');
export const createSign = () => unsupported('createSign');
export const createVerify = () => unsupported('createVerify');
export const pbkdf2 = () => unsupported('pbkdf2');
export const pbkdf2Sync = () => unsupported('pbkdf2Sync');
export const scrypt = () => unsupported('scrypt');
export const scryptSync = () => unsupported('scryptSync');
export const generateKeyPairSync = () => unsupported('generateKeyPairSync');
export const createPublicKey = () => unsupported('createPublicKey');
export const createPrivateKey = () => unsupported('createPrivateKey');

export default {
  createHash, createHmac, getHashes, randomBytes, randomFillSync, randomInt, randomUUID, timingSafeEqual,
  webcrypto, subtle, getRandomValues, createCipheriv, createDecipheriv, createSign, createVerify,
  pbkdf2, pbkdf2Sync, scrypt, scryptSync, generateKeyPairSync, createPublicKey, createPrivateKey,
};
