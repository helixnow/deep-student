/** xAI Grok 适配器（adapters/grok.rs）。 */
import type { ApiConfig } from '../../api.ts';
import { getTrimmedEffort, mergeExtraBody, type JsonObject } from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { removeKey } from '../json_map.ts';

export class GrokAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'grok';
  override get label(): string { return 'xAI Grok'; }
  override get description(): string {
    return 'Grok 系列，grok-4.3+ 支持 reasoning_effort (none/low/medium/high)';
  }

  static parseGrokVersion(model: string): [number, number] | null {
    const lower = model.toLowerCase();
    const index = lower.indexOf('grok');
    if (index === -1) return null;
    let rest = lower.slice(index + 4);
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
    const lower = model.toLowerCase();
    if (lower.includes('non-reasoning')) return false;
    if (lower === 'grok-latest' || lower.endsWith('/grok-latest')) return true;
    const version = GrokAdapter.parseGrokVersion(model);
    return version !== null && (version[0] > 4 || (version[0] === 4 && version[1] >= 3));
  }

  static isGrok420MultiAgent(model: string): boolean {
    const version = GrokAdapter.parseGrokVersion(model);
    return version !== null && version[0] === 4 && version[1] === 20
      && model.toLowerCase().includes('multi-agent');
  }

  static requiresReasoning(model: string): boolean {
    const lower = model.toLowerCase();
    if (lower === 'grok-latest' || lower.endsWith('/grok-latest')) return true;
    const version = GrokAdapter.parseGrokVersion(model);
    return version !== null && (version[0] > 4 || (version[0] === 4 && version[1] >= 5))
      && !lower.includes('non-reasoning');
  }

  static isGrok4(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.includes('grok-4') || lower.includes('grok4');
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    if (GrokAdapter.supportsReasoningEffort(config.model)) {
      const isMultiAgent = GrokAdapter.isGrok420MultiAgent(config.model);
      const requiresReasoning = GrokAdapter.requiresReasoning(config.model);
      const version = GrokAdapter.parseGrokVersion(config.model);
      const supportsXhigh = isMultiAgent
        || (version !== null && (version[0] > 4 || (version[0] === 4 && version[1] >= 6)));
      const requested = enableThinking === false
        ? (requiresReasoning ? 'low' : 'none')
        : getTrimmedEffort(config);
      if (requested !== null) {
        let normalized: string;
        switch (requested.toLowerCase()) {
          case 'none': normalized = requiresReasoning ? 'low' : 'none'; break;
          case 'minimal': case 'low': normalized = 'low'; break;
          case 'medium': normalized = 'medium'; break;
          case 'xhigh': normalized = supportsXhigh ? 'xhigh' : 'high'; break;
          case 'high': case 'max': normalized = 'high'; break;
          default: normalized = 'low';
        }
        body.reasoning_effort = normalized;
      }
    }

    if (GrokAdapter.isGrok4(config.model)) {
      removeKey(body, 'presence_penalty');
      removeKey(body, 'frequency_penalty');
      removeKey(body, 'presencePenalty');
      removeKey(body, 'frequencyPenalty');
      removeKey(body, 'stop');
    }
    return false;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override applyCommonParams(body: JsonObject, config: ApiConfig): void {
    mergeExtraBody(body, config);
  }
}
