/**
 * Chat generative_ui 块 — 按 blockId 维护增量解析状态。
 *
 * React 渲染侧只有累积后的 full content，因此以「长度 delta」驱动
 * GenerativeUIStreamParser，避免每次 render 全量重扫。
 *
 * 可选 persistKey + 注入 storage：把 lastGoodIntent 落到会话级存储，
 * 刷新后内存 Map 清空仍可恢复。默认不写 sessionStorage。
 */

import { GenerativeUIStreamParser, type GenerativeUIStreamSnapshot } from '../parser';
import type { GenerativeUIIntent } from '../types';
import {
  STREAM_BUFFER_CAPPED_WARNING,
  isStreamBufferOverCap,
  withStreamBufferCappedWarning,
} from '../utils/streamBufferGuard';
import {
  clearPersistedLastGoodIntent,
  readPersistedLastGoodIntent,
  writePersistedLastGoodIntent,
  type GenerativeUIStreamPersistStorage,
} from './generativeUIStreamPersistence';

export interface GenerativeUIStreamPersistOptions {
  /** 非空时启用 lastGoodIntent 读写；缺省关闭 */
  persistKey?: string;
  /** 测试 / 调用方注入；缺省不持久化 */
  storage?: GenerativeUIStreamPersistStorage | null;
  /** 流式字符上限；测试可注入 */
  maxChars?: number;
}

interface StreamEntry {
  parser: GenerativeUIStreamParser;
  lastLength: number;
  lastGoodIntent: GenerativeUIIntent | null;
  persistKey?: string;
  storage?: GenerativeUIStreamPersistStorage | null;
  bufferCapped: boolean;
  maxChars?: number;
}

const entries = new Map<string, StreamEntry>();

function bindPersist(entry: StreamEntry, options?: GenerativeUIStreamPersistOptions): void {
  if (options?.persistKey) entry.persistKey = options.persistKey;
  if (options?.storage) entry.storage = options.storage;
  if (typeof options?.maxChars === 'number') entry.maxChars = options.maxChars;
}

function persistBinding(
  entry: StreamEntry | undefined,
  options?: GenerativeUIStreamPersistOptions,
): { persistKey?: string; storage?: GenerativeUIStreamPersistStorage | null } {
  return {
    persistKey: options?.persistKey ?? entry?.persistKey,
    storage: options?.storage ?? entry?.storage,
  };
}

function hydrateLastGood(entry: StreamEntry): void {
  if (entry.lastGoodIntent || !entry.persistKey || !entry.storage) return;
  const restored = readPersistedLastGoodIntent(entry.persistKey, entry.storage);
  if (restored) entry.lastGoodIntent = restored;
}

function persistLastGood(entry: StreamEntry): void {
  if (!entry.persistKey || !entry.storage) return;
  writePersistedLastGoodIntent(entry.persistKey, entry.lastGoodIntent, entry.storage);
}

function getOrCreateEntry(blockId: string, options?: GenerativeUIStreamPersistOptions): StreamEntry {
  let entry = entries.get(blockId);
  if (!entry) {
    entry = {
      parser: new GenerativeUIStreamParser(options?.maxChars),
      lastLength: 0,
      lastGoodIntent: null,
      bufferCapped: false,
      maxChars: options?.maxChars,
    };
    bindPersist(entry, options);
    hydrateLastGood(entry);
    entries.set(blockId, entry);
    return entry;
  }
  bindPersist(entry, options);
  hydrateLastGood(entry);
  return entry;
}

function rememberLastGood(entry: StreamEntry, snap: GenerativeUIStreamSnapshot): GenerativeUIStreamSnapshot {
  if (snap.intent) {
    entry.lastGoodIntent = snap.intent;
    persistLastGood(entry);
  }
  return applyBufferCap(entry, {
    ...snap,
    intent: snap.intent ?? entry.lastGoodIntent,
  });
}

function applyBufferCap(
  entry: StreamEntry,
  snap: GenerativeUIStreamSnapshot,
): GenerativeUIStreamSnapshot {
  if (!entry.bufferCapped && !snap.warnings.includes(STREAM_BUFFER_CAPPED_WARNING)) {
    return snap;
  }
  entry.bufferCapped = true;
  return {
    ...snap,
    phase: snap.phase === 'complete' ? snap.phase : 'overflow',
    warnings: withStreamBufferCappedWarning(snap.warnings),
  };
}

