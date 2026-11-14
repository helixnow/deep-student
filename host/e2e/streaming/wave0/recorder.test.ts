import { expect, it } from 'vitest';
import { CommandError, HandlerPanic, createTestHost, definePlugin } from '../../../kernel/testing.ts';
import type { LaneContract } from '../../../kernel/contract.ts';
import { StreamRecorder } from './recorder.ts';
import { applyRules, candidateRules } from './normalize-candidates.ts';
import { hostDriver, resolvePlaceholders, runScenario } from './runner.ts';
import { parseWireJson } from './wire-json.ts';

function record(take: string, payloadJson: string) {
  const recorder = new StreamRecorder({ scenario: 'c2.raw-integer', side: 'B', take });
  recorder.pullHostEvents([{ kind: 'event', event: 'chat_v2_session_precision',
    payload: JSON.parse(payloadJson), payloadJson, target: { kind: 'Any' } }], 0);
  return recorder.finish();
}

it.each([
  ['9007199254740993', '9007199254740992'],
  ['-9223372036854775808', '-9223372036854775807'],
  ['18446744073709551615', '18446744073709551614'],
  ['1e400', '2e400'], ['-1e400', '-2e400'], ['1e-400', '2e-400'],
  ['1.234567890123456789', '1.234567890123456788'], ['-0', '0'],
])('StreamRecorder → finish → candidateRules distinguishes wire numbers %s / %s', (left, right) => {
  const text = `{"version":${left},"optional":null}`;
  const a = record('B1', text), b = record('B2', `{"version":${right},"optional":null}`);
  expect(a.events[0]!.payloadJson).toBe(text);
  expect(a.events).not.toEqual(b.events);
  const report = candidateRules(a, b);
  expect(report.verdict).toBe('unrepeatable');
  expect(report.candidates).toEqual([]);
  expect(report.unrepeatable).toHaveLength(1);
  expect(report.unrepeatable[0]!.pointer).toBe('/events/0/payload/version');
  // Reports themselves keep JSON numbers, including exponents; never quoted business strings.
  expect(JSON.stringify(report.unrepeatable[0])).toContain(`"a1":${left}`);
  expect(candidateRules(a, record('B-repeat', text)).verdict).toBe('identical');
  // Persist/reload of the record keeps the original wire even though display values are rounded.
  expect(candidateRules(JSON.parse(JSON.stringify(a)), record('B-reload', text)).verdict).toBe('identical');
});

it('keeps null/missing, event/array order/count and late events visible', () => {
  for (const [left, right] of [['{"v":null}', '{}'], ['[1,2]', '[2,1]'], ['[1]', '[1,1]']]) {
    expect(candidateRules(record('B1', left!), record('B2', right!)).verdict).toBe('unrepeatable');
  }
  const recorder = new StreamRecorder({ scenario: 'late', side: 'A', take: 'A1' });
  recorder.push('chat_v2_session_x', null, '{"eventType":"stream_complete"}');
  recorder.push('chat_v2_stream_x', null, '{"chunk":null}');
  recorder.push('chat_v2_stream_x', null, '{}');
  const full = recorder.finish();
  expect(full.events.map(e => [e.index, e.payloadJson])).toEqual([
    [0, '{"eventType":"stream_complete"}'], [1, '{"chunk":null}'], [2, '{}'],
  ]);
  expect(full.terminal).toEqual({ kind: 'stream_complete', indices: [0], eventsAfterFirstTerminal: 2 });
  const reordered = { ...structuredClone(full), take: 'A2' };
  [reordered.events[1], reordered.events[2]] = [reordered.events[2]!, reordered.events[1]!];
  expect(candidateRules(full, reordered).verdict).toBe('unrepeatable');
  reordered.events.pop();
  expect(candidateRules(full, reordered).unrepeatable.some(u => u.pointer === '/events/length')).toBe(true);
});

