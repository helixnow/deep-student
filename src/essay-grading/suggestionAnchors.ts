/**
 * 采纳批改建议的前后文锚定定位工具。
 *
 * 建议卡片给出的 original 片段可能在正文中出现多次（高频词、重复句式），
 * 仅用全局 indexOf 会替换到错误位置。这里以批改结果中该标记前后的原文
 * 片段作为锚点，在多个候选位置中挑选上下文匹配度最高的一处；
 * 同时支持反向替换（撤销已采纳的修改），包括「撤销删除」这类
 * 目标片段为空、需要按前后文接缝重插原文的场景。
 */

import type { StreamingMarker } from './streamingMarkerParser';

/** 一处可落回原文的修改（由批注详情卡产出，Workbench 消费） */
export interface SuggestionChange {
  /** 原文片段（del 采纳后撤销时为重插内容） */
  original: string;
  /** 替换内容（del 为 ''） */
  replacement: string;
  /** 原文中紧邻 original 之前的一段上下文锚点（可空） */
  before?: string;
  /** 原文中紧邻 original 之后的一段上下文锚点（可空） */
  after?: string;
  /** 建议的稳定标识（轮次内 marker 下标 + 内容），用于「已采纳」状态 */
  key?: string;
}

/** 上下文锚点的参考长度（字符）：够区分重复片段，又不至于因远处小改动失配 */
export const SUGGESTION_CONTEXT_CHARS = 24;

/** 候选位置枚举上限：防御性限制，正常作文不会到达 */
const MAX_OCCURRENCES = 200;

/** text 结尾与 anchor 结尾重合的最长字符数 */
function commonSuffixLength(text: string, anchor: string): number {
  let n = 0;
  while (
    n < text.length &&
    n < anchor.length &&
    text[text.length - 1 - n] === anchor[anchor.length - 1 - n]
  ) {
    n += 1;
  }
  return n;
}

/** text 开头与 anchor 开头重合的最长字符数 */
function commonPrefixLength(text: string, anchor: string): number {
  let n = 0;
  while (n < text.length && n < anchor.length && text[n] === anchor[n]) {
    n += 1;
  }
  return n;
}

function findOccurrences(text: string, target: string): number[] {
  const indices: number[] = [];
  let from = 0;
  while (indices.length < MAX_OCCURRENCES) {
    const idx = text.indexOf(target, from);
    if (idx === -1) break;
    indices.push(idx);
    from = idx + Math.max(1, target.length);
  }
  return indices;
}

/**
 * 目标片段为空（撤销删除时重插原文）时，按 before/after 的接缝定位插入点。
 * 找不到可靠接缝返回 -1。
 */
function findJunctionIndex(text: string, before?: string, after?: string): number {
  const beforeAnchor = (before ?? '').slice(-SUGGESTION_CONTEXT_CHARS);
  const afterAnchor = (after ?? '').slice(0, SUGGESTION_CONTEXT_CHARS);
  if (!beforeAnchor && !afterAnchor) return -1;

  if (beforeAnchor) {
    for (const idx of findOccurrences(text, beforeAnchor)) {
      const junction = idx + beforeAnchor.length;
      // 同时有两侧锚点时必须在同一接缝完整相邻；只命中 before 就插入
      // 会在用户已改动正文后把撤销内容重插到错误的重复片段。
      if (afterAnchor && !text.startsWith(afterAnchor, junction)) continue;
      return junction;
    }
    if (!afterAnchor) return -1;
  }

  if (afterAnchor) {
    const idx = text.indexOf(afterAnchor);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * 在 text 中定位 target 的最佳出现位置（前后文锚定评分，取匹配度最高者）。
 * target 为空串时退化为接缝定位。找不到返回 -1。
 */
export function findAnchoredIndex(
  text: string,
  target: string,
  before?: string,
  after?: string
): number {
  if (!target) return findJunctionIndex(text, before, after);

  const occurrences = findOccurrences(text, target);
  if (occurrences.length === 0) return -1;
  if (occurrences.length === 1 || (!before && !after)) return occurrences[0];

  let best = occurrences[0];
  let bestScore = -1;
  for (const idx of occurrences) {
    const beforeSlice = text.slice(Math.max(0, idx - SUGGESTION_CONTEXT_CHARS), idx);
    const afterSlice = text.slice(
      idx + target.length,
      idx + target.length + SUGGESTION_CONTEXT_CHARS
    );
    const score =
      commonSuffixLength(beforeSlice, before ?? '') +
      commonPrefixLength(afterSlice, after ?? '');
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  // 有锚点却完全不匹配时安全失败，而不是退化为全局第一处。
  // 目标重复的场景中，静默替错位置比提示用户手动处理更危险。
  return bestScore > 0 ? best : -1;
}

export interface AnchoredReplacement {
  /** 替换后的完整文本 */
  text: string;
  /** 替换发生的位置 */
  index: number;
}

/**
 * 锚定替换：把 text 中锚点匹配度最高的一处 target 替换为 replacement。
 * 定位失败（原文已被手动改动）返回 null，由调用方提示用户。
 */
export function applyAnchoredReplacement(
  text: string,
  target: string,
  replacement: string,
  before?: string,
  after?: string
): AnchoredReplacement | null {
  const index = findAnchoredIndex(text, target, before, after);
  if (index < 0) return null;
  return {
    text: text.slice(0, index) + replacement + text.slice(index + target.length),
    index,
  };
}

// ============================================================================
// 从批改结果 marker 流构造带锚点的修改
// ============================================================================

/** marker 在「提交批改的原文」中的贡献（ins 是新增内容、pending 是未完成尾部，均不在原文中） */
export function markerOriginalText(marker: StreamingMarker): string {
  switch (marker.type) {
    case 'ins':
    case 'pending':
      return '';
    case 'replace':
      return marker.oldText ?? '';
    default:
      return marker.content ?? '';
  }
}

/**
 * 由 marker 流构造可采纳的修改（replace / del），并附带：
 * - 前后文锚点：按相邻 marker 的原文贡献重建（必须传未过滤的 markers，
 *   筛选视图会把 ins 内容降级为 text，混入锚点会破坏定位）；
 * - 稳定 key：轮次内 marker 下标 + 内容，用于「已采纳」状态。
 * 不可直接落回原文的 marker 类型返回 null。
 */
export function buildSuggestionChange(
  markers: StreamingMarker[],
  index: number
): SuggestionChange | null {
  const marker = markers[index];
  if (!marker) return null;

  let original: string;
  let replacement: string;
  if (marker.type === 'replace' && marker.oldText && marker.newText) {
    original = marker.oldText;
    replacement = marker.newText;
  } else if (marker.type === 'del' && marker.content) {
    original = marker.content;
    replacement = '';
  } else {
    return null;
  }

  let before = '';
  for (let i = index - 1; i >= 0 && before.length < SUGGESTION_CONTEXT_CHARS; i -= 1) {
    before = markerOriginalText(markers[i]) + before;
  }
  let after = '';
  for (let i = index + 1; i < markers.length && after.length < SUGGESTION_CONTEXT_CHARS; i += 1) {
    after += markerOriginalText(markers[i]);
  }

  return {
    original,
    replacement,
    before: before.slice(-SUGGESTION_CONTEXT_CHARS),
    after: after.slice(0, SUGGESTION_CONTEXT_CHARS),
    key: `${index}:${original}=>${replacement}`,
  };
}
