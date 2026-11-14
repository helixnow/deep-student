/** 通用 OpenAI 兼容适配器（adapters/generic_openai.rs）。 */
import type { ApiConfig } from '../../api.ts';
import { shouldUseOpenaiResponsesForConfig } from '../protocol.ts';
import {
  BaseAdapter, getTrimmedEffort, mergeExtraBody, resolveEnableThinking, type JsonObject,
} from './base.ts';
import { removeKey } from '../json_map.ts';

const STANDARD_EFFORTS: Record<string, string> = {
  none: 'none', disabled: 'none', off: 'none', false: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium', enabled: 'medium', adaptive: 'medium', auto: 'medium', on: 'medium', true: 'medium',
  high: 'high',
  xhigh: 'xhigh', max: 'xhigh',
};

const VALID_EFFORTS = new Set([
  'none', 'disabled', 'off', 'false', 'minimal', 'low', 'medium', 'enabled',
  'adaptive', 'auto', 'on', 'true', 'high', 'xhigh', 'max', 'unset',
]);

const RELAY_HOSTS = new Set([
  'custom', 'general', 'one-api', 'one_api', 'sub2api', 'cpa', 'together', 'fireworks', 'groq',
]);

function urlHost(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch { // boundary-allow empty-catch: Rust `Url::parse(...).ok()` 解析失败返回 None，不记录日志
    return null;
  }
}

export function isOpenrouter(config: ApiConfig): boolean {
  if (config.providerType?.toLowerCase() === 'openrouter') return true;
  if (config.providerScope?.toLowerCase() === 'openrouter') return true;
  const host = urlHost(config.baseUrl);
  return host !== null && (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'));
}

export function isSiliconflow(config: ApiConfig): boolean {
  if (config.providerType?.toLowerCase() === 'siliconflow') return true;
  if (config.providerScope?.toLowerCase() === 'siliconflow') return true;
  const base = config.baseUrl.toLowerCase();
  return base.includes('siliconflow.cn') || base.includes('siliconflow.com');
}

function normalizeSiliconflowEffort(effort: string): string | null {
  switch (effort.trim().toLowerCase()) {
    case 'minimal': case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': case 'ultra': return 'max';
    default: return null;
  }
}

function normalizeStandardEffort(effort: string): string | null {
  return STANDARD_EFFORTS[effort.trim().toLowerCase()] ?? null;
}

function requestedEffort(config: ApiConfig): string | null {
  const trimmed = getTrimmedEffort(config);
  if (trimmed !== null) return trimmed;
  const effort = config.effort?.trim();
  return effort === undefined || effort === '' ? null : effort;
}

function isMaxCapableGptFamily(config: ApiConfig): boolean {
  const model = config.model.trim().toLowerCase();
  const segment = model.split('/').at(-1) ?? '';
  let rest: string;
  if (segment.startsWith('gpt-5.6')) rest = segment.slice('gpt-5.6'.length);
  else if (segment.startsWith('gpt-6')) rest = segment.slice('gpt-6'.length);
  else return false;
  return rest === '' || /^[._-]/.test(rest);
}

function isRelayHost(config: ApiConfig): boolean {
  if (isSiliconflow(config) || isOpenrouter(config)) return false;
  const host = (config.providerType ?? config.providerScope ?? '').trim().toLowerCase();
  return RELAY_HOSTS.has(host);
}

function normalizeEffortForModel(config: ApiConfig, effort: string): string | null {
  if (effort.trim().toLowerCase() === 'max' && (isMaxCapableGptFamily(config) || isRelayHost(config))) {
    return 'max';
  }
  return normalizeStandardEffort(effort);
}

function effortFromBudget(budget: number): string {
  if (budget < 0) return 'medium';
  if (budget === 0) return 'none';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 16384) return 'high';
  return 'xhigh';
}

function insertReasoningEffort(body: JsonObject, config: ApiConfig, effort: string): void {
  if (isOpenrouter(config)) {
    removeKey(body, 'reasoning_effort');
    const reasoning = body.reasoning;
    if (typeof reasoning === 'object' && reasoning !== null && !Array.isArray(reasoning)) {
      const nested = reasoning as JsonObject;
      removeKey(nested, 'max_tokens');
      removeKey(nested, 'enabled');
      nested.effort = effort;
    } else {
      body.reasoning = { effort };
    }
  } else {
    body.reasoning_effort = effort;
    removeKey(body, 'reasoning');
  }
}

function shouldRemoveSamplingForReasoning(config: ApiConfig): boolean {
  const effort = requestedEffort(config);
  if (effort !== null) {
    const trimmed = effort.trim().toLowerCase();
    if (trimmed !== '') {
      if (trimmed === 'unset' || normalizeStandardEffort(trimmed) === 'none') return false;
      if (!VALID_EFFORTS.has(trimmed)) return false;
      return true;
    }
  }
  if (!(config.isReasoning || config.supportsReasoning) || !resolveEnableThinking(config, null)) {
    return false;
  }
  if (config.thinkingBudget === null || config.thinkingBudget === undefined) return true;
  return effortFromBudget(config.thinkingBudget) !== 'none';
}

