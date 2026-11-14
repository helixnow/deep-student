import { describe, expect, it } from 'vitest';
import { JsonReader, JsonSyntaxError, classifyJsonNumber, objectLastWins, parseJsonDocument, ryuFormat, type JsonNode } from '../api.ts';

const U64_MAX = (1n << 64n) - 1n;
const message = (run: () => unknown) => {
  try { run(); } catch (error) {
    if (error instanceof JsonSyntaxError) return error.message;
    throw error;
  }
  throw new Error('no error');
};
const fail = (text: string) => message(() => parseJsonDocument(text));

describe.each(['string', 'bytes'] as const)('ASCII string spans (%s input)', mode => {
  const reader = (text: string) => mode === 'bytes'
    ? JsonReader.fromSlice(new TextEncoder().encode(text)) : new JsonReader(text);
  const span = 'a'.repeat(4096);

  it('resumes after Unicode and escapes, then reads subsequent keys and exact numbers', () => {
    const value = `${span}é${span}😀${span}\n${span}\"\\/${span}\u007f`;
    const r = reader(`{"${span}":${JSON.stringify(value)},"next":18446744073709551615}`);
    r.beginObject();
    expect(r.nextKey()).toBe(span);
    expect(r.readString()).toBe(value);
    expect(r.nextKey()).toBe('next');
    expect(r.readUnsigned('u64', U64_MAX)).toBe(U64_MAX);
    expect(r.nextKey()).toBeNull();
    r.end();
  });

  it.each([
    ['', 'EOF while parsing a string at line 1 column 4097'],
    ['" x', 'trailing characters at line 1 column 4100'],
    ['é" x', 'trailing characters at line 1 column 4102'],
    ['😀" x', 'trailing characters at line 1 column 4104'],
    ['\\q"', 'invalid escape at line 1 column 4099'],
    ['\\udc00"', 'lone leading surrogate in hex escape at line 1 column 4103'],
    ['\\ud800x"', 'unexpected end of hex escape at line 1 column 4104'],
    ['\\u00é0"', 'invalid escape at line 1 column 4103'],
    ['\u0001"', 'control character (\\u0000-\\u001F) found while parsing a string at line 1 column 4098'],
    ['\n"', 'control character (\\u0000-\\u001F) found while parsing a string at line 2 column 0'],
  ])('keeps byte positions and error priority for suffix %j', (suffix, expected) => {
    expect(message(() => {
      const r = reader(`"${span}${suffix}`);
      r.readString();
      r.end();
    })).toBe(expected);
  });
});

describe('serde_json 1.0.149 number classification (de.rs:462-527)', () => {
  it('integers keep u64/i64 precision; -0, fractions, exponents and overflow are F64', () => {
    expect(classifyJsonNumber('18446744073709551615')).toEqual({ kind: 'u64', value: U64_MAX, raw: '18446744073709551615' });
    expect(classifyJsonNumber('-9223372036854775808')).toMatchObject({ kind: 'i64', value: -(1n << 63n) });
    expect(classifyJsonNumber('-0')).toMatchObject({ kind: 'f64', value: -0 });
    expect(classifyJsonNumber('1.0')).toMatchObject({ kind: 'f64', value: 1 });
    expect(classifyJsonNumber('1e2')).toMatchObject({ kind: 'f64', value: 100 });
    expect(classifyJsonNumber('18446744073709551616')).toMatchObject({ kind: 'f64' });
    // zmij-1.0.21 lib.rs:1102-1106 写指数符号：dec_exp >= 0 为 `e+`（ryu 不写 +）。
    expect(['-0.0', '0.0', '24.0', '10.0', '1.5', '1.8446744073709552e+19', '1e-7'].map(v => v))
      .toEqual([-0, 0, 24, 10, 1.5, 18446744073709551616, 1e-7].map(ryuFormat));
  });
});

