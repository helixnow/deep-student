/** DeepSeek 专用适配器（adapters/deepseek.rs）。 */
import { f32ToJsonNumber } from '../../../../platform/util/portable.ts';
import type { ApiConfig } from '../../api.ts';
import { effectiveApiProtocolForConfig, isOfficialDeepseekConfig } from '../protocol.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { getTrimmedEffort, resolveEnableThinking, type JsonObject } from './base.ts';
import { removeKey } from '../json_map.ts';

type ModelVersion = 'v31' | 'v32' | 'v4' | 'legacy_alias' | 'unknown';
type HostProtocol = 'official' | 'siliconflow' | 'other';

function classifyModel(model: string): ModelVersion {
  const lower = model.toLowerCase();
  if (lower.includes('deepseek-v3.1') || lower.includes('deepseek-ai/deepseek-v3.1')
    || lower.includes('pro/deepseek-ai/deepseek-v3.1')) return 'v31';
  if (lower.includes('deepseek-v3.2')) return 'v32';
  if (lower.includes('deepseek-v4') || lower.includes('deepseek-flash')) return 'v4';
  if (lower === 'deepseek-chat' || lower === 'deepseek-reasoner') return 'legacy_alias';
  return 'unknown';
}

function hostProtocol(config: ApiConfig): HostProtocol {
  const baseUrl = config.baseUrl.toLowerCase();
  if (baseUrl.includes('siliconflow')) return 'siliconflow';
  if (config.providerType?.toLowerCase() === 'siliconflow') return 'siliconflow';
  if (isOfficialDeepseekConfig(config)) return 'official';
  return 'other';
}

function isV4EffortCapable(version: ModelVersion): boolean {
  return version === 'v4' || version === 'legacy_alias';
}

function resolveDeepseekThinking(
  config: ApiConfig, version: ModelVersion, overrideValue: boolean | null,
): boolean {
  if (overrideValue !== null && overrideValue !== undefined) return overrideValue;
  if (config.enableThinking !== null && config.enableThinking !== undefined) {
    return config.enableThinking;
  }
  if (version === 'v4') return true;
  if (config.supportsReasoning && isV4EffortCapable(version)) return true;
  return resolveEnableThinking(config, null);
}

function normalizeV4ReasoningEffort(effort: string): string | null {
  switch (effort.trim().toLowerCase()) {
    case 'none': case 'unset': return null;
    case 'minimal': case 'low': return 'low';
    case 'medium': case 'high': case 'xhigh': return 'high';
    case 'max': case 'ultra': return 'max';
    default: return null;
  }
}

function v32BudgetFromEffort(effort: string): number | null {
  switch (effort.trim().toLowerCase()) {
    case 'low': return 2048;
    case 'medium': return 8192;
    case 'high': return 16384;
    case 'xhigh': case 'max': return 32768;
    default: return null;
  }
}

function resolveSiliconflowThinkingBudget(
  config: ApiConfig, version: ModelVersion,
): number | null {
  if ((version === 'v31' || version === 'v32') && config.thinkingBudget !== null) {
    return config.thinkingBudget;
  }
  if (version === 'v31' || version === 'v32') {
    const effort = getTrimmedEffort(config);
    if (effort !== null) {
      const mapped = v32BudgetFromEffort(effort);
      if (mapped !== null) return mapped;
    }
  }
  return config.thinkingBudget;
}

function shouldApplyReasoningEffort(
  config: ApiConfig, version: ModelVersion, host: HostProtocol, enableThinkingValue: boolean,
): string | null {
  if (!enableThinkingValue || !isV4EffortCapable(version)) return null;
  const effort = getTrimmedEffort(config);
  if (effort === null) return null;
  if (host !== 'official' && effort.toLowerCase() === 'xhigh') return 'max';
  return normalizeV4ReasoningEffort(effort);
}

export function isOfficialDeepseekV4(config: ApiConfig): boolean {
  return hostProtocol(config) === 'official' && isV4EffortCapable(classifyModel(config.model));
}