export class GenericOpenAIAdapter extends BaseAdapter {
  override readonly id: string = 'general';
  override get label(): string { return 'OpenAI Compatible'; }
  override get description(): string {
    return '适用于大多数 OpenAI 兼容模型参数格式；具体请求协议由 OpenAI 协议决定';
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    let earlyReturn = false;

    if (isSiliconflow(config) && (config.supportsReasoning || config.isReasoning)) {
      const enableThinkingValue = resolveEnableThinking(config, enableThinking);
      body.enable_thinking = enableThinkingValue;
      removeKey(body, 'reasoning');
      removeKey(body, 'thinking');

      if (enableThinkingValue) {
        const effort = getTrimmedEffort(config);
        const normalized = effort === null ? null : normalizeSiliconflowEffort(effort);
        if (normalized !== null) {
          body.reasoning_effort = normalized;
          removeKey(body, 'thinking_budget');
        } else {
          removeKey(body, 'reasoning_effort');
          if (config.thinkingBudget !== null && config.thinkingBudget !== undefined) {
            body.thinking_budget = Math.min(32768, Math.max(128, config.thinkingBudget));
          } else {
            removeKey(body, 'thinking_budget');
          }
        }
      } else {
        removeKey(body, 'thinking_budget');
        removeKey(body, 'reasoning_effort');
      }
      return false;
    }

    if (shouldRemoveSamplingForReasoning(config)) {
      removeKey(body, 'temperature');
      removeKey(body, 'top_p');
      removeKey(body, 'logprobs');
    }

    const effort = requestedEffort(config);
    const hasReasoningEffort = effort !== null;
    const hasResponsesReasoningMode =
      shouldUseOpenaiResponsesForConfig(config)
      && config.model.trim().toLowerCase().startsWith('gpt-5.6')
      && (config.reasoningMode?.trim().toLowerCase() === 'standard'
        || config.reasoningMode?.trim().toLowerCase() === 'pro');

    removeKey(body, 'enable_thinking');
    removeKey(body, 'thinking_budget');
    removeKey(body, 'include_thoughts');
    removeKey(body, 'thinking');
    removeKey(body, 'output_config');

    if (hasReasoningEffort && effort !== null) {
      const requested = effort.toLowerCase();
      if (requested === 'unset') {
        removeKey(body, 'reasoning_effort');
        removeKey(body, 'reasoning');
        earlyReturn = true;
      } else {
        const normalized = normalizeEffortForModel(config, effort);
        if (normalized !== null) {
          if (normalized === 'none') {
            insertReasoningEffort(body, config, 'none');
            earlyReturn = true;
          } else {
            insertReasoningEffort(body, config, normalized);
          }
        } else {
          removeKey(body, 'reasoning_effort');
          removeKey(body, 'reasoning');
        }
      }

      if (config.verbosity !== null && config.verbosity !== undefined) {
        const verbosity = config.verbosity.trim().toLowerCase();
        if (verbosity === 'low' || verbosity === 'medium' || verbosity === 'high') {
          body.verbosity = verbosity;
        }
      }
    } else if (config.supportsReasoning || config.isReasoning) {
      const enableThinkingValue = resolveEnableThinking(config, enableThinking);
      const normalized = enableThinkingValue
        ? (config.thinkingBudget !== null && config.thinkingBudget !== undefined
          ? effortFromBudget(config.thinkingBudget) : 'medium')
        : 'none';
      insertReasoningEffort(body, config, normalized);
    }

    if (hasResponsesReasoningMode) {
      const normalized = config.reasoningMode?.trim().toLowerCase();
      if (normalized === 'standard' || normalized === 'pro') {
        const existing = body.reasoning;
        if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
          (existing as JsonObject).mode = normalized;
        } else {
          body.reasoning = { mode: normalized };
        }
      }
    }

    return earlyReturn;
  }

  override shouldRemoveSamplingParams(config: ApiConfig): boolean {
    return !isSiliconflow(config) && shouldRemoveSamplingForReasoning(config);
  }

  override applyCommonParams(body: JsonObject, config: ApiConfig): void {
    if (config.minP !== null && config.minP !== undefined) body.min_p = config.minP;
    if (config.topK !== null && config.topK !== undefined) body.top_k = config.topK;
    if (config.repetitionPenalty !== null && config.repetitionPenalty !== undefined) {
      body.repetition_penalty = config.repetitionPenalty;
    }
    if (config.reasoningSplit !== null && config.reasoningSplit !== undefined) {
      body.reasoning_split = config.reasoningSplit;
    }
    if (config.verbosity !== null && config.verbosity !== undefined) {
      const normalized = config.verbosity.trim().toLowerCase();
      if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        body.verbosity = normalized;
      }
    }
    removeKey(body, 'effort');
    mergeExtraBody(body, config);
  }
}
