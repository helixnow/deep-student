/**
 * `image = 0.24` decoder for the `nativeImage` host service.
 *
 * Rust call sites use `image::load_from_memory(bytes)` and then
 * `DynamicImage::dimensions()` / `to_rgba8()`.  `sharp` is not equivalent:
 * libvips rejects BMP/TGA/ICO/PNM inputs that the Rust build accepts, so the
 * adapter runs the same crate compiled for wasm32-wasip1 (see `wasm/`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeImage } from './api.ts';
import { ImageOperationError } from './api.ts';
import { removeRun, runWasm } from '../wasm/loader.ts';
import { cropFigure, cropRgba, encode, encodeJpegWithinLimit, resizeDimensions, resizeRgba } from './operations.ts';

interface ImageResponse {
  ok?: boolean;
  error?: string;
  width?: number;
  height?: number;
  length?: number;
}

async function invoke(op: string, bytes: Uint8Array, output?: string): Promise<ImageResponse> {
  const run = await runWasm(
    { engine: 'image', op, input: '/out/input', ...(output === undefined ? {} : { output }) },
    { files: { input: bytes } },
  );
  try {
    const response = run.response as ImageResponse;
    if (response.ok !== true) {
      // `image::ImageError` Display text, same as the Rust `map_err` sites.
      throw new Error(response.error ?? 'image decode failed');
    }
    return response;
  } finally {
    await removeRun(run);
  }
}

function size(response: ImageResponse): { width: number; height: number } {
  if (!Number.isSafeInteger(response.width) || !Number.isSafeInteger(response.height)) {
    throw new Error('image engine returned invalid dimensions');
  }
  return { width: response.width!, height: response.height! };
}

export const image: NativeImage = {
  cropRgba, resizeRgba, resizeDimensions, encode, encodeJpegWithinLimit,
  cropFigure: (bytes, bbox) => cropFigure(image.decodeRgba, bytes, bbox),
  async resizeAndEncodeJpeg(bytes, options) {
    let decoded = await image.decodeRgba(bytes);
    if (Math.max(decoded.width, decoded.height) > options.maxDimension) {
      const scale = options.maxDimension / Math.max(decoded.width, decoded.height);
      const bounds = resizeDimensions(decoded.width, decoded.height,
        Math.trunc(decoded.width * scale), Math.trunc(decoded.height * scale));
      decoded = resizeRgba(decoded, bounds.width, bounds.height, 'triangle');
    }
    return encode(decoded, { format: 'jpeg', quality: options.quality });
  },
  async resizeTriangleJpeg(bytes, maxWidth, maxHeight, quality) {
    let decoded;
    try { decoded = await image.decodeRgba(bytes); }
    catch (error) { throw new ImageOperationError('decode', error); }
    if (decoded.width > maxWidth || decoded.height > maxHeight) {
      const size = resizeDimensions(decoded.width, decoded.height, maxWidth, maxHeight);
      decoded = resizeRgba(decoded, size.width, size.height, 'triangle');
    }
    try { return await encode(decoded, { format: 'jpeg', quality }); }
    catch (error) { throw new ImageOperationError('encode', error); }
  },
  async dimensions(bytes) {
    return size(await invoke('dimensions', bytes));
  },
  async decodeRgba(bytes) {
    const run = await runWasm(
      { engine: 'image', op: 'decode_rgba', input: '/out/input', output: '/out/rgba.bin' },
      { files: { input: bytes } },
    );
    try {
      const response = run.response as ImageResponse;
      if (response.ok !== true) throw new Error(response.error ?? 'image decode failed');
      const { width, height } = size(response);
      const rgba = await readFile(join(run.outputDir, 'rgba.bin'));
      if (rgba.length !== response.length || rgba.length !== width * height * 4) {
        throw new Error('image engine returned a truncated RGBA buffer');
      }
      return { width, height, rgba: new Uint8Array(rgba) };
    } finally {
      await removeRun(run);
    }
  },
};
