export type DeepSeekReasoningControlKind =
  | 'openai-effort'
  | 'v4-effort'
  | 'v32-budget-effort'
  | 'toggle-only';

export type DeepSeekReasoningOptionValue = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface DeepSeekReasoningOption {
  value: DeepSeekReasoningOptionValue;
  labelKey: string;
  defaultLabel: string;
}

export interface DeepSeekReasoningControl {
  kind: DeepSeekReasoningControlKind;
  options: DeepSeekReasoningOption[];
}

export interface DeepSeekRuntimeReasoningControlInput {
  model?: unknown;
  modelId?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
}

export interface DeepSeekRuntimeReasoningSelectionInput {
  control: DeepSeekReasoningControl;
  enableThinking?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
}

export interface DeepSeekRuntimeReasoningSelection {
  enableThinking: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
}

export const DEEPSEEK_V32_EFFORT_BUDGETS: Record<'low' | 'medium' | 'high' | 'xhigh', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

const V4_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const OPENAI_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.reasoning.effort.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'Extra High' },
];

const V32_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.deepseek.depth.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.deepseek.depth.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.deepseek.depth.xhigh', defaultLabel: 'Extra High' },
];

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function isDeepSeekV4ModelId(modelId: string | undefined | null): boolean {
  const lower = normalize(modelId);
  return lower.includes('deepseek-v4') || lower === 'deepseek-chat' || lower === 'deepseek-reasoner';
}

export function isDeepSeekV32ModelId(modelId: string | undefined | null): boolean {
  return normalize(modelId).includes('deepseek-v3.2');
}

export function isOpenAiReasoningModelId(modelId: string | undefined | null): boolean {
  const lower = normalize(modelId);
  if (!lower) return false;
  return (
    (lower.includes('gpt-5') && !lower.includes('gpt-5-chat')) ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4') ||
    lower.includes('gpt-oss') ||
    lower.includes('codex-mini')
  );
}

export function deepSeekV32EffortToBudget(effort: string | undefined | null): number | undefined {
  const normalized = normalize(effort);
  if (normalized === 'max') return DEEPSEEK_V32_EFFORT_BUDGETS.xhigh;
  if (normalized in DEEPSEEK_V32_EFFORT_BUDGETS) {
    return DEEPSEEK_V32_EFFORT_BUDGETS[normalized as keyof typeof DEEPSEEK_V32_EFFORT_BUDGETS];
  }
  return undefined;
}

export function deepSeekV32BudgetToEffort(budget: number | undefined | null): 'low' | 'medium' | 'high' | 'xhigh' {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.low) return 'low';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.high) return 'high';
  return 'xhigh';
}

export function normalizeDeepSeekV4Effort(effort: string | undefined | null): 'high' | 'max' {
  return normalize(effort) === 'max' || normalize(effort) === 'xhigh' ? 'max' : 'high';
}

export function resolveDeepSeekReasoningControl(
  modelId: string | undefined | null,
  supportsReasoningEffort: boolean
): DeepSeekReasoningControl {
  if (isOpenAiReasoningModelId(modelId)) {
    return { kind: 'openai-effort', options: OPENAI_EFFORT_OPTIONS };
  }
  if (supportsReasoningEffort || isDeepSeekV4ModelId(modelId)) {
    return { kind: 'v4-effort', options: V4_EFFORT_OPTIONS };
  }
  if (isDeepSeekV32ModelId(modelId)) {
    return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS };
  }
  return { kind: 'toggle-only', options: [] };
}

export function resolveDeepSeekRuntimeReasoningControl(
  input: DeepSeekRuntimeReasoningControlInput
): DeepSeekReasoningControl {
  const model = normalize(input.model) || normalize(input.modelId);
  if (isOpenAiReasoningModelId(model)) {
    return { kind: 'openai-effort', options: OPENAI_EFFORT_OPTIONS };
  }
  if (isDeepSeekV4ModelId(model)) {
    return { kind: 'v4-effort', options: V4_EFFORT_OPTIONS };
  }
  if (isDeepSeekV32ModelId(model)) {
    return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS };
  }
  return { kind: 'toggle-only', options: [] };
}

export function resolveDeepSeekRuntimeReasoningSelection(
  input: DeepSeekRuntimeReasoningSelectionInput
): DeepSeekRuntimeReasoningSelection {
  const enableThinking = input.enableThinking ?? true;

  if (input.control.kind === 'openai-effort') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const effort =
      normalizedEffort === 'low' ||
      normalizedEffort === 'medium' ||
      normalizedEffort === 'high' ||
      normalizedEffort === 'xhigh'
        ? normalizedEffort
        : 'medium';

    return {
      enableThinking,
      reasoningEffort: effort,
      thinkingBudget: undefined,
    };
  }

  if (input.control.kind === 'v4-effort') {
    return {
      enableThinking,
      reasoningEffort: normalizeDeepSeekV4Effort(input.reasoningEffort ?? deepSeekV32BudgetToEffort(input.thinkingBudget)),
      thinkingBudget: undefined,
    };
  }

  if (input.control.kind === 'v32-budget-effort') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const effort =
      normalizedEffort === 'low' ||
      normalizedEffort === 'medium' ||
      normalizedEffort === 'high' ||
      normalizedEffort === 'xhigh' ||
      normalizedEffort === 'max'
        ? normalizedEffort
        : deepSeekV32BudgetToEffort(input.thinkingBudget);
    const v32Effort = effort === 'max' ? 'xhigh' : effort;

    return {
      enableThinking,
      reasoningEffort: v32Effort,
      thinkingBudget: deepSeekV32EffortToBudget(v32Effort),
    };
  }

  return {
    enableThinking,
    reasoningEffort: undefined,
    thinkingBudget: undefined,
  };
}
