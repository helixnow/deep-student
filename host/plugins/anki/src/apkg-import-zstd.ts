/**
 * 现代 anki21b 的 zstd 解压与 protobuf 解析（媒体清单 / 笔记类型配置）。
 *
 * zstd 同步解压由本地运行时端口提供（桌面 `node:zlib.zstdDecompressSync`，移动端不注入）；
 * 异步路径用 F7 `nativeCompression`，两端都可用。字节层只用 `Uint8Array`。
 */
import type { NativeCompression } from '../../../platform/native/api.ts';
import { decodeUtf8Strict } from '../../../platform/util/utf8.ts';
import { readU16LE, readU32LE, readU64LE } from './bytes.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  APKG_ERROR_COLLECTION_INVALID,
  MAX_MEDIA_MANIFEST_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZSTD_WINDOW_LOG,
  ZSTD_MAGIC,
  errorMessage,
  validationError,
} from './apkg-import-types.ts';

// ============================================================================
// zstd（现代 anki21b：集合库 / 媒体清单 / 媒体条目）
// ============================================================================

export function isZstdFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === ZSTD_MAGIC[0] && bytes[1] === ZSTD_MAGIC[1]
    && bytes[2] === ZSTD_MAGIC[2] && bytes[3] === ZSTD_MAGIC[3];
}

/**
 * 读取 zstd 帧头里的 windowLog（`Frame_Header_Descriptor` 的 window descriptor /
 * 单段帧的 content size）。Rust 侧用 `Decoder::window_log_max(27)` 限制解码窗口。
 */
export function zstdFrameWindowLog(bytes: Uint8Array): number | null {
  if (bytes.length < 5) return null;
  const descriptor = bytes[4]!;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const dictionaryIdFlag = descriptor & 3;
  let cursor = 5;
  let windowLog: number | null = null;
  if (singleSegment === 0) {
    if (cursor >= bytes.length) return null;
    const windowDescriptor = bytes[cursor]!;
    cursor += 1;
    windowLog = 10 + (windowDescriptor >>> 3);
  }
  cursor += [0, 1, 2, 4][dictionaryIdFlag]!;
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment === 1 ? 1 : 0)
    : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  if (windowLog === null && contentSizeBytes > 0 && cursor + contentSizeBytes <= bytes.length) {
    let contentSize: number;
    if (contentSizeBytes === 1) contentSize = bytes[cursor]!;
    else if (contentSizeBytes === 2) contentSize = readU16LE(bytes, cursor) + 256;
    else if (contentSizeBytes === 4) contentSize = readU32LE(bytes, cursor);
    else contentSize = Number(readU64LE(bytes, cursor));
    windowLog = contentSize <= 1 ? 0 : Math.ceil(Math.log2(contentSize));
  }
  return windowLog;
}

function isTooLargeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

/** 解压至多 `limit` 字节；`overflow` 表示真实输出超过上限。畸形帧抛错。 */
export function zstdDecompressUpTo(bytes: Uint8Array, limit: number): { overflow: boolean; data: Uint8Array } {
  const windowLog = zstdFrameWindowLog(bytes);
  if (windowLog !== null && windowLog > MAX_ZSTD_WINDOW_LOG) {
    throw new Error(`frame window size (2^${windowLog}) exceeds the ${MAX_ZSTD_WINDOW_LOG} window-log limit`);
  }
  try {
    return { overflow: false, data: ankiLocalRuntime().zstdDecompress(bytes, Math.max(1, limit)) };
  } catch (error) {
    if (isTooLargeError(error)) return { overflow: true, data: new Uint8Array(0) };
    throw error;
  }
}

/** F7 `nativeCompression` 版本的同一窗口/输出上限校验（异步路径专用）。 */
export async function zstdDecompressUpToWith(
  compression: NativeCompression,
  bytes: Uint8Array,
  limit: number,
): Promise<{ overflow: boolean; data: Uint8Array }> {
  const windowLog = zstdFrameWindowLog(bytes);
  if (windowLog !== null && windowLog > MAX_ZSTD_WINDOW_LOG) {
    throw new Error(`frame window size (2^${windowLog}) exceeds the ${MAX_ZSTD_WINDOW_LOG} window-log limit`);
  }
  try {
    const decoded = await compression.zstdDecode(bytes, Math.max(1, limit));
    const data = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (data.length > limit) return { overflow: true, data: new Uint8Array(0) };
    return { overflow: false, data };
  } catch (error) {
    // F7 的 `zstdDecode` 在超过上限时抛 RangeError；其余错误保留给调用方映射。
    if (error instanceof RangeError) return { overflow: true, data: new Uint8Array(0) };
    throw error;
  }
}

// ============================================================================
// 现代 APKG（anki21b）：最小 protobuf 解码
// ============================================================================

interface ProtobufCursor {
  offset: number;
}

