/** 智谱 GLM 适配器（adapters/zhipu.rs）。 */
import type { ApiConfig } from '../../api.ts';
import { getTrimmedEffort, resolveEnableThinking, type JsonObject } from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { removeKey } from '../json_map.ts';

export class ZhipuAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'zhipu';
  override get label(): string { return '智谱 GLM'; }
  override get description(): string { return 'GLM 系列，支持 thinking.type/clear_thinking 参数'; }

  static supportsThinkingStatic(model: string): boolean {
    return ZhipuAdapter.supportsThinking(model);
  }

  static supportsThinking(model: string): boolean {
    const lower = model.toLowerCase();
    if (lower.includes('-flash') || lower.includes('4.1v')) return false;
    return ['glm-4.5', 'glm-4.6', 'glm-4.7', 'glm4.5', 'glm4.6', 'glm4.7', 'glm-5', 'glm5']
      .some((fragment) => lower.includes(fragment));
  }

  static supportsToolStream(model: string): boolean {
    const lower = model.toLowerCase();
    return ['glm-4.6', 'glm-4.7', 'glm4.6', 'glm4.7', 'glm-5', 'glm5']
      .some((fragment) => lower.includes(fragment));
  }

  static parseGlmVersion(model: string): [number, number] | null {
    const lower = model.toLowerCase();
    const index = lower.indexOf('glm');
    if (index === -1) return null;
    let rest = lower.slice(index + 3);
    if (rest.startsWith('-')) rest = rest.slice(1);
    const majorMatch = /^\d+/.exec(rest);
    if (majorMatch === null) return null;
    const major = Number.parseInt(majorMatch[0], 10);
    const afterMajor = rest.slice(majorMatch[0].length);
    let minor = 0;
    if (afterMajor.startsWith('.') || afterMajor.startsWith('-')) {
      const minorMatch = /^\d{1,2}/.exec(afterMajor.slice(1));
      if (minorMatch !== null) minor = Number.parseInt(minorMatch[0], 10);
    }
    return [major, minor];
  }

  static supportsReasoningEffort(model: string): boolean {
    const version = ZhipuAdapter.parseGlmVersion(model);
    if (version === null) return false;
    return version[0] > 5 || (version[0] === 5 && version[1] >= 2);
  }

  static isGlm53(model: string): boolean {
    const segment = model.trim().toLowerCase().split('/').at(-1) ?? '';
    return segment.startsWith('glm-5.3') || segment.startsWith('glm5.3');
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    removeKey(body, 'frequency_penalty');
    removeKey(body, 'presence_penalty');

    const canThink = ZhipuAdapter.supportsThinking(config.model);
    const isGlm53 = ZhipuAdapter.isGlm53(config.model);
    const thinking: JsonObject = {};
    if ((canThink && !isGlm53) || config.supportsReasoning || isGlm53) {
      const enableThinkingValue = isGlm53 || resolveEnableThinking(config, enableThinking);
      thinking.type = enableThinkingValue ? 'enabled' : 'disabled';
      if (config.includeThoughts) thinking.clear_thinking = false;
    }
    if (Object.keys(thinking).length > 0) body.thinking = thinking;

    if (ZhipuAdapter.supportsReasoningEffort(config.model)) {
      const effort = getTrimmedEffort(config);
      if (effort !== null) {
        const lower = effort.toLowerCase();
        if (isGlm53) {
          let normalized: string;
          switch (lower) {
            case 'minimal': case 'low': normalized = 'low'; break;
            case 'medium': case 'high': case 'xhigh': normalized = 'high'; break;
            case 'none': case 'unset': case 'off': case 'disabled': normalized = 'low'; break;
            default: normalized = 'max';
          }
          body.reasoning_effort = normalized;
        } else if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(lower)) {
          body.reasoning_effort = lower;
        }
      }
    }

    if (ZhipuAdapter.supportsToolStream(config.model)
      && Object.prototype.hasOwnProperty.call(body, 'tools')) {
      body.tool_stream = true;
    }
    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }
}
