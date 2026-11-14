/** 字节豆包适配器（adapters/doubao.rs）。 */
import type { ApiConfig } from '../../api.ts';
import { resolveEnableThinking, type JsonObject, type PassbackPolicy } from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';

export class DoubaoAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'doubao';
  override get label(): string { return '字节豆包'; }
  override get description(): string {
    return '豆包 Seed/Thinking 系列，支持 thinking.type (auto/enabled/disabled)';
  }

  static supportsAutoMode(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.includes('seed') || lower.includes('thinking-pro-m');
  }

  static isThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.includes('thinking') || lower.includes('seed');
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    if (!config.supportsReasoning && !config.isReasoning) return false;
    const enableThinkingValue = resolveEnableThinking(config, enableThinking);
    let thinkingType: string;
    if (enableThinkingValue) {
      if (DoubaoAdapter.supportsAutoMode(config.model)) {
        const effort = config.reasoningEffort?.toLowerCase();
        thinkingType = effort === 'auto' || effort === 'medium' ? 'auto' : 'enabled';
      } else {
        thinkingType = 'enabled';
      }
    } else {
      thinkingType = 'disabled';
    }
    body.thinking = { type: thinkingType };
    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return config.isReasoning || config.supportsReasoning || DoubaoAdapter.isThinkingModel(config.model)
      ? 'deep_seek_style' : 'no_passback';
  }
}
