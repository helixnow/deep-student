/**
 * `crates/dstu-anki/src/anki_qa_lint.rs::tests` 的全量移植（70 个测试）。
 *
 * 每个 `it` 标题与 Rust 测试函数名逐字一致；断言语义（含自定义失败文案）保持对应。
 * 源码扫描类测试（`codes_module_matches_*`）读取本移植的 `anki-qa-*.ts`，
 * 契约清单取自 `anki-gold-set.ts` 的 `LINT_CONTRACT_CODES`。
 */
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { regex } from '../../../platform/native/regex/index.ts';
import { LINT_CONTRACT_CODES } from '../src/anki-gold-set.ts';
import { UNTRUSTED_IMPORT_PROTOCOL_FIELDS } from '../src/apkg-importer.ts';
import type { DecodedFieldExtractionRule } from '../src/templates.ts';
import {
  ALL_LINT_CODES,
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  FingerprintTracker,
  LintIssue,
  QA_FLAGS_FIELD,
  decodeLintConfig,
  defaultLintConfig,
  documentTracker,
  emptyFingerprintObservation,
  issuesFromObservation,
  lintCard,
  lintCardWithTracker,
  lintFieldAgainstRule,
  mergeFlags,
  observeDocumentCard,
  releaseDocumentTracker,
  shouldReject,
  type CardLintInput,
} from '../src/anki-qa-lint.ts';

function emptyExtras(): Record<string, string> {
  return {};
}

function basicInput(
  front: string,
  back: string,
  tagList: string[],
  extras: Record<string, string>,
): CardLintInput {
  return { front, back, text: null, tags: tagList, extra_fields: extras };
}

function issueCodes(issues: readonly LintIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function tags(...values: string[]): string[] {
  return [...values];
}

/** 读取 `_qa_flags` 的 JSON 数组（键缺失/无法解析时直接失败）。 */
function readFlags(extra_fields: Record<string, string>): unknown[] {
  const raw = extra_fields[QA_FLAGS_FIELD];
  if (raw === undefined) throw new Error(`${QA_FLAGS_FIELD} 不存在`);
  return JSON.parse(raw) as unknown[];
}

/** `_qa_flags` 数组中的单个条目（对象断言用）。 */
function flagAt(flags: unknown[], index: number): Record<string, unknown> {
  const entry = flags[index];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`flags[${index}] 不是对象`);
  }
  return entry as Record<string, unknown>;
}

