/** Centralized provider/model dialect decisions (provider_quirks.rs). */
import type { ApiConfig } from '../api.ts';
import { getPassbackPolicy, type ReasoningPassbackPolicy } from './reasoning_policy.ts';

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

export interface RuntimeReasoningOverride {
  force_enabled: boolean;
  disabled_effort: string | null;
}

export interface ProviderQuirks {
  max_tokens_field: MaxTokensField;
  preserve_existing_max_tokens: boolean;
  legacy_max_tokens_field: MaxTokensField;
  sampling_params_allowed: boolean;
  strip_tool_choice_on_tool_result: boolean;
  force_json_response_format: boolean;
  reasoning_passback: ReasoningPassbackPolicy;
  runtime_reasoning: RuntimeReasoningOverride;
}

export interface EndpointQuirks {
  use_mimo_test_payload: boolean;
}

const FORCED_REASONING_MODEL_PATTERNS = ['codex', 'gpt-oss', '-pro'];
const OPENAI_O_FAMILIES = ['o1', 'o3', 'o4'];
const MODERN_GPT5_NONE_PREFIXES = [
  'gpt-5.1', 'gpt-5.2', 'gpt-5.3', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6',
];
const INITIAL_GPT5_VARIANTS = ['gpt-5-mini', 'gpt-5-nano'];

function providerFieldMatches(value: string | null | undefined, expected: string): boolean {
  return value !== null && value !== undefined && value.toLowerCase() === expected;
}

function modelMatchesFamily(model: string, family: string): boolean {
  return model === family
    || model.startsWith(`${family}-`)
    || model.endsWith(`/${family}`)
    || model.includes(`/${family}-`);
}

function runtimeReasoningOverride(config: ApiConfig): RuntimeReasoningOverride {
  const providerType = config.providerType ?? '';
  const providerScope = config.providerScope ?? '';
  const protocol = config.apiProtocol ?? '';
  const model = config.model.toLowerCase();

  const hasExplicitOpenaiProtocol =
    protocol === 'openai_chat_completions' || protocol === 'openai_responses';
  const isCodex = providerType.toLowerCase() === 'openai_codex'
    || providerScope.toLowerCase() === 'openai_codex';
  const isOpenaiOFamily = OPENAI_O_FAMILIES.some((family) => modelMatchesFamily(model, family));
  const isOpenaiReasoningModel = (model.includes('gpt-5') && !model.includes('gpt-5-chat'))
    || model.includes('codex')
    || model.includes('gpt-oss')
    || isOpenaiOFamily;

  const isOpenaiProtocol = hasExplicitOpenaiProtocol
    || (protocol === '' && (isCodex || isOpenaiReasoningModel));
  const modernGpt5SupportsNone = MODERN_GPT5_NONE_PREFIXES.some((prefix) => model.includes(prefix))
    && !model.includes('-pro')
    && !model.includes('codex')
    && !model.includes('-chat');
  const initialGpt5 = (model === 'gpt-5'
    || model.endsWith('/gpt-5')
    || INITIAL_GPT5_VARIANTS.some((variant) => model.includes(variant)))
    && !model.includes('gpt-5.');
  const forcedByPattern = FORCED_REASONING_MODEL_PATTERNS.some((pattern) => model.includes(pattern));
  const forcedOpenaiReasoning = (isCodex || isOpenaiReasoningModel)
    && (isCodex || forcedByPattern || initialGpt5 || isOpenaiOFamilies(model));

  return {
    force_enabled: isOpenaiProtocol && forcedOpenaiReasoning,
    disabled_effort: isOpenaiProtocol && modernGpt5SupportsNone ? 'none' : null,
  };
}

function isOpenaiOFamilies(model: string): boolean {
  return OPENAI_O_FAMILIES.some((family) => modelMatchesFamily(model, family));
}

export function resolveQuirks(config: ApiConfig): ProviderQuirks {
  const model = config.model.toLowerCase();
  const modelSlug = model.split('/').at(-1) ?? model;
  const isQwen = providerFieldMatches(config.providerType, 'qwen')
    || config.modelAdapter.toLowerCase() === 'qwen';
  const isMimo = providerFieldMatches(config.providerScope, 'mimo')
    || providerFieldMatches(config.providerType, 'mimo')
    || config.modelAdapter.toLowerCase() === 'mimo'
    || config.baseUrl.toLowerCase().includes('xiaomimimo.com')
    || model.startsWith('mimo-v');
  const isMistral = providerFieldMatches(config.providerScope, 'mistral')
    || providerFieldMatches(config.providerType, 'mistral')
    || config.modelAdapter.toLowerCase() === 'mistral'
    || config.baseUrl.toLowerCase().includes('mistral.ai')
    || modelSlug.startsWith('mistral-')
    || modelSlug.startsWith('magistral-');

  const maxTokensField: MaxTokensField = isMimo
    ? 'max_completion_tokens'
    : isMistral
      ? 'max_tokens'
      : config.isReasoning ? 'max_completion_tokens' : 'max_tokens';

  return {
    max_tokens_field: maxTokensField,
    preserve_existing_max_tokens: config.isReasoning && !isMimo && !isMistral,
    legacy_max_tokens_field: isMimo ? 'max_completion_tokens' : 'max_tokens',
    sampling_params_allowed: !config.isReasoning || isMimo,
    strip_tool_choice_on_tool_result: isQwen,
    force_json_response_format: config.model.startsWith('gpt-'),
    reasoning_passback: getPassbackPolicy(config),
    runtime_reasoning: runtimeReasoningOverride(config),
  };
}

export function resolveEndpointQuirks(model: string, baseUrl: string): EndpointQuirks {
  return {
    use_mimo_test_payload: model.toLowerCase().startsWith('mimo-v')
      || baseUrl.toLowerCase().includes('xiaomimimo.com'),
  };
}
