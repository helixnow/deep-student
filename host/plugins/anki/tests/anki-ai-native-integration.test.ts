/**
 * `tests/anki_ai_native_integration.rs` 中 L16 归属的 15 条测试。
 *
 * 覆盖 qa_lint 规则抽样 / merge_flags 幂等、preference 检索预算、
 * fsrs feedback 纯函数链、anki_protocol 能力探测与 repair/wrapper，
 * 以及 eval fixture 基线。transform / script / plan_route / analyze
 * 这 14 条属于 L24-chatanki 的实现面，本 lane 不复制其内部逻辑，
 * 保留在 TESTMAP pending 并报告跨 lane 依赖。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import {
  buildProfile,
  buildInterferenceHints,
  charCount,
  defaultFsrsFeedbackConfig,
  renderInterferenceSection,
  renderProfileSection,
  suggestSplits,
  type FsrsFeedbackRow,
  type UserReviewProfile,
} from '../src/anki-fsrs-feedback.ts';
import {
  CARDS_WRAPPER_KEY,
  CARD_DELIMITER,
  TEMPLATE_ID_KEY,
  buildCardsResponseSchema,
  detectSchemaCapability,
  isStructuredProtocol,
  repairJson,
  repairJsonDetailed,
  resolveOutputProtocol,
  stripWrapperPrefix,
  unwrapCardsArray,
} from '../src/anki-protocol.ts';
import {
  FingerprintTracker,
  QA_FLAGS_FIELD,
  defaultLintConfig,
  lintCard,
  lintCardWithTracker,
  mergeFlags,
  shouldReject,
  type CardLintInput,
  type LintConfig,
} from '../src/anki-qa-lint.ts';
import {
  consolidate,
  createPreferenceStore,
  createSessionObservation,
  estimateTokens,
  extractPreferences,
  retrievePreferencePrompt,
} from '../src/preference-memory.ts';

function input(
  front: string,
  back: string,
  text: string | null,
  tags: string[],
  extraFields: Record<string, string> = {},
): CardLintInput {
  return { front, back, text, tags, extra_fields: extraFields };
}

function makeRow(
  id: string,
  front: string,
  lapses: number,
  tags: string[],
  template: string | null,
): FsrsFeedbackRow {
  return {
    ankiCardId: id,
    front,
    templateId: template,
    tags,
    state: 2,
    stability: 3.0,
    lapses,
    reps: lapses + 2,
    dueMs: 0,
    lastReviewMs: 1_000,
  };
}

function emptyOptions(): AnkiGenerationOptions {
  return {
    deck_name: 'integration-test',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 10,
  };
}

function evalFixtureRoot(): URL {
  return new URL('../../../../tests/fixtures/anki-eval/', import.meta.url);
}

function fixtureManifest(): {
  delimiter: string;
  cases: Array<Record<string, unknown>>;
} {
  const raw = readFileSync(new URL('manifest.json', evalFixtureRoot()), 'utf8');
  return JSON.parse(raw) as { delimiter: string; cases: Array<Record<string, unknown>> };
}

describe('tests/anki_ai_native_integration.rs', () => {
  it('qa_lint_error_rules_sample_hits_expected_codes', () => {
    const cfg = defaultLintConfig();
    const codes = (value: CardLintInput): Set<string> =>
      new Set(lintCard(value, cfg).map((issue) => issue.code));

    const identical = codes(input('<b>什么是 TCP</b>', '什么是TCP？', null, ['网络']));
    expect(identical.has('front_back_identical')).toBe(true);

    const empty = codes(input('   ', '', null, []));
    expect(empty.has('empty_front')).toBe(true);
    expect(empty.has('empty_back')).toBe(true);

    const cloze = codes(input('Q', 'A', '{{c1::}} 与 {{c0::零}}', ['生物']));
    expect(cloze.has('cloze_empty_answer')).toBe(true);
    expect(cloze.has('cloze_bad_index')).toBe(true);

    const placeholder = codes(input('请解释 {{DOCUMENT_CONTENT}}', '……', null, ['占位']));
    expect(placeholder.has('placeholder_residue')).toBe(true);

    const mcqFields: Record<string, string> = {
      optionA: '水',
      optionB: '火',
      correct: 'C',
    };
    const mcq = codes(input('下列哪项正确？', 'C', null, ['选择题'], mcqFields));
    expect(mcq.has('mcq_answer_not_in_options')).toBe(true);
  });

  it('qa_lint_warn_info_rules_sample_hits_expected_codes_and_severities', () => {
    const cfg = defaultLintConfig();

    const issues = lintCard(
      input(
        '细胞膜的主要成分是磷脂双分子层吗？为什么它具有流动性？',
        '磷脂双分子层',
        null,
        [],
      ),
      cfg,
    );
    const byCode = new Map(issues.map((issue) => [issue.code, issue.severity]));
    expect(byCode.get('answer_leak')).toBe('warn');
    expect(byCode.get('multi_concept')).toBe('warn');
    expect(byCode.get('tags_empty')).toBe('info');

    const tightCfg: LintConfig = { ...defaultLintConfig(), max_front_chars: 10 };
    const long = lintCard(
      input('这是一个超过十个字符的超长正面问题文本', '短答案', null, ['长度']),
      tightCfg,
    );
    expect(
      long.some((issue) => issue.code === 'front_too_long' && issue.severity === 'warn'),
    ).toBe(true);

    const mixed = lintCard(
      input(
        '什么是 photosynthesis biological process mechanism overview 的核心步骤与调控因素说明？',
        '光反应与暗反应两个阶段',
        null,
        ['生物'],
      ),
      cfg,
    );
    for (const issue of mixed.filter((candidate) => candidate.code === 'mixed_language')) {
      expect(issue.severity).toBe('info');
    }
  });

  it('qa_lint_duplicate_tracking_and_reject_semantics', () => {
    const cfg = defaultLintConfig();
    const tracker = new FingerprintTracker();

    const first = lintCardWithTracker(
      input('什么是TCP？', '传输控制协议', null, ['网络']),
      cfg,
      tracker,
    );
    expect(first.some((issue) => issue.code === 'duplicate_card')).toBe(false);

    const second = lintCardWithTracker(
      input('<b>什么是 tcp</b>', '一种传输层协议', null, ['网络']),
      cfg,
      tracker,
    );
    expect(
      second.some((issue) => issue.code === 'duplicate_in_document'),
      `HTML/大小写/空白差异不影响指纹: ${JSON.stringify(second)}`,
    ).toBe(true);

    const errorIssues = lintCard(input('', '', null, []), cfg);
    expect(errorIssues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(shouldReject(errorIssues, cfg), 'Flag 级永不拒绝').toBe(false);
    const rejectCfg: LintConfig = { ...defaultLintConfig(), level: 'reject' };
    expect(shouldReject(errorIssues, rejectCfg)).toBe(true);
    expect(shouldReject(second, rejectCfg), 'Warn/Info 永不触发拒绝').toBe(false);
  });

  it('qa_lint_merge_flags_is_idempotent_and_preserves_legacy_entries', () => {
    const cfg = defaultLintConfig();
    const issues = lintCard(input('TODO 补充问题', '答案', null, ['草稿']), cfg);
    expect(issues.some((issue) => issue.code === 'todo_residue')).toBe(true);

    const extra: Record<string, string> = {
      [QA_FLAGS_FIELD]: JSON.stringify([
        { field: 'front', rule: 'min_length', message: '过短' },
      ]),
    };
    mergeFlags(extra, issues);
    const merged = JSON.parse(extra[QA_FLAGS_FIELD]!) as Array<Record<string, unknown>>;
    expect(merged.some((entry) => entry.rule === 'min_length'), '既有条目保留').toBe(true);
    expect(merged.some((entry) => entry.code === 'todo_residue')).toBe(true);

    const before = extra[QA_FLAGS_FIELD]!;
    mergeFlags(extra, issues);
    const after = JSON.parse(extra[QA_FLAGS_FIELD]!) as Array<Record<string, unknown>>;
    expect((JSON.parse(before) as unknown[]).length).toBe(after.length);

    const clean: Record<string, string> = {};
    mergeFlags(clean, []);
    expect(Object.hasOwn(clean, QA_FLAGS_FIELD)).toBe(false);
  });

  it('preference_retrieve_respects_token_budget_end_to_end', () => {
    const store = createPreferenceStore();
    const observation = createSessionObservation({
      extra_requirements: '请用中文回答，卡片不要超过 20 张，别翻译专业术语',
      template_used: '学术填空题',
      generated_count: 10,
    });
    const candidates = extractPreferences(observation);
    expect(candidates.length, `显式要求应抽出多类偏好: ${JSON.stringify(candidates)}`).toBeGreaterThanOrEqual(2);
    const outcome = consolidate(store, candidates, 1_000);
    expect(outcome.added.length).toBeGreaterThan(0);

    const templates = ['学术填空题'];

    const full = retrievePreferencePrompt(store, '备考生物', templates, 400);
    expect(full).toContain('【用户制卡偏好】');
    expect(full.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(estimateTokens(full), '装箱结果必须在预算内').toBeLessThanOrEqual(400);

    const zero = retrievePreferencePrompt(store, '备考生物', templates, 0);
    expect(zero).toBe('');
    const tiny = retrievePreferencePrompt(store, '备考生物', templates, 1);
    expect(tiny, `连 header 都放不下时必须返回空串: ${JSON.stringify(tiny)}`).toBe('');

    const lines = full.split('\n').slice(1).length;
    expect(lines, `每类偏好最多一条（共 4 类）: ${full}`).toBeLessThanOrEqual(4);
  });

  it('preference_template_filtering_matches_available_templates', () => {
    const store = createPreferenceStore();
    const observation = createSessionObservation({ template_used: '填空' });
    consolidate(store, extractPreferences(observation), 1_000);
    expect(store.entries.length).toBeGreaterThan(0);

    const hit = retrievePreferencePrompt(store, '复习', ['学术填空题'], 200);
    expect(hit, `双向包含匹配应命中: ${JSON.stringify(hit)}`).toContain('填空');

    const miss = retrievePreferencePrompt(store, '复习', ['选择题'], 200);
    expect(miss, `模板不可用时不得注入: ${JSON.stringify(miss)}`).toBe('');
  });

  it('fsrs_suggest_splits_heuristics_cover_enumerated_comparison_and_atomic', () => {
    const enumerated = suggestSplits(
      '细胞呼吸的三个阶段？',
      '1. 糖酵解\n2. 柠檬酸循环\n3. 氧化磷酸化',
      10,
    );
    expect(enumerated).toHaveLength(3);
    expect(enumerated[0]!.front).toContain('要点 1/3');
    expect(enumerated[1]!.back).toBe('柠檬酸循环');

    expect(suggestSplits('酶的特性？', '高效性；专一性；作用条件温和', 2)).toHaveLength(2);

    const comparison = suggestSplits('有丝分裂与减数分裂的区别？', '染色体行为不同等', 10);
    expect(comparison).toHaveLength(2);
    expect(comparison[0]!.front).toContain('有丝分裂');
    expect(comparison[1]!.front).toContain('减数分裂');

    expect(suggestSplits('水的化学式？', 'H2O。', 10), '原子卡不拆').toEqual([]);
    expect(suggestSplits('', 'back', 10)).toEqual([]);
    expect(suggestSplits('front', 'back', 0)).toEqual([]);
  });

  it('fsrs_profile_and_interference_chain_respects_budgets', () => {
    const cfg = defaultFsrsFeedbackConfig();
    cfg.includeCardExcerpts = true;
    const rows = [
      makeRow('card-a', '牛顿第二定律的表达式是什么？', 6, ['力学'], null),
      makeRow('card-b', '牛顿第二定律的适用条件？', 4, ['力学'], null),
      makeRow('card-c', '光合作用发生在哪里？', 0, ['生物'], 'cloze'),
    ];
    const profile: UserReviewProfile = buildProfile(rows, 10_000, cfg);
    expect(profile.totalCards).toBe(3);
    expect(profile.confusableTags[0]!.tag).toBe('力学');
    expect(profile.confusableTags[0]!.totalLapses).toBe(10);
    expect(profile.highLapseCards, 'lapses>=2 的卡才进入示例').toHaveLength(2);

    const section = renderProfileSection(profile, cfg);
    expect(section, '非空画像必须渲染').not.toBeNull();
    expect(section!).not.toContain('数据仅本地');
    expect(section!).not.toContain('不上传');
    expect(charCount(section!)).toBeLessThanOrEqual(cfg.maxProfileChars);

    const hints = buildInterferenceHints(rows, '本章讲牛顿第二定律及其应用', cfg);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((hint) => hint.lapses >= cfg.minLapsesForHint)).toBe(true);
    expect(
      hints.every((hint) => !hint.frontExcerpt.includes('光合作用')),
      '主题无关的卡不得进入干扰预警',
    ).toBe(true);
    const interference = renderInterferenceSection(hints, cfg);
    expect(interference).not.toBeNull();
    expect(charCount(interference!)).toBeLessThanOrEqual(cfg.maxInterferenceChars);
    expect(interference!).toContain('对比卡');

    expect(buildInterferenceHints([], '任意', cfg)).toEqual([]);
    expect(renderInterferenceSection([], cfg)).toBeNull();
  });

  it('protocol_capability_detection_and_resolution_matrix', () => {
    expect(
      detectSchemaCapability('anthropic', null, null, 'https://api.anthropic.com'),
    ).toBe('json_schema');
    expect(
      detectSchemaCapability('openai', null, 'openai', 'https://api.openai.com/v1'),
    ).toBe('json_schema');
    expect(
      detectSchemaCapability('openai', null, 'deepseek', 'https://api.deepseek.com'),
    ).toBe('json_object_only');
    expect(
      detectSchemaCapability('openai', null, null, 'https://my-gateway.example.com/v1'),
    ).toBe('unknown');

    expect(resolveOutputProtocol(null, 'json_schema')).toEqual([
      'json_schema',
      'auto_capability',
    ]);
    expect(resolveOutputProtocol('auto', 'unknown')).toEqual([
      'delimiter',
      'auto_capability_unknown_fallback',
    ]);
    expect(resolveOutputProtocol(null, 'json_object_only')).toEqual([
      'delimiter',
      'auto_json_object_only_fallback',
    ]);
    expect(resolveOutputProtocol('json_schema', 'unknown')).toEqual([
      'json_schema',
      'explicit_request',
    ]);
    expect(resolveOutputProtocol('delimiter', 'json_schema')).toEqual([
      'delimiter',
      'explicit_request',
    ]);
    expect(isStructuredProtocol('json_schema')).toBe(true);
    expect(isStructuredProtocol('delimiter')).toBe(false);
  });

  it('protocol_multi_template_schema_uses_one_of_with_discriminator', () => {
    const options = emptyOptions();
    options.template_fields_by_id = {
      basic: ['front', 'back', 'tags'],
      cloze: ['text', 'tags'],
    };
    const schema = buildCardsResponseSchema(options);
    expect(schema).not.toBeNull();

    expect(schema!.required).toEqual([CARDS_WRAPPER_KEY]);
    const properties = schema!.properties as Record<string, Record<string, unknown>>;
    const items = properties[CARDS_WRAPPER_KEY]!.items as Record<string, unknown>;
    const variants = items.oneOf as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      const variantProperties = variant.properties as Record<string, Record<string, unknown>>;
      const discriminator = variantProperties[TEMPLATE_ID_KEY]!;
      expect(discriminator.type).toBe('string');
      expect((discriminator.enum as unknown[]).length, '判别字段 enum 单值').toBe(1);
      expect((variant.required as unknown[]).includes(TEMPLATE_ID_KEY)).toBe(true);
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it('protocol_repair_json_fixes_high_frequency_stream_damage', () => {
    const trailingComma = repairJson('{"front":"Q","back":"A",}');
    expect(trailingComma).not.toBeNull();
    expect((JSON.parse(trailingComma!) as Record<string, unknown>).back).toBe('A');

    expect(
      repairJson('{"front":"什么是 TC'),
      '字符串中途截断不得被无损接口静默修复',
    ).toBeNull();
    const detailed = repairJsonDetailed('{"front":"什么是 TC');
    expect(detailed, 'detailed 仍可修出合法 JSON').not.toBeNull();
    expect(detailed!.truncated_string, '必须携带截断标记').toBe(true);
    const detailedValue = JSON.parse(detailed!.text) as Record<string, unknown>;
    expect((detailedValue.front as string).startsWith('什么是')).toBe(true);

    const unclosed = repairJson('{"front":"Q","tags":["网络"');
    expect(unclosed, 'unclosed brackets').not.toBeNull();
    const unclosedValue = JSON.parse(unclosed!) as Record<string, unknown>;
    expect((unclosedValue.tags as unknown[])[0]).toBe('网络');

    const tailGarbage = repairJson('{"front":"Q","back":"A"}]}');
    expect(tailGarbage, 'tail garbage').not.toBeNull();
    expect((JSON.parse(tailGarbage!) as Record<string, unknown>).back).toBe('A');

    expect(repairJson('完全没有对象')).toBeNull();
  });

  it('protocol_wrapper_streaming_strip_and_unwrap', () => {
    const partial = { text: '{"ca' };
    expect(stripWrapperPrefix(partial)).toBe(false);
    expect(partial.text).toBe('{"ca');

    const buffer = { text: '  { "cards" : [ {"front":"Q1"}' };
    expect(stripWrapperPrefix(buffer)).toBe(true);
    expect(buffer.text.trimStart().startsWith('{"front"')).toBe(true);

    const plain = { text: '{"front":"Q"}' };
    expect(stripWrapperPrefix(plain)).toBe(false);
    expect(plain.text).toBe('{"front":"Q"}');

    expect(unwrapCardsArray({ cards: [{ front: 'Q' }] })).toHaveLength(1);
    expect(unwrapCardsArray({ data: [] })).toBeNull();
  });

  it('cross_module_repair_then_lint_then_merge_chain', () => {
    const damaged =
      '{"front":"下列关于 TODO 的说法？","back":"答案 A","tags":["网络"],';
    const repaired = repairJson(damaged);
    expect(repaired).not.toBeNull();
    const card = JSON.parse(repaired!) as Record<string, unknown>;

    const front = card.front as string;
    const back = card.back as string;
    const tags = (card.tags as unknown[]).map((tag) => tag as string);

    const extraFields: Record<string, string> = {};
    const issues = lintCard(
      { front, back, text: null, tags, extra_fields: extraFields },
      defaultLintConfig(),
    );
    expect(
      issues.some((issue) => issue.code === 'todo_residue'),
      JSON.stringify(issues),
    ).toBe(true);

    mergeFlags(extraFields, issues);
    const flags = JSON.parse(extraFields[QA_FLAGS_FIELD]!) as Array<Record<string, unknown>>;
    expect(flags.some((flag) => flag.code === 'todo_residue')).toBe(true);
    expect(shouldReject(issues, defaultLintConfig())).toBe(false);
  });

  it('eval_fixture_manifest_stays_consistent_with_production_constants', () => {
    const manifest = fixtureManifest();
    expect(manifest.delimiter, '夹具分隔符必须与 anki_protocol::CARD_DELIMITER 同源').toBe(
      CARD_DELIMITER,
    );

    const cases = manifest.cases;
    expect(cases.length, `基线至少 28 个 fixture，当前 ${cases.length}`).toBeGreaterThanOrEqual(28);

    const seenIds = new Set<string>();
    const allowedOutcomes = new Set(['parse_ok', 'repair_ok', 'error_card']);
    for (const item of cases) {
      const id = item.id as string;
      expect(seenIds.has(id), `case id 重复: ${id}`).toBe(false);
      seenIds.add(id);
      expect(['bad', 'good'], `case ${id} 的 set 非法`).toContain(item.set);
      expect(['stream', 'direct'], `case ${id} 的 entry 非法`).toContain(item.entry);
      const file = item.file as string;
      expect(() => readFileSync(new URL(file, evalFixtureRoot())), `case ${id} 的夹具文件缺失: ${file}`).not.toThrow();
      const expected = item.expected as { cards: Array<Record<string, unknown>> };
      for (const card of expected.cards) {
        const outcome = card.outcome as string;
        expect(allowedOutcomes.has(outcome), `case ${id} 结局非法: ${outcome}`).toBe(true);
      }
    }

    const bad = cases.filter((item) => item.set === 'bad').length;
    const good = cases.filter((item) => item.set === 'good').length;
    expect(bad, `坏样本基线不得缩水（当前 ${bad}）`).toBeGreaterThanOrEqual(22);
    expect(good, `好卡对照组不得缩水（当前 ${good}）`).toBeGreaterThanOrEqual(6);
  });

  it('eval_fixture_repair_expectations_hold_against_production_repair_json', () => {
    const manifest = fixtureManifest();
    let checked = 0;
    for (const item of manifest.cases) {
      if (item.entry !== 'direct') continue;
      const expectedCards = (item.expected as { cards: Array<Record<string, unknown>> }).cards;
      const expected = expectedCards
        .map((card) => card.outcome)
        .filter((outcome): outcome is string => typeof outcome === 'string');
      if (expected.length !== 1) continue;
      const file = item.file as string;
      const content = readFileSync(new URL(file, evalFixtureRoot()), 'utf8');
      const body = content.split(CARD_DELIMITER).join('');
      const outcome = expected[0]!;
      if (outcome === 'parse_ok') {
        expect(
          () => JSON.parse(body.trim()),
          `case ${item.id} 预期 parse_ok 但原文不可解析`,
        ).not.toThrow();
        checked += 1;
      } else if (outcome === 'repair_ok') {
        expect(
          () => JSON.parse(body.trim()),
          `case ${item.id} 预期 repair_ok 但原文已可直接解析（基线应升级为 parse_ok）`,
        ).toThrow();
        expect(
          repairJson(body),
          `case ${item.id} 预期 repair_ok 但生产 repair_json 修不动`,
        ).not.toBeNull();
        checked += 1;
      }
    }
    expect(checked, '至少应存在一个可对照生产 repair_json 的 direct 用例').toBeGreaterThanOrEqual(1);
  });
});
