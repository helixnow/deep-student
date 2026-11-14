import { nativeImage, type NativeImage } from 'electron';
import UPNG from 'upng-js';
import { PNG } from 'pngjs';
import { raw, reqInteger } from './args.ts';
import { ShellCommandError } from './errors.ts';
import type { BuiltinPlugin, CommandContext, Resource } from './runtime.ts';

/** Tauri Image stores straight RGBA, not Chromium's premultiplied native bitmap. */
export class ImageResource implements Resource {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(rgba: Uint8Array, width: number, height: number) { this.rgba = rgba; this.width = width; this.height = height; }
  close(): void { /* Image bytes are owned by the resource and reclaimed by GC. */ }
  /** Lossless RGBA8 PNG of the straight pixels (upng-js 2.1.0 `encode` truncates IEND for tiny palette images). */
  png(): Buffer {
    if (this.rgba.length !== this.width * this.height * 4) throw new ShellCommandError('The number of RGBA bytes is not divisible by 4 or does not match the image dimensions');
    const png = new PNG({ width: this.width, height: this.height, colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
    png.data = Buffer.from(this.rgba);
    return PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  }
  native(): NativeImage {
    return nativeImage.createFromBuffer(this.png());
  }
  static fromPng(png: Uint8Array): ImageResource {
    const decoded = UPNG.decode(Uint8Array.from(png).buffer);
    return new ImageResource(new Uint8Array(UPNG.toRGBA8(decoded)[0]!), decoded.width, decoded.height);
  }
}
const isImage = (resource: Resource): resource is ImageResource => resource instanceof ImageResource;
const isByte = (item: unknown): boolean => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 255;

/**
 * Tauri `JsImage`。本构建的 tauri 没开 `image-ico` / `image-png`（src-tauri/Cargo.toml），文件路径与编码字节一律拒绝，
 * 不读文件也不解码（tauri-2.11.5 `image/mod.rs:213-227`）。
 */
export function resolveImage(value: unknown, ctx: CommandContext): ImageResource {
  if (typeof value === 'number') return ctx.runtime.getResource(ctx.webviewLabel, value, isImage);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'rgba' in value) {
    const img = value as { rgba: number[]; width: number; height: number };
    return new ImageResource(Uint8Array.from(img.rgba), img.width, img.height);
  }
  if (typeof value === 'string') throw new ShellCommandError('expected RGBA image data, found a file path');
  if (Array.isArray(value) && value.every(isByte)) throw new ShellCommandError('expected RGBA image data, found raw bytes');
  throw new ShellCommandError('data did not match any variant of untagged enum JsImage');
}

/** 同一原因，这两条命令在 Tauri 里不带参数、恒报错（tauri-2.11.5 `image/plugin.rs:34-36,52-55`）。 */
const decodingUnsupported = (command: 'from_bytes' | 'from_path') => (): never => {
  throw new ShellCommandError(`${command} is only supported if the \`image-ico\` or \`image-png\` Cargo features are enabled`);
};

export function imagePlugin(): BuiltinPlugin {
  const get = (rid: number, ctx: CommandContext) => ctx.runtime.getResource(ctx.webviewLabel, rid, isImage);
  return {
    new: (input, ctx) => ctx.runtime.addResource(ctx.webviewLabel, new ImageResource(Uint8Array.from(raw(input, 'rgba') as number[]), reqInteger(input, 'width'), reqInteger(input, 'height'))),
    from_bytes: decodingUnsupported('from_bytes'),
    from_path: decodingUnsupported('from_path'),
    rgba: (input, ctx) => Array.from(get(reqInteger(input, 'rid'), ctx).rgba),
    size: (input, ctx) => { const img = get(reqInteger(input, 'rid'), ctx); return { width: img.width, height: img.height }; },
  };
}
