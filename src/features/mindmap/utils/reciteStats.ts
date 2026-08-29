/**
 * 背诵闭环：挖空复习统计（历史错误率优先排序，不是 SRS）。
 *
 * 诚实口径：本模块只按 Laplace 平滑错误率做「难点优先」排序，没有 due date、
 * 复习间隔、熟练度状态等调度概念，因此刻意不自称 SRS/间隔重复。
 * `lastReviewedAt` 仅作展示与调试参考，不参与排序。
 *
 * 会话事件模型（避免把「从未看到的空」记成答对）：
 * - 会话 = 进入 → 退出背诵模式一次；退出时把会话事件日志提交进统计。
 * - 只有本会话**实际呈现**（遮盖态渲染进视口并短暂驻留）或**实际作答**
 *   （单独翻开）的空才会进入统计；从未滚到的空不计任何样本。
 * - 「翻开」（revealBlank）= 没背出来 = miss，且是粘性事件：
 *   之后重新遮盖不会抹掉本会话已产生的 miss。
 * - 呈现过、未单独翻开、也未被「显示全部」直接亮出答案的空 = 背出来
 *   （成功样本）。因此零翻开的全对会话同样会被提交。
 * - 「显示全部」是核对动作而非逐空作答：被它亮出的空既不算 miss 也不算
 *   成功（除非此前已单独翻开，miss 保留）。
 *
 * 持久化：localStorage 按导图 id 分键（mindmap-recite-stats:<id>），
 * 读写全程 try/catch，存储不可用时退化为会话内排序。
 */

import type { MindMapNode } from '../types';
import { mergeRanges, validateRanges } from './node/blankRanges';

export interface ReciteBlankStat {
  /** 被检验次数（每次提交的会话中实际作答的空 +1） */
  attempts: number;
  /** 翻开（没背出来）次数 */
  misses: number;
  /** 最近一次提交会话的时间戳（ms）；仅展示/调试，不参与排序 */
  lastReviewedAt?: number;
}

/** nodeId → 挖空区间索引（merge 后） → 统计 */
export type ReciteStats = Record<string, Record<number, ReciteBlankStat>>;

/** 单个空在本会话中的事件记录（全部粘性，只置位不清除） */
export interface ReciteSessionBlankEvents {
  /** 遮盖态实际呈现过（渲染进视口） */
  presented?: boolean;
  /** 被单独翻开过（没背出来；重新遮盖不清除） */
  missed?: boolean;
  /** 经「显示全部」被整体亮出过（核对，不算逐空作答） */
  bulkRevealed?: boolean;
}

/** nodeId → 挖空区间索引（merge 后） → 会话事件 */
export type ReciteSessionLog = Record<string, Record<number, ReciteSessionBlankEvents>>;

export interface ReciteReviewItem {
  nodeId: string;
  /** 节点内所有挖空的最大平滑错误率（难点优先排序键） */
  score: number;
  blankCount: number;
}

/**
 * 存储键：历史上曾叫 mindmap-recite-srs:<id>；旧键数据在旧语义下把未作答的
 * 空记成答对，样本已失真，故改键弃读、不做迁移（功能未发布，无兼容负担）。
 */
const STORAGE_PREFIX = 'mindmap-recite-stats:';

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
 * 提交一次背诵会话：只统计会话日志中实际作答的空——
 * 翻开过 = miss；呈现过且未被「显示全部」亮出 = 背出来（attempts+1）。
 * 日志按当前文档校验（节点已删除 / 区间索引越界的条目直接忽略）。
 * 无任何可提交样本时原样返回入参（引用不变，调用方可据此跳过持久化）。
 */
export function commitReciteSession(
  stats: ReciteStats,
  scopeRoot: MindMapNode,
  session: ReciteSessionLog,
  now: number = Date.now(),
): ReciteStats {
  let changed = false;
  const next: ReciteStats = { ...stats };
  const walk = (node: MindMapNode) => {
    const events = session[node.id];
    if (events) {
      const ranges = normalizedRanges(node);
      let byIndex: Record<number, ReciteBlankStat> | null = null;
      for (let i = 0; i < ranges.length; i++) {
        const blank = events[i];
        if (!blank) continue;
        // 实际作答判定：单独翻开恒为 miss；未翻开的空只有在「呈现过且
        // 没被显示全部直接亮出」时才算一次成功样本。
        const graded = blank.missed === true
          || (blank.presented === true && blank.bulkRevealed !== true);
        if (!graded) continue;
        if (!byIndex) byIndex = { ...next[node.id] };
        const prev = byIndex[i];
        byIndex[i] = {
          attempts: (prev?.attempts ?? 0) + 1,
          misses: (prev?.misses ?? 0) + (blank.missed ? 1 : 0),
          lastReviewedAt: now,
        };
        changed = true;
      }
      if (byIndex) next[node.id] = byIndex;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(scopeRoot);
  return changed ? next : stats;
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
