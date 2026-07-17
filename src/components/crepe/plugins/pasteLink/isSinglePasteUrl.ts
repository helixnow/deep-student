/**
 * 判定剪贴板纯文本是否为「可智能粘贴」的单个 URL。
 *
 * 规则（对齐 Notion）：
 * - trim 后非空、单行（无 \r/\n）
 * - 无空白字符
 * - 以 `http://` / `https://` 或 `www.` 开头（大小写不敏感）
 */

const URL_PREFIX = /^(https?:\/\/|www\.)/i;

/**
 * 若文本是单个可粘贴 URL，返回 trim 后的原文；否则返回 null。
 */
export function isSinglePasteUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/[\r\n]/.test(text)) return null;
  if (/\s/.test(text)) return null;
  if (!URL_PREFIX.test(text)) return null;
  return text;
}

/**
 * 将粘贴 URL 规范为可用的 href。
 * `www.` 前缀补全为 `https://www....`；其余保持原样。
 */
export function normalizePasteHref(url: string): string {
  if (/^www\./i.test(url)) {
    return `https://${url}`;
  }
  return url;
}
