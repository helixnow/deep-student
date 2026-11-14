import { describe, expect, it } from 'vitest';
import type { ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { JsonValue } from '../api.ts';
import { accumulate, fromApi, fromApiWithCache, fromEstimate, hasTokens, parseApiUsage } from '../src/token-usage.ts';
import { assignFinalRoundReasoningItems, assignToolRoundReasoningItems, freezeToolFaceForPromptCache,
  freezeToolSchemaOrderForPromptCache, freezeToolSchemasForPromptCache, mergeFrozenToolSchemaOrderBaseline,
  mergeRoundResultsInCallOrder, requiredFieldsForEmptyToolCall, RESPONSES_FINAL_REASONING_KEY,
  retainFailedRoundUsage, sortToolSchemasForPromptCache, toolSchemaDigest, toolSchemaSortKey } from '../src/tool-face.ts';

const schema = (name: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'function', function: { name, ...extra } });
const bytes = (value: unknown) => JSON.stringify(value);
const result = (id: string, error: string | null): ToolResultInfo => ({
  toolCallId: id, blockId: null, toolName: 'tool', input: {}, output: {}, success: error === null,
  error, durationMs: null, reasoningContent: null, thoughtSignature: null,
});

describe('llm_adapter.rs::parse_api_usage', () => {
  it('test_parse_api_usage_openai_format', () => {
    const usage = parseApiUsage({ prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 })!;
    expect(usage.promptTokens).toBe(1234);
    expect(usage.completionTokens).toBe(567);
    expect(usage.totalTokens).toBe(1801);
    expect(usage.source).toBe('api');
    expect(usage.reasoningTokens).toBeUndefined();
    expect(usage.cachedTokens).toBeUndefined();
  });
  it('test_parse_api_usage_anthropic_format', () => {
    const usage = parseApiUsage({ input_tokens: 1234, output_tokens: 567,
      cache_read_input_tokens: 100, cache_creation_input_tokens: 50 })!;
    expect(usage.promptTokens).toBe(1234);
    expect(usage.completionTokens).toBe(567);
    expect(usage.totalTokens).toBe(1801);
    expect(usage.source).toBe('api');
    expect(usage.cachedTokens).toBe(100);
    expect(usage.cacheWriteTokens).toBe(50);
  });
  it('test_parse_api_usage_deepseek_format', () => {
    const usage = parseApiUsage({ prompt_tokens: 1234, completion_tokens: 567, reasoning_tokens: 200 })!;
    expect(usage.totalTokens).toBe(1801);
    expect(usage.reasoningTokens).toBe(200);
  });
  it('test_parse_api_usage_invalid_format', () => {
    expect(parseApiUsage({ invalid_field: 123 })).toBeNull();
  });
  it('test_parse_api_usage_partial_openai', () => {
    const usage = parseApiUsage({ prompt_tokens: 1000 })!;
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(0);
  });
  it('test_parse_api_usage_anthropic_cache_read', () => {
    expect(parseApiUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 800 })!.cachedTokens).toBe(800);
  });
  it('test_parse_api_usage_responses_format', () => {
    const usage = parseApiUsage({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500,
      input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
      output_tokens_details: { reasoning_tokens: 90 } })!;
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(300);
    expect(usage.cachedTokens).toBe(1024);
    expect(usage.cacheWriteTokens).toBe(128);
    expect(usage.reasoningTokens).toBe(90);
  });
  it('test_parse_api_usage_gateway_duplicate_cache_uses_max', () => {
    expect(parseApiUsage({ prompt_tokens: 2000, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 1024 }, input_tokens_details: { cached_tokens: 1024 } })!.cachedTokens).toBe(1024);
  });
  it('test_parse_api_usage_anthropic_cache_write', () => {
    const usage = parseApiUsage({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 500 })!;
    expect(usage.cachedTokens).toBeUndefined();
    expect(usage.cacheWriteTokens).toBe(500);
  });
  it('test_parse_api_usage_preserves_observed_zero_cache_values', () => {
    const measured = parseApiUsage({ input_tokens: 10, output_tokens: 20,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })!;
    expect(measured.cachedTokens).toBe(0);
    expect(measured.cacheWriteTokens).toBe(0);
    const unmeasured = parseApiUsage({ input_tokens: 10, output_tokens: 20 })!;
    expect(unmeasured.cachedTokens).toBeUndefined();
    expect(unmeasured.cacheWriteTokens).toBeUndefined();
  });
  it('test_token_usage_serialization_camel_case', () => {
    const json = JSON.stringify(fromApi(1000, 500, 200));
    expect(json).toContain('"promptTokens":1000');
    expect(json).toContain('"completionTokens":500');
    expect(json).toContain('"totalTokens":1500');
    expect(json).toContain('"source":"api"');
    expect(json).toContain('"reasoningTokens":200');
  });
  it('test_token_usage_accumulate', () => {
    const usage = fromApi(1000, 500, null);
    accumulate(usage, fromApi(800, 300, 100));
    expect(usage.promptTokens).toBe(1800);
    expect(usage.completionTokens).toBe(800);
    expect(usage.totalTokens).toBe(2600);
    expect(usage.source).toBe('api');
    expect(usage.reasoningTokens).toBe(100);
  });
  it('test_token_usage_accumulate_mixed_source', () => {
    const usage = fromApi(1000, 500, null);
    accumulate(usage, fromEstimate(800, 300, true));
    expect(usage.promptTokens).toBe(1800);
    expect(usage.source).toBe('mixed');
  });
  it('test_token_source_display', () => {
    expect(fromApi(1, 1, null).source).toBe('api');
    expect(fromEstimate(1, 1, true).source).toBe('tiktoken');
    expect(fromEstimate(1, 1, false).source).toBe('heuristic');
    const mixed = fromApi(1, 1, null); accumulate(mixed, fromEstimate(1, 1, true));
    expect(mixed.source).toBe('mixed');
  });
  it('test_token_usage_from_estimate_tiktoken', () => {
    const usage = fromEstimate(1000, 500, true);
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(500);
    expect(usage.totalTokens).toBe(1500);
    expect(usage.source).toBe('tiktoken');
  });
  it('test_token_usage_from_estimate_heuristic', () => {
    const usage = fromEstimate(1000, 500, false);
    expect(usage.source).toBe('heuristic');
  });
  it('test_token_usage_has_tokens', () => {
    expect(hasTokens(fromApi(1, 0, null))).toBe(true);
    expect(hasTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'api' })).toBe(false);
  });
  it('keeps u64 semantics and saturating totals', () => {
    expect(parseApiUsage({ prompt_tokens: 4_294_967_297 })).toMatchObject({ promptTokens: 1, completionTokens: 0 });
    expect(parseApiUsage({ prompt_tokens: -1 })).toBeNull();
    expect(parseApiUsage({ prompt_tokens: 1.5, completion_tokens: 2 })).toMatchObject({ promptTokens: 0, completionTokens: 2 });
    expect(fromApi(4_294_967_295, 10, null).totalTokens).toBe(4_294_967_295);
  });
});

