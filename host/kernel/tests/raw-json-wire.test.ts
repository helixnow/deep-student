import { expect, it } from 'vitest';
import { CommandError, definePlugin } from '../api.ts';
import { createTestHost } from '../testing.ts';
import { findNonJson, toWireJson } from '../json.ts';
import type { LaneContract } from '../contract.ts';

const nativeJson = JSON as typeof JSON & {
  rawJSON(text: string): Readonly<{ rawJSON: string }>;
  isRawJSON(value: unknown): boolean;
};
const tokens = ['9007199254740993', '1.234567890123456789', '1e400', '-1e400', '1e-400', '-1e-400', '-0'];
const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written fixture', $defs: {}, commands: [{
    name: 'fixture_raw', lane: 'F1-fixture', rust: { file: 'fixture.rs', line: 1, fn: 'fixture_raw' },
    async: true, args: [], injected: [],
    result: { 'x-rust': 'serde_json::Value' }, error: { 'x-rust': 'serde_json::Value' }, frontend: 'none',
  }], events: [],
};

it.each([true, false])('F1-RAWJSON-01 projects native atoms at real command/error/event exits (debug=%s)', async debug => {
  const atoms = tokens.map(token => nativeJson.rawJSON(token));
  const plain = { rawJSON: '1e400' };
  const nullProto = Object.assign(Object.create(null), { rawJSON: '1e400' });
  const value = Object.freeze({ question: { numbers: atoms }, plain, nullProto });
  const seen: unknown[] = [];
  let reject = false;
  const plugin = definePlugin({
    meta: { id: 'fixture.raw', commands: ['fixture_raw'] },
    apply(ctx) {
      ctx.backendEvents.listen('question-import-progress', payload => seen.push(payload));
      ctx.commands.register('fixture_raw', () => {
        ctx.backendEvents.emit('question-import-progress', value);
        if (reject) throw new CommandError(value);
        return value;
      });
    },
  });
  const host = await createTestHost({ plugins: [plugin], contracts: { only: [contract] }, app: { debug } });
  const expected = { question: { numbers: tokens.map(token => JSON.parse(token)) }, plain, nullProto: { ...nullProto } };
  try {
    expect(findNonJson(value)).toBeNull();
    expect(toWireJson(value)).toEqual(expected);
    expect(findNonJson(Infinity)).toContain('non-finite');
    const result = await host.invoke<typeof expected>('fixture_raw');
    expect(result).toEqual(expected);
    expect(result.question.numbers.every(number => typeof number === 'number')).toBe(true);
    expect(Object.is(result.question.numbers[5], -0)).toBe(true);
    expect(host.eventsNamed('question-import-progress')).toEqual([expected]);
    reject = true;
    await expect(host.invoke('fixture_raw')).rejects.toEqual(expected);
    expect(seen).toEqual([value, value]);
    expect(seen[0]).toBe(value);
    expect(atoms.map(atom => atom.rawJSON)).toEqual(tokens);
    expect(atoms.every(atom => nativeJson.isRawJSON(atom))).toBe(true);
    expect(nativeJson.isRawJSON(plain)).toBe(false);
    expect(nativeJson.isRawJSON(nullProto)).toBe(false);
  } finally { await host.dispose(); }
});

it.each([true, false])('F1-RAWJSON-02 carries one source-preserving JSON text for mixed result/error/event (debug=%s)', async debug => {
  const raw = nativeJson.rawJSON('1e400');
  const negativeZero = nativeJson.rawJSON('-0');
  const value = { raw, typed: Infinity, nan: NaN, nested: [negativeZero, 9007199254740993n], plain: { rawJSON: '1e400' } };
  const text = '{"raw":1e400,"typed":null,"nan":null,"nested":[-0,9007199254740993],"plain":{"rawJSON":"1e400"}}';
  let reject = false;
  const seen: unknown[] = [];
  const host = await createTestHost({ contracts: { only: [contract] }, app: { debug }, plugins: [definePlugin({
    meta: { id: 'fixture.raw-source', commands: ['fixture_raw'] },
    apply(ctx) {
      ctx.backendEvents.listen('question-import-progress', payload => seen.push(payload));
      ctx.commands.register('fixture_raw', () => {
        ctx.backendEvents.emit('question-import-progress', value);
        if (reject) throw new CommandError(value);
        return value;
      });
    },
  })] });
  try {
    const request = { id: 'raw-source', cmd: 'fixture_raw', args: {}, source: { window: 'main', webview: 'main' } };
    expect(await host.runtime.dispatchInvoke(request)).toEqual({ kind: 'ok', value: JSON.parse(text), json: text });
    reject = true;
    expect(await host.runtime.dispatchInvoke(request)).toEqual({ kind: 'err', error: JSON.parse(text), json: text });
    for (const event of host.events.filter(event => event.event === 'question-import-progress')) {
      expect(event).toMatchObject({ payload: JSON.parse(text), payloadJson: text, target: { kind: 'Any' } });
    }
    expect(seen).toEqual([value, value]);
    expect(seen[0]).toBe(value);
    expect(value.raw).toBe(raw);
    expect(value.typed).toBe(Infinity);
    expect(value.nested[1]).toBe(9007199254740993n);
    host.ctx.backendEvents.emit('ordinary-lookalike', { rawJSON: '1e400' });
    expect(Object.hasOwn(host.events.at(-1)!, 'payloadJson')).toBe(false);
  } finally { await host.dispose(); }
});
