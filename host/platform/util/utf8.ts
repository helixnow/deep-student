/**
 * UTF-8 校验辅助：与 Rust `std::str::from_utf8` 的 `Utf8Error` 边界一致。
 *
 * 该函数只返回“首个错误”的位置与长度，供严格解码器与增量流解码器共用；
 * 不自行替换字节，调用方决定 U+FFFD / 抛错 / 保留 pending。
 */
export interface Utf8ValidPrefix {
  /** 首个错误前的合法字节数。 */
  readonly validUpTo: number;
  /** `null` = 末尾不完整序列；数字 = 真正非法序列的字节数。 */
  readonly errorLength: number | null;
}

/** 返回首个 UTF-8 错误；整个输入合法时返回 `null`。 */
export function validUtf8Prefix(bytes: Uint8Array): Utf8ValidPrefix | null {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index]!;
    if (first < 0x80) {
      index += 1;
      continue;
    }
    let width: number;
    if (first >= 0xc2 && first <= 0xdf) width = 2;
    else if (first >= 0xe0 && first <= 0xef) width = 3;
    else if (first >= 0xf0 && first <= 0xf4) width = 4;
    else return { validUpTo: index, errorLength: 1 };
    if (index + width > bytes.length) return { validUpTo: index, errorLength: null };
    const second = bytes[index + 1]!;
    const secondOk = first === 0xe0
      ? second >= 0xa0 && second <= 0xbf
      : first === 0xed
        ? second >= 0x80 && second <= 0x9f
        : first === 0xf0
          ? second >= 0x90 && second <= 0xbf
          : first === 0xf4
            ? second >= 0x80 && second <= 0x8f
            : (second & 0xc0) === 0x80;
    if (!secondOk) return { validUpTo: index, errorLength: 1 };
    if (width >= 3) {
      const third = bytes[index + 2]!;
      if ((third & 0xc0) !== 0x80) return { validUpTo: index, errorLength: 2 };
    }
    if (width === 4) {
      const fourth = bytes[index + 3]!;
      if ((fourth & 0xc0) !== 0x80) return { validUpTo: index, errorLength: 3 };
    }
    index += width;
  }
  return null;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

/** WHATWG UTF-8 编码；非法序列替换为 U+FFFD（与 `Buffer#toString('utf8')` 相同）。 */
export function encodeUtf8(value: string): Uint8Array {
  return ENCODER.encode(value);
}

/** WHATWG UTF-8 有损解码；孤立代理按 U+FFFD 编码（与 `Buffer.from(value, 'utf8')` 相同）。 */
export function decodeUtf8Lossy(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/**
 * Rust `String`/`str` 的 `Ord`：按 UTF-8 字节序比较，返回 -1 / 0 / 1（同 `Buffer.compare`）。
 * 孤立代理按 U+FFFD 编码后参与比较。
 */
export function compareUtf8(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  const a = encodeUtf8(left);
  const b = encodeUtf8(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Rust `str::len()`：UTF-8 字节数（不是 JS 的 UTF-16 code unit 数）；孤立代理按 U+FFFD 计 3 字节。 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** `byteOffset` 是否落在 UTF-8 字符边界上（0..len 含端点）。 */
export function isCharBoundary(value: string, byteOffset: number): boolean {
  const bytes = encodeUtf8(value);
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) return false;
  return byteOffset === 0 || byteOffset === bytes.length || (bytes[byteOffset]! & 0xc0) !== 0x80;
}

/**
 * 按 UTF-8 字符边界安全截断：返回不超过 `maxBytes` 字节的最长前缀。
 * 负数或非法参数抛 `RangeError`；超过长度时返回原字符串。
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`truncateUtf8: invalid maxBytes ${maxBytes}`);
  }
  const bytes = encodeUtf8(value);
  if (maxBytes >= bytes.length) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decodeUtf8Lossy(bytes.subarray(0, end));
}

/**
 * Rust `String::truncate(new_len)`：`new_len` 必须是字符边界且不超过长度，
 * 否则抛 `RangeError`（Rust 为 panic）。
 */
export function truncateUtf8Exact(value: string, newLength: number): string {
  const bytes = encodeUtf8(value);
  if (!Number.isInteger(newLength) || newLength < 0 || newLength > bytes.length) {
    throw new RangeError(`truncateUtf8Exact: new_len ${newLength} out of bounds (len ${bytes.length})`);
  }
  if (newLength > 0 && newLength < bytes.length && (bytes[newLength]! & 0xc0) === 0x80) {
    throw new RangeError(`truncateUtf8Exact: new_len ${newLength} is not a char boundary`);
  }
  return decodeUtf8Lossy(bytes.subarray(0, newLength));
}

/** Rust `Utf8Error` / `FromUtf8Error`。 */
export class Utf8DecodeError extends Error {
  readonly validUpTo: number;
  readonly errorLength: number | null;

  constructor(
    validUpTo: number,
    errorLength: number | null,
  ) {
    super(
      errorLength === null
        ? `incomplete utf-8 byte sequence from index ${validUpTo}`
        : `invalid utf-8 sequence of ${errorLength} bytes from index ${validUpTo}`,
    );
    this.validUpTo = validUpTo;
    this.errorLength = errorLength;
    this.name = 'Utf8DecodeError';
  }
}

/**
 * Rust `String::from_utf8` 的 `Utf8Error` Display 文案；合法时返回 null。
 */
export function utf8ErrorMessage(bytes: Uint8Array): string | null {
  const invalid = validUtf8Prefix(bytes);
  if (invalid === null) return null;
  return new Utf8DecodeError(invalid.validUpTo, invalid.errorLength).message;
}

/** `std::str::from_utf8` 严格解码；非法 UTF-8 抛 {@link Utf8DecodeError}。 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  const invalid = validUtf8Prefix(bytes);
  if (invalid !== null) throw new Utf8DecodeError(invalid.validUpTo, invalid.errorLength);
  return decodeUtf8Lossy(bytes);
}
