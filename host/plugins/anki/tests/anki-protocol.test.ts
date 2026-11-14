/**
 * `crates/dstu-anki/src/anki_protocol.rs::tests` 的移植：协议常量、格式指令、
 * 协议决策、schema 生成、JSON 修复与 wrapper 流式剥离的纯逻辑测试。
 */
import { describe, expect, it } from 'vitest';
import type {
  AnkiGenerationOptions,
  FieldExtractionRule__De,
  FieldType__De,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import {
  BROKEN_DELIMITER_TAIL,
  buildCardSchema,
  buildCardsResponseSchema,
  buildResponseFormat,
  CARDS_WRAPPER_KEY,
  CARD_DELIMITER,
  detectSchemaCapability,
  formatInstructions,
  isMultiTemplate,
  JSON_SCHEMA_NAME,
  repairJson,
  repairJsonDetailed,
  resolveOutputProtocol,
  stripWrapperPrefix,
  structuredOutputOptionsFromOptionsJson,
  TEMPLATE_ID_KEY,
  unwrapCardsArray,
  qaPassEnabled,
} from '../src/anki-protocol.ts';

function makeRule(isRequired: boolean, fieldType: FieldType__De, description: string): FieldExtractionRule__De {
  return {
    field_type: fieldType,
    is_required: isRequired,
    default_value: null,
    validation_pattern: null,
    description,
  };
}

function emptyOptions(): AnkiGenerationOptions {
  return {
    deck_name: '默认',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 10,
  };
}

/** `serde_json::Value` 的下标语义：缺失键与越界都返回 null。 */
function jsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key] ?? null;
  }
  return current;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

