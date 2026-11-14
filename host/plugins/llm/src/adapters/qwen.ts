/** 阿里通义千问适配器（adapters/qwen.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  getTrimmedEffort, resolveEnableThinking, type JsonObject, type PassbackPolicy,
} from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { removeKey } from '../json_map.ts';

const FORCED_QWEN37_MAX = [
  'qwen3.7-max-preview', 'qwen3-7-max-preview', 'qwen3.7-max-2026-05-17',
  'qwen3-7-max-2026-05-17', 'qwen3.7-max-20260517', 'qwen3-7-max-20260517',
];

export class QwenAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'qwen';
  override get label(): string { return '通义千问'; }
  override get description(): string { return 'Qwen 系列，支持 enable_thinking/thinking_budget 参数'; }

  static isForcedThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();
    if (lower.includes('qwq')) return true;
    if (FORCED_QWEN37_MAX.some((value) => lower.includes(value))) return true;
    return lower.includes('qwen3') && lower.split(/[-_/]/).some((token) => token === 'thinking');
  }

  static isSiliconflow(config: ApiConfig): boolean {
    return config.providerType?.toLowerCase() === 'siliconflow'
      || config.baseUrl.includes('siliconflow.cn') || config.baseUrl.includes('siliconflow.com');
  }

  static isDashscope(config: ApiConfig): boolean {
    return config.providerType?.toLowerCase() === 'qwen'
      || config.baseUrl.includes('dashscope.aliyuncs.com')
      || config.baseUrl.includes('dashscope-intl.aliyuncs.com')
      || config.baseUrl.includes('.maas.aliyuncs.com')
      || config.baseUrl.includes('qianwenaiapi.com');
  }

  static supportsPreserveThinking(model: string): boolean {
    return model.trim().toLowerCase().includes('qwen3.6')
      || model.trim().toLowerCase().includes('qwen3.7');
  }

  static isQwen38EffortModel(model: string): boolean {
    const segment = model.trim().toLowerCase().split('/').at(-1) ?? '';
    return segment.startsWith('qwen3.8');
  }

  static isQwen38OmniModel(model: string): boolean {
    const lower = model.trim().toLowerCase();
    return lower.includes('qwen3.8') && lower.includes('omni');
  }

  static normalizeQwen38Effort(effort: string | null, isOmni: boolean): string | null {
    const normalized = effort?.trim().toLowerCase();
    switch (normalized) {
      case undefined: case '': case 'unset': return null;
      case 'none': return isOmni ? 'none' : null;
      case 'minimal': case 'low': return 'low';
      case 'medium': return 'medium';
      case 'high': case 'xhigh': case 'max': case 'ultra': return 'xhigh';
      default: return null;
    }
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    const isSiliconflow = QwenAdapter.isSiliconflow(config);
    const isDashscope = QwenAdapter.isDashscope(config);
    if (isDashscope) removeKey(body, 'frequency_penalty');

    const forcedThinking = QwenAdapter.isForcedThinkingModel(config.model);
    const isQwen38 = QwenAdapter.isQwen38EffortModel(config.model);
    const isQwen38Omni = isQwen38 && QwenAdapter.isQwen38OmniModel(config.model);
    let qwen38Effort = isQwen38
      ? QwenAdapter.normalizeQwen38Effort(getTrimmedEffort(config), isQwen38Omni) : null;

    if (config.supportsReasoning || forcedThinking) {
      const enableThinkingValue = forcedThinking || resolveEnableThinking(config, enableThinking);
      body.enable_thinking = enableThinkingValue;
      if (isQwen38 && isQwen38Omni && !enableThinkingValue) qwen38Effort = 'none';
      if (isDashscope && QwenAdapter.supportsPreserveThinking(config.model)) {
        body.preserve_thinking = enableThinkingValue && config.includeThoughts;
      }
      if (config.thinkingBudget !== null && config.thinkingBudget !== undefined
        && qwen38Effort === null) {
        const sanitized = isSiliconflow
          ? Math.min(32768, Math.max(128, config.thinkingBudget))
          : Math.max(0, config.thinkingBudget);
        if (sanitized > 0) body.thinking_budget = sanitized;
      }
    }

    if (isDashscope || isSiliconflow) {
      removeKey(body, 'reasoning_effort');
    } else {
      const effort = getTrimmedEffort(config);
      if (effort !== null && effort.toLowerCase() !== 'none' && effort.toLowerCase() !== 'unset') {
        body.reasoning_effort = effort.toLowerCase();
      }
    }

    if (isQwen38) {
      if (qwen38Effort !== null) {
        body.reasoning_effort = qwen38Effort;
        removeKey(body, 'thinking_budget');
      } else if (isQwen38Omni) {
        body.reasoning_effort = 'xhigh';
        removeKey(body, 'thinking_budget');
      }
    }
    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return config.supportsReasoning || config.isReasoning ? 'deep_seek_style' : 'no_passback';
  }
}
