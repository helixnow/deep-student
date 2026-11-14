/**
 * Rust `base64 0.22.1` STANDARD 解码（F4 共享原语，原位于 secrets/crypto-service.ts）。
 * 桌面入口：解码结果是 `Buffer`（同一块内存的视图）；可移植实现与 `Uint8Array` 结果见 `base64-core.ts`。
 */
import { decodeBase64Standard as decodeBase64Bytes, type Base64DecodeResult as Base64DecodeBytesResult } from './base64-core.ts';

export type Base64DecodeResult = Base64DecodeBytesResult<Buffer>;

/**
 * `base64 0.22.1` `general_purpose::STANDARD.decode` 的逐分支移植：
 * `RequireCanonical` 填充 + `decode_allow_trailing_bits = false`。
 * 错误文本保留 crate `DecodeError` 的 Display（见 `decode.rs:32-45`）。
 */
export function decodeBase64Standard(text: string): Base64DecodeResult {
  const decoded = decodeBase64Bytes(text);
  if (decoded.error !== undefined) return { error: decoded.error };
  const bytes = decoded.bytes;
  return { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}
