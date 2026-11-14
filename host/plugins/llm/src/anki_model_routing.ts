/**
 * Anki 制卡 Sidekick 模型分层路由（anki_model_routing.rs）。
 *
 * 制卡管线中不同职责使用不同强度的模型：规划（planner）/ 终审（critic）用较强
 * 模型，批量生成（generator）用廉价模型，图像理解（vlm）用视觉模型。
 *
 * 设计约束：
 * 1. 只根据已配置的槽位分配：制卡槽（anki_card_model_config_id，通常廉价）、
 *    主模型槽（model2_config_id，通常较强）、视觉槽（任一已启用的多模态文本
 *    模型）。缺槽位时降级到同一模型，绝不因缺配置而报错。
 * 2. 决策可观测：`AnkiRoutingPlan` 全字段可序列化 + debug 日志逐角色输出。
 * 3. 零新增网络调用与配置 UI：本模块为纯函数；能力探测只读现有模型分配与
 *    API 配置。
 * 4. 失败不影响制卡：槽位探测失败或配置在探测后消失时静默回退。
 *
 * wire 格式说明：路由模式经 options JSON 的扩展字段
 * `sidekick_model_routing`（"auto" | "single"）传入，缺省 auto。
 * 复用 serde-default 的二次解析模式——options 对象被多处穷举字面量构造，
 * 因此这里只按可选字段读取，不认识的值一律回退 auto。
 */
import type { ApiConfig, ModelAssignments } from '../api.ts';
import { logDebug } from './logging.ts';

// ============================================================
// 角色与模式
// ============================================================

/** 制卡管线中的模型角色。 */
export type AnkiModelRole = 'planner' | 'generator' | 'critic' | 'vlm';

/** 全部角色，顺序与 Rust `AnkiModelRole::ALL` 一致（日志/去重口径）。 */
export const ANKI_MODEL_ROLES: readonly AnkiModelRole[] = ['planner', 'generator', 'critic', 'vlm'];

/** 路由模式（options JSON 扩展字段 `sidekick_model_routing`，缺省 auto）。 */
export type RoutingMode = 'auto' | 'single';

/** 缺省路由模式（与 Rust `Default for RoutingMode` 一致）。 */
export const DEFAULT_ROUTING_MODE: RoutingMode = 'auto';

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从任务的 anki_generation_options JSON 解析路由模式。
 *
 * 未知值 / 缺失 / 非法 JSON 一律回退 auto（保守：auto 在槽位齐全时与旧行为
 * 的 generator 选择一致，缺槽位时才体现降级差异）。
 */
export function parseRoutingMode(optionsJson: string): RoutingMode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return DEFAULT_ROUTING_MODE;
  }
  if (!isRecord(parsed)) return DEFAULT_ROUTING_MODE;
  const raw = parsed.sidekick_model_routing;
  if (typeof raw !== 'string') return DEFAULT_ROUTING_MODE;
  const value = raw.trim().toLowerCase();
  return value === 'single' || value === 'off' || value === 'disabled'
    ? 'single'
    : DEFAULT_ROUTING_MODE;
}

// ============================================================
// 槽位快照（只读能力探测的输出）
// ============================================================

/** 单个槽位的能力快照（从 ApiConfig 提取的最小只读子集）。 */
export interface SlotProbe {
  configId: string;
  model: string;
  isMultimodal: boolean;
  isReasoning: boolean;
}

export function slotProbeFromConfig(config: ApiConfig): SlotProbe {
  return {
    configId: config.id,
    model: config.model,
    isMultimodal: config.isMultimodal,
    isReasoning: config.isReasoning,
  };
}

/**
 * Sidekick 路由可见的全部槽位。
 *
 * 均为可缺省：缺槽位是常态（用户可能只配了一个模型），由 `planRouting`
 * 负责降级，本结构不做任何判断。
 */
export interface AnkiRoutingSlots {
  /** 制卡槽（anki_card_model_config_id）——批量生成的首选（通常廉价） */
  ankiCard: SlotProbe | null;
  /** 主模型槽（model2_config_id）——规划/终审的首选（通常较强） */
  main: SlotProbe | null;
  /** 视觉槽——任一已启用的多模态文本模型（探测顺序见 `buildSlots`） */
  vision: SlotProbe | null;
}

