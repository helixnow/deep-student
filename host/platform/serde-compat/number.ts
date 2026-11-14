/**
 * serde_json 1.0.149 的数字拼写。
 *
 * - f64：`ser.rs` serialize_f64 → zmij 1.0.21 `format_finite`；与 platform/util 的 `ryuFormat` 同一实现。
 * - f32：先 `as f32`，再取 binary32 的最短往返十进制（util `f32ToJsonNumber`），按 zmij f32 的
 *   定点区间 [-6, 12]（zmij-1.0.21 src/lib.rs:1064-1066）排版。
 * - NaN / ±Infinity：serialize_f32/f64 写 `null`（ser.rs:155-171）。
 * - 整数：十进制原样；u64/i64 超过 2^53 必须以 bigint 或原生数字原子给出。
 */
import { isJsonNumberAtom } from '../../kernel/serde.ts';
import { f32ToJsonNumber } from '../util/f32-json.ts';
import { ryuFormat } from '../util/json-exact.ts';
import { RustShapeError, type IntKind, type JsonNumberAtom } from './api.ts';

type NativeJson = typeof JSON & { rawJSON?(text: string): JsonNumberAtom; isRawJSON?(value: unknown): boolean };
const nativeJson = JSON as NativeJson;

/** kernel 的原子判别；运行时没有 `JSON.isRawJSON`（旧 WebView）时不存在原子。 */
export function isNumberAtom(value: unknown): value is JsonNumberAtom {
  return typeof nativeJson.isRawJSON === 'function' && isJsonNumberAtom(value);
}

/** 数值输入（number / bigint / 原子）转成 JS number；其他类型报错。 */
function toNumber(value: unknown, path: string, what: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (isNumberAtom(value)) return Number(value.rawJSON);
  throw new RustShapeError(path, `expected ${what}, got ${describe(value)}`);
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Map) return 'Map';
  return typeof value === 'object' ? 'object' : `${typeof value} ${String(value).slice(0, 40)}`;
}

/** zmij 的排版：`digits` 为去掉小数点的有效数字，`exp` 为首位数字的十进制指数。 */
function layout(digits: string, exp: number, low: number, high: number): string {
  const len = digits.length;
  if (exp >= low && exp <= high) {
    if (len - 1 <= exp) return `${digits}${'0'.repeat(exp - (len - 1))}.0`;
    if (exp >= 0) return `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    return `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return `${digits[0]}${len > 1 ? `.${digits.slice(1)}` : ''}e${exp < 0 ? '-' : '+'}${Math.abs(exp)}`;
}

/** Rust `f64` 经 serde_json 序列化的文本；整数值带 `.0`。 */
export function formatF64(value: number | bigint | JsonNumberAtom, path = '$'): string {
  const n = toNumber(value, path, 'f64');
  return Number.isFinite(n) ? ryuFormat(n) : 'null';
}

/** Rust `f32` 经 serde_json 序列化的文本（输入先按 `as f32` 舍入）。 */
export function formatF32(value: number | bigint | JsonNumberAtom, path = '$'): string {
  const n = f32ToJsonNumber(toNumber(value, path, 'f32'));
  if (n === null) return 'null';
  if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
  const [mantissa = '', exponent = '0'] = Math.abs(n).toExponential().split('e');
  return (n < 0 ? '-' : '') + layout(mantissa.replace('.', ''), Number(exponent), -6, 12);
}

const INT_RANGES: Record<IntKind, readonly [bigint, bigint]> = {
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, 18446744073709551615n],
  usize: [0n, 18446744073709551615n], u128: [0n, 2n ** 128n - 1n],
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n], isize: [-(2n ** 63n), 2n ** 63n - 1n], i128: [-(2n ** 127n), 2n ** 127n - 1n],
};

/** 整数输入 → bigint；number 只接受安全整数（更大的值已丢精度，须用 bigint）。 */
export function toInteger(kind: IntKind, value: unknown, path = '$'): bigint {
  let big: bigint;
  if (typeof value === 'bigint') big = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RustShapeError(path, `expected ${kind} as a safe integer or bigint, got ${value}`);
    big = BigInt(value);
  } else if (isNumberAtom(value) && /^-?\d+$/.test(value.rawJSON)) big = BigInt(value.rawJSON);
  else throw new RustShapeError(path, `expected ${kind}, got ${describe(value)}`);
  const [min, max] = INT_RANGES[kind];
  if (big < min || big > max) throw new RangeError(`${path}: ${big} out of range for ${kind}`);
  return big;
}

export function formatInt(kind: IntKind, value: number | bigint | JsonNumberAtom, path = '$'): string {
  return toInteger(kind, value, path).toString();
}

/**
 * `serde_json::Value` 中的数字：原子按 arbitrary_precision 的文本保留（指数写 `e+`，`-0` 为 `0`，
 * 同 util/json-value.ts），bigint 原样，number 的整数值写整数（`integralFloats: 'float'` 时按 f64）。
 */
export function formatValueNumber(value: number | bigint | JsonNumberAtom, integralFloats: 'int' | 'float'): string {
  if (typeof value === 'bigint') return value.toString();
  if (isNumberAtom(value)) {
    const raw = value.rawJSON;
    if (raw === '-0') return '0';
    return raw.replace('E', 'e').replace(/e(?=\d)/, 'e+');
  }
  if (!Number.isFinite(value)) return 'null';
  // serde_json Value 的整数是 u64 / i64；超出两者的整数值只能来自 f64。
  if (integralFloats === 'int' && Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 64) {
    return BigInt(value).toString();
  }
  return ryuFormat(value);
}

function atom(text: string): JsonNumberAtom {
  if (typeof nativeJson.rawJSON !== 'function') throw new Error('JSON.rawJSON is unavailable in this runtime; use toRustJson instead');
  return nativeJson.rawJSON(text);
}

/** 让手工组装的对象经 `JSON.stringify` 写出 Rust f64 拼写（非有限值为 `null`）。 */
export function f64Atom(value: number | bigint | JsonNumberAtom): JsonNumberAtom {
  return atom(formatF64(value));
}

/** 同 {@link f64Atom}，按 f32。 */
export function f32Atom(value: number | bigint | JsonNumberAtom): JsonNumberAtom {
  return atom(formatF32(value));
}
