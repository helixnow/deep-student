// 渠道解析（2026-10-03，方案 F：统一 5 档 + 零交叉判定链）。
//
// ## 设计
// 每个渠道（= get_adapter 命中的适配器）一个独立 resolve 函数，职责收窄为两件事：
//   1. 该模型是否支持思考（不支持 → 返回 null，由调用方回退）
//   2. 该模型是否暴露关闭状态（canDisable）
// 档位集合一律是统一的五档（levels.ts 的 UNIFIED_REASONING_LEVELS），
// **不再**按模型家族裁剪 options。
//
// ## 为什么不再裁剪档位
// 档位可用性属「模型能力」，应在后端按能力表就近映射（见
// scripts/reasoning-level-registry.json）。前端裁剪会导致同一事实在三处
// 重复（前端表、后端归一表、注册表）并漂移——
// gpt-6 的 max 被静默折叠为 xhigh、Gemini 的 low 被改写为 high 都是漂移产物。
//
// ## 交叉判定链已移除
// 旧实现存在四处跨渠道兜底：
//   - registry.ts 的 FAMILY_SWEEP_ORDER 家族清扫（宿主渠道按 10 个家族依次尝试）
//   - registry.ts 的三级 `hostResolve ?? sweepFamilies ?? resolveGenericChannel`
//   - channels.ts 的 `resolveSiliconFlowChannel ?? resolveOpenAiChannel`
//   - channels.ts 的 `resolveQwenChannel ?? resolveSiliconFlowChannel`
// 它们使同一模型可能被"A 渠道判定后交给 B 渠道映射"，职责与结果都不可预期。
// 现改为：**渠道只按自身身份判定**；身份或模型不支持时返回 null，
// 由调用方选择单一中性兜底，绝不再调用其他家族的解析器。

import {
  extractModelVersion,
  isClaudeAdaptiveModelId,
  isClaudeAlwaysOnModelId,
  isClaudeOpus55ModelId,
  isDeepSeekR1ModelId,
  isDeepSeekV4ModelId,
  isForcedThinkingModelId,
  isKimiK3OrLaterModelId,
  isLegacyKimiForcedThinkingModelId,
  isMistralEffortModelId,
  isQwenForcedThinkingModelId,
  isQwenPureThinkingModelId,
  matchModelFamily,
  type ModelFamily,
} from './modelFamily';
import {
  UNIFIED_REASONING_LEVELS,
  coerceReasoningLevel,
  toggleOnlyControl,
  unifiedControl,
  type ReasoningControl,
  type ReasoningLevel,
} from './levels';

/** 渠道解析入参；adapterId 为 get_adapter 解析结果（后端下发 / 设置页显式选择）。
 *  字段按 unknown 接收（store 透传值可能缺类型），渠道内部统一 normalize。 */
export interface ReasoningChannelInput {
  model?: unknown;
  modelId?: unknown;
  adapterId?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
  /** 模型配置的 supportsReasoning（渠道无内建判定时的兜底依据）。 */
  supportsReasoning?: unknown;
}

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** 取模型 ID（model 优先，兼容 modelId 别名）。 */
export function channelModelId(input: ReasoningChannelInput): string {
  return normalize(input.model) || normalize(input.modelId);
}

/** 渠道入口统一做的家族门控：模型 ID 必须属于本家族（包含匹配见 modelFamily）。 */
function gate(input: ReasoningChannelInput, family: ModelFamily): string | null {
  const model = channelModelId(input);
  if (!model) return null;
  return matchModelFamily(model) === family ? model : null;
}

/** 统一档位控制对象的构造入口（所有渠道共用，确保 options 完全一致）。 */
function unified(canDisable: boolean, defaultValue?: ReasoningLevel): ReasoningControl {
  return unifiedControl(canDisable, { defaultValue });
}

// ── Qwen 渠道 ────────────────────────────────────────────────────────────

export function resolveQwenChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'qwen');
  if (!model) return null;
  // 纯推理型号（qwq / *-thinking / qwen3.8-2.4t-a95b 等）：始终思考，无关闭。
  if (isQwenForcedThinkingModelId(model) || isQwenPureThinkingModelId(model)) {
    return unified(false, 'xhigh');
  }
  // qwen3.8 系：默认档对齐后端 reasoning-level-registry（qwen-3.8 default=xhigh）。
  if (model.includes('qwen3.8')) return unified(true, 'xhigh');
  // 其余 Qwen 思考型号（3.5~3.7 混合、商业系 plus/turbo/flash）：可关闭。
  return unified(true, 'medium');
}