export function usesDeepseekV41ImageTokens(config: ApiConfig): boolean {
  return hostProtocol(config) === 'official'
    && ['deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(config.model.trim().toLowerCase());
}

/** Chat Completions 需要字符串 system content。 */
export function normalizeDeepseekChatRequest(body: unknown, config: ApiConfig): void {
  const usesDeepseek = config.modelAdapter.toLowerCase() === 'deepseek'
    || isOfficialDeepseekConfig(config);
  if (!usesDeepseek || effectiveApiProtocolForConfig(config) !== 'openai_chat_completions') return;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const map = body as JsonObject;
  if (Object.prototype.hasOwnProperty.call(map, 'max_completion_tokens')) {
    const limit = map.max_completion_tokens;
    removeKey(map, 'max_completion_tokens');
    if (!Object.prototype.hasOwnProperty.call(map, 'max_tokens')) map.max_tokens = limit;
  }
  const messages = map.messages;
  if (!Array.isArray(messages)) return;
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const message = value as JsonObject;
    if (message.role !== 'system' || !Array.isArray(message.content)) continue;
    const parts = message.content;
    const texts: string[] = [];
    let ok = true;
    for (const part of parts) {
      if (typeof part === 'string') { texts.push(part); continue; }
      if (typeof part === 'object' && part !== null && !Array.isArray(part)
        && (part as JsonObject).type === 'text' && typeof (part as JsonObject).text === 'string') {
        texts.push((part as JsonObject).text as string);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && texts.length === parts.length) message.content = texts.join('\n');
  }
}

function applyOfficialSampling(body: JsonObject, thinking: boolean): void {
  removeKey(body, 'presence_penalty');
  removeKey(body, 'frequency_penalty');
  if (thinking) {
    removeKey(body, 'temperature');
    if (typeof body.top_p === 'number') {
      body.top_p = Math.min(1, Math.max(0.95, body.top_p));
    }
  } else {
    removeKey(body, 'top_p');
  }
}

/** Official output cap and sampling dialect after generic reasoning assembly. */
export function applyOfficialDeepseekGenerationParams(
  body: unknown, config: ApiConfig,
): boolean {
  if (!isOfficialDeepseekV4(config)) return false;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const map = body as JsonObject;
  const thinkingValue = map.thinking;
  const thinkingType = typeof thinkingValue === 'object' && thinkingValue !== null
    && !Array.isArray(thinkingValue) ? (thinkingValue as JsonObject).type : undefined;
  const thinking = thinkingType !== 'disabled';
  const defaultTokens = !thinking ? 8192
    : map.reasoning_effort === 'max' ? 131072 : 65536;
  const requested = config.maxOutputTokens > 0 ? config.maxOutputTokens : defaultTokens;
  const limit = config.maxTokensLimit !== null && config.maxTokensLimit > 0
    ? config.maxTokensLimit : 393216;
  map.max_tokens = Math.min(requested, limit, 393216);
  removeKey(map, 'max_completion_tokens');
  map.temperature = f32ToJsonNumber(config.temperature);
  if (config.topPOverride !== null && config.topPOverride !== undefined) {
    map.top_p = f32ToJsonNumber(config.topPOverride);
  }
  applyOfficialSampling(map, thinking);
  return true;
}

export class DeepSeekAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'deepseek';
  override get label(): string { return 'DeepSeek'; }
  override get description(): string {
    return 'DeepSeek 系列，支持 version-aware thinking/reasoning 参数格式';
  }

  override validateReasoningConfig(config: ApiConfig): void {
    const version = classifyModel(config.model);
    if (!isV4EffortCapable(version) || hostProtocol(config) !== 'official') return;
    if (!resolveDeepseekThinking(config, version, null)) return;
    const effort = getTrimmedEffort(config);
    if (effort === null) return;
    if (['none', 'unset', 'off'].includes(effort.toLowerCase())) return;
    if (normalizeV4ReasoningEffort(effort) === null) {
      throw new Error(`UNSUPPORTED_REASONING_EFFORT: 模型 ${config.model} 不支持推理强度 "${effort}"（支持 low/medium/high/xhigh/max）`);
    }
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    const version = classifyModel(config.model);
    const host = hostProtocol(config);

    if (version === 'v31'
      && (Object.prototype.hasOwnProperty.call(body, 'tools')
        || Object.prototype.hasOwnProperty.call(body, 'tool_choice'))) {
      removeKey(body, 'enable_thinking');
      removeKey(body, 'thinking');
      removeKey(body, 'thinking_budget');
      removeKey(body, 'include_thoughts');
      removeKey(body, 'reasoning_effort');
      return false;
    }

    const deepseekReasoningCapable = config.supportsReasoning
      || version === 'v31' || version === 'v32' || version === 'v4';

    if (deepseekReasoningCapable) {
      const enableThinkingValue = resolveDeepseekThinking(config, version, enableThinking);
      if (host === 'siliconflow') {
        body.enable_thinking = enableThinkingValue;
        removeKey(body, 'thinking');
        if (isV4EffortCapable(version)) {
          removeKey(body, 'thinking_budget');
          const effort = shouldApplyReasoningEffort(config, version, host, enableThinkingValue);
          if (effort !== null) body.reasoning_effort = effort;
          else removeKey(body, 'reasoning_effort');
        } else {
          removeKey(body, 'reasoning_effort');
          const budget = resolveSiliconflowThinkingBudget(config, version);
          if (budget !== null) {
            body.thinking_budget = Math.min(32768, Math.max(128, budget));
          }
        }
      } else {
        body.thinking = { type: enableThinkingValue ? 'enabled' : 'disabled' };
        removeKey(body, 'enable_thinking');
        removeKey(body, 'thinking_budget');
        const effort = shouldApplyReasoningEffort(config, version, host, enableThinkingValue);
        if (effort !== null) body.reasoning_effort = effort;
        else removeKey(body, 'reasoning_effort');
      }
    }

    if (isOfficialDeepseekV4(config)) {
      const thinking = resolveDeepseekThinking(config, version, enableThinking);
      applyOfficialSampling(body, thinking);
    }
    return false;
  }

  override shouldRemoveSamplingParams(config: ApiConfig): boolean {
    const version = classifyModel(config.model);
    const thinkingEnabled = resolveDeepseekThinking(config, version, null);
    return !isOfficialDeepseekV4(config)
      && thinkingEnabled
      && isV4EffortCapable(version);
  }

  override shouldDisableThinkingForTools(config: ApiConfig, body: JsonObject): boolean {
    return config.model.toLowerCase().includes('deepseek-v3.1')
      && (Object.prototype.hasOwnProperty.call(body, 'tools')
        || Object.prototype.hasOwnProperty.call(body, 'tool_choice'));
  }
}
