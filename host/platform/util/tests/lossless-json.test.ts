import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JsonFloat, cloneDbJson, dbJsonEquals, isJsonObject, jsonChunksLossless, parseJsonLossless, stringifyJsonLossless,
  toPlainJson, type DbJson,
} from '../lossless-json.ts';

const nativeJson = JSON as typeof JSON & {
  rawJSON(text: string): Readonly<{ rawJSON: string }>;
  isRawJSON(value: unknown): boolean;
};
/** kernel 的原生数字原子；结构上是 `{ rawJSON: string }`，类型上因此也能当 DbJson 对象传入。 */
const atom = (text: string): DbJson => nativeJson.rawJSON(text) as unknown as DbJson;

describe('lossless-json with kernel rawJSON atoms', () => {
  it('serializes an atom like parseJsonLossless of its text, never as a {"rawJSON": …} object', () => {
    const value: DbJson = { big: atom('12345678901234567890'), list: [atom('1.0'), atom('1E5'), atom('-0'), atom('"s"')], n: atom('null') };
    const text = '{"big":12345678901234567890,"list":[1.0,1E5,-0,"s"],"n":null}';
    expect(stringifyJsonLossless(value)).toBe('{"big":12345678901234567890,"list":[1.0,1e+5,0,"s"],"n":null}');
    expect(stringifyJsonLossless(value)).toBe(stringifyJsonLossless(parseJsonLossless(text)));
    expect(stringifyJsonLossless(value, true)).toBe(stringifyJsonLossless(parseJsonLossless(text), true));
    expect([...jsonChunksLossless(atom('7'))]).toEqual(['7']);
  });

  it('compares an atom by the number variant its text parses to', () => {
    expect(dbJsonEquals(atom('9007199254740993'), 9007199254740993n)).toBe(true);
    expect(dbJsonEquals(9007199254740993n, atom('9007199254740993'))).toBe(true);
    expect(dbJsonEquals(atom('1'), 1)).toBe(true);
    expect(dbJsonEquals(atom('1'), new JsonFloat(1))).toBe(false);
    expect(dbJsonEquals(atom('1.0'), new JsonFloat(1, '1.0'))).toBe(true);
    expect(dbJsonEquals(atom('1.0'), 1)).toBe(false);
    expect(dbJsonEquals(atom('null'), null)).toBe(true);
    expect(dbJsonEquals({ a: [atom('2')] }, { a: [2] })).toBe(true);
    expect(dbJsonEquals(atom('1'), { rawJSON: '1' })).toBe(false);
    expect(dbJsonEquals(atom('1'), undefined)).toBe(false);
  });

  it('keeps the atom itself when cloning, and projects it to a plain value', () => {
    const big = atom('12345678901234567890');
    const cloned = cloneDbJson({ list: [big] }) as { list: DbJson[] };
    expect(cloned.list[0]).toBe(big);
    expect(nativeJson.isRawJSON(cloned.list[0])).toBe(true);
    expect(toPlainJson({ big, float: atom('1.5'), int: atom('3'), s: atom('"x"') }))
      .toEqual({ big: 12345678901234567890n, float: 1.5, int: 3, s: 'x' });
  });

  it('isJsonObject rejects atoms but accepts a business object that happens to have a rawJSON key', () => {
    expect(isJsonObject(atom('1'))).toBe(false);
    expect(isJsonObject({ rawJSON: '1' })).toBe(true);
    expect(stringifyJsonLossless({ rawJSON: '1' })).toBe('{"rawJSON":"1"}');
  });
});

describe('lossless-json on a runtime without JSON.isRawJSON (older WKWebView, Node 20 and below)', () => {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, 'isRawJSON')!;
  beforeEach(() => {
    expect(Reflect.deleteProperty(JSON, 'isRawJSON')).toBe(true);
    expect('isRawJSON' in JSON).toBe(false);
  });
  afterEach(() => {
    Object.defineProperty(JSON, 'isRawJSON', descriptor);
  });

  it('treats an object with a rawJSON key as a plain business object everywhere', () => {
    const business: DbJson = { rawJSON: '1' };
    expect(isJsonObject(business)).toBe(true);
    expect(stringifyJsonLossless({ wrapped: business })).toBe('{"wrapped":{"rawJSON":"1"}}');
    expect(stringifyJsonLossless(business, true)).toBe('{\n  "rawJSON": "1"\n}');
    expect([...jsonChunksLossless(business)]).toEqual(['{', '"rawJSON":', '"1"', '}']);
    expect(dbJsonEquals(business, { rawJSON: '1' })).toBe(true);
    expect(dbJsonEquals(business, 1)).toBe(false);
    expect(dbJsonEquals(business, { rawJSON: '2' })).toBe(false);
    const cloned = cloneDbJson(business);
    expect(cloned).not.toBe(business);
    expect(cloned).toEqual({ rawJSON: '1' });
    expect(toPlainJson(business)).toEqual({ rawJSON: '1' });
  });

  it('parses, compares and serializes numbers exactly as with rawJSON support', () => {
    const text = '{"big":12345678901234567890,"list":[1.0,1E5,-0,"s"],"n":null}';
    const parsed = parseJsonLossless(text);
    expect(stringifyJsonLossless(parsed)).toBe('{"big":12345678901234567890,"list":[1.0,1e+5,0,"s"],"n":null}');
    expect(dbJsonEquals(parsed, parseJsonLossless(text))).toBe(true);
    expect(dbJsonEquals(parseJsonLossless('1'), parseJsonLossless('1.0'))).toBe(false);
    expect(toPlainJson(parsed)).toEqual({ big: 12345678901234567890n, list: [1, 100000, -0, 's'], n: null });
  });
});
