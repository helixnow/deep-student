/**
 * 导图节点定位：把「引用里的节点提示 / 检索命中片段」解析为具体节点 ID。
 *
 * 学习闭环（知识库 / 聊天 → 回到来源）：
 * - 聊天引用 `[思维导图:mm_xxx#节点文字:标题]` 的 `#` 段可以是节点 ID 或节点文字
 * - 知识库检索命中导图时只有 chunk 文本（MindmapBuilder 产出的缩进大纲，含备注行），
 *   需要按行匹配回节点
 *
 * 纯函数，无 store / DOM 依赖；找不到时返回 null（调用方只打开导图，不定位）。
 */
import type { MindMapNode } from '../types';

export type MindmapNodeTargetMatch = 'id' | 'exact' | 'normalized' | 'fuzzy' | 'chunk';

export interface MindmapNodeTargetHint {
  /** 明确的节点 ID（如 selection 引用的 `node:<id>` locator） */
  nodeId?: string;
  /** 节点提示：引用 `#` 段——可能是节点 ID，也可能是节点文字 */
  text?: string;
  /** 检索命中片段（缩进大纲文本） */
  chunkText?: string;
}

export interface MindmapNodeTargetResult {
  nodeId: string;
  matchedBy: MindmapNodeTargetMatch;
}

interface IndexedNode {
  node: MindMapNode;
  parentId: string | null;
  depth: number;
  order: number;
  norm: string;
}

/**
 * store.nodeLocateRequest 的有效期：画布/大纲挂载时只消费这段时间内发出的请求，
 * 避免切换视图重挂载时重放陈旧的定位。
 */
export const NODE_LOCATE_REQUEST_TTL_MS = 5_000;

/** 模糊匹配最低相似度（字符二元组 Dice 系数） */
const FUZZY_MIN_SIMILARITY = 0.5;
/** 包含匹配时较短一方的最小长度，避免「的」「A」这类过短提示乱命中 */
const CONTAINS_MIN_LENGTH = 2;

/**
 * 归一化节点文字：NFKC（全半角）、小写、去 markdown 记号/标点、折叠空白。
 */
