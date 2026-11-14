import { expect, it } from 'vitest';
import { orderForProfile } from '../profile.ts';
import { definePlugin } from '../api.ts';

const entry = (id: string, inject: string[], provides: string[]) => ({ plugin: definePlugin({ meta: { id, provides }, inject, apply() {} }) });
it('orders providers before consumers while preserving independent profile order', () => {
  const a = entry('a', ['b'], []), b = entry('b', ['root'], ['b']), c = entry('c', [], []);
  expect(orderForProfile([a, b, c])).toEqual([b, a, c]);
});
it('keeps entries whose services nobody provides in stable order instead of rejecting them', () => {
  const missing = entry('a', ['missing'], []), independent = entry('b', [], []);
  expect(orderForProfile([missing, independent])).toEqual([missing, independent]);
});
it('rejects duplicate providers and cycles before applying plugins', () => {
  expect(() => orderForProfile([entry('a', ['b'], ['a']), entry('b', ['a'], ['b'])])).toThrow('dependency cycle');
  expect(() => orderForProfile([entry('a', [], ['x']), entry('b', [], ['x'])])).toThrow('provided by both');
});
