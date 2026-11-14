// Rust chatanki_executor.rs:9647–9690 plan_route model selection:
// `resolve_anki_role_decision(Planner, Auto)`, then `call_anki_routed_raw_prompt`
// (model2_pipeline.rs:8632–8672). A failed Planner call retries once on
// `call_model2_raw_prompt(prompt, None, Anki)`; without a decision the routed
// exit already used model2, so the request is not repeated.
import type { ChatAnkiRoutePlanner } from '../api.ts';
import type { LlmAnkiRouting, LlmRawPrompt, StandardModel2Output } from '../../llm/api.ts';
import { errorText } from './execution.ts';

export function createChatAnkiRoutePlanner(
  routing: Pick<LlmAnkiRouting, 'resolveAnkiRoleDecision'> | null,
  rawPrompt: Pick<LlmRawPrompt, 'callAnkiRoutedRawPrompt' | 'callModel2RawPrompt'>,
  warn: (message: string) => void,
): ChatAnkiRoutePlanner {
  return {
    callAnkiRoutedRawPrompt: async (task, prompt) => {
      const decision = routing === null ? null : await routing.resolveAnkiRoleDecision('planner', 'auto');
      let output: StandardModel2Output;
      try {
        output = await rawPrompt.callAnkiRoutedRawPrompt(decision, task, prompt, null);
      } catch (caught) {
        if (decision === null) throw caught;
        warn(`[chatanki] Planner 槽调用失败，回退原 model2 路径: ${errorText(caught)}`);
        output = await rawPrompt.callModel2RawPrompt(prompt, null, 'anki');
      }
      return output.assistant_message;
    },
  };
}
