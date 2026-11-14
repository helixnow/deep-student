/**
 * `tests/qa_pass_critic_combo.rs`（11 条）的移植。
 *
 * QA 留痕三条来源（字段规则 / 确定性 lint / critic relint）× `enable_qa_pass`
 * 两态的完整组合矩阵。开关解析走真实 options wire；false 侧只剥
 * `_qa_flags`，`_content_provenance` 必须存活（金标第二道闸）。
 */
import { describe, expect, it } from 'vitest';
import { regex } from '../../../platform/native/regex/index.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import {
  CRITIC_FLAG_CODE,
  CRITIC_REVISED_CODE,
  planUpdates,
  sanitizePlanForDisabledQaPass,
  type CardVerdict,
  type CriticPlan,
  type RevisedFields,
  type Verdict,
} from '../src/anki-critic.ts';
import {
  CONTENT_PROVENANCE_FIELD,
  CRITIC_REVISED_QA_CODE,
  PROVENANCE_ACTOR_LLM_CRITIC,
  hasCriticRevisionMarker,
  isLlmCriticActor,
  isUserProvenEdit,
  parseContentProvenance,
} from '../src/anki-gold-set.ts';
import {
  qaPassEnabled,
  structuredOutputOptionsFromOptionsJson,
} from '../src/anki-protocol.ts';
import {
  QA_FLAGS_FIELD,
  codes,
  defaultLintConfig,
  lintCard,
  lintFieldAgainstRule,
  mergeFlags,
  type CardLintInput,
  type LintIssue,
} from '../src/anki-qa-lint.ts';
import { decodeFieldExtractionRule } from '../src/templates.ts';

// ============================================================================
// fixture 构造
// ============================================================================

function cardFromJson(
  id: string,
  front: string,
  back: string,
  tags: string[],
  extras: Record<string, string>,
): AnkiCard {
  return {
    id,
    task_id: 'task-combo',
    front,
    back,
    text: null,
    tags,
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z',
    extra_fields: extras,
    template_id: null,
  };
}

/** 真实 wire 形态的 options JSON；`enable_qa_pass` 省略 = 默认开启。 */
function optionsJson(enableQaPass: boolean | null): string {
  const value: Record<string, unknown> = {
    deck_name: '默认牌组',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 5,
  };
  if (enableQaPass !== null) value.enable_qa_pass = enableQaPass;
  return JSON.stringify(value);
}

/** 复现 `run_critic_pass` 的门控接线：仅当 options 解析出 `enable_qa_pass=false` 时收口。 */
function planWithQaGate(
  cards: readonly AnkiCard[],
  verdicts: readonly CardVerdict[],
  optionsJsonText: string,
): CriticPlan {
  const plan = planUpdates(cards, verdicts);
  if (!qaPassEnabled(structuredOutputOptionsFromOptionsJson(optionsJsonText))) {
    sanitizePlanForDisabledQaPass(plan, cards);
  }
  return plan;
}

/** 选择题 correct 字段的模板规则（allowed A-D + 模式 ^[A-D]$）。 */
function correctFieldRule() {
  return decodeFieldExtractionRule({
    field_type: 'Text',
    is_required: true,
    default_value: null,
    validation_pattern: '^[A-D]$',
    description: '正确选项',
    min_length: 1,
    max_length: 1,
    allowed_values: ['A', 'B', 'C', 'D'],
  });
}

/** 解出 `_qa_flags` JSON 数组（键缺失 → 空列表；非法 JSON 直接抛错暴露污染）。 */
function qaEntries(extras: Record<string, string>): Record<string, unknown>[] {
  const raw = extras[QA_FLAGS_FIELD];
  if (raw === undefined) return [];
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error('_qa_flags 必须是合法 JSON 数组');
  return value as Record<string, unknown>[];
}

/** 全部结构化 code（legacy `{field, rule}` 条目无 code，不计入）。 */
function qaCodes(extras: Record<string, string>): string[] {
  return qaEntries(extras)
    .map((entry) => entry.code)
    .filter((code): code is string => typeof code === 'string');
}

function flagVerdict(cardId: string): CardVerdict {
  return {
    card_id: cardId,
    verdict: 'flag',
    reasons: ['与同批卡片重复'],
    revised: null,
  };
}

function reviseVerdict(cardId: string, back: string): CardVerdict {
  const revised: RevisedFields = { front: null, back, text: null };
  return {
    card_id: cardId,
    verdict: 'revise',
    reasons: ['答案与源材料不符'],
    revised,
  };
}

