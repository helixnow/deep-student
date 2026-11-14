/** Google Gemini 适配器（adapters/gemini.rs）。 */
import type { ApiConfig } from '../../api.ts';
import {
  BaseAdapter, getTrimmedEffort, resolveEnableThinking, type JsonObject,
} from './base.ts';

function isGemini3(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('gemini-3') || lower.includes('gemini3');
}

function isGemini3Flash(model: string): boolean {
  return isGemini3(model) && model.toLowerCase().includes('flash');
}

function isFlash(model: string): boolean {
  return model.toLowerCase().includes('flash');
}

function defaultThinkingLevel(model: string, flash: boolean): string {
  const lower = model.toLowerCase();
  if (lower.includes('flash-lite')) return 'minimal';
  if (lower.includes('gemini-3.5-flash')) return 'medium';
  if (lower.includes('gemini-3-flash')) return 'high';
  if (flash) return 'low';
  return 'high';
}

function mapEffortToLevel(effort: string | null, model: string, flash: boolean): string {
  const lower = effort?.toLowerCase();
  switch (lower) {
    case 'high': case 'xhigh': return 'high';
    case 'low': return 'low';
    case 'medium': return flash ? 'medium' : 'high';
    case 'minimal': case 'none': return flash ? 'minimal' : 'low';
    default: return defaultThinkingLevel(model, flash);
  }
}

function clampGemini25Budget(model: string, budget: number): number {
  if (budget <= -1) return -1;
  if (isFlash(model)) return Math.min(24_576, Math.max(0, budget));
  return Math.min(32_768, Math.max(128, budget));
}

export class GeminiAdapter extends BaseAdapter {
  override readonly id: string = 'google';
  override get label(): string { return 'Google Gemini'; }
  override get description(): string {
    return 'Gemini 系列，支持 thinkingLevel/thinkingBudget 参数';
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    const enableThinkingValue = resolveEnableThinking(config, enableThinking);
    const effort = getTrimmedEffort(config);
    const gemini3 = isGemini3(config.model);
    const gemini3Flash = isGemini3Flash(config.model);

    const thinkingMap: JsonObject = {};

    if (gemini3) {
      if (enableThinkingValue) {
        thinkingMap.thinkingLevel = mapEffortToLevel(effort, config.model, gemini3Flash);
      } else {
        thinkingMap.thinkingLevel = gemini3Flash ? 'minimal' : 'low';
      }
    } else if (enableThinkingValue) {
      thinkingMap.thinkingBudget = config.thinkingBudget !== null
        && config.thinkingBudget !== undefined
        ? clampGemini25Budget(config.model, config.thinkingBudget)
        : -1;
    } else if (config.model.toLowerCase().includes('flash')) {
      thinkingMap.thinkingBudget = 0;
    }

    if (config.includeThoughts || enableThinkingValue) thinkingMap.includeThoughts = true;

    if (Object.keys(thinkingMap).length > 0) body.thinkingConfig = thinkingMap;

    if (config.geminiApiVersion !== '') {
      body.gemini_api_version = config.geminiApiVersion;
    }

    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }
}
