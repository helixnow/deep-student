// 统一思考强度档位表（2026-10-03，方案 F：前端统一 5 档）。
//
// ## 设计
// 前端**不再**按模型家族裁剪档位集合——所有支持思考的模型统一展示同一套
// 五档（low/medium/high/xhigh/max）+ 关闭开关。哪一档对该模型真正可用，
// 由后端的档位能力表（scripts/reasoning-level-registry.json）在请求前
// 就近吸附完成映射。
//
// 这样做的理由：档位可用性属于「模型能力」而非「界面能力」，散落在前端
// 会导致三处重复（前端表、后端归一表、注册表）且极易漂移——历史上
// gpt-6 的 max 被静默折叠、Gemini 的 low 被改写为 high 都是这类漂移。
//
// ## 与旧实现的关系
// 旧文件 `src/utils/deepseekReasoningControls.ts` 同时承载了「档位表常量」
// 与「按模型家族判定」两件事，且被 channels.ts / registry.ts 反向依赖，
// 形成双份判定链。本模块是它的单一替代品：只保留五档这一套表与必要的
// 类型/换算工具，家族判定全部移入 reasoning/modelFamily.ts。

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReasoningLevelOption {
  value: ReasoningLevel;
  labelKey: string;
  defaultLabel: string;
}

/** 统一五档（前端展示用；不含 minimal——该档官方已基本名存实亡）。 */
// 文案用短标签（低/中/高/极高/最高）：`reasoning.effort.*` 是设置页里「API 参数值（中文）」
// 的写法，直接用在输入框档位芯片上会显示成「high（高）」。
export const UNIFIED_REASONING_LEVELS: ReasoningLevelOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.deepseek.depth.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.deepseek.depth.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.deepseek.depth.xhigh', defaultLabel: 'Extra High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

/** 档位深度序（就近吸附与旧值迁移用）。 */
export const REASONING_LEVEL_RANK: Record<ReasoningLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

const VALID_LEVELS = new Set<string>(Object.keys(REASONING_LEVEL_RANK));

/** 归一化任意外部档位字符串；非法/未知返回 undefined。 */
export function coerceReasoningLevel(value: unknown): ReasoningLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_LEVELS.has(normalized) ? (normalized as ReasoningLevel) : undefined;
}

/**
 * 思考强度控制对象（渠道解析结果）。
 *
 * 统一 5 档后本对象在**所有渠道**上都返回同一套 options；`kind` 仅用于
 * 记录「该渠道的关闭语义如何表达」，不再用来区分档位集合。
 */
export type ReasoningControlKind =
  | 'effort'
  | 'effort-budget-fallback'
  | 'toggle-only';

export interface ReasoningControl {
  kind: ReasoningControlKind;
  options: ReasoningLevelOption[];
  /** 该模型是否暴露真实的关闭状态（强制思考模型为 false）。 */
  canDisable: boolean;
  /** 用户未显式选择时使用的档位（由后端能力表判定，前端仅作展示初值）。 */
  defaultValue?: ReasoningLevel;
}

/** 统一控制对象：所有渠道共用。 */
export function unifiedControl(
  canDisable: boolean,
  options: {
    kind?: ReasoningControlKind;
    defaultValue?: ReasoningLevel;
  } = {}
): ReasoningControl {
  return {
    kind: options.kind ?? 'effort',
    options: UNIFIED_REASONING_LEVELS,
    canDisable,
    defaultValue: options.defaultValue,
  };
}

/** 仅开关（不展示档位）——非推理模型或渠道未声明思考语义时使用。 */
export function toggleOnlyControl(canDisable: boolean): ReasoningControl {
  return { kind: 'toggle-only', options: [], canDisable };
}
