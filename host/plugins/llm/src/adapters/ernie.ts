/** 百度文心 ERNIE / 千帆 v2 适配器（adapters/ernie.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  getTrimmedEffort, mergeExtraBody, resolveEnableThinking,
  type JsonObject, type PassbackPolicy,
} from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { removeKey } from '../json_map.ts';

export class ErnieAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'ernie';
  override get label(): string { return '百度文心'; }
  override get description(): string {
    return 'ERNIE/千帆 v2 系列，支持 thinking.type/reasoning_effort/penalty_score 参数';
  }

  static isThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.includes('ernie-5.0-thinking') || lower.includes('ernie-5-thinking')
      || lower.includes('ernie5-thinking') || lower.includes('ernie-x1')
      || lower.includes('ernie_x1');
  }

  static supportsThinkingBudget(model: string): boolean {
    return model.toLowerCase().includes('deepseek');
  }

  static isHostedDeepseek(model: string): boolean {
    return model.toLowerCase().includes('deepseek');
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    if (ErnieAdapter.isHostedDeepseek(config.model)) {
      const effort = getTrimmedEffort(config);
      if (effort !== null) {
        const lower = effort.toLowerCase();
        if (lower === 'low' || lower === 'medium' || lower === 'high' || lower === 'max') {
          body.reasoning_effort = lower;
        } else if (lower === 'xhigh') {
          body.reasoning_effort = 'max';
        }
      }
    } else if (getTrimmedEffort(config) !== null) {
      removeKey(body, 'reasoning_effort');
    }

    const canThink = ErnieAdapter.isThinkingModel(config.model)
      || config.supportsReasoning || config.isReasoning;
    if (canThink) {
      const thinkingEnabled = resolveEnableThinking(config, enableThinking);
      body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
      removeKey(body, 'enable_thinking');
    }

    if (!ErnieAdapter.supportsThinkingBudget(config.model)) removeKey(body, 'thinking_budget');
    return false;
  }

  override shouldRemoveSamplingParams(config: ApiConfig): boolean {
    return ErnieAdapter.isThinkingModel(config.model)
      || config.isReasoning || config.supportsReasoning;
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return ErnieAdapter.isThinkingModel(config.model)
      || config.supportsReasoning || config.isReasoning
      ? 'deep_seek_style' : 'no_passback';
  }

  override applyCommonParams(body: JsonObject, config: ApiConfig): void {
    if (config.minP !== null && config.minP !== undefined) body.min_p = config.minP;
    if (config.topK !== null && config.topK !== undefined) body.top_k = config.topK;
    if (config.repetitionPenalty !== null && config.repetitionPenalty !== undefined) {
      body.penalty_score = config.repetitionPenalty;
    }
    mergeExtraBody(body, config);
  }
}
