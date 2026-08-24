/**
 * Chat generative_ui 块 — 按 blockId 维护增量解析状态。
 *
 * React 渲染侧只有累积后的 full content，因此以「长度 delta」驱动
 * GenerativeUIStreamParser，避免每次 render 全量重扫。
 */

import { GenerativeUIStreamParser, type GenerativeUIStreamSnapshot } from '../parser';
import type { GenerativeUIIntent } from '../types';

interface StreamEntry {
  parser: GenerativeUIStreamParser;
  lastLength: number;
}

const entries = new Map<string, StreamEntry>();

function getOrCreateEntry(blockId: string): StreamEntry {
  let entry = entries.get(blockId);
  if (!entry) {
    entry = { parser: new GenerativeUIStreamParser(), lastLength: 0 };
    entries.set(blockId, entry);
  }
  return entry;
}

/** 将 block.content 增量喂入解析器，返回当前 snapshot */
export function appendGenerativeUIStreamContent(
  blockId: string,
  fullContent: string,
): GenerativeUIStreamSnapshot {
  const entry = getOrCreateEntry(blockId);

  if (fullContent.length < entry.lastLength) {
    entry.parser.reset();
    entry.lastLength = 0;
  }

  const delta = fullContent.slice(entry.lastLength);
  entry.lastLength = fullContent.length;

  if (delta) {
    entry.parser.appendChunk(delta);
  }

  return entry.parser.getSnapshot();
}

/** 终态：finalize 并清理 registry */
export function finalizeGenerativeUIStream(blockId: string): GenerativeUIIntent | null {
  const entry = entries.get(blockId);
  if (!entry) return null;
  entries.delete(blockId);
  return entry.parser.finalize();
}

export function resetGenerativeUIStream(blockId: string): void {
  entries.delete(blockId);
}

export function getGenerativeUIStreamSnapshot(blockId: string): GenerativeUIStreamSnapshot | null {
  return entries.get(blockId)?.parser.getSnapshot() ?? null;
}

/** 测试专用 */
export function clearGenerativeUIStreamRegistry(): void {
  entries.clear();
}
