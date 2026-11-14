import { expect, it } from 'vitest';
import { JsonReader, jsonNumberToRawJSON, parseJsonDocument, stringifyJsonValue } from '../api.ts';
import { jsonNumberToRawJSON as indexNumber, stringifyJsonValue as indexStringify } from '../index.ts';

it('Value numeric atoms retain arbitrary digits in native JSON.stringify on the real runtime', () => {
  expect(indexNumber).toBe(jsonNumberToRawJSON);
  for (const [raw, canonical] of [
    ['1e999', '1e+999'], ['-1E999', '-1e+999'], ['1e-999', '1e-999'],
    ['9007199254740993', '9007199254740993'], ['18446744073709551615', '18446744073709551615'],
    ['-9223372036854775808', '-9223372036854775808'], ['1.0', '1.0'], ['-0', '0'], ['-0.0', '-0.0'],
  ]) {
    const node = parseJsonDocument(raw!);
    if (node.kind !== 'number') throw new Error('number');
    const atom = jsonNumberToRawJSON(node.value);
    expect(Object.getPrototypeOf(atom)).toBeNull();
    expect(Object.isFrozen(atom)).toBe(true);
    expect(atom.rawJSON).toBe(canonical);
    expect(JSON.stringify({ job_id: 'job-1', details: atom })).toBe(`{"job_id":"job-1","details":${canonical}}`);
  }
});

it('Value numeric atoms remain raw with an existing bigint JSON.stringify replacer', () => {
  const node = parseJsonDocument('1e999');
  if (node.kind !== 'number') throw new Error('number');
  const value = { total: 9007199254740993n, details: { job_id: 'job', n: jsonNumberToRawJSON(node.value) } };
  const saved = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint'
    ? jsonNumberToRawJSON({ kind: 'u64', value: item, raw: item.toString() }) : item);
  expect(saved).toBe('{"total":9007199254740993,"details":{"job_id":"job","n":1e+999}}');
});

it('Value serializer preserves raw numeric semantics, map order and last-wins without plain-object key reordering', () => {
  expect(indexStringify).toBe(stringifyJsonValue);
  const root = parseJsonDocument('{"10":1.0,"2":1E999,"__proto__":{"n":9007199254740993},"10":-0,"list":[-0.0,true,null,"中文😀"]}');
  expect(stringifyJsonValue(root)).toBe('{"10":0,"2":1e+999,"__proto__":{"n":9007199254740993},"list":[-0.0,true,null,"中文😀"]}');
});

it('arbitrary Value saving does not change typed ParserNumber overflow handling', () => {
  expect(() => new JsonReader('1e999').readNumber('f64')).toThrow('number out of range');
  expect(() => new JsonReader('1e999').readUnsigned('u64', (1n << 64n) - 1n)).toThrow('number out of range');
  const zero = new JsonReader('-0').readNumber('u64');
  expect(zero).toMatchObject({ kind: 'f64', value: -0 });
});
