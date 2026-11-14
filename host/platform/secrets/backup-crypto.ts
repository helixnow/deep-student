/**
 * DSBK 备份加密容器（`dstu-security/src/crypto/backup_crypto.rs`）。
 *
 * - v1：`DSBK ‖ 0x01 ‖ m,t,p(u32 LE) ‖ salt16 ‖ nonce12 ‖ AES-256-GCM(全文) ‖ tag16`（头 45 字节）。
 * - v2：`DSBK ‖ 0x02 ‖ m,t,p ‖ salt16 ‖ nonce_prefix7 ‖ chunk(u32 LE)`（头 44 字节），之后每块
 *   `AES-256-GCM(key, prefix7 ‖ counter_be32 ‖ final_flag, chunk)`，明文块 1 MiB。
 * - 密钥 = Argon2id v0x13（m KiB, t, p, 32 字节），无 secret / AD。
 * - 路径式接口在本文件；Web Streams 版共用 `dsbk-stream.ts` 的可移植帧逻辑，这里只注入 Node 的 GCM。
 *
 * Argon2：factory 实例可消费正式 F7 NativeArgon2 服务（Electron 也可用）。未提供该依赖的
 * 既有调用保留 Node crypto.argon2（可用时）或 noble argon2idAsync 的路径；不会在 native 服务
 * 已选中但失败时静默降级。参数与 raw Argon2id v0x13/32 字节格式不变。
 */
import * as nodeCrypto from 'node:crypto';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { nowEpochNanos, toRfc3339SecsZ } from '../time/index.ts';
import { errnoCode, ioMessage } from '../paths/compat.ts';
import { renameWithRetry } from '../util/durable-fs.ts';
import type { BackupCrypto, BackupCryptoOptions, FileCipherSession, FirstChunkPlan, PasswordVerifier } from './api.ts';
import type { NativeArgon2 as NativeArgon2Service } from '../native/api.ts';
import {
  BackupCryptoError,
  decryptDsbkStream,
  DSBK_GCM_TAG_LEN,
  DSBK_MAX_PLAINTEXT_CHUNK,
  DSBK_V1_HEADER_LEN,
  DSBK_V2_CHUNK_OFFSET,
  DSBK_V2_HEADER_LEN,
  encryptDsbkStream,
  isEncryptedBackup,
  STREAM_PLAINTEXT_CHUNK,
  type DsbkKeyFor,
  type DsbkStreamDeps,
} from './dsbk-stream.ts';

export {
  BackupCryptoError, DSBK_GCM_TAG_LEN, DSBK_MAX_PLAINTEXT_CHUNK, DSBK_V1_HEADER_LEN, DSBK_V2_CHUNK_OFFSET,
  DSBK_V2_HEADER_LEN, isEncryptedBackup, STREAM_PLAINTEXT_CHUNK,
};
export const DSBK_MAGIC = Buffer.from('DSBK');
const V1 = 1;
const V2 = 2;
export const DEFAULT_M_COST = 65536;
export const DEFAULT_T_COST = 3;
export const DEFAULT_P_COST = 4;
export const KDF_MAX_M_COST_KIB = 1024 * 1024;
export const KDF_MAX_T_COST = 16;
export const KDF_MAX_P_COST = 8;
export const PASSWORD_VERIFIER_KDF_ARGON2ID = 'argon2id';
const MARKER_VERIFIER_DOMAIN = Buffer.from('deep-student.encryption-marker.verifier.v1');
const ENCRYPTED_ROOT_FINGERPRINT_DOMAIN = Buffer.from('deep-student.encrypted-root-memory.v1');

export const KDF_PARAMS_REJECTED_MESSAGE =
  '该云端数据携带的加密参数异常（数据可能已损坏、被外部工具改写，或由不兼容的版本写入），已在开始计算前停止，以避免应用长时间无响应。请检查该云端目录的内容后重试，或改用其他云端目录。';
export const KDF_NEW_PASSWORD_PARAMS_REJECTED_MESSAGE =
  '所选加密强度参数超出本设备可安全承受的内存范围，已停止本次加密。请使用默认加密参数（无需任何设置），或降低自定义参数后重试；已有的加密数据不受影响，仍可正常解密。';

/** 桌面端新写入面封顶 = 全局上限（移动端 256 MiB 不在本轮范围）。 */
export function kdfMaxMCostForNewPassword(): number {
  return KDF_MAX_M_COST_KIB;
}

