/**
 * `formatRustFixed` 对照真实 Rust 输出：fixtures/rust-fixed/table.tsv 由同目录 main.rs 生成（rustc 版本在表头）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatRustFixed } from '../rust-fixed.ts';

const rows = readFileSync(new URL('./fixtures/rust-fixed/table.tsv', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => line.split('\t') as [string, string, string, string]);

function parse(literal: string, type: string): number {
  const value = literal === 'inf' ? Infinity : literal === '-inf' ? -Infinity : Number(literal);
  return type === 'f32' ? Math.fround(value) : value;
}

describe('formatRustFixed matches Rust format!("{:.N}") byte for byte', () => {
  it('the table covers f64 and f32 rows', () => {
    expect(rows.filter(([type]) => type === 'f64')).toHaveLength(210);
    expect(rows.filter(([type]) => type === 'f32')).toHaveLength(21);
  });

  it.each(rows)('%s %s with precision %s -> %s', (type, literal, precision, expected) => {
    expect(formatRustFixed(parse(literal, type), Number(precision))).toBe(expected);
  });

  it('differs from toFixed exactly where Rust does: exact ties go to the even digit, the sign survives rounding to zero, no exponent form', () => {
    const cases: Array<[number, number, string, string]> = [
      [0.125, 2, '0.12', '0.13'],
      [-0.125, 2, '-0.12', '-0.13'],
      [2.5, 0, '2', '3'],
      [-0, 2, '-0.00', '0.00'],
      [1e21, 2, '1000000000000000000000.00', '1e+21'],
      [Infinity, 2, 'inf', 'Infinity'],
    ];
    for (const [value, precision, rust, toFixed] of cases) {
      expect([formatRustFixed(value, precision), value.toFixed(precision)]).toEqual([rust, toFixed]);
    }
    expect(formatRustFixed(0.375, 2)).toBe((0.375).toFixed(2));
    expect(formatRustFixed(2.675, 2)).toBe((2.675).toFixed(2));
  });

  it('goes beyond 100 digits, which toFixed refuses, down to the exact value of the smallest subnormal (2^-1074)', () => {
    expect(formatRustFixed(0.5, 120)).toBe(`0.5${'0'.repeat(119)}`);
    expect(() => (0.5).toFixed(120)).toThrow(RangeError);
    const smallest = formatRustFixed(5e-324, 1074);
    expect(smallest).toHaveLength(2 + 1074);
    expect(smallest).toMatch(/^0\.0{323}49406564584124654[0-9]+625$/);
    expect(formatRustFixed(5e-324, 1075)).toBe(`${smallest}0`);
  });

  it('rejects a precision Rust could not have been given', () => {
    for (const precision of [-1, 1.5, Number.NaN, Infinity]) expect(() => formatRustFixed(1, precision)).toThrow(RangeError);
  });
});
