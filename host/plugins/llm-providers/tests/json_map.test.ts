import { describe, expect, it } from 'vitest';
import { removeKey } from '../src/json_map.ts';

describe.each([['llm', removeKey]])(
  '%s removeKey (serde_json preserve_order Map::remove = indexmap swap_remove)', (_name, remove) => {
    it('moves the last entry into the removed slot and keeps the rest in place', () => {
      const map: Record<string, unknown> = { a: 1, x: 2, b: 3, c: 4 };
      expect(remove(map, 'x')).toBe(2);
      expect(Object.entries(map)).toEqual([['a', 1], ['c', 4], ['b', 3]]);
    });

    it('removing the last or the only following entry matches a plain delete', () => {
      const last: Record<string, unknown> = { a: 1, b: 2, c: 3 };
      remove(last, 'c');
      expect(Object.keys(last)).toEqual(['a', 'b']);
      const second: Record<string, unknown> = { a: 1, b: 2, c: 3 };
      remove(second, 'b');
      expect(Object.keys(second)).toEqual(['a', 'c']);
    });

    it('a missing key changes nothing', () => {
      const map: Record<string, unknown> = { a: 1, b: 2 };
      expect(remove(map, 'z')).toBeUndefined();
      expect(Object.keys(map)).toEqual(['a', 'b']);
    });

    it('keeps an own __proto__ key (JSON-parsed tool schemas) as data', () => {
      const map = JSON.parse('{"x":0,"__proto__":{"p":1},"y":2}') as Record<string, unknown>;
      remove(map, 'x');
      expect(JSON.stringify(map)).toBe('{"y":2,"__proto__":{"p":1}}');
      expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    });
  });
