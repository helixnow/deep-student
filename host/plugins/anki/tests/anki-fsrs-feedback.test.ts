import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle, SqlParam } from '../../../platform/storage/api.ts';
import {
  buildFeedbackInjection,
  buildInterferenceHints,
  buildProfile,
  buildUserReviewProfile,
  charCount,
  defaultFsrsFeedbackConfig,
  excerpt,
  extractKeywords,
  isUserReviewProfileEmpty,
  renderInterferenceSection,
  renderProfileSection,
  stripEnumerationMarker,
  suggestSplits,
  type FsrsFeedbackConfig,
  type FsrsFeedbackRow,
  type InterferenceHint,
  type UserReviewProfile,
} from '../src/anki-fsrs-feedback.ts';
import { listFeedbackRows } from '../repository/anki-fsrs-feedback.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

// ============================================================
// 单元测试（纯函数，无 DB）：`anki_fsrs_feedback.rs:780-1239`
// ============================================================

function makeRow(
  id: string,
  front: string,
  templateId: string | null,
  tags: readonly string[],
  lapses: number,
  reps: number,
  stability: number | null,
  dueMs: number,
  lastReviewMs: number | null,
): FsrsFeedbackRow {
  return {
    ankiCardId: id,
    front,
    templateId,
    tags: [...tags],
    state: reps > 0 ? 2 : 0,
    stability,
    lapses,
    reps,
    dueMs,
    lastReviewMs,
  };
}

function cfg(): FsrsFeedbackConfig {
  return defaultFsrsFeedbackConfig();
}