function restoredSnapshot(intent: GenerativeUIIntent): GenerativeUIStreamSnapshot {
  return {
    phase: 'streaming',
    intent,
    committedBlockCount: intent.blocks.length,
    bufferLength: 0,
    warnings: ['restored-last-good'],
  };
}

/** 将 block.content 增量喂入解析器，返回当前 snapshot */
export function appendGenerativeUIStreamContent(
  blockId: string,
  fullContent: string,
  options?: GenerativeUIStreamPersistOptions,
): GenerativeUIStreamSnapshot {
  const entry = getOrCreateEntry(blockId, options);
  const parserBuffer = entry.parser.getBuffer();
  const contentWasReplaced =
    entry.lastLength > 0 &&
    parserBuffer.length === entry.lastLength &&
    !fullContent.startsWith(parserBuffer);

  if (fullContent.length < entry.lastLength || contentWasReplaced) {
    entry.parser.reset();
    entry.lastLength = 0;
    entry.lastGoodIntent = null;
    entry.bufferCapped = false;
    clearPersistedLastGoodIntent(entry.persistKey, entry.storage);
  }

  if (
    entry.bufferCapped ||
    isStreamBufferOverCap(fullContent.length, options?.maxChars ?? entry.maxChars)
  ) {
    entry.bufferCapped = true;
    entry.lastLength = fullContent.length;
    return rememberLastGood(entry, entry.parser.getSnapshot());
  }

  const delta = fullContent.slice(entry.lastLength);
  entry.lastLength = fullContent.length;

  if (delta) {
    const snap = entry.parser.appendChunk(delta);
    if (snap.warnings.includes(STREAM_BUFFER_CAPPED_WARNING)) {
      entry.bufferCapped = true;
    }
  }

  return rememberLastGood(entry, entry.parser.getSnapshot());
}

/** 终态：finalize；最终 JSON 失败时回退 lastGoodIntent */
export function finalizeGenerativeUIStream(
  blockId: string,
  options?: GenerativeUIStreamPersistOptions,
): GenerativeUIIntent | null {
  const entry = entries.get(blockId);
  if (!entry) {
    return readPersistedLastGoodIntent(options?.persistKey, options?.storage);
  }
  bindPersist(entry, options);
  hydrateLastGood(entry);
  const { persistKey, storage } = persistBinding(entry, options);
  const lastGood = entry.lastGoodIntent;
  entries.delete(blockId);
  const final = entry.parser.finalize();
  const result = final ?? lastGood;
  if (persistKey && storage) {
    writePersistedLastGoodIntent(persistKey, result, storage);
  }
  return result;
}

export function resetGenerativeUIStream(
  blockId: string,
  options?: GenerativeUIStreamPersistOptions,
): void {
  const entry = entries.get(blockId);
  const { persistKey, storage } = persistBinding(entry, options);
  entries.delete(blockId);
  clearPersistedLastGoodIntent(persistKey, storage);
}

export function getGenerativeUIStreamSnapshot(
  blockId: string,
  options?: GenerativeUIStreamPersistOptions,
): GenerativeUIStreamSnapshot | null {
  const entry = entries.get(blockId);
  if (entry) {
    bindPersist(entry, options);
    hydrateLastGood(entry);
    return rememberLastGood(entry, entry.parser.getSnapshot());
  }
  const restored = readPersistedLastGoodIntent(options?.persistKey, options?.storage);
  return restored ? restoredSnapshot(restored) : null;
}

export function getLastGoodGenerativeUIIntent(
  blockId: string,
  options?: GenerativeUIStreamPersistOptions,
): GenerativeUIIntent | null {
  const entry = entries.get(blockId);
  if (entry) {
    bindPersist(entry, options);
    if (entry.lastGoodIntent) return entry.lastGoodIntent;
    hydrateLastGood(entry);
    return entry.lastGoodIntent;
  }
  return readPersistedLastGoodIntent(options?.persistKey, options?.storage);
}

/** 测试专用：只清内存，不碰注入 storage（便于模拟刷新） */
export function clearGenerativeUIStreamRegistry(): void {
  entries.clear();
}
