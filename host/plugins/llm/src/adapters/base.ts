/** Shared request-adapter primitives (llm_manager/adapters/mod.rs). */
import type { ApiConfig } from '../../api.ts';

export type JsonObject = { [key: string]: unknown };

export type PassbackPolicy = 'deep_seek_style' | 'reasoning_details' | 'no_passback';

export interface RequestAdapter {
  id: string;
  label: string;
  description: string;
  applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean;
  shouldRemoveSamplingParams(config: ApiConfig): boolean;
  validateReasoningConfig(config: ApiConfig): void;
  shouldDisableThinkingForTools(config: ApiConfig, body: JsonObject): boolean;
  applyCommonParams(body: JsonObject, config: ApiConfig): void;
  getPassbackPolicy(config: ApiConfig): PassbackPolicy;
  formatToolCallMessage(toolCalls: unknown[], thinkingContent: string | null): unknown | null;
  requiresThinkingInHistory(config: ApiConfig): boolean;
}

export function resolveEnableThinking(config: ApiConfig, overrideValue?: boolean | null): boolean {
  if (overrideValue !== undefined && overrideValue !== null) return overrideValue;
  if (config.enableThinking !== undefined && config.enableThinking !== null) {
    return config.enableThinking;
  }
  return config.thinkingEnabled;
}

export function getTrimmedEffort(config: ApiConfig): string | null {
  const value = config.reasoningEffort?.trim();
  return value === undefined || value === '' ? null : value;
}

export function mergeExtraBody(body: JsonObject, config: ApiConfig): void {
  const extra = config.extraBody;
  if (extra === null || extra === undefined) return;
  for (const [key, value] of Object.entries(extra)) {
    if (key === '') continue;
    if (Object.prototype.hasOwnProperty.call(body, key)) continue;
    body[key] = value;
  }
}

export function defaultApplyCommonParams(body: JsonObject, config: ApiConfig): void {
  if (config.minP !== null && config.minP !== undefined) body.min_p = config.minP;
  if (config.topK !== null && config.topK !== undefined) body.top_k = config.topK;
  if (config.repetitionPenalty !== null && config.repetitionPenalty !== undefined) {
    body.repetition_penalty = config.repetitionPenalty;
  }
  if (config.reasoningSplit !== null && config.reasoningSplit !== undefined) {
    body.reasoning_split = config.reasoningSplit;
  }
  if (config.effort !== null && config.effort !== undefined) body.effort = config.effort;
  if (config.verbosity !== null && config.verbosity !== undefined) body.verbosity = config.verbosity;
  mergeExtraBody(body, config);
}

/** Base implementation mirroring the Rust trait defaults. */
export abstract class BaseAdapter implements RequestAdapter {
  abstract id: string;
  get label(): string { return this.id; }
  get description(): string { return 'Generic request adapter'; }

  abstract applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean;

  shouldRemoveSamplingParams(config: ApiConfig): boolean {
    return config.isReasoning || config.supportsReasoning;
  }

  validateReasoningConfig(_config: ApiConfig): void { void _config; }

  shouldDisableThinkingForTools(_config: ApiConfig, _body: JsonObject): boolean {
    void _config; void _body;
    return false;
  }

  applyCommonParams(body: JsonObject, config: ApiConfig): void {
    defaultApplyCommonParams(body, config);
  }

  getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return config.isReasoning || config.supportsReasoning ? 'deep_seek_style' : 'no_passback';
  }

  formatToolCallMessage(_toolCalls: unknown[], _thinkingContent: string | null): unknown | null {
    void _toolCalls; void _thinkingContent;
    return null;
  }

  requiresThinkingInHistory(_config: ApiConfig): boolean {
    void _config;
    return false;
  }
}