describe('crates/dstu-anki/src/anki_fsrs_feedback.rs::tests', () => {
  // 1. 画像序列化：camelCase 键 + roundtrip
  it('profile_serialization_roundtrip_camel_case', () => {
    const rows = [
      makeRow('c1', '牛顿第二定律的内容是什么？', 'basic-choice', ['力学', '牛顿定律'], 4, 6, 3, 0, 0),
    ];
    const profile = buildProfile(rows, 1_000_000, cfg());
    const json = JSON.stringify(profile);
    expect(json).toContain('avgRetrievability');
    expect(json).toContain('highLapseTemplates');
    expect(json).toContain('confusableTags');
    const back = JSON.parse(json) as UserReviewProfile;
    // 浮点 roundtrip 用容差比较（Rust 侧对应 serde_json 未开 float_roundtrip 的 1 ulp 差）
    const parsed = back.avgRetrievability!;
    const original = profile.avgRetrievability!;
    expect(Math.abs(parsed - original)).toBeLessThan(1e-12);
    back.avgRetrievability = profile.avgRetrievability;
    expect(back).toEqual(profile);
  });

  // 2. 空库 → 空画像，渲染为 None
  it('empty_rows_yield_empty_profile_and_no_section', () => {
    const profile = buildProfile([], 123, cfg());
    expect(isUserReviewProfileEmpty(profile)).toBe(true);
    expect(profile.totalCards).toBe(0);
    expect(profile.avgRetrievability).toBeNull();
    expect(renderProfileSection(profile, cfg())).toBeNull();
  });

  // 3. 平均可提取性：stability=5 且 5 天前复习 → FSRS-5 曲线精确 0.9
  it('avg_retrievability_matches_fsrs_forgetting_curve', () => {
    const nowMs = 10 * 86_400_000;
    const fiveDaysAgo = nowMs - 5 * 86_400_000;
    const rows = [
      makeRow('c1', 'front', null, [], 0, 3, 5.0, nowMs + 1, fiveDaysAgo),
    ];
    const profile = buildProfile(rows, nowMs, cfg());
    const r = profile.avgRetrievability!;
    expect(Math.abs(r - 0.9)).toBeLessThan(1e-9);
    // 未复习的卡不计入平均
    const rows2 = [rows[0]!, makeRow('c2', 'new', null, [], 0, 0, null, 0, null)];
    const profile2 = buildProfile(rows2, nowMs, cfg());
    expect(Math.abs(profile2.avgRetrievability! - 0.9)).toBeLessThan(1e-9);
  });

  // 4. 高 lapse 模板：排序 + max_templates 截断，无模板归入 basic
  it('template_stats_sorted_and_capped', () => {
    const rows: FsrsFeedbackRow[] = [];
    for (let i = 0; i < 4; i += 1) {
      rows.push(makeRow(`a${i}`, 'f', 'tmpl-heavy', [], 5, 6, 2, 0, 0));
    }
    rows.push(makeRow('b1', 'f', 'tmpl-light', [], 1, 2, 2, 0, 0));
    rows.push(makeRow('c1', 'f', null, [], 2, 3, 2, 0, 0));

    const config = cfg();
    config.maxTemplates = 2;
    const profile = buildProfile(rows, 1, config);
    expect(profile.highLapseTemplates).toHaveLength(2);
    expect(profile.highLapseTemplates[0]!.templateId).toBe('tmpl-heavy');
    expect(profile.highLapseTemplates[0]!.totalLapses).toBe(20);
    expect(profile.highLapseTemplates[0]!.cards).toBe(4);
    // basic(2) > tmpl-light(1)
    expect(profile.highLapseTemplates[1]!.templateId).toBe('basic');
  });

  // 5. 易混淆标签：需 ≥2 卡且平均 lapse ≥1；排序 + 截断
  it('confusable_tags_filtered_sorted_capped', () => {
    const rows = [
      makeRow('c1', 'f', null, ['三角函数', '数学'], 4, 5, 2, 0, 0),
      makeRow('c2', 'f', null, ['三角函数'], 3, 4, 2, 0, 0),
      makeRow('c3', 'f', null, ['数学'], 0, 1, 2, 0, 0),
      // 单卡标签不足以构成"混淆"
      makeRow('c4', 'f', null, ['孤儿标签'], 9, 9, 2, 0, 0),
    ];
    const profile = buildProfile(rows, 1, cfg());
    const tags = profile.confusableTags.map((tag) => tag.tag);
    expect(tags).toEqual(['三角函数', '数学']);
    expect(profile.confusableTags[0]!.totalLapses).toBe(7);
    expect(profile.confusableTags[0]!.cards).toBe(2);

    const config = cfg();
    config.maxTags = 1;
    const capped = buildProfile(rows, 1, config);
    expect(capped.confusableTags).toHaveLength(1);
  });

  // 6. 画像渲染遵守字符预算（token 预算截断）
  it('profile_section_respects_char_budget', () => {
    const rows: FsrsFeedbackRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(
        makeRow(
          `c${i}`,
          `这是一张非常长的高遗忘卡片正面内容，编号 ${i}，用于测试字符预算截断行为`,
          `tmpl-${i}`,
          ['标签A', '标签B'],
          5,
          6,
          2,
          0,
          0,
        ),
      );
    }
    const config = cfg();
    config.maxProfileChars = 200;
    config.includeCardExcerpts = true;
    const profile = buildProfile(rows, 1, config);
    const section = renderProfileSection(profile, config)!;
    expect(charCount(section)).toBeLessThanOrEqual(200);
    expect(section.endsWith('…')).toBe(true);
    // 预算充足时不截断
    const wide = cfg();
    wide.maxProfileChars = 100_000;
    wide.includeCardExcerpts = true;
    const full = renderProfileSection(profile, wide)!;
    expect(full.endsWith('…')).toBe(false);
    expect(full).toContain('易混淆标签');
  });

  // 6b. 隐私默认（0824 收口）：默认配置不渲染历史卡片正面摘要，
  //     只有显式开启 include_card_excerpts 才包含；且渲染文案不再声称「不上传」。
  it('profile_section_excludes_card_excerpts_by_default', () => {
    const rows = [
      makeRow('c1', '线粒体是细胞的能量工厂吗？', 'basic', ['生物'], 5, 6, 2, 0, 0),
    ];
    const profile = buildProfile(rows, 1, cfg());
    expect(profile.highLapseCards.length).toBeGreaterThan(0);

    // 默认：匿名聚合可渲染，但卡片原文摘要不出现
    const defaultConfig = cfg();
    expect(defaultConfig.includeCardExcerpts).toBe(false);
    const section = renderProfileSection(profile, defaultConfig)!;
    expect(section).not.toContain('高遗忘卡片示例');
    expect(section).not.toContain('线粒体');
    expect(section).not.toContain('不上传');
    expect(section).not.toContain('仅本地');

    // 显式开启后才包含摘要
    const optedIn = cfg();
    optedIn.includeCardExcerpts = true;
    const full = renderProfileSection(profile, optedIn)!;
    expect(full).toContain('高遗忘卡片示例');
    expect(full).toContain('线粒体');

    // 干扰预警文案同样不得声称「仅本地」
    const hints = buildInterferenceHints(rows, '线粒体与能量代谢', optedIn);
    const interference = renderInterferenceSection(hints, optedIn)!;
    expect(interference).not.toContain('仅本地');
    expect(interference).not.toContain('不上传');
  });

  // 7. front 摘要多字节安全截断
  it('front_excerpt_is_multibyte_safe', () => {
    const longFront = '微积分基本定理说明了导数与积分之间的互逆关系，且适用于连续函数'.repeat(3);
    const e = excerpt(longFront, 10);
    expect(charCount(e)).toBe(11); // 10 字 + 省略号
    expect(e.endsWith('…')).toBe(true);
    expect(excerpt('短', 10)).toBe('短');
  });

  // 8. 关键词提取：CJK bigram + 拉丁词
  it('extract_keywords_handles_cjk_and_latin', () => {
    const kws = extractKeywords('牛顿第二定律 Newton force 定律', 50);
    expect(kws).toContain('牛顿');
    expect(kws).toContain('定律');
    expect(kws).toContain('newton');
    expect(kws).toContain('force');
    // 短拉丁词（<3 字符）不收
    expect(extractKeywords('a an of', 50).some((k) => k === 'an')).toBe(false);
    // 空文本
    expect(extractKeywords('', 50)).toEqual([]);
  });

  // 9. 干扰候选：关键词重叠命中高 lapse 卡，低 lapse 卡排除
  it('interference_hints_match_by_keyword_overlap', () => {
    const rows = [
      makeRow('hit', '牛顿第二定律的表达式是什么？', null, [], 5, 6, 2, 0, 0),
      makeRow('low', '牛顿第二定律适用条件？', null, [], 0, 1, 2, 0, 0),
      makeRow('miss', '光合作用的暗反应发生在哪里？', null, [], 7, 8, 2, 0, 0),
    ];
    const hints = buildInterferenceHints(rows, '本章讲解牛顿第二定律及其应用', cfg());
    const ids = hints.map((hint) => hint.ankiCardId);
    expect(ids).toEqual(['hit']);
    expect(hints[0]!.overlapScore).toBeGreaterThan(0);
    // 空文档内容 → 无候选
    expect(buildInterferenceHints(rows, '  ', cfg())).toEqual([]);
  });

  // 10. 干扰列表上限（max_interference_cards）
  it('interference_hints_capped_at_limit', () => {
    const rows: FsrsFeedbackRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(
        makeRow(
          `c${String(i).padStart(2, '0')}`,
          '细胞呼吸的三个阶段分别是什么？',
          null,
          [],
          3 + i,
          5,
          2,
          0,
          0,
        ),
      );
    }
    const config = cfg();
    config.maxInterferenceCards = 4;
    const hints = buildInterferenceHints(rows, '细胞呼吸与能量代谢', config);
    expect(hints).toHaveLength(4);
    // lapses 高的排前面（overlap 相同）
    expect(hints[0]!.ankiCardId).toBe('c19');
  });

  // 11. 干扰渲染遵守字符预算：超预算停止追加条目
  it('interference_section_respects_char_budget', () => {
    const hints: InterferenceHint[] = [];
    for (let i = 0; i < 10; i += 1) {
      hints.push({
        ankiCardId: `c${i}`,
        frontExcerpt: '这是一条比较长的高遗忘卡片正面摘要用于测试预算',
        lapses: 5,
        overlapScore: 3,
      });
    }
    const config = cfg();
    config.maxInterferenceChars = 260;
    const section = renderInterferenceSection(hints, config)!;
    expect(charCount(section)).toBeLessThanOrEqual(260);
    // 至少保留 header，且不是全部 10 条
    expect(section).toContain('同批次语义干扰预警');
    expect(section.split('lapses=').length - 1).toBeLessThan(10);
    // 空候选 → None
    expect(renderInterferenceSection([], config)).toBeNull();
  });

  // 12. suggest_splits：枚举答案拆成原子卡
  it('suggest_splits_enumerated_back', () => {
    const back = '1. 糖酵解发生在细胞质基质\n2. 丙酮酸氧化脱羧发生在线粒体基质\n3. 三羧酸循环也在线粒体基质';
    const out = suggestSplits('细胞呼吸的三个阶段及场所？', back, 10);
    expect(out).toHaveLength(3);
    expect(out[0]!.front).toContain('要点 1/3');
    expect(out[1]!.back).toBe('丙酮酸氧化脱羧发生在线粒体基质');
    expect(out[0]!.rationale).toContain('并列要点');
    // max_suggestions 截断
    expect(suggestSplits('q', back, 2)).toHaveLength(2);
  });

  // 13. suggest_splits：分号列表 + 对比型正面
  it('suggest_splits_semicolons_and_comparison', () => {
    const semi = suggestSplits('酶的特性？', '高效性；专一性；作用条件温和', 10);
    expect(semi).toHaveLength(3);
    expect(semi[2]!.back).toBe('作用条件温和');

    const cmp = suggestSplits('有丝分裂与减数分裂的区别？', '染色体行为不同等等', 10);
    expect(cmp).toHaveLength(2);
    expect(cmp[0]!.front).toContain('有丝分裂');
    expect(cmp[1]!.front).toContain('减数分裂');
  });

  // 14. suggest_splits：长多句答案拆两卡；原子卡不拆
  it('suggest_splits_long_back_and_atomic_noop', () => {
    const longBack =
      '细胞膜主要由磷脂双分子层构成，磷脂分子的疏水尾部相对、亲水头部朝外，构成了膜的基本骨架结构。' +
      '膜上镶嵌、贯穿或附着多种蛋白质，这些蛋白质承担物质运输、信号转导以及细胞间信息交流等重要功能。' +
      '此外细胞膜还含有少量糖类，以糖蛋白或糖脂的形式存在于细胞膜外表面，参与细胞识别和免疫应答等过程。';
    const out = suggestSplits('细胞膜的组成？', longBack, 10);
    expect(out).toHaveLength(2);
    expect(out[0]!.front).toContain('核心结论');
    expect(out[1]!.front).toContain('补充细节');

    // 原子卡：单句短答案 → 无建议
    expect(suggestSplits('水的化学式？', 'H2O。', 10)).toEqual([]);
    // 空输入
    expect(suggestSplits('', 'back', 10)).toEqual([]);
    expect(suggestSplits('front', '', 10)).toEqual([]);
  });

  // 15. 枚举标记解析边界
  it('enumeration_marker_variants', () => {
    expect(stripEnumerationMarker('1. 第一点')).toBe('第一点');
    expect(stripEnumerationMarker('2、第二点')).toBe('第二点');
    expect(stripEnumerationMarker('(3) 第三点')).toBe('第三点');
    expect(stripEnumerationMarker('① 圈号')).toBe('圈号');
    expect(stripEnumerationMarker('- 短横')).toBe('短横');
    expect(stripEnumerationMarker('普通句子')).toBeNull();
    expect(stripEnumerationMarker('2026年')).toBeNull();
  });

  // 16. 配置默认值 + 序列化
  it('config_defaults_are_sane_and_serializable', () => {
    const c = defaultFsrsFeedbackConfig();
    expect(c.scanLimit).toBeGreaterThanOrEqual(100);
    expect(c.minLapsesForHint).toBeGreaterThanOrEqual(1);
    expect(c.maxInterferenceCards).toBeGreaterThan(0);
    expect(c.maxInterferenceCards).toBeLessThanOrEqual(20);
    expect(c.maxProfileChars).toBeGreaterThanOrEqual(200);
    const json = JSON.stringify(c);
    expect(json).toContain('maxInterferenceCards');
    const back = JSON.parse(json) as FsrsFeedbackConfig;
    expect(back.scanLimit).toBe(c.scanLimit);
  });

  // 17. due 统计与 reviewed 统计
  it('due_and_reviewed_counters', () => {
    const now = 1_000_000;
    const rows = [
      makeRow('due1', 'f', null, [], 0, 2, 2, now - 1, 0),
      makeRow('due2', 'f', null, [], 0, 2, 2, now, 0),
      makeRow('future', 'f', null, [], 0, 2, 2, now + 1, 0),
      makeRow('new', 'f', null, [], 0, 0, null, now - 1, null),
    ];
    const profile = buildProfile(rows, now, cfg());
    expect(profile.totalCards).toBe(4);
    expect(profile.dueCards).toBe(3);
    expect(profile.reviewedCards).toBe(3);
  });
});

