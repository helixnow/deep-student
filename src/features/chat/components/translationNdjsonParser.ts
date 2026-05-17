/**
 * NDJSON 流式解析器
 *
 * 处理后端流式翻译输出：每行一个 JSON 对象（aligned 模式），或纯文本（plain 模式）。
 *
 * 健壮性策略（来自对真实 LLM 输出的观察）：
 * - 跳过空行
 * - 跳过 markdown 代码围栏（```json / ```）
 * - 跳过任何前置非 JSON 行（如 "Sure, here is the translation:"）
 * - 容忍尾部换行不规范
 * - {"done": true} 视为终结标记，不作为段返回
 */

import type { AlignedSegment } from './translationTypes';

export interface NdjsonLineResult {
  segments: AlignedSegment[];
  done: boolean;
}

/**
 * 增量 NDJSON 解析器。维护一个 buffer，每次塞入新 chunk 后尝试切出完整行。
 *
 * 用法：
 *   const parser = createNdjsonParser();
 *   onChunk: (chunk) => {
 *     const { segments, done } = parser.push(chunk);
 *     // segments：本次新解析出的段（可能为空）
 *     // done：是否遇到 {"done": true}
 *   }
 *   onComplete: () => parser.flush(); // 可选：处理最后一行（无尾换行）
 */
export function createNdjsonParser() {
  let buffer = '';

  function consumeLines(): NdjsonLineResult {
    const segments: AlignedSegment[] = [];
    let done = false;

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const result = parseLine(line);
      if (result === 'done') {
        done = true;
      } else if (result) {
        segments.push(result);
      }
    }

    return { segments, done };
  }

  function parseLine(rawLine: string): AlignedSegment | 'done' | null {
    const line = rawLine.trim();
    if (!line) return null;

    // 跳过 markdown 围栏与单纯的引导文本
    if (line.startsWith('```')) return null;
    if (!line.startsWith('{')) return null;

    try {
      const obj = JSON.parse(line) as { src?: unknown; tgt?: unknown; done?: unknown };
      if (obj && obj.done === true) return 'done';
      if (typeof obj?.src === 'string' && typeof obj?.tgt === 'string') {
        return { src: obj.src, tgt: obj.tgt };
      }
    } catch {
      // 单行不合法 JSON：可能是 LLM 拼写错（如尾随逗号）；忽略不致命
    }
    return null;
  }

  return {
    push(chunk: string): NdjsonLineResult {
      buffer += chunk;
      return consumeLines();
    },

    /** 流结束后调用：把 buffer 中残留的非换行内容当作最后一行处理 */
    flush(): NdjsonLineResult {
      const tail = buffer;
      buffer = '';
      if (!tail.trim()) return { segments: [], done: false };
      const result = parseLine(tail);
      if (result === 'done') return { segments: [], done: true };
      if (result) return { segments: [result], done: false };
      return { segments: [], done: false };
    },
  };
}

/**
 * 解析"完整 buffer"为段数组（用于缓存的非流式回放，或解析失败时的兜底）。
 *
 * 兜底策略：先尝试当 NDJSON 解析；如果一段都没解出来，再尝试整个 buffer 作为单个 JSON
 *（{"segments": [...]}）解析；都失败则返回 null。
 */
export function parseAlignedFallback(raw: string): AlignedSegment[] | null {
  const parser = createNdjsonParser();
  const { segments } = parser.push(raw + '\n');
  if (segments.length > 0) return segments;

  // 旧版调用 call_llm_for_boundary 时返回的是 {"segments":[...]} 整段
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { segments?: AlignedSegment[] };
      if (Array.isArray(obj?.segments)) {
        return obj.segments.filter(
          (s) => typeof s?.src === 'string' && typeof s?.tgt === 'string'
        );
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