describe('tool_loop.rs::tests (tool face)', () => {
  it('tool_schema_sort_key_reads_function_name_and_falls_back_to_top_level', () => {
    expect(toolSchemaSortKey({ type: 'function', function: { name: 'builtin-web_search' } })).toBe('builtin-web_search');
    expect(toolSchemaSortKey({ name: 'legacy_tool' })).toBe('legacy_tool');
    expect(toolSchemaSortKey({ type: 'function' })).toBe('');
  });
  it('empty_tool_call_is_invalid_only_when_its_schema_has_required_fields', () => {
    const schemas = new Map<string, unknown>([
      ['needs_command', { type: 'function', function: { name: 'needs_command',
        parameters: { type: 'object', required: ['command'] } } }],
      ['no_args', { type: 'function', function: { name: 'no_args', parameters: { type: 'object', properties: {} } } }],
    ]);
    expect(requiredFieldsForEmptyToolCall({ name: 'needs_command', arguments: {} }, schemas)).toEqual(['command']);
    expect(requiredFieldsForEmptyToolCall({ name: 'no_args', arguments: {} }, schemas)).toBeNull();
    expect(requiredFieldsForEmptyToolCall({ name: 'needs_command', arguments: { command: 'pwd' } }, schemas)).toBeNull();
  });
  it('tool_schema_sort_orders_openai_function_schemas_deterministically', () => {
    const tools = [schema('zeta'), { name: 'mid_legacy' }, schema('alpha')];
    sortToolSchemasForPromptCache(tools);
    expect(tools.map(toolSchemaSortKey)).toEqual(['alpha', 'mid_legacy', 'zeta']);
    const before = structuredClone(tools);
    sortToolSchemasForPromptCache(tools);
    expect(tools).toEqual(before);
  });
  it('frozen_tool_order_appends_new_tools_without_touching_sent_prefix', () => {
    const frozen: string[] = [];
    const tools = [schema('zeta_tool', { description: 'B' }), schema('alpha_tool', { description: 'A' })];
    freezeToolSchemaOrderForPromptCache(tools, frozen);
    expect(tools.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'zeta_tool']);
    const sent = tools.map(bytes);
    tools.push(schema('beta_tool'));
    freezeToolSchemaOrderForPromptCache(tools, frozen);
    expect(tools.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
    sent.forEach((expected, index) => expect(bytes(tools[index])).toBe(expected));
  });
  it('frozen_tool_order_survives_full_rebuild_and_stays_idempotent', () => {
    const frozen: string[] = [];
    const tools = [schema('zeta_tool'), schema('mid_tool')];
    freezeToolSchemaOrderForPromptCache(tools, frozen);
    expect(frozen).toEqual(['mid_tool', 'zeta_tool']);
    const rebuilt = [schema('delta_tool'), schema('zeta_tool'), schema('aardvark_tool'), schema('mid_tool')];
    freezeToolSchemaOrderForPromptCache(rebuilt, frozen);
    expect(rebuilt.map(toolSchemaSortKey)).toEqual(['mid_tool', 'zeta_tool', 'aardvark_tool', 'delta_tool']);
    expect(frozen).toEqual(['mid_tool', 'zeta_tool', 'aardvark_tool', 'delta_tool']);
    const before = structuredClone(rebuilt);
    freezeToolSchemaOrderForPromptCache(rebuilt, frozen);
    expect(rebuilt).toEqual(before);
    expect(frozen).toEqual(['mid_tool', 'zeta_tool', 'aardvark_tool', 'delta_tool']);
  });
  it('frozen_tool_order_persists_across_turns_via_session_baseline', () => {
    const sessionBaseline: string[] = [];
    const turn1Local = [...sessionBaseline];
    const turn1Tools = [schema('zeta_tool', { description: 'Z' }), schema('alpha_tool', { description: 'A' })];
    freezeToolSchemaOrderForPromptCache(turn1Tools, turn1Local);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, turn1Local);
    const sent = turn1Tools.map(bytes);
    expect(sessionBaseline).toEqual(['alpha_tool', 'zeta_tool']);

    const turn2Local = [...sessionBaseline];
    const turn2Tools = [schema('beta_tool', { description: 'B' }), schema('zeta_tool', { description: 'Z' }),
      schema('alpha_tool', { description: 'A' })];
    freezeToolSchemaOrderForPromptCache(turn2Tools, turn2Local);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, turn2Local);
    expect(turn2Tools.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
    sent.forEach((expected, index) => expect(bytes(turn2Tools[index])).toBe(expected));
    expect(sessionBaseline).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);

    const turn3Local = [...sessionBaseline];
    const turn3Tools = [schema('beta_tool', { description: 'B' }), schema('alpha_tool', { description: 'A' })];
    freezeToolSchemaOrderForPromptCache(turn3Tools, turn3Local);
    mergeFrozenToolSchemaOrderBaseline(sessionBaseline, turn3Local);
    expect(turn3Tools.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'beta_tool']);
    expect(sessionBaseline).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
  });
  it('session_baseline_merge_is_append_only_across_parallel_variants', () => {
    const shared = ['alpha_tool', 'zeta_tool'];
    mergeFrozenToolSchemaOrderBaseline(shared, ['alpha_tool', 'zeta_tool', 'beta_tool']);
    expect(shared).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
    mergeFrozenToolSchemaOrderBaseline(shared, ['alpha_tool', 'zeta_tool']);
    expect(shared).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
  });
  it('frozen_tool_schema_bytes_survive_append_and_same_name_change', () => {
    const names: string[] = [];
    const schemas = new Map<string, unknown>();
    const tools = [schema('zeta_tool', { description: 'Z v1', parameters: { type: 'object', properties: {} } }),
      schema('alpha_tool', { description: 'A v1' })];
    freezeToolSchemasForPromptCache(tools, names, schemas);
    expect(tools.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'zeta_tool']);
    const sent = tools.map(bytes);
    const rebuilt = [schema('zeta_tool', { description: 'Z v2 CHANGED', parameters: { type: 'object', properties: {} } }),
      schema('beta_tool', { description: 'B v1' }), schema('alpha_tool', { description: 'A v1' })];
    freezeToolSchemasForPromptCache(rebuilt, names, schemas);
    expect(rebuilt.map(toolSchemaSortKey)).toEqual(['alpha_tool', 'zeta_tool', 'beta_tool']);
    sent.forEach((expected, index) => expect(bytes(rebuilt[index])).toBe(expected));
    expect((rebuilt[1] as unknown as { function: { description: string } }).function.description).toBe('Z v1');

    const beta = bytes(rebuilt[2]);
    const third = [schema('beta_tool', { description: 'B v2 CHANGED' }), schema('alpha_tool', { description: 'A v1' }),
      schema('zeta_tool', { description: 'Z v2 CHANGED', parameters: { type: 'object', properties: {} } })];
    freezeToolSchemasForPromptCache(third, names, schemas);
    expect(bytes(third[2])).toBe(beta);
  });
  it('same_name_schema_change_applies_at_next_stable_window', () => {
    const v1 = schema('alpha_tool', { description: 'A v1' });
    const v2 = schema('alpha_tool', { description: 'A v2' });
    const sessionNames: string[] = [];
    const w1 = new Map<string, unknown>();
    freezeToolSchemasForPromptCache([v1], sessionNames, w1);
    const w1r2 = [v2];
    freezeToolSchemasForPromptCache(w1r2, sessionNames, w1);
    expect(w1r2[0]).toEqual(v1);
    const w2 = new Map<string, unknown>();
    const w2r1 = [v2];
    freezeToolSchemasForPromptCache(w2r1, sessionNames, w2);
    expect(w2r1[0]).toEqual(v2);
    expect(sessionNames).toEqual(['alpha_tool']);
    const w2r2 = [v1];
    freezeToolSchemasForPromptCache(w2r2, sessionNames, w2);
    expect(w2r2[0]).toEqual(v2);
  });
  it('frozen_tool_schema_bytes_normalize_key_order_permutation', () => {
    const names: string[] = [];
    const schemas = new Map<string, unknown>();
    const tools = [schema('alpha_tool', { description: 'A' })];
    freezeToolSchemasForPromptCache(tools, names, schemas);
    const sent = bytes(tools[0]);
    const permuted = [{ function: { description: 'A', name: 'alpha_tool' }, type: 'function' }];
    expect(permuted[0]).toEqual(tools[0]);
    expect(bytes(permuted[0])).not.toBe(sent);
    freezeToolSchemasForPromptCache(permuted, names, schemas);
    expect(bytes(permuted[0])).toBe(sent);
  });
  it('tool_schema_digest_is_name_ordered_and_none_when_empty', () => {
    expect(toolSchemaDigest(new Map())).toBeNull();
    const a = new Map<string, unknown>([['b', schema('b')], ['a', schema('a')]]);
    const b = new Map<string, unknown>([['a', schema('a')], ['b', schema('b')]]);
    expect(toolSchemaDigest(a)).toBe(toolSchemaDigest(b));
    expect(toolSchemaDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    const changed = new Map<string, unknown>([['a', schema('a', { description: 'changed' })], ['b', schema('b')]]);
    expect(toolSchemaDigest(changed)).not.toBe(toolSchemaDigest(a));
  });
  it('freeze_tool_face_returns_window_digest', () => {
    const names: string[] = [];
    const schemas = new Map<string, unknown>();
    const tools = [schema('alpha_tool')];
    const digest = freezeToolFaceForPromptCache(tools, names, schemas);
    expect(digest).toBe(toolSchemaDigest(schemas));
    expect(freezeToolFaceForPromptCache([], names, new Map())).toBeNull();
  });
  it('tool_round_reasoning_items_pair_by_tool_call_id', () => {
    const dest = new Map<string, JsonValue>();
    assignToolRoundReasoningItems(dest, [['call_1', { id: 'rs_1' }], ['call_2', { id: 'rs_2' }]], 'call_1');
    expect(dest.size).toBe(2);
    expect(dest.get('call_1')).toEqual({ id: 'rs_1' });
    expect(dest.get('call_2')).toEqual({ id: 'rs_2' });
  });
  it('tool_round_unpaired_fallback_never_overwrites_paired_item', () => {
    const dest = new Map<string, JsonValue>();
    assignToolRoundReasoningItems(dest, [['call_1', { id: 'rs_paired' }], [null, { id: 'rs_orphan' }]], 'call_1');
    expect(dest.size).toBe(1);
    expect(dest.get('call_1')).toEqual({ id: 'rs_paired' });
    const dest2 = new Map<string, JsonValue>();
    assignToolRoundReasoningItems(dest2, [[null, { id: 'rs_orphan' }]], 'call_9');
    expect(dest2.get('call_9')).toEqual({ id: 'rs_orphan' });
    const dest3 = new Map<string, JsonValue>();
    assignToolRoundReasoningItems(dest3, [[null, { id: 'x' }]], null);
    expect(dest3.size).toBe(0);
  });
  it('final_round_reasoning_unpaired_items_use_sentinel_key_last_wins', () => {
    const dest = new Map<string, JsonValue>();
    assignFinalRoundReasoningItems(dest, [['call_1', { id: 'rs_tool' }], [null, { id: 'rs_first' }], [null, { id: 'rs_last' }]]);
    expect(dest.size).toBe(2);
    expect(dest.get('call_1')).toEqual({ id: 'rs_tool' });
    expect(dest.get(RESPONSES_FINAL_REASONING_KEY)).toEqual({ id: 'rs_last' });
  });
  it('failed_round_retains_and_accumulates_reported_partial_usage', () => {
    const accumulated = fromApiWithCache(100, 10, 2, 4);
    const partial = fromApiWithCache(20, 5, 3, 7);
    const retained = retainFailedRoundUsage(accumulated, partial)!;
    expect(retained.promptTokens).toBe(20);
    expect(retained.completionTokens).toBe(5);
    expect(accumulated.promptTokens).toBe(120);
    expect(accumulated.completionTokens).toBe(15);
    expect(accumulated.totalTokens).toBe(135);
    expect(accumulated.reasoningTokens).toBe(5);
    expect(accumulated.cachedTokens).toBe(11);
    expect(accumulated.lastRoundPromptTokens).toBe(25);
  });
  it('failed_round_without_reported_usage_does_not_change_totals', () => {
    const accumulated = fromApi(8, 3, null);
    const before = structuredClone(accumulated);
    expect(retainFailedRoundUsage(accumulated, null)).toBeNull();
    expect(accumulated).toEqual(before);
  });
  it('merge_round_results_in_call_order_prefers_call_order_and_keeps_orphans', () => {
    const merged = mergeRoundResultsInCallOrder([{ id: 'b' }, { id: 'a' }],
      [result('a', null), result('b', 'timeout')], [result('synth', 'synthetic')]);
    expect(merged.map(info => info.toolCallId)).toEqual(['b', 'a', 'synth']);
  });
});
