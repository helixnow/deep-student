/**
 * Generative UI — 流式 JSON 增量解析器
 *
 * 在 SSE/流式输出中尝试从不完整 JSON 提取可渲染 blocks。
 */

import { generativeUIIntentSchema } from './schema';
import type { GenerativeUIIntent } from './types';

/** 从不完整 JSON 字符串中提取最后一个完整 block 数组前缀 */
export function tryParsePartialIntent(buffer: string): GenerativeUIIntent | null {
  const trimmed = buffer.trim();
  if (!trimmed) return null;

  // 完整 JSON 优先
  try {
    const parsed = JSON.parse(trimmed);
    const result = generativeUIIntentSchema.safeParse(parsed);
    if (result.success) return result.data as GenerativeUIIntent;
  } catch {
    // 继续尝试部分解析
  }

  // 启发式：闭合 blocks 数组
  const candidates = [
    trimmed,
    `${trimmed}]}`,
    `${trimmed}}`,
    `${trimmed}]}}`,
  ];

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

export class GenerativeUIStreamParser {
  private buffer = '';

  append(chunk: string): GenerativeUIIntent | null {
    this.buffer += chunk;
    return tryParsePartialIntent(this.buffer);
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
  }

  finalize(): GenerativeUIIntent | null {
    return tryParsePartialIntent(this.buffer);
  }
}