describe('crates/dstu-anki/src/anki_protocol.rs::tests', () => {
  // -------------------- 常量一致性 --------------------

  it('delimiter_constants_are_consistent', () => {
    // 损坏分隔符尾部必须是标准分隔符的真后缀，且标准分隔符以 <<< 开头，
    // 否则解析侧的修复锚点会失配
    expect(CARD_DELIMITER.endsWith(BROKEN_DELIMITER_TAIL)).toBe(true);
    expect(CARD_DELIMITER.startsWith('<<<')).toBe(true);
    expect(CARD_DELIMITER).not.toBe(BROKEN_DELIMITER_TAIL);
  });

  // -------------------- 协议指令 --------------------

  it('delimiter_instructions_reference_shared_constant', () => {
    const text = formatInstructions('delimiter', '数量段\n\n', 'front、back', '{}');
    expect(text).toContain(CARD_DELIMITER);
    expect(text).toContain('数量段');
    expect(text).toContain('front、back');
  });

  it('structured_instructions_use_wrapper_and_omit_delimiter', () => {
    for (const protocol of ['json_object', 'json_schema'] as const) {
      const text = formatInstructions(protocol, '', 'front、back', '{"front": "<question>"}');
      expect(text, `structured instructions must not mention delimiter: ${text}`).not.toContain(
        CARD_DELIMITER,
      );
      expect(text).toContain(`"${CARDS_WRAPPER_KEY}"`);
      expect(text).toContain('{"cards": [{"front": "<question>"}]}');
    }
  });

  // -------------------- 协议决策 --------------------

  it('auto_prefers_json_schema_when_capable', () => {
    const [protocol, reason] = resolveOutputProtocol(null, 'json_schema');
    expect(protocol).toBe('json_schema');
    expect(reason).toBe('auto_capability');

    const [autoProtocol] = resolveOutputProtocol('auto', 'json_schema');
    expect(autoProtocol).toBe('json_schema');
  });

  it('auto_falls_back_to_delimiter_when_capability_unknown', () => {
    const [protocol, reason] = resolveOutputProtocol(null, 'unknown');
    expect(protocol).toBe('delimiter');
    expect(reason).toBe('auto_capability_unknown_fallback');

    // 仅确认 json_object 的供应商同样回退 delimiter（json_object 需显式请求）
    const [jsonObjectProtocol] = resolveOutputProtocol(null, 'json_object_only');
    expect(jsonObjectProtocol).toBe('delimiter');
  });

  it('explicit_request_overrides_capability', () => {
    const [protocol, reason] = resolveOutputProtocol('json_schema', 'unknown');
    expect(protocol).toBe('json_schema');
    expect(reason).toBe('explicit_request');

    const [delimiter] = resolveOutputProtocol('delimiter', 'json_schema');
    expect(delimiter).toBe('delimiter');

    const [jsonObject] = resolveOutputProtocol('json_object', 'unknown');
    expect(jsonObject).toBe('json_object');

    // 非法取值保守回退 delimiter
    const [fallback, fallbackReason] = resolveOutputProtocol('yaml', 'json_schema');
    expect(fallback).toBe('delimiter');
    expect(fallbackReason).toBe('unknown_requested_value_fallback');
  });

  it('capability_detection_matches_provider_adapters', () => {
    // 原生协议 / 官方端点 → json_schema
    expect(detectSchemaCapability('general', 'anthropic_messages', null, '')).toBe('json_schema');
    expect(detectSchemaCapability('gemini', null, null, '')).toBe('json_schema');
    expect(detectSchemaCapability('general', null, 'openai', 'https://api.openai.com/v1')).toBe(
      'json_schema',
    );
    expect(detectSchemaCapability('general', 'openai_responses', null, '')).toBe('json_schema');
    // DeepSeek 官方 → 仅 json_object
    expect(detectSchemaCapability('general', null, null, 'https://api.deepseek.com/v1')).toBe(
      'json_object_only',
    );
    // 任意 OpenAI 兼容端点 → 未知，不得静默假设支持
    expect(
      detectSchemaCapability(
        'general',
        'openai_chat_completions',
        null,
        'https://my-gateway.example.com/v1',
      ),
    ).toBe('unknown');
  });

  // -------------------- schema 生成 --------------------

  it('card_schema_maps_types_required_and_enum', () => {
    const rules: Record<string, FieldExtractionRule__De> = {};
    rules.front = makeRule(true, 'Text', '问题');
    const correct = makeRule(true, 'Text', '正确选项');
    correct.allowed_values = ['A', 'B', 'C', 'D'];
    rules.correct = correct;
    rules.tags = makeRule(false, 'Array', '标签');
    rules.score = makeRule(false, 'Number', '分值');

    const fields = ['front', 'correct', 'tags', 'score'];
    const schema = buildCardSchema(fields, rules, null);

    expect(jsonPath(schema, 'type')).toBe('object');
    expect(jsonPath(schema, 'properties.front.type')).toBe('string');
    expect(jsonPath(schema, 'properties.correct.enum')).toEqual(['A', 'B', 'C', 'D']);
    expect(jsonPath(schema, 'properties.tags.type')).toBe('array');
    expect(jsonPath(schema, 'properties.tags.items.type')).toBe('string');
    expect(jsonPath(schema, 'properties.score.type')).toBe('number');
    expect(jsonPath(schema, 'additionalProperties')).toBe(false);

    const required = jsonPath(schema, 'required') as string[];
    expect(required).toContain('front');
    expect(required).toContain('correct');
    expect(required).not.toContain('tags');
    expect(required).not.toContain('score');
  });

  it('card_schema_carries_length_constraints_and_description', () => {
    const front = makeRule(true, 'Text', '问题或概念');
    front.min_length = 2;
    front.max_length = 100;
    const rules: Record<string, FieldExtractionRule__De> = { front };

    const schema = buildCardSchema(['front'], rules, null);
    expect(jsonPath(schema, 'properties.front.minLength')).toBe(2);
    expect(jsonPath(schema, 'properties.front.maxLength')).toBe(100);
    expect(jsonPath(schema, 'properties.front.description')).toBe('问题或概念');
  });

  it('card_schema_without_rules_uses_historic_defaults', () => {
    const fields = ['front', 'back', 'tags'];
    const schema = buildCardSchema(fields, null, null);
    // 历史默认：front/back 必填字符串，tags 可选字符串数组
    expect(jsonPath(schema, 'properties.tags.type')).toBe('array');
    expect(jsonPath(schema, 'required')).toEqual(['front', 'back']);
  });

  it('multi_template_schema_uses_oneof_with_template_id_discriminator', () => {
    const fieldsById: Record<string, string[]> = {
      'design-lab': ['question', 'answer'],
      'design-glass': ['text'],
    };

    const rulesById: Record<string, Record<string, FieldExtractionRule__De>> = {};
    const labRules: Record<string, FieldExtractionRule__De> = {};
    labRules.question = makeRule(true, 'Text', '题干');
    labRules.answer = makeRule(true, 'Text', '答案');
    rulesById['design-lab'] = labRules;
    const glassRules: Record<string, FieldExtractionRule__De> = {};
    glassRules.text = makeRule(true, 'Text', '填空文本');
    rulesById['design-glass'] = glassRules;

    const options = emptyOptions();
    options.template_fields_by_id = fieldsById;
    options.field_extraction_rules_by_id = rulesById;

    expect(isMultiTemplate(options)).toBe(true);
    const schema = buildCardsResponseSchema(options);
    expect(schema).not.toBeNull();
    const items = jsonPath(schema, `properties.${CARDS_WRAPPER_KEY}.items`);
    const variants = jsonPath(items, 'oneOf') as unknown[];
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      const templateEnum = jsonPath(variant, `properties.${TEMPLATE_ID_KEY}.enum`) as unknown[];
      expect(templateEnum).toHaveLength(1);
      const required = jsonPath(variant, 'required') as string[];
      expect(required).toContain(TEMPLATE_ID_KEY);
    }
  });

  it('response_format_shapes_per_protocol', () => {
    const options = emptyOptions();

    expect(buildResponseFormat('delimiter', options)).toBeNull();

    const jsonObject = buildResponseFormat('json_object', options);
    expect(jsonObject).toEqual({ type: 'json_object' });

    // 与 providers/mod.rs 各转换函数约定的 CC 形态完全一致：
    // {type:"json_schema", json_schema:{name,schema,strict}}
    const jsonSchema = buildResponseFormat('json_schema', options);
    expect(jsonPath(jsonSchema, 'type')).toBe('json_schema');
    expect(jsonPath(jsonSchema, 'json_schema.name')).toBe(JSON_SCHEMA_NAME);
    expect(jsonPath(jsonSchema, 'json_schema.strict')).toBe(false);
    const schema = jsonPath(jsonSchema, 'json_schema.schema');
    expect(jsonPath(schema, 'required')).toEqual([CARDS_WRAPPER_KEY]);
    expect(jsonPath(schema, `properties.${CARDS_WRAPPER_KEY}.type`)).toBe('array');
  });

  // -------------------- is_multi_template --------------------

  it('is_multi_template_detects_all_sources', () => {
    const options = emptyOptions();
    expect(isMultiTemplate(options)).toBe(false);

    const byIds = emptyOptions();
    byIds.template_ids = ['a', 'b'];
    expect(isMultiTemplate(byIds)).toBe(true);

    const singleId = emptyOptions();
    singleId.template_ids = ['a'];
    expect(isMultiTemplate(singleId)).toBe(false);

    const byRules = emptyOptions();
    byRules.field_extraction_rules_by_id = { a: {}, b: {} };
    expect(isMultiTemplate(byRules)).toBe(true);
  });

  // -------------------- json repair --------------------

  it('repair_removes_trailing_comma', () => {
    const repaired = repairJson('{"front": "Q", "back": "A",}');
    expect(repaired).not.toBeNull();
    const value = parseJson(repaired!);
    expect(jsonPath(value, 'back')).toBe('A');

    const repairedArray = repairJson('{"tags": ["a", "b",]}');
    expect(repairedArray).not.toBeNull();
    const arrayValue = parseJson(repairedArray!);
    expect(jsonPath(arrayValue, 'tags')).toEqual(['a', 'b']);
  });

  it('repair_closes_missing_brackets', () => {
    // 已闭合字符串之后的缺失括号：无损修复，允许自动修复
    const repaired = repairJson('{"front": "Q", "tags": ["a"');
    expect(repaired).not.toBeNull();
    const value = parseJson(repaired!);
    expect(jsonPath(value, 'tags')).toEqual(['a']);
  });

  it('repair_refuses_silent_fix_for_mid_string_truncation', () => {
    // 字符串中途截断：内容已丢失，无损修复接口必须拒绝（0824 评审 #3）
    expect(repairJson('{"front": "未闭合')).toBeNull();
    expect(repairJson('{"front": "Q", "back": "答案被截')).toBeNull();

    // detailed 接口仍可修出语法合法的 JSON，但必须携带 truncated_string 标记
    const detailed = repairJsonDetailed('{"front": "未闭合');
    expect(detailed).not.toBeNull();
    expect(detailed!.truncated_string).toBe(true);
    const value = parseJson(detailed!.text);
    expect(jsonPath(value, 'front')).toBe('未闭合');

    // 悬空转义反斜杠同属字符串中途截断
    const dangling = repairJsonDetailed('{"front": "abc\\');
    expect(dangling).not.toBeNull();
    expect(dangling!.truncated_string).toBe(true);

    // 无损形态经 detailed 接口不得误标截断
    const lossless = repairJsonDetailed('{"front": "Q", "back": "A",}');
    expect(lossless).not.toBeNull();
    expect(lossless!.truncated_string).toBe(false);
  });

  it('repair_trims_trailing_garbage_after_balanced_object', () => {
    // 结构化收尾残留 `]}` 场景
    const repaired = repairJson('{"front": "Q", "back": "A"}]}');
    expect(repaired).not.toBeNull();
    const value = parseJson(repaired!);
    expect(jsonPath(value, 'front')).toBe('Q');
  });

  it('repair_returns_none_for_hopeless_input', () => {
    expect(repairJson('no json here')).toBeNull();
    expect(repairJson('')).toBeNull();
  });

  it('repair_does_not_touch_delimiter_text_inside_strings', () => {
    const raw = `{"front": "包含 ${CARD_DELIMITER} 的文本", "back": "A"`;
    const repaired = repairJson(raw);
    expect(repaired).not.toBeNull();
    const value = parseJson(repaired!);
    expect(jsonPath(value, 'front') as string).toContain(CARD_DELIMITER);
  });

  // -------------------- wrapper 流式剥离 / 展开 --------------------

  it('strip_wrapper_prefix_only_when_complete', () => {
    const buffer = { text: '{"cards": [{"front": "Q"}' };
    expect(stripWrapperPrefix(buffer)).toBe(true);
    expect(buffer.text).toBe('{"front": "Q"}');

    // 前缀不完整：等待，不破坏缓冲
    const partial = { text: '{"ca' };
    expect(stripWrapperPrefix(partial)).toBe(false);
    expect(partial.text).toBe('{"ca');

    // 非 wrapper 形态：不动
    const plain = { text: '{"front": "Q"}' };
    expect(stripWrapperPrefix(plain)).toBe(false);
    expect(plain.text).toBe('{"front": "Q"}');

    // 空白变体
    const spaced = { text: '  {\n  "cards" : [\n{"a":1}' };
    expect(stripWrapperPrefix(spaced)).toBe(true);
    expect(spaced.text.trimStart()).toBe('{"a":1}');
  });

  it('unwrap_cards_array_extracts_wrapper_items', () => {
    const wrapper = { cards: [{ front: 'Q1' }, { front: 'Q2' }] };
    const cards = unwrapCardsArray(wrapper);
    expect(cards).not.toBeNull();
    expect(cards!).toHaveLength(2);

    expect(unwrapCardsArray({ front: 'Q' })).toBeNull();
    expect(unwrapCardsArray({ cards: 'not array' })).toBeNull();
    expect(unwrapCardsArray('scalar')).toBeNull();
  });

  // -------------------- StructuredOutputOptions --------------------

  it('structured_options_parse_from_options_json', () => {
    const opts = structuredOutputOptionsFromOptionsJson(
      '{"deck_name":"d","note_type":"Basic","enable_images":false,\n' +
        '               "max_cards_per_mistake":5,"output_protocol":"json_schema","enable_qa_pass":false}',
    );
    expect(opts.output_protocol).toBe('json_schema');
    expect(qaPassEnabled(opts)).toBe(false);

    // 旧版 options（无扩展字段）：默认 auto + QA 开
    const legacy = structuredOutputOptionsFromOptionsJson(
      '{"deck_name":"d","note_type":"Basic","enable_images":false,"max_cards_per_mistake":5}',
    );
    expect(legacy.output_protocol).toBeNull();
    expect(qaPassEnabled(legacy)).toBe(true);

    // 非法 JSON 回退默认
    const broken = structuredOutputOptionsFromOptionsJson('not json');
    expect(broken.output_protocol).toBeNull();
    expect(qaPassEnabled(broken)).toBe(true);

    // 非完整 AnkiGenerationOptions（缺必填字段）同样回退默认：
    // 解析单点收敛后不再对残缺 JSON 做宽松字段提取。
    const partial = structuredOutputOptionsFromOptionsJson('{"output_protocol":"json_schema"}');
    expect(partial.output_protocol).toBeNull();
    expect(qaPassEnabled(partial)).toBe(true);
  });
});
