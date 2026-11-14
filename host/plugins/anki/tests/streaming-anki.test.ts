import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnkiGenerationOptions,
  FieldExtractionRule__De,
  TemplateDescription,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  CARD_BUFFER_HARD_LIMIT,
  ERROR_CARD_RAW_PREVIEW_CHARS,
  QA_FLAGS_FIELD,
  StreamingAnkiService,
  buildCriticSummaryEvent,
  buildPrompt,
  buildResponseFormat,
  buildTaskCompletedEvent,
  compactOutputBudget,
  deckTag,
  defaultStreamStats,
  describePromptField,
  errorCardContent,
  errorContentIsRepairable,
  extractCardFromBufferImpl,
  extractReadableText,
  findRule,
  isPlaceholderCard,
  resolveTemplateIdCandidate,
  statsHasAnySignal,
  statsHasWarnings,
  stripModelSpecialTokens,
  stripWrapperPrefix,
  validateFieldAgainstRule,
} from '../src/streaming-anki.ts';
import { ORIGINAL_GENERATION_FIELD, ORIGINAL_GENERATION_MAX_BYTES, extractOriginalFromExtras } from '../src/anki-gold-set.ts';
import { buildOcclusionDraftMarker, extractOcclusionDraftFields } from '../src/image-occlusion.ts';
import { releaseDocumentTracker } from '../src/anki-qa-tracker.ts';
import {
  CARDS_WRAPPER_KEY,
  resolveOutputProtocol,
  structuredOutputOptionsFromOptionsJson,
} from '../src/anki-protocol.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const DEFAULTS: AnkiGenerationOptions = {
  deck_name: '默认',
  note_type: 'Basic',
  enable_images: false,
  max_cards_per_mistake: 5,
};

function minimalOptions(): AnkiGenerationOptions {
  return { ...DEFAULTS };
}

function makeTemplate(id: string, name: string): TemplateDescription {
  return { id, name, description: 'desc', fields: ['front', 'back'], generation_prompt: null };
}

function makeRule(
  isRequired: boolean,
  fieldType: FieldExtractionRule__De['field_type'],
  description: string,
  overrides: Partial<FieldExtractionRule__De> = {},
): FieldExtractionRule__De {
  return {
    field_type: fieldType,
    is_required: isRequired,
    default_value: null,
    validation_pattern: null,
    description,
    ...overrides,
  };
}