describe('JsonReader typed consumption keeps serde error priority', () => {
  it('-0 is a float for u32 and full u64 range is exact', () => {
    const r = new JsonReader('[-0]');
    r.beginArray();
    r.nextItem();
    expect(message(() => r.readUnsigned('u32', 0xffff_ffffn))).toBe('invalid type: floating point `-0.0`, expected u32 at line 1 column 3');
    const big = new JsonReader('18446744073709551615');
    expect(big.readUnsigned('u64', U64_MAX)).toBe(U64_MAX);
    expect(message(() => new JsonReader('18446744073709551616').readUnsigned('u64', U64_MAX)))
      .toBe('invalid type: floating point `1.8446744073709552e+19`, expected u64 at line 1 column 20');
    expect(message(() => new JsonReader('-1').readUnsigned('u32', 0xffff_ffffn))).toBe('invalid value: integer `-1`, expected u32 at line 1 column 2');
  });

  it('a field type error is reported before later invalid tokens; columns are UTF-8 bytes (emoji = 4)', () => {
    const r = new JsonReader('{"a":"😀","b":false} trailing');
    r.beginObject();
    expect(r.nextKey()).toBe('a');
    expect(r.readString()).toBe('😀');
    expect(r.nextKey()).toBe('b');
    expect(message(() => r.readString())).toBe('invalid type: boolean `false`, expected a string at line 1 column 21');
  });

  it('duplicate known field is reported before reading an invalid second value', () => {
    const r = new JsonReader('{"a":1,"a":!}');
    r.beginObject();
    r.nextKey();
    r.readUnsigned('u8', 255n);
    expect(r.nextKey()).toBe('a');
    expect(message(() => { throw r.fieldError('duplicate field `a`'); })).toBe('duplicate field `a` at line 1 column 10');
  });

  it('missing field is reported after the closing brace; unknown fields are still syntax-checked', () => {
    const r = new JsonReader('{"x":1,"x":[2]}');
    r.beginObject();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) r.skipValue();
    expect(r.error('missing field `b`').message).toBe('missing field `b` at line 1 column 15');
    expect(message(() => {
      const bad = new JsonReader('{"x":1,"x":!}');
      bad.beginObject();
      for (let key = bad.nextKey(); key !== null; key = bad.nextKey()) bad.skipValue();
    })).toBe('expected value at line 1 column 12');
  });
});

describe('JsonReader externally-tagged enum map form (de.rs deserialize_enum)', () => {
  const unitVariant = (text: string) => {
    const r = new JsonReader(text);
    r.beginObject();
    const name = r.readEnumVariant();
    r.readNull('unit variant');
    r.endEnumObject();
    r.end();
    return name;
  };
  it('reads one variant and requires the closing brace without reading a second key', () => {
    expect(unitVariant('{"linux":null}')).toBe('linux');
    expect(unitVariant('{ "linux" : null }')).toBe('linux');
    // F1 counterexample: Rust reports at the unconsumed comma, before any second key.
    expect(message(() => unitVariant('{"linux":null , "windows":null}'))).toBe('expected value at line 1 column 14');
    expect(message(() => unitVariant('{"linux":null'))).toBe('EOF while parsing an object at line 1 column 13');
    expect(message(() => unitVariant('{1:null}'))).toBe('invalid type: integer `1`, expected variant identifier at line 1 column 2');
    expect(message(() => unitVariant('{"linux" null}'))).toBe('expected `:` at line 1 column 10');
  });
});

describe('JsonReader.endArray (positional struct / tuple end_seq)', () => {
  function oneUnsigned(text: string): void {
    const r = new JsonReader(text);
    r.beginArray();
    expect(r.nextItem()).toBe(true);
    r.readUnsigned('u32', 0xffff_ffffn);
    r.endArray();
    r.end();
  }
  it('closes after fixed fields and reports extra elements without reading their values', () => {
    oneUnsigned('[1]');
    oneUnsigned('[1 ]');
    const r = new JsonReader('[1,2,3,4,5,6,7,8,9,10]');
    r.beginArray();
    for (let i = 0; i < 9; i++) { expect(r.nextItem()).toBe(true); r.readUnsigned('u32', 0xffff_ffffn); }
    expect(message(() => r.endArray())).toBe('trailing characters at line 1 column 20');
    expect(message(() => oneUnsigned('[1,!]'))).toBe('trailing characters at line 1 column 4');
    expect(message(() => oneUnsigned('[1,]'))).toBe('trailing comma at line 1 column 4');
    expect(message(() => oneUnsigned('[1,'))).toBe('trailing characters at line 1 column 3');
    expect(message(() => oneUnsigned('[1'))).toBe('EOF while parsing a list at line 1 column 2');
  });
  it('uses peek byte positions, including after emoji and line breaks', () => {
    expect(message(() => oneUnsigned('[1 😀]'))).toBe('trailing characters at line 1 column 4');
    expect(message(() => oneUnsigned('[1,\n😀]'))).toBe('trailing characters at line 2 column 1');
    const r = new JsonReader('["😀",0]');
    r.beginArray();
    r.nextItem();
    expect(r.readString()).toBe('😀');
    expect(message(() => r.endArray())).toBe('trailing characters at line 1 column 9');
  });
});

