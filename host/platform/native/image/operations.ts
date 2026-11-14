import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../errors/api.ts';
import type { ImageEncodeOptions, ImageFilter, ImagePixelRect, RgbaImage } from './api.ts';
import { removeRun, runWasm } from '../wasm/loader.ts';

const f = Math.fround;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function check(input: RgbaImage): void {
  if (!Number.isSafeInteger(input.width) || input.width < 1
    || !Number.isSafeInteger(input.height) || input.height < 1
    || input.rgba.length !== input.width * input.height * 4) {
    throw new RangeError('Invalid RGBA image dimensions or buffer length');
  }
}

/** image 0.24.9 imageops/mod.rs::crop_dimms + SubImage::to_image, RGBA8 only. */
export function cropRgba(input: RgbaImage, bbox: ImagePixelRect): RgbaImage {
  check(input);
  for (const coordinate of [bbox.x, bbox.y, bbox.width, bbox.height]) {
    if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 0xffffffff) {
      throw new RangeError('crop coordinates and dimensions must be u32 integers');
    }
  }
  const x = Math.min(bbox.x, input.width), y = Math.min(bbox.y, input.height);
  const width = Math.min(bbox.width, input.width - x), height = Math.min(bbox.height, input.height - y);
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * input.width + x) * 4;
    rgba.set(input.rgba.subarray(start, start + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function sinc(value: number): number {
  if (value === 0) return 1;
  const a = f(value * f(Math.PI));
  return f(f(Math.sin(a)) / a);
}

/** image 0.24.9 sample.rs: clipped support, normalized AFTER clipping. */
function weights(source: number, target: number, output: number, filter: ImageFilter): { left: number; values: number[] } {
  const ratio = f(f(source) / f(target));
  const scale = Math.max(1, ratio);
  const support = f((filter === 'triangle' ? 1 : 3) * scale);
  const center = f(f(f(output) + 0.5) * ratio);
  const left = clamp(Math.floor(f(center - support)), 0, source - 1);
  const right = clamp(Math.ceil(f(center + support)), left + 1, source);
  const origin = f(center - 0.5);
  let sum = 0;
  const values: number[] = [];
  for (let i = left; i < right; i++) {
    const x = f(f(f(i) - origin) / scale);
    const weight = filter === 'triangle'
      ? (Math.abs(x) < 1 ? f(1 - Math.abs(x)) : 0)
      : (Math.abs(x) < 3 ? f(sinc(x) * sinc(f(x / 3))) : 0);
    values.push(weight);
    sum = f(sum + weight);
  }
  return { left, values: values.map(value => f(value / sum)) };
}

export function resizeRgba(input: RgbaImage, width: number, height: number, filter: ImageFilter): RgbaImage {
  check(input);
  if (!Number.isSafeInteger(width) || width < 0 || !Number.isSafeInteger(height) || height < 0) {
    throw new RangeError('Invalid resize dimensions');
  }
  if (input.width === width && input.height === height) return { width, height, rgba: input.rgba.slice() };
  const vertical = new Float32Array(input.width * height * 4);
  for (let y = 0; y < height; y++) {
    const { left, values } = weights(input.height, height, y, filter);
    for (let x = 0; x < input.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          sum = f(sum + f(input.rgba[((left + i) * input.width + x) * 4 + c]! * values[i]!));
        }
        vertical[(y * input.width + x) * 4 + c] = sum;
      }
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) {
    const { left, values } = weights(input.width, width, x, filter);
    for (let y = 0; y < height; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          sum = f(sum + f(vertical[(y * input.width + left + i) * 4 + c]! * values[i]!));
        }
        rgba[(y * width + x) * 4 + c] = Math.round(clamp(sum, 0, 255));
      }
    }
  }
  return { width, height, rgba };
}

export function resizeDimensions(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * `DynamicImage::ImageRgba8(..).write_to(.., ImageOutputFormat::Png | Jpeg(q))` in the F7 WASI engine:
 * the same image 0.24.9 PNG/JPEG encoders every Rust call site uses (D12). The crate's JPEG encoder
 * drops alpha via `to_rgb()` (no compositing) and clamps quality to 1..=100; failures carry the
 * crate's `ImageError` Display text.
 */
export async function encode(input: RgbaImage, options: ImageEncodeOptions): Promise<Uint8Array> {
  check(input);
  const run = await runWasm({
    engine: 'image', op: 'encode', input: '/out/input', output: '/out/output',
    width: input.width, height: input.height, color: 'rgba8', format: options.format,
    quality: clamp(Math.trunc(options.quality ?? 75), 1, 100),
  }, { files: { input: input.rgba } });
  try {
    const response = run.response as { ok?: boolean; error?: unknown };
    if (response.ok !== true) throw new Error(String(response.error));
    return new Uint8Array(await readFile(join(run.outputDir, 'output')));
  } finally {
    await removeRun(run);
  }
}

export async function encodeJpegWithinLimit(input: RgbaImage, maxBytes: number, qualities: readonly number[]): Promise<Uint8Array> {
  for (const quality of qualities) {
    const bytes = await encode(input, { format: 'jpeg', quality });
    if (bytes.length <= maxBytes) return bytes;
  }
  throw new Error(`压缩后仍超过 ${Math.floor(maxBytes / 1024)}KB 上限`);
}

export async function cropFigure(
  decode: (bytes: Uint8Array) => Promise<RgbaImage>, bytes: Uint8Array,
  bbox: readonly [number, number, number, number],
): Promise<Uint8Array> {
  let source: RgbaImage;
  try { source = await decode(bytes); }
  catch (error) { throw AppError.internal(`加载页面图片失败: ${error instanceof Error ? error.message : String(error)}`); }
  const [a, b, c, d] = bbox;
  // Rust f64::min/max ignore a lone NaN; saturating `as u32` maps NaN to zero.
  const min = (x: number, y: number): number => Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.min(x, y);
  const max = (x: number, y: number): number => Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.max(x, y);
  const u32 = (value: number): number => Number.isNaN(value) || value <= 0 ? 0 : Math.min(0xffffffff, Math.round(value));
  const x1 = clamp(min(a, c), 0, 1), y1 = clamp(min(b, d), 0, 1);
  const x2 = clamp(max(a, c), 0, 1), y2 = clamp(max(b, d), 0, 1);
  const x = Math.min(u32(x1 * source.width), Math.max(0, source.width - 1));
  const y = Math.min(u32(y1 * source.height), Math.max(0, source.height - 1));
  const width = Math.min(u32(max((x2 - x1) * source.width, 1)), source.width - x);
  const height = Math.min(u32(max((y2 - y1) * source.height, 1)), source.height - y);
  if (width === 0 || height === 0) throw AppError.validation('裁切区域无效：宽度或高度为 0');
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * source.width + x) * 4;
    rgba.set(source.rgba.subarray(start, start + width * 4), row * width * 4);
  }
  try { return await encode({ width, height, rgba }, { format: 'png' }); }
  catch (error) { throw AppError.internal(`编码裁切图片失败: ${error instanceof Error ? error.message : String(error)}`); }
}
