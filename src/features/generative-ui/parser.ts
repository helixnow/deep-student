/**
 * Generative UI — 流式 JSON 增量解析器
 *
 * 块级提交：仅闭合的 block 对象进入渲染列表，保持 last-good partial。
 * 增量状态机：committedBlocks 随 extractClosedBlockObjectSlices 增长而追加，
 * 避免每个 chunk 重解析已提交块。
 */

import { generativeBlockIntentSchema, generativeUIIntentSchema } from './schema';
import type { GenerativeBlockIntent, GenerativeUIIntent } from './types';

const MAX_BUFFER_BYTES = 256 * 1024;

export type GenerativeUIStreamPhase = 'idle' | 'streaming' | 'complete' | 'overflow';

export interface GenerativeUIStreamSnapshot {
  phase: GenerativeUIStreamPhase;
  intent: GenerativeUIIntent | null;
  committedBlockCount: number;
  bufferLength: number;
}

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

function tryBracketCloseCandidates(sanitized: string): GenerativeUIIntent | null {
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

function ingestNewBlockSlices(
  slices: string[],
  fromIndex: number,
  committedBlocks: GenerativeBlockIntent[],
): number {
  let parsed = fromIndex;
  for (let i = fromIndex; i < slices.length; i += 1) {
    try {
      const obj = JSON.parse(slices[i]!) as GenerativeBlockIntent;
      const validated = generativeBlockIntentSchema.safeParse(obj);
      if (validated.success) {
        committedBlocks.push(validated.data);
        parsed = i + 1;
      }
    } catch {
      // skip malformed closed slice
    }
  }
  return parsed;
}

/** 块级增量解析：返回已闭合 blocks + 可选 meta（无状态单次调用） */
export function tryParsePartialIntent(buffer: string): GenerativeUIIntent | null {
  if (!buffer.trim()) return null;
  if (buffer.length > MAX_BUFFER_BYTES) return null;

  const parser = new GenerativeUIStreamParser();
  parser.appendChunk(buffer);
  return parser.getSnapshot().intent;
}

export class GenerativeUIStreamParser {
  private buffer = '';
  private lastGood: GenerativeUIIntent | null = null;
  private committedBlocks: GenerativeBlockIntent[] = [];
  private parsedSliceCount = 0;
  private phase: GenerativeUIStreamPhase = 'idle';

  /** 追加 chunk 并返回 snapshot（增量状态机入口） */
  appendChunk(chunk: string): GenerativeUIStreamSnapshot {
    if (chunk) {
      this.buffer += chunk;
      if (this.phase === 'idle') {
        this.phase = 'streaming';
      }
    }

    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
      this.phase = 'overflow';
      this.committedBlocks = [];
      this.parsedSliceCount = 0;
    }

    const partial = this.reconcileIntent();
    if (partial) {
      this.lastGood = partial;
      if (this.phase === 'overflow') {
        this.phase = 'streaming';
      }
    }

    return this.getSnapshot();
  }

  /** @deprecated 使用 appendChunk；保留兼容 */
  append(chunk: string): GenerativeUIIntent | null {
    return this.appendChunk(chunk).intent ?? this.lastGood;
  }

  getSnapshot(): GenerativeUIStreamSnapshot {
    return {
      phase: this.phase,
      intent: this.lastGood,
      committedBlockCount: this.committedBlocks.length,
      bufferLength: this.buffer.length,
    };
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.lastGood = null;
    this.committedBlocks = [];
    this.parsedSliceCount = 0;
    this.phase = 'idle';
  }

  finalize(): GenerativeUIIntent | null {
    this.phase = 'complete';
    const final = this.reconcileIntent(true);
    if (final) return final;
    return this.lastGood;
  }

  private reconcileIntent(finalPass = false): GenerativeUIIntent | null {
    if (!this.buffer.trim()) return null;

    const sanitized = sanitizeGenerativeJsonBuffer(this.buffer);

    try {
      const parsed = JSON.parse(sanitized);
      const result = generativeUIIntentSchema.safeParse(parsed);
      if (result.success) {
        this.committedBlocks = [...result.data.blocks];
        this.parsedSliceCount = result.data.blocks.length;
        return result.data as GenerativeUIIntent;
      }
    } catch {
      // fall through to block-level extraction
    }

    const slices = extractClosedBlockObjectSlices(this.buffer);
    if (slices.length > this.parsedSliceCount) {
      this.parsedSliceCount = ingestNewBlockSlices(
        slices,
        this.parsedSliceCount,
        this.committedBlocks,
      );
    }

    if (this.committedBlocks.length > 0) {
      return {
        version: '1',
        meta: parseMetaFromBuffer(this.buffer),
        blocks: [...this.committedBlocks],
      };
    }

    if (finalPass) {
      return tryBracketCloseCandidates(sanitized);
    }

    return tryBracketCloseCandidates(sanitized);
  }
}
