/** Mistral 适配器（adapters/mistral.rs）。 */
import type { ApiConfig } from '../../api.ts';
import type { JsonValue } from '../../../../platform/errors/api.ts';
import {
  BaseAdapter, getTrimmedEffort, mergeExtraBody, resolveEnableThinking, type JsonObject,
} from './base.ts';

function isMagistral(model: string): boolean {
  return model.toLowerCase().includes('magistral');
}

function modelSlug(model: string): string {
  const lower = model.trim().toLowerCase();
  return lower.split('/').at(-1) ?? lower;
}

function isMistralHostedGlm(model: string): boolean {
  const slug = modelSlug(model);
  return slug === 'zai-glm-5-3' || slug === 'zai-glm-5-3-flash';
}

function supportsReasoningEffort(model: string): boolean {
  if (isMagistral(model)) return false;
  const slug = modelSlug(model);
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
    const hostedGlm = isMistralHostedGlm(config.model);
    if (hostedGlm || modelSlug(config.model) === 'deepseek-v4-1-flash-1017') {
      const requested = resolveEnableThinking(config, enableThinking)
        ? getTrimmedEffort(config)?.toLowerCase() : 'none';
      if (requested === 'none') body.reasoning_effort = hostedGlm ? 'low' : 'none';
      else if (requested === 'minimal' || requested === 'low') body.reasoning_effort = 'low';
      else body.reasoning_effort = requested === 'max' ? 'max' : 'high';
      return false;
    }

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

export function normalizeMistralChatRequest(body: JsonValue): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    const { reasoning_content: reasoning, content } = message;
    delete message.reasoning_content;
    delete message.reasoning_details;
    delete message.thought_signature;
    delete message.response_reasoning_item;
    delete message.response_web_search_items;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object' && !Array.isArray(part)) delete part.cache_control;
      }
    }
    if (message.role !== 'assistant' || typeof reasoning !== 'string' || !reasoning.trim()) continue;
    const parts = Array.isArray(content) ? content : typeof content === 'string' && content !== ''
      ? [{ type: 'text', text: content }] : [];
    message.content = [{ type: 'thinking', thinking: [{ type: 'text', text: reasoning }] }, ...parts];
  }
}
