/** LLMManager::detect_image_format_from_base64 / detect_image_format_from_bytes (mod.rs:5605–5644). */
import { decodeBase64Standard } from '../../../platform/util/portable.ts';

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function detectImageFormatFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 4) return 'jpeg';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && startsWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])) return 'webp';
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
  return 'jpeg';
}

/** Decodes `get(..100).unwrap_or(base64)`, not the entire image; any decode error means jpeg. */
export function detectImageFormatFromBase64(base64: string): string {
  const decoded = decodeBase64Standard(base64.length > 100 ? base64.slice(0, 100) : base64);
  return decoded.bytes === undefined ? 'jpeg' : detectImageFormatFromBytes(decoded.bytes);
}
