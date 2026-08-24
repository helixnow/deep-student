/**
 * Generative UI — 流式 JSON 增量解析器
 *
 * 块级提交：仅闭合的 block 对象进入渲染列表，保持 last-good partial。
 */

import { generativeBlockIntentSchema, generativeUIIntentSchema } from './schema';
import type { GenerativeBlockIntent, GenerativeUIIntent } from './types';

const MAX_BUFFER_BYTES = 256 * 1024;

/** 剥 markdown 围栏并定位首个 `{` */
export function sanitizeGenerativeJsonBuffer(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  return start >= 0 ? s.slice(start) : s;
}

/** 从 buffer 中提取 blocks 数组内已闭合的对象 JSON 切片 */
export function extractClosedBlockObjectSlices(buffer: string): string[] {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  const blocksKey = json.indexOf('"blocks"');
  if (blocksKey < 0) return [];
  const arrayStart = json.indexOf('[', blocksKey);
  if (arrayStart < 0) return [];

  const objects: string[] = [];
  let i = arrayStart + 1;

  while (i < json.length) {
    while (i < json.length && /[\s,]/.test(json[i]!)) i += 1;
    if (i >= json.length || json[i] === ']') break;
    if (json[i] !== '{') break;

    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (; i < json.length; i += 1) {
      const c = json[i]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (inString && c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          objects.push(json.slice(start, i + 1));
          i += 1;
          break;
        }
      }
    }
  }

  return objects;
}

function parseMetaFromBuffer(buffer: string): GenerativeUIIntent['meta'] | undefined {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  try {
    const parsed = JSON.parse(json) as { meta?: GenerativeUIIntent['meta'] };
    return parsed.meta;
  } catch {
    const metaMatch = json.match(/"meta"\s*:\s*(\{[\s\S]*?\})(?=,\s*"blocks"|\s*})/);
    if (!metaMatch?.[1]) return undefined;
    try {
      return JSON.parse(metaMatch[1]) as GenerativeUIIntent['meta'];
    } catch {
      return undefined;
    }
  }
}

/** 块级增量解析：返回已闭合 blocks + 可选 meta */
export function tryParsePartialIntent(buffer: string): GenerativeUIIntent | null {
  if (!buffer.trim()) return null;
  if (buffer.length > MAX_BUFFER_BYTES) return null;

  const sanitized = sanitizeGenerativeJsonBuffer(buffer);

  try {
    const parsed = JSON.parse(sanitized);
    const result = generativeUIIntentSchema.safeParse(parsed);
    if (result.success) return result.data as GenerativeUIIntent;
  } catch {
    // fall through to block-level extraction
  }

  const slices = extractClosedBlockObjectSlices(buffer);
  if (slices.length === 0) {
    const candidates = [sanitized, `${sanitized}]}`, `${sanitized}}`, `${sanitized}]}}`];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const result = generativeUIIntentSchema.safeParse(parsed);
        if (result.success) return result.data as GenerativeUIIntent;
      } catch {
        // next
      }
    }
    return null;
  }

  const blocks: GenerativeBlockIntent[] = [];
  for (const slice of slices) {
    try {
      const obj = JSON.parse(slice) as GenerativeBlockIntent;
      const validated = generativeBlockIntentSchema.safeParse(obj);
      if (validated.success) blocks.push(validated.data);
    } catch {
      // skip malformed closed slice
    }
  }

  if (blocks.length === 0) return null;

  return {
    version: '1',
    meta: parseMetaFromBuffer(buffer),
    blocks,
  };
}

export class GenerativeUIStreamParser {
  private buffer = '';
  private lastGood: GenerativeUIIntent | null = null;

  append(chunk: string): GenerativeUIIntent | null {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
    }
    const partial = tryParsePartialIntent(this.buffer);
    if (partial) this.lastGood = partial;
    return partial ?? this.lastGood;
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.lastGood = null;
  }

  finalize(): GenerativeUIIntent | null {
    const final = tryParsePartialIntent(this.buffer);
    if (final) return final;
    return this.lastGood;
  }
}