// ── OpenAI 渠道（gpt-5.x / gpt-6 系 / o 系列 / codex / gpt-oss）───────────

export function resolveOpenAiChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'openai');
  if (!model) return null;
  // 非推理变体（*-chat）不展示档位。
  if (/-chat(?:[.\-_/]|$)/.test(model)) return null;
  const isOpenAiReasoning =
    model.includes('gpt-') ||
    model.includes('gpt-oss') ||
    model.includes('codex') ||
    /(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(model);
  if (!isOpenAiReasoning) return null;
  // openai_codex 宿主（ChatGPT/Codex 订阅通道）强制思考，不接受关闭。
  const providerForcesThinking =
    normalize(input.providerType) === 'openai_codex' ||
    normalize(input.providerScope) === 'openai_codex';
  // 强制思考（不可关闭）：o 系列、codex、gpt-oss、*-pro 变体。
  const canDisable = !providerForcesThinking && !isForcedThinkingModelId(model);
  return unified(canDisable, 'medium');
}

// ── DeepSeek 渠道 ────────────────────────────────────────────────────────

export function resolveDeepSeekChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'deepseek');
  if (!model) return null;
  if (isDeepSeekV4ModelId(model)) {
    // V4 / V4.1 Flash：官方 reasoning_effort（none/low/high/max），可关闭。
    return unified(true, 'high');
  }
  if (isDeepSeekR1ModelId(model) || isForcedThinkingModelId(model)) {
    return unified(false, 'high');
  }
  // V3.x 与未识别型号：走开关 + budget 兜底，档位统一展示。
  return unified(true, 'medium');
}

// ── Gemini 渠道 ──────────────────────────────────────────────────────────

export function resolveGeminiChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'gemini');
  if (!model) return null;
  if (model.includes('gemini-3') || model.includes('gemini3')) {
    // Gemini 3 全系不能关闭思考（minimal ≠ off）。
    return unified(false, 'high');
  }
  if (model.includes('gemini-2.5')) {
    // 2.5 Pro 不能禁用，2.5 Flash/Flash-Lite 可以。
    const canDisable = model.includes('flash');
    return unified(canDisable, 'low');
  }
  return null;
}

// ── Claude 渠道 ──────────────────────────────────────────────────────────

export function resolveClaudeChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'claude');
  if (!model || !isClaudeAdaptiveModelId(model)) return null;
  // Fable / Mythos / Opus 5.5：adaptive 常开，不可关闭。
  const alwaysOn = isClaudeAlwaysOnModelId(model) || isClaudeOpus55ModelId(model);
  return unified(!alwaysOn, 'high');
}

// ── 智谱 GLM 渠道 ────────────────────────────────────────────────────────

export function resolveZhipuChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'zhipu');
  if (!model) return null;
  // GLM-5.3 系强制思考（传 disabled 报错）。
  if (model.includes('5.3')) return unified(false, 'max');
  // GLM-5.2 及以上：全档可关闭（none/minimal 表示放弃思考）。
  const version = extractModelVersion(model);
  if (version && (version[0] > 5 || (version[0] === 5 && version[1] >= 2))) {
    return unified(true, 'max');
  }
  // GLM-4.x 等旧代际：仅开关。
  return toggleOnlyControl(true);
}

// ── Grok 渠道 ────────────────────────────────────────────────────────────

export function resolveGrokChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'grok');
  if (!model) return null;
  if (model.includes('non-reasoning')) return null;
  if (model.includes('grok-4.20') && model.includes('multi-agent')) {
    return unified(false, 'medium');
  }
  const version = extractModelVersion(model);
  if (version) {
    const [major, minor] = version;
    // 4.5+ 不可关闭。
    if (major > 4 || (major === 4 && minor >= 5)) return unified(false, 'high');
    // 4.3：可关闭（none）。
    if (major === 4 && minor >= 3) return unified(true, 'low');
  }
  if (model === 'grok-latest' || model.endsWith('/grok-latest')) {
    return unified(false, 'high');
  }
  return null;
}

// ── Moonshot / Kimi 渠道 ─────────────────────────────────────────────────

export function resolveMoonshotChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'moonshot');
  if (!model) return null;
  // K3+：始终推理（无 thinking 参数），不可关闭。
  if (isKimiK3OrLaterModelId(model)) return unified(false, 'max');
  // K2.7-code：强制思考。
  if (model.includes('kimi-k2.7') && model.includes('code')) return unified(false, 'high');
  // K2-thinking 等遗留强制型号。
  if (isLegacyKimiForcedThinkingModelId(model)) return unified(false, 'high');
  // K2.5 / K2.6：思考开关可切换，无 effort 档位语义。
  return toggleOnlyControl(true);
}

