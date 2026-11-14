/** mod.rs:7734–7749 and model2_pipeline.rs:8616–8624. */
import type { LLMManager, LlmAnkiRouting } from '../api.ts';
import { CommandError } from '../../../platform/errors/api.ts';
import { buildSlots, emptyRoutingSlots, logDebugPlan, planDecision, planRouting } from './anki_model_routing.ts';
import { logDebug } from './logging.ts';

function message(error: unknown): string {
  if (error instanceof CommandError && error.value !== null && typeof error.value === 'object' && 'message' in error.value) return String(error.value.message);
  return error instanceof Error ? error.message : String(error);
}

export function createAnkiRoutingService(llm: LLMManager): LlmAnkiRouting {
  const probe: LlmAnkiRouting['probeAnkiRoutingSlots'] = async () => {
    let assignments;
    try { assignments = await llm.getModelAssignments(); }
    catch (error) { logDebug(`[ANKI_ROUTING] 读取模型分配失败，返回空槽位: ${message(error)}`); return emptyRoutingSlots(); }
    let configs;
    try { configs = await llm.getApiConfigs(); }
    catch (error) { logDebug(`[ANKI_ROUTING] 读取 API 配置失败，返回空槽位: ${message(error)}`); return emptyRoutingSlots(); }
    return buildSlots(assignments, configs);
  };
  return {
    probeAnkiRoutingSlots: probe,
    async resolveAnkiRoleDecision(role, mode) {
      const plan = planRouting(mode, await probe());
      if (plan === null) return null;
      logDebugPlan(plan);
      return structuredClone(planDecision(plan, role));
    },
  };
}
