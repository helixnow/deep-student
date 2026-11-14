// 真实 Rust 输出对照表：__fixtures__/serde-json-floats.json 由 __fixtures__/rust-sampler（serde_json 1.0.149 +
// zmij 1.0.21 + ryu 1.0.23，与 src-tauri/Cargo.lock 相同版本，`cargo run --offline` 生成）写出。
// 输入以 IEEE-754 位模式给出，避免十进制往返误差；期望值是 `serde_json::to_string(&x)` 原文。
//
// 拼写规则（zmij 1.0.21 src/lib.rs:1064-1135）：
// - 定点区间：f64 首位十进制指数 ∈ [-5, 15]，f32 ∈ [-6, 12]；整数值补 `.0`。
// - 区间外：`d[.ddd]e±X`，指数不补零（`1e-7`，不是 C/Python 的 `1e-07`），尾数无 `.0`（不是 `1.0e-7`），
//   非负指数写 `e+`（`1e+16`）。ryu（serde_json 1.0.146 之前）写 `1e16`，这是两者唯一的差别。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatF32, formatF64 } from '../index.ts';

interface Fixture {
  tableF64: Array<[string, string, string, string]>;
  tableF32: Array<[string, string, string, string]>;
  f64: Array<[string, string]>;
  f32: Array<[string, string]>;
}
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/serde-json-floats.json'), 'utf8')) as Fixture;

const view = new DataView(new ArrayBuffer(8));
function f64FromBits(hex: string): number {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}
function f32FromBits(hex: string): number {
  view.setUint32(0, Number.parseInt(hex, 16));
  return view.getFloat32(0);
}

describe('serde_json f64 对照表（Rust 实测）', () => {
  it.each(FIXTURE.tableF64)('%s → serde_json %s', (text, bits, serde) => {
    expect(f64FromBits(bits)).toBe(Number(text));
    expect(formatF64(f64FromBits(bits))).toBe(serde);
  });

  it('科学计数法阈值：1e-5 起定点、9.999999999999999e-6 起科学；1e15 定点、1e16 科学', () => {
    const row = (text: string) => FIXTURE.tableF64.find(r => r[0] === text)![2];
    expect(row('1e-5')).toBe('0.00001');
    expect(row('9.999999999999999e-6')).toBe('9.999999999999999e-6');
    expect(row('1e-7')).toBe('1e-7');
    expect(row('1e15')).toBe('1000000000000000.0');
    expect(row('9999999999999998')).toBe('9999999999999998.0');
    expect(row('1e16')).toBe('1e+16');
  });

  it('与 ryu 只差非负指数的 `+`', () => {
    for (const [, , serde, ryu] of [...FIXTURE.tableF64, ...FIXTURE.tableF32]) {
      expect(serde.replace('e+', 'e')).toBe(ryu);
    }
  });

  it(`网格与随机位模式（${FIXTURE.f64.length} 个）逐字节一致`, () => {
    const mismatches = FIXTURE.f64
      .map(([bits, serde]) => [bits, serde, formatF64(f64FromBits(bits))])
      .filter(([, serde, ts]) => serde !== ts);
    expect(mismatches).toEqual([]);
  });
});

describe('serde_json f32 对照表（Rust 实测）', () => {
  it.each(FIXTURE.tableF32)('%s → serde_json %s', (_text, bits, serde) => {
    expect(formatF32(f32FromBits(bits))).toBe(serde);
  });

  it('科学计数法阈值：1e-6 定点、9.999999e-7 科学；1e12 定点、1e13 科学', () => {
    const row = (text: string) => FIXTURE.tableF32.find(r => r[0] === text)![2];
    expect(row('1e-6')).toBe('0.000001');
    expect(row('9.999999e-7')).toBe('9.999999e-7');
    expect(row('1e-7')).toBe('1e-7');
    expect(row('1e12')).toBe('1000000000000.0');
    expect(row('1e13')).toBe('1e+13');
  });

  it(`网格与随机位模式（${FIXTURE.f32.length} 个）逐字节一致`, () => {
    const mismatches = FIXTURE.f32
      .map(([bits, serde]) => [bits, serde, formatF32(f32FromBits(bits))])
      .filter(([, serde, ts]) => serde !== ts);
    expect(mismatches).toEqual([]);
  });

  it('宿主持有的是 f32 窄化前的 double：先 `as f32` 再取最短十进制', () => {
    expect(formatF32(0.212)).toBe(FIXTURE.tableF32.find(r => r[0] === '0.212')![2]);
    expect(formatF32(f32FromBits(FIXTURE.tableF32.find(r => r[0] === '0.212')![1]))).toBe('0.212');
  });
});