function svc(db: DatabaseHandle): StreamingAnkiService {
  return new StreamingAnkiService({
    db,
    regex: nativeRegex,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

function qaFlagCodes(extra: Record<string, string>): string[] {
  const raw = extra[QA_FLAGS_FIELD];
  if (raw === undefined) return [];
  const flags = JSON.parse(raw) as Array<Record<string, unknown>>;
  return flags.map((flag) => String(flag['code'] ?? ''));
}

describe('crates/dstu-anki/src/streaming_anki_service.rs::tests', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;
  let service: StreamingAnkiService;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
    service = svc(db);
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  }, 120_000);

  beforeEach(() => {
    // 每个 DB 用例使用独立 task/document id；这里只清理本次文件用到的固定 id。
    for (const taskId of [
      'truncated-task', 'lossless-task', 'original-basic-task', 'original-cloze-task',
      'original-existing-task', 'original-oversized-task', 'fp-task-a', 'fp-task-b',
    ]) {
      db.run('DELETE FROM anki_cards WHERE task_id = ?1', [taskId]);
      db.run('DELETE FROM document_tasks WHERE id = ?1', [taskId]);
    }
  }, 120_000);

  function seedTask(taskId: string, documentId: string, segmentIndex = 0): void {
    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '{}')`,
      [taskId, documentId, '指纹测试文档', segmentIndex, `segment-${segmentIndex}`, 'Streaming',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    );
  }

  function fingerprintOptions(): AnkiGenerationOptions {
    return {
      ...minimalOptions(),
      field_extraction_rules: {
        front: makeRule(true, 'Text', 'front'),
        back: makeRule(true, 'Text', 'back'),
      },
    };
  }

  // ------------------------------------------------------------ 纯函数

  it('compact_output_budget_grows_with_segment_and_reasoning', () => {
    const segment = '词'.repeat(2200);
    expect(compactOutputBudget(2400, segment, false, 32_000)).toBeGreaterThanOrEqual(7000);
    expect(compactOutputBudget(2400, segment, true, 32_000)).toBeGreaterThanOrEqual(11_000);
    expect(compactOutputBudget(2400, 'short', false, 32_000)).toBe(2400);
    expect(compactOutputBudget(2400, segment, true, 4000)).toBe(4000);
  });

  it('resolve_template_id_accepts_exact_id', () => {
    const templates = [makeTemplate('design-lab', '01. The Lab Pro (学术选择题增强版)'), makeTemplate('design-glass', '07. The Glass (学术填空题)')];
    expect(resolveTemplateIdCandidate('design-lab', templates, null, null)).toBe('design-lab');
  });

  it('resolve_template_id_accepts_template_name', () => {
    const templates = [makeTemplate('design-lab', '01. The Lab Pro (学术选择题增强版)')];
    expect(resolveTemplateIdCandidate('01. The Lab Pro (学术选择题增强版)', templates, null, null)).toBe('design-lab');
  });

  it('resolve_template_id_accepts_normalized_name', () => {
    const templates = [makeTemplate('design-lab', '01. The Lab Pro (学术选择题增强版)')];
    expect(resolveTemplateIdCandidate('01 The   Lab Pro 学术选择题增强版', templates, null, null)).toBe('design-lab');
  });

  it('resolve_template_id_rejects_unknown_value', () => {
    const templates = [makeTemplate('design-lab', '01. The Lab Pro (学术选择题增强版)')];
    expect(resolveTemplateIdCandidate('not-exist-template', templates, null, null)).toBeNull();
  });

  it('resolve_template_id_rejects_ambiguous_name', () => {
    const templates = [makeTemplate('design-lab-v1', '01. The Lab Pro'), makeTemplate('design-lab-v2', '01. The Lab Pro')];
    expect(resolveTemplateIdCandidate('01. The Lab Pro', templates, null, null)).toBeNull();
  });

  it('extract_readable_text_prefers_top_level_string', () => {
    const text = extractReadableText({
      tags: ['a', 'b'],
      template_id: 'design-lab',
      question: '什么是牛顿第一定律？',
      answer: '惯性定律',
    });
    expect(['什么是牛顿第一定律？', '惯性定律']).toContain(text);
  });

  it('extract_readable_text_falls_back_to_nested_fields', () => {
    expect(extractReadableText({ template_id: 'design-lab', fields: { Question: '  嵌套问题  ' } })).toBe('嵌套问题');
  });

  it('extract_readable_text_returns_none_for_unreadable_fragment', () => {
    expect(extractReadableText({ tags: ['only', 'tags'], template_id: 'design-lab', count: 42 })).toBeNull();
    expect(extractReadableText('not an object')).toBeNull();
  });

  it('describe_prompt_field_honors_is_required_flag', () => {
    const required = describePromptField('explanation', makeRule(true, 'Text', '解析说明'));
    expect(required).toContain('必填');
    expect(required).toContain('解析说明');
    const optional = describePromptField('notes', makeRule(false, 'Text', ''));
    expect(optional).toContain('可选');
    expect(optional).toContain('补充注释');
  });

  it('describe_prompt_field_defaults_without_rule', () => {
    expect(describePromptField('front', null)).toContain('必填');
    expect(describePromptField('back', null)).toContain('必填');
    const tags = describePromptField('tags', null);
    expect(tags).toContain('可选');
    expect(tags).toContain('字符串数组');
    expect(describePromptField('custom_field', null)).toContain('可选');
  });

  it('describe_prompt_field_reports_array_type_from_rule', () => {
    const described = describePromptField('steps', makeRule(true, 'Array', '步骤列表'));
    expect(described).toContain('字符串数组');
    expect(described).toContain('必填');
  });

  it('find_rule_matches_case_insensitively', () => {
    const rules = { Front: makeRule(true, 'Text', '正面') };
    expect(findRule(rules, 'Front')).toBeDefined();
    expect(findRule(rules, 'front')).toBeDefined();
    expect(findRule(rules, 'FRONT')).toBeDefined();
    expect(findRule(rules, 'back')).toBeUndefined();
    expect(findRule(null, 'front')).toBeUndefined();
  });

  it('strip_model_special_tokens_removes_box_wrapper', () => {
    expect(stripModelSpecialTokens('<|begin_of_box|>{"front":"Q","back":"A"}<|end_of_box|>')).toBe('{"front":"Q","back":"A"}');
  });

  it('strip_model_special_tokens_yields_empty_for_pure_token_fragment', () => {
    expect(stripModelSpecialTokens('<|end_of_box|>').trim()).toBe('');
    expect(stripModelSpecialTokens('\n <|end_of_box|> \n').trim()).toBe('');
    expect(stripModelSpecialTokens('<|im_end|><|endoftext|>').trim()).toBe('');
  });

  it('strip_model_special_tokens_keeps_non_whitelisted_content', () => {
    const input = '{"front":"何为 <|自定义|> 标记？"}';
    expect(stripModelSpecialTokens(input)).toBe(input);
  });

  it('strip_model_special_tokens_preserves_literal_tokens_in_card_body', () => {
    const input = '{"front":"<|im_end|> 是什么？","back":"它是模型协议的字面量 <|endoftext|>。"}';
    expect(stripModelSpecialTokens(input)).toBe(input);
    expect(stripModelSpecialTokens(`<|begin_of_box|>${input}<|end_of_box|>`)).toBe(input);
    const truncated = '{"front":"正文以字面量 <|im_end|>';
    expect(stripModelSpecialTokens(truncated)).toBe(truncated);
  });

  it('error_content_is_repairable_rejects_pure_special_token', () => {
    expect(errorContentIsRepairable('<|end_of_box|>')).toBe(false);
    expect(errorContentIsRepairable('  \n<|end_of_box|>\n  ')).toBe(false);
    expect(errorContentIsRepairable('')).toBe(false);
    expect(errorContentIsRepairable('   ')).toBe(false);
  });

  it('error_content_is_repairable_rejects_error_message_without_raw_output', () => {
    expect(errorContentIsRepairable('解析卡片失败: 卡片缺少或无法识别 template_id，无法在多模板场景解析字段。')).toBe(false);
    expect(errorContentIsRepairable(errorCardContent('缺少 template_id', '{"Question": "什么是拉格朗日中值定理"}'))).toBe(true);
  });

  it('deck_tag_skips_default_and_normalizes_whitespace', () => {
    expect(deckTag('Default')).toBeNull();
    expect(deckTag('  ')).toBeNull();
    expect(deckTag('有机化学::烯烃加成')).toBe('有机化学::烯烃加成');
    expect(deckTag('Organic Chem::Alkenes')).toBe('Organic_Chem::Alkenes');
  });

  it('placeholder_cards_are_detected', () => {
    expect(isPlaceholderCard({ template_id: 'design-footer', Question: 'placeholder' })).toBe(true);
    expect(isPlaceholderCard({ fields: { Front: '...', Back: '[TODO]' } })).toBe(true);
    expect(isPlaceholderCard({ template_id: 'design-footer', Question: 'placeholder', Answer: '罗尔定理的推广' })).toBe(false);
    expect(isPlaceholderCard({ template_id: 'x' })).toBe(false);
  });

  it('error_card_content_keeps_bounded_raw_output', () => {
    const raw = 'x'.repeat(ERROR_CARD_RAW_PREVIEW_CHARS + 50);
    const content = errorCardContent('bad', raw);
    expect(content.startsWith('解析卡片失败: bad\n原始输出: ')).toBe(true);
    expect((content.match(/x/gu) ?? []).length).toBe(ERROR_CARD_RAW_PREVIEW_CHARS);
  });

  it('error_content_is_repairable_accepts_truncated_card_fragment', () => {
    expect(errorContentIsRepairable('{"front": "什么是流式解析')).toBe(true);
    expect(errorContentIsRepairable('<|begin_of_box|>{"front": "未闭合的卡片')).toBe(true);
  });

  // -------------------- clean_json_string --------------------

  it('clean_json_string_strips_json_fence', () => {
    const cleaned = service.cleanJsonString('```json\n{"front":"问题","back":"答案"}\n```');
    expect(cleaned).toBe('{"front":"问题","back":"答案"}');
    expect(() => JSON.parse(cleaned)).not.toThrow();
  });

  it('clean_json_string_strips_plain_fence', () => {
    expect(service.cleanJsonString('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('clean_json_string_strips_bom_prefix', () => {
    expect(service.cleanJsonString('\uFEFF{"a":1}')).toBe('{"a":1}');
  });

  it('clean_json_string_extracts_object_from_surrounding_noise', () => {
    expect(service.cleanJsonString('好的，以下是生成的卡片：\n{"front":"Q","back":"A"}\n希望对你有帮助')).toBe('{"front":"Q","back":"A"}');
  });

  it('clean_json_string_preserves_unicode_content', () => {
    const raw = '```json\n{"front":"ひらがな カタカナ 한국어"}\n```';
    const parsed = JSON.parse(service.cleanJsonString(raw)) as Record<string, unknown>;
    expect(parsed['front']).toBe('ひらがな カタカナ 한국어');
  });

  it('clean_json_string_falls_back_when_no_object', () => {
    expect(service.cleanJsonString('  not json at all  ')).toBe('not json at all');
  });

  // -------------------- extract_fields_with_rules --------------------

  it('extract_fields_required_missing_without_default_is_validation_error', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      back: makeRule(true, 'Text', '背面'),
    };
    await expect(service.extractFieldsWithRules({ front: '只有正面' }, rules, null)).rejects.toThrow(/缺少必需字段.*back/su);
  });

  it('extract_fields_prefers_semantic_fields_over_template_order', async () => {
    const rules: Record<string, FieldExtractionRule__De> = {};
    for (const field of ['ID', 'Question', 'Formula', 'Expl']) rules[field] = makeRule(false, 'Text', field);
    const fields = ['ID', 'Question', 'Formula', 'Expl'];
    const first = await service.extractFieldsWithRules(
      { ID: 'LMT-01', Question: '拉格朗日中值定理', Formula: "f(b)-f(a)=f'(ξ)(b-a)", Expl: '连续且可导' },
      rules,
      fields,
    );
    expect(first.front).toBe('拉格朗日中值定理');
    expect(first.back).toBe('连续且可导');
    expect(first.extra_fields['id']).toBe('LMT-01');

    const choiceRules: Record<string, FieldExtractionRule__De> = {};
    for (const field of ['Subject', 'Question', 'optiona', 'optionb', 'correct', 'explanation']) {
      choiceRules[field] = makeRule(false, 'Text', field);
    }
    const second = await service.extractFieldsWithRules(
      {
        Subject: '高等数学',
        Question: '易错点是？',
        optiona: '忘记验证连续性',
        optionb: '以上都是',
        correct: 'B',
        explanation: '两个条件缺一不可',
      },
      choiceRules,
      ['Subject', 'Question'],
    );
    expect(second.front).toBe('易错点是？');
    expect(second.back).toContain('正确答案：B');
  });

  it('extract_fields_required_missing_uses_default_value', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      back: makeRule(true, 'Text', '背面', { default_value: '默认背面' }),
    };
    const parsed = await service.extractFieldsWithRules({ front: '问题' }, rules, null);
    expect(parsed.front).toBe('问题');
    expect(parsed.back).toBe('默认背面');
  });

  it('extract_fields_happy_path_with_tags_and_extra_fields', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      back: makeRule(true, 'Text', '背面'),
      tags: makeRule(false, 'Array', '标签'),
      note: makeRule(false, 'Text', '备注'),
    };
    const parsed = await service.extractFieldsWithRules(
      { front: '什么是惯性？', back: '物体保持运动状态的性质', tags: ['物理', '力学'], note: '补充说明' },
      rules,
      null,
    );
    expect(parsed.front).toBe('什么是惯性？');
    expect(parsed.back).toBe('物体保持运动状态的性质');
    expect(parsed.tags).toEqual(['物理', '力学']);
    expect(parsed.extra_fields['note']).toBe('补充说明');
    expect(parsed.extra_fields['front']).toBe('什么是惯性？');
  });

  it('extract_fields_reads_nested_fields_object_case_insensitively', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      back: makeRule(true, 'Text', '背面'),
    };
    const parsed = await service.extractFieldsWithRules(
      { template_id: 'design-lab', fields: { Front: '嵌套问题', Back: '嵌套答案' } },
      rules,
      null,
    );
    expect(parsed.front).toBe('嵌套问题');
    expect(parsed.back).toBe('嵌套答案');
  });

  it('extract_fields_text_field_maps_to_cloze_front_back', async () => {
    const parsed = await service.extractFieldsWithRules(
      { Text: '水的沸点是{{c1::100}}摄氏度' },
      { text: makeRule(true, 'Text', '填空文本') },
      null,
    );
    expect(parsed.extra_fields['text']).toBe('水的沸点是{{c1::100}}摄氏度');
    expect(parsed.front).toBe('水的沸点是{{c1::100}}摄氏度');
    expect(parsed.back.startsWith('填空题：')).toBe(true);
  });

  // -------------------- clean_template_placeholders --------------------

  it('clean_template_placeholders_removes_empty_mustache_tags', () => {
    expect(service.cleanTemplatePlaceholders('  前缀{{.}}中间{{/}}再{{#}}然后{{}}空格{{ }}双空格{{  }}尾部  ')).toBe(
      '前缀中间再然后空格双空格尾部',
    );
  });

  it('clean_template_placeholders_preserves_named_tags_and_cloze', () => {
    expect(service.cleanTemplatePlaceholders('{{Front}} 与 {{c1::答案}} 应原样保留')).toBe('{{Front}} 与 {{c1::答案}} 应原样保留');
  });

  // -------------------- buffer 分隔符切分与硬上限 --------------------

  it('extract_card_standard_delimiter_splits_buffer', () => {
    const buffer = { text: '{"front":"Q"}<<<ANKI_CARD_JSON_END>>>{"front":"下一张' };
    expect(extractCardFromBufferImpl(buffer)).toEqual({ ok: true, card: '{"front":"Q"}' });
    expect(buffer.text).toBe('{"front":"下一张');
    expect(extractCardFromBufferImpl(buffer)).toBeNull();
  });

  it('extract_card_repairs_corrupted_delimiter', () => {
    const buffer = { text: '{"a":1}\n<<< ANKI_CARD_JSON_END>>>tail' };
    expect(extractCardFromBufferImpl(buffer)).toEqual({ ok: true, card: '{"a":1}' });
    expect(buffer.text).toBe('tail');
  });

  it('extract_card_ignores_empty_segment_before_delimiter', () => {
    const buffer = { text: '  \n<<<ANKI_CARD_JSON_END>>>next' };
    expect(extractCardFromBufferImpl(buffer)).toBeNull();
    expect(buffer.text).toBe('next');
  });

  it('buffer_at_hard_limit_keeps_accumulating', () => {
    const buffer = { text: 'x'.repeat(CARD_BUFFER_HARD_LIMIT) };
    expect(extractCardFromBufferImpl(buffer)).toBeNull();
    expect(buffer.text.length).toBe(CARD_BUFFER_HARD_LIMIT);
  });

  it('buffer_over_hard_limit_truncates_and_clears', () => {
    const oversized = 'x'.repeat(CARD_BUFFER_HARD_LIMIT + 1);
    const buffer = { text: oversized };
    expect(extractCardFromBufferImpl(buffer)).toEqual({ ok: false, truncated: oversized });
    expect(buffer.text).toBe('');
  });

  it('buffer_hard_limit_is_far_above_legacy_threshold', () => {
    expect(CARD_BUFFER_HARD_LIMIT).toBeGreaterThanOrEqual(1_000_000);
    const buffer = { text: '内容'.repeat(10_000) };
    expect(extractCardFromBufferImpl(buffer)).toBeNull();
    expect(buffer.text.length).toBeGreaterThan(0);
  });

  // -------------------- validate_field_against_rule --------------------

  function violationRules(violations: readonly { rule: string }[]): string[] {
    return violations.map((violation) => violation.rule);
  }

  async function validate(field: string, value: string, rule: FieldExtractionRule__De) {
    return validateFieldAgainstRule(field, value, rule, nativeRegex);
  }

  it('validate_field_passes_without_constraints', async () => {
    expect(await validate('front', '任意内容', makeRule(true, 'Text', '无约束字段'))).toEqual([]);
  });

  it('validate_field_flags_min_length_by_unicode_chars', async () => {
    const rule = makeRule(true, 'Text', '正面', { min_length: 5 });
    const violations = await validate('front', '题目', rule);
    expect(violationRules(violations)).toEqual(['min_length']);
    expect(violations[0]!.message).toContain('长度 2 小于最小长度 5');
    expect(await validate('front', '五个字的题', rule)).toEqual([]);
  });

  it('validate_field_flags_max_length', async () => {
    const rule = makeRule(true, 'Text', '正面', { max_length: 3 });
    expect(violationRules(await validate('front', '超过三个字', rule))).toEqual(['max_length']);
    expect(await validate('front', '三个字', rule)).toEqual([]);
  });

  it('validate_field_flags_allowed_values', async () => {
    const rule = makeRule(true, 'Text', '正确选项', { allowed_values: ['A', 'B', 42] });
    expect(await validate('correct', 'A', rule)).toEqual([]);
    expect(await validate('correct', '42', rule)).toEqual([]);
    const violations = await validate('correct', 'E', rule);
    expect(violationRules(violations)).toEqual(['allowed_values']);
    expect(violations[0]!.field).toBe('correct');
    expect(await validate('correct', '任意', { ...rule, allowed_values: [] })).toEqual([]);
  });

  it('validate_field_flags_validation_pattern', async () => {
    const rule = makeRule(true, 'Text', '编号', { validation_pattern: '^\\d{4}$' });
    expect(await validate('code', '2026', rule)).toEqual([]);
    expect(violationRules(await validate('code', 'abc', rule))).toEqual(['validation_pattern']);
  });

  it('validate_field_skips_uncompilable_pattern', async () => {
    const rule = makeRule(true, 'Text', '编号', { validation_pattern: '[unclosed' });
    expect(await validate('code', 'whatever', rule)).toEqual([]);
    expect(await validate('code', 'whatever', { ...rule, validation_pattern: '   ' })).toEqual([]);
  });

  it('validate_field_accumulates_multiple_violations', async () => {
    const rule = makeRule(true, 'Text', '正面', {
      min_length: 10,
      allowed_values: ['固定答案'],
      validation_pattern: '^\\d+$',
    });
    const violations = await validate('front', 'abc', rule);
    expect(violationRules(violations)).toEqual(['min_length', 'allowed_values', 'validation_pattern']);
    for (const violation of violations) {
      expect(violation.field).toBe('front');
      expect(violation.message.length).toBeGreaterThan(0);
    }
  });

  it('extract_fields_violations_flag_but_do_not_kill_card', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面', { min_length: 20 }),
      back: makeRule(true, 'Text', '背面'),
      correct: makeRule(false, 'Text', '正确选项', { allowed_values: ['A', 'B'] }),
    };
    const parsed = await service.extractFieldsWithRules({ front: '短问题', back: '答案', correct: 'E' }, rules, null);
    expect(parsed.front).toBe('短问题');
    expect(parsed.back).toBe('答案');
    const flags = JSON.parse(parsed.extra_fields[QA_FLAGS_FIELD]!) as Array<Record<string, string>>;
    const flagged = flags.map((flag) => [flag['field'], flag['rule']] as [string, string]).sort();
    expect(flagged).toEqual([
      ['correct', 'allowed_values'],
      ['front', 'min_length'],
    ]);
  });

  it('extract_fields_compliant_card_has_no_qa_flags', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面', { min_length: 2, max_length: 50, validation_pattern: '惯性' }),
      back: makeRule(true, 'Text', '背面'),
    };
    const parsed = await service.extractFieldsWithRules({ front: '什么是惯性？', back: '答案' }, rules, null);
    expect(Object.hasOwn(parsed.extra_fields, QA_FLAGS_FIELD)).toBe(false);
  });

  it('extract_fields_tags_validated_per_item', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      back: makeRule(true, 'Text', '背面'),
      tags: makeRule(false, 'Array', '标签', { max_length: 4 }),
    };
    const parsed = await service.extractFieldsWithRules(
      { front: '问题', back: '答案', tags: ['物理', '远超四个字符的超长标签'] },
      rules,
      null,
    );
    expect(parsed.tags.length).toBe(2);
    const flags = JSON.parse(parsed.extra_fields[QA_FLAGS_FIELD]!) as Array<Record<string, string>>;
    expect(flags.length).toBe(1);
    expect(flags[0]!['field']).toBe('tags');
    expect(flags[0]!['rule']).toBe('max_length');
  });

  it('qa_flags_never_leak_into_fallback_back', async () => {
    const rules = {
      front: makeRule(true, 'Text', '正面'),
      note: makeRule(false, 'Text', '备注', { min_length: 50 }),
    };
    const parsed = await service.extractFieldsWithRules({ front: '问题', note: '短备注' }, rules, null);
    expect(Object.hasOwn(parsed.extra_fields, QA_FLAGS_FIELD)).toBe(true);
    expect(parsed.back).toBe('短备注');
    expect(parsed.back).not.toContain('min_length');
  });

  // -------------------- brace-depth 切卡器 --------------------

  function extract(buffer: { text: string }) {
    return extractCardFromBufferImpl(buffer);
  }

  it('brace_cutter_waits_for_split_json_then_cuts_without_delimiter', () => {
    const buffer = { text: '{"front": "什么是牛顿第一' };
    expect(extract(buffer)).toBeNull();
    expect(buffer.text).toBe('{"front": "什么是牛顿第一');
    buffer.text += '定律？", "back": "惯性定律"}';
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "什么是牛顿第一定律？", "back": "惯性定律"}' });
    expect(buffer.text).toBe('');
  });

  it('brace_cutter_waits_when_nested_object_not_closed', () => {
    const buffer = { text: '{"fields": {"Front": "嵌套问题"' };
    expect(extract(buffer)).toBeNull();
    buffer.text += '}, "template_id": "design-lab"}';
    const result = extract(buffer);
    expect(result).toEqual({ ok: true, card: '{"fields": {"Front": "嵌套问题"}, "template_id": "design-lab"}' });
    if (result?.ok === true) expect(() => JSON.parse(result.card)).not.toThrow();
  });

  it('brace_cutter_extracts_multiple_cards_from_one_chunk', () => {
    const buffer = {
      text: '{"front": "Q1", "back": "A1"}<<<ANKI_CARD_JSON_END>>>{"front": "Q2", "back": "A2"}<<<ANKI_CARD_JSON_END>>>',
    };
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "Q1", "back": "A1"}' });
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "Q2", "back": "A2"}' });
    expect(extract(buffer)).toBeNull();
    expect(buffer.text).toBe('');
  });

  it('brace_cutter_extracts_multiple_cards_without_any_delimiter', () => {
    const buffer = { text: '{"front":"Q1","back":"A1"} {"front":"Q2","back":"A2"}' };
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front":"Q1","back":"A1"}' });
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front":"Q2","back":"A2"}' });
    expect(extract(buffer)).toBeNull();
    expect(buffer.text).toBe('');
  });

  it('brace_cutter_ignores_delimiter_inside_json_string', () => {
    const buffer = { text: '{"front": "输出 <<<ANKI_CARD_JSON_END>>> 有什么作用？", "back": "流式切卡信号"}<<<ANKI_CARD_JSON_END>>>' };
    const result = extract(buffer);
    expect(result).toEqual({ ok: true, card: '{"front": "输出 <<<ANKI_CARD_JSON_END>>> 有什么作用？", "back": "流式切卡信号"}' });
    if (result?.ok === true) {
      expect(result.card).toContain('<<<ANKI_CARD_JSON_END>>>');
      expect(() => JSON.parse(result.card)).not.toThrow();
    }
    expect(buffer.text).toBe('');
  });

  it('brace_cutter_ignores_delimiter_in_string_even_when_json_incomplete', () => {
    const buffer = { text: '{"front": "分隔符 <<<ANKI_CARD_JSON_END>>> 出现在字符串里", "back": "尚未' };
    const snapshot = buffer.text;
    expect(extract(buffer)).toBeNull();
    expect(buffer.text).toBe(snapshot);
    buffer.text += '结束"}';
    const result = extract(buffer);
    if (result?.ok === true) {
      expect(result.card).toContain('<<<ANKI_CARD_JSON_END>>>');
      expect(() => JSON.parse(result.card)).not.toThrow();
    } else {
      throw new Error('expected card');
    }
  });

  it('brace_cutter_handles_escaped_quotes_and_braces_in_strings', () => {
    const buffer = { text: '{"front": "他说：\\"{ 这不是括号 }\\"", "back": "转义\\\\"}' };
    const result = extract(buffer);
    expect(result).toEqual({ ok: true, card: '{"front": "他说：\\"{ 这不是括号 }\\"", "back": "转义\\\\"}' });
    if (result?.ok === true) expect(() => JSON.parse(result.card)).not.toThrow();
    expect(buffer.text).toBe('');
  });

  it('delimiter_still_cuts_unbalanced_fragment_for_backward_compat', () => {
    const buffer = { text: '{"front": "括号缺失"<<<ANKI_CARD_JSON_END>>>{"front": "下一张", "back": "B"}' };
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "括号缺失"' });
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "下一张", "back": "B"}' });
    expect(extract(buffer)).toBeNull();
  });

  it('broken_delimiter_variant_still_recovers_unbalanced_fragment', () => {
    const inside = { text: '{"front": "残片<<< ANKI_CARD_JSON_END>>>"' };
    expect(extract(inside)).toBeNull();
    const outside = { text: '{"front": "残片"<<< ANKI_CARD_JSON_END>>>' };
    expect(extract(outside)).toEqual({ ok: true, card: '{"front": "残片"' });
    expect(outside.text).toBe('');
  });

  it('prose_prefix_is_discarded_when_json_cuts', () => {
    const buffer = { text: '好的，以下是第一张卡片：{"front":"Q","back":"A"}<<<ANKI_CARD_JSON_END>>>' };
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front":"Q","back":"A"}' });
    expect(buffer.text).toBe('');
  });

  it('brace_cutter_handles_multibyte_utf8_safely', () => {
    const buffer = { text: '{"front": "水的沸点🌡️是{{c1::100}}℃"}<<<ANKI_CARD_JSON_END>>>' };
    const result = extract(buffer);
    if (result?.ok !== true) throw new Error('expected card');
    expect(() => JSON.parse(result.card)).not.toThrow();
    expect(result.card).toContain('🌡️');
    expect(buffer.text).toBe('');
  });

  // -------------------- 输出协议升级 --------------------

  it('prompt_and_parser_share_delimiter_constant', () => {
    const payload = buildPrompt('内容', minimalOptions(), 'delimiter');
    expect(payload.user).toContain('<<<ANKI_CARD_JSON_END>>>');
    const buffer = { text: '{"front":"Q","back":"A"}<<<ANKI_CARD_JSON_END>>>' };
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front":"Q","back":"A"}' });
  });

  it('build_prompt_structured_omits_delimiter_and_uses_wrapper', () => {
    for (const protocol of ['json_object', 'json_schema'] as const) {
      const payload = buildPrompt('内容', minimalOptions(), protocol);
      expect(payload.user).not.toContain('<<<ANKI_CARD_JSON_END>>>');
      expect(payload.user).toContain('"cards"');
    }
  });

  it('build_prompt_example_json_is_language_neutral', () => {
    const payload = buildPrompt('content', minimalOptions(), 'delimiter');
    expect(payload.user).toContain('"front": "<question>"');
    expect(payload.user).toContain('"back": "<answer>"');
    expect(payload.user).not.toContain('问题内容');
  });

  it('build_prompt_appends_custom_prompt_instead_of_replacing', () => {
    const options = { ...minimalOptions(), custom_anki_prompt: '每张卡片的 front 必须以疑问句结尾' };
    const payload = buildPrompt('内容', options, 'delimiter');
    expect(payload.system).not.toBeNull();
    const system = payload.system!;
    expect(system).toContain('专业的 Anki 学习卡片制作助手');
    expect(system).toContain('每张卡片的 front 必须以疑问句结尾');
    expect(system).toContain('模板生成说明');
  });

  it('build_prompt_injects_latex_rules_before_base_prompt', () => {
    const options = { ...minimalOptions(), custom_anki_prompt: '模板字段说明' };
    const payload = buildPrompt('内容', options, 'delimiter');
    const system = payload.system!;
    expect(system).toContain('禁止裸露 LaTeX');
    expect(system).toContain('<latex_rules');
    expect(system.indexOf('<latex_rules')).toBeLessThan(system.indexOf('专业的 Anki 学习卡片制作助手'));
  });

  it('cardagent_real_options_full_request_has_single_protocol_source', () => {
    const fixture = fs.readFileSync(
      new URL('../../../../tests/fixtures/anki/cardagent_system_prompt.txt', import.meta.url),
      'utf8',
    );
    expect(fixture).not.toContain('ANKI_CARD_JSON_END');

    const options: AnkiGenerationOptions = {
      deck_name: 'Default',
      note_type: 'Basic',
      enable_images: true,
      max_cards_per_mistake: 10,
      max_cards_total: 10,
      template_id: 'basic',
      template_ids: ['basic'],
      template_descriptions: [{
        id: 'basic', name: 'Basic', description: 'Basic template', fields: ['front', 'back', 'tags'],
      }],
      template_fields: ['front', 'back', 'tags'],
      template_fields_by_id: { basic: ['front', 'back', 'tags'] },
      segment_overlap_size: 200,
      enable_llm_boundary_detection: true,
      custom_anki_prompt: fixture,
      fsrs_feedback: false,
    };

    const structured = buildPrompt('学习材料', options, 'json_schema');
    const system = structured.system!;
    expect(system).toContain('专业的 Anki 记忆卡片制作专家');
    for (const message of [system, structured.user]) {
      expect(message).not.toContain('<<<ANKI_CARD_JSON_END>>>');
    }
    expect(structured.user).toContain('"cards"');

    const delimiter = buildPrompt('学习材料', options, 'delimiter');
    expect(delimiter.system!).not.toContain('<<<ANKI_CARD_JSON_END>>>');
    expect(delimiter.user).toContain('<<<ANKI_CARD_JSON_END>>>');
  });

  it('structured_wrapper_streams_cards_through_existing_cutter', () => {
    const buffer = { text: '' };

    buffer.text += '{"ca';
    expect(stripWrapperPrefix(buffer)).toBe(false);
    expect(extract(buffer)).toBeNull();

    buffer.text += 'rds": [{"front": "Q1", "back": "A1"},';
    expect(stripWrapperPrefix(buffer)).toBe(true);
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "Q1", "back": "A1"}' });
    expect(extract(buffer)).toBeNull();

    buffer.text += '{"front": "Q2", "back": "A2"}]}';
    expect(stripWrapperPrefix(buffer)).toBe(false);
    expect(extract(buffer)).toEqual({ ok: true, card: '{"front": "Q2", "back": "A2"}' });
    expect(extract(buffer)).toBeNull();
    expect(buffer.text.trim()).not.toContain('{');
  });

  it('expand_wrapper_payloads_expands_wrapper_and_repairs_truncation', () => {
    const payloads = service.expandWrapperPayloads('{"cards": [{"front": "Q1", "back": "A1"}, {"front": "Q2", "back": "A2"}]}');
    expect(payloads.length).toBe(2);
    expect(payloads[0]!.json).toContain('Q1');
    expect(payloads[1]!.json).toContain('Q2');
    expect(payloads.every((payload) => !payload.truncated)).toBe(true);

    const repaired = service.expandWrapperPayloads('{"cards": [{"front": "Q1", "back": "A1"}');
    expect(repaired.length).toBe(1);
    expect(repaired[0]!.json).toContain('Q1');
    expect(repaired[0]!.truncated).toBe(false);

    const single = service.expandWrapperPayloads('{"front": "Q", "back": "A"}');
    expect(single).toEqual([{ json: '{"front": "Q", "back": "A"}', truncated: false }]);

    const text = service.expandWrapperPayloads('以上就是全部卡片');
    expect(text).toEqual([{ json: '以上就是全部卡片', truncated: false }]);
  });

  it('expand_wrapper_payloads_marks_mid_string_truncated_last_card', () => {
    const payloads = service.expandWrapperPayloads(
      '{"cards": [{"front": "Q1", "back": "A1"}, {"front": "Q2", "back": "答案说到一半就断',
    );
    expect(payloads.length).toBe(2);
    expect(payloads[0]!.json).toContain('Q1');
    expect(payloads[0]!.truncated).toBe(false);
    expect(payloads[1]!.json).toContain('Q2');
    expect(payloads[1]!.truncated).toBe(true);
  });

  it('response_format_injection_matrix_for_service_options', () => {
    const options = minimalOptions();
    expect(buildResponseFormat('delimiter', options)).toBeNull();
    const format = buildResponseFormat('json_schema', options)!;
    expect(format['type']).toBe('json_schema');
    const jsonSchema = format['json_schema'] as Record<string, unknown>;
    const schema = jsonSchema['schema'] as Record<string, unknown>;
    expect(schema['required']).toEqual([CARDS_WRAPPER_KEY]);

    const [protocol] = resolveOutputProtocol(null, 'unknown');
    expect(protocol).toBe('delimiter');
  });

  // -------------------- Round 4 #3：真实入库路径 --------------------

  it('parse_and_save_card_honors_qa_pass_flag_persistence_contract', async () => {
    const defaultEnabled = structuredOutputOptionsFromOptionsJson('{}');
    expect(defaultEnabled.enable_qa_pass ?? true).toBeTruthy();

    for (const [label, qaPassEnabled, expectFlags] of [
      ['disabled', false, false],
      ['enabled', true, true],
    ] as const) {
      const documentId = `doc-qa-pass-${label}-${crypto.randomUUID()}`;
      const taskId = `qa-pass-${label}-task`;
      releaseDocumentTracker(documentId);
      db.run('DELETE FROM anki_cards WHERE task_id = ?1', [taskId]);
      db.run('DELETE FROM document_tasks WHERE id = ?1', [taskId]);
      seedTask(taskId, documentId, 0);

      const identical = `${label} identical content`;
      const card = await service.parseAndSaveCard(
        JSON.stringify({ front: identical, back: identical }),
        taskId,
        documentId,
        fingerprintOptions(),
        qaPassEnabled,
        null,
      );
      expect(card).not.toBeNull();
      const flags = card!.extra_fields[QA_FLAGS_FIELD];
      expect(flags !== undefined).toBe(expectFlags);
      if (expectFlags) {
        expect(qaFlagCodes(card!.extra_fields)).toContain('front_back_identical');
      }
      const persisted = db.all<Record<string, unknown>>(
        'SELECT extra_fields_json FROM anki_cards WHERE task_id = ?1',
        [taskId],
      );
      expect(persisted.length).toBe(1);
      const persistedExtra = JSON.parse(String(persisted[0]!['extra_fields_json'] ?? '{}')) as Record<string, string>;
      expect(Object.hasOwn(persistedExtra, QA_FLAGS_FIELD)).toBe(expectFlags);
      releaseDocumentTracker(documentId);
    }
  });

  it('parse_and_save_card_rejects_mid_string_truncation_as_error', async () => {
    const documentId = `doc-truncated-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('truncated-task', documentId, 0);
    await expect(
      service.parseAndSaveCard(
        '{"front":"什么是流式解析？","back":"答案在正文中途被截',
        'truncated-task',
        documentId,
        fingerprintOptions(),
        true,
        null,
      ),
    ).rejects.toThrow(/字符串中途截断/u);
    const persisted = db.all('SELECT id FROM anki_cards WHERE task_id = ?1', ['truncated-task']);
    expect(persisted.length).toBe(0);
    releaseDocumentTracker(documentId);
  });

  it('parse_and_save_card_still_repairs_lossless_damage', async () => {
    const documentId = `doc-lossless-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('lossless-task', documentId, 0);
    const card = await service.parseAndSaveCard(
      '{"front":"什么是惯性？","back":"保持原有运动状态的性质",',
      'lossless-task',
      documentId,
      fingerprintOptions(),
      true,
      null,
    );
    expect(card).not.toBeNull();
    expect(card!.front).toBe('什么是惯性？');
    expect(card!.back).toBe('保持原有运动状态的性质');
    expect(card!.is_error_card).toBe(false);
    releaseDocumentTracker(documentId);
  });

  it('parse_and_save_card_persists_original_generation_snapshot', async () => {
    const documentId = `doc-original-basic-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('original-basic-task', documentId, 0);
    const card = await service.parseAndSaveCard(
      '{"front":"  什么是惯性？  ","back":"  保持原有运动状态的性质  "}',
      'original-basic-task',
      documentId,
      fingerprintOptions(),
      true,
      null,
    );
    expect(card).not.toBeNull();
    const snapshot = extractOriginalFromExtras(card!.extra_fields);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.front).toBe(card!.front);
    expect(snapshot!.back).toBe(card!.back);
    expect(snapshot!.text).toBeNull();

    const persisted = db.all<Record<string, unknown>>(
      'SELECT extra_fields_json FROM anki_cards WHERE task_id = ?1',
      ['original-basic-task'],
    );
    expect(persisted.length).toBe(1);
    const persistedExtra = JSON.parse(String(persisted[0]!['extra_fields_json'] ?? '{}')) as Record<string, string>;
    expect(extractOriginalFromExtras(persistedExtra)).toEqual(snapshot);
    releaseDocumentTracker(documentId);
  });

  it('parse_and_save_card_snapshot_includes_cloze_text', async () => {
    const documentId = `doc-original-cloze-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('original-cloze-task', documentId, 0);
    const options = {
      ...minimalOptions(),
      template_fields: ['Text'],
      field_extraction_rules: { text: makeRule(true, 'Text', 'text') },
    };
    const card = await service.parseAndSaveCard(
      '{"text":"水在标准大气压下的沸点是 {{c1::100 摄氏度}}。"}',
      'original-cloze-task',
      documentId,
      options,
      true,
      null,
    );
    expect(card).not.toBeNull();
    const snapshot = extractOriginalFromExtras(card!.extra_fields);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.front).toBe(card!.front);
    expect(snapshot!.back).toBe(card!.back);
    expect(snapshot!.text).toBe(card!.text);
    expect(snapshot!.text ?? '').toContain('{{c1::');
    releaseDocumentTracker(documentId);
  });

  it('parse_and_save_card_does_not_overwrite_existing_original_generation', async () => {
    const documentId = `doc-original-existing-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('original-existing-task', documentId, 0);
    const options = fingerprintOptions();
    options.field_extraction_rules = {
      ...options.field_extraction_rules,
      [ORIGINAL_GENERATION_FIELD]: makeRule(false, 'Text', 'existing snapshot'),
    };
    const card = await service.parseAndSaveCard(
      `{"front":"新问题","back":"新答案","${ORIGINAL_GENERATION_FIELD}":"user-controlled-value"}`,
      'original-existing-task',
      documentId,
      options,
      true,
      null,
    );
    expect(card).not.toBeNull();
    expect(card!.extra_fields[ORIGINAL_GENERATION_FIELD]).toBe('user-controlled-value');
    releaseDocumentTracker(documentId);
  });

  it('oversized_original_generation_failure_does_not_block_card_insert', async () => {
    const documentId = `doc-original-oversized-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('original-oversized-task', documentId, 0);
    const oversizedFront = '界'.repeat(ORIGINAL_GENERATION_MAX_BYTES);
    const card = await service.parseAndSaveCard(
      JSON.stringify({ front: oversizedFront, back: '仍需正常入库' }),
      'original-oversized-task',
      documentId,
      fingerprintOptions(),
      true,
      null,
    );
    expect(card).not.toBeNull();
    expect(Object.hasOwn(card!.extra_fields, ORIGINAL_GENERATION_FIELD)).toBe(false);
    const persisted = db.all<Record<string, unknown>>(
      'SELECT front FROM anki_cards WHERE task_id = ?1',
      ['original-oversized-task'],
    );
    expect(persisted.length).toBe(1);
    expect(persisted[0]!['front']).toBe(card!.front);
    releaseDocumentTracker(documentId);
  });

  it('duplicate_front_across_segments_flagged_and_still_saved', async () => {
    const documentId = `doc-fp-dup-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('fp-task-a', documentId, 0);
    seedTask('fp-task-b', documentId, 1);
    const options = fingerprintOptions();

    const first = await service.parseAndSaveCard(
      '{"front":"什么是 TCP？","back":"传输控制协议"}', 'fp-task-a', documentId, options, true, null,
    );
    expect(first).not.toBeNull();
    expect(qaFlagCodes(first!.extra_fields)).not.toContain('duplicate_in_document');

    const second = await service.parseAndSaveCard(
      '{"front":"<b>什么是TCP</b>","back":"Transmission Control Protocol"}', 'fp-task-b', documentId, options, true, null,
    );
    expect(second).not.toBeNull();
    expect(qaFlagCodes(second!.extra_fields)).toContain('duplicate_in_document');
    expect(db.all('SELECT id FROM anki_cards WHERE task_id = ?1', ['fp-task-a']).length).toBe(1);
    expect(db.all('SELECT id FROM anki_cards WHERE task_id = ?1', ['fp-task-b']).length).toBe(1);
    releaseDocumentTracker(documentId);
  });

  it('near_duplicate_front_flagged_but_not_dropped', async () => {
    const documentId = `doc-fp-near-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('fp-near-task', documentId, 0);
    const options = fingerprintOptions();

    await service.parseAndSaveCard(
      '{"front":"细胞膜的主要成分是磷脂双分子层","back":"生物膜基础"}', 'fp-near-task', documentId, options, true, null,
    );
    const near = await service.parseAndSaveCard(
      '{"front":"细胞膜的主要成分是磷脂双分子层结构","back":"生物膜基础知识"}', 'fp-near-task', documentId, options, true, null,
    );
    expect(near).not.toBeNull();
    const codes = qaFlagCodes(near!.extra_fields);
    expect(codes).toContain('near_duplicate');
    expect(codes).not.toContain('duplicate_in_document');
    releaseDocumentTracker(documentId);
  });

  it('fingerprint_state_isolated_between_documents', async () => {
    const docA = `doc-fp-iso-a-${crypto.randomUUID()}`;
    const docB = `doc-fp-iso-b-${crypto.randomUUID()}`;
    releaseDocumentTracker(docA);
    releaseDocumentTracker(docB);
    seedTask('fp-iso-task-a', docA, 0);
    seedTask('fp-iso-task-b', docB, 0);
    const options = fingerprintOptions();

    await service.parseAndSaveCard(
      '{"front":"什么是渗透压？","back":"溶剂分子跨膜净流动的驱动力"}', 'fp-iso-task-a', docA, options, true, null,
    );
    const other = await service.parseAndSaveCard(
      '{"front":"什么是渗透压？","back":"溶剂分子跨膜净流动的驱动力"}', 'fp-iso-task-b', docB, options, true, null,
    );
    expect(other).not.toBeNull();
    const codes = qaFlagCodes(other!.extra_fields);
    expect(codes).not.toContain('duplicate_in_document');
    expect(codes).not.toContain('near_duplicate');
    releaseDocumentTracker(docA);
    releaseDocumentTracker(docB);
  });

  it('vlm_occlusion_draft_is_merged_into_extra_fields_without_rewriting_card', async () => {
    const documentId = `doc-occlusion-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('occlusion-task', documentId, 0);
    const marker = buildOcclusionDraftMarker('image-source-1', '[IMAGE_DESC: 输入层；隐藏层；输出层]');
    expect(marker).not.toBeNull();
    const fields = extractOcclusionDraftFields(marker!);
    expect(fields).not.toBeNull();

    const card = await service.parseAndSaveCard(
      '{"front":"神经网络包含哪些层？","back":"输入层、隐藏层和输出层"}',
      'occlusion-task',
      documentId,
      fingerprintOptions(),
      true,
      fields,
    );
    expect(card).not.toBeNull();
    expect(card!.front).toBe('神经网络包含哪些层？');
    expect(card!.back).toBe('输入层、隐藏层和输出层');
    expect(Object.hasOwn(card!.extra_fields, '_occlusion')).toBe(true);
    expect(card!.tags).toContain('image-occlusion');
    expect(card!.text).toBe(fields!.text);
    expect(card!.text ?? '').toContain('<img src="image-source-1"><br>');
    expect(card!.text ?? '').toContain('{{c1::');
    expect(card!.images).toEqual(['image-source-1']);
    releaseDocumentTracker(documentId);
  });

  it('plain_card_without_occlusion_keeps_images_empty', async () => {
    const documentId = `doc-plain-images-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('plain-images-task', documentId, 0);
    const card = await service.parseAndSaveCard(
      '{"front":"什么是熵？","back":"系统混乱程度的度量"}',
      'plain-images-task',
      documentId,
      fingerprintOptions(),
      true,
      null,
    );
    expect(card).not.toBeNull();
    expect(card!.images).toEqual([]);
    expect(Object.hasOwn(card!.extra_fields, '_occlusion')).toBe(false);
    expect(card!.text).toBeNull();
    releaseDocumentTracker(documentId);
  });

  it('occlusion_draft_does_not_overwrite_model_written_text', async () => {
    const documentId = `doc-occlusion-text-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('occlusion-text-task', documentId, 0);
    const options = {
      ...minimalOptions(),
      template_fields: ['Text'],
      field_extraction_rules: { text: makeRule(true, 'Text', 'text') },
    };
    const marker = buildOcclusionDraftMarker('image-source-2', '[IMAGE_DESC: 定子；转子]');
    expect(marker).not.toBeNull();
    const fields = extractOcclusionDraftFields(marker!);
    expect(fields).not.toBeNull();
    expect(fields!.text).toContain('<img src="image-source-2">');

    const card = await service.parseAndSaveCard(
      '{"text":"电动机把电能转化为 {{c1::机械能}}。"}',
      'occlusion-text-task',
      documentId,
      options,
      true,
      fields,
    );
    expect(card).not.toBeNull();
    expect(card!.text).toBe('电动机把电能转化为 {{c1::机械能}}。');
    expect(card!.text ?? '').not.toContain('<img');
    expect(Object.hasOwn(card!.extra_fields, '_occlusion')).toBe(true);
    expect(card!.images).toEqual(['image-source-2']);
    releaseDocumentTracker(documentId);
  });

  it('occlusion_pending_placeholder_image_ref_stays_out_of_images', async () => {
    const documentId = `doc-occlusion-pending-${crypto.randomUUID()}`;
    releaseDocumentTracker(documentId);
    seedTask('occlusion-pending-task', documentId, 0);
    const marker = buildOcclusionDraftMarker('vlm://pending-image', '[IMAGE_DESC: 主动脉；肺动脉]');
    expect(marker).not.toBeNull();
    const fields = extractOcclusionDraftFields(marker!);
    expect(fields).not.toBeNull();

    const card = await service.parseAndSaveCard(
      '{"front":"心脏的大血管有哪些？","back":"主动脉和肺动脉"}',
      'occlusion-pending-task',
      documentId,
      fingerprintOptions(),
      true,
      fields,
    );
    expect(card).not.toBeNull();
    expect(card!.images).toEqual([]);
    expect(Object.hasOwn(card!.extra_fields, '_occlusion')).toBe(true);
    expect(card!.tags).toContain('image-occlusion');
    releaseDocumentTracker(documentId);
  });

  // -------------------- Wave2-E Round 3 事件载荷 --------------------

  it('critic_summary_event_contains_gold_and_routing_fields', () => {
    const event = buildCriticSummaryEvent('task-1', 'doc-1', {
      examined: 5,
      kept: 3,
      revised: 1,
      flagged: 1,
      rejected_unknown_ids: 0,
      skipped_over_budget: 2,
      gold_references: 4,
      gold_references_truncated: 1,
      persist_failures: 0,
      degraded: null,
      routed_config_id: 'cfg-critic',
      routed_model: 'model-x',
      routed_degraded: false,
    });
    const inner = event['CriticSummary'] as Record<string, unknown>;
    expect(inner['task_id']).toBe('task-1');
    expect(inner['document_id']).toBe('doc-1');
    expect(inner['gold_references']).toBe(4);
    expect(inner['gold_references_truncated']).toBe(1);
    expect(inner['routed_config_id']).toBe('cfg-critic');
    expect(inner['routed_model']).toBe('model-x');
    expect(inner['routed_degraded']).toBe(false);
    expect(inner['examined']).toBe(5);
    expect(inner['skipped_over_budget']).toBe(2);
  });

  it('critic_summary_event_omits_routing_when_unrouted', () => {
    const event = buildCriticSummaryEvent('task-2', 'doc-2', {
      examined: 1,
      kept: 1,
      revised: 0,
      flagged: 0,
      rejected_unknown_ids: 0,
      skipped_over_budget: 0,
      gold_references: 0,
      gold_references_truncated: 0,
      persist_failures: 0,
      degraded: null,
      routed_config_id: null,
      routed_model: null,
      routed_degraded: null,
    });
    const inner = event['CriticSummary'] as Record<string, unknown>;
    expect(Object.hasOwn(inner, 'routed_config_id')).toBe(false);
    expect(Object.hasOwn(inner, 'routed_model')).toBe(false);
    expect(Object.hasOwn(inner, 'routed_degraded')).toBe(false);
    expect(inner['gold_references']).toBe(0);
  });

  it('task_completed_event_flags_warnings_when_dropped', () => {
    const event = buildTaskCompletedEvent('task-3', 'doc-3', {
      card_count: 7,
      failed_cards: 0,
      duplicate_cards: 0,
      dropped_fragments: 2,
      flagged_cards: 0,
    });
    const inner = event['TaskCompleted'] as Record<string, unknown>;
    expect(inner['completed_with_warnings']).toBe(true);
    expect(inner['dropped_fragments']).toBe(2);
    expect(inner['failed_cards']).toBe(0);
    expect(inner['duplicate_cards']).toBe(0);
    expect(inner['flagged_cards']).toBe(0);
    expect(inner['task_id']).toBe('task-3');
    expect(inner['document_id']).toBe('doc-3');
    expect(inner['total_cards_generated']).toBe(7);
    expect(inner['final_status']).toBe('Completed');
  });

  it('task_completed_event_clean_run_has_no_warning_flag', () => {
    const event = buildTaskCompletedEvent('task-4', 'doc-4', {
      card_count: 3,
      failed_cards: 0,
      duplicate_cards: 0,
      dropped_fragments: 0,
      flagged_cards: 0,
    });
    const inner = event['TaskCompleted'] as Record<string, unknown>;
    expect(inner['completed_with_warnings']).toBe(false);
    expect(inner['total_cards_generated']).toBe(3);
  });

  it('stream_stats_warning_and_signal_predicates', () => {
    expect(statsHasWarnings(defaultStreamStats())).toBe(false);
    expect(statsHasAnySignal(defaultStreamStats())).toBe(false);
    const okOnly = { ...defaultStreamStats(), card_count: 2 };
    expect(statsHasWarnings(okOnly)).toBe(false);
    expect(statsHasAnySignal(okOnly)).toBe(true);
    for (const key of ['failed_cards', 'duplicate_cards', 'dropped_fragments', 'flagged_cards'] as const) {
      const stats = { ...defaultStreamStats(), [key]: 1 };
      expect(statsHasWarnings(stats)).toBe(true);
      expect(statsHasAnySignal(stats)).toBe(true);
    }
  });
});

