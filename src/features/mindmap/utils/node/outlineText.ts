/**
 * 导图节点 → 大纲文本序列化（P0 选区即上下文用）。
 *
 * 把选中节点及其子树序列化为缩进大纲，作为选区快照的 text 载荷。
 * 截断策略（对应设计文档风险 1）：深度 / 节点数 / 字符数三重上限，
 * 超限追加「已截断」标记；发送侧另有 token 预算截断兜底。
 */

import type { MindMapNode } from '../../types';

export interface OutlineSerializeOptions {
  /** 最大相对深度（含根层），默认 6 */
  maxDepth?: number;
  /** 最大节点数，默认 100 */
  maxNodes?: number;
  /** 最大字符数，默认 4000 */
  maxChars?: number;
  /** 节点备注的最大保留字符，默认 100；0 表示不带备注 */
  maxNoteChars?: number;
}

const DEFAULTS = {
  maxDepth: 6,
  maxNodes: 100,
  maxChars: 4000,
  maxNoteChars: 100,
} as const;

interface SerializeState {
  lines: string[];
  visited: number;
  truncated: boolean;
  totalChars: number;
  maxChars: number;
}

function visit(node: MindMapNode, depth: number, opts: Required<OutlineSerializeOptions>, state: SerializeState): void {
  if (state.truncated) return;
  if (depth > opts.maxDepth || state.visited >= opts.maxNodes) {
    state.truncated = true;
    return;
  }

  const indent = '  '.repeat(depth - 1);
  const note = opts.maxNoteChars > 0 && node.note
    ? `（备注：${node.note.length > opts.maxNoteChars ? `${node.note.slice(0, opts.maxNoteChars)}…` : node.note}）`
    : '';
  const line = `${indent}- ${node.text}${note}`;

  // 字符超限：本节点不产出行，visited 不计数（保持 visited == 已输出行数，
  // 截断后缀的"尚有 N 个节点"才准确）
  if (state.totalChars + line.length > opts.maxChars) {
    state.truncated = true;
    return;
  }
  state.visited += 1;
  state.lines.push(line);
  state.totalChars += line.length;

  for (const child of node.children ?? []) {
    visit(child, depth + 1, opts, state);
    if (state.truncated) return;
  }
}

/**
 * 序列化若干节点（各自带子树）为大纲文本。
 * 发生截断时末尾追加 `…（已截断，尚有 N 个节点）` 标记（设计文档风险 1：
 * 截断需带计数，让模型/用户知晓子树规模）。
 */
export function serializeNodesToOutlineText(
  nodes: MindMapNode[],
  options?: OutlineSerializeOptions,
): string {
  const opts: Required<OutlineSerializeOptions> = { ...DEFAULTS, ...options };
  const state: SerializeState = { lines: [], visited: 0, truncated: false, totalChars: 0, maxChars: opts.maxChars };

  for (const node of nodes) {
    visit(node, 1, opts, state);
    if (state.truncated) break;
  }

  const body = state.lines.join('\n');
  if (!state.truncated) return body;
  const remaining = countNodes(nodes) - state.visited;
  return remaining > 0
    ? `${body}\n- …（已截断，尚有 ${remaining} 个节点）`
    : `${body}\n- …（已截断）`;
}

/** 统计子树节点总数（含各根节点本身） */
function countNodes(nodes: MindMapNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    if (node.children) stack.push(...node.children);
  }
  return count;
}
