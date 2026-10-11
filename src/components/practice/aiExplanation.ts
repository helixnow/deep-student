/**
 * AI 解析 → 题目「解析」字段的落地规则（#467）
 *
 * AI 解析（questions.ai_feedback）与题目自带解析（questions.explanation）是两条轨：
 * - 原解析为空：通用解析由后端直接回填（见 qbank_grading 的 fill_explanation_if_empty）；
 * - 原解析非空：绝不静默覆盖，只提供显式的「写入解析」动作，且需二次确认替换。
 */

/** 评判模式反馈末尾的结构化标签，写入解析前去掉 */
const GRADING_TAG_PATTERN = /<verdict>\s*(?:correct|partial|incorrect)\s*<\/verdict>|<score\s+value="\d+"\s*\/>/gi;

/** 把 AI 反馈转成可作为题目解析保存的正文 */
export function toExplanationText(aiText: string | null | undefined): string {
  return (aiText ?? '').replace(GRADING_TAG_PATTERN, '').trim();
}

/**
 * 「写入解析」动作的形态：
 * - none：没有可写的 AI 文本，或与现有解析相同
 * - write：现有解析为空，直接写入
 * - replace：现有解析非空，需确认后替换
 */
export type AiExplanationWriteAction = 'none' | 'write' | 'replace';

export function resolveAiExplanationWrite(
  explanation: string | null | undefined,
  aiText: string | null | undefined,
): AiExplanationWriteAction {
  const next = toExplanationText(aiText);
  if (!next) return 'none';
  const current = (explanation ?? '').trim();
  if (!current) return 'write';
  return current === next ? 'none' : 'replace';
}
