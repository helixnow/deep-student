import { toBase64 } from '../crypto/encoding.ts';
import { decodeBase64Standard } from '../util/portable.ts';
import { storageLog } from './logging.ts';

/** The subset of `nativeImage` required by the Rust image-quality policy. */
export interface ImageQualityCodec {
  dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  resizeAndEncodeJpeg(
    bytes: Uint8Array,
    options: { maxDimension: number; quality: number },
  ): Promise<Uint8Array>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `FileManager::adjust_image_quality_bytes` (file_manager.rs:74-167).
 *
 * All no-op/failure branches return the original bytes; only the resize/encode
 * step is delegated to the native codec. `resizeAndEncodeJpeg` receives
 * `{ maxDimension, quality }` exactly as the Rust policy resolves them.
 */
export async function adjustImageQualityBytes(
  imageData: Uint8Array,
  visionQuality: string,
  codec: ImageQualityCodec,
): Promise<Uint8Array> {
  if (visionQuality === 'high') return imageData;

  let size: { width: number; height: number };
  try {
    size = await codec.dimensions(imageData);
  } catch (error) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] 图片加载失败: ${errorText(error)}`);
    return imageData;
  }

  const megapixels = (size.width * size.height) / 1_000_000;
  let maxDimension: number;
  let quality: number;
  switch (visionQuality) {
    case 'low':
      maxDimension = 768;
      quality = 60;
      break;
    case 'medium':
      maxDimension = 1024;
      quality = 75;
      break;
    case 'auto':
      if (megapixels > 4.0) {
        maxDimension = 768;
        quality = 60;
      } else if (megapixels > 2.0) {
        maxDimension = 1024;
        quality = 75;
      } else {
        return imageData;
      }
      break;
    default:
      return imageData;
  }

  const needsResize = size.width > maxDimension || size.height > maxDimension;
  if (!needsResize && imageData.byteLength < 500_000) return imageData;

  try {
    return await codec.resizeAndEncodeJpeg(imageData, { maxDimension, quality });
  } catch (error) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] JPEG 编码失败: ${errorText(error)}`);
    return imageData;
  }
}

/** `FileManager::adjust_image_quality_base64` (file_manager.rs:56-69). */
export async function adjustImageQualityBase64(
  base64Data: string,
  visionQuality: string,
  codec: ImageQualityCodec,
): Promise<string> {
  if (visionQuality === 'high') return base64Data;
  const decoded = decodeBase64Standard(base64Data);
  if (decoded.error !== undefined) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] Base64 解码失败: ${decoded.error}`);
    return base64Data;
  }
  return toBase64(await adjustImageQualityBytes(decoded.bytes, visionQuality, codec));
}