describe('parseJsonDocument (serde_json::Value)', () => {
  it('arbitrary_precision accepts legal numbers beyond f64 without exposing Infinity', () => {
    const raw = '{"a":1e400,"a":-1e400,"nested":[1e-400,1234567890123456789012345678901234567890]}';
    const root = parseJsonDocument(raw);
    if (root.kind !== 'object') throw new Error('object');
    expect(root.members[0]!.value).toEqual({ kind: 'number', value: { kind: 'arbitrary', raw: '1e400' } });
    expect(objectLastWins(root).get('a')).toEqual({ kind: 'number', value: { kind: 'arbitrary', raw: '-1e400' } });
    const nested = root.members[2]!.value;
    if (nested.kind !== 'array') throw new Error('array');
    expect(nested.items.map(node => node.kind === 'number' ? node.value.raw : null))
      .toEqual(['1e-400', '1234567890123456789012345678901234567890']);
    expect(fail('{"a":1e400} x')).toBe('trailing characters at line 1 column 13');
    expect(fail('1e')).toBe('EOF while parsing a value at line 1 column 2');
    expect(fail('[1e+]')).toBe('invalid number at line 1 column 5');
    expect(fail('"\\ud800"')).toContain('unexpected end of hex escape');
  });

  it('skipValue accepts arbitrary numeric tokens, while typed numeric reads still reject overflow', () => {
    const r = new JsonReader('{"ignored":{"huge":1e400},"known":7}');
    r.beginObject();
    expect(r.nextKey()).toBe('ignored');
    r.skipValue();
    expect(r.nextKey()).toBe('known');
    expect(r.readUnsigned('u32', 0xffff_ffffn)).toBe(7n);
    expect(r.nextKey()).toBeNull();
    r.end();
    for (const read of [
      (r: JsonReader) => r.readNumber('f64'),
      (r: JsonReader) => r.readUnsigned('u64', U64_MAX),
      (r: JsonReader) => r.readSigned('i64', -(1n << 63n), (1n << 63n) - 1n),
    ]) {
      expect(message(() => read(new JsonReader('1e400 trailing'))))
        .toBe('number out of range at line 1 column 5');
    }
    expect(message(() => new JsonReader('1e+').skipValue())).toBe('invalid number at line 1 column 3');
    expect(message(() => new JsonReader('[1e+] x').skipValue())).toBe('invalid number at line 1 column 5');
    expect(message(() => new JsonReader('['.repeat(128)).skipValue())).toContain('recursion limit exceeded');
  });

  it('keeps member order and duplicates; Value semantics are last-wins', () => {
    const root = parseJsonDocument('{"a":1,"__proto__":2,"a":3}');
    if (root.kind !== 'object') throw new Error('object');
    expect(root.members.map(m => m.key)).toEqual(['a', '__proto__', 'a']);
    const map = objectLastWins(root);
    expect([...map.keys()]).toEqual(['a', '__proto__']);
    expect((map.get('a') as JsonNode & { kind: 'number' }).value.raw).toBe('3');
  });

  it('decodes escapes and surrogate pairs', () => {
    expect(parseJsonDocument('"\\u00e9\\ud83d\\ude00\\n\\/"')).toEqual({ kind: 'string', value: 'é😀\n/' });
  });

  it('reports serde_json ErrorCode Display at serde positions', () => {
    expect(fail('')).toBe('EOF while parsing a value at line 1 column 0');
    expect(fail('x')).toBe('expected value at line 1 column 1');
    expect(fail('"é" x')).toBe('trailing characters at line 1 column 6');
    expect(fail('{\n  "a": tru }')).toBe('expected ident at line 2 column 11');
    expect(fail('{"a":')).toBe('EOF while parsing a value at line 1 column 5');
    expect(fail('{')).toBe('EOF while parsing an object at line 1 column 1');
    expect(fail('[')).toBe('EOF while parsing a list at line 1 column 1');
    expect(fail('{"a" 1}')).toBe('expected `:` at line 1 column 6');
    expect(fail('{1:2}')).toBe('key must be a string at line 1 column 2');
    expect(fail('{"a":1,}')).toBe('trailing comma at line 1 column 8');
    expect(fail('[1,]')).toBe('trailing comma at line 1 column 4');
    expect(fail('[1 2]')).toBe('expected `,` or `]` at line 1 column 4');
    expect(fail('{"a":1')).toBe('EOF while parsing an object at line 1 column 6');
    expect(fail('01')).toBe('invalid number at line 1 column 2');
    expect(fail('"\\q"')).toBe('invalid escape at line 1 column 3');
    expect(fail('"abc')).toBe('EOF while parsing a string at line 1 column 4');
  });

  it('enforces the 128-level recursion limit', () => {
    expect(parseJsonDocument('['.repeat(127) + ']'.repeat(127)).kind).toBe('array');
    expect(fail('['.repeat(128) + ']'.repeat(128))).toBe('recursion limit exceeded at line 1 column 128');
  });
});

