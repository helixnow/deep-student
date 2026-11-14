/**
 * F7 `nativeImage` 的正式能力接缝（`host/platform/native/image/api.ts`）。
 *
 * Rust qbank 的图片处理全部走 `image` crate：
 * - `docx_handout::prepare_png`：`image::load_from_memory` → 最长边 2000 的
 *   `DynamicImage::resize(..., FilterType::Triangle)` → PNG 编码；
 * - `qbank_crop_source_image`：`to_rgba8` → `imageops::crop_imm` 像素裁剪 →
 *   `PngEncoder`。
 *
 * 这些方法在 `ds-mig/F7-native` 分支的 `NativeImage` 中已发布，main 目前只
 * 提供 `dimensions`/`decodeRgba`。qbank 只依赖本文件的公开结构类型；业务层
 * 不再直接 import sharp，也不复制 F7 的 wasm/原生适配。
 */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface ImagePixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageFilter = 'triangle' | 'lanczos3';

export interface NativeImageOps {
  decodeRgba(bytes: Uint8Array): Promise<RgbaImage>;
  cropRgba(input: RgbaImage, bbox: ImagePixelRect): RgbaImage;
  resizeRgba(input: RgbaImage, width: number, height: number, filter: ImageFilter): RgbaImage;
  resizeDimensions(width: number, height: number, maxWidth: number, maxHeight: number):
    { width: number; height: number };
  encode(input: RgbaImage, options: { format: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array>;
}

export type PaperImageCodec = Pick<NativeImageOps,
  'decodeRgba' | 'resizeRgba' | 'resizeDimensions' | 'encode'>;
export type CropImageCodec = Pick<NativeImageOps, 'decodeRgba' | 'cropRgba' | 'encode'>;

interface ServiceContext {
  get(name: string): unknown;
}

function nativeImageOf(ctx: ServiceContext): Partial<NativeImageOps> | undefined {
  return ctx.get('nativeImage') as Partial<NativeImageOps> | undefined;
}

function hasMethods<T extends object>(value: Partial<T> | undefined,
  names: readonly (keyof T)[]): value is T {
  return value !== undefined && names.every(name => typeof value[name] === 'function');
}

/** DOCX 图片需要解码 + 三角形缩放 + PNG 编码；main 未合入 F7 时返回 null。 */
export function paperImageCodecOf(ctx: ServiceContext): PaperImageCodec | null {
  const image = nativeImageOf(ctx);
  return hasMethods<PaperImageCodec>(image,
    ['decodeRgba', 'resizeRgba', 'resizeDimensions', 'encode']) ? image : null;
}

/** 源图裁剪需要解码 + `cropRgba` + PNG 编码；main 未合入 F7 时返回 null。 */
export function cropImageCodecOf(ctx: ServiceContext): CropImageCodec | null {
  const image = nativeImageOf(ctx);
  return hasMethods<CropImageCodec>(image, ['decodeRgba', 'cropRgba', 'encode']) ? image : null;
}
