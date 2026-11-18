import type { FirstChunkPlan } from './api.ts';
import { BackupCryptoError, DSBK_V2_HEADER_LEN, DSBK_GCM_TAG_LEN, DSBK_V2_CHUNK_OFFSET, DSBK_MAX_PLAINTEXT_CHUNK, STREAM_PLAINTEXT_CHUNK, isEncryptedBackup } from './dsbk-stream.ts';

const U64_MAX = (1n << 64n) - 1n;

/** Rust `object_len: u64`：bigint 覆盖完整 u64；number 只接受安全整数（超过 2^53 已失真）。 */
export function objectLenU64(objectLen: number | bigint): bigint {
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
  const h = head;
  if (!isEncryptedBackup(h)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
  if (h[4] === 1) return { kind: 'LegacyV1WholeFile' };
  if (h[4] !== 2) throw new BackupCryptoError(`不支持的加密版本: ${h[4]}`);
  if (h.length < DSBK_V2_HEADER_LEN) throw new BackupCryptoError(`DSBK v2 头被截断：${h.length} 字节 < ${DSBK_V2_HEADER_LEN} 字节`);
  const chunk = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(DSBK_V2_CHUNK_OFFSET, true);
  if (chunk === 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK) throw new BackupCryptoError(`加密分块大小非法: ${chunk}`);
  const body = len - BigInt(DSBK_V2_HEADER_LEN);
  if (body < BigInt(DSBK_GCM_TAG_LEN)) throw new BackupCryptoError(`加密备份缺少数据块（对象总长 ${len} 字节，装不下 v2 头 + GCM tag）`);
  const cipherChunk = BigInt(chunk + DSBK_GCM_TAG_LEN);
  return { kind: 'StreamV2', prefixLen: DSBK_V2_HEADER_LEN + Number(body < cipherChunk ? body : cipherChunk) };
}
