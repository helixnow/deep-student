// 档位 ↔ thinking_budget 数值换算（历史方言兼容）。
//
// 这些换算服务于「未开放 reasoning_effort、只能用 thinking_budget 表达强度」的
// 宿主与代际：DeepSeek V3.x（SiliconFlow 托管）与 Qwen 3.7 及更早的混合思考型号。
// 对已开放 reasoning_effort 的模型（V4、Qwen3.8、gpt-5.x/6、GLM、K3、Grok 等），
// effort 是主路径，本模块不参与——budget 仅在后端作未配置 effort 时的兜底。

/** DeepSeek V3.x 在托管宿主上的 budget 档位（SiliconFlow 上限 32768）。 */
export const DEEPSEEK_V32_EFFORT_BUDGETS: Record<'low' | 'medium' | 'high' | 'xhigh', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

/** Qwen 混合思考（3.7 及更早）的 budget 档位。 */
export const QWEN_EFFORT_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 65536,
  max: 262144,
} as const;

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export function deepSeekV32EffortToBudget(effort: string | undefined | null): number | undefined {
  const normalized = normalize(effort);
  if (normalized === 'max') return DEEPSEEK_V32_EFFORT_BUDGETS.xhigh;
  if (normalized in DEEPSEEK_V32_EFFORT_BUDGETS) {
    return DEEPSEEK_V32_EFFORT_BUDGETS[normalized as keyof typeof DEEPSEEK_V32_EFFORT_BUDGETS];
  }
  return undefined;
}

export function deepSeekV32BudgetToEffort(
  budget: number | undefined | null
): 'low' | 'medium' | 'high' | 'xhigh' {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.low) return 'low';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.high) return 'high';
  return 'xhigh';
}

export function qwenEffortToBudget(effort: string | undefined | null): number {
  const normalized = normalize(effort);
  if (normalized === 'low') return QWEN_EFFORT_BUDGETS.low;
  if (normalized === 'high') return QWEN_EFFORT_BUDGETS.high;
  if (normalized === 'xhigh') return QWEN_EFFORT_BUDGETS.xhigh;
  if (normalized === 'max') return QWEN_EFFORT_BUDGETS.max;
  return QWEN_EFFORT_BUDGETS.medium;
}

export function qwenBudgetToEffort(
  budget: number | undefined | null
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium';
  if (budget <= QWEN_EFFORT_BUDGETS.low) return 'low';
  if (budget <= QWEN_EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= QWEN_EFFORT_BUDGETS.high) return 'high';
  if (budget <= QWEN_EFFORT_BUDGETS.xhigh) return 'xhigh';
  return 'max';
}
