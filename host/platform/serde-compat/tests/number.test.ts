// 期望值依据（Cargo.lock：serde_json 1.0.149、zmij 1.0.21；源码见 ~/.cargo/registry/src/*/）：
// - serde_json-1.0.149 src/ser.rs:155-171：f32/f64 的 NaN/Infinity 序列化为 `null`，其余走
//   `Formatter::write_f32/write_f64`（ser.rs:1691-1724）→ `zmij::Buffer::format_finite`。
// - zmij-1.0.21 src/lib.rs:1029-1036：±0 写 `0.0` / `-0.0`；
//   lib.rs:1064-1066：f32 十进制指数在 [-6, 12]、f64 在 [-5, 15] 内用定点，整数值补 `.0`；
//   lib.rs:1093-1135：否则 `d.ddde±X`，非负指数写 `e+`，指数不补零。
// - 有效数字是最短往返表示（Schubfach/zmij；f64 与 JS Number#toExponential() 相同，
//   f32 由 host/platform/util/f32-json.ts 的 f32ToJsonNumber 按 binary32 精度求最短）。
// - 整数：serde_json `itoa` 原样十进制，u64/i64 超过 2^53 仍为精确整数字面量（ser.rs serialize_u64/i64）。
import { describe, expect, it } from 'vitest';
import { f32Atom, f64Atom, formatF32, formatF64, formatInt, RustShapeError, type JsonNumberAtom } from '../index.ts';

const rawJSON = (text: string) => (JSON as unknown as { rawJSON(t: string): JsonNumberAtom }).rawJSON(text);

describe('formatF64（serde_json f64 / zmij f64）', () => {
  it.each([
    [0, '0.0'], [-0, '-0.0'], [1, '1.0'], [92, '92.0'], [525600, '525600.0'], [-3, '-3.0'],
    [0.1, '0.1'], [1.5, '1.5'], [0.1 + 0.2, '0.30000000000000004'], [100.25, '100.25'],
    // 定点上界 dec_exp = 15；16 起科学计数，非负指数带 `+`
    [1e15, '1000000000000000.0'], [123456789012345.6, '123456789012345.6'],
    [1e16, '1e+16'], [1.5e16, '1.5e+16'], [2 ** 53, '9007199254740992.0'], [2 ** 60, '1.152921504606847e+18'],
    // 定点下界 dec_exp = -5
    [0.0001, '0.0001'], [0.00001, '0.00001'], [0.000012, '0.000012'], [0.000001, '1e-6'], [1.5e-7, '1.5e-7'],
    [5e-324, '5e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'], [-2.5e-10, '-2.5e-10'],
  ])('%s → %s', (value, expected) => {
    expect(formatF64(value)).toBe(expected);
  });

  it('非有限值输出 null（ser.rs:169-171）', () => {
    expect(formatF64(Number.NaN)).toBe('null');
    expect(formatF64(Infinity)).toBe('null');
    expect(formatF64(-Infinity)).toBe('null');
  });

  it('接受 bigint 与 kernel 原生数字原子，按 f64 取值', () => {
    expect(formatF64(9007199254740993n)).toBe('9007199254740992.0');
    expect(formatF64(rawJSON('92'))).toBe('92.0');
    expect(formatF64(rawJSON('1E2'))).toBe('100.0');
    expect(() => formatF64('92' as unknown as number)).toThrow(RustShapeError);
    // 业务对象恰好有 rawJSON 键不是原子
    expect(() => formatF64({ rawJSON: '1' } as unknown as number)).toThrow(RustShapeError);
  });
});

describe('formatF32（serde_json f32 / zmij f32）', () => {
  it.each([
    [85, '85.0'], [1, '1.0'], [100, '100.0'], [0, '0.0'], [-0, '-0.0'],
    // 双精度输入先 `as f32`，再取 binary32 的最短往返十进制
    [0.1, '0.1'], [0.1 + 0.2, '0.3'], [1 / 3, '0.33333334'], [0.123456789, '0.12345679'],
    [0.212, '0.212'], [1.2931, '1.2931'], [0.001, '0.001'], [16777217, '16777216.0'],
    // f32 定点区间 [-6, 12]
    [1e12, '1000000000000.0'], [1e13, '1e+13'], [0.000001, '0.000001'], [1e-7, '1e-7'],
    [3.4028234663852886e38, '3.4028235e+38'], [1.401298464324817e-45, '1e-45'], [-2.5e-10, '-2.5e-10'],
  ])('%s → %s', (value, expected) => {
    expect(formatF32(value)).toBe(expected);
  });

  it('非有限值与窄化溢出输出 null', () => {
    expect(formatF32(Number.NaN)).toBe('null');
    expect(formatF32(1e39)).toBe('null');
    expect(formatF32(-Infinity)).toBe('null');
  });
});

describe('formatInt', () => {
  it('u64/i64 全精度', () => {
    expect(formatInt('u64', 18446744073709551615n)).toBe('18446744073709551615');
    expect(formatInt('i64', -9223372036854775808n)).toBe('-9223372036854775808');
    expect(formatInt('u64', rawJSON('9007199254740993'))).toBe('9007199254740993');
    expect(formatInt('u32', 4294967295)).toBe('4294967295');
    expect(formatInt('i32', -0)).toBe('0');
  });

  it('越界、非整数与不安全的 number 都拒绝（Rust 侧不可能出现）', () => {
    expect(() => formatInt('u32', 4294967296)).toThrow(RangeError);
    expect(() => formatInt('u8', -1)).toThrow(RangeError);
    expect(() => formatInt('i64', 1.5)).toThrow(RustShapeError);
    // 2^53 + 1 已无法用 number 精确表示：要求调用方用 bigint
    expect(() => formatInt('u64', 2 ** 53 + 2)).toThrow(RustShapeError);
    expect(() => formatInt('u64', rawJSON('1.0'))).toThrow(RustShapeError);
  });
});

describe('数字原子（JSON.rawJSON，供手工组装对象后 JSON.stringify）', () => {
  it('f64Atom / f32Atom 让 JSON.stringify 写出 Rust 拼写', () => {
    const text = JSON.stringify({ percent: f32Atom(85), steps: [f64Atom(0.5), f64Atom(525600)], bad: f64Atom(Number.NaN) });
    expect(text).toBe('{"percent":85.0,"steps":[0.5,525600.0],"bad":null}');
  });
});
