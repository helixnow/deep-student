// Rust chatanki_executor.rs:9713–9751 call_vlm_extract: `resolve_anki_role_decision(Vlm, Auto)`, then
// `call_anki_routed_raw_prompt(decision, task, prompt, Some(images))` (model2_pipeline.rs:8632–8672).
// A failed Vlm call retries once on `call_model2_raw_prompt(prompt, Some(images), Anki)`; without a
// decision the routed exit already used model2 with the images, so the request is not repeated.
import type { ChatAnkiVlmExtractor } from '../api.ts';
import type { LlmAnkiRouting, LlmRawPrompt, StandardModel2Output } from '../../llm/api.ts';
import { errorText } from './execution.ts';

export function createChatAnkiVlmExtractor(
  routing: Pick<LlmAnkiRouting, 'resolveAnkiRoleDecision'> | null,
  rawPrompt: Pick<LlmRawPrompt, 'callAnkiRoutedRawPrompt' | 'callModel2RawPrompt'>,
  warn: (message: string) => void,
): ChatAnkiVlmExtractor {
  return {
    callVlmExtract: async (task, prompt, images) => {
      const decision = routing === null ? null : await routing.resolveAnkiRoleDecision('vlm', 'auto');
      const fallbackImages = decision === null ? null : images.map((image) => ({ ...image }));
      let output: StandardModel2Output;
      try {
        output = await rawPrompt.callAnkiRoutedRawPrompt(decision, task, prompt, images.map((image) => ({ ...image })));
      } catch (caught) {
        if (fallbackImages === null) throw caught;
        warn(`[chatanki] Vlm 槽调用失败，回退原 model2 图片提取路径: ${errorText(caught)}`);
        output = await rawPrompt.callModel2RawPrompt(prompt, fallbackImages, 'anki');
      }
      return output.assistant_message;
    },
  };
}
