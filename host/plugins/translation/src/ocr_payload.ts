/**
 * OCR 图片载荷解码（移植 `src/cmd/translation.rs:40–88`）。
 *
 * 只负责 payload → 字节 + 扩展名；OCR 推理链路由 L02 的模型运行时另接。
 */
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';

/** F4's base64 0.22 STANDARD decoder; awaiting re-export through its public API. */
export type StandardBase64Decoder = (text: string) =>
  { readonly bytes: Uint8Array; readonly error?: never } | { readonly bytes?: never; readonly error: string };

export const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

export function inferExtensionFromMime(mime: string): string | null {
  switch (rustTrim(mime).replace(/[A-Z]/g, value => value.toLowerCase())) {
    case 'image/png': return 'png';
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/bmp': return 'bmp';
    default: return null;
  }
}

export function inferExtensionFromBytes(bytes: Uint8Array): string | null {
  const startsWith = (signature: number[]): boolean =>
    signature.every((value, index) => bytes[index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'jpg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))) return 'gif';
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'webp';
  if (startsWith([0x42, 0x4d])) return 'bmp';
  return null;
}

/** `decode_base64_image_payload`。 */
export function decodeBase64ImagePayload(payload: string, decodeStandard: StandardBase64Decoder): { bytes: Uint8Array; extension: string } {
  const trimmed = rustTrim(payload);
  let declaredMime: string | null = null;
  let base64Data: string;
  if (trimmed.startsWith('data:')) {
    const comma = trimmed.indexOf(',');
    if (comma < 0) throw AppError.validation('Invalid data URL format');
    const header = trimmed.slice(0, comma);
    const mime = header.startsWith('data:') ? header.slice('data:'.length).split(';')[0] ?? '' : '';
    declaredMime = mime;
    base64Data = trimmed.slice(comma + 1);
  } else {
    base64Data = trimmed;
  }
  if (Math.trunc(utf8ByteLength(base64Data) / 4) * 3 > MAX_OCR_IMAGE_BYTES) {
    throw AppError.validation(`图片过大（上限 ${MAX_OCR_IMAGE_BYTES / 1024 / 1024}MB），请压缩后重试`);
  }
  const decoded = decodeStandard(base64Data);
  if (decoded.error !== undefined) throw AppError.validation(`Base64解码失败: ${decoded.error}`);
  const bytes = decoded.bytes;
  if (bytes.length > MAX_OCR_IMAGE_BYTES) {
    throw AppError.validation(`图片过大（上限 ${MAX_OCR_IMAGE_BYTES / 1024 / 1024}MB），请压缩后重试`);
  }
  const extension = inferExtensionFromBytes(bytes)
    ?? (declaredMime === null ? null : inferExtensionFromMime(declaredMime))
    ?? 'png';
  return { bytes, extension };
}
