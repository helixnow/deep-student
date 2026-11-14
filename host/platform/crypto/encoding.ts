/**
 * hex / base64 / UTF-8 编解码与定长比较的纯函数实现，Node 与 Web 共用。
 * 只依赖 ECMAScript 与 `TextEncoder` / `TextDecoder`，不得 import Node 模块。语义见 `api.ts`。
 */
import { CryptoError, type Base64DecodeOptions, type Base64EncodeOptions, type BinaryInput } from './api.ts';

const HEX_DIGITS = '0123456789abcdef';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const encoder = new TextEncoder();
const lossyDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 字符串按 UTF-8 编码；字节原样返回（不复制）。 */
export function toBytes(data: BinaryInput): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** 把任意 `Uint8Array` 子类（如 Node `Buffer`）变成同一内存上的普通 `Uint8Array` 视图。 */
export function plainBytes(bytes: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(bytes) === Uint8Array.prototype
    ? bytes
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array, options: { readonly fatal?: boolean } = {}): string {
  if (!options.fatal) return lossyDecoder.decode(bytes);
  try {
    return fatalDecoder.decode(bytes);
  } catch (error) {
    throw new CryptoError('InvalidEncoding', `invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 0x0f]!;
  return out;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new CryptoError('InvalidEncoding', `hex string has odd length ${text.length}`);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const high = hexValue(text.charCodeAt(2 * i));
    const low = hexValue(text.charCodeAt(2 * i + 1));
    if (high < 0 || low < 0) throw new CryptoError('InvalidEncoding', `invalid hex digit at offset ${high < 0 ? 2 * i : 2 * i + 1}`);
    out[i] = (high << 4) | low;
  }
  return out;
}

export function toBase64(bytes: Uint8Array, options: Base64EncodeOptions = {}): string {
  const alphabet = options.alphabet ?? 'standard';
  const table = alphabet === 'url' ? URL_SAFE : STANDARD;
  const padding = options.padding ?? alphabet === 'standard';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += table[n >> 18]! + table[(n >> 12) & 63]! + table[(n >> 6) & 63]! + table[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += table[n >> 18]! + table[(n >> 12) & 63]! + (padding ? '==' : '');
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += table[n >> 18]! + table[(n >> 12) & 63]! + table[(n >> 6) & 63]! + (padding ? '=' : '');
  }
  return out;
}

function base64Value(code: number, alphabet: 'standard' | 'url' | 'either'): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (alphabet !== 'url') {
    if (code === 0x2b) return 62;
    if (code === 0x2f) return 63;
  }
  if (alphabet !== 'standard') {
    if (code === 0x2d) return 62;
    if (code === 0x5f) return 63;
  }
  return -1;
}

/** WHATWG infra「ASCII whitespace」：TAB、LF、FF、CR、SPACE。 */
function isAsciiWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

export function fromBase64(text: string, options: Base64DecodeOptions = {}): Uint8Array {
  const alphabet = options.alphabet ?? 'standard';
  let data = '';
  for (let i = 0; i < text.length; i++) {
    if (!isAsciiWhitespace(text.charCodeAt(i))) data += text[i];
  }
  if (data.length % 4 === 0) {
    if (data.endsWith('==')) data = data.slice(0, -2);
    else if (data.endsWith('=')) data = data.slice(0, -1);
  }
  if (data.length % 4 === 1) throw new CryptoError('InvalidEncoding', `invalid base64 length ${data.length}`);
  const out = new Uint8Array(Math.floor((data.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < data.length; i++) {
    const value = base64Value(data.charCodeAt(i), alphabet);
    if (value < 0) throw new CryptoError('InvalidEncoding', `invalid base64 character at offset ${i}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** 定长比较：长度相同时遍历全部字节，耗时与内容无关。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** 参数校验：非负安全整数。 */
export function assertLength(length: number, what: string): void {
  if (!Number.isSafeInteger(length) || length < 0) throw new CryptoError('InvalidArgument', `${what} must be a non-negative safe integer, got ${length}`);
}

/** `randomInt(min, max)` 的参数约束（同 node:crypto）。 */
export function assertRandomIntRange(min: number, max: number): void {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new CryptoError('InvalidArgument', 'randomInt bounds must be safe integers');
  if (max <= min) throw new CryptoError('InvalidArgument', `randomInt requires max > min, got [${min}, ${max})`);
  if (max - min >= 2 ** 48) throw new CryptoError('InvalidArgument', 'randomInt range must be less than 2^48');
}

export function assertAesGcm(key: Uint8Array, iv: Uint8Array, tagLength: number): void {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new CryptoError('InvalidKey', `AES-GCM key must be 16, 24 or 32 bytes, got ${key.length}`);
  }
  if (iv.length === 0) throw new CryptoError('InvalidIv', 'AES-GCM iv must not be empty');
  if (!Number.isInteger(tagLength) || tagLength < 12 || tagLength > 16) {
    throw new CryptoError('InvalidArgument', `AES-GCM tagLength must be 12..16 bytes, got ${tagLength}`);
  }
}
