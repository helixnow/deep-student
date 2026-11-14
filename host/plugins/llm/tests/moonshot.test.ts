import { describe, expect, it } from 'vitest';
import {
  MoonshotAdapter, normalizeToolSchemasForMfjs, parseKVersion,
  shouldApplyMfjsToolSchemaDialect,
} from '../src/adapters/moonshot.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new MoonshotAdapter();

function mfjsTool(parameters: unknown): Body {
  return {
    type: 'function',
    function: { name: 'demo_tool', description: 'demo', parameters },
  };
}

describe('adapters/moonshot.rs', () => {
  it('test_thinking_model_temperature', () => {
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2-thinking' }), null);
    expect(body.temperature).toBe(1.0);
  });

  it('test_thinking_model_min_max_tokens', () => {
    const body: Body = { max_tokens: 4096 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2-thinking' }), null);
    expect(body.max_tokens).toBe(32000);
  });

  it('test_non_thinking_model_keeps_temperature', () => {
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2-turbo-preview' }), null);
    expect(body.temperature).toBe(0.7);
  });

  it('test_parse_k_version', () => {
    expect(parseKVersion('kimi-k2.5')).toEqual([2, 5]);
    expect(parseKVersion('kimi-k2-5')).toEqual([2, 5]);
    expect(parseKVersion('kimi-k2.6')).toEqual([2, 6]);
    expect(parseKVersion('kimi-k2.7-code')).toEqual([2, 7]);
    expect(parseKVersion('kimi-k2.7-code-highspeed')).toEqual([2, 7]);
    expect(parseKVersion('kimi-k2')).toEqual([2, 0]);
    expect(parseKVersion('kimi-k2-thinking')).toEqual([2, 0]);
    expect(parseKVersion('kimi-k2-0905-preview')).toEqual([2, 0]);
    expect(parseKVersion('kimi-k2.10')).toEqual([2, 10]);
    expect(parseKVersion('kimi-k3')).toEqual([3, 0]);
    expect(parseKVersion('moonshot-v1-128k')).toBeNull();
    expect(parseKVersion('kimi-latest')).toBeNull();
  });

  it('test_k25_model_detection', () => {
    for (const model of [
      'kimi-k2.5', 'kimi-k2-5', 'Pro/moonshot/kimi-k2.5', 'moonshot/K2.5-preview',
      'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.10',
    ]) {
      expect(MoonshotAdapter.isK25OrLater(model), model).toBe(true);
    }
    expect(MoonshotAdapter.isK25OrLater('kimi-k3')).toBe(false);
    expect(MoonshotAdapter.isK3OrLater('kimi-k3')).toBe(true);
    expect(MoonshotAdapter.isK3OrLater('kimi-k3-0905-preview')).toBe(true);
    expect(MoonshotAdapter.isK3OrLater('kimi-k2.7-code')).toBe(false);
    for (const model of [
      'kimi-k2', 'kimi-k2-thinking', 'kimi-k2-0905-preview', 'moonshot-v1-128k',
    ]) {
      expect(MoonshotAdapter.isK25OrLater(model), model).toBe(false);
    }
  });

  it('test_k25_thinking_param_format', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.5' }), true);
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('test_k25_thinking_disabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.5' }), false);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('test_k26_fixed_params_stripped', () => {
    const body: Body = {
      temperature: 0.7, top_p: 0.8, n: 2, presence_penalty: 0.5, frequency_penalty: 0.5,
    };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.6' }), null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.n).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
    expect((body.thinking as Body).type).toBe('enabled');
  });

  it('test_k26_max_tokens_migrated_to_max_completion_tokens', () => {
    const body: Body = { max_tokens: 50000 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.6' }), null);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(50000);
  });

  it('test_k25_default_max_completion_tokens', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.5' }), null);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(32768);
  });

  it('test_k26_existing_max_completion_tokens_kept', () => {
    const body: Body = { max_completion_tokens: 65536, max_tokens: 4096 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.6' }), null);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(65536);
  });

  it('test_k26_keep_all_with_include_thoughts', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'kimi-k2.6', includeThoughts: true }), true,
    );
    expect(body.thinking).toEqual({ type: 'enabled', keep: 'all' });
  });

  it('test_k25_no_keep_support', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'kimi-k2.5', includeThoughts: true }), true,
    );
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('test_k27_code_forces_thinking_and_keep_all', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.7-code' }), false);
    expect(body.thinking).toEqual({ type: 'enabled', keep: 'all' });
  });

  it('test_k26_tool_choice_constraint', () => {
    const body: Body = { tool_choice: 'required' };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'kimi-k2.6' }), true);
    expect(body.tool_choice).toBe('auto');
  });

  it('test_new_gen_passback_policy', () => {
    for (const model of ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code']) {
      expect(adapter.getPassbackPolicy(makeConfig({ model })), model).toBe('deep_seek_style');
    }
  });

  it('test_k3_forces_reasoning_effort_max', () => {
    for (const model of ['kimi-k3', 'kimi-k3-0905-preview', 'moonshotai/Kimi-K3-Instruct']) {
      const body: Body = {
        thinking: { type: 'enabled' }, enable_thinking: false, thinking_budget: 8192,
      };
      const handled = adapter.applyReasoningConfig(body, makeConfig({ model }), false);
      expect(handled, model).toBe(true);
      expect(body.thinking, model).toBeUndefined();
      expect(body.enable_thinking, model).toBeUndefined();
      expect(body.thinking_budget, model).toBeUndefined();
      expect(body.reasoning_effort, model).toBe('max');
    }
  });

  it('test_legacy_k2_not_treated_as_new_gen', () => {
    const body: Body = { temperature: 0.7 };
    const earlyReturn = adapter.applyReasoningConfig(
      body, makeConfig({ model: 'kimi-k2-0905-preview' }), null,
    );
    expect(earlyReturn).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toBeUndefined();
  });

  it('mfjs_distributes_root_constraints_into_anyof_branches', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: { documentId: { type: 'string' }, ankiBlockId: { type: 'string' } },
      anyOf: [{ required: ['documentId'] }, { required: ['ankiBlockId'] }],
      additionalProperties: false,
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(1);
    const params = (tools[0] as Body).function as Body;
    expect(params.parameters).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { documentId: { type: 'string' }, ankiBlockId: { type: 'string' } },
          required: ['documentId'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { documentId: { type: 'string' }, ankiBlockId: { type: 'string' } },
          required: ['ankiBlockId'],
          additionalProperties: false,
        },
      ],
    });
  });

  it('mfjs_distributes_nested_and_rewrites_null_enum_and_drops_unsupported', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        expectedReviewVersion: {
          anyOf: [{ type: 'integer', minimum: 0 }, { enum: [null] }],
          description: 'reviewState=null 时显式传 null',
        },
        patch: {
          type: 'object',
          minProperties: 1,
          properties: { front: { type: 'string' }, text: { type: 'string' } },
          anyOf: [{ required: ['front'] }, { required: ['text'] }],
          additionalProperties: false,
        },
      },
      required: ['cardId'],
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(3);
    const params = ((tools[0] as Body).function as Body).parameters as Body;
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['cardId']);
    expect((params.properties as Body).expectedReviewVersion).toEqual({
      anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
      description: 'reviewState=null 时显式传 null',
    });
    expect((params.properties as Body).patch).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { front: { type: 'string' }, text: { type: 'string' } },
          required: ['front'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { front: { type: 'string' }, text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      ],
    });
  });

  it('mfjs_rewrites_oneof_with_discriminator_branches', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', enum: ['theme', 'theme_palette'] },
        value: {},
      },
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', enum: ['theme'] },
            value: { type: 'string', enum: ['light', 'dark', 'auto'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', enum: ['theme_palette'] },
            value: { type: 'string', enum: ['default', 'custom'] },
          },
        },
      ],
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(2);
    const params = ((tools[0] as Body).function as Body).parameters as Body;
    expect(params.oneOf).toBeUndefined();
    expect(Object.keys(params).length).toBe(1);
    const anyOf = params.anyOf as Body[];
    expect((anyOf[0]!.properties as Body).key).toEqual({ type: 'string', enum: ['theme'] });
    expect((anyOf[1]!.properties as Body).value)
      .toEqual({ type: 'string', enum: ['default', 'custom'] });
    expect(anyOf[0]!.required).toEqual(['key', 'value']);
  });

  it('mfjs_rewrites_const_and_drops_unique_items', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: {
        zoom: {
          anyOf: [
            { type: 'number', minimum: 10, maximum: 800 },
            { type: 'string', const: 'fit' },
          ],
        },
        byWeekday: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          uniqueItems: true,
        },
      },
      required: ['zoom'],
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(2);
    const params = ((tools[0] as Body).function as Body).parameters as Body;
    const properties = params.properties as Body;
    expect((properties.zoom as Body).anyOf).toEqual([
      { type: 'number', minimum: 10, maximum: 800 },
      { type: 'string', enum: ['fit'] },
    ]);
    expect(properties.byWeekday).toEqual({
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
    });
  });

  it('mfjs_leaves_compliant_schemas_untouched', () => {
    const compliant = mfjsTool({
      type: 'object',
      properties: {
        qs: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'place your query or queries here',
        },
      },
      required: ['qs'],
    });
    const plain = mfjsTool({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    const tools: unknown[] = [structuredClone(compliant), structuredClone(plain)];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(0);
    expect(tools).toEqual([compliant, plain]);
  });

  it('mfjs_unions_required_when_distributing', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: {
        list_id: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        expected_updated_at: { type: 'string' },
      },
      required: ['list_id', 'expected_updated_at'],
      anyOf: [{ required: ['title'] }],
    })];
    normalizeToolSchemasForMfjs(tools);
    const params = ((tools[0] as Body).function as Body).parameters as Body;
    const branch = (params.anyOf as Body[])[0]!;
    expect(branch.required).toEqual(['title', 'list_id', 'expected_updated_at']);
    expect(branch.type).toBe('object');
  });

  it('mfjs_infers_type_for_bare_enum', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: {
        format: { const: 'json', enum: ['json'] },
        count: { enum: [1, 2, 3] },
        ratio: { enum: [0.5, 1.5] },
        flag: { enum: [true, false] },
      },
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(5);
    const props = (((tools[0] as Body).function as Body).parameters as Body).properties as Body;
    expect(props.format).toEqual({ type: 'string', enum: ['json'] });
    expect(props.count).toEqual({ type: 'integer', enum: [1, 2, 3] });
    expect(props.ratio).toEqual({ type: 'number', enum: [0.5, 1.5] });
    expect(props.flag).toEqual({ type: 'boolean', enum: [true, false] });
  });

  it('mfjs_drops_parent_annotation_when_branch_defines_it', () => {
    const tools: unknown[] = [mfjsTool({
      type: 'object',
      properties: {
        content: {
          oneOf: [
            { type: 'string', description: 'JSON 字符串' },
            { type: 'object', description: '对象格式' },
          ],
          description: '完整 MindMapDocument（字符串或对象）',
        },
      },
    })];
    const rewrites = normalizeToolSchemasForMfjs(tools);
    expect(rewrites).toBe(2);
    const content = (((tools[0] as Body).function as Body).parameters as Body)
      .properties as Body;
    const node = content.content as Body;
    expect(node.description).toBeUndefined();
    const anyOf = node.anyOf as Body[];
    expect(anyOf[0]!.description).toBe('JSON 字符串');
    expect(anyOf[1]!.description).toBe('对象格式');
  });

  it('mfjs_gate_matches_moonshot_configs', () => {
    expect(shouldApplyMfjsToolSchemaDialect(makeConfig({
      modelAdapter: 'moonshot', model: 'kimi-k3', baseUrl: 'https://api.moonshot.cn/v1',
    }))).toBe(true);
    expect(shouldApplyMfjsToolSchemaDialect(makeConfig({
      modelAdapter: 'openai', model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',
    }))).toBe(true);
    expect(shouldApplyMfjsToolSchemaDialect(makeConfig({
      modelAdapter: 'openai', model: 'kimi-k3-max', baseUrl: 'http://47.88.78.106/v1',
    }))).toBe(true);
    expect(shouldApplyMfjsToolSchemaDialect(makeConfig({
      modelAdapter: 'openai', model: 'gpt-5.6', baseUrl: 'https://api.openai.com/v1',
    }))).toBe(false);
  });

  it('test_k3_uses_configured_effort_low', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'kimi-k3', reasoningEffort: 'low' }), null,
    );
    expect(body.reasoning_effort).toBe('low');
  });

  it('test_k3_xhigh_effort_normalized_to_max', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'kimi-k3', reasoningEffort: 'xhigh' }), null,
    );
    expect(body.reasoning_effort).toBe('max');
  });
});