// ============================================================
// 集成测试（真实 mistakes 库）：`tests/anki_fsrs_feedback.rs:1-235`
// ============================================================

function insertCard(
  db: DatabaseHandle,
  taskId: string,
  cardId: string,
  front: string,
  tagsJson: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO document_tasks (
        id, document_id, original_document_name, segment_index,
        content_segment, status, anki_generation_options_json
     ) VALUES (?1, 'doc-feedback', 'test.md', 0, 'segment', 'Completed', '{}')`,
    [taskId],
  );
  db.run(
    `INSERT INTO anki_cards (id, task_id, front, back, tags_json, source_type, source_id)
     VALUES (?1, ?2, ?3, 'back', ?4, 'document', 'doc-feedback')`,
    [cardId, taskId, front, tagsJson],
  );
}

/** 入队（等价 `enqueue_cards` 的最小 SQL 效果）：New 卡、无 stability、无 lapse。 */
function enqueueCard(db: DatabaseHandle, cardId: string, dueMs: SqlParam): void {
  db.run(
    `INSERT INTO fsrs_card_states (id, anki_card_id, state, due_ms, created_at, updated_at)
     VALUES (?1, ?2, 0, ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [`fsrs-${cardId}`, cardId, dueMs],
  );
}

/** 入队后直接改写调度状态，模拟"复习过且多次遗忘"的卡。 */
function makeLapsed(db: DatabaseHandle, cardId: string, lapses: number, dueMs: SqlParam): void {
  const updated = db.run(
    `UPDATE fsrs_card_states
     SET lapses = ?1, reps = ?2, state = 2, stability = 3.0,
         last_review_ms = 1000, due_ms = ?3
     WHERE anki_card_id = ?4`,
    [lapses, lapses + 2, dueMs, cardId],
  );
  expect(updated.changes).toBe(1);
}

