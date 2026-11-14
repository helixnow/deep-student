import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { StreamEvent } from '../api.ts';
import { cloneProviderToolCall, stringifyProviderToolCall } from '../api.ts';
import { isJsonFloat, parseJsonLossless } from '../../sync/api.ts';
import plugin from '../index.ts';

async function host() {
  return createTestHost({ plugins: [plugin], provide: { settings: { async getSecret() { return null; } } }, app: { version: '0.11.0' } });
}

function toolArguments(events: StreamEvent[]): string {
  const call = events.find(event => event.type === 'ToolCall');
  if (call?.type !== 'ToolCall' || call.value === null || typeof call.value !== 'object' || Array.isArray(call.value)) throw new Error('no ToolCall');
  const fn = call.value.function;
  if (fn === null || typeof fn !== 'object' || Array.isArray(fn) || typeof fn.arguments !== 'string') throw new Error('no serialized arguments');
  return fn.arguments;
}

it('anthropic partial_json serializes arbitrary_precision numbers like Rust, not a repaired Number or verbatim source', async () => {
  const h = await host();
  try {
    const adapter = h.ctx.llmAdapters.createAdapter('anthropic');
    expect(adapter.parseStream('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"f","input":{}}}')).toEqual([]);
    const partial = ' { "n":9007199254740993,"f":1.0,"e":1E0,"z":-0,"nested":[18446744073709551615,1e400],"a":1,"a":2 } ';
    for (const fragment of [partial.slice(0, 28), partial.slice(28)]) {
      expect(adapter.parseStream(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: fragment } })}`)).toEqual([]);
    }
    const output = adapter.parseStream('data: {"type":"content_block_stop","index":0}');
    expect(toolArguments(output)).toBe('{"n":9007199254740993,"f":1.0,"e":1e+0,"z":0,"nested":[18446744073709551615,1e+400],"a":2}');
    expect(adapter.parseStream('data: {"type":"content_block_stop","index":0}')).toEqual([]);
  } finally { await h.dispose(); }
});

it('anthropic baseInput preserves nested and scalar numeric types when no partial JSON is present', async () => {
  const h = await host();
  try {
    for (const [input, expected] of [
      ['{"n":9007199254740993,"f":1.0,"e":1e0}', '{"n":9007199254740993,"f":1.0,"e":1e+0}'],
      ['1.0', '1.0'], ['1E0', '1e+0'], ['9007199254740993', '9007199254740993'], ['null', 'null'],
    ]) {
      const adapter = h.ctx.llmAdapters.createAdapter('anthropic');
      adapter.parseStream(`data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"f","input":${input}}}`);
      expect(toolArguments(adapter.parseStream('data: {"type":"content_block_stop","index":0}'))).toBe(expected);
    }
  } finally { await h.dispose(); }
});

it('anthropic scalar partial_json keeps its numeric variant rather than falling back to a rounded root Number', async () => {
  const h = await host();
  try {
    for (const [partial, expected] of [['1.0', '1.0'], ['1E0', '1e+0'], ['9007199254740993', '9007199254740993'], ['-0', '0'], ['null', 'null']]) {
      const adapter = h.ctx.llmAdapters.createAdapter('anthropic');
      adapter.parseStream('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"f","input":{"ignored":true}}}');
      adapter.parseStream(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })}`);
      expect(toolArguments(adapter.parseStream('data: {"type":"content_block_stop","index":0}'))).toBe(expected);
    }
  } finally { await h.dispose(); }
});

it('anthropic retains malformed/empty-buffer fallback and signature-before-tool ordering', async () => {
  const h = await host();
  try {
    const adapter = h.ctx.llmAdapters.createAdapter('anthropic');
    const start = (input: string) => adapter.parseStream(`data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"f"${input}}}`);
    const delta = (partial: string) => adapter.parseStream(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })}`);
    const stop = () => adapter.parseStream('data: {"type":"content_block_stop","index":0}');
    start(',"input":{"n":9}'); delta('{');
    expect(toolArguments(stop())).toBe('{}'); // Nonempty invalid buffer does not fall back to baseInput.
    start(''); expect(toolArguments(stop())).toBe('{}');
    start(',"input":null'); delta(' \n\t'); expect(toolArguments(stop())).toBe('null');
    start(',"input":{}'); delta('null'); expect(toolArguments(stop())).toBe('null');
    start(',"input":{"n":9007199254740993}');
    adapter.parseStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}');
    const ordered = stop();
    expect(ordered[0]).toEqual({ type: 'ThoughtSignature', value: 'sig' });
    expect(ordered[1]?.type).toBe('ToolCall');
  } finally { await h.dispose(); }
});

it('openai standard arguments strings are forwarded without parse or normalization', async () => {
  const h = await host();
  try {
    for (const argumentsText of [' {"n":9007199254740993,"f":1.0,"e":1E0} ', '{invalid']) {
      const adapter = h.ctx.llmAdapters.createAdapter('openai');
      const [event] = adapter.parseStream(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: argumentsText } }] } }] })}`);
      expect(toolArguments([event!])).toBe(argumentsText);
    }
  } finally { await h.dispose(); }
});

it('openai nonstandard object arguments retain numeric facts through the public Host handoff seam', async () => {
  const h = await host();
  try {
    const adapter = h.ctx.llmAdapters.createAdapter('openai');
    const [event] = adapter.parseStream('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":{"n":9007199254740993,"f":1.0,"e":1E0,"z":-0,"nested":[18446744073709551615,1e400]}}}]}}]}');
    if (event?.type !== 'ToolCall') throw new Error('no ToolCall');
    const serialized = stringifyProviderToolCall(cloneProviderToolCall(event.value));
    expect(serialized).toBe('{"index":0,"id":"c","function":{"name":"f","arguments":{"n":9007199254740993,"f":1.0,"e":1e+0,"z":0,"nested":[18446744073709551615,1e+400]}}}');
    // Consumers can now use the existing shared lossless parser; no new JSON type is invented.
    const decoded = parseJsonLossless(serialized) as { function: { arguments: { n: bigint; f: unknown; e: unknown } } };
    expect(decoded.function.arguments.n).toBe(9007199254740993n);
    expect(isJsonFloat(decoded.function.arguments.f)).toBe(true);
    expect(isJsonFloat(decoded.function.arguments.e)).toBe(true);
    const copied = cloneProviderToolCall(event.value);
    expect(copied).not.toBe(event.value);
    expect(stringifyProviderToolCall(event.value)).toBe(serialized);
  } finally { await h.dispose(); }
});
