import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_CAP,
  DEFAULT_PROMPT_TOKEN_BUDGET,
  MAX_STORE_ENTRIES,
  consolidate,
  consolidateObservation,
  createConsolidateOutcome,
  createPreferenceStore,
  createSessionObservation,
  estimateTokens,
  extractPreferences,
  retrievePreferencePrompt,
  type CardDeleteObservation,
  type CardEditObservation,
  type PreferenceCandidate,
  type PreferenceKind,
  type PreferenceStore,
  type SessionObservation,
} from '../src/preference-memory.ts';

function edit(field: string, before: string, after: string): CardEditObservation {
  return { field, before, after };
}

function find(
  candidates: readonly PreferenceCandidate[],
  kind: PreferenceKind,
): PreferenceCandidate | undefined {
  return candidates.find((candidate) => candidate.kind === kind);
}

function observation(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return createSessionObservation(overrides);
}

describe('crates/dstu-anki/src/anki_preference_memory.rs::tests', () => {
  // ---- extract：extraRequirements 显式信号 ----

  it('extract_language_zh_from_extra_requirements', () => {
    const obs = observation({
      extra_requirements: '请用中文回答，答案要包含推导过程',
    });
    const cands = extractPreferences(obs);
    const lang = find(cands, 'language');
    expect(lang, '应产出语言偏好').toBeDefined();
    expect(lang?.subject).toBe('zh');
    expect(lang?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(lang?.statement).toContain('中文');
  });

  it('extract_language_en_and_ambiguity_guard', () => {
    const obs = observation({
      extra_requirements: 'Please write all cards in English',
    });
    const cands = extractPreferences(obs);
    expect(find(cands, 'language')?.subject).toBe('en');

    // 中英信号同时出现 → 歧义，保守不产出。
    const ambiguous = observation({
      extra_requirements: '正面用中文回答，背面 in English',
    });
    expect(find(extractPreferences(ambiguous), 'language')).toBeUndefined();
  });

  it('extract_no_translation_from_extra_requirements', () => {
    const obs = observation({
      extra_requirements: '专业术语保留英文，不要翻译成中文',
    });
    const cands = extractPreferences(obs);
    const pref = find(cands, 'no_translation');
    expect(pref, '应产出禁止翻译偏好').toBeDefined();
    expect(pref?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('extract_density_numeric_limit', () => {
    const obs = observation({
      extra_requirements: '重点做概念卡，每段最多 6 张卡',
    });
    const cands = extractPreferences(obs);
    const density = find(cands, 'card_density');
    expect(density, '应产出密度偏好').toBeDefined();
    expect(density?.subject).toBe('6');
    expect(density?.statement).toContain('6');
  });

  it('extract_template_preference_with_negation_guard', () => {
    const obs = observation({
      extra_requirements: '请用学术填空题模板，覆盖第 3 章',
    });
    const cands = extractPreferences(obs);
    const tpl = find(cands, 'template_preference');
    expect(tpl, '应产出模板偏好').toBeDefined();
    expect(tpl?.subject).toBe('学术填空题');
    expect(tpl?.statement).toContain('学术填空题');

    // 否定前缀不得误判为偏好。
    const negated = observation({
      extra_requirements: '不要用填空模板',
    });
    expect(
      find(extractPreferences(negated), 'template_preference'),
      '否定语境不应抽出模板偏好',
    ).toBeUndefined();
  });

  // ---- extract：编辑 diff 信号 ----

  it('extract_language_shift_from_edits', () => {
    const obs = observation({
      edits: [
        edit(
          'back',
          'Mitochondria are the powerhouse of the cell.',
          '线粒体是细胞的能量工厂，通过氧化磷酸化合成 ATP。',
        ),
        edit(
          'back',
          'Osmosis is the diffusion of water across a membrane.',
          '渗透是水分子经半透膜从低浓度溶液向高浓度溶液的扩散。',
        ),
      ],
    });
    const cands = extractPreferences(obs);
    const lang = find(cands, 'language');
    expect(lang, '两次改写为中文应产出语言偏好').toBeDefined();
    expect(lang?.subject).toBe('zh');
    expect(lang?.confidence).toBeLessThan(0.9); // 行为信号置信度应低于显式要求

    // 单次改写不足以下结论。
    const single = observation({
      edits: [edit('back', 'The cell.', '细胞是生命的基本单位。')],
    });
    expect(find(extractPreferences(single), 'language')).toBeUndefined();
  });

  it('extract_no_translation_from_reinstated_terms', () => {
    const obs = observation({
      edits: [
        edit(
          'back',
          '注意力机制会计算查询与键的相似度。',
          '注意力机制（attention）会计算 query 与 key 的相似度。',
        ),
        edit('front', '什么是分词？', '什么是分词（tokenize）？'),
      ],
    });
    const cands = extractPreferences(obs);
    const pref = find(cands, 'no_translation');
    expect(pref, '回写多个术语应产出禁止翻译偏好').toBeDefined();
    const statement = pref?.statement ?? '';
    expect(statement.includes('attention') || statement.includes('tokenize')).toBe(true);
    expect(pref?.evidence).toContain('术语原文');
  });

  // ---- extract：删卡密度信号 ----

  it('extract_density_from_heavy_deletion_only', () => {
    const deleted = (n: number): CardDeleteObservation[] =>
      Array.from({ length: n }, (_, i) => ({ front: `Q${i}`, back: `A${i}` }));

    // 10 张删 4 张（40%）→ 产出。
    const heavy = observation({
      deletions: deleted(4),
      generated_count: 10,
    });
    const cands = extractPreferences(heavy);
    const density = find(cands, 'card_density');
    expect(density, '高删除率应产出密度偏好').toBeDefined();
    expect(density?.evidence).toContain('4/10');

    // 10 张删 1 张（10%）→ 不产出。
    const light = observation({
      deletions: deleted(1),
      generated_count: 10,
    });
    expect(find(extractPreferences(light), 'card_density')).toBeUndefined();

    // 样本太小（3 张删 2 张）→ 不产出。
    const tiny = observation({
      deletions: deleted(2),
      generated_count: 3,
    });
    expect(find(extractPreferences(tiny), 'card_density')).toBeUndefined();
  });

  it('extract_empty_observation_yields_nothing', () => {
    expect(extractPreferences(createSessionObservation())).toHaveLength(0);
    const blank = observation({ extra_requirements: '   ' });
    expect(extractPreferences(blank)).toHaveLength(0);
  });

  // ---- consolidate：ADD-only 语义 ----

  it('consolidate_adds_new_entries', () => {
    const store = createPreferenceStore();
    const cands = extractPreferences(
      observation({ extra_requirements: '请用中文回答，不要翻译术语' }),
    );
    expect(cands).toHaveLength(2);
    const outcome = consolidate(store, cands, 1_000);
    expect(outcome.added).toHaveLength(2);
    expect(outcome.reinforced).toHaveLength(0);
    expect(store.entries).toHaveLength(2);
    expect(store.entries.every((e) => e.evidence_count === 1)).toBe(true);
    expect(store.entries.every((e) => e.first_seen_ms === 1_000)).toBe(true);
  });

  it('consolidate_observation_runs_extract_and_add', () => {
    const store = createPreferenceStore();
    const obs = observation({ extra_requirements: '请用中文回答，不要翻译术语' });

    const outcome = consolidateObservation(store, obs, 1_234);

    expect(outcome.added).toHaveLength(2);
    expect(outcome.reinforced).toHaveLength(0);
    expect(store.entries).toHaveLength(2);
    expect(store.entries.every((entry) => entry.first_seen_ms === 1_234)).toBe(true);
  });

  it('consolidate_observation_without_signal_is_noop', () => {
    const store = createPreferenceStore();

    const outcome = consolidateObservation(store, createSessionObservation(), 1_234);

    expect(outcome).toEqual(createConsolidateOutcome());
    expect(store.entries).toHaveLength(0);
  });

  it('consolidate_observation_preserves_add_only_conflicts', () => {
    const store = createPreferenceStore();
    for (const requirement of ['请用中文回答', 'Please write cards in English']) {
      consolidateObservation(
        store,
        observation({ extra_requirements: requirement }),
        1_234,
      );
    }

    expect(store.entries).toHaveLength(2);
    expect(store.entries.some((entry) => entry.subject === 'zh')).toBe(true);
    expect(store.entries.some((entry) => entry.subject === 'en')).toBe(true);
  });

  it('consolidate_reinforces_duplicates_and_keeps_conflicts', () => {
    const store = createPreferenceStore();
    const zh = extractPreferences(observation({ extra_requirements: '请用中文回答' }));
    consolidate(store, zh, 1_000);
    const outcome = consolidate(store, zh, 2_000);

    // 重复观察 → 强化而非新增。
    expect(outcome.reinforced).toHaveLength(1);
    expect(outcome.added).toHaveLength(0);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.evidence_count).toBe(2);
    expect(store.entries[0]?.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP);
    expect(store.entries[0]?.last_seen_ms).toBe(2_000);
    expect(store.entries[0]?.first_seen_ms).toBe(1_000);

    // 矛盾偏好（改偏好英文）→ ADD-only：新增共存，绝不改写/删除旧条目。
    const en = extractPreferences(
      observation({ extra_requirements: 'please write cards in English' }),
    );
    const conflictOutcome = consolidate(store, en, 3_000);
    expect(conflictOutcome.added).toHaveLength(1);
    expect(store.entries).toHaveLength(2);
    expect(store.entries.some((e) => e.subject === 'zh')).toBe(true);
    expect(store.entries.some((e) => e.subject === 'en')).toBe(true);
  });

  it('consolidate_confidence_capped', () => {
    const store = createPreferenceStore();
    const cands = extractPreferences(observation({ extra_requirements: '请用中文回答' }));
    for (let i = 0; i < 20; i++) {
      consolidate(store, cands, i);
    }
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP);
    expect(store.entries[0]?.evidence_count).toBe(20);
  });

  it('consolidate_evicts_lowest_score_beyond_capacity', () => {
    const store = createPreferenceStore();
    // 先塞满：用不同模板名生成 MAX 个不同条目。
    for (let i = 0; i < MAX_STORE_ENTRIES; i++) {
      const cand: PreferenceCandidate = {
        kind: 'template_preference',
        statement: `优先使用「模板${i}」模板`,
        subject: `模板${i}`,
        confidence: 0.9,
        evidence: 'test',
      };
      consolidate(store, [cand], i);
    }
    expect(store.entries).toHaveLength(MAX_STORE_ENTRIES);

    // 再加入一条低置信度条目 → 容量维护会淘汰全库最低分（即它自己）。
    const weak: PreferenceCandidate = {
      kind: 'card_density',
      statement: '控制卡片密度：少而精',
      subject: null,
      confidence: 0.1,
      evidence: 'test',
    };
    const outcome = consolidate(store, [weak], 99_999);
    expect(store.entries).toHaveLength(MAX_STORE_ENTRIES);
    expect(outcome.evicted).toHaveLength(1);
  });

  // ---- retrieve：检索与预算 ----

  it('retrieve_empty_store_returns_empty', () => {
    const store = createPreferenceStore();
    expect(
      retrievePreferencePrompt(store, '复习细胞呼吸', [], DEFAULT_PROMPT_TOKEN_BUDGET),
    ).toBe('');
  });

  it('retrieve_picks_one_per_kind_and_filters_unavailable_templates', () => {
    const store = createPreferenceStore();
    // 两条矛盾语言偏好：zh 证据更多 → 检索只取 zh。
    const zh = extractPreferences(observation({ extra_requirements: '请用中文回答' }));
    consolidate(store, zh, 1_000);
    consolidate(store, zh, 2_000);
    const en = extractPreferences(
      observation({ extra_requirements: 'please write cards in English' }),
    );
    consolidate(store, en, 3_000);
    // 模板偏好：目标模板不在可用列表 → 应被过滤。
    const tpl = extractPreferences(
      observation({ extra_requirements: '请用手稿风格模板' }),
    );
    consolidate(store, tpl, 4_000);

    const available = ['学术选择题', '学术填空题'];
    const prompt = retrievePreferencePrompt(store, '整理讲义', available, 200);
    expect(prompt, `应选中证据更多的中文偏好: ${prompt}`).toContain('中文');
    expect(prompt, `每 kind 只取一条: ${prompt}`).not.toContain('英文');
    expect(prompt, `不可用模板应被过滤: ${prompt}`).not.toContain('手稿风格');

    // 模板在可用列表中时应注入（双向包含匹配）。
    const available2 = ['手稿风格'];
    const prompt2 = retrievePreferencePrompt(store, '整理讲义', available2, 200);
    expect(prompt2, `可用模板应注入: ${prompt2}`).toContain('手稿风格');
  });

  it('retrieve_respects_token_budget', () => {
    const store = createPreferenceStore();
    const cands = extractPreferences(
      observation({
        extra_requirements: '请用中文回答，不要翻译术语，每段最多 5 张卡，请用学术填空题模板',
      }),
    );
    expect(cands, '四类偏好应全部抽出').toHaveLength(4);
    consolidate(store, cands, 1_000);
    const available = ['学术填空题'];

    // 充足预算：4 行全部注入，且实际 token 不超预算。
    const full = retrievePreferencePrompt(store, 'goal', available, 200);
    expect(full.split('\n'), `header + 4 行: ${full}`).toHaveLength(5);
    expect(estimateTokens(full)).toBeLessThanOrEqual(200);

    // 紧预算：只装得下部分行。
    const tight = retrievePreferencePrompt(store, 'goal', available, 60);
    expect(tight).not.toBe('');
    expect(tight.split('\n').length, `紧预算应丢行: ${tight}`).toBeLessThan(5);
    expect(estimateTokens(tight)).toBeLessThanOrEqual(60);

    // 预算过小：一行都放不下 → 空串。
    expect(retrievePreferencePrompt(store, 'goal', available, 10)).toBe('');
    expect(retrievePreferencePrompt(store, 'goal', available, 0)).toBe('');
  });

  it('retrieve_goal_keyword_boost', () => {
    const store = createPreferenceStore();
    for (const name of ['学术选择题', '学术填空题']) {
      const cand: PreferenceCandidate = {
        kind: 'template_preference',
        statement: `优先使用「${name}」模板`,
        subject: name,
        confidence: 0.6,
        evidence: 'test',
      };
      consolidate(store, [cand], 1_000);
    }
    const available = ['学术选择题', '学术填空题'];
    // goal 提到填空 → 填空模板条目应因关键词加权胜出。
    const prompt = retrievePreferencePrompt(store, '把讲义做成学术填空题练习', available, 200);
    expect(prompt, `goal 关键词应加权: ${prompt}`).toContain('学术填空题');
    expect(prompt).not.toContain('学术选择题');
  });

  // ---- 工具函数与序列化 ----

  it('estimate_tokens_sanity', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    // 4 个 CJK 字 = 4 tokens。
    expect(estimateTokens('细胞呼吸')).toBe(4);
    // 8 个 ASCII 字符 = 2 tokens（4 字符 ≈ 1 token，向上取整）。
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcde')).toBe(2);
    // 混排：2 CJK + 4 ASCII = 2 + 1 = 3。
    expect(estimateTokens('细胞 cell')).toBe(3);
  });

  it('store_serde_round_trip', () => {
    const store = createPreferenceStore();
    const cands = extractPreferences(
      observation({ extra_requirements: '请用中文回答，每段最多 5 张卡' }),
    );
    consolidate(store, cands, 42);

    const json = JSON.stringify(store);
    const restored = JSON.parse(json) as PreferenceStore;
    expect(restored.entries).toHaveLength(store.entries.length);
    expect(restored.entries[0]?.statement).toBe(store.entries[0]?.statement);
    expect(restored.entries[0]?.evidence_count).toBe(1);
    expect(restored.entries[0]?.first_seen_ms).toBe(42);

    // kind 序列化为 snake_case，便于跨端消费。
    expect(json.includes('"language"') || json.includes('"card_density"')).toBe(true);
  });
});
