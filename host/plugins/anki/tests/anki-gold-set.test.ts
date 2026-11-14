/**
 * `crates/dstu-anki/src/anki_gold_set.rs::tests` 的全量移植（50 个测试）。
 *
 * 每个 `it` 标题与 Rust 测试函数名逐字一致；断言语义保持不变。
 * 正则相关路径（PII 脱敏、lint 契约源码扫描）使用 F7 `nativeRegex` /
 * 与 Rust 相同的源码扫描口径。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { regex } from '../../../platform/native/regex/index.ts';
import {
  CONTENT_PROVENANCE_FIELD,
  CRITIC_REVISED_QA_CODE,
  LINT_CONTRACT_CODES,
  ORIGINAL_GENERATION_FIELD,
  ORIGINAL_GENERATION_MAX_BYTES,
  PROVENANCE_ACTOR_IMPORT,
  PROVENANCE_ACTOR_LLM_CRITIC,
  PROVENANCE_ACTOR_SYNC,
  PROVENANCE_ACTOR_USER,
  cardSnapshotToJson,
  classifyCandidate,
  defaultGoldMiningConfig,
  editDistance,
  editRatio,
  extractOriginalFromExtras,
  extractOriginalGeneration,
  fixtureExportBucket,
  goldCandidateFromJson,
  goldLintConfig,
  goldSetStats,
  hasCriticRevisionMarker,
  insertContentProvenance,
  insertOriginalGenerationOnce,
  isLlmCriticActor,
  isUserProvenEdit,
  lintRepairPair,
  llmCriticContentProvenance,
  mineGoldSet,
  parseContentProvenance,
  scrubPii,
  selectGroundedReferencePairs,
  serializeContentProvenance,
  toFixtureJson,
  userContentProvenance,
  type CardSnapshot,
  type GoldCandidate,
  type GoldLabel,
  type GoldSample,
  type RepairPair,
} from '../src/anki-gold-set.ts';
import { QA_FLAGS_FIELD } from '../src/anki-qa-lint.ts';

function snap(front: string, back: string): CardSnapshot {
  return { front, back, text: null };
}

function baseCandidate(id: string): GoldCandidate {
  return {
    card_id: id,
    current: snap('什么是惯性？', '物体保持原有运动状态不变的性质'),
    original: null,
    created_at_ms: 1_000_000,
    updated_at_ms: 1_000_000,
    deleted_at_ms: null,
    review_count: 0,
    again_count: 0,
    was_error_card: false,
    is_error_card: false,
    critic_revised: false,
    edit_actor: null,
  };
}

function insertOrThrow(
  extras: Record<string, string>,
  front: string,
  back: string,
  text: string | null,
): boolean {
  const result = insertOriginalGenerationOnce(extras, front, back, text);
  if (!result.ok) throw new Error(result.error.type);
  return result.inserted;
}

function insertExpectError(
  extras: Record<string, string>,
  front: string,
  back: string,
  text: string | null,
): string {
  const result = insertOriginalGenerationOnce(extras, front, back, text);
  if (result.ok) throw new Error('expected error');
  return result.error.type;
}

function pairSample(
  id: string,
  label: GoldLabel,
  original: CardSnapshot,
  edited: CardSnapshot,
): GoldSample {
  return {
    card_id: id,
    label,
    reason: '测试样本',
    repair_pair: {
      original,
      edited,
      distance_ratio: editRatio(original, edited),
    },
  };
}

function emptySnapshot(): CardSnapshot {
  return { front: '', back: '', text: null };
}

describe('crates/dstu-anki/src/anki_gold_set.rs::tests', () => {
  // -------- extract_original_generation --------

  it('insert_original_generation_captures_front_back_and_text', () => {
    const extras: Record<string, string> = {};
    const inserted = insertOrThrow(
      extras,
      '什么是惯性？',
      '保持原有运动状态的性质',
      '物体具有 {{c1::惯性}}',
    );

    expect(inserted).toBe(true);
    const snapshot = extractOriginalFromExtras(extras);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.front).toBe('什么是惯性？');
    expect(snapshot?.back).toBe('保持原有运动状态的性质');
    expect(snapshot?.text).toBe('物体具有 {{c1::惯性}}');
  });

  it('insert_original_generation_omits_absent_text', () => {
    const extras: Record<string, string> = {};
    insertOrThrow(extras, 'Q', 'A', null);

    const raw = extras[ORIGINAL_GENERATION_FIELD];
    expect(raw).toBeDefined();
    const value = JSON.parse(raw!) as Record<string, unknown>;
    expect(value).toEqual({ front: 'Q', back: 'A' });
    expect(value.text).toBeUndefined();
  });

  it('insert_original_generation_preserves_explicit_empty_text', () => {
    const extras: Record<string, string> = {};
    insertOrThrow(extras, 'Q', 'A', '');

    const snapshot = extractOriginalFromExtras(extras);
    expect(snapshot?.text).toBe('');
  });

  it('insert_original_generation_is_first_write_only', () => {
    const extras: Record<string, string> = {};
    expect(insertOrThrow(extras, 'original Q', 'original A', null)).toBe(true);
    const originalRaw = extras[ORIGINAL_GENERATION_FIELD];

    const inserted = insertOrThrow(extras, 'edited Q', 'edited A', 'edited');
    expect(inserted).toBe(false);
    expect(extras[ORIGINAL_GENERATION_FIELD]).toBe(originalRaw);
  });

  it('insert_original_generation_never_replaces_malformed_existing_value', () => {
    const extras: Record<string, string> = {
      [ORIGINAL_GENERATION_FIELD]: 'user-controlled-non-json',
    };

    const inserted = insertOrThrow(extras, 'x'.repeat(ORIGINAL_GENERATION_MAX_BYTES * 2), 'A', null);
    expect(inserted).toBe(false);
    expect(extras[ORIGINAL_GENERATION_FIELD]).toBe('user-controlled-non-json');
  });

  it('insert_original_generation_accepts_exact_byte_limit', () => {
    const overhead = JSON.stringify(
      cardSnapshotToJson({ front: '', back: '', text: null }),
    ).length;
    expect(overhead).toBeLessThan(ORIGINAL_GENERATION_MAX_BYTES);
    const front = 'x'.repeat(ORIGINAL_GENERATION_MAX_BYTES - overhead);
    const extras: Record<string, string> = {};

    insertOrThrow(extras, front, '', null);
    expect(extras[ORIGINAL_GENERATION_FIELD]!.length).toBe(ORIGINAL_GENERATION_MAX_BYTES);
  });

  it('insert_original_generation_rejects_over_limit_without_mutation', () => {
    const overhead = JSON.stringify(
      cardSnapshotToJson({ front: '', back: '', text: null }),
    ).length;
    const front = 'x'.repeat(ORIGINAL_GENERATION_MAX_BYTES - overhead + 1);
    const extras: Record<string, string> = { keep: 'value' };
    const before: Record<string, string> = { ...extras };

    const result = insertOriginalGenerationOnce(extras, front, '', null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toEqual({
      type: 'TooLarge',
      actual_bytes: ORIGINAL_GENERATION_MAX_BYTES + 1,
      max_bytes: ORIGINAL_GENERATION_MAX_BYTES,
    });
    expect(extras).toEqual(before);
  });

  it('insert_original_generation_limit_counts_utf8_bytes', () => {
    const overhead = JSON.stringify(
      cardSnapshotToJson({ front: '', back: '', text: null }),
    ).length;
    const front = '界'.repeat(Math.trunc((ORIGINAL_GENERATION_MAX_BYTES - overhead) / 3) + 1);
    expect([...front].length).toBeLessThan(ORIGINAL_GENERATION_MAX_BYTES);
    const extras: Record<string, string> = {};

    const errorType = insertExpectError(extras, front, '', null);
    expect(errorType).toBe('TooLarge');
    expect(Object.hasOwn(extras, ORIGINAL_GENERATION_FIELD)).toBe(false);
  });

  it('extracts_original_generation_object_form', () => {
    const raw = '{"note":"x","_original_generation":{"front":"Q","back":"A"}}';
    const snapshot = extractOriginalGeneration(raw);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.front).toBe('Q');
    expect(snapshot?.back).toBe('A');
    expect(snapshot?.text).toBeNull();
  });

  it('extracts_original_generation_double_encoded_string_form', () => {
    const raw =
      '{"_original_generation":"{\\"front\\":\\"Q\\",\\"back\\":\\"A\\",\\"text\\":\\"T {{c1::x}}\\"}"}';
    const snapshot = extractOriginalGeneration(raw);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.front).toBe('Q');
    expect(snapshot?.text).toBe('T {{c1::x}}');
  });

  it('extract_returns_none_for_missing_or_invalid', () => {
    expect(extractOriginalGeneration('{"other":1}')).toBeNull();
    expect(extractOriginalGeneration('not-json')).toBeNull();
    expect(extractOriginalGeneration('{"_original_generation":42}')).toBeNull();
    expect(extractOriginalGeneration('{"_original_generation":"not-json"}')).toBeNull();
  });

  it('critic_revision_marker_requires_structured_stable_code', () => {
    const marked: Record<string, string> = {
      [QA_FLAGS_FIELD]: JSON.stringify([
        { code: 'answer_leak', field: 'front' },
        { code: CRITIC_REVISED_QA_CODE, field: 'card' },
      ]),
    };
    expect(hasCriticRevisionMarker(marked)).toBe(true);

    const unrelated: Record<string, string> = {
      [QA_FLAGS_FIELD]: JSON.stringify([{ message: CRITIC_REVISED_QA_CODE }]),
    };
    expect(hasCriticRevisionMarker(unrelated)).toBe(false);
    expect(hasCriticRevisionMarker({ [QA_FLAGS_FIELD]: 'not-json' })).toBe(false);
  });

  // -------- edit_distance / edit_ratio --------

  it('edit_distance_counts_unicode_chars', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('牛顿第一定律', '牛顿第二定律')).toBe(1);
    expect(editDistance('惯性', '')).toBe(2);
  });

  it('edit_ratio_boundaries', () => {
    const orig = snap('0123456789', '');
    const same = { ...orig };
    expect(editRatio(orig, same)).toBe(0);

    const empty = emptySnapshot();
    expect(editRatio(empty, snap('x', 'y'))).toBe(1);
    expect(editRatio(empty, empty)).toBe(0);

    const minor = snap('01234567AB', '');
    const ratio = editRatio(orig, minor);
    expect(ratio).toBeGreaterThan(0.17);
    expect(ratio).toBeLessThan(0.19);
  });

  // -------- classify：kept_unedited 正例 --------

  it('kept_unedited_requires_retention_signals', () => {
    const candidate = baseCandidate('c1');
    candidate.review_count = 5;
    candidate.again_count = 1;
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('kept_unedited');
    expect(sample.repair_pair).toBeNull();
  });

  it('unedited_with_weak_retention_is_unlabeled', () => {
    const config = defaultGoldMiningConfig();
    const shortReviews = baseCandidate('c2');
    shortReviews.review_count = 2;
    expect(classifyCandidate(shortReviews, config).label).toBe('unlabeled');

    const highLapse = baseCandidate('c3');
    highLapse.review_count = 10;
    highLapse.again_count = 5;
    expect(classifyCandidate(highLapse, config).label).toBe('unlabeled');
  });

  it('original_equal_to_current_goes_through_unedited_path_despite_timestamps', () => {
    const candidate = baseCandidate('c4');
    candidate.original = { ...candidate.current };
    candidate.updated_at_ms = candidate.created_at_ms + 3 * 60 * 60 * 1000;
    candidate.review_count = 4;
    expect(classifyCandidate(candidate, defaultGoldMiningConfig()).label).toBe('kept_unedited');
  });

  // -------- classify：修正对 --------

  it('minor_edit_yields_repair_pair_with_ratio', () => {
    const candidate = baseCandidate('c5');
    candidate.original = snap('什么是惯性？？', '物体保持原有运动状态不变的性质');
    candidate.updated_at_ms = candidate.created_at_ms + 10 * 60 * 1000;
    candidate.edit_actor = PROVENANCE_ACTOR_USER;
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('edited_minor');
    const pair = sample.repair_pair;
    expect(pair).not.toBeNull();
    expect(pair!.distance_ratio).toBeGreaterThan(0);
    expect(pair!.distance_ratio).toBeLessThan(0.25);
    expect(pair!.edited).toEqual(candidate.current);
  });

  it('major_rewrite_yields_edited_major', () => {
    const candidate = baseCandidate('c6');
    candidate.original = snap('好的，以下是卡片：惯性是什么以及加速度是什么？', 'TODO');
    candidate.edit_actor = PROVENANCE_ACTOR_USER;
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('edited_major');
    expect(sample.repair_pair!.distance_ratio).toBeGreaterThanOrEqual(0.25);
  });

  it('critic_revised_content_is_never_mined_as_user_gold', () => {
    const candidate = baseCandidate('critic-revised');
    candidate.original = snap('模型原问题（答案泄露）', '模型原答案');
    candidate.critic_revised = true;
    candidate.review_count = 10;

    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('unlabeled');
    expect(sample.repair_pair).toBeNull();
    expect(sample.reason).toContain(CRITIC_REVISED_QA_CODE);
  });

  it('llm_critic_actor_is_excluded_even_without_qa_flags_marker', () => {
    const candidate = baseCandidate('critic-provenance');
    candidate.original = snap('模型原问题（答案泄露）', '模型原答案');
    candidate.critic_revised = false;
    candidate.edit_actor = PROVENANCE_ACTOR_LLM_CRITIC;
    candidate.review_count = 10;

    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('unlabeled');
    expect(sample.repair_pair).toBeNull();
    expect(sample.reason).toContain(CRITIC_REVISED_QA_CODE);
  });

  it('edited_content_without_actor_proof_is_unlabeled', () => {
    const candidate = baseCandidate('legacy-edited');
    candidate.original = snap('什么是惯性？？', '物体保持原有运动状态不变的性质');
    candidate.edit_actor = null;
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('unlabeled');
    expect(sample.repair_pair).toBeNull();
    expect(sample.reason).toContain('缺编辑者证明');
  });

  it('non_user_actors_never_enter_edited_buckets', () => {
    for (const actor of [PROVENANCE_ACTOR_IMPORT, PROVENANCE_ACTOR_SYNC, 'future_agent']) {
      const candidate = baseCandidate(`actor-${actor}`);
      candidate.original = snap('什么是惯性？？', '物体保持原有运动状态不变的性质');
      candidate.edit_actor = actor;
      const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
      expect(sample.label, `actor=${actor}`).toBe('unlabeled');
      expect(sample.repair_pair).toBeNull();
    }
  });

  it('user_actor_proof_keeps_kept_unedited_channel_untouched', () => {
    const candidate = baseCandidate('kept-no-actor');
    candidate.original = { ...candidate.current };
    candidate.review_count = 5;
    candidate.again_count = 1;
    expect(classifyCandidate(candidate, defaultGoldMiningConfig()).label).toBe('kept_unedited');
  });

  it('gold_candidate_old_json_without_edit_actor_deserializes', () => {
    const raw = {
      card_id: 'legacy',
      current: { front: 'Q', back: 'A' },
      original: null,
      created_at_ms: 0,
      updated_at_ms: 0,
      deleted_at_ms: null,
      review_count: 0,
      again_count: 0,
      was_error_card: false,
      is_error_card: false,
    };
    const candidate = goldCandidateFromJson(raw);
    expect(candidate).not.toBeNull();
    expect(candidate!.edit_actor).toBeNull();
    expect(candidate!.critic_revised).toBe(false);
  });

  // -------- _content_provenance 读写 helper --------

  it('content_provenance_round_trips_via_extras', () => {
    const extras: Record<string, string> = {};
    insertContentProvenance(extras, userContentProvenance('update_library_card'));

    const parsed = parseContentProvenance(extras);
    expect(parsed).not.toBeNull();
    expect(parsed!.actor).toBe(PROVENANCE_ACTOR_USER);
    expect(parsed!.code).toBe('update_library_card');
    expect(parsed!.at).toBeTruthy();
    expect(isUserProvenEdit(extras)).toBe(true);
    expect(isLlmCriticActor(extras)).toBe(false);
  });

  it('content_provenance_is_last_writer_wins', () => {
    const extras: Record<string, string> = {};
    insertContentProvenance(extras, llmCriticContentProvenance());
    expect(isLlmCriticActor(extras)).toBe(true);

    insertContentProvenance(extras, userContentProvenance(''));
    const parsed = parseContentProvenance(extras);
    expect(parsed!.actor).toBe(PROVENANCE_ACTOR_USER);
    expect(parsed!.code).toBeNull();
    expect(isUserProvenEdit(extras)).toBe(true);
    expect(isLlmCriticActor(extras)).toBe(false);
  });

  it('content_provenance_uses_camel_case_and_ignores_unknown_fields', () => {
    const raw = serializeContentProvenance({
      actor: PROVENANCE_ACTOR_LLM_CRITIC,
      code: CRITIC_REVISED_QA_CODE,
      at: '2026-08-24T00:00:00Z',
    });
    expect(raw).toContain('"actor":"llm_critic"');
    expect(raw).toContain('"code":"llm_critic_revised"');
    expect(raw).toContain('"at":');

    const extras: Record<string, string> = {
      [CONTENT_PROVENANCE_FIELD]:
        '{"actor":"user","code":"x","at":"2026-01-01T00:00:00Z","futureField":123}',
    };
    const parsed = parseContentProvenance(extras);
    expect(parsed).not.toBeNull();
    expect(parsed!.actor).toBe(PROVENANCE_ACTOR_USER);
    expect(isUserProvenEdit(extras)).toBe(true);
  });

  it('content_provenance_malformed_values_are_fail_closed', () => {
    for (const bad of ['not-json', '42', '{"code":"x"}', '["user"]']) {
      const extras: Record<string, string> = { [CONTENT_PROVENANCE_FIELD]: bad };
      expect(parseContentProvenance(extras), `bad=${bad}`).toBeNull();
      expect(isUserProvenEdit(extras)).toBe(false);
      expect(isLlmCriticActor(extras)).toBe(false);
    }
    expect(parseContentProvenance({})).toBeNull();
  });

  it('provenance_detection_does_not_depend_on_qa_flags', () => {
    const extras: Record<string, string> = {};
    insertContentProvenance(extras, llmCriticContentProvenance());
    expect(Object.hasOwn(extras, QA_FLAGS_FIELD)).toBe(false);
    expect(isLlmCriticActor(extras)).toBe(true);
    expect(hasCriticRevisionMarker(extras)).toBe(false);
  });

  it('edited_by_timestamp_without_original_is_unlabeled_with_reason', () => {
    const candidate = baseCandidate('c7');
    candidate.updated_at_ms = candidate.created_at_ms + 60 * 60 * 1000;
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('unlabeled');
    expect(sample.reason).toContain('_original_generation');
  });

  // -------- classify：删除通道 --------

  it('early_delete_without_reviews_is_negative', () => {
    const candidate = baseCandidate('c8');
    candidate.deleted_at_ms = candidate.created_at_ms + 2 * 60 * 60 * 1000;
    expect(classifyCandidate(candidate, defaultGoldMiningConfig()).label).toBe('deleted_early');
  });

  it('reviewed_or_late_delete_is_unlabeled', () => {
    const config = defaultGoldMiningConfig();
    const reviewed = baseCandidate('c9');
    reviewed.deleted_at_ms = reviewed.created_at_ms + 60 * 1000;
    reviewed.review_count = 2;
    expect(classifyCandidate(reviewed, config).label).toBe('unlabeled');

    const late = baseCandidate('c10');
    late.deleted_at_ms = late.created_at_ms + 48 * 60 * 60 * 1000;
    expect(classifyCandidate(late, config).label).toBe('unlabeled');
  });

  // -------- classify：错误卡修复 --------

  it('repaired_error_card_becomes_repair_pair', () => {
    const candidate = baseCandidate('c11');
    candidate.was_error_card = true;
    candidate.original = snap("{'front': '什么是纯函数？'", '');
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('error_card_repaired');
    expect(sample.repair_pair!.edited.front).toBe('什么是惯性？');
  });

  it('still_broken_or_blank_error_card_is_unlabeled', () => {
    const config = defaultGoldMiningConfig();
    const broken = baseCandidate('c12');
    broken.is_error_card = true;
    expect(classifyCandidate(broken, config).label).toBe('unlabeled');

    const blank = baseCandidate('c13');
    blank.was_error_card = true;
    blank.current = emptySnapshot();
    expect(classifyCandidate(blank, config).label).toBe('unlabeled');
  });

  // -------- mine_gold_set / stats / bucket --------

  it('mine_gold_set_buckets_and_stats', () => {
    const config = defaultGoldMiningConfig();
    const kept = baseCandidate('k');
    kept.review_count = 3;
    const minor = baseCandidate('m');
    minor.original = snap('什么是惯性？？', '物体保持原有运动状态不变的性质');
    minor.edit_actor = PROVENANCE_ACTOR_USER;
    const deleted = baseCandidate('d');
    deleted.deleted_at_ms = deleted.created_at_ms + 1000;
    const unlabeled = baseCandidate('u');

    const samples = mineGoldSet([kept, minor, deleted, unlabeled], config);
    expect(goldSetStats(samples)).toEqual({
      kept_unedited: 1,
      edited_minor: 1,
      edited_major: 0,
      deleted_early: 1,
      error_card_repaired: 0,
      unlabeled: 1,
    });

    expect(fixtureExportBucket('kept_unedited')).toBe('gold/positive');
    expect(fixtureExportBucket('edited_minor')).toBe('gold/repair-pairs');
    expect(fixtureExportBucket('error_card_repaired')).toBe('gold/repair-pairs');
    expect(fixtureExportBucket('deleted_early')).toBe('gold/negative');
    expect(fixtureExportBucket('unlabeled')).toBeNull();
  });

  // -------- lint 契约校验 --------

  it('lint_repair_pair_degraded_original_and_clean_edited', () => {
    const pair: RepairPair = {
      original: snap('快速排序的平均时间复杂度是多少？答案是 O(n log n)。', 'O(n log n)'),
      edited: snap('快速排序的平均时间复杂度是多少？', 'O(n log n)'),
      distance_ratio: 0.3,
    };
    const report = lintRepairPair(pair, goldLintConfig());
    expect(report.original_flagged).toBe(true);
    expect(report.original_codes).toContain('answer_leak');
    expect(report.edited_clean).toBe(true);
    expect(report.lint_blind_spot).toBe(false);
  });

  it('lint_repair_pair_detects_blind_spot', () => {
    const pair: RepairPair = {
      original: snap('什么是惯性？', '物体保持运动状态的性质'),
      edited: snap('什么是惯性？', '物体保持原有运动状态不变的固有属性'),
      distance_ratio: 0.4,
    };
    const report = lintRepairPair(pair, goldLintConfig());
    expect(report.original_flagged).toBe(false);
    expect(report.edited_clean).toBe(true);
    expect(report.lint_blind_spot).toBe(true);
  });

  it('gold_lint_config_suppresses_info_noise', () => {
    const clean = snap('什么是哈希冲突？', '不同键映射到同一槽位的现象');
    const report = lintRepairPair(
      { original: clean, edited: clean, distance_ratio: 0 },
      goldLintConfig(),
    );
    // 快照不带 tags：默认配置会命中 tags_empty(Info)，gold 配置 + Warn 过滤后必须为空
    expect(report.original_codes).toEqual([]);
  });

  // -------- grounded critic 参照对选取 --------

  it('extract_original_from_extras_string_form', () => {
    const extras: Record<string, string> = {
      [ORIGINAL_GENERATION_FIELD]: '{"front":"Q","back":"A"}',
    };
    const snapshot = extractOriginalFromExtras(extras);
    expect(snapshot?.front).toBe('Q');
    expect(snapshot?.back).toBe('A');

    expect(extractOriginalFromExtras({})).toBeNull();
    expect(extractOriginalFromExtras({ [ORIGINAL_GENERATION_FIELD]: 'not-json' })).toBeNull();
    expect(extractOriginalFromExtras({ [ORIGINAL_GENERATION_FIELD]: '42' })).toBeNull();
  });

  it('select_reference_pairs_requires_clean_gold_side', () => {
    const config = goldLintConfig();
    const clean = pairSample(
      'good',
      'edited_minor',
      snap('什么是惯性？答案是保持运动状态。', '保持运动状态'),
      snap('什么是惯性？', '物体保持原有运动状态不变的性质'),
    );
    const dirtyGold = pairSample(
      'dirty',
      'edited_major',
      snap('TODO 问题', 'TODO'),
      snap('什么是加速度？', '请参考 {{DOCUMENT_CONTENT}}'),
    );
    const picked = selectGroundedReferencePairs([clean, dirtyGold], config, 10);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.edited.front).toBe('什么是惯性？');
  });

  it('select_reference_pairs_keeps_lint_blind_spot_pairs', () => {
    const config = goldLintConfig();
    const blind = pairSample(
      'blind',
      'edited_minor',
      snap('什么是惯性？', '物体保持运动状态的性质'),
      snap('什么是惯性？', '物体保持原有运动状态不变的固有属性'),
    );
    const picked = selectGroundedReferencePairs([blind], config, 10);
    expect(picked).toHaveLength(1);
  });

  it('select_reference_pairs_filters_labels_blanks_and_duplicates', () => {
    const config = goldLintConfig();
    const wrongLabel = pairSample(
      'kept',
      'kept_unedited',
      snap('Q', 'A'),
      snap('什么是熵？', '系统混乱程度的度量'),
    );
    const blankGold = pairSample(
      'blank',
      'edited_major',
      snap('坏问题', '坏答案'),
      emptySnapshot(),
    );
    const valid = pairSample(
      'v1',
      'edited_minor',
      snap('什么是熵？？', '混乱度'),
      snap('什么是熵？', '系统混乱程度的度量'),
    );
    const duplicateFront = pairSample(
      'v2',
      'edited_major',
      snap('什么是熵', 'TODO'),
      snap('什么是熵？', '另一种表述的答案'),
    );
    const noPair: GoldSample = {
      card_id: 'np',
      label: 'edited_minor',
      reason: 'x',
      repair_pair: null,
    };
    const picked = selectGroundedReferencePairs(
      [wrongLabel, blankGold, valid, duplicateFront, noPair],
      config,
      10,
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]!.edited.back).toBe('系统混乱程度的度量');
  });

  it('select_reference_pairs_caps_at_max_preserving_order', () => {
    const config = goldLintConfig();
    const samples: GoldSample[] = [];
    for (let i = 0; i < 5; i += 1) {
      samples.push(
        pairSample(
          `s${i}`,
          'edited_minor',
          snap(`旧问题${i}？？`, '旧答案'),
          snap(`问题${i}是什么？`, `答案${i}`),
        ),
      );
    }
    const picked = selectGroundedReferencePairs(samples, config, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0]!.edited.front).toBe('问题0是什么？');
    expect(picked[1]!.edited.front).toBe('问题1是什么？');
  });

  // -------- 脱敏 --------

  it('scrub_pii_strips_email_phone_and_id', async () => {
    const [out, n] = await scrubPii(
      '联系 alice@example.com 或 13812345678，证件 11010119900307867X',
      regex,
    );
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('13812345678');
    expect(out).not.toContain('11010119900307867X');
    expect(out).toContain('[已脱敏邮箱]');
    expect(out).toContain('[已脱敏手机号]');
    expect(out).toContain('[已脱敏证件号]');
    expect(n).toBe(3);
  });

  it('scrub_pii_preserves_normal_content', async () => {
    const text = 'TCP 三次握手：SYN、SYN-ACK、ACK；速度 299792458 m/s 不是手机号';
    const [out, n] = await scrubPii(text, regex);
    expect(out).toBe(text);
    expect(n).toBe(0);
  });

  // -------- 导出整形 --------

  it('fixture_json_scrubs_and_shapes_repair_pair', async () => {
    const sample: GoldSample = {
      card_id: 'rp-x',
      label: 'edited_minor',
      reason: '小幅编辑',
      repair_pair: {
        original: snap('联系 bob@example.com 咨询答案', '42'),
        edited: snap('生命、宇宙及一切的终极答案是？', '42'),
        distance_ratio: 0.123456,
      },
    };
    const value = await toFixtureJson(sample, regex);
    expect(value).not.toBeNull();
    expect(value!.id).toBe('rp-x');
    expect(value!.label).toBe('edited_minor');
    expect((value!.original as CardSnapshot).front).toBe('联系 [已脱敏邮箱] 咨询答案');
    expect((value!.edited as CardSnapshot).front).toBe('生命、宇宙及一切的终极答案是？');
    expect(value!.distanceRatio).toBe(0.123);

    const unlabeled: GoldSample = {
      card_id: 'u',
      label: 'unlabeled',
      reason: 'x',
      repair_pair: null,
    };
    expect(await toFixtureJson(unlabeled, regex)).toBeNull();
  });

  // -------- 跨语言 lint 契约守护 --------

  it('lint_contract_codes_match_anki_qa_lint_source', () => {
    const source = readdirSync(new URL('../src/', import.meta.url))
      .filter((name) => /^anki-qa-.*\.ts$/.test(name))
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    const ctor = /LintIssue\.new\(\s*['"]([a-z_]+)['"]/g;
    const jsonCode = /"code":\s*['"]([a-z_]+)['"]/g;
    const found = new Set<string>();
    for (const match of source.matchAll(ctor)) found.add(match[1] as string);
    for (const match of source.matchAll(jsonCode)) found.add(match[1] as string);
    const declared = new Set<string>(LINT_CONTRACT_CODES);
    expect([...declared].sort()).toEqual([...found].sort());
  });

  it('lint_contract_codes_have_no_duplicates', () => {
    const set = new Set<string>(LINT_CONTRACT_CODES);
    expect(set.size).toBe(LINT_CONTRACT_CODES.length);
  });

  // -------- 仓库内金标修正对 fixture 消费 --------

  it('repo_repair_pair_fixtures_satisfy_lint_contract', () => {
    const dir = new URL(
      '../../../../tests/fixtures/anki-eval/gold/repair-pairs/',
      import.meta.url,
    );
    const config = goldLintConfig();
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    let checked = 0;
    for (const entry of entries) {
      const raw = readFileSync(new URL(entry, dir), 'utf8');
      const value = JSON.parse(raw) as {
        original: unknown;
        edited: unknown;
      };
      const original = decodeSnapshot(value.original);
      const edited = decodeSnapshot(value.edited);
      const pair: RepairPair = {
        distance_ratio: editRatio(original, edited),
        original,
        edited,
      };
      const report = lintRepairPair(pair, config);
      expect(
        report.original_flagged,
        `${entry}: original 必须被 lint 命中（改前=劣化），实际 codes=${JSON.stringify(report.original_codes)}`,
      ).toBe(true);
      expect(
        report.edited_clean,
        `${entry}: edited 必须零 lint 命中（改后=金标），实际 codes=${JSON.stringify(report.edited_codes)}`,
      ).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

/** fixture 中的 `CardSnapshot`（front/back 缺省空串，text 缺省 null）。 */
function decodeSnapshot(value: unknown): CardSnapshot {
  const object = value as Record<string, unknown>;
  return {
    front: typeof object.front === 'string' ? object.front : '',
    back: typeof object.back === 'string' ? object.back : '',
    text: typeof object.text === 'string' ? object.text : null,
  };
}
