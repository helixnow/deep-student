/** 思维链回传策略（reasoning_policy.rs）。 */
import type { ApiConfig } from '../api.ts';
import { isOfficialDeepseekConfig } from './protocol.ts';
import { requestAdapterForConfig } from './adapters/registry.ts';

export type ReasoningPassbackPolicy = 'deep_seek_style' | 'reasoning_details' | 'no_passback';

export interface ReasoningDetail {
  type: string;
  text?: string;
  summary?: string;
  encryptedContent?: string;
  id?: string;
  index?: number;
  signature?: string;
}

export function thinkingDetail(text: string): ReasoningDetail {
  return { type: 'thinking', text };
}

export function thinkingDetailWithSignature(text: string, signature: string): ReasoningDetail {
  return { type: 'thinking', text, signature };
}

export function isGeminiThinkingModel(config: ApiConfig): boolean {
  const model = config.model.toLowerCase();
  return model.includes('gemini-2.5') || model.includes('gemini-3') || model.includes('gemini3');
}

export function getPassbackPolicy(config: ApiConfig): ReasoningPassbackPolicy {
  const provider = (config.providerType ?? '').toLowerCase();
  const model = config.model.toLowerCase();

  if (provider === 'openrouter') {
    if (model.includes('gemini-3') || model.includes('gemini-2.5')) return 'reasoning_details';
    if (
      model.includes('/o1') || model.includes('/o3') || model.includes('/o4')
      || model.includes('o1-') || model.includes('o3-') || model.includes('o4-')
    ) return 'reasoning_details';
    if (model.includes('/gpt-5') || model.includes('gpt-5.')) return 'reasoning_details';
    if ((model.includes('kimi') || model.includes('moonshot')) && model.includes('thinking')) {
      return 'reasoning_details';
    }
  }

  if ((provider === 'google' || provider === 'gemini') && isGeminiThinkingModel(config)) {
    return 'reasoning_details';
  }

  if (provider === 'perplexity' && model.includes('sonar') && model.includes('reasoning')) {
    return 'deep_seek_style';
  }

  return requestAdapterForConfig(config).getPassbackPolicy(config);
}

export function requiresReasoningPassback(config: ApiConfig): boolean {
  return getPassbackPolicy(config) !== 'no_passback';
}

export function isOfficialDeepseekV4Family(config: ApiConfig): boolean {
  const model = config.model.toLowerCase();
  const isDeepseekHost = isOfficialDeepseekConfig(config);
  const isV4Family = model.includes('deepseek-v4')
    || model.includes('deepseek-flash')
    || model === 'deepseek-chat' || model === 'deepseek-reasoner';
  return isDeepseekHost && isV4Family;
}

export function shouldPassbackPlainAssistantReasoning(config: ApiConfig): boolean {
  return requiresReasoningPassback(config) && !isOfficialDeepseekV4Family(config);
}

export function shouldPassbackPlainAssistantReasoningForRequest(
  config: ApiConfig, requestHasTools: boolean,
): boolean {
  if (!requiresReasoningPassback(config)) return false;
  if (isOfficialDeepseekV4Family(config)) return requestHasTools;
  return true;
}

export function usesReasoningDetailsFormat(config: ApiConfig): boolean {
  return getPassbackPolicy(config) === 'reasoning_details';
}

export function requiresThoughtSignature(config: ApiConfig): boolean {
  return isGeminiThinkingModel(config);
}

export function getPolicyName(policy: ReasoningPassbackPolicy): string {
  switch (policy) {
    case 'deep_seek_style': return 'DeepSeek Style (reasoning_content)';
    case 'reasoning_details': return 'Reasoning Details (reasoning_details array)';
    case 'no_passback': return 'No Passback';
  }
}
