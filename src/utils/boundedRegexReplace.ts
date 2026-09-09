/**
 * 有预算的正则替换（2026-09-07 审阅 N03）。
 *
 * 背景：AI 编辑的正则分支曾直接 `content.replace(new RegExp(pattern, 'g'), …)`，
 * 绕过普通替换路径的结果大小预算——多次匹配 + 放大的 replacement 可构造出
 * 远超 1 MiB 持久化上限的结果。本实现逐次匹配累加实际 UTF-8 输出字节，
 * 超限提前停止（不先构造大字符串再检查长度），并处理零宽匹配的推进语义
 * （与 String.replace 一致：零宽匹配后前进一个 UTF-16 码元）。
 *
 * 已知边界：单个匹配内部的灾难性回溯无法在同步代码中中断（JS RegExp 无
 * 超时语义）；彻底隔离需要把匹配移入可 terminate 的 Worker，属于后续项。
 * 匹配次数上限用于约束「海量小匹配」形态的 CPU 放大。
 */

export type BoundedRegexReplaceOutcome =
  | { ok: true; content: string; replaceCount: number }
  | {
      ok: false;
      reason: 'invalid_regex' | 'no_match' | 'output_too_large';
      message?: string;
    };

/** 匹配次数上限：与输出预算同族的 CPU 护栏（零宽匹配每位置一次，天然有界）。 */
export const MAX_REGEX_REPLACE_MATCHES = 200_000;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function boundedRegexReplace(
  original: string,
  searchPattern: string,
  replaceWith: string,
  maxOutputBytes: number,
): BoundedRegexReplaceOutcome {
  let regex: RegExp;
  try {
    regex = new RegExp(searchPattern, 'g');
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_regex',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const replaceBytes = utf8ByteLength(replaceWith);
  const parts: string[] = [];
  let lastIndex = 0;
  let replaceCount = 0;
  let outputBytes = 0;

  for (;;) {
    const match = regex.exec(original);
    if (!match) break;

    const literal = original.slice(lastIndex, match.index);
    outputBytes += utf8ByteLength(literal) + replaceBytes;
    if (outputBytes > maxOutputBytes) {
      return { ok: false, reason: 'output_too_large' };
    }
    parts.push(literal, replaceWith);
    replaceCount += 1;
    if (replaceCount > MAX_REGEX_REPLACE_MATCHES) {
      return { ok: false, reason: 'output_too_large' };
    }

    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) {
      // 零宽匹配：前进一个码元，与 String.replace 的 AdvanceStringIndex 一致
      regex.lastIndex = match.index + 1;
    }
  }

  if (replaceCount === 0) {
    return { ok: false, reason: 'no_match' };
  }

  const tail = original.slice(lastIndex);
  outputBytes += utf8ByteLength(tail);
  if (outputBytes > maxOutputBytes) {
    return { ok: false, reason: 'output_too_large' };
  }
  parts.push(tail);

  return { ok: true, content: parts.join(''), replaceCount };
}
