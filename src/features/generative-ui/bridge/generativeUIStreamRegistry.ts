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
  lastGoodIntent: GenerativeUIIntent | null;
}

const entries = new Map<string, StreamEntry>();

function getOrCreateEntry(blockId: string): StreamEntry {
  let entry = entries.get(blockId);
  if (!entry) {
    entry = { parser: new GenerativeUIStreamParser(), lastLength: 0, lastGoodIntent: null };
    entries.set(blockId, entry);
  }
  return entry;
}

function rememberLastGood(entry: StreamEntry, snap: GenerativeUIStreamSnapshot): GenerativeUIStreamSnapshot {
  if (snap.intent) {
    entry.lastGoodIntent = snap.intent;
  }
  return {
    ...snap,
    intent: snap.intent ?? entry.lastGoodIntent,
  };
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
    entry.lastGoodIntent = null;
  }

  const delta = fullContent.slice(entry.lastLength);
  entry.lastLength = fullContent.length;

  if (delta) {
    entry.parser.appendChunk(delta);
  }

  return rememberLastGood(entry, entry.parser.getSnapshot());
}

/** 终态：finalize；最终 JSON 失败时回退 lastGoodIntent */
export function finalizeGenerativeUIStream(blockId: string): GenerativeUIIntent | null {
  const entry = entries.get(blockId);
  if (!entry) return null;
  const lastGood = entry.lastGoodIntent;
  entries.delete(blockId);
  const final = entry.parser.finalize();
  return final ?? lastGood;
}

export function resetGenerativeUIStream(blockId: string): void {
  entries.delete(blockId);
}

export function getGenerativeUIStreamSnapshot(blockId: string): GenerativeUIStreamSnapshot | null {
  const entry = entries.get(blockId);
  if (!entry) return null;
  return rememberLastGood(entry, entry.parser.getSnapshot());
}

export function getLastGoodGenerativeUIIntent(blockId: string): GenerativeUIIntent | null {
  return entries.get(blockId)?.lastGoodIntent ?? null;
}

/** 测试专用 */
export function clearGenerativeUIStreamRegistry(): void {
  entries.clear();
}
