import { describe, expect, it } from 'vitest';
import { resolveAliasWithLookup } from '../repository/id-alias.ts';

describe('id_alias.rs', () => {
  it('follows chains and preserves the original ID for any cycle', () => {
    const aliases = new Map([['a', 'b'], ['b', 'c']]);
    expect(resolveAliasWithLookup('files', 'a', id => aliases.get(id) ?? null)).toBe('c');
    aliases.set('c', 'b');
    expect(resolveAliasWithLookup('files', 'a', id => aliases.get(id) ?? null)).toBe('a');
    expect(resolveAliasWithLookup('files', 'unknown', id => aliases.get(id) ?? null)).toBe('unknown');
  });
  it('propagates lookup errors unchanged', () => {
    const error = new Error('lookup failed');
    expect(() => resolveAliasWithLookup('files', 'a', () => { throw error; })).toThrow(error);
  });
});
