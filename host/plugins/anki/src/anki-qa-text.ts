/**
 * Anki lint 的共享文本工具（Rust `char` / `str` / `format!` 语义）。
 *
 * 同时被规则实现与指纹归一化使用。
 */

// ============================================================================
// 文本工具
// ============================================================================

/** 剥离 HTML 标签（简单状态机，不解析实体；对 lint 用途足够）。 */
export function stripHtml(s: string): string {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>' && inTag) {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

/** `char::is_alphanumeric`：Unicode Alphabetic ∪ Nd/Nl/No。 */
export const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;

/** 比较用归一化：去 HTML → 小写 → 仅保留字母/数字（含 CJK），丢弃空白与标点。 */
export function normalizeForCompare(s: string): string {
  return [...stripHtml(s)]
    .filter((c) => ALPHANUMERIC.test(c))
    .map((c) => c.toLowerCase())
    .join('');
}

/** `char::is_ascii_digit`。 */
export function isAsciiDigit(charCode: number): boolean {
  return charCode >= 0x30 && charCode <= 0x39;
}

/** `char::is_ascii_alphabetic`。 */
export function isAsciiAlphabetic(charCode: number): boolean {
  return (charCode >= 0x41 && charCode <= 0x5a) || (charCode >= 0x61 && charCode <= 0x7a);
}

/** `char::is_ascii_alphanumeric`。 */
export function isAsciiAlphanumeric(charCode: number): boolean {
  return isAsciiDigit(charCode) || isAsciiAlphabetic(charCode);
}

export function isCjk(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文音节
  );
}

/**
 * Rust `format!("{:.0}", value)` 的等价实现：十进制定点、0 位小数、
 * 恰好 .5 时舍入到偶数（Rust 浮点格式化规则），而非 JS `toFixed` 的远离零舍入。
 */
export function formatFixed0(value: number): string {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction === 0.5) {
    return String(floor % 2 === 0 ? floor : floor + 1);
  }
  return String(Math.round(value));
}

/** 子串出现次数（非重叠，等价于 Rust `str::matches().count()`）。 */
export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

