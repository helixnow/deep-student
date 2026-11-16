/**
 * 由一段用户文字派生会话标题——与 Host 的兜底标题规则一致
 * （host/plugins/chat-pipeline/src/summary.ts `fallbackSessionMetadata`）：
 * 空白归一、去掉首尾中英文标点、截前 20 个字符；为空返回 null。
 */
const CJK_PUNCTUATION = '，。！？；：、“”‘’（）【】《》「」『』…—～·';

function isRemovable(char: string): boolean {
  return /[!-/:-@[-`{-~]/.test(char) || CJK_PUNCTUATION.includes(char);
}

export function sessionTitleFromText(text: string | null | undefined): string | null {
  const normalized = (text ?? '').split(/\s+/).filter(Boolean).join(' ');
  const chars = Array.from(normalized);
  let start = 0;
  let end = chars.length;
  while (start < end && isRemovable(chars[start]!)) start++;
  while (end > start && isRemovable(chars[end - 1]!)) end--;
  const cleaned = chars.slice(start, end);
  return cleaned.length > 0 ? cleaned.slice(0, 20).join('') : null;
}
