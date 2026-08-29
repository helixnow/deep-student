/**
 * 雷达图维度标签的宽度感知换行/截断。
 *
 * 此前按「6 个字符」硬截断：中文维度名（内容/表达等 2-4 字）没问题，
 * 英文维度名（如 "Organization & Coherence"）会被截成 "Organi…" 不可读。
 * 这里改按视觉宽度单位（CJK ≈ 2、拉丁 ≈ 1）拆成至多两行，
 * 英文优先在空格处断行，仅第二行仍超宽时才截断加省略号。
 */

const CJK_REGEX = /[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 单字符的近似排版宽度单位：CJK 全角 ≈ 2，其余 ≈ 1 */
const charUnits = (ch: string): number => (CJK_REGEX.test(ch) ? 2 : 1);

/** 文本的近似排版宽度单位数 */
export function textUnits(text: string): number {
  return Array.from(text).reduce((sum, ch) => sum + charUnits(ch), 0);
}

/** 按宽度单位截断，超出时在词尾加省略号 */
export function truncateByUnits(text: string, maxUnits: number): string {
  const chars = Array.from(text);
  let units = 0;
  let count = 0;
  for (const ch of chars) {
    units += charUnits(ch);
    if (units > maxUnits) break;
    count += 1;
  }
  if (count >= chars.length) return text;
  return `${chars.slice(0, count).join('').trimEnd()}…`;
}

/** 每行的宽度预算（单位）：约 6 个 CJK 字符或 12 个拉丁字符 */
export const RADAR_LABEL_UNITS_PER_LINE = 12;

/**
 * 把维度名拆成至多两行：
 * - 整体不超预算 → 单行原样返回；
 * - 英文在预算内最后一个空格处断行；中文（无空格）按预算硬断；
 * - 第二行仍超预算时按预算截断加省略号（完整维度名在图表下方的速览列表中可见）。
 */
export function wrapRadarLabel(
  name: string,
  maxUnitsPerLine = RADAR_LABEL_UNITS_PER_LINE
): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [''];
  if (textUnits(trimmed) <= maxUnitsPerLine) return [trimmed];

  const chars = Array.from(trimmed);
  let units = 0;
  let lastSpace = -1;
  let hardBreak = chars.length;
  for (let i = 0; i < chars.length; i += 1) {
    units += charUnits(chars[i]);
    if (units > maxUnitsPerLine) {
      hardBreak = i;
      break;
    }
    if (chars[i] === ' ') lastSpace = i;
  }
  const splitAt = lastSpace > 0 ? lastSpace : hardBreak;
  const line1 = chars.slice(0, splitAt).join('').trimEnd();
  const line2 = chars.slice(splitAt).join('').trimStart();
  if (!line2) return [line1];
  return [line1, truncateByUnits(line2, maxUnitsPerLine)];
}
