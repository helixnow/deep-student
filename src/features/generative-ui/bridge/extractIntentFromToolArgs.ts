/**
 * 从 render_generative_ui 的流式工具参数（tool_call_preparing chunk 累积的原始 JSON 文本）
 * 中截取 intent 源文本，交给 appendGenerativeUIStreamContent 增量解析（方案第 5 节）。
 *
 * - 只认顶层 "intent" 键（其它字符串 / 嵌套对象里出现的 "intent" 不算）。
 * - 值以 { 或 [ 开头：返回该值的原文切片（闭合则截到闭合处，否则截到末尾）。
 * - 值以 " 开头（模型把 intent 当 JSON 字符串传）：增量解码 JSON 字符串转义，
 *   截到最后一个完整转义（含 \uXXXX），保证后续调用结果是本次结果的前缀扩展。
 * - 还没流到 intent 值 / 值不是对象或字符串：返回 null。
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipWhitespace(src: string, i: number): number {
  while (i < src.length && WHITESPACE.has(src[i])) i += 1;
  return i;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

interface DecodedString {
  value: string;
  /** 闭合引号之后的位置；未闭合为 -1 */
  end: number;
}

/** 解码从 start（指向开引号）起的 JSON 字符串；未闭合时返回已完整解码的前缀 */
function decodeJsonString(src: string, start: number): DecodedString {
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    // 转义序列：不完整则停在反斜杠前
    if (i + 1 >= src.length) break;
    const esc = src[i + 1];
    if (esc === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // 非法转义：按原文保留，避免卡死
        out += src.slice(i, i + 6);
        i += 6;
        continue;
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += SIMPLE_ESCAPES[esc] ?? esc;
    i += 2;
  }
  return { value: out, end: -1 };
}

/** 跳过 start 处的复合值（对象/数组）；返回闭合后的位置，未闭合返回 -1 */
function skipCompound(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const s = decodeJsonString(src, i);
      if (s.end < 0) return -1;
      i = s.end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** 跳过任意 JSON 值；返回值之后的位置，未完整返回 -1 */
function skipValue(src: string, start: number): number {
  const ch = src[start];
  if (ch === undefined) return -1;
  if (ch === '"') return decodeJsonString(src, start).end;
  if (ch === '{' || ch === '[') return skipCompound(src, start);
  let i = start;
  while (i < src.length && src[i] !== ',' && src[i] !== '}' && !WHITESPACE.has(src[i])) i += 1;
  return i < src.length ? i : -1;
}

export function extractIntentFromToolArgs(args: string | null | undefined): string | null {
  if (!args) return null;
  let i = skipWhitespace(args, 0);
  if (args[i] !== '{') return null;
  i += 1;

  while (i < args.length) {
    i = skipWhitespace(args, i);
    if (args[i] === ',') {
      i = skipWhitespace(args, i + 1);
    }
    if (i >= args.length || args[i] === '}') return null;
    if (args[i] !== '"') return null;

    const key = decodeJsonString(args, i);
    if (key.end < 0) return null;
    i = skipWhitespace(args, key.end);
    if (args[i] !== ':') return null;
    i = skipWhitespace(args, i + 1);
    if (i >= args.length) return null;

    if (key.value === 'intent') {
      const first = args[i];
      if (first === '{' || first === '[') {
        const end = skipCompound(args, i);
        return end < 0 ? args.slice(i) : args.slice(i, end);
      }
      if (first === '"') {
        return decodeJsonString(args, i).value;
      }
      return null;
    }

    const next = skipValue(args, i);
    if (next < 0) return null;
    i = next;
  }
  return null;
}
