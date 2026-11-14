import { expect, it } from 'vitest';
import { JsonReader, JsonSyntaxError } from '../api.ts';

const error = (read: () => unknown) => {
  try { read(); } catch (failure) {
    if (failure instanceof JsonSyntaxError) return failure.message;
    throw failure;
  }
  throw new Error('expected JsonSyntaxError');
};

// L01's typed pages fixture: only unknown fields use IgnoredAny; known data uses the usual typed API.
function pages(text: string): string[] {
  const r = new JsonReader(text);
  r.beginObject();
  let result: string[] | undefined;
  for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
    if (key !== 'pages') { r.skipIgnoredValue(); continue; }
    if (result !== undefined) throw r.fieldError('duplicate field `pages`');
    r.beginArray();
    result = [];
    while (r.nextItem()) result.push(r.readString());
  }
  if (result === undefined) throw r.error('missing field `pages`');
  r.end();
  return result;
}

it('IgnoredAny accepts huge numbers, lone surrogate escapes and deep unknown containers', () => {
  // serde_json1.0.149 de.rs:1102-1281, read.rs:ignore_str/ignore_escape.
  expect(pages('{"pages":[],"unknown":1e400}')).toEqual([]);
  expect(pages('{"unknown":"\\ud800","pages":["ok"]}')).toEqual(['ok']);
  expect(pages('{"unknown":{"\\udc00":"\\ud800"},"pages":[]}')).toEqual([]);
  for (const depth of [127, 128, 4096]) {
    expect(pages(`{"unknown":${'['.repeat(depth)}null${']'.repeat(depth)},"pages":[]}`)).toEqual([]);
  }
  // No typed depth is spent inside the ignored value, and the caller's enclosing object is intact.
  const r = new JsonReader('{"unknown":' + '['.repeat(200) + ']'.repeat(200) + ',"known":0}');
  r.beginObject();
  expect(r.nextKey()).toBe('unknown');
  r.skipIgnoredValue();
  expect(r.nextKey()).toBe('known');
  expect(r.readUnsigned('u32', 0xffff_ffffn)).toBe(0n);
  expect(r.nextKey()).toBeNull();
  r.end();
});

it('IgnoredAny does not relax known-field strings, numeric checks or duplicate/trailing order', () => {
  expect(error(() => pages('{"unknown":1e400,"pages":["\\ud800"]}'))).toContain('unexpected end of hex escape');
  expect(error(() => pages('{"pages":[],"pages":!}'))).toBe('duplicate field `pages` at line 1 column 19');
  expect(error(() => pages('{"pages":false} x'))).toBe('invalid type: boolean `false`, expected a sequence at line 1 column 14');
  const r = new JsonReader('[1e400]');
  r.beginArray();
  r.nextItem();
  expect(error(() => r.readUnsigned('u64', (1n << 64n) - 1n))).toBe('number out of range at line 1 column 6');

  const typed = new JsonReader('['.repeat(128));
  expect(error(() => {
    for (let i = 0; i < 128; i++) typed.beginArray();
  })).toBe('recursion limit exceeded at line 1 column 128');
});

it('IgnoredAny preserves its own lexical errors and exact ASCII positions', () => {
  // ignore_value intentionally differs from typed/Value trailing-comma errors.
  const cases: [string, string][] = [
    ['[1,]', 'expected value at line 1 column 4'],
    ['{"a":1,}', 'key must be a string at line 1 column 8'],
    ['[1 2]', 'expected `,` or `]` at line 1 column 4'],
    ['{"a":1 "b":2}', 'expected `,` or `}` at line 1 column 8'],
    ['{"a" 0}', 'expected `:` at line 1 column 6'],
    ['[', 'EOF while parsing a list at line 1 column 1'],
    ['{"a":', 'EOF while parsing a value at line 1 column 5'],
    ['[1,', 'EOF while parsing a value at line 1 column 3'],
    ['01', 'invalid number at line 1 column 2'],
    ['-', 'invalid number at line 1 column 1'],
    ['1.', 'invalid number at line 1 column 2'],
    ['1e+', 'invalid number at line 1 column 3'],
    ['[1e+]', 'invalid number at line 1 column 5'],
    ['"\\uX000"', 'invalid escape at line 1 column 7'],
    ['"\\uX0', 'EOF while parsing a string at line 1 column 5'],
    ['"\\q"', 'invalid escape at line 1 column 3'],
    ['"a\u0001"', 'control character (\\u0000-\\u001F) found while parsing a string at line 1 column 2'],
    ['"unterminated', 'EOF while parsing a string at line 1 column 13'],
  ];
  for (const [text, expected] of cases) expect(error(() => new JsonReader(text).skipIgnoredValue())).toBe(expected);
  expect(error(() => pages('{"pages":[]} x'))).toBe('trailing characters at line 1 column 14');
});

it('legacy skipValue still validates string surrogate pairs and caps depth', () => {
  expect(error(() => new JsonReader('"\\ud800"').skipValue())).toContain('unexpected end of hex escape');
  expect(error(() => new JsonReader('['.repeat(128)).skipValue())).toContain('recursion limit exceeded');
});