describe('crates/dstu-anki/src/anki_qa_lint.rs::tests', () => {
  // -------- 规则 1：front == back --------

  it('identical_front_back_is_error', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    const input = basicInput('牛顿第一定律', '牛顿第一定律', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('front_back_identical');
    expect(
      issues.some((i) => i.code === 'front_back_identical' && i.severity === 'error'),
    ).toBe(true);
  });

  it('identical_after_html_and_whitespace_normalization', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    const input = basicInput('<b>什么是 TCP？</b>', '什么是TCP', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('front_back_identical');
  });

  it('different_front_back_passes', () => {
    const extras = emptyExtras();
    const t = tags('网络');
    const input = basicInput('TCP 的全称是什么？', '传输控制协议', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('front_back_identical');
  });

  // -------- 规则 2：空字段 --------

  it('empty_front_and_back_are_errors', () => {
    const extras = emptyExtras();
    const t = tags('x');
    const input = basicInput('   ', '\t\n', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    const c = issueCodes(issues);
    expect(c).toContain('empty_front');
    expect(c).toContain('empty_back');
  });

  it('cloze_card_with_text_allows_empty_back', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '水的沸点是{{c1::100}}摄氏度',
      back: '',
      text: '水的沸点是{{c1::100}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    const c = issueCodes(issues);
    expect(c, 'cloze 卡允许空 back').not.toContain('empty_back');
    expect(c).not.toContain('empty_front');
  });

  // -------- 规则 3：cloze --------

  it('valid_cloze_passes', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '',
      back: '',
      text: '水在标准大气压下的沸点是{{c1::100}}摄氏度，冰点是{{c2::0}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issueCodes(issues).some((c) => c.startsWith('cloze_')),
      '合法 cloze 不应报 cloze 违规',
    ).toBe(false);
  });

  it('unclosed_cloze_is_error', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '',
      back: '',
      text: '沸点是{{c1::100 摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('cloze_unclosed');
  });

  it('empty_cloze_answer_is_error', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '',
      back: '',
      text: '沸点是{{c1::}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('cloze_empty_answer');
  });

  it('cloze_index_zero_is_error', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '',
      back: '',
      text: '沸点是{{c0::100}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('cloze_bad_index');
  });

  it('text_field_without_any_cloze_is_flagged', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '沸点',
      back: '100 摄氏度',
      text: '水的沸点是 100 摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('cloze_missing');
  });

  it('cloze_in_front_is_also_scanned', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input = basicInput('沸点是{{c1::}}摄氏度', '100', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issues.some((i) => i.code === 'cloze_empty_answer' && i.field === 'front'),
    ).toBe(true);
  });

  // -------- 规则 4：答案泄露 --------

  it('answer_leak_detected', () => {
    const extras = emptyExtras();
    const t = tags('网络');
    const input = basicInput(
      'TCP 全称是传输控制协议，请问 TCP 的全称是什么？',
      '传输控制协议',
      t,
      extras,
    );
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('answer_leak');
  });

  it('short_back_does_not_trigger_leak', () => {
    const extras = emptyExtras();
    const t = tags('判断');
    // back 仅 1 字符，低于 answer_leak_min_chars，不判泄露
    const input = basicInput('地球是行星吗？答案是或否。', '是', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('answer_leak');
  });

  // -------- 规则 5：双概念 --------

  it('double_question_marks_flag_multi_concept', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    const input = basicInput('什么是惯性？什么是加速度？', '……', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('multi_concept');
  });

  it('fenbie_conjunction_flags_multi_concept', () => {
    const extras = emptyExtras();
    const t = tags('生物');
    const input = basicInput(
      '线粒体和叶绿体的功能分别是什么',
      '线粒体供能；叶绿体光合作用',
      t,
      extras,
    );
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('multi_concept');
  });

  it('single_question_passes_multi_concept', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    const input = basicInput('什么是惯性？', '物体保持原有运动状态的性质', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('multi_concept');
  });

  // -------- 规则 6：front 过长 --------

  it('overlong_front_is_flagged_with_configurable_threshold', () => {
    const extras = emptyExtras();
    const t = tags('历史');
    const longFront = '问'.repeat(50);
    const input = basicInput(longFront, '答案', t, extras);

    const cfg = defaultLintConfig();
    cfg.max_front_chars = 40;
    const issues = lintCard(input, cfg);
    expect(issueCodes(issues)).toContain('front_too_long');

    cfg.max_front_chars = 60;
    const issues2 = lintCard(input, cfg);
    expect(issueCodes(issues2)).not.toContain('front_too_long');
  });

  it('front_length_counts_visible_chars_not_html', () => {
    const extras = emptyExtras();
    const t = tags('x');
    // 大量 HTML 标签但可见文本很短 → 不 flag
    const front = `<div class="very-long-class-name">短问题</div>`;
    const input = basicInput(front, '答', t, extras);
    const cfg = defaultLintConfig();
    cfg.max_front_chars = 10;
    const issues = lintCard(input, cfg);
    expect(issueCodes(issues)).not.toContain('front_too_long');
  });

  // -------- 规则 7：占位符 --------

  it('document_content_placeholder_is_error', () => {
    const extras = emptyExtras();
    const t = tags('x');
    const input = basicInput('请总结 {{DOCUMENT_CONTENT}}', '内容', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issues.some((i) => i.code === 'placeholder_residue' && i.severity === 'error'),
    ).toBe(true);
  });

  it('todo_and_xxx_residue_flagged', () => {
    const extras = emptyExtras();
    const t = tags('x');
    const input = basicInput('什么是惯性？', 'TODO: 补充答案 xxx', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    const c = issueCodes(issues);
    expect(c).toContain('todo_residue');
    expect(c).toContain('xxx_residue');
  });

  it('empty_cjk_brackets_flagged', () => {
    const extras = emptyExtras();
    const t = tags('x');
    const input = basicInput('填空：中国的首都是【】', '北京', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('empty_brackets');
  });

  it('cloze_syntax_is_not_mistaken_for_placeholder', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const input: CardLintInput = {
      front: '',
      back: '',
      text: '沸点是{{c1::100}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('placeholder_residue');
  });

  it('normal_word_with_xx_inside_not_flagged', () => {
    const extras = emptyExtras();
    const t = tags('math');
    // "maxxx" 内嵌于字母上下文，不应命中独立 xxx token：
    // 正则要求两侧非字母数字，"maxxxi" 不命中
    const input = basicInput('What is maxxxi?', 'a name', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('xxx_residue');
  });

  // -------- 规则 8：tags --------

  it('empty_tags_is_info_only', () => {
    const extras = emptyExtras();
    const t: string[] = [];
    const input = basicInput('什么是惯性？', '保持运动状态的性质', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    const tagIssue = issues.find((i) => i.code === 'tags_empty');
    expect(tagIssue).toBeDefined();
    expect(tagIssue?.severity).toBe('info');
    // info 永不导致拒绝
    const cfg = defaultLintConfig();
    cfg.level = 'reject';
    expect(shouldReject(issues, cfg)).toBe(false);
  });

  it('whitespace_only_tags_count_as_empty', () => {
    const extras = emptyExtras();
    const t = tags('  ', '\t');
    const input = basicInput('什么是惯性？', '保持运动状态的性质', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('tags_empty');
  });

  // -------- 规则 9/9b：重复卡 + 近重复 --------

  it('duplicate_front_detected_by_tracker', () => {
    const extras = emptyExtras();
    const t = tags('网络');
    const cfg = defaultLintConfig();
    const tracker = new FingerprintTracker();

    const first = basicInput('什么是 TCP？', '传输控制协议', t, extras);
    const issues1 = lintCardWithTracker(first, cfg, tracker);
    expect(issueCodes(issues1)).not.toContain('duplicate_in_document');

    // HTML/空白/大小写差异不影响指纹
    const second = basicInput('<b>什么是TCP</b>', '传输控制协议', t, extras);
    const issues2 = lintCardWithTracker(second, cfg, tracker);
    expect(issueCodes(issues2)).toContain('duplicate_in_document');
    expect(tracker.len()).toBe(1);
  });

  it('distinct_fronts_not_flagged_as_duplicate', () => {
    const extras = emptyExtras();
    const t = tags('网络');
    const cfg = defaultLintConfig();
    const tracker = new FingerprintTracker();
    const a = basicInput('什么是 TCP？', '传输控制协议', t, extras);
    const b = basicInput('什么是 UDP？', '用户数据报协议', t, extras);
    lintCardWithTracker(a, cfg, tracker);
    const issues = lintCardWithTracker(b, cfg, tracker);
    expect(issueCodes(issues)).not.toContain('duplicate_in_document');
    expect(issueCodes(issues)).not.toContain('near_duplicate');
    expect(tracker.len()).toBe(2);
  });

  it('observe_first_sighting_is_clean', () => {
    const tracker = new FingerprintTracker();
    const obs = tracker.observe('细胞膜的主要成分是什么？');
    expect(obs.exact_duplicate).toBe(false);
    expect(obs.near_duplicate).toBeNull();
    expect(tracker.len()).toBe(1);
  });

  it('near_duplicate_small_edit_flagged_with_similarity', () => {
    const tracker = new FingerprintTracker();
    tracker.observe('细胞膜的主要成分是磷脂双分子层');
    // 小编辑（追加两字）→ bigram Jaccard 14/16 = 0.875 ≥ 0.82
    const obs = tracker.observe('细胞膜的主要成分是磷脂双分子层结构');
    expect(obs.exact_duplicate).toBe(false);
    const sim = obs.near_duplicate ?? Number.NaN;
    expect(Number.isNaN(sim), '小编辑必须判为近重复').toBe(false);
    expect(sim).toBeGreaterThanOrEqual(DEFAULT_NEAR_DUPLICATE_THRESHOLD);
    expect(sim).toBeLessThan(1.0);

    // 经 lint 输出为 near_duplicate flag（warn，不丢卡）
    const issues = issuesFromObservation(obs);
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe('near_duplicate');
    expect(issues[0]?.severity).toBe('warn');
    expect(issues[0]?.message, 'message 应携带相似度百分比').toContain('%');
  });

  it('exact_duplicate_not_double_flagged_as_near_duplicate', () => {
    const tracker = new FingerprintTracker();
    tracker.observe('什么是操作系统？');
    const obs = tracker.observe('什么是操作系统？');
    expect(obs.exact_duplicate).toBe(true);
    expect(obs.near_duplicate, '精确重复不叠加 near_duplicate').toBeNull();
    const issues = issuesFromObservation(obs);
    expect(issueCodes(issues)).toEqual(['duplicate_in_document']);
  });

  it('near_duplicate_threshold_is_configurable', () => {
    // 阈值拉满到 1.0：小编辑不再判近重复
    const strict = FingerprintTracker.withNearDuplicateThreshold(1.0);
    strict.observe('细胞膜的主要成分是磷脂双分子层');
    const strictObs = strict.observe('细胞膜的主要成分是磷脂双分子层结构');
    expect(strictObs.near_duplicate).toBeNull();

    // 阈值放宽到 0.4：语序调整也会被捕获
    const loose = FingerprintTracker.withNearDuplicateThreshold(0.4);
    loose.observe('什么是tcp协议');
    const looseObs = loose.observe('tcp协议是什么');
    expect(looseObs.near_duplicate, '低阈值应捕获语序调整').not.toBeNull();
  });

  it('empty_or_whitespace_front_never_flagged_as_duplicate', () => {
    const tracker = new FingerprintTracker();
    expect(tracker.observe('')).toEqual(emptyFingerprintObservation());
    expect(tracker.observe('   ')).toEqual(emptyFingerprintObservation());
    expect(tracker.observe('<b> </b>')).toEqual(emptyFingerprintObservation());
    expect(tracker.isEmpty(), '空指纹不得登记').toBe(true);
  });

  it('cloze_text_field_preferred_as_duplicate_key', () => {
    const extras = emptyExtras();
    const t = tags('化学');
    const cfg = defaultLintConfig();
    const tracker = new FingerprintTracker();
    // 两张卡 front 不同但 cloze Text 相同 → 判重复
    const a: CardLintInput = {
      front: '渲染视图A',
      back: '',
      text: '水的沸点是{{c1::100}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    const b: CardLintInput = {
      front: '渲染视图B',
      back: '',
      text: '水的沸点是{{c1::100}}摄氏度',
      tags: t,
      extra_fields: extras,
    };
    lintCardWithTracker(a, cfg, tracker);
    const issues = lintCardWithTracker(b, cfg, tracker);
    expect(issueCodes(issues)).toContain('duplicate_in_document');
  });

  it('near_tracked_cap_bounds_index_but_exact_dedup_survives', () => {
    const tracker = new FingerprintTracker();
    tracker.max_near_tracked = 1;
    tracker.observe('第一张完全不同的卡片内容');
    tracker.observe('第二张也完全不同的另一内容');
    // 超过 cap 后：与第二张近似的卡不再判近重复（第二张未入 bigram 索引）
    const capped = tracker.observe('第二张也完全不同的另一内容啊');
    expect(capped.near_duplicate, 'cap 之外不做近重复扫描').toBeNull();
    // 但精确重复检测不受 cap 影响
    const exact = tracker.observe('第二张也完全不同的另一内容');
    expect(exact.exact_duplicate).toBe(true);
  });

  it('duplicate_flags_are_warn_and_never_reject', () => {
    const cfg = defaultLintConfig();
    cfg.level = 'reject';
    const dup = issuesFromObservation({ exact_duplicate: true, near_duplicate: null });
    const near = issuesFromObservation({ exact_duplicate: false, near_duplicate: 0.9 });
    expect(shouldReject(dup, cfg), '重复只 flag 不丢卡').toBe(false);
    expect(shouldReject(near, cfg), '近重复只 flag 不丢卡').toBe(false);
  });

  // -------- 文档级 tracker registry --------

  it('document_tracker_registry_shares_state_across_handles', () => {
    const docId = `doc-registry-share-${process.pid}`;
    releaseDocumentTracker(docId);

    // 模拟两个 segment task 各自取 handle（生产路径的并发形态）
    const handleA = documentTracker(docId);
    const handleB = documentTracker(docId);
    expect(handleA, '同一文档必须共享同一 tracker').toBe(handleB);

    handleA.observe('跨segment共享的front');
    const obs = handleB.observe('跨segment共享的front');
    expect(obs.exact_duplicate, '另一 segment 的 handle 必须看到已登记指纹').toBe(true);

    releaseDocumentTracker(docId);
  });

  it('document_tracker_registry_isolates_documents', () => {
    const docA = `doc-registry-iso-a-${process.pid}`;
    const docB = `doc-registry-iso-b-${process.pid}`;
    releaseDocumentTracker(docA);
    releaseDocumentTracker(docB);

    const issuesA = observeDocumentCard(docA, '同一个front');
    expect(issuesA).toEqual([]);
    // 不同文档看不到彼此的指纹
    const issuesB = observeDocumentCard(docB, '同一个front');
    expect(issuesB, '不同文档必须相互隔离').toEqual([]);
    // 同文档第二次 → 重复
    const issuesA2 = observeDocumentCard(docA, '同一个front');
    expect(issueCodes(issuesA2)).toEqual(['duplicate_in_document']);

    releaseDocumentTracker(docA);
    releaseDocumentTracker(docB);
  });

  it('release_document_tracker_resets_state', () => {
    const docId = `doc-registry-release-${process.pid}`;
    releaseDocumentTracker(docId);

    expect(observeDocumentCard(docId, '释放前的front')).toEqual([]);
    expect(issueCodes(observeDocumentCard(docId, '释放前的front'))).toEqual([
      'duplicate_in_document',
    ]);

    releaseDocumentTracker(docId);
    // 释放后重新懒创建，状态清零
    expect(
      observeDocumentCard(docId, '释放前的front'),
      '释放后不得残留旧指纹',
    ).toEqual([]);
    releaseDocumentTracker(docId);
  });

  it('observe_document_card_blank_inputs_are_noop', () => {
    expect(observeDocumentCard('', '有内容的front')).toEqual([]);
    expect(observeDocumentCard('   ', '有内容的front')).toEqual([]);
    const docId = `doc-registry-blank-${process.pid}`;
    releaseDocumentTracker(docId);
    expect(observeDocumentCard(docId, '')).toEqual([]);
    expect(observeDocumentCard(docId, '  ')).toEqual([]);
    // 空 key 不得登记指纹：随后真实 front 首次出现仍是干净的
    expect(observeDocumentCard(docId, '真实front')).toEqual([]);
    releaseDocumentTracker(docId);
  });

  it('observe_document_card_emits_near_duplicate', () => {
    const docId = `doc-registry-near-${process.pid}`;
    releaseDocumentTracker(docId);
    expect(observeDocumentCard(docId, '细胞膜的主要成分是磷脂双分子层')).toEqual([]);
    const issues = observeDocumentCard(docId, '细胞膜的主要成分是磷脂双分子层结构');
    expect(issueCodes(issues)).toEqual(['near_duplicate']);
    expect(issues[0]?.severity).toBe('warn');
    releaseDocumentTracker(docId);
  });

  it('check_and_insert_back_compat_wrapper', () => {
    const tracker = new FingerprintTracker();
    expect(tracker.checkAndInsert('什么是 TCP？')).toBe(false);
    expect(tracker.checkAndInsert('<b>什么是TCP</b>')).toBe(true);
    expect(tracker.checkAndInsert('')).toBe(false);
  });

  // -------- 规则 10：字段规则 --------

  it('field_rule_min_max_allowed_pattern', async () => {
    const rule: DecodedFieldExtractionRule = {
      field_type: 'Text',
      is_required: true,
      default_value: null,
      validation_pattern: '^[A-D]$',
      description: '正确选项',
      max_length: 1,
      min_length: 1,
      allowed_values: ['A', 'B', 'C', 'D'],
    };
    // "E" 长度合法但 allowed_values 与 pattern 双违规
    const issuesE = await lintFieldAgainstRule('correct', 'E', rule, regex);
    const c = issueCodes(issuesE);
    expect(c).toContain('field_rule_allowed_values');
    expect(c).toContain('field_rule_pattern');
    // "AB" 超长
    const issuesAB = await lintFieldAgainstRule('correct', 'AB', rule, regex);
    expect(issueCodes(issuesAB)).toContain('field_rule_max_length');
    // "" 过短
    const issuesEmpty = await lintFieldAgainstRule('correct', '', rule, regex);
    expect(issueCodes(issuesEmpty)).toContain('field_rule_min_length');
    // "A" 全部通过
    const issuesA = await lintFieldAgainstRule('correct', 'A', rule, regex);
    expect(issuesA).toEqual([]);
  });

  // -------- 规则 11：选择题 --------

  function mcqExtras(
    options: Array<[string, string]>,
    answer: [string, string] | null,
  ): Record<string, string> {
    const m: Record<string, string> = {};
    for (const [k, v] of options) {
      m[k] = v;
    }
    if (answer !== null) {
      m[answer[0]] = answer[1];
    }
    return m;
  }

  it('mcq_valid_card_passes', () => {
    const extras = mcqExtras(
      [
        ['optionA', '地球'],
        ['optionB', '火星'],
        ['optionC', '金星'],
        ['optionD', '木星'],
      ],
      ['correct', 'A'],
    );
    const t = tags('天文');
    const input = basicInput('太阳系中密度最大的行星？', '地球', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues).some((c) => c.startsWith('mcq_'))).toBe(false);
  });

  it('mcq_too_few_options_is_error', () => {
    const extras = mcqExtras(
      [
        ['optionA', '地球'],
        ['optionB', '  '],
      ],
      ['correct', 'A'],
    );
    const t = tags('天文');
    const input = basicInput('哪个是行星？', '地球', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issues.some((i) => i.code === 'mcq_too_few_options' && i.severity === 'error'),
    ).toBe(true);
  });

  it('mcq_answer_letter_without_matching_option_is_error', () => {
    const extras = mcqExtras(
      [
        ['optionA', '地球'],
        ['optionB', '火星'],
      ],
      ['correct', 'C'],
    );
    const t = tags('天文');
    const input = basicInput('哪个是行星？', '金星', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('mcq_answer_not_in_options');
  });

  it('mcq_full_text_answer_matching_option_passes', () => {
    const extras = mcqExtras(
      [
        ['option_a', '地球'],
        ['option_b', '火星'],
      ],
      ['answer', '火星'],
    );
    const t = tags('天文');
    const input = basicInput('哪个是红色行星？', '火星', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('mcq_answer_not_in_options');
  });

  it('mcq_missing_answer_field_is_warn', () => {
    const extras = mcqExtras(
      [
        ['optionA', '地球'],
        ['optionB', '火星'],
      ],
      null,
    );
    const t = tags('天文');
    const input = basicInput('哪个是行星？', '地球', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issues.some((i) => i.code === 'mcq_missing_answer' && i.severity === 'warn'),
    ).toBe(true);
  });

  it('non_mcq_card_skips_mcq_rules', () => {
    const extras = emptyExtras();
    extras['note'] = '补充说明';
    const t = tags('x');
    const input = basicInput('什么是惯性？', '保持运动状态的性质', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues).some((c) => c.startsWith('mcq_'))).toBe(false);
  });

  // -------- 规则 12：语言混杂 --------

  it('heavily_mixed_language_is_info_and_never_rejects', () => {
    const extras = emptyExtras();
    const t = tags('cs');
    const input = basicInput(
      '什么是操作系统调度？',
      '操作系统进程调度指的就是 the process of selecting which ready process runs next 这样一个由内核负责完成的核心决策过程',
      t,
      extras,
    );
    const issues = lintCard(input, defaultLintConfig());
    const issue = issues.find((i) => i.code === 'mixed_language');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('info');
    const cfg = defaultLintConfig();
    cfg.level = 'reject';
    expect(shouldReject(issue === undefined ? [] : [issue], cfg), '语言混杂永不拒绝').toBe(false);
  });

  it('pure_chinese_back_not_flagged_as_mixed', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    const input = basicInput(
      '什么是惯性？',
      '惯性是物体保持原有运动状态不变的性质，是物体的固有属性，与外力无关',
      t,
      extras,
    );
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('mixed_language');
  });

  it('short_terminology_mix_below_threshold_not_flagged', () => {
    const extras = emptyExtras();
    const t = tags('cs');
    // "TCP 协议" 之类短术语混排：字母总量低于阈值，不 flag
    const input = basicInput('TCP 是什么？', 'TCP 协议', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).not.toContain('mixed_language');
  });

  // -------- LintLevel / should_reject --------

  it('default_flag_level_never_rejects_even_errors', () => {
    const extras = emptyExtras();
    const t = tags('x');
    const input = basicInput('同一句话', '同一句话', t, extras);
    const cfg = defaultLintConfig();
    const issues = lintCard(input, cfg);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
    expect(shouldReject(issues, cfg), '默认 flag 级别不丢卡').toBe(false);
  });

  it('reject_level_rejects_only_on_error', () => {
    const cfg = defaultLintConfig();
    cfg.level = 'reject';

    const errorIssue = LintIssue.new('empty_front', 'front', 'x', 'error');
    const warnIssue = LintIssue.new('answer_leak', 'front', 'x', 'warn');

    expect(shouldReject([errorIssue], cfg)).toBe(true);
    expect(shouldReject([warnIssue], cfg)).toBe(false);
    expect(shouldReject([], cfg)).toBe(false);

    cfg.level = 'flag';
    const flagErrorIssue = LintIssue.new('empty_front', 'front', 'x', 'error');
    expect(shouldReject([flagErrorIssue, warnIssue], cfg)).toBe(false);
  });

  // -------- merge_flags --------

  it('merge_flags_preserves_existing_field_rule_entries', () => {
    const extras = emptyExtras();
    // 模拟 extract_fields_with_rules 已写入的字段规则违规
    extras[QA_FLAGS_FIELD] =
      '[{"field":"front","rule":"min_length","message":"长度 3 小于最小长度 20"}]';
    const issues = [LintIssue.new('answer_leak', 'front', '泄露', 'warn')];
    mergeFlags(extras, issues);

    const merged = readFlags(extras);
    expect(merged.length).toBe(2);
    expect(flagAt(merged, 0).rule, '既有条目必须保留在前').toBe('min_length');
    expect(flagAt(merged, 1).code).toBe('answer_leak');
    expect(flagAt(merged, 1).severity).toBe('warn');
  });

  it('merge_flags_is_idempotent_by_code_and_field', () => {
    const extras = emptyExtras();
    const issues = [LintIssue.new('tags_empty', 'tags', '无标签', 'info')];
    mergeFlags(extras, issues);
    mergeFlags(extras, issues); // 重复 merge
    const merged = readFlags(extras);
    expect(merged.length, '重复 merge 不产生重复条目').toBe(1);
  });

  it('merge_flags_no_issues_no_key', () => {
    const extras = emptyExtras();
    mergeFlags(extras, []);
    expect(Object.hasOwn(extras, QA_FLAGS_FIELD), '干净卡片不写 _qa_flags').toBe(false);
  });

  it('merge_flags_wraps_unparseable_legacy_value', () => {
    const extras = emptyExtras();
    extras[QA_FLAGS_FIELD] = 'not-json';
    const issues = [LintIssue.new('tags_empty', 'tags', '无标签', 'info')];
    mergeFlags(extras, issues);
    const merged = readFlags(extras);
    expect(merged.length).toBe(2);
    expect(flagAt(merged, 0).code).toBe('legacy_flags_unparsed');
    expect(flagAt(merged, 0).message).toBe('not-json');
  });

  // -------- 组合与序列化 --------

  it('clean_card_produces_zero_issues', () => {
    const extras = emptyExtras();
    extras['note'] = '牛顿力学基础';
    const t = tags('物理', '力学');
    const input = basicInput('什么是惯性？', '物体保持原有运动状态不变的性质', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issues, '干净卡片必须零违规').toEqual([]);
  });

  it('issue_serializes_to_expected_shape', () => {
    const issue = LintIssue.new('answer_leak', 'front', '泄露', 'warn');
    const v = JSON.parse(JSON.stringify(issue)) as Record<string, unknown>;
    expect(v.code).toBe('answer_leak');
    expect(v.field).toBe('front');
    expect(v.message).toBe('泄露');
    expect(v.severity).toBe('warn');
    // serde 派生顺序：{code, field, message, severity}
    expect(Object.keys(v)).toEqual(['code', 'field', 'message', 'severity']);
  });

  it('config_rules_can_be_disabled_individually', () => {
    const extras = emptyExtras();
    const t: string[] = [];
    const input = basicInput('同一句话？同一句话？', '同一句话', t, extras);
    const cfg = {
      ...defaultLintConfig(),
      check_front_back_identical: false,
      check_multi_concept: false,
      check_tags_empty: false,
      check_answer_leak: false,
    };
    const issues = lintCard(input, cfg);
    expect(issues, '关闭的规则不得产出违规').toEqual([]);
  });

  it('qa_flags_field_name_matches_streaming_service', () => {
    // 各模块独立声明同名常量以避免耦合；此断言守护两侧不漂移
    // （`streaming_anki_service` 尚未移植，改以导入侧的协议字段清单为锚点）。
    expect(QA_FLAGS_FIELD).toBe('_qa_flags');
    expect(UNTRUSTED_IMPORT_PROTOCOL_FIELDS).toContain(QA_FLAGS_FIELD);
  });

  it('lint_config_deserializes_with_serde_defaults', () => {
    // 前端只传部分字段时其余用默认值（serde(default)）
    const cfg = decodeLintConfig(JSON.parse('{"level":"reject","max_front_chars":100}'));
    expect(cfg.level).toBe('reject');
    expect(cfg.max_front_chars).toBe(100);
    expect(cfg.check_cloze).toBe(true);
    expect(cfg.answer_leak_min_chars).toBe(4);
  });

  // -------- codes 模块（稳定常量导出）契约守护 --------

  it('codes_module_matches_emitted_literals', () => {
    // ALL_LINT_CODES 必须与规则实现实际产出的 code 字面量集合完全一致：
    // 新增规则忘了补常量、或常量拼错值，此测试即红。
    const source = readdirSync(new URL('../src/', import.meta.url))
      .filter((name) => /^anki-qa-.*\.ts$/.test(name))
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    const ctor = /LintIssue\.new\(\s*['"]([a-z_]+)['"]/g;
    const jsonCode = /"code":\s*['"]([a-z_]+)['"]/g;
    const emitted = new Set<string>();
    for (const match of source.matchAll(ctor)) emitted.add(match[1] as string);
    for (const match of source.matchAll(jsonCode)) emitted.add(match[1] as string);
    const declared = new Set<string>(ALL_LINT_CODES);
    expect([...emitted].sort()).toEqual([...declared].sort());
  });

  it('codes_module_matches_contract_list', () => {
    // 与 `anki-gold-set.ts` 的 LINT_CONTRACT_CODES 对齐，避免双份清单漂移
    expect(LINT_CONTRACT_CODES.length).toBeGreaterThan(0);
    expect([...new Set(ALL_LINT_CODES)].sort(), 'ALL_LINT_CODES 与 LINT_CONTRACT_CODES 漂移').toEqual(
      [...new Set(LINT_CONTRACT_CODES)].sort(),
    );
  });

  it('codes_module_all_is_exhaustive_and_unique', () => {
    // ALL_LINT_CODES 无重复
    const set = new Set(ALL_LINT_CODES);
    expect(set.size, 'ALL_LINT_CODES 含重复项').toBe(ALL_LINT_CODES.length);
    // ALL_LINT_CODES 覆盖模块内声明的每个 code 常量（漏列即红）
    const source = readFileSync(new URL('../src/anki-qa-types.ts', import.meta.url), 'utf8');
    const decl = /^\s*([A-Z][A-Z0-9_]*): '([a-z][a-z0-9_]*)',$/gm;
    const declared = new Set<string>();
    for (const match of source.matchAll(decl)) declared.add(match[2] as string);
    expect(declared.size).toBeGreaterThan(0);
    expect(declared, 'codes 模块声明的常量与 ALL 清单不一致').toEqual(new Set(ALL_LINT_CODES));
  });

  // -------- 规则 13：bare_latex --------

  it('bare_latex_flags_bare_superscript', () => {
    // issue #462 的 A 批卡原样：`Avo ≥ 10^5` 无 $ 包裹
    const extras = emptyExtras();
    const t = tags('电子技术');
    const input = basicInput('开环电压增益 Avo 很高，通常 Avo ≥ 10^5', '10^5', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    const hit = issues.find((i) => i.code === 'bare_latex');
    expect(hit, '裸上标必须命中').toBeDefined();
    expect(hit?.severity, 'bare_latex 仅 warn，永不拒绝').toBe('warn');
    expect(hit?.field).toBe('front');
  });

  it('bare_latex_flags_backslash_command_and_braced_subscript', () => {
    const extras = emptyExtras();
    const t = tags('数学');
    const input = basicInput('求导', '结果是 \\frac{1}{2}，下标 v_{O}', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues)).toContain('bare_latex');
  });

  it('bare_latex_scans_extra_fields', () => {
    // Formula 字段位于 extra_fields，必须被扫描
    const extras = emptyExtras();
    extras['Formula'] = 'Avo \\geq 10^5';
    const t = tags('电子');
    const input = basicInput('增益', '见公式字段', t, extras);
    const issues = lintCard(input, defaultLintConfig());
    expect(
      issues.some((i) => i.code === 'bare_latex' && i.field === 'Formula'),
    ).toBe(true);
  });

  it('wrapped_math_and_currency_and_code_are_not_flagged', () => {
    const extras = emptyExtras();
    const t = tags('物理');
    // 已用 $...$ / \(...\) 包裹 → 不算裸；货币 $5 到 $10 与行内代码 a^b → 不算裸
    const input = basicInput(
      '电容定义为 $C=$ 与 \\(E=\\dfrac{\\sigma}{\\varepsilon_0}\\)',
      '价格 $5 到 $10，代码 `a^b`',
      t,
      extras,
    );
    const issues = lintCard(input, defaultLintConfig());
    expect(issueCodes(issues), '已包裹公式/货币/代码不得误报').not.toContain('bare_latex');
  });

  it('bare_latex_can_be_disabled', () => {
    const extras = emptyExtras();
    const t = tags('数学');
    const input = basicInput('10^5', '10^5', t, extras);
    const cfg = { ...defaultLintConfig(), check_bare_latex: false };
    const issues = lintCard(input, cfg);
    expect(issueCodes(issues)).not.toContain('bare_latex');
  });
});
