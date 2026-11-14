/** Xiaomi MiMo 适配器（adapters/mimo.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  BaseAdapter, resolveEnableThinking, type JsonObject, type PassbackPolicy,
} from './base.ts';
import { removeKey } from '../json_map.ts';

export class MimoAdapter extends BaseAdapter {
  override readonly id: string = 'mimo';
  override get label(): string { return 'Xiaomi MiMo'; }
  override get description(): string { return 'MiMo 系列，支持 thinking.type 与 reasoning_content'; }

  static supportsThinking(config: ApiConfig): boolean {
    const model = config.model.toLowerCase();
    return !model.includes('tts') && (config.supportsReasoning || config.isReasoning);
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    removeKey(body, 'enable_thinking');
    removeKey(body, 'thinking_budget');
    removeKey(body, 'include_thoughts');
    removeKey(body, 'reasoning_effort');

    if (MimoAdapter.supportsThinking(config)) {
      const thinkingEnabled = resolveEnableThinking(config, enableThinking);
      body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
    } else {
      removeKey(body, 'thinking');
    }

    if (typeof body.tool_choice === 'string' && body.tool_choice !== 'auto') {
      body.tool_choice = 'auto';
    }

    return true;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return MimoAdapter.supportsThinking(config) ? 'deep_seek_style' : 'no_passback';
  }
}