function ensureWithinAppLimits(m: number, t: number, p: number): void {
  if (m > KDF_MAX_M_COST_KIB || t > KDF_MAX_T_COST || p > KDF_MAX_P_COST) throw new BackupCryptoError(KDF_PARAMS_REJECTED_MESSAGE);
}

function ensureAllowedForNewEncryption(m: number, t: number, p: number): void {
  ensureWithinAppLimits(m, t, p);
  if (m > kdfMaxMCostForNewPassword()) throw new BackupCryptoError(KDF_NEW_PASSWORD_PARAMS_REJECTED_MESSAGE);
}

type NativeArgon2 = (algorithm: 'argon2id', params: { message: Uint8Array; nonce: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number }, cb: (err: Error | null, key: Buffer) => void) => void;

function nativeArgon2(): NativeArgon2 | null {
  const fn = (nodeCrypto as unknown as { argon2?: NativeArgon2 }).argon2;
  if (typeof fn !== 'function') return null;
  try {
    (nodeCrypto as unknown as { argon2Sync: (a: string, p: object) => Buffer }).argon2Sync('argon2id', {
      message: Buffer.from('probe'),
      nonce: Buffer.alloc(8),
      parallelism: 1,
      tagLength: 4,
      memory: 8,
      passes: 1,
    });
    return fn;
  } catch {
    // 运行时（Electron/BoringSSL）不支持 Argon2：改用纯 JS 实现。
    return null;
  }
}
const native = nativeArgon2();

type KeyDeriver = (password: string, salt: Uint8Array, m: number, t: number, p: number) => Promise<Buffer>;

/** Existing standalone entry keeps its Node/noble backend semantics. */
export function deriveKey(password: string, salt: Uint8Array, m: number, t: number, p: number): Promise<Buffer> {
  return deriveKeyWithService(password, salt, m, t, p);
}

