/**
 * 流式 JSON 对象解析器（aligned 翻译模式）
 *
 * 不再假设"一行一个对象"：以字符串感知的花括号配对扫描累积缓冲，
 * 任何完整的顶层 JSON 对象一旦到齐立即切出解析。因此天然兼容：
 * - 标准 NDJSON（一行一个对象）
 * - pretty-printed / 跨多行的 JSON 对象
 * - JSON 数组包裹 [{...},{...}]（数组括号与逗号被当作对象间噪声跳过）
 * - markdown 代码围栏与前置引导文本（对象之外的一切内容忽略）
 * - 字符串值内含 { } " \n 等字符（字符串/转义感知，不会误判边界）
 *
 * 终结语义：
 * - {"done": true} 视为终结标记，不作为段返回；
 * - done 之后即使模型继续输出，也不再产生新段（防尾部垃圾污染）。
 */

import type { AlignedSegment } from './translationTypes';

export interface NdjsonLineResult {
  segments: AlignedSegment[];
  /** 是否已经遇到 {"done": true} 终结标记（跨 push 保持） */
  done: boolean;
}

/**
 * 增量解析器。维护一个 buffer 与扫描游标（跨 push 保留，避免每个
 * chunk 从头重扫），每次塞入新 chunk 后尝试切出所有完整对象。
 *
 * 用法：
 *   const parser = createNdjsonParser();
 *   onChunk: (chunk) => {
 *     const { segments, done } = parser.push(chunk);
 *     // segments：本次新解析出的段（可能为空）
 *     // done：是否已遇到 {"done": true}
 *   }
 *   onComplete: () => parser.flush(); // 清理残缺缓冲（完整对象已即时解析）
 */
export function createNdjsonParser() {
  let buffer = '';
  // 扫描状态跨 push 保留
  let pos = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1; // 当前顶层对象 '{' 在 buffer 中的下标；-1 表示不在对象内
  let sawDone = false;

  function parseObject(text: string): AlignedSegment | 'done' | null {
    try {
      const obj = JSON.parse(text) as { src?: unknown; tgt?: unknown; done?: unknown };
      if (obj && obj.done === true) return 'done';
      if (typeof obj?.src === 'string' && typeof obj?.tgt === 'string') {
        return { src: obj.src, tgt: obj.tgt };
      }
    } catch {
      // 括号配对完整但不是合法 JSON（模型笔误）：忽略，不致命
    }
    return null;
  }

  function consume(): NdjsonLineResult {
    const segments: AlignedSegment[] = [];

    while (pos < buffer.length) {
      const ch = buffer[pos];

      if (objStart === -1) {
        // 对象之外：跳过一切噪声（围栏、引导文本、数组括号、逗号、空白）
        if (ch === '{') {
          objStart = pos;
          depth = 1;
          inString = false;
          escaped = false;
        }
        pos++;
        continue;
      }

      // 对象内部：字符串/转义感知的括号配对
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const objText = buffer.slice(objStart, pos + 1);
          objStart = -1;
          const result = parseObject(objText);
          if (result === 'done') {
            sawDone = true;
          } else if (result && !sawDone) {
            segments.push(result);
          }
        }
      }
      pos++;
    }

    // 压缩缓冲：已完全消费的前缀丢弃，防止长流下内存与重扫增长
    if (objStart === -1) {
      buffer = '';
      pos = 0;
    } else if (objStart > 0) {
      buffer = buffer.slice(objStart);
      pos -= objStart;
      objStart = 0;
    }

    return { segments, done: sawDone };
  }

  return {
    push(chunk: string): NdjsonLineResult {
      buffer += chunk;
      return consume();
    },

    /**
     * 流结束后调用。完整对象在到达时已即时解析，这里仅清理残缺缓冲
     * （未闭合的 '{...' 无法可靠解析，丢弃；调用方应在 0 段时用
     * parseAlignedFallback 对全量累积文本做兜底）。
     */
    flush(): NdjsonLineResult {
      buffer = '';
      pos = 0;
      objStart = -1;
      depth = 0;
      inString = false;
      escaped = false;
      return { segments: [], done: sawDone };
    },
  };
}

/**
 * 解析"完整 buffer"为段数组（用于缓存的非流式回放，或流式解析 0 段时的兜底）。
 *
 * 兜底策略：
 * 1. 先跑一遍对象边界扫描（已覆盖 NDJSON、pretty JSON、顶层数组、围栏包裹）；
 * 2. 再尝试旧格式 {"segments": [...]}（内层对象在 depth>1，第 1 步切不出来）；
 * 3. 都失败返回 null，由调用方决定是否退化为单段整体译文（并向用户明示降级）。
 */
export function parseAlignedFallback(raw: string): AlignedSegment[] | null {
  const parser = createNdjsonParser();
  const { segments } = parser.push(raw);
  if (segments.length > 0) return segments;

  const isValidSegment = (s: unknown): s is AlignedSegment => {
    const seg = s as { src?: unknown; tgt?: unknown } | null;
    return typeof seg?.src === 'string' && typeof seg?.tgt === 'string';
  };

  // 旧版调用 call_llm_for_boundary 时返回的是 {"segments":[...]} 整段
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { segments?: unknown[] };
      if (Array.isArray(obj?.segments)) {
        const valid = obj.segments.filter(isValidSegment);
        if (valid.length > 0) return valid;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}
