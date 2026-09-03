/**
 * 领域预设提示词的判定规则（单一事实来源）
 *
 * 核心约束：
 * - 仅用户显式改过提示词才发送 prompt_override / 持久化 customPrompt；
 *   默认/模板文案交由后端按语向/领域参数自行组装（domain_system_prompt），
 *   前端不把默认文案回传成 override 把它覆盖掉。
 * - 切换领域时：提示词仍是默认/模板文案（或为空）则跟随新领域模板，
 *   用户显式修改过则原样保留。
 */

/** 各领域的默认提示词文案 key（无专属模板的领域回落到通用默认） */
export const DOMAIN_DEFAULT_PROMPT_KEYS: Record<string, string> = {
  general: 'translation:prompt_editor.default_prompt',
  academic: 'translation:prompt_panel.template_prompts.academic',
  technical: 'translation:prompt_panel.template_prompts.technical',
  literary: 'translation:prompt_panel.template_prompts.literary',
  casual: 'translation:prompt_panel.template_prompts.conversational',
};

/**
 * 用户是否显式修改过提示词。
 * 空文案或命中任一已知默认/模板文案 → 未修改（不发 override）。
 */
export function isPromptCustomized(
  prompt: string,
  knownDefaultPrompts: ReadonlySet<string>,
): boolean {
  const trimmed = prompt.trim();
  return trimmed !== '' && !knownDefaultPrompts.has(trimmed);
}

/**
 * 切换领域后的提示词文案：
 * 显式修改过 → 保留原文案；否则 → 跟随新领域默认模板。
 */
export function promptAfterDomainSwitch(
  prevPrompt: string,
  nextDomainDefaultPrompt: string,
  knownDefaultPrompts: ReadonlySet<string>,
): string {
  return isPromptCustomized(prevPrompt, knownDefaultPrompts)
    ? prevPrompt
    : nextDomainDefaultPrompt;
}

/**
 * 会话没有独立提示词时，从全局设置恢复编辑器文案。
 *
 * 全局设置可能由旧版本写入某个领域的默认模板；这类文案不是用户覆盖，
 * 应按当前会话领域重新取默认值，避免界面显示学术模板、实际后端却使用
 * 通用领域预设。只有真正自定义的全局提示词才跨会话恢复。
 */
export function promptForSessionLoad(
  savedPrompt: string | null | undefined,
  currentDomainDefaultPrompt: string,
  knownDefaultPrompts: ReadonlySet<string>,
): string {
  return isPromptCustomized(savedPrompt ?? '', knownDefaultPrompts)
    ? savedPrompt!
    : currentDomainDefaultPrompt;
}
