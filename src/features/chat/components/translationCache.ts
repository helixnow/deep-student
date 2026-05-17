/**
 * 聊天翻译弹窗的 LRU 缓存
 *
 * - 内存缓存，进程生命周期
 * - 翻译模型变更时（监听 `model_assignments_changed` 事件）整体清空
 * - 容量上限 100 条；插入顺序近似 LRU（每次命中重新插入到末尾）
 *
 * 缓存键由 mode + 模型 id + 源/目标语言 + sha256(context + source) 组合而成，
 * 这样上下文不同时，同一段文字也会重新翻译。
 */

import type { AlignedSegment } from './translationTypes';

export type CachedPayload =
  | { mode: 'aligned'; segments: AlignedSegment[] }
  | { mode: 'streaming'; text: string };

const MAX_ENTRIES = 100;
const cache = new Map<string, CachedPayload>();

// SHA-256（hex），用于压缩长文本到稳定 key 片段
async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const enc = new TextEncoder().encode(input);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // fallthrough to djb2
    }
  }
  // 退化：djb2 hash（不防碰撞，但缓存场景下足够）
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export async function buildCacheKey(params: {
  mode: 'aligned' | 'streaming';
  modelId: string;
  srcLang: string;
  tgtLang: string;
  source: string;
  contextBefore: string;
  contextAfter: string;
}): Promise<string> {
  const payload = `${params.contextBefore}\u0001${params.source}\u0001${params.contextAfter}`;
  const digest = await sha256Hex(payload);
  return `${params.mode}|${params.modelId || ''}|${params.srcLang}|${params.tgtLang}|${digest}`;
}

export function readCache(key: string): CachedPayload | null {
  const entry = cache.get(key);
  if (!entry) return null;
  // 命中后重排到末尾（近似 LRU）
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function writeCache(key: string, payload: CachedPayload): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_ENTRIES) {
    // 删除最早一条
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, payload);
}

export function clearCache(): void {
  cache.clear();
}

// 模型分配改动后整体作废（避免给用户看到"上一个模型"的旧译文）
if (typeof window !== 'undefined') {
  window.addEventListener('model_assignments_changed', clearCache);
}
