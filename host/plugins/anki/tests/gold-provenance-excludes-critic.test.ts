/**
 * `tests/gold_provenance_excludes_critic.rs`（14 条）的移植。
 *
 * 核心红线：critic 自动修订卡（marker 或 provenance actor=llm_critic）不得
 * 进入 grounded reference；非 user actor 一律 fail-closed。
 */
import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import {
  CRITIC_REVISED_CODE,
  defaultCriticConfig,
  goldReferencesFromCards,
  parseCriticResponse,
  planUpdates,
  sanitizePlanForDisabledQaPass,
} from '../src/anki-critic.ts';
import {
  CONTENT_PROVENANCE_FIELD,
  CRITIC_REVISED_QA_CODE,
  ORIGINAL_GENERATION_FIELD,
  PROVENANCE_ACTOR_IMPORT,
  PROVENANCE_ACTOR_LLM_CRITIC,
  PROVENANCE_ACTOR_SYNC,
  PROVENANCE_ACTOR_USER,
  classifyCandidate,
  defaultGoldMiningConfig,
  goldLintConfig,
  hasCriticRevisionMarker,
  insertContentProvenance,
  isLlmCriticActor,
  isUserProvenEdit,
  llmCriticContentProvenance,
  mineGoldSet,
  parseContentProvenance,
  selectGroundedReferencePairs,
  userContentProvenance,
  defaultGoldSetMining,
  type GoldCandidate,
} from '../src/anki-gold-set.ts';
import { QA_FLAGS_FIELD } from '../src/anki-qa-lint.ts';

const ACTOR_USER = 'user';
const ACTOR_LLM_CRITIC = 'llm_critic';
const ACTOR_IMPORT = 'import';
const ACTOR_SYNC = 'sync';

function provenanceValue(actor: string): string {
  return JSON.stringify({
    actor,
    code: actor === ACTOR_LLM_CRITIC ? CRITIC_REVISED_QA_CODE : null,
    at: '2026-08-24T12:00:00Z',
  });
}

function criticMarkerFlags(): string {
  return JSON.stringify([
    { code: 'answer_leak', field: 'front' },
    { code: CRITIC_REVISED_QA_CODE, field: 'card' },
  ]);
}

function originalSnapshot(front: string, back: string): string {
  return JSON.stringify({ front, back });
}

function cardFromJson(
  id: string,
  front: string,
  back: string,
  extras: Record<string, string>,
): AnkiCard {
  return {
    id,
    task_id: 'task-sibling',
    front,
    back,
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T01:00:00Z',
    extra_fields: extras,
    template_id: null,
  };
}

function candidateFromJson(value: Record<string, unknown>): GoldCandidate {
  return {
    card_id: value.card_id as string,
    current: value.current as GoldCandidate['current'],
    original: (value.original as GoldCandidate['original']) ?? null,
    created_at_ms: value.created_at_ms as number,
    updated_at_ms: value.updated_at_ms as number,
    deleted_at_ms: (value.deleted_at_ms as number | null) ?? null,
    review_count: value.review_count as number,
    again_count: value.again_count as number,
    was_error_card: value.was_error_card as boolean,
    is_error_card: value.is_error_card as boolean,
    critic_revised: value.critic_revised === true,
    edit_actor: (value.edit_actor as string | null) ?? null,
  };
}

function editedCandidateJson(
  cardId: string,
  editActor: string | null,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    card_id: cardId,
    current: { front: '什么是惯性？', back: '物体保持原有运动状态不变的性质', text: null },
    original: { front: '什么是惯性？？', back: '物体保持原有运动状态不变的性质', text: null },
    created_at_ms: 1_000_000,
    updated_at_ms: 2_000_000,
    review_count: 0,
    again_count: 0,
    was_error_card: false,
    is_error_card: false,
    critic_revised: false,
  };
  if (editActor !== null) value.edit_actor = editActor;
  return value;
}

function mineReferences(cards: readonly AnkiCard[]): ReturnType<typeof goldReferencesFromCards> {
  return goldReferencesFromCards(
    cards,
    'task-current',
    defaultCriticConfig(),
    defaultGoldSetMining(),
  );
}

