/**
 * Rust 字符串语义（F4 发布，`dstu-util/src/utils/unicode.rs` / `text.rs`）。
 *
 * 单独成文件是为了让 `model-special-tokens.ts` 复用同一份 trim 实现，
 * 同时避免 `index.ts` ↔ `model-special-tokens.ts` 的循环依赖。
 */

/** Rust `char::is_whitespace`（Unicode White_Space 属性）。 */
export function isRustWhitespace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Rust `str::trim_start`（与 JS `trimStart` 不同：不去 U+FEFF，去 U+0085）。 */
export function rustTrimStart(value: string): string {
  let start = 0;
  while (start < value.length && isRustWhitespace(value.charCodeAt(start))) start++;
  return value.slice(start);
}

/** Rust `str::trim_end`（不去 U+FEFF，去 U+0085）。 */
export function rustTrimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && isRustWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(0, end);
}

/** Rust `str::trim`。 */
export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}

/** 别名：`trim` 的 Rust 语义版本。 */
export const trim = rustTrim;
/** 别名：`trimStart` 的 Rust 语义版本。 */
export const trimStart = rustTrimStart;
/** 别名：`trimEnd` 的 Rust 语义版本。 */
export const trimEnd = rustTrimEnd;

/** Rust `str::chars().count()`（Unicode 标量值个数）。 */
export function charCount(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Rust `s.chars().take(n).collect::<String>()`。 */
export function takeChars(value: string, n: number): string {
  let out = '';
  let i = 0;
  for (const ch of value) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}