it('does not fabricate raw text from an A object or an unsafe B object; old takes are unsupported', () => {
  const a = new StreamRecorder({ scenario: 'missing', side: 'A', take: 'A1' });
  a.push('value', { version: 9007199254740992 });
  a.step({ cmd: 'value', args: null, value: undefined, ok: true, eventsBefore: 0, eventsAfter: 1 });
  const one = a.finish(), two = { ...a.finish(), take: 'A2' };
  expect(one.events[0]!.payloadJson).toBeNull();
  expect(one.steps[0]).toMatchObject({ args: null, argsJson: null, value: undefined, valueJson: null });
  expect(candidateRules(one, two)).toMatchObject({ verdict: 'unrepeatable', candidates: [] });
  expect(candidateRules(one, two).unrepeatable.every(u => u.reason.includes('missing raw JSON'))).toBe(true);
  const b = new StreamRecorder({ scenario: 'missing', side: 'B', take: 'B1' });
  b.pullHostEvents([{ kind: 'event', event: 'value', payload: { version: 9007199254740992 }, target: { kind: 'Any' } }], 0);
  expect(b.finish().events[0]!.payloadJson).toBeNull();
  const legacy = record('B1', '{"version":1}');
  Reflect.deleteProperty(legacy.events[0]!, 'payloadJson');
  expect(candidateRules(legacy, { ...structuredClone(legacy), take: 'B2' }).verdict).toBe('unrepeatable');
});

it('snapshots exact BigInt/atom step inputs without changing numbers to strings or erasing null/omission', () => {
  const r = new StreamRecorder({ scenario: 'step', side: 'B', take: 'B1' });
  const value = { i64: -9223372036854775808n, u64: 18446744073709551615n, huge: parseWireJson('1e400'), optional: null, absent: undefined };
  r.step({ cmd: 'exact', args: value, value, ok: false, eventsBefore: 0, eventsAfter: 0 });
  const step = r.finish().steps[0]!;
  const text = '{"i64":-9223372036854775808,"u64":18446744073709551615,"huge":1e400,"optional":null}';
  expect([step.argsJson, step.valueJson]).toEqual([text, text]);
  expect(Object.hasOwn(step.args as object, 'absent')).toBe(false);
  expect((step.args as { optional: unknown }).optional).toBeNull();
  expect(resolvePlaceholders('version=${0.version}', [parseWireJson('{"version":9007199254740993}')], null)).toBe('version=9007199254740993');
});

it('candidate application preserves raw numbers and only changes reviewed token targets in its copy', () => {
  const a = record('B1', '{ "id":"00000000-0000-4000-8000-000000000001", "n":9007199254740993,"huge":1e400,"plain":{"rawJSON":"1e400"}}');
  const b = record('B2', '{ "id":"00000000-0000-4000-8000-000000000002", "n":9007199254740992,"huge":1e400,"plain":{"rawJSON":"1e400"}}');
  const before = JSON.stringify(a);
  const report = candidateRules(a, b);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]).toMatchObject({ kind: 'dynamic-id', c2: 'pending' });
  const x = applyRules(a, report.candidates), y = applyRules(b, report.candidates);
  expect([x.unbound, x.conflicts, y.unbound, y.conflicts]).toEqual([[], [], [], []]);
  expect(x.normalized.events[0]!.payloadJson).toBe('{"id":"<id:1>","n":9007199254740993,"huge":1e400,"plain":{"rawJSON":"1e400"}}');
  expect(JSON.stringify(a)).toBe(before);
  expect(candidateRules(x.normalized, y.normalized)).toMatchObject({ verdict: 'unrepeatable', candidates: [] });
});