// ── Mistral 渠道 ─────────────────────────────────────────────────────────

export function resolveMistralChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'mistral');
  if (!model || !isMistralEffortModelId(model)) return null;
  // 官方 reasoning 指南仅 high/none 两档；其余档由后端就近吸附。
  return unified(true, 'high');
}

// ── 百度 ERNIE / 千帆渠道 ────────────────────────────────────────────────

export function resolveErnieChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'ernie');
  if (!model) return null;
  // 千帆与 ERNIE 本体都支持思考开关；档位统一五档展示，
  // 千帆仅托管 DeepSeek 系真正开放 reasoning_effort，ERNIE 本体的档位
  // 由后端能力表决定是否透传。
  return unified(true, 'high');
}

// ── MiniMax 渠道 ─────────────────────────────────────────────────────────

export function resolveMinimaxChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'minimax');
  if (!model) return null;
  // M3.1 系列：always-think（none 与 disabled 均报 400），有真实五档。
  if (model.includes('m3.1')) return unified(false, 'max');
  // M3 / M2.x：thinking 始终开启，档位统一展示，关闭由后端按能力处理。
  return unified(false, 'high');
}

// ── 豆包渠道 ─────────────────────────────────────────────────────────────

export function resolveDoubaoChannel(input: ReasoningChannelInput): ReasoningControl | null {
  const model = gate(input, 'doubao');
  if (!model) return null;
  // Seed 系按官方文档接受完整档位枚举（按模型代次映射），可关闭。
  if (model.includes('seed') || model.includes('doubao')) return unified(true, 'high');
  return null;
}

// ── Generic / OpenAI 兼容渠道（中性兜底，不调用其他家族解析器）──────────

/**
 * Generic 渠道：宿主身份已知但无更强信息时的中性兜底。
 *
 * 与旧实现的区别：这里**只**依据「模型名像不像推理模型 + supportsReasoning 开关」
 * 给出统一档位，不再清扫其他家族渠道。宿主上的具体家族能力由后端能力表负责。
 */
export function resolveGenericChannel(input: ReasoningChannelInput): ReasoningControl {
  const model = channelModelId(input);
  const looksReasoning =
    !!model &&
    (/reason|think|r1|o[134]\b|gpt-|claude|gemini|qwen|glm|kimi|grok|deepseek|mistral|magistral|minimax|ernie|doubao|seed|mimo/.test(
      model
    ) ||
      model.includes('qwq'));
  const supportsReasoning = input.supportsReasoning === true;
  if (!looksReasoning && !supportsReasoning) {
    return toggleOnlyControl(true);
  }
  const canDisable = !isForcedThinkingModelId(model);
  return unified(canDisable, 'medium');
}

// ── 注册表 ───────────────────────────────────────────────────────────────

/**
 * 渠道注册表：键为 get_adapter 命中的适配器 id（含别名）。
 *
 * 契约：每个渠道**只**按自身身份判定，返回 null 表示"该渠道对当前模型
 * 没有思考语义"。渠道之间零引用——不存在 `a ?? b` 形式的跨渠道兜底。
 */
export type ReasoningChannel = (input: ReasoningChannelInput) => ReasoningControl | null;

export const REASONING_CHANNELS: Record<string, ReasoningChannel> = {
  qwen: resolveQwenChannel,
  deepseek: resolveDeepSeekChannel,
  openai: resolveOpenAiChannel,
  nvidia: resolveOpenAiChannel,
  general: resolveGenericChannel,
  siliconflow: resolveGenericChannel,
  google: resolveGeminiChannel,
  gemini: resolveGeminiChannel,
  anthropic: resolveClaudeChannel,
  claude: resolveClaudeChannel,
  zhipu: resolveZhipuChannel,
  grok: resolveGrokChannel,
  xai: resolveGrokChannel,
  moonshot: resolveMoonshotChannel,
  kimi: resolveMoonshotChannel,
  mistral: resolveMistralChannel,
  ernie: resolveErnieChannel,
  baidu: resolveErnieChannel,
  minimax: resolveMinimaxChannel,
  doubao: resolveDoubaoChannel,
};

export function normalizeAdapterId(adapterId: string | undefined | null): string | undefined {
  const id = normalize(adapterId);
  return id || undefined;
}

/** 供调用方与测试使用：统一五档表。 */
export { UNIFIED_REASONING_LEVELS, coerceReasoningLevel, toggleOnlyControl, unifiedControl };
export type { ReasoningControl, ReasoningLevel };
