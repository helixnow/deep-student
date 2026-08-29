/**
 * Generative UI — 流式 JSON 增量解析器
 *
 * 块级提交：仅闭合的 block 对象进入渲染列表，保持 last-good partial。
 * 增量状态机：committedBlocks 随 extractClosedBlockObjectSlices 增长而追加，
 * 避免每个 chunk 重解析已提交块。
 */

import {
  generativeLayoutSchema,
  generativeUIIntentSchema,
  recoverGenerativeBlocks,
  recoverGenerativeUIIntent,
  MAX_GENERATIVE_UI_BLOCKS,
} from './schema';
import type { GenerativeBlockIntent, GenerativeLayout, GenerativeUIIntent } from './types';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  guardStreamBufferAppend,
  withStreamBufferCappedWarning,
} from './utils/streamBufferGuard';

export {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
} from './utils/streamBufferGuard';

/** @deprecated 与 MAX_GENERATIVE_UI_STREAM_CHARS 同值；按字符计硬上限 */
export const MAX_BUFFER_BYTES = MAX_GENERATIVE_UI_STREAM_CHARS;

export type GenerativeUIStreamPhase = 'idle' | 'streaming' | 'complete' | 'overflow';

export interface GenerativeUIStreamSnapshot {
  phase: GenerativeUIStreamPhase;
  intent: GenerativeUIIntent | null;
  committedBlockCount: number;
  bufferLength: number;
  warnings: string[];
}

/** 剥 markdown 围栏并定位首个 `{` */
export function sanitizeGenerativeJsonBuffer(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  return start >= 0 ? s.slice(start) : s;
}

/** Locate `"key":` even when an earlier string value equals the key name. */
function indexOfJsonPropertyKey(json: string, key: string): number {
  const token = `"${key}"`;
  let from = 0;
  while (from < json.length) {
    const idx = json.indexOf(token, from);
    if (idx < 0) return -1;
    let i = idx + token.length;
    while (i < json.length && /\s/.test(json[i]!)) i += 1;
    if (json[i] === ':') return idx;
    from = idx + token.length;
  }
  return -1;
}

/** 从 buffer 中提取 blocks 数组内已闭合的对象 JSON 切片 */
export function extractClosedBlockObjectSlices(buffer: string): string[] {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  const blocksKey = indexOfJsonPropertyKey(json, 'blocks');
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

/** 提取 key 后已闭合的 JSON 对象；未闭合返回 null（流式 layout 未写完） */
function extractClosedJsonObjectAfterKey(json: string, key: string): string | null {
  const keyIdx = indexOfJsonPropertyKey(json, key);
  if (keyIdx < 0) return null;
  const colon = json.indexOf(':', keyIdx + key.length + 2);
  if (colon < 0) return null;
  let i = colon + 1;
  while (i < json.length && /\s/.test(json[i]!)) i += 1;
  if (json[i] !== '{') return null;

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
      if (depth === 0) return json.slice(start, i + 1);
    }
  }
  return null;
}

function parseMetaFromBuffer(buffer: string): GenerativeUIIntent['meta'] | undefined {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  try {
    const parsed = JSON.parse(json) as { meta?: GenerativeUIIntent['meta'] };
    return parsed.meta;
  } catch {
    const closed = extractClosedJsonObjectAfterKey(json, 'meta');
    if (!closed) return undefined;
    try {
      return JSON.parse(closed) as GenerativeUIIntent['meta'];
    } catch {
      return undefined;
    }
  }
}

