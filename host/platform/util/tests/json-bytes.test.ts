import { describe, expect, it } from 'vitest';
import { JsonReader, JsonSyntaxError, parseJsonDocument, parseJsonDocumentBytes } from '../api.ts';

// 依据：serde_json 1.0.149（src-tauri/Cargo.lock 锁定）from_slice → from_trait（de.rs:2657/2497）
// + SliceRead（read.rs:411-660）。column = 当前行已读字节数（position_of_index:421）；
// peek_error 取 min(len, index+1)（:577）；字符串在闭合引号后才 as_str（:518-529、:868）。

const U64_MAX = (1n << 64n) - 1n;
const bytes = (...parts: (string | number[])[]) => {
  const chunks = parts.map(part => (typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
};
const message = (run: () => unknown) => {
  try { run(); } catch (error) {
    if (error instanceof JsonSyntaxError) return error.message;
    throw error;
  }
  throw new Error('no error');
};
const fail = (...parts: (string | number[])[]) => message(() => parseJsonDocumentBytes(bytes(...parts)));

describe('parseJsonDocumentBytes: serde_json::from_slice::<Value>', () => {
  it('legal Unicode, escapes, exact integers and 1e400 keep raw like the string API', () => {
    const text = '{"名":"é😀\\u00e9\\ud83d\\ude00","n":[18446744073709551615,-9223372036854775808,1e400,-0,0.1],"名":null}';
    const node = parseJsonDocumentBytes(bytes(text));
    expect(node).toEqual(parseJsonDocument(text));
    expect(node).toEqual({
      kind: 'object',
      members: [
        { key: '名', value: { kind: 'string', value: 'é😀é😀' } },
        { key: 'n', value: { kind: 'array', items: [
          { kind: 'number', value: { kind: 'u64', value: U64_MAX, raw: '18446744073709551615' } },
          { kind: 'number', value: { kind: 'i64', value: -(1n << 63n), raw: '-9223372036854775808' } },
          { kind: 'number', value: { kind: 'arbitrary', raw: '1e400' } },
          { kind: 'number', value: { kind: 'f64', value: -0, raw: '-0' } },
          { kind: 'number', value: { kind: 'f64', value: 0.1, raw: '0.1' } },
        ] } },
        { key: '名', value: { kind: 'null' } },
      ],
    });
  });

  it('positions after multibyte characters count bytes (same as from_str)', () => {
    // [ " é(2) " , ␠ x → x 在下标 7，peek_error column 8。
    expect(fail('["é", x]')).toBe('expected value at line 1 column 8');
    expect(message(() => parseJsonDocument('["é", x]'))).toBe('expected value at line 1 column 8');
    expect(fail('["😀",x]')).toBe('expected value at line 1 column 9');
    expect(fail('{"é":1}\n 😀')).toBe('trailing characters at line 2 column 2');
  });

  it('invalid UTF-8 inside a string is reported after the closing quote (as_str)', () => {
    // " a FF b " → 闭合后 index 5。
    expect(fail('"a', [0xff], 'b"')).toBe('invalid unicode code point at line 1 column 5');
    // 对象键同样走 parse_str（MapKey::deserialize_any）。
    expect(fail('{"k', [0xc3], '":1}')).toBe('invalid unicode code point at line 1 column 5');
    // 第二行：{\n"v":" FE " → 行首下标 2，闭合后下标 9 → column 7。
    expect(fail('{\n"v":"', [0xfe], '"}')).toBe('invalid unicode code point at line 2 column 7');
    // 不替换成 U+FFFD 后成功。
    expect(() => parseJsonDocumentBytes(bytes('"', [0xff], '"'))).toThrow(JsonSyntaxError);
  });

  it('truncated multibyte sequences: inside a string, at EOF, outside strings', () => {
    // 中 = E4 B8 AD，截掉最后一个字节。
    expect(fail('"', [0xe4, 0xb8], '"')).toBe('invalid unicode code point at line 1 column 4');
    expect(fail('"', [0xe4, 0xb8])).toBe('EOF while parsing a string at line 1 column 3');
    expect(fail('[1,', [0xe4])).toBe('expected value at line 1 column 4');
    // 原始 C3 与随后的 \u00a9（写入 C2 A9）在闭合处一起校验，不会拼成合法字符。
    expect(fail('"', [0xc3], '\\u00a9"')).toBe('invalid unicode code point at line 1 column 9');
  });

  it('earlier JSON syntax errors win over later invalid UTF-8', () => {
    // parse_ident 读到 ',' 后 index 9 报 expected ident（de.rs parse_ident）。
    expect(fail('{"a":tru,"b":"', [0xff], '"}')).toBe('expected ident at line 1 column 9');
    expect(fail('{\n "a": [1 2],"b":"', [0xff], '"}')).toBe('expected `,` or `]` at line 2 column 10');
    // 字符串内部：控制字符 / 坏转义 / 孤立代理项 / EOF 先于闭合处的 UTF-8 校验。
    expect(fail('"', [0xff, 0x01], '"')).toBe('control character (\\u0000-\\u001F) found while parsing a string at line 1 column 3');
    expect(fail('"', [0xff], '\\q"')).toBe('invalid escape at line 1 column 4');
    expect(fail('"', [0xff], '\\udc00"')).toBe('lone leading surrogate in hex escape at line 1 column 8');
    expect(fail('"', [0xff])).toBe('EOF while parsing a string at line 1 column 2');
  });

  it('trailing invalid bytes after the root value are trailing characters', () => {
    expect(fail('{"a":1}', [0xff])).toBe('trailing characters at line 1 column 8');
    expect(fail('{"a":1} ', [0xfe])).toBe('trailing characters at line 1 column 9');
    expect(fail('1\n', [0x80])).toBe('trailing characters at line 2 column 1');
  });

  it('BOM is not stripped: leading BOM is a syntax error, BOM inside a string is kept', () => {
    expect(fail([0xef, 0xbb, 0xbf], '{}')).toBe('expected value at line 1 column 1');
    expect(parseJsonDocumentBytes(bytes('"', [0xef, 0xbb, 0xbf], '"'))).toEqual({ kind: 'string', value: '\ufeff' });
  });

  it('large inputs keep byte positions across internal chunks', () => {
    const long = 'é'.repeat(70_000);
    expect(parseJsonDocumentBytes(bytes(`"${long}"`))).toEqual({ kind: 'string', value: long });
    expect(fail(`"${'a'.repeat(40_000)}"`, [0xff])).toBe('trailing characters at line 1 column 40003');
  });

  it('IgnoredAny does not validate UTF-8 (ignore_str, read.rs:598)', () => {
    const r = JsonReader.fromSlice(bytes('{"x":"', [0xff], '","y":"ok"}'));
    r.beginObject();
    const seen: string[] = [];
    for (let key; (key = r.nextKey()) !== null;) {
      if (key === 'y') seen.push(r.readString());
      else r.skipIgnoredValue();
    }
    r.end();
    expect(seen).toEqual(['ok']);
    const typed = JsonReader.fromSlice(bytes('{"y":"', [0xff], '"}'));
    typed.beginObject();
    typed.nextKey();
    expect(message(() => typed.readString())).toBe('invalid unicode code point at line 1 column 8');
  });
});

describe('decode_hex_escape consumes four bytes before judging (read.rs:621-635)', () => {
  it.each([
    ['"\\uX000"', 'invalid escape at line 1 column 7'],
    ['"\\uX0', 'EOF while parsing a string at line 1 column 5'],
    ['"\\u00é0"', 'invalid escape at line 1 column 7'],
    ['"\\u000é"', 'invalid escape at line 1 column 7'],
    ['"\\ud800\\uZZZZ"', 'invalid escape at line 1 column 13'],
  ])('%s', (text, expected) => {
    expect(message(() => parseJsonDocument(text))).toBe(expected);
    expect(message(() => parseJsonDocumentBytes(bytes(text)))).toBe(expected);
  });
});