/** `derive_key`：应用级上限 → argon2 参数校验 → Argon2id，before any provider invocation. */
async function deriveKeyWithService(password: string, salt: Uint8Array, m: number, t: number, p: number,
  backend?: NativeArgon2Service): Promise<Buffer> {
  ensureWithinAppLimits(m, t, p);
  const paramError =
    m < 8 || m < p * 8 ? 'memory cost is too small' : t < 1 ? 'time cost is too small' : p < 1 ? 'not enough threads' : p > 0xffffff ? 'too many threads' : null;
  if (paramError !== null) throw new BackupCryptoError(`Argon2 参数无效: ${paramError}`);
  if (salt.length < 8) throw new BackupCryptoError('Argon2id 密钥派生失败: salt is too short');
  const pwd = Buffer.from(password, 'utf8');
  try {
    if (backend !== undefined) {
      const key = await backend.deriveKey(pwd, salt, m, t, p, 32);
      // Own the native allocation, not an extra untracked copy: existing F4
      // key/session wiping must also wipe the provider's returned key bytes.
      return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
    }
    if (native !== null) {
      return await new Promise<Buffer>((resolve, reject) =>
        native('argon2id', { message: pwd, nonce: salt, parallelism: p, tagLength: 32, memory: m, passes: t }, (err, key) => (err ? reject(err) : resolve(key))),
      );
    }
    return Buffer.from(await argon2idAsync(pwd, salt, { t, m, p, dkLen: 32, version: 0x13 }));
  } catch (error) {
    throw new BackupCryptoError(`Argon2id 密钥派生失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pwd.fill(0);
  }
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function gcmEncrypt(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

function gcmDecrypt(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Buffer | null {
  if (ct.length < 16) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    // 认证失败 = aes-gcm `aead::Error`，由调用方给出 Rust 文案。
    return null;
  }
}

/** `stream_chunk_nonce`：prefix7 ‖ counter_be32 ‖ final_flag。 */
export function streamChunkNonce(prefix: Uint8Array, counter: number, isFinal: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.set(prefix.subarray(0, 7), 0);
  n.writeUInt32BE(counter >>> 0, 7);
  n[11] = isFinal ? 1 : 0;
  return n;
}

/** `encrypt_backup_with_key`；`nonce` 只供测试向量注入。 */
export function encryptBackupWithKey(pt: Uint8Array, salt: Uint8Array, m: number, t: number, p: number, key: Uint8Array, nonce: Uint8Array = randomBytes(12)): Buffer {
  return Buffer.concat([DSBK_MAGIC, Buffer.from([V1]), u32le(m), u32le(t), u32le(p), salt, nonce, gcmEncrypt(key, nonce, pt)]);
}

type KeyFor = (salt: Buffer, m: number, t: number, p: number) => Promise<Buffer>;

/** One-shot decrypt owns these keys; a FileCipherSession instead retains its
 * own cached allocations until dispose. Never wipe the session cache here.
 */
async function usingDerivedKeys<T>(password: string, derive: KeyDeriver, run: (keyFor: KeyFor) => Promise<T>): Promise<T> {
  const keys: Buffer[] = [];
  try {
    return await run(async (salt, m, t, p) => {
      const key = await derive(password, salt, m, t, p);
      keys.push(key);
      return key;
    });
  } finally { for (const key of keys) key.fill(0); }
}

const streamDeps: DsbkStreamDeps = {
  aead: { seal: gcmEncrypt, open: gcmDecrypt },
  randomBytes: (length) => randomBytes(length),
  describeError: ioMessage,
};

const streamKeyFor = (keyFor: KeyFor): DsbkKeyFor => (salt, m, t, p) => keyFor(Buffer.from(salt), m, t, p);

/** std::io::Write::write_all: a successful write may still consume only a prefix. */
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) throw new Error('failed to write whole buffer');
    offset += bytesWritten;
  }
}

async function decryptBackupWithKeyProvider(data: Uint8Array, keyFor: KeyFor): Promise<Buffer> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < DSBK_V1_HEADER_LEN) throw new BackupCryptoError('加密备份数据太短');
  if (!buf.subarray(0, 4).equals(DSBK_MAGIC)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
  if (buf[4] !== V1) throw new BackupCryptoError(`不支持的加密版本: ${buf[4]}`);
  const m = buf.readUInt32LE(5);
  const t = buf.readUInt32LE(9);
  const p = buf.readUInt32LE(13);
  const salt = Buffer.from(buf.subarray(17, 33));
  const nonce = buf.subarray(33, 45);
  const key = await keyFor(salt, m, t, p);
  const pt = gcmDecrypt(key, nonce, buf.subarray(45));
  if (pt === null) throw new BackupCryptoError('备份解密失败（密码错误或数据损坏）: aead::Error');
  return pt;
}

/** 从文件句柄尽量读满 `size` 字节（短读 = EOF）。 */
async function fillChunk(fh: import('node:fs/promises').FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await fh.read(buf, filled, size - filled, null));
    } catch (error) {
      throw new BackupCryptoError(`读取数据失败: ${ioMessage(error)}`);
    }
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buf.subarray(0, filled);
}

async function encryptFileWithKey(input: string, output: string, salt: Uint8Array, m: number, t: number, p: number, key: Uint8Array): Promise<void> {
  const prefix = randomBytes(7);
  let inFh;
  try {
    inFh = await open(input, 'r');
  } catch (error) {
    throw new BackupCryptoError(`打开待加密文件失败: ${ioMessage(error)}`);
  }
  try {
    let outFh;
    try {
      outFh = await open(output, 'w');
    } catch (error) {
      throw new BackupCryptoError(`创建加密输出文件失败: ${ioMessage(error)}`);
    }
    try {
      const header = Buffer.concat([DSBK_MAGIC, Buffer.from([V2]), u32le(m), u32le(t), u32le(p), salt, prefix, u32le(STREAM_PLAINTEXT_CHUNK)]);
      try {
        await writeAll(outFh, header);
      } catch (error) {
        throw new BackupCryptoError(`写入加密头部失败: ${ioMessage(error)}`);
      }
      let counter = 0;
      let current = await fillChunk(inFh, STREAM_PLAINTEXT_CHUNK);
      for (;;) {
        const next = await fillChunk(inFh, STREAM_PLAINTEXT_CHUNK);
        const isFinal = next.length === 0;
        const ct = gcmEncrypt(key, streamChunkNonce(prefix, counter, isFinal), current);
        try {
          await writeAll(outFh, ct);
        } catch (error) {
          throw new BackupCryptoError(`写入密文失败: ${ioMessage(error)}`);
        }
        current.fill(0);
        if (isFinal) break;
        current = next;
        if (counter === 0xffffffff) throw new BackupCryptoError('分块计数溢出（文件过大）');
        counter++;
      }
    } finally {
      await outFh.close();
    }
  } finally {
    await inFh.close();
  }
}

async function decryptFileWithKeyProvider(input: string, output: string, keyFor: KeyFor): Promise<void> {
  let fh;
  try {
    fh = await open(input, 'r');
  } catch (error) {
    throw new BackupCryptoError(`打开加密文件失败: ${ioMessage(error)}`);
  }
  try {
    const head = await fillChunk(fh, 5);
    if (head.length < 5) throw new BackupCryptoError('读取加密头失败: failed to fill whole buffer');
    if (!head.subarray(0, 4).equals(DSBK_MAGIC)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
    const version = head[4]!;
    if (version === V1) {
      let data: Buffer;
      try {
        data = await readFile(input);
      } catch (error) {
        throw new BackupCryptoError(`读取加密备份失败: ${ioMessage(error)}`);
      }
      const pt = await decryptBackupWithKeyProvider(data, keyFor);
      try {
        await writeFile(output, pt);
      } catch (error) {
        throw new BackupCryptoError(`创建解密输出失败: ${ioMessage(error)}`);
      } finally {
        pt.fill(0);
      }
      return;
    }
    if (version !== V2) throw new BackupCryptoError(`不支持的加密版本: ${version}`);
    const readExact = async (n: number, what: string) => {
      const b = await fillChunk(fh, n);
      if (b.length < n) throw new BackupCryptoError(`${what}: failed to fill whole buffer`);
      return b;
    };
    const params = await readExact(12, '读取加密参数失败');
    const m = params.readUInt32LE(0);
    const t = params.readUInt32LE(4);
    const p = params.readUInt32LE(8);
    const salt = await readExact(16, '读取 salt 失败');
    const prefix = await readExact(7, '读取 nonce 前缀失败');
    const chunk = (await readExact(4, '读取分块大小失败')).readUInt32LE(0);
    if (chunk === 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK) throw new BackupCryptoError(`加密分块大小非法: ${chunk}`);
    const cipherChunk = chunk + 16;
    const key = await keyFor(salt, m, t, p);
    let out;
    try {
      out = await open(output, 'w');
    } catch (error) {
      throw new BackupCryptoError(`创建解密输出失败: ${ioMessage(error)}`);
    }
    try {
      let counter = 0;
      let current = await fillChunk(fh, cipherChunk);
      if (current.length === 0) throw new BackupCryptoError('加密备份缺少数据块');
      for (;;) {
        const next = await fillChunk(fh, cipherChunk);
        const isFinal = next.length === 0;
        const pt = gcmDecrypt(key, streamChunkNonce(prefix, counter, isFinal), current);
        if (pt === null) throw new BackupCryptoError('备份解密失败（密码错误或数据损坏）: aead::Error');
        try {
          await writeAll(out, pt);
        } catch (error) {
          throw new BackupCryptoError(`写入解密输出失败: ${ioMessage(error)}`);
        } finally {
          pt.fill(0);
        }
        if (isFinal) break;
        current = next;
        if (counter === 0xffffffff) throw new BackupCryptoError('分块计数溢出');
        counter++;
      }
    } finally {
      await out.close();
    }
  } finally {
    await fh.close();
  }
}

const U64_MAX = (1n << 64n) - 1n;

/** Rust `object_len: u64`：bigint 覆盖完整 u64；number 只接受安全整数（超过 2^53 已失真）。 */
function objectLenU64(objectLen: number | bigint): bigint {
  if (typeof objectLen === 'bigint') {
    if (objectLen < 0n || objectLen > U64_MAX) throw new RangeError(`object_len 超出 u64: ${objectLen}`);
    return objectLen;
  }
  if (!Number.isSafeInteger(objectLen) || objectLen < 0) throw new RangeError(`object_len 必须是非负安全整数，超过 2^53 请传 bigint: ${objectLen}`);
  return BigInt(objectLen);
}

/** 结果 ≤ v2 头 + 1 MiB + tag，可安全用作分配长度。 */
export function dsbkFirstChunkSpeculativePrefixLen(objectLen: number | bigint): number {
  const cap = BigInt(DSBK_V2_HEADER_LEN + STREAM_PLAINTEXT_CHUNK + DSBK_GCM_TAG_LEN);
  const len = objectLenU64(objectLen);
  return Number(len < cap ? len : cap);
}

/** `prefixLen` ≤ v2 头 + 64 MiB + tag，总是安全 number；剩余长度比较全程用 bigint。 */
export function planFirstChunkTrial(head: Uint8Array, objectLen: number | bigint): FirstChunkPlan {
  const len = objectLenU64(objectLen);
  if (head.length < 5) throw new BackupCryptoError('对象太短，读不到 DSBK 版本字节');
  const h = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (!h.subarray(0, 4).equals(DSBK_MAGIC)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
  if (h[4] === V1) return { kind: 'LegacyV1WholeFile' };
  if (h[4] !== V2) throw new BackupCryptoError(`不支持的加密版本: ${h[4]}`);
  if (h.length < DSBK_V2_HEADER_LEN) throw new BackupCryptoError(`DSBK v2 头被截断：${h.length} 字节 < ${DSBK_V2_HEADER_LEN} 字节`);
  const chunk = h.readUInt32LE(DSBK_V2_CHUNK_OFFSET);
  if (chunk === 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK) throw new BackupCryptoError(`加密分块大小非法: ${chunk}`);
  const body = len - BigInt(DSBK_V2_HEADER_LEN);
  if (body < BigInt(DSBK_GCM_TAG_LEN)) throw new BackupCryptoError(`加密备份缺少数据块（对象总长 ${len} 字节，装不下 v2 头 + GCM tag）`);
  const cipherChunk = BigInt(chunk + DSBK_GCM_TAG_LEN);
  return { kind: 'StreamV2', prefixLen: DSBK_V2_HEADER_LEN + Number(body < cipherChunk ? body : cipherChunk) };
}

export function trialDecryptFirstChunk(prefix: Uint8Array, objectLen: number | bigint, password: string): Promise<void> {
  return trialDecryptFirstChunkWithDeriver(prefix, objectLen, password, deriveKey);
}

async function trialDecryptFirstChunkWithDeriver(prefix: Uint8Array, objectLen: number | bigint, password: string,
  derive: KeyDeriver): Promise<void> {
  const len = objectLenU64(objectLen);
  const plan = planFirstChunkTrial(prefix, len);
  if (plan.kind !== 'StreamV2') throw new BackupCryptoError('DSBK v1 容器为整文件单块，无法首块试解，请走整文件解密路径');
  if (prefix.length < plan.prefixLen) throw new BackupCryptoError(`对象前缀不足以覆盖首个密文块：需要 ${plan.prefixLen} 字节，实得 ${prefix.length} 字节`);
  const b = Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const m = b.readUInt32LE(5);
  const t = b.readUInt32LE(9);
  const p = b.readUInt32LE(13);
  const salt = b.subarray(17, 33);
  const noncePrefix = b.subarray(33, 40);
  const cipherChunk = b.readUInt32LE(DSBK_V2_CHUNK_OFFSET) + DSBK_GCM_TAG_LEN;
  const isFinal = len - BigInt(DSBK_V2_HEADER_LEN) <= BigInt(cipherChunk);
  const key = await derive(password, salt, m, t, p);
  const pt = gcmDecrypt(key, streamChunkNonce(noncePrefix, 0, isFinal), b.subarray(DSBK_V2_HEADER_LEN, plan.prefixLen));
  key.fill(0);
  if (pt === null) throw new BackupCryptoError('备份解密失败（密码错误或数据损坏）: aead::Error');
  pt.fill(0);
}

class FileCipherSessionImpl implements FileCipherSession {
  private readonly derived = new Map<string, Buffer>();
  private disposed = false;
  private password: string;
  private readonly m: number;
  private readonly t: number;
  private readonly p: number;
  private readonly salt: Buffer;
  private readonly key: Buffer;
  private readonly derive: KeyDeriver;

  constructor(
    password: string,
    m: number,
    t: number,
    p: number,
    salt: Buffer,
    key: Buffer,
    derive: KeyDeriver,
  ) {
    this.password = password;
    this.m = m;
    this.t = t;
    this.p = p;
    this.salt = salt;
    this.key = key;
    this.derive = derive;
  }

  private keyFor: KeyFor = async (salt, m, t, p) => {
    if (this.disposed) throw new BackupCryptoError('加密会话已释放');
    if (salt.equals(this.salt) && m === this.m && t === this.t && p === this.p) return this.key;
    const id = `${salt.toString('hex')}:${m}:${t}:${p}`;
    const cached = this.derived.get(id);
    if (cached) return cached;
    const key = await this.derive(this.password, salt, m, t, p);
    this.derived.set(id, key);
    return key;
  };

  async encryptBytes(plaintext: Uint8Array): Promise<Uint8Array> {
    return encryptBackupWithKey(plaintext, this.salt, this.m, this.t, this.p, this.key);
  }
  decryptBytes(data: Uint8Array): Promise<Uint8Array> {
    return decryptBackupWithKeyProvider(data, this.keyFor);
  }
  encryptFile(input: string, output: string): Promise<void> {
    return encryptFileWithKey(input, output, this.salt, this.m, this.t, this.p, this.key);
  }
  decryptFile(input: string, output: string): Promise<void> {
    return decryptFileWithKeyProvider(input, output, this.keyFor);
  }
  encryptStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void> {
    return encryptDsbkStream(input, output, { salt: this.salt, m: this.m, t: this.t, p: this.p }, streamKeyFor(this.keyFor), streamDeps);
  }
  decryptStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void> {
    return decryptDsbkStream(input, output, streamKeyFor(this.keyFor), streamDeps);
  }
  dispose(): void {
    this.disposed = true;
    this.key.fill(0);
    for (const k of this.derived.values()) k.fill(0);
    this.derived.clear();
    this.password = '';
  }
}

async function verifierDigest(password: string, salt: Uint8Array, m: number, t: number, p: number, derive: KeyDeriver): Promise<Buffer> {
  const key = await derive(password, salt, m, t, p);
  try {
    return createHash('sha256').update(MARKER_VERIFIER_DOMAIN).update(key).digest();
  } finally {
    key.fill(0);
  }
}

/** `hex::decode` 的错误文案。 */
function hexDecode(s: string): Buffer | string {
  if (s.length % 2 !== 0) return 'Odd number of digits';
  const bad = /[^0-9a-fA-F]/.exec(s);
  if (bad) return `Invalid character '${bad[0]}' at position ${bad.index}`;
  return Buffer.from(s, 'hex');
}

/** 加密目录记忆文件（`EncryptedRootMemory`）。 */
export class EncryptedRootMemory {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static fingerprint(bindingHint: string): string {
    return createHash('sha256').update(ENCRYPTED_ROOT_FINGERPRINT_DOMAIN).update(bindingHint, 'utf8').digest('hex');
  }

  private async load(): Promise<{ version: number; roots: Record<string, string> } | null> {
    let data: Buffer;
    try {
      data = await readFile(this.path);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw new BackupCryptoError(`读取本机加密目录记忆失败: ${ioMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch (error) {
      throw new BackupCryptoError(`本机加密目录记忆内容无法解析: ${String(error)}`);
    }
    const o = parsed as { version?: unknown; roots?: unknown };
    if (typeof o !== 'object' || o === null || typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 0 || typeof o.roots !== 'object' || o.roots === null || Array.isArray(o.roots)) {
      throw new BackupCryptoError('本机加密目录记忆内容无法解析: invalid type');
    }
    for (const v of Object.values(o.roots as object)) if (typeof v !== 'string') throw new BackupCryptoError('本机加密目录记忆内容无法解析: invalid type');
    return { version: o.version, roots: o.roots as Record<string, string> };
  }

  async remember(fingerprint: string): Promise<void> {
    let file: { version: number; roots: Record<string, string> };
    try {
      file = (await this.load()) ?? { version: 1, roots: {} };
    } catch {
      // Rust `Ok(None) | Err(_) => 全新内容`：损坏的记忆文件被重建。
      file = { version: 1, roots: {} };
    }
    if (Object.hasOwn(file.roots, fingerprint)) return;
    file.roots[fingerprint] = toRfc3339SecsZ(nowEpochNanos());
    // BTreeMap 序列化 = 按键排序。
    const roots: Record<string, string> = {};
    for (const k of Object.keys(file.roots).sort()) roots[k] = file.roots[k]!;
    try {
      await mkdir(dirname(this.path), { recursive: true });
    } catch (error) {
      throw new BackupCryptoError(`创建本机加密目录记忆目录失败: ${ioMessage(error)}`);
    }
    const data = JSON.stringify({ version: file.version, roots }, null, 2);
    const tmp = this.path.replace(/(\.[^./\\]*)?$/, '.json.tmp');
    try {
      await writeFile(tmp, data);
    } catch (error) {
      throw new BackupCryptoError(`写入本机加密目录记忆失败: ${ioMessage(error)}`);
    }
    try {
      await renameWithRetry(tmp, this.path);
    } catch (error) {
      throw new BackupCryptoError(`保存本机加密目录记忆失败: ${ioMessage(error)}`);
    }
  }

  async wasEncrypted(fingerprint: string): Promise<boolean> {
    try {
      const file = await this.load();
      return file !== null && Object.hasOwn(file.roots, fingerprint);
    } catch {
      // fail-closed：无法读取/解析时按"曾加密"处理。
      return true;
    }
  }
}

export function createBackupCrypto(options: BackupCryptoOptions = {}): BackupCrypto {
  // Capture once per instance. No global mutable provider, no late backend switch.
  const backend = options.nativeArgon2;
  const derive: KeyDeriver = (password, salt, m, t, p) => deriveKeyWithService(password, salt, m, t, p, backend);
  return {
    async encryptBackup(plaintext, password) {
      const salt = randomBytes(16);
      const key = await derive(password, salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST);
      try {
        return encryptBackupWithKey(plaintext, salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST, key);
      } finally {
        key.fill(0);
      }
    },
    decryptBackup: (data, password) => usingDerivedKeys(password, derive, keyFor => decryptBackupWithKeyProvider(data, keyFor)),
    async encryptBackupFile(input, output, password) {
      const salt = randomBytes(16);
      const key = await derive(password, salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST);
      try {
        await encryptFileWithKey(input, output, salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST, key);
      } finally {
        key.fill(0);
      }
    },
    decryptBackupFile: (input, output, password) => usingDerivedKeys(password, derive, keyFor => decryptFileWithKeyProvider(input, output, keyFor)),
    encryptBackupStream: (input, output, password) => usingDerivedKeys(password, derive, keyFor => encryptDsbkStream(
      input, output, { salt: randomBytes(16), m: DEFAULT_M_COST, t: DEFAULT_T_COST, p: DEFAULT_P_COST }, streamKeyFor(keyFor), streamDeps)),
    decryptBackupStream: (input, output, password) => usingDerivedKeys(password, derive, keyFor => decryptDsbkStream(input, output, streamKeyFor(keyFor), streamDeps)),
    isEncryptedBackup,
    dsbkFirstChunkSpeculativePrefixLen,
    planFirstChunkTrial,
    trialDecryptFirstChunk: (prefix, length, password) => trialDecryptFirstChunkWithDeriver(prefix, length, password, derive),
    async createFileCipherSession(password, params) {
      if (password === '') throw new BackupCryptoError('加密密码不能为空');
      const m = params?.mCost ?? DEFAULT_M_COST;
      const t = params?.tCost ?? DEFAULT_T_COST;
      const p = params?.pCost ?? DEFAULT_P_COST;
      ensureAllowedForNewEncryption(m, t, p);
      const salt = randomBytes(16);
      return new FileCipherSessionImpl(password, m, t, p, salt, await derive(password, salt, m, t, p), derive);
    },
    async createPasswordVerifier(password) {
      ensureAllowedForNewEncryption(DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST);
      const salt = randomBytes(16);
      const digest = await verifierDigest(password, salt, DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST, derive);
      return { kdf: PASSWORD_VERIFIER_KDF_ARGON2ID, mCost: DEFAULT_M_COST, tCost: DEFAULT_T_COST, pCost: DEFAULT_P_COST, salt: salt.toString('hex'), digest: digest.toString('hex') };
    },
    async checkPasswordVerifier(password: string, verifier: PasswordVerifier) {
      if (verifier.kdf !== PASSWORD_VERIFIER_KDF_ARGON2ID) throw new BackupCryptoError(`未知的加密标记校验子 KDF: ${verifier.kdf}`);
      const salt = hexDecode(verifier.salt);
      if (typeof salt === 'string') throw new BackupCryptoError(`校验子 salt 无法解析: ${salt}`);
      const expected = hexDecode(verifier.digest);
      if (typeof expected === 'string') throw new BackupCryptoError(`校验子摘要无法解析: ${expected}`);
      if (expected.length !== 32) throw new BackupCryptoError(`校验子摘要长度非法: ${expected.length} 字节`);
      const actual = await verifierDigest(password, salt, verifier.mCost, verifier.tCost, verifier.pCost, derive);
      return timingSafeEqual(actual, expected);
    },
    encryptedRootMemory: (path) => new EncryptedRootMemory(path),
    encryptedRootFingerprint: (hint) => EncryptedRootMemory.fingerprint(hint),
  };
}
