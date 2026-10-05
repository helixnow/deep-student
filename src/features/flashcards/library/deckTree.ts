/**
 * 牌组树：后端按牌组全名（`学科::主题`）给平铺计数，这里按 `::` 拼成层级，
 * 父牌组计数 = 自身 + 全部子牌组（与后端牌组筛选「含子牌组」同口径）。
 */
import type { AnkiLibraryDeckCount } from '@/types';

export const DECK_SEPARATOR = '::';

export interface DeckTreeNode {
  /** 牌组全名，直接作为筛选值；'' = 未分组 */
  path: string;
  /** 本级名称（未分组为 ''，由界面给文案） */
  label: string;
  depth: number;
  all: number;
  due: number;
  new: number;
  notEnqueued: number;
  children: DeckTreeNode[];
}

function emptyNode(path: string, label: string, depth: number): DeckTreeNode {
  return { path, label, depth, all: 0, due: 0, new: 0, notEnqueued: 0, children: [] };
}

function addCounts(node: DeckTreeNode, deck: AnkiLibraryDeckCount): void {
  node.all += deck.all;
  node.due += deck.due;
  node.new += deck.new;
  node.notEnqueued += deck.notEnqueued;
}

const collator = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });

function sortNodes(nodes: DeckTreeNode[]): void {
  nodes.sort((a, b) => collator.compare(a.label, b.label));
  for (const node of nodes) sortNodes(node.children);
}

export function buildDeckTree(decks: readonly AnkiLibraryDeckCount[]): DeckTreeNode[] {
  const roots: DeckTreeNode[] = [];
  const byPath = new Map<string, DeckTreeNode>();
  let ungrouped: DeckTreeNode | null = null;

  for (const deck of decks) {
    // 路径保持后端原样（筛选按字符串前缀比对），只在显示名上去空白
    const name = deck.name.trim();
    if (!name) {
      ungrouped ??= emptyNode('', '', 0);
      addCounts(ungrouped, deck);
      continue;
    }
    const segments = name.split(DECK_SEPARATOR);
    let siblings = roots;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth + 1).join(DECK_SEPARATOR);
      let node = byPath.get(path);
      if (!node) {
        node = emptyNode(path, segments[depth].trim() || path, depth);
        byPath.set(path, node);
        siblings.push(node);
      }
      addCounts(node, deck);
      siblings = node.children;
    }
  }

  sortNodes(roots);
  if (ungrouped) roots.push(ungrouped);
  return roots;
}

/** 深度优先展开（下拉选项等需要平铺的场景） */
export function flattenDeckTree(nodes: readonly DeckTreeNode[]): DeckTreeNode[] {
  const out: DeckTreeNode[] = [];
  const walk = (list: readonly DeckTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
