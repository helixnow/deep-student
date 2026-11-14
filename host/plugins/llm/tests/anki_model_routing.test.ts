import { describe, expect, it } from 'vitest';
import type { ApiConfig, ModelAssignments } from '../api.ts';
import {
  ANKI_MODEL_ROLES, buildSlots, distinctConfigCount, emptyRoutingSlots, isRoutingSlotsEmpty,
  logDebugPlan, parseRoutingMode, planDecision, planRouting, routingPlanDebugLines,
  type AnkiRoutingPlan, type AnkiRoutingSlots, type SlotProbe,
} from '../src/anki_model_routing.ts';
import { EMPTY_MODEL_ASSIGNMENTS } from '../src/config_store.ts';
import { makeConfig } from './support.ts';

function probe(id: string, model: string, multimodal: boolean, reasoning: boolean): SlotProbe {
  return { configId: id, model, isMultimodal: multimodal, isReasoning: reasoning };
}

function fullSlots(): AnkiRoutingSlots {
  return {
    ankiCard: probe('cfg-cheap', 'cheap-flash', false, false),
    main: probe('cfg-strong', 'strong-pro', false, true),
    vision: probe('cfg-vlm', 'vision-vl', true, false),
  };
}

function config(id: string, model: string): ApiConfig {
  return makeConfig({ id, model, enabled: true });
}

function assignments(
  anki: string | null, model2: string | null, ocr: string | null,
): ModelAssignments {
  return {
    ...EMPTY_MODEL_ASSIGNMENTS,
    anki_card_model_config_id: anki,
    model2_config_id: model2,
    exam_sheet_ocr_model_config_id: ocr,
  };
}

function expectPlan(plan: AnkiRoutingPlan | null): AnkiRoutingPlan {
  expect(plan).not.toBeNull();
  if (plan === null) throw new Error('plan 不应为 null');
  return plan;
}

