/** MiniMax 专用适配器（adapters/minimax.rs）。 */
import type { ApiConfig } from '../../api.ts';
import { mergeExtraBody, type JsonObject, type PassbackPolicy } from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { removeKey } from '../json_map.ts';

export function parseMiniMaxVersion(model: string): [number, number] | null {
  const lower = model.toLowerCase();
  const bytes = new TextEncoder().encode(lower);
  let index = lower.indexOf('m');
  while (index !== -1) {
    const previous = index > 0 ? String.fromCharCode(bytes[index - 1]!) : '';
    if (index === 0 || !/^[a-z0-9]$/i.test(previous)) {
      const rest = lower.slice(index + 1);
      const majorMatch = /^\d+/.exec(rest);
      if (majorMatch !== null) {
        const major = Number.parseInt(majorMatch[0], 10);
        const afterMajor = rest.slice(majorMatch[0].length);
        let minor = 0;
        if (afterMajor.startsWith('.') || afterMajor.startsWith('-')) {
          // Rust 只接受 1~2 位 minor（`(1..=2).contains(&minor_str.len())`），
          // 更长的数字串按无 minor 处理。
          const minorMatch = /^\d+/.exec(afterMajor.slice(1));
          if (minorMatch !== null && minorMatch[0].length <= 2) {
            minor = Number.parseInt(minorMatch[0], 10);
          }
        }
        return [major, minor];
      }
    }
    index = lower.indexOf('m', index + 1);
  }
  return null;
}

export class MiniMaxAdapter extends GenericOpenAIAdapter {
  override readonly id: string = 'minimax';
  override get label(): string { return 'MiniMax'; }
  override get description(): string {
    return 'MiniMax 系列，M3+ 支持 thinking:{adaptive/disabled}，支持 reasoning_split 参数';
  }

  override applyReasoningConfig(
    body: JsonObject, config: ApiConfig, enableThinking: boolean | null,
  ): boolean {
    removeKey(body, 'enable_thinking');
    removeKey(body, 'thinking_budget');
    removeKey(body, 'include_thoughts');

    const version = parseMiniMaxVersion(config.model);
    const supportsSwitch = version !== null && version[0] >= 3;
    if (supportsSwitch) {
      const existing = body.thinking;
      const bodyThinkingType =
        typeof existing === 'object' && existing !== null && !Array.isArray(existing)
          ? (existing as JsonObject).type : undefined;
      let thinkingOn: boolean;
      switch (bodyThinkingType) {
        case 'disabled': thinkingOn = false; break;
        case 'adaptive': case 'enabled': thinkingOn = true; break;
        default:
          thinkingOn = enableThinking ?? config.enableThinking ?? (config.thinkingEnabled || config.isReasoning);
      }
      body.thinking = { type: thinkingOn ? 'adaptive' : 'disabled' };
    } else {
      removeKey(body, 'thinking');
    }

    if (config.reasoningSplit !== null && config.reasoningSplit !== undefined) {
      body.reasoning_split = config.reasoningSplit;
    }
    return true;
  }

  override shouldRemoveSamplingParams(_config: ApiConfig): boolean {
    void _config;
    return false;
  }

  override applyCommonParams(body: JsonObject, config: ApiConfig): void {
    if (config.reasoningSplit !== null && config.reasoningSplit !== undefined) {
      body.reasoning_split = config.reasoningSplit;
    }
    if (config.minP !== null && config.minP !== undefined) body.min_p = config.minP;
    if (config.topK !== null && config.topK !== undefined) body.top_k = config.topK;
    if (config.repetitionPenalty !== null && config.repetitionPenalty !== undefined) {
      body.repetition_penalty = config.repetitionPenalty;
    }
    mergeExtraBody(body, config);
  }

  override getPassbackPolicy(config: ApiConfig): PassbackPolicy {
    return config.isReasoning ? 'reasoning_details' : 'no_passback';
  }
}
