/** 运行时推理覆盖（model2_pipeline.rs apply_runtime_reasoning_overrides）。 */
import type { ApiConfig } from '../api.ts';
import { resolveQuirks } from './provider_quirks.ts';

/**
 * 运行时关闭优先于配置与过期 UI 深度：强制推理模型保持开启；
 * 其余 OpenAI 协议模型把 effort 收敛为 `none` 并清空 budget。
 */
export function applyRuntimeReasoningOverrides(
  config: ApiConfig,
  enableThinkingOverride: boolean | null | undefined,
  reasoningEffortOverride: string | null | undefined,
  thinkingBudgetOverride: number | null | undefined,
): void {
  if (enableThinkingOverride === false) {
    const policy = resolveQuirks(config).runtime_reasoning;
    if (policy.force_enabled) {
      config.enableThinking = true;
      return;
    }
    config.enableThinking = false;
    config.reasoningEffort = policy.disabled_effort;
    config.thinkingBudget = null;
    return;
  }
  if (enableThinkingOverride !== null && enableThinkingOverride !== undefined) {
    config.enableThinking = enableThinkingOverride;
  }
  if (reasoningEffortOverride !== null && reasoningEffortOverride !== undefined) {
    config.reasoningEffort = reasoningEffortOverride;
  }
  if (thinkingBudgetOverride !== null && thinkingBudgetOverride !== undefined) {
    config.thinkingBudget = thinkingBudgetOverride;
  }
}
