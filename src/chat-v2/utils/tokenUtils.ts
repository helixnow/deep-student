/**
 * Token 估算工具函数
 *
 * 提供简单的前端 token 数量估算功能
 */

/**
 * 简单的前端 token 估算
 * 使用启发式规则：中文按 ~1.0 字符/token（cl100k/o200k 中大部分常用汉字为单 token），
 * 英文按 ~4 字符/token。
 * 与后端 token_budget.rs 的 estimate_tokens (CJK=1.0) 对齐。
 *
 * @param text - 需要估算的文本内容
 * @returns 估算的 token 数量
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  // 分离中文和非中文字符
  const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const chineseChars = text.match(chineseRegex) || [];
  const nonChineseText = text.replace(chineseRegex, '');

  // 中文：约 1.0 字符/token（cl100k_base/o200k_base 中常用汉字多为单 token）
  const chineseTokens = chineseChars.length;
  // 英文：约 4 字符/token
  const englishTokens = Math.ceil(nonChineseText.length / 4);

  return chineseTokens + englishTokens;
}