describe('tests/anki_fsrs_feedback.rs', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
  });

  it('empty_library_degrades_to_no_injection', () => {
    const config = defaultFsrsFeedbackConfig();
    expect(buildFeedbackInjection(db, '任意文档内容', config)).toBeNull();
    const profile = buildUserReviewProfile(db, config);
    expect(isUserReviewProfileEmpty(profile)).toBe(true);
    expect(profile.totalCards).toBe(0);
  });

  it('list_feedback_rows_orders_by_lapses_and_respects_limit', () => {
    insertCard(db, 't1', 'card-a', '牛顿第一定律的内容？', '["力学"]');
    insertCard(db, 't1', 'card-b', '牛顿第二定律的表达式？', '["力学"]');
    insertCard(db, 't1', 'card-c', '牛顿第三定律的内容？', '["力学"]');
    for (const cardId of ['card-a', 'card-b', 'card-c']) {
      enqueueCard(db, cardId, 0);
    }
    makeLapsed(db, 'card-a', 2, 0);
    makeLapsed(db, 'card-b', 7, 0);
    makeLapsed(db, 'card-c', 4, 0);

    const rows = listFeedbackRows(db, 100);
    expect(rows).toHaveLength(3);
    const ids = rows.map((row) => row.ankiCardId);
    expect(ids).toEqual(['card-b', 'card-c', 'card-a']); // 按 lapses 降序
    expect(rows[0]!.lapses).toBe(7);
    expect(rows[0]!.tags).toEqual(['力学']);
    expect(rows[0]!.stability).not.toBeNull();

    // limit 生效
    const limited = listFeedbackRows(db, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.ankiCardId).toBe('card-b');
  });

  it('injection_contains_profile_and_interference_sections', () => {
    insertCard(db, 't1', 'card-hi', '牛顿第二定律的表达式是什么？', '["力学","牛顿定律"]');
    insertCard(db, 't1', 'card-hi2', '牛顿第二定律的适用条件？', '["力学","牛顿定律"]');
    insertCard(db, 't1', 'card-far', '光合作用发生在哪里？', '["生物"]');
    for (const cardId of ['card-hi', 'card-hi2', 'card-far']) {
      enqueueCard(db, cardId, Date.now());
    }
    makeLapsed(db, 'card-hi', 6, 0);
    makeLapsed(db, 'card-hi2', 4, 0);
    // card-far 保持 New（无 lapse）

    // 默认配置（0824 隐私收口）：只注入匿名聚合画像，
    // 不注入历史卡片原文（高遗忘卡示例 / 干扰预警），也不再声称「仅本地/不上传」。
    const config = defaultFsrsFeedbackConfig();
    const injected = buildFeedbackInjection(db, '本章系统讲解牛顿第二定律及其应用', config);
    expect(injected).not.toBeNull();
    expect(injected ?? '').toContain('用户复习画像');
    expect(injected ?? '').toContain('易混淆标签');
    expect(injected ?? '').not.toContain('数据仅本地');
    expect(injected ?? '').not.toContain('不上传');
    expect(injected ?? '').not.toContain('同批次语义干扰预警');
    expect(injected ?? '').not.toContain('牛顿第二定律的表达式是什么？');

    // 显式开启 include_card_excerpts 后才注入卡片摘要与干扰预警
    const optedIn = defaultFsrsFeedbackConfig();
    optedIn.includeCardExcerpts = true;
    const full = buildFeedbackInjection(db, '本章系统讲解牛顿第二定律及其应用', optedIn);
    expect(full).not.toBeNull();
    // 干扰 section：主题相近的高 lapse 卡入选，不相近的不入选
    expect(full ?? '').toContain('同批次语义干扰预警');
    expect(full ?? '').toContain('牛顿第二定律的表达式是什么？');
    expect(full ?? '').not.toContain('光合作用');
    // 不泄露答案内容（只注入 front 摘要）
    expect(full ?? '').not.toContain('back');
  });

  it('unrelated_document_still_gets_profile_without_interference', () => {
    insertCard(db, 't1', 'card-x', '细胞呼吸的三个阶段？', '["生物","代谢"]');
    insertCard(db, 't1', 'card-y', '细胞呼吸的场所？', '["生物","代谢"]');
    for (const cardId of ['card-x', 'card-y']) {
      enqueueCard(db, cardId, Date.now());
    }
    makeLapsed(db, 'card-x', 5, 0);
    makeLapsed(db, 'card-y', 3, 0);

    // 显式开启摘要外送，验证的是「无关键词重叠」这一层过滤（而非隐私开关）。
    const config = defaultFsrsFeedbackConfig();
    config.includeCardExcerpts = true;
    const injected = buildFeedbackInjection(db, 'French Revolution timeline and causes', config);
    expect(injected).not.toBeNull();
    expect(injected ?? '').toContain('用户复习画像');
    expect(injected ?? '').not.toContain('同批次语义干扰预警');
  });

  it('profile_reflects_due_and_lapse_aggregates', () => {
    insertCard(db, 't1', 'card-1', '问题一？', '["标签甲"]');
    insertCard(db, 't1', 'card-2', '问题二？', '["标签甲"]');
    for (const cardId of ['card-1', 'card-2']) {
      enqueueCard(db, cardId, Date.now());
    }
    // card-1 已到期且高 lapse；card-2 未来到期（i64::MAX / 2）
    makeLapsed(db, 'card-1', 8, 0);
    makeLapsed(db, 'card-2', 2, 4_611_686_018_427_387_903n);

    const config = defaultFsrsFeedbackConfig();
    const profile = buildUserReviewProfile(db, config);
    expect(profile.totalCards).toBe(2);
    expect(profile.reviewedCards).toBe(2);
    expect(profile.dueCards).toBe(1);
    expect(profile.avgRetrievability).not.toBeNull();
    // 标签甲：2 卡 / 10 次遗忘 → 易混淆标签
    expect(profile.confusableTags).toHaveLength(1);
    expect(profile.confusableTags[0]!.tag).toBe('标签甲');
    expect(profile.confusableTags[0]!.totalLapses).toBe(10);
    // basic 模板聚合
    expect(profile.highLapseTemplates).toHaveLength(1);
    expect(profile.highLapseTemplates[0]!.templateId).toBe('basic');
    expect(profile.highLapseTemplates[0]!.dueCards).toBe(1);
  });
});
