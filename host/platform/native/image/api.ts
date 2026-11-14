/** Raw, unpremultiplied, 8-bit RGBA. No implicit orientation/colour conversion. */
export interface RgbaImage { width: number; height: number; rgba: Uint8Array }
/** Already-normalized u32 pixels, not x1/y1/x2/y2 or fractional coordinates. */
export interface ImagePixelRect { x: number; y: number; width: number; height: number }
export type ImageFilter = 'triangle' | 'lanczos3';
export interface ImageEncodeOptions { format: 'png' | 'jpeg'; quality?: number }
export class ImageOperationError extends Error {
  readonly stage: 'decode' | 'encode';
  constructor(stage: 'decode' | 'encode', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ImageOperationError';
    this.stage = stage;
  }
}
export interface NativeImage {
  dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  decodeRgba(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }>;
  /** image::imageops::crop_imm(...).to_image(): clips to bounds and preserves zero extents. */
  cropRgba(input: RgbaImage, bbox: ImagePixelRect): RgbaImage;
  /** imageops::resize on RgbaImage (exact dimensions, independent colour/alpha channels). */
  resizeRgba(input: RgbaImage, width: number, height: number, filter: ImageFilter): RgbaImage;
  /** DynamicImage::resize bounding-box dimensions, including enlargement. */
  resizeDimensions(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number };
  encode(input: RgbaImage, options: ImageEncodeOptions): Promise<Uint8Array>;
  /** vlm_grounding_service.rs normalized crop, PNG output. */
  cropFigure(bytes: Uint8Array, bbox: readonly [number, number, number, number]): Promise<Uint8Array>;
  /** Tries the supplied quality sequence in order; never returns oversized bytes. */
  encodeJpegWithinLimit(input: RgbaImage, maxBytes: number, qualities: readonly number[]): Promise<Uint8Array>;
  /** file_manager.rs two-step f64-truncate bounding box, then Triangle + JPEG. RGBA8 boundary. */
  resizeAndEncodeJpeg(bytes: Uint8Array, options: { maxDimension: number; quality: number }): Promise<Uint8Array>;
  /** exam_engine.rs bounding box/no-upscale branch; failures retain decode vs encode stage. */
  resizeTriangleJpeg(bytes: Uint8Array, maxWidth: number, maxHeight: number, quality: number): Promise<Uint8Array>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeImage: NativeImage }
}
