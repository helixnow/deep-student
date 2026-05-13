import { isDeepSeekV4ModelId } from '@/utils/deepseekReasoningControls';

export interface DeepSeekSamplingControlInput {
  model?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
  enableThinking?: boolean;
}

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function isOfficialDeepSeekEndpoint(input: DeepSeekSamplingControlInput): boolean {
  const providerType = normalize(input.providerType);
  const providerScope = normalize(input.providerScope);
  const baseUrl = normalize(input.baseUrl);

  return providerType === 'deepseek' || providerScope === 'deepseek' || baseUrl.includes('api.deepseek.com');
}

export function isDeepSeekFamilyEndpoint(input: DeepSeekSamplingControlInput): boolean {
  const providerType = normalize(input.providerType);
  const providerScope = normalize(input.providerScope);
  const baseUrl = normalize(input.baseUrl);

  return (
    isOfficialDeepSeekEndpoint(input) ||
    providerType === 'siliconflow' ||
    providerScope === 'siliconflow' ||
    baseUrl.includes('api.siliconflow.cn')
  );
}

export function shouldLockDeepSeekV4SamplingControls(input: DeepSeekSamplingControlInput): boolean {
  return Boolean(
    input.enableThinking &&
      isDeepSeekFamilyEndpoint(input) &&
      isDeepSeekV4ModelId(normalize(input.model))
  );
}