it('real kernel → hostDriver → runner keeps args, return, CommandError and events lossless, including result placeholders', async () => {
  const text = '{"i64":-9223372036854775808,"u64":18446744073709551615,"version":9007199254740993,"huge":1e400,"tiny":1e-400,"optional":null}';
  const names = ['x5_precision_ok', 'x5_precision_err'];
  const contract: LaneContract = { lane: 'X5-fixture', generator: 'hand-written fixture', $defs: {}, events: [],
    commands: names.map(name => ({ name, lane: 'X5-fixture', rust: { file: 'fixture.rs', line: 1, fn: name }, async: true,
      args: [{ key: 'value', rustName: 'value', schema: { 'x-rust': 'serde_json::Value' }, optional: false }], injected: [],
      result: { 'x-rust': 'serde_json::Value' }, error: { 'x-rust': 'serde_json::Value' }, frontend: 'none' })),
  };
  const seen: string[] = [];
  const host = await createTestHost({ contracts: { only: [contract] }, plugins: [definePlugin({
    meta: { id: 'x5.precision', commands: names },
    apply(ctx) {
      for (const cmd of names) ctx.commands.register(cmd, args => {
        seen.push(JSON.stringify(args.value));
        ctx.backendEvents.emit('chat_v2_session_precision', args.value);
        if (cmd === 'x5_precision_err') throw new CommandError(args.value);
        return args.value;
      });
    },
  })] });
  try {
    const driver = hostDriver({ ...host, ctx: { chatState: { shutdownTasks: async () => true } } });
    const scenario = { id: 'precision-chain', seed: 'empty', steps: [
      { cmd: names[0]!, args: { value: parseWireJson(text) } },
      { cmd: names[1]!, args: { value: '${0}' } },
    ] };
    const one = await runScenario(scenario, driver, { side: 'B', take: 'B1', llm: null });
    const two = await runScenario(scenario, driver, { side: 'B', take: 'B2', llm: null });
    expect(seen).toEqual([text, text, text, text]);
    expect(one.steps.map(s => [s.ok, s.argsJson, s.valueJson])).toEqual([
      [true, `{"value":${text}}`, text], [false, `{"value":${text}}`, text],
    ]);
    expect(one.events.map(e => e.payloadJson)).toEqual([text, text]);
    expect(one.steps.map(s => [s.eventsBefore, s.eventsAfter])).toEqual([[0, 1], [1, 2]]);
    expect(candidateRules(one, two).verdict).toBe('identical');
    const changed = await runScenario({ ...scenario, steps: [{ cmd: names[0]!, args: { value: parseWireJson(text.replace('9007199254740993', '9007199254740992')) } }, scenario.steps[1]!] },
      driver, { side: 'B', take: 'B3', llm: null });
    const report = candidateRules(one, changed);
    expect(report.candidates).toEqual([]);
    expect(report.unrepeatable.map(u => u.pointer)).toEqual([
      '/events/0/payload/version', '/events/1/payload/version',
      '/steps/0/args/value/version', '/steps/0/value/version', '/steps/1/args/value/version', '/steps/1/value/version',
    ]);
  } finally { await host.dispose(); }
});

it('hostDriver.invokeWire carries the production internal-error reply on a handler panic (RF-W01-panic-replies-internal-error)', async () => {
  const contract = { lane: 'X5-fixture', generator: 'hand-written fixture', events: [],
    commands: [{ name: 'x5_panics', lane: 'X5-fixture', rust: { file: 'fixture.rs', line: 1, fn: 'x5_panics' }, async: true,
      args: [], injected: [], result: { 'x-rust': 'serde_json::Value' },
      error: { 'x-rust': 'AppError', $ref: '#/$defs/AppError' }, frontend: 'none' }],
    $defs: { AppError: { type: 'object' } },
  } as unknown as LaneContract;
  const host = await createTestHost({ contracts: { only: [contract] }, plugins: [definePlugin({
    meta: { id: 'x5.panics', commands: ['x5_panics'] },
    apply(ctx) { ctx.commands.register('x5_panics', () => { throw new Error('boom'); }); },
  })] });
  try {
    const driver = hostDriver({ ...host, ctx: { chatState: { shutdownTasks: async () => true } } });
    expect(driver.invokeWire).toBeDefined();
    const thrown = await driver.invokeWire!('x5_panics', {}).then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(HandlerPanic);
    const expected = await host.invoke('x5_panics', {}).then(() => null, (error: unknown) => (error as HandlerPanic).reply);
    expect(expected).not.toBeUndefined();
    expect((thrown as HandlerPanic).reply).toEqual(expected);
  } finally { await host.dispose(); }
});
