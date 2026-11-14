import { describe, expect, it } from 'vitest';
import { definePlugin } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import type { JsonSchema } from '../contract.ts';
import { createTestHost } from '../testing.ts';

const ALSO = 'externally tagged map form {"<Variant>": null}';
const mode = { type: 'string', enum: ['A', 'B'], 'x-rust': 'test::Mode', 'x-also-accepts': ALSO };
/** What scripts/electron-migration/contracts/lib/schema.ts:867-871 emits for every `__De` unit enum in contracts/ipc. */
const modeDe = {
  oneOf: [{ type: 'string', enum: ['A', 'B'] }, ...['A', 'B'].map(n => ({ type: 'object', properties: { [n]: { type: 'null' } }, required: [n], additionalProperties: false }))],
  'x-rust': 'test::Mode', 'x-also-accepts': ALSO,
};
function contract(schema: JsonSchema) {
  const set = new ContractSet([{ file: 'test.json', contract: { lane: 'test', generator: 'test', commands: [{
    name: 'test', lane: 'test', rust: { file: 'test.rs', line: 1, fn: 'test' }, async: false, injected: [], frontend: 'none',
    args: [{ key: 'value', rustName: 'value', optional: false, schema }], result: mode,
  }], events: [], $defs: { Mode: mode, Mode__De: modeDe } } }]);
  return { check: (value: unknown) => set.checkArgs(set.get('test')!, { value }), set };
}

describe.each([['flat enum', 'Mode', mode], ['generator oneOf', 'Mode__De', modeDe]] as const)('unit enum, %s shape', (_, def, schema) => {
  it('accepts unit enum map form and hands handlers the canonical variant', () => {
    const { check, set } = contract({ $ref: `#/$defs/${def}` });
    expect(check({ A: null })).toEqual({ ok: true, args: { value: 'A' } });
    expect(check('B')).toEqual({ ok: true, args: { value: 'B' } });
    expect(set.checkResult(set.get('test')!, { A: null })).not.toBeNull();
    const nested = contract({ type: 'object', properties: { modes: { type: 'array', items: { anyOf: [{ $ref: `#/$defs/${def}` }, { type: 'null' }] } } } });
    expect(nested.check({ modes: [{ B: null }, null, 'A'] })).toEqual({ ok: true, args: { value: { modes: ['B', null, 'A'] } } });
  });
  it('retains serde errors for malformed enum maps', () => {
    const { check } = contract(schema);
    for (const value of [{}, { A: null, B: null }]) expect(check(value)).toEqual({ ok: false, error: 'invalid args `value` for command `test`: invalid value: map, expected map with a single key' });
    expect(check({ A: 1 })).toEqual({ ok: false, error: 'invalid args `value` for command `test`: invalid type: number, expected unit' });
    expect(check({ C: null })).toEqual({ ok: false, error: 'invalid args `value` for command `test`: unknown variant `C`, expected `A` or `B`' });
    expect(check('C')).toEqual({ ok: false, error: 'invalid args `value` for command `test`: unknown variant `C`, expected `A` or `B`' });
    expect(check(5)).toEqual({ ok: false, error: 'invalid args `value` for command `test`: invalid type: number, expected string or map' });
    expect(check(true)).toEqual({ ok: false, error: 'invalid args `value` for command `test`: invalid type: boolean `true`, expected string or map' });
  });
});

it('leaves near-miss oneOf shapes (serde(other), mismatched branches) to ajv', () => {
  const other = { ...modeDe, oneOf: [{ type: 'string' }, ...modeDe.oneOf.slice(1)] };
  const extraBranch = { ...modeDe, oneOf: [...modeDe.oneOf, { type: 'object', properties: { C: { type: 'string' } }, required: ['C'], additionalProperties: false }] };
  for (const schema of [other, extraBranch]) {
    const result = contract(schema).check(5);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toContain('expected string or map');
  }
});

it('qbank_create_question (W03 handoff): enum args decode and fail like serde on the real contract', async () => {
  let seen: unknown;
  const host = await createTestHost({
    plugins: [definePlugin({ meta: { id: 'probe.qbank', commands: ['qbank_create_question'] }, apply(ctx) {
      ctx.commands.register('qbank_create_question', (args) => { seen = (args as { params: { question_type?: unknown; difficulty?: unknown } }).params; throw new Error('stop'); });
    } })],
  });
  try {
    const call = (extra: Record<string, unknown>) => host.invoke('qbank_create_question', { params: { exam_id: 'e', content: 'c', ...extra } });
    await expect(call({ question_type: { essay: null }, difficulty: { very_hard: null } })).rejects.toMatchObject({ name: 'HandlerPanic' });
    expect(seen).toMatchObject({ question_type: 'essay', difficulty: 'very_hard' });
    const prefix = 'invalid args `params` for command `qbank_create_question`: ';
    const questionTypes = '`single_choice`, `multiple_choice`, `indefinite_choice`, `fill_blank`, `short_answer`, `essay`, `calculation`, `proof`, `true_false`, `matching`, `ordering`, `numeric`, `other`';
    await expect(call({ question_type: 'bogus' })).rejects.toBe(`${prefix}unknown variant \`bogus\`, expected one of ${questionTypes}`);
    await expect(call({ question_type: { bogus: null } })).rejects.toBe(`${prefix}unknown variant \`bogus\`, expected one of ${questionTypes}`);
    await expect(call({ difficulty: 'bogus' })).rejects.toBe(`${prefix}unknown variant \`bogus\`, expected one of \`easy\`, \`medium\`, \`hard\`, \`very_hard\``);
    await expect(call({ question_type: { essay: 1 } })).rejects.toBe(`${prefix}invalid type: number, expected unit`);
    await expect(call({ question_type: { essay: null, proof: null } })).rejects.toBe(`${prefix}invalid value: map, expected map with a single key`);
    await expect(call({ source_type: 5 })).rejects.toBe(`${prefix}invalid type: number, expected string or map`);
  } finally {
    await host.dispose();
  }
});