describe('tests/gold_provenance_excludes_critic.rs', () => {
  it('qa_marker_critic_revised_card_yields_zero_grounded_references', () => {
    const card = cardFromJson('c-marker', '什么是惯性？', '物体保持原有运动状态不变的性质', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是惯性？答案是保持运动状态。',
        '保持运动状态',
      ),
      [QA_FLAGS_FIELD]: criticMarkerFlags(),
    });
    const refs = mineReferences([card]);
    expect(refs).toEqual([]);
  });

  it('whitewashed_provenance_actor_llm_critic_yields_zero_references', () => {
    const card = cardFromJson('c-whitewash', '什么是惯性？', '物体保持原有运动状态不变的性质', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是惯性？答案是保持运动状态。',
        '保持运动状态',
      ),
      [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_LLM_CRITIC),
    });
    const refs = mineReferences([card]);
    expect(refs).toEqual([]);
  });

  it('legacy_card_without_marker_or_provenance_is_conservatively_excluded', () => {
    const card = cardFromJson('c-legacy', '什么是惯性？', '物体保持原有运动状态不变的性质', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是惯性？答案是保持运动状态。',
        '保持运动状态',
      ),
    });
    const refs = mineReferences([card]);
    expect(refs).toEqual([]);
  });

  it('user_actor_minor_edit_yields_grounded_reference_pair', () => {
    const card = cardFromJson('c-user', '什么是惯性？', '物体保持原有运动状态不变的性质', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是惯性？答案是保持运动状态。',
        '保持运动状态',
      ),
      [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_USER),
    });
    const refs = mineReferences([card]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.front).toBe('什么是惯性？');
    expect(refs[0]!.back).toBe('物体保持原有运动状态不变的性质');
    expect(refs[0]!.degraded_front).toBe('什么是惯性？答案是保持运动状态。');
    expect(refs[0]!.degraded_back).toBe('保持运动状态');
  });

  it('import_actor_card_is_never_user_gold', () => {
    const card = cardFromJson('c-import', '什么是加速度？', '速度对时间的变化率', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是加速度？答案是速度变化率。',
        '速度变化率',
      ),
      [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_IMPORT),
    });
    const refs = mineReferences([card]);
    expect(refs).toEqual([]);
  });

  it('marker_or_provenance_any_hit_excludes_only_tainted_cards', () => {
    const markerOnly = cardFromJson('c-m', '什么是熵？', '系统混乱程度的度量', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot('什么是熵？答案是混乱度。', '混乱度'),
      [QA_FLAGS_FIELD]: criticMarkerFlags(),
    });
    const provenanceOnly = cardFromJson('c-p', '什么是队列？', '先进先出的线性数据结构', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是队列？答案是先进先出。',
        '先进先出',
      ),
      [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_LLM_CRITIC),
    });
    const bothHit = cardFromJson('c-b', '什么是哈希冲突？', '不同键映射到同一槽位的现象', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是哈希冲突？答案是键碰撞。',
        '键碰撞',
      ),
      [QA_FLAGS_FIELD]: criticMarkerFlags(),
      [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_LLM_CRITIC),
    });
    const userControl = cardFromJson(
      'c-u',
      '什么是惯性？',
      '物体保持原有运动状态不变的性质',
      {
        [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
          '什么是惯性？答案是保持运动状态。',
          '保持运动状态',
        ),
        [CONTENT_PROVENANCE_FIELD]: provenanceValue(ACTOR_USER),
      },
    );

    const refs = mineReferences([markerOnly, provenanceOnly, bothHit, userControl]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.front).toBe('什么是惯性？');
  });

  it('classify_critic_revised_candidate_never_gets_edited_label', () => {
    const value = editedCandidateJson('cand-critic', null);
    value.critic_revised = true;
    const candidate = candidateFromJson(value);

    const config = defaultGoldMiningConfig();
    const sample = classifyCandidate(candidate, config);
    expect(sample.label).not.toBe('edited_minor');
    expect(sample.label).not.toBe('edited_major');
    expect(sample.label).toBe('unlabeled');
    expect(sample.repair_pair).toBeNull();

    const samples = mineGoldSet([candidate], config);
    const picked = selectGroundedReferencePairs(samples, goldLintConfig(), 10);
    expect(picked).toEqual([]);
  });

  it('classify_user_actor_minor_edit_is_edited_minor', () => {
    const candidate = candidateFromJson(editedCandidateJson('cand-user', ACTOR_USER));
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('edited_minor');
    const pair = sample.repair_pair;
    expect(pair).not.toBeNull();
    expect(pair!.distance_ratio).toBeGreaterThan(0);
    expect(pair!.distance_ratio).toBeLessThan(0.25);
    expect(pair!.edited.front).toBe('什么是惯性？');
  });

  it('classify_content_diff_without_actor_proof_is_unlabeled', () => {
    const candidate = candidateFromJson(editedCandidateJson('cand-legacy', null));
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('unlabeled');
    expect(sample.repair_pair).toBeNull();
    expect(sample.reason.length).toBeGreaterThan(0);
  });

  it('classify_import_actor_never_gets_edited_label', () => {
    const candidate = candidateFromJson(editedCandidateJson('cand-import', ACTOR_IMPORT));
    const config = defaultGoldMiningConfig();
    const sample = classifyCandidate(candidate, config);
    expect(sample.label).not.toBe('edited_minor');
    expect(sample.label).not.toBe('edited_major');
    expect(sample.repair_pair).toBeNull();

    const samples = mineGoldSet([candidate], config);
    const picked = selectGroundedReferencePairs(samples, goldLintConfig(), 10);
    expect(picked).toEqual([]);
  });

  it('marker_helper_hits_only_structured_stable_code', () => {
    expect(hasCriticRevisionMarker({ [QA_FLAGS_FIELD]: criticMarkerFlags() })).toBe(true);
    expect(
      hasCriticRevisionMarker({
        [QA_FLAGS_FIELD]: JSON.stringify([{ message: CRITIC_REVISED_QA_CODE }]),
      }),
    ).toBe(false);
    expect(hasCriticRevisionMarker({ [QA_FLAGS_FIELD]: 'not-json' })).toBe(false);
    expect(
      hasCriticRevisionMarker({
        [QA_FLAGS_FIELD]: JSON.stringify({ code: CRITIC_REVISED_QA_CODE }),
      }),
    ).toBe(false);
    expect(hasCriticRevisionMarker({})).toBe(false);
  });

  it('qa_pass_whitewash_pipeline_sanitized_revise_yields_zero_references', () => {
    const generated = cardFromJson(
      'c-pipeline-whitewash',
      '什么是队列？答案是先进先出。',
      '先进先出',
      {
        [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
          '什么是队列？答案是先进先出。',
          '先进先出',
        ),
      },
    );

    const raw =
      '```json\n{"verdicts":[{"card_id":"c-pipeline-whitewash","verdict":"revise","reasons":["问题面泄漏答案"],"revised":{"front":"什么是队列？","back":"先进先出的线性数据结构"}}]}\n```';
    const allowed = new Set(['c-pipeline-whitewash']);
    const parsed = parseCriticResponse(raw, allowed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.value.verdicts).toHaveLength(1);
    expect(parsed.value.rejected_unknown_ids).toBe(0);

    const plan = planUpdates([generated], parsed.value.verdicts);
    expect(plan.revised).toBe(1);
    expect(plan.updates).toHaveLength(1);
    expect(hasCriticRevisionMarker(plan.updates[0]!.extra_fields)).toBe(true);

    sanitizePlanForDisabledQaPass(plan, [generated]);
    expect(plan.updates).toHaveLength(1);
    const whitewashed = plan.updates[0]!;
    expect(Object.hasOwn(whitewashed.extra_fields, QA_FLAGS_FIELD)).toBe(false);
    expect(hasCriticRevisionMarker(whitewashed.extra_fields)).toBe(false);
    const stamp = parseContentProvenance(whitewashed.extra_fields);
    expect(stamp).not.toBeNull();
    expect(stamp!.actor).toBe(PROVENANCE_ACTOR_LLM_CRITIC);
    expect(stamp!.code).toBe(CRITIC_REVISED_QA_CODE);
    expect(isLlmCriticActor(whitewashed.extra_fields)).toBe(true);

    const userControl = cardFromJson(
      'c-pipeline-control',
      '什么是惯性？',
      '物体保持原有运动状态不变的性质',
      {
        [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
          '什么是惯性？答案是保持运动状态。',
          '保持运动状态',
        ),
      },
    );
    insertContentProvenance(
      userControl.extra_fields,
      userContentProvenance('update_anki_card'),
    );

    const refs = mineReferences([whitewashed, userControl]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.front).toBe('什么是惯性？');
  });

  it('update_anki_card_user_stamp_proves_user_edit_and_yields_reference', () => {
    const stamp = userContentProvenance('update_anki_card');
    expect(stamp.actor).toBe(PROVENANCE_ACTOR_USER);
    expect(stamp.code).toBe('update_anki_card');
    expect(stamp.at).toBeTruthy();

    const card = cardFromJson('c-update-stamp', '什么是惯性？', '物体保持原有运动状态不变的性质', {
      [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
        '什么是惯性？答案是保持运动状态。',
        '保持运动状态',
      ),
    });
    insertContentProvenance(card.extra_fields, llmCriticContentProvenance());
    insertContentProvenance(card.extra_fields, stamp);

    expect(isUserProvenEdit(card.extra_fields)).toBe(true);
    expect(isLlmCriticActor(card.extra_fields)).toBe(false);
    const parsed = parseContentProvenance(card.extra_fields);
    expect(parsed).not.toBeNull();
    expect(parsed!.actor).toBe(PROVENANCE_ACTOR_USER);
    expect(parsed!.code).toBe('update_anki_card');

    const refs = mineReferences([card]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.front).toBe('什么是惯性？');

    const candidate = candidateFromJson(
      editedCandidateJson('cand-update-stamp', parsed!.actor),
    );
    const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
    expect(sample.label).toBe('edited_minor');
    expect(sample.repair_pair).not.toBeNull();
  });

  it('import_actor_product_stamp_is_never_user_proof', () => {
    expect(ACTOR_USER).toBe(PROVENANCE_ACTOR_USER);
    expect(ACTOR_LLM_CRITIC).toBe(PROVENANCE_ACTOR_LLM_CRITIC);
    expect(ACTOR_IMPORT).toBe(PROVENANCE_ACTOR_IMPORT);
    expect(ACTOR_SYNC).toBe(PROVENANCE_ACTOR_SYNC);
    expect(CONTENT_PROVENANCE_FIELD).toBe('_content_provenance');

    const taintedBatch: AnkiCard[] = [];
    for (const [id, actor, code] of [
      ['c-prod-import', PROVENANCE_ACTOR_IMPORT, 'apkg_import'],
      ['c-prod-sync', PROVENANCE_ACTOR_SYNC, 'sync_merge'],
      ['c-prod-future', 'future_agent', null],
    ] as const) {
      const card = cardFromJson(id, '什么是加速度？', '速度对时间的变化率', {
        [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
          '什么是加速度？答案是速度变化率。',
          '速度变化率',
        ),
      });
      insertContentProvenance(card.extra_fields, {
        actor,
        code,
        at: '2026-08-26T12:00:00Z',
      });
      expect(isUserProvenEdit(card.extra_fields), `actor=${actor} 不得算用户证明`).toBe(false);
      const refs = mineReferences([card]);
      expect(refs, `actor=${actor} 必须 0 条 reference`).toEqual([]);
      taintedBatch.push(card);
    }

    const userControl = cardFromJson(
      'c-prod-user-control',
      '什么是惯性？',
      '物体保持原有运动状态不变的性质',
      {
        [ORIGINAL_GENERATION_FIELD]: originalSnapshot(
          '什么是惯性？答案是保持运动状态。',
          '保持运动状态',
        ),
      },
    );
    insertContentProvenance(
      userControl.extra_fields,
      userContentProvenance('update_anki_card'),
    );
    taintedBatch.push(userControl);
    const refs = mineReferences(taintedBatch);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.front).toBe('什么是惯性？');

    for (const [candId, actor] of [
      ['cand-prod-sync', PROVENANCE_ACTOR_SYNC],
      ['cand-prod-future', 'future_agent'],
    ] as const) {
      const candidate = candidateFromJson(editedCandidateJson(candId, actor));
      const sample = classifyCandidate(candidate, defaultGoldMiningConfig());
      expect(sample.label, `actor=${actor} 必须保守 Unlabeled`).toBe('unlabeled');
      expect(sample.repair_pair).toBeNull();
    }
  });
});
