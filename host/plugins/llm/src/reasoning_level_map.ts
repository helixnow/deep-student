/**
 * 思考强度档位映射（reasoning_level_map.rs）。
 *
 * 只改写 `reasoningEffort`，绝不触碰 `thinkingBudget` / `enableThinking` /
 * 采样参数 / verbosity / extraBody。
 */
import type { ApiConfig } from '../api.ts';
import {
  baseUrlHost, effectiveApiProtocolForConfig, isOfficialDeepseekConfig, providerIsOfficial,
} from './protocol.ts';
import { REASONING_LEVEL_PROFILES, type ReasoningLevelProfile } from './data/reasoning_level_registry.ts';

const LEVEL_RANKS: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

export function levelRank(level: string): number | null {
  return LEVEL_RANKS[level.trim().toLowerCase()] ?? null;
}

/** 包含命中只认版本边界：片段后紧跟数字是另一个版本（gpt-60 ≠ gpt-6）。 */
export function containsAtVersionBoundary(model: string, fragment: string): boolean {
  let index = model.indexOf(fragment);
  while (index !== -1) {
    const next = model.slice(index + fragment.length);
    if (!/^\d/.test(next)) return true;
    index = model.indexOf(fragment, index + 1);
  }
  return false;
}

export function findReasoningLevelProfile(config: ApiConfig): ReasoningLevelProfile | null {
  const model = config.model.trim().toLowerCase();
  if (model === '') return null;
  let best: ReasoningLevelProfile | null = null;
  let bestLength = -1;
  for (const profile of REASONING_LEVEL_PROFILES) {
    const matches = profile.modelContains.every((fragment) =>
      containsAtVersionBoundary(model, fragment.toLowerCase()));
    if (!matches) continue;
    const length = profile.modelContains.reduce((sum, fragment) => sum + fragment.length, 0);
    if (length > bestLength) {
      best = profile;
      bestLength = length;
    }
  }
  return best;
}

function isOfficialChannel(config: ApiConfig): boolean {
  const provider = config.providerType ?? config.providerScope ?? '';
  if (provider.toLowerCase() === 'deepseek') return isOfficialDeepseekConfig(config);
  return providerIsOfficial(provider);
}

function snapToLevels(
  requested: string, allowed: readonly string[], ceiling: string | null,
): string | null {
  const requestedRank = levelRank(requested);
  if (requestedRank === null) return null;
  const ceilingRank = ceiling === null ? null : levelRank(ceiling);
  let best: { distance: number; level: string } | null = null;
  for (const candidate of allowed) {
    const rank = levelRank(candidate);
    if (rank === null) continue;
    if (ceilingRank !== null && rank > ceilingRank) continue;
    const distance = Math.abs(rank - requestedRank);
    const isBetter = best === null
      || distance < best.distance
      || (distance === best.distance && (levelRank(best.level) ?? -1) < rank);
    if (isBetter) best = { distance, level: candidate };
  }
  return best === null ? null : best.level;
}

/**
 * 依据能力表映射档位；`null` 表示无需改写。
 * Some 情况下只有 `reasoningEffort` 与非能力字段不同。
 */
export function mapReasoningLevelForConfig(config: ApiConfig): ApiConfig | null {
  const requested = config.reasoningEffort?.trim();
  if (requested === undefined || requested === '') return null;
  const requestedLower = requested.toLowerCase();

  const siliconFlow = mapSiliconFlowReasoningOverride(config);
  if (siliconFlow !== null) return siliconFlow;

  if (requestedLower === 'none' || requestedLower === 'unset') return null;
  if (levelRank(requestedLower) === null) return null;
  if (!isOfficialChannel(config)) return null;

  const profile = findReasoningLevelProfile(config);
  if (profile === null) return null;

  const allowed = profile.levels.filter((level) => level.toLowerCase() !== 'none');
  if (allowed.length === 0) return null;

  const protocol = effectiveApiProtocolForConfig(config);
  const ceiling = profile.protocolCaps[protocol]?.maxLevel ?? null;

  // 1) 官方明示别名优先。
  const aliased = profile.levelAliases[requestedLower];
  if (aliased !== undefined) {
    const aliasAllowed = allowed.some((level) => level.toLowerCase() === aliased.toLowerCase());
    const aliasCeilingRank = ceiling === null ? null : levelRank(ceiling);
    const aliasRank = levelRank(aliased);
    const aliasOk = aliasAllowed
      && (aliasCeilingRank === null || aliasRank === null || aliasRank <= aliasCeilingRank);
    if (aliasOk && aliased.toLowerCase() !== requestedLower) {
      return { ...config, reasoningEffort: aliased };
    }
  }

  // 2) 档位已在允许集合内且未超协议上限 → 无需改写。
  const withinAllowed = allowed.some((level) => level.toLowerCase() === requestedLower);
  const ceilingRank = ceiling === null ? null : levelRank(ceiling);
  const requestedRank = levelRank(requestedLower);
  const withinCeiling =
    ceilingRank === null || requestedRank === null || requestedRank <= ceilingRank;
  if (withinAllowed && withinCeiling) return null;

  // 3) 兜底：就近吸附。
  const snapped = snapToLevels(requestedLower, allowed, ceiling);
  if (snapped === null || snapped.toLowerCase() === requestedLower) return null;
  return { ...config, reasoningEffort: snapped };
}

/** A persisted off preference must not turn into an invalid effort on a forced-thinking model. */
export function resolveAlwaysThinkingFallback(config: ApiConfig): ApiConfig | null {
  if (config.reasoningEffort?.trim().toLowerCase() !== 'none') return null;
  const model = config.model.trim().toLowerCase().replace(/^openai\//, '');
  if (!model.includes('chat-latest') && /^gpt-5(?:-|$)/.test(model)) {
    return { ...config, reasoningEffort: model.includes('-pro') ? 'high' : 'minimal' };
  }
  if (/^o[134](?:-|$)/.test(model) && !['o1-mini', 'o1-preview'].includes(model)) {
    return { ...config, reasoningEffort: 'low' };
  }
  const profile = findReasoningLevelProfile(config);
  if (!profile || profile.canDisable) return null;
  const lowest = [...profile.levels].filter(level => level !== 'none')
    .sort((a, b) => (levelRank(a) ?? Infinity) - (levelRank(b) ?? Infinity))[0];
  return lowest ? { ...config, reasoningEffort: lowest } : null;
}

/** Provider-specific audited exceptions, not a global rule for same-named models. */
export function mapSiliconFlowReasoningOverride(config: ApiConfig): ApiConfig | null {
  const providers = [config.providerType, config.providerScope].map(value => value?.trim().toLowerCase());
  const host = baseUrlHost(config.baseUrl);
  if (!providers.some(provider => provider === 'siliconflow' || provider === 'siliconflow-cn')
    && !/^api\.siliconflow\.(cn|com)$/.test(host)) return null;
  if (!['pro/deepseek-ai/deepseek-v4', 'deepseek-ai/deepseek-v4-flash', 'pro/zai-org/glm-5.2']
    .includes(config.model.trim().toLowerCase())) return null;
  const requested = config.reasoningEffort?.trim().toLowerCase();
  if (!requested || requested === 'none' || requested === 'unset' || levelRank(requested) === null) return null;
  const mapped = requested === 'xhigh' || requested === 'max' ? 'max' : 'high';
  return mapped === requested ? null : { ...config, reasoningEffort: mapped };
}
