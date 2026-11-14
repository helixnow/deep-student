import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { CommandError, definePlugin } from '../api.ts';
import * as json from '../json.ts';
import { ContractSet } from '../contracts.ts';
import { createTestHost } from '../testing.ts';

it.each([true, false])('F1-JSON-OWNKEY-01 preserves JSON own keys at command/event exits (debug=%s)', async debug => {
  // JSON text creates a data property here; an object-literal __proto__ would test a
  // different input. Internal values stay exact, only the existing wire-copy converts.
  const value = JSON.parse('{"before":1,"__proto__":{"cursor":0},"constructor":"kept","after":2}') as Record<string, unknown>;
  const inner = value['__proto__'] as { cursor: bigint };
  inner.cursor = 9007199254740993n;
  Object.freeze(inner); Object.freeze(value);
  const seen: unknown[] = [];
  const plugin = definePlugin({
    meta: { id: 'fixture.own-keys', commands: ['fixture_echo'] },
    apply(ctx) {
      ctx.backendEvents.listen('fixture-own-keys', payload => seen.push(payload));
      ctx.commands.register('fixture_echo', () => {
        ctx.backendEvents.emit('fixture-own-keys', value);
        return value;
      });
    },
  });
  const contracts = ContractSet.fromDirectory(fileURLToPath(new URL('../__fixtures__/contracts/', import.meta.url)));
  const host = await createTestHost({ plugins: [plugin], contracts, app: { debug } });
  try {
    const result = await host.invoke<Record<string, unknown>>('fixture_echo', { value: null });
    const event = host.eventsNamed('fixture-own-keys')[0] as Record<string, unknown>;
    for (const wire of [result, event]) {
      expect(Object.keys(wire)).toEqual(['before', '__proto__', 'constructor', 'after']);
      expect(Object.hasOwn(wire, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(wire, '__proto__')).toMatchObject({
        enumerable: true, value: { cursor: 9007199254740992 },
      });
      expect(Object.getPrototypeOf(wire)).toBe(Object.prototype);
      expect(wire.constructor).toBe('kept');
      expect(wire).not.toBe(value);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(value);
    expect(inner.cursor).toBe(9007199254740993n);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  } finally { await host.dispose(); }
});

it.each([false, true])('validates internal command values before wire projection (reject=%s)', async reject => {
  class PretendJson { toJSON() { throw new Error('class toJSON must not be invoked'); } }
  const value = new PretendJson();
  const plugin = definePlugin({
    meta: { id: 'fixture.non-json', commands: ['fixture_echo'] },
    apply(ctx) { ctx.commands.register('fixture_echo', () => { if (reject) throw new CommandError(value); return value; }); },
  });
  const contracts = ContractSet.fromDirectory(fileURLToPath(new URL('../__fixtures__/contracts/', import.meta.url)));
  const host = await createTestHost({ plugins: [plugin], contracts });
  const project = vi.spyOn(json, 'toWireJson'); // Calls the production function; no replacement implementation.
  try {
    await expect(host.invoke('fixture_echo', { value: null })).rejects.toMatch(/only plain objects/);
    expect(project).not.toHaveBeenCalled();
    expect(() => host.ctx.backendEvents.emit('fixture-non-json', value)).toThrow('not plain JSON');
    expect(project).not.toHaveBeenCalled();
  } finally { project.mockRestore(); await host.dispose(); }
});

it.each([true, false])('preserves CommandError BigInt values until the reject wire boundary (debug=%s)', async debug => {
  const value = Object.freeze({ code: 'E1', message: 'cursor conflict', cursor: 9007199254740993n });
  const error = new CommandError(value);
  const plugin = definePlugin({
    meta: { id: 'fixture.bigint-error', commands: ['fixture_struct'] },
    apply(ctx) { ctx.commands.register('fixture_struct', () => { throw error; }); },
  });
  const contracts = ContractSet.fromDirectory(fileURLToPath(new URL('../__fixtures__/contracts/', import.meta.url)));
  const host = await createTestHost({ plugins: [plugin], contracts, app: { debug } });
  try {
    await expect(host.invoke('fixture_struct', { request: { title: 'x', count: 1 }, mode: 'fast' }))
      .rejects.toEqual({ code: 'E1', message: 'cursor conflict', cursor: 9007199254740992 });
    expect(error.value).toBe(value);
    expect(value.cursor).toBe(9007199254740993n);
  } finally { await host.dispose(); }
});
