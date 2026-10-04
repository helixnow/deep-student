/**
 * HEIC/HEIF → JPEG 统一转换入口。
 *
 * 为什么不用 heic2any：它的 Emscripten/embind 胶水在运行期用 `new Function`
 * 生成调用器，release CSP `script-src 'self'` 下必抛 EvalError，转换 100% 失败，
 * 旧逻辑再静默回退为原始 HEIC → 缩略图破裂、LLM 供应商拒收。CSP 不放宽，
 * 因此只用平台原生解码器，分层降级：
 *
 *   1. WebView 原生解码（WebKit：macOS / iOS；装了 HEIF 扩展的 WebView2、
 *      带 libheif 的 WebKitGTK 也可能可以）——以"实际尝试解码"做特性检测，
 *      不看 UA；成功则 canvas 重编码为 JPEG。
 *   2. Android（System WebView 不能解码 HEIC）——Rust 命令 `convert_heic_to_jpeg`
 *      → Kotlin `HeicDecoderPlugin`（Android 9+ ImageDecoder）。
 *   3. 都不行 → 抛 {@link HeicConversionError}，由调用方明确告知用户，
 *      绝不再把 HEIC 原样塞给下游。
 */

import { invoke } from '@tauri-apps/api/core';

/** 输出像素上限（≈16MP）：低于 iOS WebKit canvas 面积上限 16.7MP，远超视觉模型所需。 */
export const HEIC_MAX_OUTPUT_PIXELS = 16_000_000;
export const HEIC_JPEG_QUALITY = 0.9;

export type HeicConversionFailureReason =
  /** 当前平台没有任何可用解码器（如 Windows 未装 HEIF 扩展、Linux 无 libheif） */
  | 'unsupported'
  /** Android 低于 9（API 28），平台不提供 HEIF 解码 */
  | 'android_too_old'
  /** 解码器存在但解码失败（文件损坏、设备缺 HEVC 解码器等） */
  | 'decode_failed';

export class HeicConversionError extends Error {
  readonly reason: HeicConversionFailureReason;
  readonly fileName: string;

  constructor(reason: HeicConversionFailureReason, fileName: string, message: string) {
    super(message);
    this.name = 'HeicConversionError';
    this.reason = reason;
    this.fileName = fileName;
  }
}

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