/** 空槽位快照（对应 `AnkiRoutingSlots::default()`）。 */
export function emptyRoutingSlots(): AnkiRoutingSlots {
  return { ankiCard: null, main: null, vision: null };
}

export function isRoutingSlotsEmpty(slots: AnkiRoutingSlots): boolean {
  return slots.ankiCard === null && slots.main === null && slots.vision === null;
}

/**
 * 配置是否可作为文本生成槽位（排除嵌入 / 重排 / 生图模型）。
 */
function eligibleTextConfig(config: ApiConfig): boolean {
  return config.enabled && !config.isEmbedding && !config.isReranker && !config.isImageGeneration;
}

function findEligible(
  id: string | null | undefined, configs: readonly ApiConfig[],
): ApiConfig | null {
  if (id === null || id === undefined) return null;
  return configs.find((config) => config.id === id && eligibleTextConfig(config)) ?? null;
}

function multimodal(config: ApiConfig | null): SlotProbe | null {
  if (config === null || !config.isMultimodal) return null;
  return slotProbeFromConfig(config);
}

/**
 * 纯函数：从模型分配 + API 配置构建槽位快照（只读，无网络 / 无 DB）。
 *
 * 视觉槽探测顺序（全部只在已启用的多模态文本模型中选取）：
 * 1. exam_sheet_ocr_model_config_id（用户显式配置的视觉 / OCR 模型）
 * 2. 主模型槽自身多模态
 * 3. 制卡槽自身多模态
 * 4. 其余任一已启用多模态配置（按配置列表顺序，确定性）
 */
export function buildSlots(
  assignments: ModelAssignments, configs: readonly ApiConfig[],
): AnkiRoutingSlots {
  const ankiCard = findEligible(assignments.anki_card_model_config_id, configs);
  const main = findEligible(assignments.model2_config_id, configs);

  const firstMultimodal = configs.find(
    (config) => eligibleTextConfig(config) && config.isMultimodal,
  );
  const vision =
    multimodal(findEligible(assignments.exam_sheet_ocr_model_config_id, configs))
    ?? multimodal(main)
    ?? multimodal(ankiCard)
    ?? (firstMultimodal === undefined ? null : slotProbeFromConfig(firstMultimodal));

  return {
    ankiCard: ankiCard === null ? null : slotProbeFromConfig(ankiCard),
    main: main === null ? null : slotProbeFromConfig(main),
    vision,
  };
}

// ============================================================
// 路由决策（可观测结构体）
// ============================================================

/** 决策来源槽位。 */
export type SlotKind = 'ankiCard' | 'mainModel' | 'vision';

/** 单角色的路由决策（全字段可序列化，供日志 / 诊断 / 前端调试面板消费）。 */
export interface RoleDecision {
  role: AnkiModelRole;
  configId: string;
  model: string;
  /** 实际取用的槽位 */
  slot: SlotKind;
  /** 首选槽位缺失、降级到了其他槽位的同一模型 */
  degraded: boolean;
  /**
   * 所选模型是否具备多模态能力（vlm 角色降级到纯文本模型时为 false，
   * 调用方据此跳过图像输入而非报错）
   */
  isMultimodal: boolean;
  /** 人类可读的决策原因（观测用，不参与任何逻辑） */
  reason: string;
}

/** 完整路由计划：四个角色各一条决策。 */
export interface AnkiRoutingPlan {
  mode: RoutingMode;
  planner: RoleDecision;
  generator: RoleDecision;
  critic: RoleDecision;
  vlm: RoleDecision;
}

export function planDecision(plan: AnkiRoutingPlan, role: AnkiModelRole): RoleDecision {
  switch (role) {
    case 'planner': return plan.planner;
    case 'generator': return plan.generator;
    case 'critic': return plan.critic;
    case 'vlm': return plan.vlm;
  }
}

/** 计划中实际用到的不同模型配置数量（观测口径）。 */
export function distinctConfigCount(plan: AnkiRoutingPlan): number {
  const ids = new Set(ANKI_MODEL_ROLES.map((role) => planDecision(plan, role).configId));
  return ids.size;
}

function decisionFrom(
  role: AnkiModelRole, probe: SlotProbe, slot: SlotKind, degraded: boolean, reason: string,
): RoleDecision {
  return {
    role,
    configId: probe.configId,
    model: probe.model,
    slot,
    degraded,
    isMultimodal: probe.isMultimodal,
    reason,
  };
}