/** 已声明且已闭合的 layout；未闭合则忽略，保留 last-good blocks */
function parseLayoutFromBuffer(buffer: string): GenerativeLayout | undefined {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  try {
    const parsed = JSON.parse(json) as { layout?: unknown };
    if (parsed.layout === undefined) return undefined;
    const result = generativeLayoutSchema.safeParse(parsed.layout);
    return result.success ? result.data : undefined;
  } catch {
    const closed = extractClosedJsonObjectAfterKey(json, 'layout');
    if (!closed) return undefined;
    try {
      const result = generativeLayoutSchema.safeParse(JSON.parse(closed));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * 流式 version：仅识别 '1' | '1.1'；未知或缺失降级为 '1'。
 * 完整文档的未知 version 由 generativeUIIntentSchema 拒绝。
 */
function parseVersionFromBuffer(buffer: string): NonNullable<GenerativeUIIntent['version']> {
  const json = sanitizeGenerativeJsonBuffer(buffer);
  const match = json.match(/"version"\s*:\s*"([^"]*)"/);
  if (match?.[1] === '1.1') return '1.1';
  return '1';
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
  warnings: string[],
): number {
  const seenIds = new Set(
    committedBlocks.map((b) => b.id).filter((id): id is string => Boolean(id)),
  );
  let parsed = fromIndex;
  for (let i = fromIndex; i < slices.length; i += 1) {
    // 块级失败也前进，避免卡在坏切片上丢掉后续好块
    parsed = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(slices[i]!);
    } catch {
      warnings.push('malformed-slice');
      continue;
    }
    const recovered = recoverGenerativeBlocks([obj]);
    if (recovered.dropped > 0 || recovered.blocks.length === 0) {
      warnings.push('invalid-block');
      continue;
    }
    const block = recovered.blocks[0]!;
    if (block.id && seenIds.has(block.id)) {
      warnings.push(`duplicate-id:${block.id}`);
      continue;
    }
    if (committedBlocks.length >= MAX_GENERATIVE_UI_BLOCKS) {
      if (!warnings.includes('blocks-truncated')) {
        warnings.push('blocks-truncated');
      }
      continue;
    }
    if (block.id) seenIds.add(block.id);
    committedBlocks.push(block);
  }
  return parsed;
}

/** 块级增量解析：返回已闭合 blocks + 可选 meta（无状态单次调用） */
export function tryParsePartialIntent(
  buffer: string,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): GenerativeUIIntent | null {
  if (!buffer.trim()) return null;
  if (buffer.length > maxChars) return null;

  const parser = new GenerativeUIStreamParser(maxChars);
  parser.appendChunk(buffer);
  return parser.getSnapshot().intent;
}

export class GenerativeUIStreamParser {
  private buffer = '';
  private lastGood: GenerativeUIIntent | null = null;
  private committedBlocks: GenerativeBlockIntent[] = [];
  private parsedSliceCount = 0;
  private phase: GenerativeUIStreamPhase = 'idle';
  private warnings: string[] = [];
  private bufferCapped = false;
  private readonly maxChars: number;

  constructor(maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS) {
    this.maxChars = maxChars;
  }

  /** 追加 chunk 并返回 snapshot（增量状态机入口） */
  appendChunk(chunk: string): GenerativeUIStreamSnapshot {
    if (this.bufferCapped) {
      return this.getSnapshot();
    }

    const { accepted, capped } = guardStreamBufferAppend(
      this.buffer.length,
      chunk,
      this.maxChars,
    );
    if (capped) {
      this.markBufferCapped();
      return this.getSnapshot();
    }

    if (accepted) {
      this.buffer += accepted;
      if (this.phase === 'idle') {
        this.phase = 'streaming';
      }
    }

    const partial = this.reconcileIntent();
    if (partial) {
      this.lastGood = partial;
    }

    return this.getSnapshot();
  }

  /** @deprecated 使用 appendChunk；保留兼容 */
  append(chunk: string): GenerativeUIIntent | null {
    return this.appendChunk(chunk).intent ?? this.lastGood;
  }

  getSnapshot(): GenerativeUIStreamSnapshot {
    const warnings = this.bufferCapped
      ? withStreamBufferCappedWarning(this.warnings)
      : [...this.warnings];
    return {
      phase: this.phase,
      intent: this.lastGood,
      committedBlockCount: this.committedBlocks.length,
      bufferLength: this.buffer.length,
      warnings,
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
    this.warnings = [];
    this.bufferCapped = false;
  }

  private markBufferCapped(): void {
    this.bufferCapped = true;
    if (this.phase !== 'complete') {
      this.phase = 'overflow';
    }
    if (!this.warnings.includes(STREAM_BUFFER_CAPPED_WARNING)) {
      this.warnings.push(STREAM_BUFFER_CAPPED_WARNING);
    }
  }

  finalize(): GenerativeUIIntent | null {
    this.phase = 'complete';
    const final = this.reconcileIntent(true);
    if (final) return final;
    return this.lastGood;
  }

  private reconcileIntent(_finalPass = false): GenerativeUIIntent | null {
    if (!this.buffer.trim()) return null;

    const sanitized = sanitizeGenerativeJsonBuffer(this.buffer);
    this.warnings = [];

    try {
      const parsed = JSON.parse(sanitized);
      const result = generativeUIIntentSchema.safeParse(parsed);
      if (result.success) {
        const sanitizedBlocks = recoverGenerativeBlocks(result.data.blocks);
        this.committedBlocks = [...sanitizedBlocks.blocks];
        this.parsedSliceCount = result.data.blocks.length;
        this.warnings.push(...sanitizedBlocks.warnings);
        return { ...result.data, blocks: sanitizedBlocks.blocks } as GenerativeUIIntent;
      }
      // 整份 schema 失败：抽出合法块，不丢前面已提交的好块
      const recovered = recoverGenerativeUIIntent(parsed);
      if (recovered && recovered.intent.blocks.length > 0) {
        this.committedBlocks = [...recovered.intent.blocks];
        // 按原始切片数推进，而不是按恢复后的块数；否则非法/重复块会令
        // 下一次 reconcile 从错误下标重放后续无 id 块。
        const rawBlockCount =
          parsed && typeof parsed === 'object' && Array.isArray(parsed.blocks)
            ? parsed.blocks.length
            : recovered.intent.blocks.length;
        this.parsedSliceCount = Math.max(this.parsedSliceCount, rawBlockCount);
        this.warnings.push(...recovered.warnings);
        return recovered.intent as GenerativeUIIntent;
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
        this.warnings,
      );
    }

    if (this.committedBlocks.length > 0) {
      return {
        version: parseVersionFromBuffer(this.buffer),
        layout: parseLayoutFromBuffer(this.buffer),
        meta: parseMetaFromBuffer(this.buffer),
        blocks: [...this.committedBlocks],
      };
    }

    return tryBracketCloseCandidates(sanitized) ?? this.lastGood;
  }
}
