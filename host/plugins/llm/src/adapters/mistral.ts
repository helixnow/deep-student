/** Mistral 适配器（adapters/mistral.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  BaseAdapter, getTrimmedEffort, mergeExtraBody, resolveEnableThinking, type JsonObject,
} from './base.ts';

function isMagistral(model: string): boolean {
  return model.toLowerCase().includes('magistral');
}

function supportsReasoningEffort(model: string): boolean {
  if (isMagistral(model)) return false;
  const lower = model.toLowerCase();
  const slug = lower.split('/').at(-1) ?? lower;
  return slug === 'mistral-medium-latest'
    || slug === 'mistral-small-latest'
    || slug === 'mistral-medium-3-5'
    || slug === 'mistral-medium-3.5'
    || slug.startsWith('mistral-medium-3-5-')
    || slug.startsWith('mistral-medium-3.5-')
    || slug === 'mistral-small-4'
    || slug.startsWith('mistral-small-4-');
}

export class MistralAdapter extends BaseAdapter {
  override readonly id: string = 'mistral';
  override get label(): string { return 'Mistral AI'; }
  override get description(): string {
    return 'Mistral 系列，Medium 3.5/Small 4 支持 reasoning_effort，Magistral 遗留 prompt_mode';
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    if (supportsReasoningEffort(config.model)) {
      const requested = enableThinking === false ? 'none' : getTrimmedEffort(config);
      if (requested !== null) {
        let normalized: string;
        switch (requested.toLowerCase()) {
          case 'none': normalized = 'none'; break;
          case 'minimal': case 'low': normalized = 'low'; break;
          case 'medium': normalized = 'medium'; break;
          case 'high': case 'xhigh': case 'max': normalized = 'high'; break;
          default: normalized = 'low';
        }
        body.reasoning_effort = normalized;
      }
    }

    if (isMagistral(config.model)) {
      const shouldEnable = resolveEnableThinking(config, enableThinking);
      body.prompt_mode = shouldEnable ? 'reasoning' : null;
    }

    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override applyCommonParams(body: JsonObject, config: ApiConfig): void {
    if (config.minP !== null && config.minP !== undefined) body.min_p = config.minP;
    if (config.topK !== null && config.topK !== undefined) body.top_k = config.topK;
    if (config.repetitionPenalty !== null && config.repetitionPenalty !== undefined) {
      body.repetition_penalty = config.repetitionPenalty;
    }
    mergeExtraBody(body, config);
  }
}