/** 按扩展名或 MIME 判断 HEIC/HEIF（很多平台给 .heic 的 MIME 为空，扩展名为主）。 */
export function isHeicFile(file: { name: string; type: string }): boolean {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.heic') || name.endsWith('.heif')) return true;
  return HEIC_MIME_TYPES.has((file.type || '').toLowerCase());
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/**
 * 按 ISO-BMFF `ftyp` 主品牌嗅探 HEIC/HEIF（需文件头至少 12 字节）。
 * 品牌表与 Rust `file_manager` 的魔数嗅探一致；AVIF（avif/avis）不算。
 */
export function sniffHeicMime(head: Uint8Array): 'image/heic' | 'image/heif' | null {
  if (head.length < 12) return null;
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return null; // "ftyp"
  const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
  if (HEIC_BRANDS.has(brand)) return 'image/heic';
  if (HEIF_BRANDS.has(brand)) return 'image/heif';
  return null;
}

/** 把 `photo.HEIC` 改成 `photo.jpg`（无扩展名时直接追加）。 */
export function toJpegFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base || 'image'}.jpg`;
}

/** 等比缩放到像素上限以内。 */
export function fitWithinPixels(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

// ============================================================================
// 解码器
// ============================================================================

/** 解码器返回 JPEG Blob；返回 null 表示"本平台不可用"，抛错表示"可用但解码失败"。 */
export type HeicDecoder = (file: File) => Promise<Blob | null>;

type DecodedSource = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decodeToImageSource(blob: Blob): Promise<DecodedSource | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // 不支持该格式 → 再试 <img>（部分 WebKit 版本 createImageBitmap 覆盖面小于 <img>）
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!loaded || !img.naturalWidth || !img.naturalHeight) return null;
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => { img.src = ''; } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * WebView 原生解码 → canvas → JPEG。WebView 不认识 HEIC 时返回 null。
 */
export const decodeHeicWithWebView: HeicDecoder = async (file) => {
  if (typeof document === 'undefined') return null;
  // MIME 为空时补上 image/heic，避免部分引擎因未知类型拒绝嗅探
  const blob = file.type ? file : new Blob([file], { type: 'image/heic' });
  const decoded = await decodeToImageSource(blob);
  if (!decoded) return null;
  try {
    const { width, height } = fitWithinPixels(decoded.width, decoded.height, HEIC_MAX_OUTPUT_PIXELS);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    // JPEG 无 alpha：先铺白底，避免透明区域编码成黑色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const jpeg = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', HEIC_JPEG_QUALITY);
    });
    if (!jpeg || jpeg.size === 0) throw new Error('canvas JPEG encoding failed');
    return jpeg;
  } finally {
    decoded.release();
  }
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

function isAndroidUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent || '');
}

/** Blob.arrayBuffer 在旧 WebView（及 jsdom）缺失时退回 FileReader。 */
function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

function extractInvokeErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * Android 原生解码（Rust `convert_heic_to_jpeg` → Kotlin ImageDecoder）。
 * 非 Android Tauri 运行时返回 null。
 */
export const decodeHeicWithAndroidNative: HeicDecoder = async (file) => {
  if (!isTauriRuntime() || !isAndroidUserAgent()) return null;
  const bytes = new Uint8Array(await readBlobBytes(file));
  let result: ArrayBuffer;
  try {
    result = await invoke<ArrayBuffer>('convert_heic_to_jpeg', bytes);
  } catch (error) {
    const message = extractInvokeErrorMessage(error);
    if (message.includes('HEIC_UNSUPPORTED_OS')) {
      throw new HeicConversionError('android_too_old', file.name, message);
    }
    throw new HeicConversionError('decode_failed', file.name, message);
  }
  if (!result || result.byteLength === 0) {
    throw new HeicConversionError('decode_failed', file.name, 'native decoder returned empty output');
  }
  return new Blob([result], { type: 'image/jpeg' });
};

export const DEFAULT_HEIC_DECODERS: readonly HeicDecoder[] = [
  decodeHeicWithWebView,
  decodeHeicWithAndroidNative,
];

// ============================================================================
// 对外入口
// ============================================================================

/**
 * 把 HEIC/HEIF 转为 JPEG File。依次尝试各解码器：
 * - 返回 Blob → 成功；
 * - 返回 null → 该解码器在本平台不可用，试下一个；
 * - 抛错 → 记录并试下一个（WebView 解码失败时 Android 原生仍可能成功）。
 * 全部失败时抛 {@link HeicConversionError}：若有解码器真正尝试过则保留其失败原因，
 * 否则为 'unsupported'。
 */
export async function convertHeicToJpeg(
  file: File,
  decoders: readonly HeicDecoder[] = DEFAULT_HEIC_DECODERS,
): Promise<File> {
  let lastError: HeicConversionError | null = null;
  for (const decode of decoders) {
    try {
      const jpeg = await decode(file);
      if (jpeg && jpeg.size > 0) {
        return new File([jpeg], toJpegFileName(file.name), {
          type: 'image/jpeg',
          lastModified: file.lastModified,
        });
      }
    } catch (error) {
      lastError = error instanceof HeicConversionError
        ? error
        : new HeicConversionError('decode_failed', file.name, extractInvokeErrorMessage(error));
    }
  }
  throw lastError ?? new HeicConversionError(
    'unsupported',
    file.name,
    'No HEIC decoder is available on this platform',
  );
}

export interface PreparedImageFiles {
  /** 非 HEIC 原样保留；HEIC 已替换为 JPEG。顺序与输入一致（失败项被剔除）。 */
  files: File[];
  /** 转换失败的 HEIC（未包含在 files 中） */
  failures: HeicConversionError[];
}

/**
 * 批量预处理：HEIC 转 JPEG，其他文件原样透传。失败项从结果中剔除并单独返回，
 * 调用方必须向用户明确提示（见 {@link describeHeicConversionError}）。
 */
export async function prepareHeicFiles(
  files: readonly File[],
  decoders: readonly HeicDecoder[] = DEFAULT_HEIC_DECODERS,
): Promise<PreparedImageFiles> {
  const results = await Promise.all(files.map(async (file) => {
    if (!isHeicFile(file)) return { file } as const;
    try {
      return { file: await convertHeicToJpeg(file, decoders) } as const;
    } catch (error) {
      const failure = error instanceof HeicConversionError
        ? error
        : new HeicConversionError('decode_failed', file.name, extractInvokeErrorMessage(error));
      console.warn('[HEIC] conversion failed', { fileName: file.name, reason: failure.reason, message: failure.message });
      return { failure } as const;
    }
  }));
  const prepared: PreparedImageFiles = { files: [], failures: [] };
  for (const result of results) {
    if ('failure' in result) prepared.failures.push(result.failure);
    else prepared.files.push(result.file);
  }
  return prepared;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 面向用户的失败文案（common 命名空间）。 */
export function describeHeicConversionError(error: HeicConversionError, t: Translate): string {
  switch (error.reason) {
    case 'android_too_old':
      return t('common:utils.notifications.heic_android_too_old', { fileName: error.fileName });
    case 'decode_failed':
      return t('common:utils.notifications.heic_decode_failed', { fileName: error.fileName });
    case 'unsupported':
    default:
      return t('common:utils.notifications.heic_unsupported', { fileName: error.fileName });
  }
}
