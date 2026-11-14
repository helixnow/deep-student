/**
 * Rust `dstu-llm/src/llm_manager/parser.rs::enhanced_clean_json_response` and
 * `dstu-memory`'s balanced-brace extractors. Regexes mirror the Rust statics exactly.
 */
import { rustTrim } from '../../../platform/util/portable.ts';

const CODE_FENCE_LINE = /^\s*```[\w-]*\s*$/gim;
const TILDE_FENCE_LINE = /^\s*~~~[\w-]*\s*$/gim;
const BACKTICK_INLINE = /```/gi;
const TILDE_INLINE = /~~~/g;

const PREFIXES = [
  '以下是JSON格式的结果：', 'JSON结果：', '结果：', '答案：', '分析结果：',
  'Here is the JSON:', 'JSON:', 'Result:', 'Output:', 'Analysis:',
  '根据分析，JSON格式结果如下：', 'JSON格式输出：',
];
const SUFFIXES = [
  '以上就是分析结果。', '分析完成。', '希望对您有帮助。',
  "That's the analysis.", 'Analysis complete.',
];

export function enhancedCleanJsonResponse(content: string): string {
  let cleaned = rustTrim(content);
  cleaned = cleaned.replace(CODE_FENCE_LINE, '');
  cleaned = cleaned.replace(TILDE_FENCE_LINE, '');
  cleaned = cleaned.replace(BACKTICK_INLINE, '');
  cleaned = cleaned.replace(TILDE_INLINE, '');
  for (const prefix of PREFIXES) {
    if (cleaned.startsWith(prefix)) cleaned = rustTrim(cleaned.slice(prefix.length));
  }
  for (const suffix of SUFFIXES) {
    if (cleaned.endsWith(suffix)) cleaned = rustTrim(cleaned.slice(0, cleaned.length - suffix.length));
  }
  return cleaned;
}

/**
 * First balanced JSON object. Rust iterates chars with byte offsets; string slicing is identical here
 * because JS strings use code units and both only need the matching braces' positions.
 */
export function extractJsonObject(text: string): string | null {
  let depth = 0;
  let start: number | null = null;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== null) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Rust `MemoryAutoExtractor::extract_json_array`: first balanced `[...]`, strings are not tracked. */
export function extractJsonArray(text: string): string | null {
  let depth = 0;
  let start: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ']' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== null) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Rust `MemoryLLMDecision::extract_first_json_object`: no string-awareness. */
export function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== null) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Rust `MemoryAutoExtractor::truncate_head_tail` (2/3 head, 10-char ellipsis). */
export function truncateHeadTailAutoExtractor(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const headLen = Math.trunc((maxChars * 2) / 3);
  const tailLen = maxChars - headLen - 10;
  return `${chars.slice(0, headLen).join('')}\n...(省略)...\n${chars.slice(chars.length - tailLen).join('')}`;
}

/** Rust `CompactionMemoryFlush::truncate_head_tail` (half head, 12-char ellipsis). */
export function truncateHeadTailFlush(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const headLen = Math.trunc(maxChars / 2);
  const tailLen = maxChars - headLen - 12;
  return `${chars.slice(0, headLen).join('')}\n...(中段省略)...\n${chars.slice(chars.length - tailLen).join('')}`;
}

/** Rust `contains_invisible_unicode`: control characters used for prompt injection. */
export function containsInvisibleUnicode(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069)
      || code === 0xfeff || (code >= 0xe0000 && code <= 0xe007f) || code === 0x00ad) return true;
  }
  return false;
}

const SENSITIVE = new RegExp(
  '(?:' +
    '(?:^|[^0-9])(?:1[3-9][0-9]{9}|[0-9]{15,19}[Xx]?)(?:$|[^0-9A-Za-z])' +
    '|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' +
    '|密码.{0,5}[:：].+' +
    '|password.{0,5}[:=].+' +
    '|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----' +
  ')',
);

/** Rust `MemoryAutoExtractor::contains_sensitive_pattern`. */
export function containsSensitivePattern(text: string): boolean {
  if (containsInvisibleUnicode(text)) return true;
  return SENSITIVE.test(text);
}