/**
 * 核心纯函数：根据槽位快照与模式生成路由计划。
 *
 * 角色偏好（auto 模式）：
 * - planner / critic：主模型槽（较强）→ 缺失则降级到制卡槽
 * - generator：制卡槽（廉价、批量）→ 缺失则降级到主模型槽
 * - vlm：视觉槽 → 缺失则降级到 generator 所用模型（标记 degraded，
 *   isMultimodal=false 时调用方应跳过图像输入）
 *
 * single 模式：全部角色使用基准模型（制卡槽优先，其次主模型槽）。
 *
 * 返回 null 当且仅当没有任何可用槽位——调用方回退旧路径报配置错误，
 * 本模块自身绝不产生错误（失败不影响制卡）。
 */
export function planRouting(
  mode: RoutingMode, slots: AnkiRoutingSlots,
): AnkiRoutingPlan | null {
  // 基准模型：generator 的首选链（制卡槽 → 主模型槽 → 视觉槽兜底）
  let baseProbe: SlotProbe;
  let baseSlot: SlotKind;
  let baseDegraded: boolean;
  if (slots.ankiCard !== null) {
    baseProbe = slots.ankiCard;
    baseSlot = 'ankiCard';
    baseDegraded = false;
  } else if (slots.main !== null) {
    baseProbe = slots.main;
    baseSlot = 'mainModel';
    baseDegraded = true;
  } else if (slots.vision !== null) {
    baseProbe = slots.vision;
    baseSlot = 'vision';
    baseDegraded = true;
  } else {
    return null;
  }

  if (mode === 'single') {
    const make = (role: AnkiModelRole): RoleDecision =>
      decisionFrom(role, baseProbe, baseSlot, baseDegraded, 'single 模式：全部角色使用基准制卡模型');
    return {
      mode,
      planner: make('planner'),
      generator: make('generator'),
      critic: make('critic'),
      vlm: make('vlm'),
    };
  }

  // generator：廉价批量生成 = 基准链
  const generator = decisionFrom(
    'generator', baseProbe, baseSlot, baseDegraded,
    baseDegraded ? '制卡槽未配置，降级到可用槽位' : '制卡槽（批量生成首选）',
  );

  // planner / critic：较强模型 = 主模型槽优先，缺失降级到基准模型
  const strong = (role: AnkiModelRole): RoleDecision => (slots.main !== null
    ? decisionFrom(role, slots.main, 'mainModel', false, '主模型槽（较强模型）')
    : decisionFrom(role, baseProbe, baseSlot, true, '主模型槽未配置，降级到基准制卡模型'));
  const planner = strong('planner');
  const critic = strong('critic');

  // vlm：视觉槽优先，缺失降级到 generator 模型
  const vlm = slots.vision !== null
    ? decisionFrom('vlm', slots.vision, 'vision', false, '视觉槽（多模态模型）')
    : decisionFrom(
      'vlm', baseProbe, baseSlot, true,
      '无可用多模态模型，降级到 Generator 模型（调用方应跳过图像输入）',
    );

  return { mode, planner, generator, critic, vlm };
}

/**
 * 决策可观测性：逐角色生成 debug 行（对应 Rust `AnkiRoutingPlan::log_debug`）。
 *
 * 第一行是汇总（模式 + 不同配置数），随后每个角色一行。
 */
export function routingPlanDebugLines(plan: AnkiRoutingPlan): string[] {
  const lines = [
    `[ANKI_ROUTING] Sidekick 路由计划: mode=${plan.mode} distinct_models=${distinctConfigCount(plan)}`,
  ];
  for (const role of ANKI_MODEL_ROLES) {
    const decision = planDecision(plan, role);
    lines.push(
      `[ANKI_ROUTING]   ${decision.role} -> config_id=${decision.configId} model=${decision.model} `
      + `slot=${decision.slot} degraded=${decision.degraded} `
      + `multimodal=${decision.isMultimodal} (${decision.reason})`,
    );
  }
  return lines;
}

/** 逐行输出 debug 日志（默认走插件 logger，可注入自定义 sink）。 */
export function logDebugPlan(
  plan: AnkiRoutingPlan, sink: (line: string) => void = (line) => logDebug(line),
): void {
  for (const line of routingPlanDebugLines(plan)) sink(line);
}