/**
 * 组合卡：字段规则违规（correct="E"）+ 确定性 lint 违规（双问号 multi_concept、
 * 空 tags → tags_empty）；第三条（critic relint）由 revise 裁决触发。
 */
async function comboCardWithFieldRuleAndLintHistory(): Promise<AnkiCard> {
  const card = cardFromJson(
    'c-combo',
    '什么是惯性？惯性是什么？',
    '物体保持原有运动状态不变的性质',
    [],
    { correct: 'E' },
  );
  const fieldIssues = await lintFieldAgainstRule('correct', 'E', correctFieldRule(), regex);
  mergeFlags(card.extra_fields, fieldIssues);
  const input: CardLintInput = {
    front: card.front,
    back: card.back,
    text: card.text,
    tags: card.tags,
    extra_fields: card.extra_fields,
  };
  const lintIssues = lintCard(input, defaultLintConfig());
  mergeFlags(card.extra_fields, lintIssues);
  return card;
}

// ============================================================================
// 轴 0：enable_qa_pass 的 wire 解析
// ============================================================================

describe('tests/qa_pass_critic_combo.rs', () => {
  it('options_wire_qa_pass_toggle_parses_explicit_default_and_malformed', () => {
    const off = structuredOutputOptionsFromOptionsJson(optionsJson(false));
    expect(off.enable_qa_pass).toBe(false);
    expect(qaPassEnabled(off)).toBe(false);

    const on = structuredOutputOptionsFromOptionsJson(optionsJson(true));
    expect(qaPassEnabled(on)).toBe(true);

    const defaulted = structuredOutputOptionsFromOptionsJson(optionsJson(null));
    expect(defaulted.enable_qa_pass).toBeNull();
    expect(qaPassEnabled(defaulted)).toBe(true);

    expect(
      qaPassEnabled(structuredOutputOptionsFromOptionsJson('not-json')),
      '非法 JSON 回退默认 = 开启',
    ).toBe(true);
    expect(
      qaPassEnabled(structuredOutputOptionsFromOptionsJson('{"enable_qa_pass":false}')),
      '残缺 options（缺必填字段）整体解析失败 → 回退默认开启，false 不生效',
    ).toBe(true);
  });

  // ==========================================================================
  // enable_qa_pass=true 侧：三条来源逐一落痕、共存、去重
  // ==========================================================================

  it('field_rule_violations_land_in_qa_flags_and_clean_value_stays_unflagged', async () => {
    const rule = correctFieldRule();

    const issues = await lintFieldAgainstRule('correct', 'E', rule, regex);
    const extras: Record<string, string> = {};
    mergeFlags(extras, issues);
    const codesSeen = qaCodes(extras);
    expect(codesSeen).toContain(codes.FIELD_RULE_ALLOWED_VALUES);
    expect(codesSeen).toContain(codes.FIELD_RULE_PATTERN);
    expect(
      qaEntries(extras).every((entry) => entry.field === 'correct'),
      '字段规则条目必须落在违规字段名上',
    ).toBe(true);

    const clean: Record<string, string> = {};
    mergeFlags(clean, await lintFieldAgainstRule('correct', 'A', rule, regex));
    expect(
      Object.hasOwn(clean, QA_FLAGS_FIELD),
      '合法值不得写入 _qa_flags 键',
    ).toBe(false);
  });

  it('deterministic_lint_merges_alongside_field_rule_history_and_dedupes', () => {
    const extras: Record<string, string> = {
      [QA_FLAGS_FIELD]: JSON.stringify([
        { field: 'correct', rule: 'allowed_values', message: '值 E 不在允许值列表中' },
      ]),
    };

    const input: CardLintInput = {
      front: '什么是惯性？惯性是什么？',
      back: '物体保持原有运动状态不变的性质',
      text: null,
      tags: [],
      extra_fields: {},
    };
    const issues = lintCard(input, defaultLintConfig());
    mergeFlags(extras, issues);
    mergeFlags(extras, issues); // 重复 merge 必须幂等

    const entries = qaEntries(extras);
    expect(entries[0]!.rule, 'legacy 字段规则条目必须保留在首位').toBe('allowed_values');
    const codesSeen = qaCodes(extras);
    expect(codesSeen).toContain(codes.MULTI_CONCEPT);
    expect(codesSeen).toContain(codes.TAGS_EMPTY);
    expect(
      codesSeen.filter((code) => code === codes.MULTI_CONCEPT).length,
      '同 (code, field) 重复 merge 不得产生重复条目',
    ).toBe(1);
  });

  it('enabled_qa_pass_critic_flag_verdict_appends_llm_critic_entry', async () => {
    const card = await comboCardWithFieldRuleAndLintHistory();
    const historyLen = qaEntries(card.extra_fields).length;

    const plan = planWithQaGate([card], [flagVerdict('c-combo')], optionsJson(true));

    expect(plan.flagged).toBe(1);
    expect(plan.updates.length, 'flag 裁决在 QA 开启时必须产生留痕写回').toBe(1);
    const updated = plan.updates[0]!;
    const entries = qaEntries(updated.extra_fields);
    expect(entries.length, '只追加一条 llm_critic 条目').toBe(historyLen + 1);
    expect(qaCodes(updated.extra_fields)).toContain(CRITIC_FLAG_CODE);
    expect(
      hasCriticRevisionMarker(updated.extra_fields),
      'flag 裁决不改内容，不得打 revised marker',
    ).toBe(false);
    expect(
      parseContentProvenance(updated.extra_fields),
      'flag 裁决不写内容，不得盖溯源戳',
    ).toBeNull();
  });

  it('enabled_qa_pass_critic_revise_relints_audits_and_stamps_provenance', () => {
    const card = cardFromJson(
      'c-revise',
      '什么是惯性？',
      '物体保持原有运动状态不变的性质',
      ['物理'],
      {},
    );
    const plan = planWithQaGate(
      [card],
      [reviseVerdict('c-revise', '请参考 {{DOCUMENT_CONTENT}}')],
      optionsJson(null), // 缺省 = 开启：默认路径必须留痕
    );

    expect(plan.revised).toBe(1);
    expect(plan.updates.length).toBe(1);
    const updated = plan.updates[0]!;
    expect(updated.back, '修订内容必须写回').toBe('请参考 {{DOCUMENT_CONTENT}}');
    expect(updated.id, '主键永不变更').toBe('c-revise');

    const entries = qaEntries(updated.extra_fields);
    const audit = entries.find((entry) => entry.code === CRITIC_REVISED_CODE);
    expect(audit, '必须携带 llm_critic_revised 审计条目').toBeDefined();
    expect(audit!.severity).toBe('info');
    const relint = entries.find((entry) => entry.code === codes.PLACEHOLDER_RESIDUE);
    expect(relint, 'relint 必须抓到 revise 引入的模板占位符').toBeDefined();
    expect(relint!.field).toBe('back');
    expect(relint!.severity).toBe('error');

    expect(hasCriticRevisionMarker(updated.extra_fields)).toBe(true);
    const prov = parseContentProvenance(updated.extra_fields);
    expect(prov, 'revise 必须盖 _content_provenance 溯源戳').not.toBeNull();
    expect(prov!.actor).toBe(PROVENANCE_ACTOR_LLM_CRITIC);
    expect(prov!.code).toBe(CRITIC_REVISED_QA_CODE);
  });

  it('enabled_qa_pass_full_combo_keeps_all_flag_sources_coexisting_deduped', async () => {
    const card = await comboCardWithFieldRuleAndLintHistory();
    const plan = planWithQaGate(
      [card],
      [reviseVerdict('c-combo', '请参考 {{DOCUMENT_CONTENT}}')],
      optionsJson(true),
    );

    expect(plan.updates.length).toBe(1);
    const updated = plan.updates[0]!;
    const codesSeen = qaCodes(updated.extra_fields);
    for (const expected of [
      codes.FIELD_RULE_ALLOWED_VALUES,
      codes.FIELD_RULE_PATTERN,
      codes.MULTI_CONCEPT,
      codes.TAGS_EMPTY,
      CRITIC_REVISED_CODE,
      codes.PLACEHOLDER_RESIDUE,
    ]) {
      expect(codesSeen, `组合留痕缺少 ${expected}: ${JSON.stringify(codesSeen)}`).toContain(
        expected,
      );
    }
    for (const dedupCode of [codes.MULTI_CONCEPT, codes.TAGS_EMPTY]) {
      expect(
        codesSeen.filter((code) => code === dedupCode).length,
        `${dedupCode} 在 relint 复报后必须保持单条`,
      ).toBe(1);
    }
    expect(isLlmCriticActor(updated.extra_fields)).toBe(true);
  });

  // ==========================================================================
  // enable_qa_pass=false 侧：不落 `_qa_flags`，但 provenance 仍落
  // ==========================================================================

  it('disabled_qa_pass_drops_flag_only_update_even_with_field_rule_history', async () => {
    const card = await comboCardWithFieldRuleAndLintHistory();
    const plan = planWithQaGate([card], [flagVerdict('c-combo')], optionsJson(false));

    expect(
      plan.updates.length,
      '关 QA 留痕后 flag-only 更新必须整体丢弃（不空写回、不删历史留痕）',
    ).toBe(0);
    expect(plan.flagged, '裁决统计不受门控影响').toBe(1);
  });

  it('disabled_qa_pass_revise_strips_all_flag_sources_but_provenance_survives', async () => {
    const card = await comboCardWithFieldRuleAndLintHistory();
    const plan = planWithQaGate(
      [card],
      [reviseVerdict('c-combo', '请参考 {{DOCUMENT_CONTENT}}')],
      optionsJson(false),
    );

    expect(plan.revised).toBe(1);
    expect(plan.updates.length, '有实质内容差异的 revise 必须保留写回').toBe(1);
    const updated = plan.updates[0]!;
    expect(updated.back).toBe('请参考 {{DOCUMENT_CONTENT}}');
    expect(
      Object.hasOwn(updated.extra_fields, QA_FLAGS_FIELD),
      'false 侧不得落任何 _qa_flags（字段规则/lint/审计/relint 一律剥）',
    ).toBe(false);
    const prov = parseContentProvenance(updated.extra_fields);
    expect(prov, '溯源戳必须随内容修订一并落盘').not.toBeNull();
    expect(prov!.actor).toBe(PROVENANCE_ACTOR_LLM_CRITIC);
    expect(prov!.code).toBe(CRITIC_REVISED_QA_CODE);
  });

  it('disabled_qa_pass_drops_noop_revise_where_only_provenance_differs', () => {
    const card = cardFromJson(
      'c-noop',
      '什么是惯性？',
      '物体保持原有运动状态不变的性质',
      ['物理'],
      { note: '保持不变的业务扩展字段' },
    );
    const plan = planWithQaGate(
      [card],
      // revised.back 与原卡逐字相同 → 套用后内容零变化
      [reviseVerdict('c-noop', '物体保持原有运动状态不变的性质')],
      optionsJson(false),
    );

    expect(plan.revised, '裁决统计照常（critic 观测不受门控影响）').toBe(1);
    expect(
      plan.updates.length,
      '内容零变化的 revise 在 false 侧必须丢弃——溯源戳不是落盘理由',
    ).toBe(0);
  });

  it('disabled_qa_pass_output_card_still_excluded_by_provenance_gold_gate', () => {
    const card = cardFromJson('c-gate', '什么是熵？', '系统混乱程度的度量', ['热学'], {});
    const plan = planWithQaGate(
      [card],
      [reviseVerdict('c-gate', '熵是系统微观状态数的对数度量')],
      optionsJson(false),
    );
    expect(plan.updates.length).toBe(1);
    const landed = plan.updates[0]!;

    expect(
      hasCriticRevisionMarker(landed.extra_fields),
      '第一道闸（_qa_flags marker）在 false 侧确已失明——这正是需要第二道闸的场景',
    ).toBe(false);
    expect(
      isLlmCriticActor(landed.extra_fields),
      '第二道闸（provenance actor=llm_critic）必须命中',
    ).toBe(true);
    expect(
      isUserProvenEdit(landed.extra_fields),
      'critic 自改绝不构成用户编辑证明',
    ).toBe(false);
    expect(
      Object.hasOwn(landed.extra_fields, CONTENT_PROVENANCE_FIELD),
      '溯源键必须在落库形态中存活',
    ).toBe(true);
  });

  // ==========================================================================
  // 严重度语义在组合下保持
  // ==========================================================================

  it('combined_flag_entries_preserve_per_source_severity', async () => {
    const fieldIssues: LintIssue[] = await lintFieldAgainstRule(
      'correct',
      'E',
      correctFieldRule(),
      regex,
    );
    expect(
      fieldIssues.every((issue) => issue.severity === 'warn'),
      '字段规则违规恒为 Warn（不丢卡）',
    ).toBe(true);

    const card = await comboCardWithFieldRuleAndLintHistory();
    const plan = planWithQaGate(
      [card],
      [reviseVerdict('c-combo', '请参考 {{DOCUMENT_CONTENT}}')],
      optionsJson(true),
    );
    const entries = qaEntries(plan.updates[0]!.extra_fields);
    const severityOf = (code: string): string | undefined => {
      const entry = entries.find((candidate) => candidate.code === code);
      const severity = entry?.severity;
      return typeof severity === 'string' ? severity : undefined;
    };
    expect(severityOf(codes.FIELD_RULE_ALLOWED_VALUES)).toBe('warn');
    expect(severityOf(CRITIC_REVISED_CODE)).toBe('info');
    expect(severityOf(codes.PLACEHOLDER_RESIDUE)).toBe('error');
  });
});
