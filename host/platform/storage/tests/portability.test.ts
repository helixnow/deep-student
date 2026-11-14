/**
 * 存储层里供移动端复用的模块：运行时不得触达 Node 专有依赖。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { StorageError } from '../errors.ts';
import { cacheDebugEnabled, setCacheDebugSource } from '../llm-usage.ts';
import { detectExtensionFromHead, extractExtension, isVirtualUri } from '../file-names.ts';
import { forEachBinding, planParams, type BindValue } from '../params.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('params, writer-slot, database-layout, llm-usage, file-names, pending-memory-candidates-schema and disk-space never load Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, [
    'host/platform/storage/params.ts',
    'host/platform/storage/writer-slot.ts',
    'host/platform/storage/database-layout.ts',
    'host/platform/storage/llm-usage.ts',
    'host/platform/storage/file-names.ts',
    'host/platform/storage/pending-memory-candidates-schema.ts',
    'host/platform/storage/disk-space.ts',
  ])).toEqual([]);
});

describe('forEachBinding (driver-independent binding by SQLite parameter index)', () => {
  const collect = (sql: string, params: Parameters<typeof forEachBinding>[1]): Array<[number, string | null, BindValue]> => {
    const out: Array<[number, string | null, BindValue]> = [];
    forEachBinding(planParams(sql), params, (slot, value) => out.push([slot.index, slot.key, value]));
    return out;
  };

  it('maps array values to SQLite indexes for ?, ?NNN and named slots, converting booleans', () => {
    expect(collect('SELECT ?2, ?1, ?2', ['a', true])).toEqual([[2, '2', 1], [1, '1', 'a']]);
    expect(collect('SELECT :a, ?, :a', [null, 7n])).toEqual([[1, 'a', null], [2, null, 7n]]);
    const blob = new Uint8Array([1, 2]);
    expect(collect('SELECT @b', { b: blob })[0]![2]).toBe(blob);
  });

  it('rejects with the rusqlite messages', () => {
    expect(() => collect('SELECT ?', undefined)).toThrow('Wrong number of parameters passed to query. Got 0, needed 1');
    expect(() => collect('SELECT ?, ?', [1])).toThrow('Wrong number of parameters passed to query. Got 1, needed 2');
    expect(() => collect('SELECT ?', { x: 1 })).toThrow('Anonymous "?" parameters require an array of values');
    expect(() => collect('SELECT :x', {})).toThrow('SQL parameter "x" is undefined');
    expect(() => collect('SELECT ?1', [{} as never])).toThrow(StorageError);
    expect(collect('SELECT 1', undefined)).toEqual([]);
  });
});

it('cacheDebugEnabled is off until a platform wires a source, and re-evaluates on every call', () => {
  let flag = false;
  setCacheDebugSource(() => flag);
  try {
    expect(cacheDebugEnabled()).toBe(false);
    flag = true;
    expect(cacheDebugEnabled()).toBe(true);
  } finally {
    setCacheDebugSource(() => false);
  }
});

it('file-names classifies names and file heads without touching the file system', () => {
  expect(isVirtualUri(' content://media/1')).toBe(true);
  expect(extractExtension('/a/b/%E6%96%87.PDF')).toBe('pdf');
  const head = (bytes: Uint8Array) => (n: number) => bytes.subarray(0, n);
  const enc = new TextEncoder();
  expect(detectExtensionFromHead(head(enc.encode('%PDF-1.7\n')))).toBe('pdf');
  expect(detectExtensionFromHead(head(enc.encode('a,b\n1,2\n')))).toBe('csv');
  expect(detectExtensionFromHead(() => null)).toBeNull();
});