describe('anki_model_routing.rs', () => {
  // ---------- 路由模式解析 ----------

  it('mode_defaults_to_auto', () => {
    // 旧版 options（无扩展字段）
    expect(parseRoutingMode('{"deck_name":"d","note_type":"Basic"}')).toBe('auto');
    // 空对象 / 非法 JSON 同样回退 auto
    expect(parseRoutingMode('{}')).toBe('auto');
    expect(parseRoutingMode('not json')).toBe('auto');
  });

  it('mode_parses_single_and_aliases', () => {
    expect(parseRoutingMode('{"sidekick_model_routing":"single"}')).toBe('single');
    expect(parseRoutingMode('{"sidekick_model_routing":"OFF"}')).toBe('single');
    expect(parseRoutingMode('{"sidekick_model_routing":" disabled "}')).toBe('single');
    // 显式 auto 与未知值都是 auto
    expect(parseRoutingMode('{"sidekick_model_routing":"auto"}')).toBe('auto');
    expect(parseRoutingMode('{"sidekick_model_routing":"whatever"}')).toBe('auto');
  });

  // ---------- auto 模式：槽位齐全 ----------

  it('full_slots_assign_roles_by_strength', () => {
    const plan = expectPlan(planRouting('auto', fullSlots()));
    expect(plan.planner.configId).toBe('cfg-strong');
    expect(plan.planner.slot).toBe('mainModel');
    expect(plan.planner.degraded).toBe(false);

    expect(plan.generator.configId).toBe('cfg-cheap');
    expect(plan.generator.slot).toBe('ankiCard');
    expect(plan.generator.degraded).toBe(false);

    expect(plan.critic.configId).toBe('cfg-strong');
    expect(plan.critic.degraded).toBe(false);

    expect(plan.vlm.configId).toBe('cfg-vlm');
    expect(plan.vlm.slot).toBe('vision');
    expect(plan.vlm.isMultimodal).toBe(true);
    expect(plan.vlm.degraded).toBe(false);

    expect(distinctConfigCount(plan)).toBe(3);
  });

  // ---------- auto 模式：缺槽位降级 ----------

  it('missing_main_degrades_planner_and_critic_to_anki_slot', () => {
    const slots = fullSlots();
    slots.main = null;
    const plan = expectPlan(planRouting('auto', slots));
    expect(plan.planner.configId).toBe('cfg-cheap');
    expect(plan.planner.slot).toBe('ankiCard');
    expect(plan.planner.degraded).toBe(true);
    expect(plan.critic.configId).toBe('cfg-cheap');
    expect(plan.critic.degraded).toBe(true);
    // generator 不受影响
    expect(plan.generator.degraded).toBe(false);
  });

  it('missing_anki_slot_degrades_generator_to_main', () => {
    const slots = fullSlots();
    slots.ankiCard = null;
    const plan = expectPlan(planRouting('auto', slots));
    expect(plan.generator.configId).toBe('cfg-strong');
    expect(plan.generator.slot).toBe('mainModel');
    expect(plan.generator.degraded).toBe(true);
    // planner / critic 仍用主模型且不算降级
    expect(plan.planner.degraded).toBe(false);
  });

  it('missing_vision_degrades_vlm_to_generator_model', () => {
    const slots = fullSlots();
    slots.vision = null;
    const plan = expectPlan(planRouting('auto', slots));
    expect(plan.vlm.configId).toBe(plan.generator.configId);
    expect(plan.vlm.degraded).toBe(true);
    // 降级目标是纯文本模型：调用方据 isMultimodal=false 跳过图像输入
    expect(plan.vlm.isMultimodal).toBe(false);
  });

  it('single_configured_model_serves_all_roles', () => {
    const slots: AnkiRoutingSlots = {
      ankiCard: probe('only', 'only-model', false, false),
      main: null,
      vision: null,
    };
    const plan = expectPlan(planRouting('auto', slots));
    for (const role of ANKI_MODEL_ROLES) {
      expect(planDecision(plan, role).configId).toBe('only');
    }
    expect(distinctConfigCount(plan)).toBe(1);
    // generator 用的是首选槽位，不算降级；其余角色是降级
    expect(plan.generator.degraded).toBe(false);
    expect(plan.planner.degraded).toBe(true);
    expect(plan.critic.degraded).toBe(true);
    expect(plan.vlm.degraded).toBe(true);
  });

  it('empty_slots_yield_no_plan', () => {
    expect(planRouting('auto', emptyRoutingSlots())).toBeNull();
    expect(planRouting('single', emptyRoutingSlots())).toBeNull();
    expect(isRoutingSlotsEmpty(emptyRoutingSlots())).toBe(true);
  });

  it('only_vision_slot_still_produces_plan', () => {
    // 极端配置：只配了一个多模态模型 —— 全角色都用它，制卡不中断
    const slots: AnkiRoutingSlots = {
      ankiCard: null,
      main: null,
      vision: probe('cfg-vlm', 'vision-vl', true, false),
    };
    const plan = expectPlan(planRouting('auto', slots));
    for (const role of ANKI_MODEL_ROLES) {
      expect(planDecision(plan, role).configId).toBe('cfg-vlm');
    }
    expect(plan.generator.degraded).toBe(true);
    // 视觉角色用视觉槽是首选，不算降级
    expect(plan.vlm.degraded).toBe(false);
  });

  // ---------- single 模式 ----------

  it('single_mode_uses_base_model_for_all_roles', () => {
    const plan = expectPlan(planRouting('single', fullSlots()));
    for (const role of ANKI_MODEL_ROLES) {
      expect(planDecision(plan, role).configId).toBe('cfg-cheap');
      expect(planDecision(plan, role).slot).toBe('ankiCard');
    }
    expect(distinctConfigCount(plan)).toBe(1);
  });

  // ---------- 可观测性：结构体序列化 ----------

  it('plan_serializes_with_all_roles_and_reasons', () => {
    const plan = expectPlan(planRouting('auto', fullSlots()));
    const raw = JSON.stringify(plan);
    for (const key of ['planner', 'generator', 'critic', 'vlm', 'reason', 'degraded']) {
      expect(raw).toContain(key);
    }
    const back = JSON.parse(raw) as AnkiRoutingPlan;
    expect(back).toStrictEqual(plan);

    // debug 日志路径可用：逐角色输出，且首行为汇总
    const lines: string[] = [];
    logDebugPlan(plan, (line) => lines.push(line));
    expect(lines).toStrictEqual(routingPlanDebugLines(plan));
    expect(lines).toHaveLength(ANKI_MODEL_ROLES.length + 1);
    for (const line of lines) expect(line).toContain('[ANKI_ROUTING]');
  });

  // ---------- 槽位构建（buildSlots 纯函数） ----------

  it('build_slots_resolves_configured_assignments', () => {
    const configs = [
      config('cfg-cheap', 'cheap-flash'),
      makeConfig({ ...config('cfg-strong', 'strong-pro'), isReasoning: true }),
    ];
    const slots = buildSlots(assignments('cfg-cheap', 'cfg-strong', null), configs);
    const ankiCard = slots.ankiCard;
    expect(ankiCard).not.toBeNull();
    expect(ankiCard?.configId).toBe('cfg-cheap');
    const main = slots.main;
    expect(main).not.toBeNull();
    expect(main?.configId).toBe('cfg-strong');
    expect(main?.isReasoning).toBe(true);
    // 无多模态配置 → 无视觉槽
    expect(slots.vision).toBeNull();
  });

  it('build_slots_skips_disabled_and_non_text_configs', () => {
    const disabled = makeConfig({ ...config('cfg-cheap', 'cheap-flash'), enabled: false });
    const embedding = makeConfig({
      ...config('cfg-embed', 'embed-v1'), isEmbedding: true, isMultimodal: true,
    });
    const slots = buildSlots(
      assignments('cfg-cheap', 'cfg-embed', null),
      [disabled, embedding],
    );
    expect(slots.ankiCard).toBeNull();
    expect(slots.main).toBeNull();
    expect(slots.vision).toBeNull();
    expect(isRoutingSlotsEmpty(slots)).toBe(true);
  });

  it('build_slots_vision_prefers_ocr_assignment_then_falls_back', () => {
    const ocr = makeConfig({ ...config('cfg-ocr', 'ocr-vl'), isMultimodal: true });
    const otherVlm = makeConfig({ ...config('cfg-other-vlm', 'other-vl'), isMultimodal: true });
    const configs = [config('cfg-cheap', 'cheap-flash'), ocr, otherVlm];

    // 1. 显式 OCR 槽优先
    const explicit = buildSlots(assignments('cfg-cheap', null, 'cfg-ocr'), configs);
    expect(explicit.vision).not.toBeNull();
    expect(explicit.vision?.configId).toBe('cfg-ocr');

    // 2. 未配置 OCR 槽：回退到任一已启用多模态配置（列表顺序确定性）
    const fallback = buildSlots(assignments('cfg-cheap', null, null), configs);
    expect(fallback.vision).not.toBeNull();
    expect(fallback.vision?.configId).toBe('cfg-ocr');
  });

  it('build_slots_vision_uses_multimodal_main_or_anki_before_stranger_configs', () => {
    const mmMain = makeConfig({ ...config('cfg-mm-main', 'mm-main'), isMultimodal: true });
    const stranger = makeConfig({
      ...config('cfg-stranger', 'stranger-vl'), isMultimodal: true,
    });
    // stranger 排在前面，但主模型槽自身多模态应优先
    const configs = [stranger, mmMain];
    const slots = buildSlots(assignments(null, 'cfg-mm-main', null), configs);
    expect(slots.vision).not.toBeNull();
    expect(slots.vision?.configId).toBe('cfg-mm-main');
    // 主模型槽多模态时：planner 与 vlm 同模型，且都不算降级
    const plan = expectPlan(planRouting('auto', slots));
    expect(plan.vlm.configId).toBe('cfg-mm-main');
    expect(plan.vlm.degraded).toBe(false);
    expect(plan.vlm.isMultimodal).toBe(true);
  });

  it('build_slots_missing_assignment_ids_are_ignored', () => {
    const configs = [config('cfg-a', 'model-a')];
    // 分配指向不存在的 id：静默忽略，不抛错
    const slots = buildSlots(assignments('ghost', 'cfg-a', 'ghost-2'), configs);
    expect(slots.ankiCard).toBeNull();
    expect(slots.main).not.toBeNull();
    expect(slots.main?.configId).toBe('cfg-a');
  });

  // ---------- 端到端纯逻辑：探测 → 计划 ----------

  it('probe_to_plan_pipeline_prefers_cheap_generator_and_strong_planner', () => {
    const strong = makeConfig({
      ...config('cfg-strong', 'strong-pro'), isReasoning: true, isMultimodal: true,
    });
    const configs = [config('cfg-cheap', 'cheap-flash'), strong];
    const slots = buildSlots(assignments('cfg-cheap', 'cfg-strong', null), configs);
    const plan = expectPlan(planRouting(parseRoutingMode('{}'), slots));
    expect(plan.generator.configId).toBe('cfg-cheap');
    expect(plan.planner.configId).toBe('cfg-strong');
    expect(plan.critic.configId).toBe('cfg-strong');
    // 主模型多模态 → 视觉槽复用主模型
    expect(plan.vlm.configId).toBe('cfg-strong');
    expect(distinctConfigCount(plan)).toBe(2);
  });

  // ---------- planner / vlm 生产消费的降级矩阵 ----------

  it('only_main_keeps_planner_primary_and_degrades_generator_and_vlm', () => {
    const slots: AnkiRoutingSlots = {
      ankiCard: null,
      main: probe('cfg-main', 'main', false, true),
      vision: null,
    };
    const plan = expectPlan(planRouting('auto', slots));

    expect(plan.planner.slot).toBe('mainModel');
    expect(plan.planner.degraded).toBe(false);
    expect(plan.generator.configId).toBe('cfg-main');
    expect(plan.generator.degraded).toBe(true);
    expect(plan.vlm.configId).toBe('cfg-main');
    expect(plan.vlm.degraded).toBe(true);
  });

  it('multimodal_main_can_serve_planner_and_vlm_as_one_config', () => {
    const main = probe('cfg-main-vl', 'main-vl', true, true);
    const slots: AnkiRoutingSlots = {
      ankiCard: null,
      main: { ...main },
      vision: { ...main },
    };
    const plan = expectPlan(planRouting('auto', slots));

    expect(plan.planner.slot).toBe('mainModel');
    expect(plan.vlm.slot).toBe('vision');
    expect(plan.planner.degraded).toBe(false);
    expect(plan.vlm.degraded).toBe(false);
    expect(distinctConfigCount(plan)).toBe(1);
  });

  it('missing_anki_with_distinct_vision_preserves_role_specific_slots', () => {
    const slots: AnkiRoutingSlots = {
      ankiCard: null,
      main: probe('cfg-main', 'main', false, true),
      vision: probe('cfg-vlm', 'vlm', true, false),
    };
    const plan = expectPlan(planRouting('auto', slots));

    expect(plan.generator.slot).toBe('mainModel');
    expect(plan.generator.degraded).toBe(true);
    expect(plan.planner.slot).toBe('mainModel');
    expect(plan.planner.degraded).toBe(false);
    expect(plan.vlm.slot).toBe('vision');
    expect(plan.vlm.degraded).toBe(false);
  });

  it('missing_main_keeps_generator_and_vlm_on_their_own_slots', () => {
    const slots: AnkiRoutingSlots = {
      ankiCard: probe('cfg-anki', 'anki', false, false),
      main: null,
      vision: probe('cfg-vlm', 'vlm', true, false),
    };
    const plan = expectPlan(planRouting('auto', slots));

    expect(plan.planner.configId).toBe(plan.generator.configId);
    expect(plan.planner.degraded).toBe(true);
    expect(plan.generator.degraded).toBe(false);
    expect(plan.vlm.slot).toBe('vision');
    expect(plan.vlm.degraded).toBe(false);
  });

  it('duplicate_config_ids_are_deduplicated_without_losing_slot_identity', () => {
    const shared = probe('cfg-shared', 'shared-vl', true, true);
    const slots: AnkiRoutingSlots = {
      ankiCard: { ...shared },
      main: { ...shared },
      vision: { ...shared },
    };
    const plan = expectPlan(planRouting('auto', slots));

    expect(plan.planner.slot).toBe('mainModel');
    expect(plan.generator.slot).toBe('ankiCard');
    expect(plan.vlm.slot).toBe('vision');
    expect(distinctConfigCount(plan)).toBe(1);
  });

  it('single_mode_with_only_vision_marks_every_role_as_base_degraded', () => {
    const slots: AnkiRoutingSlots = {
      ankiCard: null,
      main: null,
      vision: probe('cfg-vlm', 'vlm', true, false),
    };
    const plan = expectPlan(planRouting('single', slots));

    for (const role of ANKI_MODEL_ROLES) {
      const decision = planDecision(plan, role);
      expect(decision.configId).toBe('cfg-vlm');
      expect(decision.slot).toBe('vision');
      expect(decision.degraded).toBe(true);
    }
  });
});
