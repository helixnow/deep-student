/** dstu-util/utils/unicode.rs:13–48. */
export function sanitize_unicode(input: string): string {
  const replacements: Record<string, string> = { '／': '/', '＼': '\\', '．': '.', '：': ':', '＊': '*', '？': '?', '＜': '<', '＞': '>', '｜': '|', '＂': '"' };
  return input.replace(/[\u200b-\u200d\ufeff\u00ad\u2060-\u2064\u202a-\u202e\u2066-\u2069]/g, '').replace(/[／＼．：＊？＜＞｜＂]/g, c => replacements[c]!);
}
/** dstu-util/utils/text.rs:10–44: Unicode scalar count, not UTF-16 code units. */
export function safe_truncate_chars(input: string, max_chars: number): string { return [...input].slice(0, max_chars).join(''); }
export function safe_truncate(input: string, max_chars: number): string {
  if (max_chars === 0) return '';
  const chars = [...input];
  return chars.slice(0, max_chars).join('') + (chars.length > max_chars ? '...' : '');
}
export const preview_with_ellipsis = safe_truncate;
