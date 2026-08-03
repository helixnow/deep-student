/**
 * API Key 最小合理性校验（审阅 26-settings-vendor-frontend P1-2）
 *
 * 用于"自动保存"（防抖 / 失焦）路径的守门：避免用户手动输入到一半的
 * Key 被持久化，并随后被 autoPostSaveFlow 携带着向供应商 /models 端点
 * 发起真实请求（半截密钥进入对方服务器日志、反复 401 可能触发风控）。
 *
 * 仅做启发式判断，不校验 Key 真伪：
 * - 长度 >= 16（主流供应商 Key 均 >= 32 字符，16 已足够保守）；
 * - 不含空白字符（换行/空格通常意味着粘贴出错或输入未完成）；
 * - 不是掩码占位（*** 或全星号）。
 *
 * 显式保存（点击保存按钮 / Cmd+S）不经过此校验，短 Key 用户仍可手动保存。
 */
export const MIN_AUTO_SAVE_KEY_LENGTH = 16;

/**
 * Removes clipboard artifacts that cannot be meaningful parts of an API key.
 * Do not guess at prefixes such as `Bearer` or prose copied from a provider
 * console: credentials should only be changed by an explicit user action.
 */
export function normalizePastedApiKey(value: string): string {
  return value
    .replace(/^\uFEFF/u, '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();
}

export function isPlausibleApiKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_AUTO_SAVE_KEY_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.split('').every(c => c === '*')) return false;
  return true;
}
