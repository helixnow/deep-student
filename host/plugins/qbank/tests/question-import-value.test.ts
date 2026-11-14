/**
 * `question_import_service.rs` 的 `serde_json::from_str::<Value>`（arbitrary_precision）数字投影。
 * F4 provider 已在树内，本文件全部为无条件断言；任何异常或结果不符都会失败。
 */
import { describe, expect, it } from 'vitest';
import { f64 } from '../repository/serde-decode.ts';
import { valueFromStr } from '../src/question-import-service.ts';

describe('question_import_service Value numeric projection', () => {
  it('keeps safe integers as numbers and persists unsafe integers losslessly', () => {
    expect(JSON.stringify(valueFromStr('{"a":2,"b":0.7}'))).toBe('{"a":2,"b":0.7}');
    // u64 / i64 超出 Number 安全整数范围时保留原始数字 token，不 Number 舍入。
    expect(JSON.stringify(valueFromStr('{"u":9007199254740993,"i":-9007199254740993,"max":18446744073709551615}')))
      .toBe('{"u":9007199254740993,"i":-9007199254740993,"max":18446744073709551615}');
  });

  it('persists arbitrary Value numbers with serde Display normalization', () => {
    const overflow = valueFromStr('{"n":1e999,"m":-1E999}');
    expect(JSON.stringify(overflow)).toBe('{"n":1e+999,"m":-1e+999}');
  });

  it('persists finite high-precision decimals and exponent tokens exactly', () => {
    const raw = valueFromStr('{"a":1.234567890123456789,"b":0.1000000000000000001,"c":1e-400,"d":1e2}');
    expect(JSON.stringify(raw))
      .toBe('{"a":1.234567890123456789,"b":0.1000000000000000001,"c":1e-400,"d":1e+2}');
  });

  it('reads raw atoms only at the typed f64 boundary', () => {
    const raw = valueFromStr('{"x":1.234567890123456789}') as { x: unknown };
    expect(f64(raw.x, 'x')).toBe(1.234567890123456789);
    expect(JSON.stringify(raw)).toBe('{"x":1.234567890123456789}');
  });

  it('keeps duplicate-key last-wins at the first position', () => {
    expect(JSON.stringify(valueFromStr('{"a":1,"b":2,"a":3}'))).toBe('{"a":3,"b":2}');
  });
});