// serde_json 1.0.149 error.rs:471-475：`floating point `{}``，格式化器 zmij 1.0.21 `Buffer::format`。
// 位置 = 已消费的数字 token 末尾（readUnsigned/readSigned/invalidType 都用 error()）。
describe('JsonReader typed float errors use zmij 1.0.21 formatting (lib.rs:1012-1135)', () => {
  const unsigned = (text: string) => message(() => new JsonReader(text).readUnsigned('u64', U64_MAX));

  it('positive scientific exponents carry `+` (lib.rs:1102-1106 e_sign)', () => {
    // 1e21：dec_exp 21 不在 [-5,15]（lib.rs:1065）→ 科学计数；单个有效数字不写 `.`（lib.rs:1098）。
    expect(unsigned('1e21')).toBe('invalid type: floating point `1e+21`, expected u64 at line 1 column 4');
    // u64::MAX+1 溢出 u64 → F64（de.rs parse_integer）；dec_exp 19。
    expect(unsigned('18446744073709551616')).toBe('invalid type: floating point `1.8446744073709552e+19`, expected u64 at line 1 column 20');
    expect(message(() => new JsonReader('18446744073709551616').readSigned('i64', -(1n << 63n), (1n << 63n) - 1n)))
      .toBe('invalid type: floating point `1.8446744073709552e+19`, expected i64 at line 1 column 20');
    // 三位指数：lib.rs:1121-1134 的 dec_exp >= 100 分支。
    expect(unsigned('1e100')).toBe('invalid type: floating point `1e+100`, expected u64 at line 1 column 5');
    expect(unsigned('1.7976931348623157e308')).toBe('invalid type: floating point `1.7976931348623157e+308`, expected u64 at line 1 column 22');
    expect(message(() => new JsonReader('-1e21').readSigned('i64', -(1n << 63n), (1n << 63n) - 1n)))
      .toBe('invalid type: floating point `-1e+21`, expected i64 at line 1 column 5');
  });

  it('the fixed/scientific boundary stays at dec_exp 15/16 (lib.rs:1065)', () => {
    // dec_exp 15，length-1 <= dec_exp → 补零加 `.0`（lib.rs:1067-1074）。
    expect(unsigned('1e15')).toBe('invalid type: floating point `1000000000000000.0`, expected u64 at line 1 column 4');
    expect(unsigned('9999999999999998.0')).toBe('invalid type: floating point `9999999999999998.0`, expected u64 at line 1 column 18');
    // dec_exp 15，length-1 > dec_exp → 定点小数（lib.rs:1075-1081）。
    expect(unsigned('1234567890123456.7')).toBe('invalid type: floating point `1234567890123456.8`, expected u64 at line 1 column 18');
    // dec_exp 16 → 科学计数。
    expect(unsigned('1e16')).toBe('invalid type: floating point `1e+16`, expected u64 at line 1 column 4');
    expect(unsigned('12345678901234567890.5')).toBe('invalid type: floating point `1.2345678901234567e+19`, expected u64 at line 1 column 22');
  });

  it('negative exponents, -0 and the dec_exp -5/-6 boundary are unchanged', () => {
    // dec_exp -5 → 定点 `0.0000…`（lib.rs:1082-1090）；-6 → `e-`（lib.rs:1105）。
    expect(unsigned('1e-5')).toBe('invalid type: floating point `0.00001`, expected u64 at line 1 column 4');
    expect(unsigned('1.2345e-5')).toBe('invalid type: floating point `0.000012345`, expected u64 at line 1 column 9');
    expect(unsigned('1e-6')).toBe('invalid type: floating point `1e-6`, expected u64 at line 1 column 4');
    expect(unsigned('1.5e-7')).toBe('invalid type: floating point `1.5e-7`, expected u64 at line 1 column 6');
    expect(unsigned('5e-324')).toBe('invalid type: floating point `5e-324`, expected u64 at line 1 column 6');
    // 零：lib.rs:1031-1037 写 `0.0`，负号由 lib.rs:1019-1022 先写。
    expect(unsigned('-0')).toBe('invalid type: floating point `-0.0`, expected u64 at line 1 column 2');
    expect(unsigned('0e5')).toBe('invalid type: floating point `0.0`, expected u64 at line 1 column 3');
    expect(unsigned('24.0')).toBe('invalid type: floating point `24.0`, expected u64 at line 1 column 4');
  });

  it('invalidType through a struct keeps the field error before later syntax errors', () => {
    const r = new JsonReader('{"a":1e21,"b":!} x');
    r.beginObject();
    expect(r.nextKey()).toBe('a');
    expect(message(() => r.readString())).toBe('invalid type: floating point `1e+21`, expected a string at line 1 column 9');
    const seq = new JsonReader('[1, 1e16]');
    seq.beginArray();
    seq.nextItem();
    expect(seq.readUnsigned('u8', 255n)).toBe(1n);
    seq.nextItem();
    expect(message(() => seq.readUnsigned('u8', 255n))).toBe('invalid type: floating point `1e+16`, expected u8 at line 1 column 8');
  });
});
