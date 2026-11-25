/**
 * 内置自动化任务（如学习心跳检查）的前端展示本地化工具。
 *
 * 后端 SQLite 中可能存有历史种子写入的中文默认标题（"学习心跳检查"）或默认英文标题；
 * 当用户切换界面语言时，展示层按当前 locale 映射默认内置标题与提示词，同时绝不覆盖
 * 用户自定义改名或改写后的内容。
 */

export const BUILTIN_HEARTBEAT_AUTOMATION_ID = 'auto_heartbeat_default';

const BUILTIN_HEARTBEAT_DEFAULT_NAMES = new Set<string>([
  '学习心跳检查',
  'Study Heartbeat Check',
  'Learning Heartbeat Check',
]);

const DEFAULT_HEARTBEAT_PROMPT_ZH = `你是 Deep Student 的后台心跳检查代理。请依次检查以下清单（只使用可用的只读工具，工具不可用则跳过该项）：
1. 用 builtin-user_todo_get_summary 检查今天到期或已逾期的待办事项；
2. 用 builtin-qbank_list（include_stats=true）留意最近 3 天没有练习记录、或错误率偏高需要复习的题库/错题本；
3. 如需补充上下文，可用 builtin-unified_search 搜索相关学习记录。
输出规则：
- 如果所有检查都没有需要用户关注的事项，只输出 HEARTBEAT_OK，不要输出任何其他内容；
- 如果有需要关注的事项，用简洁中文逐条列出（数量 + 建议动作），且不要出现 HEARTBEAT_OK 字样；
- 不要向用户提问，不要执行任何写操作或高敏感操作。`;

const DEFAULT_HEARTBEAT_PROMPT_EN = `You are Deep Student's background heartbeat check agent. Check each item in order (use only available read-only tools; skip items whose tools are unavailable):
1. Check due today or overdue todos with builtin-user_todo_get_summary;
2. Check question banks/mistake notebooks with no practice in the last 3 days or high error rates with builtin-qbank_list (include_stats=true);
3. Search relevant study records with builtin-unified_search if extra context is needed.
Output rules:
- If nothing needs the user's attention, output only HEARTBEAT_OK with no other content;
- Otherwise, list items concisely in English (count + suggested action) without containing HEARTBEAT_OK;
- Do not ask the user questions, and do not perform any write or sensitive operations.`;

const BUILTIN_HEARTBEAT_DEFAULT_PROMPTS = new Set<string>([
  DEFAULT_HEARTBEAT_PROMPT_ZH,
  DEFAULT_HEARTBEAT_PROMPT_EN,
]);

const HEARTBEAT_NAME_KEY = 'todo:automation.builtin.heartbeatName';
const HEARTBEAT_PROMPT_KEY = 'todo:automation.builtin.heartbeatPrompt';

export type AutomationDisplayTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

function isEnglishLocale(locale?: string): boolean {
  return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('en');
}

export function isBuiltinHeartbeatAutomation(
  automation: { id: string; heartbeat?: boolean },
): boolean {
  return automation.heartbeat === true || automation.id === BUILTIN_HEARTBEAT_AUTOMATION_ID;
}

/**
 * 返回定时任务面向当前 UI 语言的展示名称：
 * 仅对内置心跳任务的默认名称做本地化，保留用户自定义名称。
 */
export function getAutomationDisplayName(
  automation: { id: string; name: string; heartbeat?: boolean },
  t: AutomationDisplayTranslate,
  locale?: string,
): string {
  if (!isBuiltinHeartbeatAutomation(automation)) return automation.name;
  if (!BUILTIN_HEARTBEAT_DEFAULT_NAMES.has(automation.name.trim())) {
    return automation.name;
  }
  const fallback = isEnglishLocale(locale) ? 'Study Heartbeat Check' : '学习心跳检查';
  const translated = t(HEARTBEAT_NAME_KEY, { defaultValue: fallback });
  return translated === HEARTBEAT_NAME_KEY ? fallback : translated;
}

/**
 * 返回内置心跳任务面向当前 UI 语言的默认提示词（未自定义时）。
 */
export function getAutomationDisplayPrompt(
  automation: { id: string; prompt: string; heartbeat?: boolean },
  t: AutomationDisplayTranslate,
  locale?: string,
): string {
  if (!isBuiltinHeartbeatAutomation(automation)) return automation.prompt;
  if (!BUILTIN_HEARTBEAT_DEFAULT_PROMPTS.has(automation.prompt.trim())) {
    return automation.prompt;
  }
  const fallback = isEnglishLocale(locale)
    ? DEFAULT_HEARTBEAT_PROMPT_EN
    : DEFAULT_HEARTBEAT_PROMPT_ZH;
  const translated = t(HEARTBEAT_PROMPT_KEY, { defaultValue: fallback });
  return translated === HEARTBEAT_PROMPT_KEY ? fallback : translated;
}