export function normalizeMindmapNodeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    // markdown 强调 / 行内代码 / 链接括号 / 列表符 / LaTeX 定界符
    .replace(/[*_`~#>$\\[\]()]/g, ' ')
    // 常见中英文标点
    .replace(/[,.;:!?，。；：！？、"'“”‘’《》「」『』【】…·\-–—/|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexTree(root: MindMapNode): IndexedNode[] {
  const out: IndexedNode[] = [];
  const stack: Array<{ node: MindMapNode; parentId: string | null; depth: number }> = [
    { node: root, parentId: null, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, parentId, depth } = stack.pop()!;
    out.push({
      node,
      parentId,
      depth,
      order: out.length,
      norm: normalizeMindmapNodeText(node.text ?? ''),
    });
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], parentId: node.id, depth: depth + 1 });
    }
  }
  return out;
}

function bigrams(text: string): Map<string, number> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Map<string, number>();
  if (compact.length === 1) {
    grams.set(compact, 1);
    return grams;
  }
  for (let i = 0; i < compact.length - 1; i += 1) {
    const gram = compact.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** 字符二元组 Dice 相似度（中英文通用，0~1） */
export function mindmapTextSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let total = 0;
  for (const count of ga.values()) total += count;
  for (const count of gb.values()) total += count;
  if (total === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / total;
}

function matchByText(
  indexed: IndexedNode[],
  rawText: string,
): MindmapNodeTargetResult | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const exact = indexed.find((entry) => (entry.node.text ?? '').trim() === trimmed);
  if (exact) return { nodeId: exact.node.id, matchedBy: 'exact' };

  const norm = normalizeMindmapNodeText(trimmed);
  if (!norm) return null;
  const normalized = indexed.find((entry) => entry.norm === norm);
  if (normalized) return { nodeId: normalized.node.id, matchedBy: 'normalized' };

  // 模糊：包含关系优先（长度差越小越好），其次二元组相似度
  let best: { entry: IndexedNode; score: number } | null = null;
  for (const entry of indexed) {
    if (!entry.norm) continue;
    let score = 0;
    const shorter = Math.min(entry.norm.length, norm.length);
    const longer = Math.max(entry.norm.length, norm.length);
    if (
      shorter >= CONTAINS_MIN_LENGTH &&
      (entry.norm.includes(norm) || norm.includes(entry.norm))
    ) {
      // 包含命中至少 0.6，按长度比例加分
      score = 0.6 + 0.4 * (shorter / longer);
    } else {
      score = mindmapTextSimilarity(entry.norm, norm);
    }
    if (score >= FUZZY_MIN_SIMILARITY && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best ? { nodeId: best.entry.node.id, matchedBy: 'fuzzy' } : null;
}

function lowestCommonAncestor(
  byId: Map<string, IndexedNode>,
  nodeIds: string[],
): string | null {
  if (nodeIds.length === 0) return null;
  const pathOf = (id: string): string[] => {
    const path: string[] = [];
    let cursor: IndexedNode | undefined = byId.get(id);
    while (cursor) {
      path.unshift(cursor.node.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return path;
  };
  let common = pathOf(nodeIds[0]);
  for (const id of nodeIds.slice(1)) {
    const path = pathOf(id);
    let i = 0;
    while (i < common.length && i < path.length && common[i] === path[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length > 0 ? common[common.length - 1] : null;
}

/**
 * 检索片段 → 节点：逐行（去缩进）与节点文字精确/归一化匹配，
 * 取唯一命中行的最近公共祖先；跨多个一级分支（公共祖先是根）视为无法定位。
 * 备注行不对应任何节点，自然被忽略；同名节点（多处命中）的行仅在没有唯一行时才参与。
 */
function matchByChunk(
  indexed: IndexedNode[],
  chunkText: string,
): MindmapNodeTargetResult | null {
  const rootId = indexed[0]?.node.id;
  const byNorm = new Map<string, IndexedNode[]>();
  for (const entry of indexed) {
    if (!entry.norm) continue;
    const list = byNorm.get(entry.norm) ?? [];
    list.push(entry);
    byNorm.set(entry.norm, list);
  }

  const unique: string[] = [];
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  for (const line of chunkText.split(/\r?\n/)) {
    const norm = normalizeMindmapNodeText(line);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const hits = byNorm.get(norm);
    if (!hits || hits.length === 0) continue;
    if (hits.length === 1) unique.push(hits[0].node.id);
    else ambiguous.push(hits[0].node.id);
  }

  const candidates = unique.length > 0 ? unique : ambiguous;
  if (candidates.length === 0) {
    // 片段被截断（snippet 截在行中间）时整行对不上：退化为最长行的文字模糊匹配
    const longest = chunkText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    if (normalizeMindmapNodeText(longest).length < 4) return null;
    const fuzzy = matchByText(indexed, longest);
    return fuzzy ? { nodeId: fuzzy.nodeId, matchedBy: 'chunk' } : null;
  }

  const byId = new Map(indexed.map((entry) => [entry.node.id, entry]));
  const lca = lowestCommonAncestor(byId, candidates);
  if (!lca) return null;
  // 片段只命中根本身 → 定位根；跨分支（LCA=根）→ 无具体节点可定位
  if (lca === rootId && !(candidates.length === 1 && candidates[0] === rootId)) {
    return null;
  }
  return { nodeId: lca, matchedBy: 'chunk' };
}

/**
 * 解析定位目标。优先级：显式 nodeId → 提示即节点 ID → 文字（精确/归一化/模糊）→ 检索片段。
 */
export function resolveMindmapNodeTarget(
  root: MindMapNode | null | undefined,
  hint: MindmapNodeTargetHint | null | undefined,
): MindmapNodeTargetResult | null {
  if (!root || !hint) return null;
  const indexed = indexTree(root);
  const byId = new Set(indexed.map((entry) => entry.node.id));

  const explicitId = hint.nodeId?.trim();
  if (explicitId && byId.has(explicitId)) return { nodeId: explicitId, matchedBy: 'id' };

  const text = hint.text?.trim();
  if (text) {
    if (byId.has(text)) return { nodeId: text, matchedBy: 'id' };
    const byText = matchByText(indexed, text);
    if (byText) return byText;
  }

  const chunk = hint.chunkText?.trim();
  if (chunk) return matchByChunk(indexed, chunk);

  return null;
}

/**
 * 返回「目标节点祖先全部展开」的新树（结构共享，未改动的子树沿用原对象）。
 * 只读预览（MindMapEmbed）用：不写 store，不影响导图本身的折叠状态。
 * 目标不存在时原样返回 root。
 */
export function expandAncestorsInTree(root: MindMapNode, nodeId: string): MindMapNode {
  const visit = (node: MindMapNode): MindMapNode | null => {
    if (node.id === nodeId) return node;
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < children.length; i += 1) {
      const next = visit(children[i]);
      if (next) {
        const nextChildren = next === children[i]
          ? children
          : [...children.slice(0, i), next, ...children.slice(i + 1)];
        if (!node.collapsed && nextChildren === children) return node;
        return { ...node, collapsed: false, children: nextChildren };
      }
    }
    return null;
  };
  return visit(root) ?? root;
}