/** 读取 protobuf varint（最多 10 字节）。 */
function readProtobufVarintBig(bytes: Uint8Array, cursor: ProtobufCursor): bigint {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (cursor.offset >= bytes.length) throw new Error('protobuf varint is truncated');
    const byte = bytes[cursor.offset]!;
    cursor.offset += 1;
    if (shift >= 64n) throw new Error('protobuf varint overflows 64 bits');
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
}

export function readProtobufVarint(bytes: Uint8Array, cursor: ProtobufCursor): number {
  const value = readProtobufVarintBig(bytes, cursor);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export function readProtobufLengthDelimited(bytes: Uint8Array, cursor: ProtobufCursor): Uint8Array {
  const length = readProtobufVarintBig(bytes, cursor);
  const end = BigInt(cursor.offset) + length;
  if (end > BigInt(bytes.length)) throw new Error('protobuf length-delimited field is truncated');
  const slice = bytes.subarray(cursor.offset, Number(end));
  cursor.offset = Number(end);
  return slice;
}

export function skipProtobufValue(bytes: Uint8Array, cursor: ProtobufCursor, wireType: number): void {
  switch (wireType) {
    case 0:
      readProtobufVarintBig(bytes, cursor);
      return;
    case 1:
    case 5: {
      const width = wireType === 1 ? 8 : 4;
      if (cursor.offset + width > bytes.length) {
        throw new Error('protobuf fixed-width field is truncated');
      }
      cursor.offset += width;
      return;
    }
    case 2:
      readProtobufLengthDelimited(bytes, cursor);
      return;
    default:
      throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

/**
 * 解析现代 APKG 媒体清单（zstd 压缩的 protobuf `MediaEntries`）：
 * `MediaEntries { repeated MediaEntry entries = 1; }`、`MediaEntry { string name = 1; … }`。
 * 仅提取 name，按出现顺序映射到 zip 内数字媒体条目 "0","1",…。
 */
export function parseModernMediaManifest(
  bytes: Uint8Array,
  predecoded?: Uint8Array,
): Map<string, string> {
  let decoded = predecoded ?? bytes;
  if (predecoded === undefined && isZstdFrame(bytes)) {
    let result: { overflow: boolean; data: Uint8Array };
    try {
      result = zstdDecompressUpTo(bytes, MAX_MEDIA_MANIFEST_BYTES);
    } catch (error) {
      throw new Error(`zstd 解压失败: ${errorMessage(error)}`);
    }
    if (result.overflow || result.data.length > MAX_MEDIA_MANIFEST_BYTES) {
      throw new Error(`解压后的媒体清单超过 ${MAX_MEDIA_MANIFEST_BYTES} 字节上限`);
    }
    decoded = result.data;
  }

  const names = parseMediaEntriesProtobuf(decoded);
  const manifest = new Map<string, string>();
  names.forEach((name, index) => manifest.set(String(index), name));
  return manifest;
}

export function parseMediaEntriesProtobuf(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const cursor: ProtobufCursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readProtobufVarint(bytes, cursor);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 1 && wireType === 2) {
      const entry = readProtobufLengthDelimited(bytes, cursor);
      names.push(parseMediaEntryName(entry));
      if (names.length > MAX_ZIP_ENTRIES) {
        throw new Error(`媒体清单条目数超过 ${MAX_ZIP_ENTRIES} 上限`);
      }
    } else {
      skipProtobufValue(bytes, cursor, wireType);
    }
  }
  return names;
}

export function parseMediaEntryName(bytes: Uint8Array): string {
  const cursor: ProtobufCursor = { offset: 0 };
  let name: string | null = null;
  while (cursor.offset < bytes.length) {
    const tag = readProtobufVarint(bytes, cursor);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 1 && wireType === 2) {
      const raw = readProtobufLengthDelimited(bytes, cursor);
      name = decodeUtf8StrictMessage(raw, '媒体条目文件名不是合法 UTF-8');
    } else {
      skipProtobufValue(bytes, cursor, wireType);
    }
  }
  if (name === null) throw new Error('媒体条目缺少文件名');
  return name;
}

/** 严格 UTF-8 解码（Rust `std::str::from_utf8`）：非法序列抛调用方文案。 */
function decodeUtf8StrictMessage(bytes: Uint8Array, message: string): string {
  try {
    return decodeUtf8Strict(bytes);
  } catch {
    throw new Error(message);
  }
}

/**
 * 现代 schema `notetypes.config`（protobuf NotetypeConfig）：field 1 = kind
 * （0 = normal，1 = cloze，proto3 零值不序列化）。解析失败保守回退 normal。
 */
export function parseNotetypeKind(config: Uint8Array): number {
  const bytes = config;
  const cursor: ProtobufCursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    let tag: number;
    try {
      tag = readProtobufVarint(bytes, cursor);
    } catch {
      return 0;
    }
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 1 && wireType === 0) {
      try {
        return readProtobufVarint(bytes, cursor) === 1 ? 1 : 0;
      } catch {
        return 0;
      }
    }
    try {
      skipProtobufValue(bytes, cursor, wireType);
    } catch {
      return 0;
    }
  }
  return 0;
}
