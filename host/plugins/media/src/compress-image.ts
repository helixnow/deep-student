/**
 * `dstu-media/src/cmd/media.rs::compress_image_blocking`: long-edge Triangle
 * resize (no enlargement) and JPEG re-encode. Pixel work runs in F7
 * `nativeImage`; this module keeps the Rust branch order and error strings.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from '../../../platform/util/path.ts';
import type { NativeImage, RgbaImage } from '../../../platform/native/image/api.ts';
import type { CompressImageResult } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { decodeBase64Standard } from './base64.ts';

const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_QUALITY = 80;

export interface CompressImageArgs {
  sourcePath?: string | null;
  bytesBase64?: string | null;
  maxEdge?: number | null;
  quality?: number | null;
  outputMode?: string | null;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Errors are plain strings, as the Rust command returns `Result<_, String>`. */
export class CompressImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressImageError';
  }
}

type CompressImageService = Pick<NativeImage, 'decodeRgba' | 'resizeDimensions' | 'resizeRgba' | 'encode'>;

/** `nativeImage` is resolved after the source checks, so argument errors come first as in Rust. */
export async function compressImage(
  nativeImage: () => CompressImageService,
  args: CompressImageArgs,
): Promise<CompressImageResult> {
  const sourcePath = args.sourcePath ?? null;
  const bytesBase64 = args.bytesBase64 ?? null;
  // 1. 取源 bytes（同时提供时优先 sourcePath）
  let sourceBytes: Uint8Array;
  if (sourcePath !== null) {
    try { sourceBytes = await readFile(sourcePath); }
    catch (error) { throw new CompressImageError(`读取源图片失败 (${sourcePath}): ${text(error)}`); }
  } else if (bytesBase64 !== null) {
    try { sourceBytes = decodeBase64Standard(bytesBase64); }
    catch (error) { throw new CompressImageError(`base64 解码失败: ${text(error)}`); }
  } else {
    throw new CompressImageError('必须提供 sourcePath 或 bytesBase64 之一');
  }
  const originalSize = sourceBytes.length;
  const image = nativeImage();

  // 2. 解码
  let decoded: RgbaImage;
  try { decoded = await image.decodeRgba(sourceBytes); }
  catch (error) { throw new CompressImageError(`图片解码失败: ${text(error)}`); }
  const originalWidth = decoded.width;
  const originalHeight = decoded.height;

  // 3. 长边缩放（不放大），(max_edge, max_edge) 为包围盒
  const maxEdge = Math.max(args.maxEdge ?? DEFAULT_MAX_EDGE, 1);
  let output = decoded;
  if (Math.max(originalWidth, originalHeight) > maxEdge) {
    const size = image.resizeDimensions(originalWidth, originalHeight, maxEdge, maxEdge);
    output = image.resizeRgba(decoded, size.width, size.height, 'triangle');
  }

  // 4. JPEG 重编码（to_rgb8：丢弃 alpha，不合成）
  const quality = Math.min(Math.max(args.quality ?? DEFAULT_QUALITY, 10), 95);
  let encoded: Uint8Array;
  try { encoded = await image.encode(output, { format: 'jpeg', quality }); }
  catch (error) { throw new CompressImageError(`JPEG 编码失败: ${text(error)}`); }

  const common = {
    width: output.width,
    height: output.height,
    originalWidth,
    originalHeight,
    originalSize,
    compressedSize: encoded.length,
    format: 'jpeg',
  };
  // 5. 按输出模式返回
  if (args.outputMode === 'file') {
    const filePath = join(tmpdir(), `dstu_compressed_${globalThis.crypto.randomUUID().replaceAll('-', '')}.jpg`);
    try { await writeFile(filePath, encoded); }
    catch (error) { throw new CompressImageError(`写入临时文件失败: ${text(error)}`); }
    return { bytesBase64: null, filePath, ...common };
  }
  return { bytesBase64: Buffer.from(encoded).toString('base64'), filePath: null, ...common };
}
