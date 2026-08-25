/**
 * 背诵闭环：挖空复习统计（会话级 SRS）。
 *
 * 语义约定（与 UI 交互一致）：
 * - 背诵会话 = 进入 → 退出背诵模式一次；退出时提交本会话统计。
 * - 「翻开」（revealBlank）= 没背出来 = 一次 miss；
 *   会话内保持遮盖的空视为背出来（attempts+1，misses 不变）。
 * - 整个会话零翻开视为「没有实际背诵」，不提交（避免反复开关稀释错误率）。
 *
 * 排序：Laplace 平滑错误率 (misses+1)/(attempts+2)，
 * 从未复习的空基线 0.5——高频翻开 > 未复习 > 稳定记住，符合难点优先直觉。
 *
 * 持久化：localStorage 按导图 id 分键（mindmap-recite-srs:<id>），
 * 读写全程 try/catch，存储不可用时退化为会话内排序。
 */

import type { MindMapNode } from '../types';
import { mergeRanges, validateRanges } from './node/blankRanges';

export interface ReciteBlankStat {
  /** 被检验次数（每次提交的会话 +1） */
  attempts: number;
  /** 翻开（没背出来）次数 */
  misses: number;
  /** 最近一次提交会话的时间戳（ms） */
  lastReviewedAt?: number;
}

/** nodeId → 挖空区间索引（merge 后） → 统计 */
export type ReciteStats = Record<string, Record<number, ReciteBlankStat>>;

export interface ReciteReviewItem {
  nodeId: string;
  /** 节点内所有挖空的最大平滑错误率（难点优先排序键） */
  score: number;
  blankCount: number;
}

const STORAGE_PREFIX = 'mindmap-recite-srs:';

/** Laplace 平滑错误率；未复习过的空为 0.5 基线 */
export function smoothedErrorRate(stat?: ReciteBlankStat): number {
  const attempts = stat?.attempts ?? 0;
  const misses = stat?.misses ?? 0;
  return (misses + 1) / (attempts + 2);
}

export function loadReciteStats(mindmapId: string): ReciteStats {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + mindmapId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ReciteStats) : {};
  } catch {
    return {};
  }
}

export function saveReciteStats(mindmapId: string, stats: ReciteStats): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + mindmapId, JSON.stringify(stats));
  } catch {
    // 存储满 / 不可用：静默退化为会话内排序
  }
}

/** 与 store 的 revealBlank 索引语义一致：merge+validate 后的区间列表 */
function normalizedRanges(node: MindMapNode) {
  if (!node.blankedRanges?.length || node.text.length === 0) return [];
  return mergeRanges(validateRanges(node.blankedRanges, node.text.length));
}

/**
 * 提交一次背诵会话：范围内每个挖空 attempts+1，被翻开的额外 misses+1。
 * 整个会话没有任何翻开（revealed 为空）时原样返回（视为未实际背诵）。
 * 返回新的 stats 对象（不修改入参）。
 */
export function commitReciteSession(
  stats: ReciteStats,
  scopeRoot: MindMapNode,
  revealed: Record<string, Record<number, boolean>>,
  now: number = Date.now(),
): ReciteStats {
  const revealedAny = Object.values(revealed).some(
    (byIndex) => Object.values(byIndex).some(Boolean),
  );
  if (!revealedAny) return stats;

  const next: ReciteStats = { ...stats };
  const walk = (node: MindMapNode) => {
    const ranges = normalizedRanges(node);
    if (ranges.length > 0) {
      const byIndex: Record<number, ReciteBlankStat> = { ...next[node.id] };
      for (let i = 0; i < ranges.length; i++) {
        const prev = byIndex[i];
        byIndex[i] = {
          attempts: (prev?.attempts ?? 0) + 1,
          misses: (prev?.misses ?? 0) + (revealed[node.id]?.[i] ? 1 : 0),
          lastReviewedAt: now,
        };
      }
      next[node.id] = byIndex;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(scopeRoot);
  return next;
}

/**
 * 构建难点优先复习队列：范围内所有带挖空的节点，
 * 按节点内挖空的最大平滑错误率降序；同分保持文档序（DFS 先序）。
 */
export function buildReviewQueue(
  scopeRoot: MindMapNode,
  stats: ReciteStats,
): ReciteReviewItem[] {
  const items: ReciteReviewItem[] = [];
  const walk = (node: MindMapNode) => {
    const ranges = normalizedRanges(node);
    if (ranges.length > 0) {
      let score = 0;
      for (let i = 0; i < ranges.length; i++) {
        score = Math.max(score, smoothedErrorRate(stats[node.id]?.[i]));
      }
      items.push({ nodeId: node.id, score, blankCount: ranges.length });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(scopeRoot);
  // Array.prototype.sort 稳定：同分节点保持 DFS 文档序
  return items.sort((a, b) => b.score - a.score);
}
