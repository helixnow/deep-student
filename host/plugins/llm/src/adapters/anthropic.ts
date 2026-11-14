/** Anthropic/Claude 适配器（adapters/anthropic.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  BaseAdapter, getTrimmedEffort, resolveEnableThinking, type JsonObject, type PassbackPolicy,
} from './base.ts';
import { removeKey } from '../json_map.ts';

const MAX_BUDGET_TOKENS = 32_768;
const MIN_BUDGET_TOKENS = 1_024;
const DEFAULT_BUDGET_TOKENS = 10_240;

export type ClaudeGeneration = 'adaptive' | 'manual' | 'unsupported';

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;
type ClaudeFamily = typeof FAMILIES[number];

interface ParsedClaudeModel {
  family: ClaudeFamily;
  major: number;
  minor: number | null;
}

/** 解析 Claude 模型 ID 中的（家族, 主版本, 次版本）。 */
export function parseClaudeModel(model: string): ParsedClaudeModel | null {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== '');
  const familyIndex = tokens.findIndex((token) => (FAMILIES as readonly string[]).includes(token));
  if (familyIndex === -1) return null;
  const family = tokens[familyIndex] as ClaudeFamily;

  const asVersion = (token: string | undefined): number | null => {
    if (token === undefined) return null;
    if (!/^\d+$/.test(token)) return null;
    const value = Number.parseInt(token, 10);
    return value < 100 ? value : null;
  };

  const major = asVersion(tokens[familyIndex + 1]);
  if (major !== null) {
    return { family, major, minor: asVersion(tokens[familyIndex + 2]) };
  }

  const numbers: number[] = [];
  let index = familyIndex;
  while (index > 0) {
    index -= 1;
    const value = asVersion(tokens[index]);
    if (value === null) break;
    numbers.push(value);
  }
  numbers.reverse();
  if (numbers.length > 0) {
    return { family, major: numbers[0]!, minor: numbers[1] ?? null };
  }
  return { family, major: 0, minor: null };
}

/** 集中式 Claude 代际判定。 */
export function claudeGeneration(model: string): ClaudeGeneration {
  const parsed = parseClaudeModel(model);
  if (parsed === null) return 'unsupported';
  const { family, major, minor } = parsed;
  if (family === 'fable' || family === 'mythos') return 'adaptive';
  if (family === 'opus') {
    if (major === 0) return 'unsupported';
    if (major >= 5) return 'adaptive';
    if (major === 4 && minor !== null && minor >= 6) return 'adaptive';
    if (major === 4) return 'manual';
    return 'unsupported';
  }
  if (family === 'sonnet') {
    if (major === 0) return 'unsupported';
    if (major >= 5) return 'adaptive';
    if (major === 4 && minor !== null && minor >= 6) return 'adaptive';
    if (major === 4) return 'manual';
    if (major === 3 && minor === 7) return 'manual';
    return 'unsupported';
  }
  if (family === 'haiku') {
    if (major === 0) return 'unsupported';
    if (major === 4) return 'manual';
    return 'unsupported';
  }
  return 'unsupported';
}

/** Fable 5 / restricted Mythos 5 的 thinking 为 always-on。 */
export function claudeThinkingAlwaysOn(model: string): boolean {
  const parsed = parseClaudeModel(model);
  return parsed !== null && (parsed.family === 'fable' || parsed.family === 'mythos');
}

/** reasoning_effort → Anthropic effort（新代际）。 */
export function mapReasoningEffortToAnthropic(effort: string): string | null {
  switch (effort.trim().toLowerCase()) {
    case 'low': case 'minimal': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    default: return null;
  }
}

/** budget_tokens → effort 的近似映射。 */
export function mapBudgetTokensToEffort(budget: number): 'low' | 'medium' | 'high' | 'max' {
  if (budget < 8192) return 'low';
  if (budget < 16384) return 'medium';
  if (budget < 32768) return 'high';
  return 'max';
}

function clampTopPForThinking(topP: number): number {
  return Math.min(1.0, Math.max(0.95, topP));
}

function isClaude45(model: string): boolean {
  const parsed = parseClaudeModel(model);
  return parsed !== null
    && (parsed.family === 'opus' || parsed.family === 'sonnet' || parsed.family === 'haiku')
    && parsed.major === 4 && parsed.minor === 5;
}

function numericBodyValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class AnthropicAdapter extends BaseAdapter {
  override readonly id: string = 'anthropic';
  override get label(): string { return 'Anthropic Claude'; }
  override get description(): string {
    return 'Claude 系列，thinking 请求形态按代际分叉（manual budget / adaptive effort）';
  }

  static isClaude45(model: string): boolean {
    return isClaude45(model);
  }

  static validateBudgetTokens(
    budget: number | null | undefined, maxTokens: number | null | undefined, budgetCap: number,
  ): number {
    const requested = budget !== null && budget !== undefined && budget > 0
      ? budget : DEFAULT_BUDGET_TOKENS;
    let validated = Math.min(budgetCap, Math.max(MIN_BUDGET_TOKENS, requested));

    if (maxTokens !== null && maxTokens !== undefined) {
      if (maxTokens <= 1) return 1;
      if (maxTokens <= MIN_BUDGET_TOKENS) return Math.max(1, maxTokens - 1);
      if (validated >= maxTokens) {
        validated = Math.max(MIN_BUDGET_TOKENS, maxTokens - 1);
      }
    }
    return validated;
  }

  private applyAdaptiveGeneration(
    body: JsonObject, config: ApiConfig, enableThinkingValue: boolean,
  ): void {
    removeKey(body, 'temperature');
    removeKey(body, 'top_p');
    removeKey(body, 'top_k');

    if (enableThinkingValue) {
      const thinking: JsonObject = { type: 'adaptive' };
      if (config.includeThoughts) thinking.display = 'summarized';
      body.thinking = thinking;

      const requested = getTrimmedEffort(config);
      let effort = requested === null ? null : mapReasoningEffortToAnthropic(requested);
      if (effort === null) {
        const legacyEffort = config.effort?.trim();
        if (legacyEffort !== undefined && legacyEffort !== '') {
          effort = mapReasoningEffortToAnthropic(legacyEffort);
        }
      }
      if (effort === null && config.thinkingBudget !== null
        && config.thinkingBudget !== undefined && config.thinkingBudget > 0) {
        effort = mapBudgetTokensToEffort(config.thinkingBudget);
      }
      if (effort !== null) body.effort = effort;
      else removeKey(body, 'effort');
    } else if (!claudeThinkingAlwaysOn(config.model)) {
      body.thinking = { type: 'disabled' };
      removeKey(body, 'effort');
    }
  }

  private applyManualGeneration(
    body: JsonObject, config: ApiConfig, enableThinkingValue: boolean,
    generation: ClaudeGeneration,
  ): void {
    if (enableThinkingValue) {
      removeKey(body, 'temperature');
      removeKey(body, 'top_k');

      const topP = numericBodyValue(body.top_p);
      if (topP !== null && (topP < 0.95 || topP > 1.0)) {
        body.top_p = clampTopPForThinking(topP);
      }

      void generation;

      const maxTokensRaw = body.max_tokens ?? body.max_completion_tokens;
      const maxTokens = numericBodyValue(maxTokensRaw) === null
        ? null : Math.trunc(numericBodyValue(maxTokensRaw) as number);
      const budgetTokens = AnthropicAdapter.validateBudgetTokens(
        config.thinkingBudget, maxTokens, MAX_BUDGET_TOKENS,
      );
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    } else if (isClaude45(config.model)) {
      if (Object.prototype.hasOwnProperty.call(body, 'temperature')
        && Object.prototype.hasOwnProperty.call(body, 'top_p')) {
        removeKey(body, 'top_p');
      }
    }
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    removeKey(body, 'frequency_penalty');
    removeKey(body, 'presence_penalty');

    const enableThinkingValue = resolveEnableThinking(config, enableThinking);
    const generation = claudeGeneration(config.model);

    if (generation === 'adaptive') {
      this.applyAdaptiveGeneration(body, config, enableThinkingValue);
      return true;
    }

    this.applyManualGeneration(body, config, enableThinkingValue, generation);
    return false;
  }

  override shouldRemoveSamplingParams(config: ApiConfig): boolean {
    return claudeGeneration(config.model) === 'adaptive';
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return resolveEnableThinking(config, null) ? 'deep_seek_style' : 'no_passback';
  }

  override formatToolCallMessage(
    toolCalls: unknown[], thinkingContent: string | null,
  ): unknown | null {
    const blocks: JsonObject[] = [];
    if (thinkingContent !== null && thinkingContent !== '') {
      blocks.push({ type: 'thinking', thinking: thinkingContent });
    }
    for (const toolCall of toolCalls) {
      if (typeof toolCall !== 'object' || toolCall === null || Array.isArray(toolCall)) continue;
      const call = toolCall as JsonObject;
      const fn = typeof call.function === 'object' && call.function !== null
        && !Array.isArray(call.function) ? call.function as JsonObject : {};
      const rawArguments = fn.arguments;
      let input: unknown = {};
      if (typeof rawArguments === 'string') {
        try { input = JSON.parse(rawArguments); } catch { // boundary-allow empty-catch: Rust `serde_json::from_str(s).ok()` 解析失败回退 `{}`，不记录日志
          input = {};
        }
      }
      blocks.push({
        type: 'tool_use',
        id: call.id ?? '',
        name: fn.name ?? '',
        input,
      });
    }
    return blocks.length === 0 ? null : blocks;
  }

  override requiresThinkingInHistory(config: ApiConfig): boolean {
    return resolveEnableThinking(config, null);
  }
}
