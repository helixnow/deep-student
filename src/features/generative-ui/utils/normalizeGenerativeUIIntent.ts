/**
 * 宿主稳定入口：解析 + 校验 + 丢弃非法块 + 可选升到 v1.1。
 * 复用 recoverGenerativeUIIntent / coercePartialIntent / migrateIntentToV11。
 */

import {
  extractClosedBlockObjectSlices,
  sanitizeGenerativeJsonBuffer,
} from '../parser';
import {
  MAX_GENERATIVE_UI_BLOCKS,
  recoverGenerativeBlocks,
  recoverGenerativeUIIntent,
} from '../schema';
import type { GenerativeBlockIntent, GenerativeUIIntent } from '../types';
import { assignStableBlockIds } from './assignStableBlockIds';
import { coercePartialIntent } from './coercePartialIntent';
import { migrateIntentToV11 } from './migrateIntentToV11';

export interface NormalizeGenerativeUIIntentOptions {
  /** 为 true 时对恢复结果调用 migrateIntentToV11 */
  migrateToV11?: boolean;
  /** 额外块数上限（再钳制到 schema 的 32） */
  maxBlocks?: number;
  /** 为缺失的 block.id 补确定性 id（不改已有非空 id） */
  assignIds?: boolean;
}

export interface NormalizeGenerativeUIIntentResult {
  ok: boolean;
  intent?: GenerativeUIIntent;
  dropped: unknown[];
  warnings: string[];
  /** recover / maxBlocks 是否截断了超出上限的块 */
  truncated: boolean;
}

function resolveMaxBlocks(maxBlocks?: number): number {
  if (typeof maxBlocks !== 'number' || !Number.isFinite(maxBlocks) || maxBlocks < 0) {
    return MAX_GENERATIVE_UI_BLOCKS;
  }
  return Math.min(Math.floor(maxBlocks), MAX_GENERATIVE_UI_BLOCKS);
}

function extractRawBlocks(input: string | object): unknown[] {
  if (typeof input === 'object' && input !== null) {
    const blocks = (input as { blocks?: unknown }).blocks;
    return Array.isArray(blocks) ? blocks : [];
  }

  if (typeof input !== 'string') {
    return [];
  }

  const sanitized = sanitizeGenerativeJsonBuffer(input);
  try {
    const parsed = JSON.parse(sanitized) as { blocks?: unknown };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.blocks)) {
      return parsed.blocks;
    }
  } catch {
    // 半截 JSON：退回已闭合切片
  }

  const raw: unknown[] = [];
  for (const slice of extractClosedBlockObjectSlices(input)) {
    try {
      raw.push(JSON.parse(slice));
    } catch {
      raw.push(slice);
    }
  }
  return raw;
}

/** 对照 recover 保留的块，列出未进入结果的原始项（非法 / 重复 id / 超限） */
function collectDroppedBlocks(
  rawBlocks: unknown[],
  kept: readonly GenerativeBlockIntent[],
): unknown[] {
  const dropped: unknown[] = [];
  let keptIndex = 0;
  for (const raw of rawBlocks) {
    const candidate = recoverGenerativeBlocks([raw]).blocks[0];
    const expected = kept[keptIndex];
    if (
      candidate !== undefined &&
      expected !== undefined &&
      candidate.type === expected.type &&
      candidate.id === expected.id
    ) {
      keptIndex += 1;
      continue;
    }
    dropped.push(raw);
  }
  return dropped;
}

function applyMaxBlocks(
  intent: GenerativeUIIntent,
  maxBlocks: number,
  warnings: string[],
): GenerativeUIIntent {
  if (intent.blocks.length <= maxBlocks) return intent;
  if (!warnings.includes('blocks-truncated')) {
    warnings.push('blocks-truncated');
  }
  return { ...intent, blocks: intent.blocks.slice(0, maxBlocks) };
}

/**
 * 解析字符串或对象意图：丢弃非法块，可选截断与 v1.1 迁移。
 */
export function normalizeGenerativeUIIntent(
  input: string | object,
  options: NormalizeGenerativeUIIntentOptions = {},
): NormalizeGenerativeUIIntentResult {
  if (input == null) {
    return { ok: false, dropped: [], warnings: ['unable-to-recover'], truncated: false };
  }

  let intent: GenerativeUIIntent | null = null;
  let warnings: string[] = [];

  if (typeof input === 'string') {
    const coerced = coercePartialIntent(input);
    intent = coerced.intent;
    warnings = [...coerced.warnings];
  } else if (typeof input === 'object') {
    const recovered = recoverGenerativeUIIntent(input);
    if (recovered) {
      intent = recovered.intent;
      warnings = [...recovered.warnings];
    }
  } else {
    return { ok: false, dropped: [], warnings: ['unable-to-recover'], truncated: false };
  }

  const rawBlocks = extractRawBlocks(input);

  if (!intent) {
    const dropped = collectDroppedBlocks(rawBlocks, []);
    return {
      ok: false,
      dropped,
      warnings: warnings.length > 0 ? warnings : ['unable-to-recover'],
      truncated: warnings.includes('blocks-truncated'),
    };
  }

  intent = applyMaxBlocks(intent, resolveMaxBlocks(options.maxBlocks), warnings);
  const dropped = collectDroppedBlocks(rawBlocks, intent.blocks);

  if (options.migrateToV11) {
    intent = migrateIntentToV11(intent);
  }

  if (options.assignIds) {
    intent = assignStableBlockIds(intent);
  }

  return {
    ok: true,
    intent,
    dropped,
    warnings,
    truncated: warnings.includes('blocks-truncated'),
  };
}
