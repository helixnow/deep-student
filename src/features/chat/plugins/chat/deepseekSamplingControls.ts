import { isDeepSeekV4ModelId, isOfficialDeepSeekEndpoint } from '@/utils/deepseekReasoningControls';

export { isOfficialDeepSeekEndpoint } from '@/utils/deepseekReasoningControls';

export interface DeepSeekSamplingControlInput {
  model?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
  enableThinking?: boolean;
}

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

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

export function isOfficialDeepSeekV4Model(input: DeepSeekSamplingControlInput): boolean {
  return isOfficialDeepSeekEndpoint(input) && isDeepSeekV4ModelId(normalize(input.model));
}

export function shouldLockDeepSeekV4SamplingControls(
  input: DeepSeekSamplingControlInput,
  parameter: 'temperature' | 'topP' | 'penalty' = 'temperature',
): boolean {
  if (isOfficialDeepSeekV4Model(input)) {
    if (parameter === 'topP') return input.enableThinking === false;
    if (parameter === 'penalty') return true;
  }
  return Boolean(
    input.enableThinking &&
      isDeepSeekFamilyEndpoint(input) &&
      isDeepSeekV4ModelId(normalize(input.model))
  );
}
