/**
 * mindmapDriver 纯校验、克隆、快照与状态对账模块
 *
 * 从 mindmapDriver.ts 拆出，保持纯函数/无副作用，覆盖 MN5/C7 全量学习字段：
 * anchors / excerpts / excerptQuote / imageAssetId / cardNote / isExpandedCard /
 * isFlashcard / summaries / priority / progress / href / images / style / blankedRanges / refs。
 */
import i18n from '@/i18n';
import {
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  buildNodeIndex,
  createImageSanitizeBudget,
  sanitizeNodeImages,
  buildCompletedVisibilityIndex,
  resolveVisibleIdFromIndex,
  mergeRanges,
  validateRanges,
  sanitizeCardNote,
  sanitizeExcerptQuote,
  sanitizeExcerptSlots,
  sanitizeImageAssetId,
  sanitizeNodeAnchors,
  collectSearchPathIds,
  searchMindMapNodeIds,
  sanitizeDocumentSummaries,
  type BlankRange,
  type MindMapImage,
  type MindMapNode,
  type MindMapNodeRef,
  type MindMapStoreApi,
  type MindMapStoreState,
  type MindMapSummaryBrace,
  type NodeStyle,
  type UpdateNodeParams,
} from '@/features/mindmap';
import {
  findNodeById,
  findParentNode,
  isDescendantOf,
} from '@/shared/mindmap/find';
import type { AgentOp } from '../types';

const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** R1-05 对齐的 anchor / payload 形状 */
export interface MindmapOpAnchor {
  node_id?: string;
  parent_id?: string;
  new_parent_id?: string;
}

export interface MindmapOpPayload {
  patch?: UpdateNodeParams;
  data?: Record<string, unknown>;
  index?: number;
  summaries?: unknown;
}

export type MindmapSubtreeValidationCode =
  | 'INVALID_CHILDREN'
  | 'INVALID_NODE'
  | 'INVALID_ID'
  | 'INVALID_TEXT'
  | 'DUPLICATE_ID'
  | 'EXISTING_ID'
  | 'CYCLE'
  | 'SHARED_NODE'
  | 'DEPTH_LIMIT'
  | 'NODE_LIMIT';

export interface MindmapSubtreeValidationResult {
  ok: boolean;
  code?: MindmapSubtreeValidationCode;
  reason?: string;
  nodeCount: number;
  maxRelativeDepth: number;
  forest: MindMapNode[];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function parseAnchor(op: AgentOp): MindmapOpAnchor {
  const raw = asRecord(op.anchor) ?? {};
  return {
    node_id: typeof raw.node_id === 'string' ? raw.node_id : undefined,
    parent_id: typeof raw.parent_id === 'string' ? raw.parent_id : undefined,
    new_parent_id: typeof raw.new_parent_id === 'string' ? raw.new_parent_id : undefined,
  };
}

export function parsePayload(op: AgentOp): MindmapOpPayload {
  const raw = asRecord(op.payload) ?? {};
  const index = typeof raw.index === 'number' && Number.isFinite(raw.index) ? raw.index : undefined;
  return {
    patch: asRecord(raw.patch) as UpdateNodeParams | undefined,
    data: asRecord(raw.data) as MindmapOpPayload['data'],
    index,
    ...(Object.prototype.hasOwnProperty.call(raw, 'summaries') ? { summaries: raw.summaries } : {}),
  };
}

export function deepCloneNode(node: MindMapNode): MindMapNode {
  return JSON.parse(JSON.stringify(node)) as MindMapNode;
}

export function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

export function cloneNodeStyle(value: unknown): NodeStyle | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const style: NodeStyle = {};
  if (typeof raw.bgColor === 'string') style.bgColor = raw.bgColor;
  if (typeof raw.textColor === 'string') style.textColor = raw.textColor;
  if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
    style.fontSize = raw.fontSize;
  }
  if (raw.fontWeight === 'normal' || raw.fontWeight === 'bold') {
    style.fontWeight = raw.fontWeight;
  }
  if (raw.fontStyle === 'normal' || raw.fontStyle === 'italic') {
    style.fontStyle = raw.fontStyle;
  }
  if (
    raw.textDecoration === 'none' ||
    raw.textDecoration === 'underline' ||
    raw.textDecoration === 'line-through'
  ) {
    style.textDecoration = raw.textDecoration;
  }
  if (raw.headingLevel === 'h1' || raw.headingLevel === 'h2' || raw.headingLevel === 'h3') {
    style.headingLevel = raw.headingLevel;
  }
  if (typeof raw.icon === 'string') style.icon = raw.icon;
  if (typeof raw.showCheckbox === 'boolean') style.showCheckbox = raw.showCheckbox;
  return Object.keys(style).length > 0 ? style : undefined;
}

export function mergeNodeStylePatch(
  current: NodeStyle | undefined,
  patch: unknown,
): NodeStyle | undefined {
  const raw = asRecord(patch);
  if (!raw) return current;
  const merged = { ...(current ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? (merged as NodeStyle) : undefined;
}

export function cloneBlankedRanges(value: unknown): BlankRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges = value.flatMap((item) => {
    const raw = asRecord(item);
    return raw && Number.isInteger(raw.start) && Number.isInteger(raw.end)
      ? [{ start: raw.start as number, end: raw.end as number }]
      : [];
  });
  return ranges.length > 0 ? ranges : undefined;
}

export function cloneNodeRefs(value: unknown): MindMapNodeRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((item) => {
    const raw = asRecord(item);
    if (
      !raw ||
      typeof raw.sourceId !== 'string' ||
      typeof raw.type !== 'string' ||
      typeof raw.name !== 'string'
    ) {
      return [];
    }
    const ref: MindMapNodeRef = {
      sourceId: raw.sourceId,
      type: raw.type,
      name: raw.name,
    };
    if (typeof raw.resourceHash === 'string') ref.resourceHash = raw.resourceHash;
    return [ref];
  });
  return refs.length > 0 ? refs : undefined;
}

export function sanitizeNodePriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 6 ? value : undefined;
}

export function sanitizeNodeProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return Math.round(value);
}

export function sanitizeNodeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    return SAFE_HREF_SCHEMES.has(parsed.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function cloneNodeImages(value: unknown): MindMapImage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const budget = createImageSanitizeBudget();
  const out: MindMapImage[] = [];
  for (const item of value) {
    const sanitized = sanitizeNodeImages([item], budget);
    if (!sanitized || sanitized.length === 0) continue;
    const rawItem = asRecord(item);
    const id =
      typeof rawItem?.id === 'string' && rawItem.id.trim()
        ? rawItem.id.trim().slice(0, 128)
        : undefined;
    out.push(id ? { ...sanitized[0], id } : { ...sanitized[0] });
  }
  return out.length > 0 ? out : undefined;
}

/** 将外部节点对象中的 MN5/C7 学习字段安全清洗后合并到目标节点（供 add_node 与嵌套子树共用） */
export function applyValidatedOptionalNodeFields(
  target: Omit<MindMapNode, 'id'>,
  raw: Record<string, unknown>,
): void {
  if (typeof raw.note === 'string') target.note = raw.note;
  if (typeof raw.collapsed === 'boolean') target.collapsed = raw.collapsed;
  if (typeof raw.completed === 'boolean') target.completed = raw.completed;
  const style = cloneNodeStyle(raw.style);
  if (style) target.style = style;
  const blankedRanges = cloneBlankedRanges(raw.blankedRanges);
  if (blankedRanges) target.blankedRanges = blankedRanges;
  const refs = cloneNodeRefs(raw.refs);
  if (refs) target.refs = refs;
  if (typeof raw.branchColor === 'string') target.branchColor = raw.branchColor;

  const priority = sanitizeNodePriority(raw.priority);
  if (priority !== undefined) target.priority = priority;
  const progress = sanitizeNodeProgress(raw.progress);
  if (progress !== undefined) target.progress = progress;
  const href = sanitizeNodeHref(raw.href);
  if (href !== undefined) target.href = href;
  const images = cloneNodeImages(raw.images);
  if (images) target.images = images;

  const anchors = sanitizeNodeAnchors(raw.anchors);
  if (anchors) target.anchors = anchors;
  const excerptQuote = sanitizeExcerptQuote(raw.excerptQuote);
  if (excerptQuote) target.excerptQuote = excerptQuote;
  const imageAssetId = sanitizeImageAssetId(raw.imageAssetId);
  if (imageAssetId) target.imageAssetId = imageAssetId;
  const excerpts = sanitizeExcerptSlots(raw.excerpts);
  if (excerpts) target.excerpts = excerpts;
  const cardNote = sanitizeCardNote(raw.cardNote);
  if (cardNote) target.cardNote = cardNote;
  if (typeof raw.isExpandedCard === 'boolean') target.isExpandedCard = raw.isExpandedCard;
  if (raw.isFlashcard === true) target.isFlashcard = true;
}

/**
 * 规范化 update_node 的 patch（对齐 MN5/C7 字段清洗与显式清除语义）：
 * - 显式清除（`null`、`undefined`、`""`、`[]`）转为清除标记；
 * - 非法值（如 `priority: 7`、非法 `href`）直接从 `normalized` 中省略（`delete`），绝不静默抹除节点原有合法值。
 */
export function normalizeUpdateNodePatch(
  node: MindMapNode,
  patch: UpdateNodeParams,
): UpdateNodeParams {
  const raw = patch as unknown as Record<string, unknown>;
  const normalized: UpdateNodeParams = {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(raw, 'style')
      ? { style: mergeNodeStylePatch(node.style, raw.style) }
      : {}),
  };

  if (Object.prototype.hasOwnProperty.call(raw, 'priority')) {
    if (raw.priority === null || raw.priority === undefined) {
      normalized.priority = undefined;
    } else {
      const cleaned = sanitizeNodePriority(raw.priority);
      if (cleaned !== undefined) normalized.priority = cleaned;
      else delete normalized.priority;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'progress')) {
    if (raw.progress === null || raw.progress === undefined) {
      normalized.progress = undefined;
    } else {
      const cleaned = sanitizeNodeProgress(raw.progress);
      if (cleaned !== undefined) normalized.progress = cleaned;
      else delete normalized.progress;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'href')) {
    if (
      raw.href === null ||
      raw.href === undefined ||
      (typeof raw.href === 'string' && raw.href.trim() === '')
    ) {
      normalized.href = undefined;
    } else {
      const cleaned = sanitizeNodeHref(raw.href);
      if (cleaned !== undefined) normalized.href = cleaned;
      else delete normalized.href;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'images')) {
    if (
      raw.images === null ||
      raw.images === undefined ||
      (Array.isArray(raw.images) && raw.images.length === 0)
    ) {
      normalized.images = undefined;
    } else {
      const cleaned = cloneNodeImages(raw.images);
      if (cleaned !== undefined) normalized.images = cleaned;
      else delete normalized.images;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'anchors')) {
    if (
      raw.anchors === null ||
      raw.anchors === undefined ||
      (Array.isArray(raw.anchors) && raw.anchors.length === 0)
    ) {
      normalized.anchors = null;
    } else {
      const cleaned = sanitizeNodeAnchors(raw.anchors);
      if (cleaned !== undefined) normalized.anchors = cleaned;
      else delete normalized.anchors;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'excerpts')) {
    if (
      raw.excerpts === null ||
      raw.excerpts === undefined ||
      (Array.isArray(raw.excerpts) && raw.excerpts.length === 0)
    ) {
      normalized.excerpts = null;
    } else {
      const cleaned = sanitizeExcerptSlots(raw.excerpts);
      if (cleaned !== undefined) normalized.excerpts = cleaned;
      else delete normalized.excerpts;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'excerptQuote')) {
    if (
      raw.excerptQuote === null ||
      raw.excerptQuote === undefined ||
      (typeof raw.excerptQuote === 'string' && raw.excerptQuote.trim() === '')
    ) {
      normalized.excerptQuote = null;
    } else {
      const cleaned = sanitizeExcerptQuote(raw.excerptQuote);
      if (cleaned !== undefined) normalized.excerptQuote = cleaned;
      else delete normalized.excerptQuote;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'imageAssetId')) {
    if (
      raw.imageAssetId === null ||
      raw.imageAssetId === undefined ||
      (typeof raw.imageAssetId === 'string' && raw.imageAssetId.trim() === '')
    ) {
      normalized.imageAssetId = null;
    } else {
      const cleaned = sanitizeImageAssetId(raw.imageAssetId);
      if (cleaned !== undefined) normalized.imageAssetId = cleaned;
      else delete normalized.imageAssetId;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'cardNote')) {
    if (
      raw.cardNote === null ||
      raw.cardNote === undefined ||
      (typeof raw.cardNote === 'string' && raw.cardNote.trim() === '')
    ) {
      normalized.cardNote = null;
    } else {
      const cleaned = sanitizeCardNote(raw.cardNote);
      if (cleaned !== undefined) normalized.cardNote = cleaned;
      else delete normalized.cardNote;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'isExpandedCard')) {
    if (raw.isExpandedCard === null || raw.isExpandedCard === undefined) {
      normalized.isExpandedCard = null;
    } else if (typeof raw.isExpandedCard === 'boolean') {
      normalized.isExpandedCard = raw.isExpandedCard;
    } else {
      delete normalized.isExpandedCard;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'isFlashcard')) {
    if (raw.isFlashcard === true) {
      normalized.isFlashcard = true;
    } else if (
      raw.isFlashcard === false ||
      raw.isFlashcard === null ||
      raw.isFlashcard === undefined
    ) {
      normalized.isFlashcard = null;
    } else {
      delete normalized.isFlashcard;
    }
  }

  return normalized;
}

/** 校验并清洗文档级 summaries（归纳总结大括号） */
export function validateMindmapSummariesInput(
  root: MindMapNode,
  rawSummaries: unknown,
): MindMapSummaryBrace[] | undefined {
  return sanitizeDocumentSummaries(rawSummaries, root);
}

/** 在任何文档 mutation 前验证并克隆 Agent 提供的 children forest。 */
export function validateMindmapSubtreeInput(
  root: MindMapNode,
  parentId: string,
  input: unknown,
  reservedIds?: readonly string[],
): MindmapSubtreeValidationResult {
  const fail = (
    code: MindmapSubtreeValidationCode,
    reason: string,
    nodeCount = 0,
    maxRelativeDepth = 0,
  ): MindmapSubtreeValidationResult => ({
    ok: false,
    code,
    reason,
    nodeCount,
    maxRelativeDepth,
    forest: [],
  });

  if (input !== undefined && !Array.isArray(input)) {
    return fail(
      'INVALID_CHILDREN',
      i18n.t('mindmap:agent.validation_children_not_array', {
        defaultValue: 'data.children 必须是数组',
      }),
    );
  }
  const values = (input ?? []) as unknown[];

  const existingIds = new Set<string>();
  let existingCount = 0;
  let parentDepth = -1;
  const stack: Array<{ node: MindMapNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    existingCount += 1;
    existingIds.add(current.node.id);
    if (current.node.id === parentId) parentDepth = current.depth;
    for (let i = current.node.children.length - 1; i >= 0; i--) {
      stack.push({ node: current.node.children[i], depth: current.depth + 1 });
    }
  }
  if (parentDepth < 0) {
    return fail(
      'INVALID_NODE',
      i18n.t('mindmap:agent.parent_not_found', {
        id: parentId,
        defaultValue: '父节点 {{id}} 不存在',
      }),
    );
  }
  if (existingCount + 1 > MAX_MINDMAP_NODES) {
    return fail(
      'NODE_LIMIT',
      i18n.t('mindmap:agent.validation_node_limit', {
        max: MAX_MINDMAP_NODES,
        defaultValue: '节点总数不能超过 {{max}}',
      }),
    );
  }
  if (parentDepth + 1 >= MAX_MINDMAP_DEPTH) {
    return fail(
      'DEPTH_LIMIT',
      i18n.t('mindmap:agent.validation_depth_limit', {
        max: MAX_MINDMAP_DEPTH,
        defaultValue: '节点深度不能达到或超过 {{max}}',
      }),
    );
  }

  const incomingIds = new Set<string>();
  if (reservedIds) {
    for (const id of reservedIds) {
      const trimmed = typeof id === 'string' ? id.trim() : '';
      if (trimmed) incomingIds.add(trimmed);
    }
  }
  const seenObjects = new WeakSet<object>();
  const activeObjects = new WeakSet<object>();
  let nodeCount = 0;
  let maxRelativeDepth = 0;
  let failure: MindmapSubtreeValidationResult | null = null;

  const visit = (value: unknown, relativeDepth: number): MindMapNode | null => {
    if (failure) return null;
    const raw = asRecord(value);
    if (!raw) {
      failure = fail(
        'INVALID_NODE',
        i18n.t('mindmap:agent.validation_item_not_node', {
          defaultValue: 'children 中每一项都必须是节点对象',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      return null;
    }
    if (activeObjects.has(raw)) {
      failure = fail(
        'CYCLE',
        i18n.t('mindmap:agent.validation_cycle', {
          defaultValue: 'children 中存在循环引用',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      return null;
    }
    if (seenObjects.has(raw)) {
      failure = fail(
        'SHARED_NODE',
        i18n.t('mindmap:agent.validation_shared_node', {
          defaultValue: '同一节点对象不能属于多个父节点',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      return null;
    }
    activeObjects.add(raw);
    seenObjects.add(raw);

    const resolvedRawId =
      raw.id === undefined
        ? `node_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
        : raw.id;

    if (typeof resolvedRawId !== 'string' || resolvedRawId.trim().length === 0) {
      failure = fail(
        'INVALID_ID',
        i18n.t('mindmap:agent.validation_invalid_id', {
          defaultValue: '子节点 id 必须是非空字符串',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (existingIds.has(resolvedRawId)) {
      failure = fail(
        'EXISTING_ID',
        i18n.t('mindmap:agent.validation_existing_id', {
          id: resolvedRawId,
          defaultValue: '子节点 id {{id}} 已存在',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (incomingIds.has(resolvedRawId) || incomingIds.has(resolvedRawId.trim())) {
      failure = fail(
        'DUPLICATE_ID',
        i18n.t('mindmap:agent.validation_duplicate_id', {
          id: resolvedRawId,
          defaultValue: 'children 中存在重复 id {{id}}',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (typeof raw.text !== 'string') {
      failure = fail(
        'INVALID_TEXT',
        i18n.t('mindmap:agent.validation_invalid_text', {
          id: resolvedRawId,
          defaultValue: '子节点 {{id}} 的 text 必须是字符串',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    const rawChildren = raw.children === undefined ? [] : raw.children;
    if (!Array.isArray(rawChildren)) {
      failure = fail(
        'INVALID_CHILDREN',
        i18n.t('mindmap:agent.validation_invalid_children', {
          id: resolvedRawId,
          defaultValue: '子节点 {{id}} 的 children 必须是数组',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }

    incomingIds.add(resolvedRawId);
    nodeCount += 1;
    maxRelativeDepth = Math.max(maxRelativeDepth, relativeDepth);
    if (existingCount + 1 + nodeCount > MAX_MINDMAP_NODES) {
      failure = fail(
        'NODE_LIMIT',
        i18n.t('mindmap:agent.validation_node_limit', {
          max: MAX_MINDMAP_NODES,
          defaultValue: '节点总数不能超过 {{max}}',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (parentDepth + 1 + relativeDepth >= MAX_MINDMAP_DEPTH) {
      failure = fail(
        'DEPTH_LIMIT',
        i18n.t('mindmap:agent.validation_depth_limit', {
          max: MAX_MINDMAP_DEPTH,
          defaultValue: '节点深度不能达到或超过 {{max}}',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }

    const children: MindMapNode[] = [];
    for (const child of rawChildren) {
      const cloned = visit(child, relativeDepth + 1);
      if (!cloned) {
        activeObjects.delete(raw);
        return null;
      }
      children.push(cloned);
    }
    activeObjects.delete(raw);

    const node: MindMapNode = { id: resolvedRawId, text: raw.text, children };
    applyValidatedOptionalNodeFields(node, raw);
    return node;
  };

  const forest: MindMapNode[] = [];
  for (const value of values) {
    const cloned = visit(value, 1);
    if (!cloned) return failure!;
    forest.push(cloned);
  }
  return { ok: true, nodeCount, maxRelativeDepth, forest };
}

/** 捕获节点全量可更新字段快照，用于 ledger 回滚与冲突检测 */
export function snapshotNodeFields(node: MindMapNode): UpdateNodeParams {
  return {
    text: node.text,
    note: node.note,
    collapsed: node.collapsed,
    completed: node.completed,
    style: node.style ? { ...node.style } : undefined,
    blankedRanges: node.blankedRanges?.map((r) => ({ ...r })),
    refs: node.refs?.map((r) => ({ ...r })),
    priority: node.priority,
    progress: node.progress,
    href: node.href,
    images: node.images?.map((img) => ({ ...img })),
    anchors: node.anchors ? (JSON.parse(JSON.stringify(node.anchors)) as MindMapNode['anchors']) : undefined,
    excerptQuote: node.excerptQuote,
    imageAssetId: node.imageAssetId,
    excerpts: node.excerpts ? (JSON.parse(JSON.stringify(node.excerpts)) as MindMapNode['excerpts']) : undefined,
    cardNote: node.cardNote,
    isExpandedCard: node.isExpandedCard,
    isFlashcard: node.isFlashcard,
  };
}

export function nodeLocation(root: MindMapNode, nodeId: string): { parentId: string; index: number } | null {
  const parent = findParentNode(root, nodeId);
  if (!parent) return null;
  const index = parent.children.findIndex((child) => child.id === nodeId);
  return index >= 0 ? { parentId: parent.id, index } : null;
}

/** delete_node 退场演出：目标节点及其整棵子树一起标记 */
export function collectSubtreeIds(root: MindMapNode, nodeId: string): string[] {
  const target = findNodeById(root, nodeId);
  if (!target) return [];
  const ids: string[] = [];
  const stack: MindMapNode[] = [target];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ids.push(node.id);
    for (const child of node.children) stack.push(child);
  }
  return ids;
}

export function collectTargetNodeIds(ops: AgentOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    const anchor = parseAnchor(op);
    if (anchor.node_id) ids.add(anchor.node_id);
    if (anchor.parent_id) ids.add(anchor.parent_id);
    if (anchor.new_parent_id) ids.add(anchor.new_parent_id);
  }
  return ids;
}

function countNestedRawNodes(childrenRaw: unknown, seen: WeakSet<object>): number {
  if (!Array.isArray(childrenRaw)) return 0;
  let total = 0;
  for (const item of childrenRaw) {
    const rec = asRecord(item);
    if (!rec || seen.has(rec)) continue;
    seen.add(rec);
    total += 1 + countNestedRawNodes(rec.children, seen);
  }
  return total;
}

export function countProposedBatchNodes(ops: AgentOp[]): number {
  let count = 0;
  const seen = new WeakSet<object>();
  for (const op of ops) {
    if (op.kind === 'add_node') {
      const payload = asRecord(op.payload);
      const data = asRecord(payload?.data);
      if (data) seen.add(data);
      count += 1 + countNestedRawNodes(data?.children, seen);
    } else {
      count += 1;
    }
  }
  return count;
}

export function getTreeDepth(root: MindMapNode, targetId: string, depth = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getTreeDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

export function getTreeHeight(root: MindMapNode): number {
  let height = 0;
  for (const child of root.children) {
    height = Math.max(height, 1 + getTreeHeight(child));
  }
  return height;
}

export function resolveFailureReason(
  storeApi: MindMapStoreApi,
  op: AgentOp,
  anchor: MindmapOpAnchor,
): string | null {
  const root = storeApi.getState().document.root;
  switch (op.kind) {
    case 'add_node': {
      if (!anchor.parent_id) {
        return i18n.t('mindmap:agent.missing_parent_id', { defaultValue: '缺少 parent_id' });
      }
      if (!findNodeById(root, anchor.parent_id)) {
        return i18n.t('mindmap:agent.parent_not_found', {
          id: anchor.parent_id,
          defaultValue: '父节点 {{id}} 不存在',
        });
      }
      return null;
    }
    case 'update_node':
    case 'delete_node': {
      if (!anchor.node_id) {
        return i18n.t('mindmap:agent.missing_node_id', { defaultValue: '缺少 node_id' });
      }
      if (!findNodeById(root, anchor.node_id)) {
        return i18n.t('mindmap:agent.node_not_found', {
          id: anchor.node_id,
          defaultValue: '节点 {{id}} 不存在',
        });
      }
      if (op.kind === 'delete_node' && root.id === anchor.node_id) {
        return i18n.t('mindmap:agent.cannot_delete_root', { defaultValue: '不能删除根节点' });
      }
      return null;
    }
    case 'move_node': {
      if (!anchor.node_id) {
        return i18n.t('mindmap:agent.missing_node_id', { defaultValue: '缺少 node_id' });
      }
      if (!anchor.new_parent_id) {
        return i18n.t('mindmap:agent.missing_new_parent_id', {
          defaultValue: '缺少 new_parent_id',
        });
      }
      if (!findNodeById(root, anchor.node_id)) {
        return i18n.t('mindmap:agent.node_not_found', {
          id: anchor.node_id,
          defaultValue: '节点 {{id}} 不存在',
        });
      }
      if (!findNodeById(root, anchor.new_parent_id)) {
        return i18n.t('mindmap:agent.new_parent_not_found', {
          id: anchor.new_parent_id,
          defaultValue: '新父节点 {{id}} 不存在',
        });
      }
      if (root.id === anchor.node_id) {
        return i18n.t('mindmap:agent.cannot_move_root', { defaultValue: '不能移动根节点' });
      }
      if (anchor.node_id === anchor.new_parent_id) {
        return i18n.t('mindmap:agent.cannot_move_to_self', {
          defaultValue: '不能把节点移动到自身',
        });
      }
      if (isDescendantOf(root, anchor.node_id, anchor.new_parent_id)) {
        return i18n.t('mindmap:agent.cannot_move_to_descendant', {
          defaultValue: '不能把节点移动到自己的后代',
        });
      }
      const movingNode = findNodeById(root, anchor.node_id);
      const nextParentDepth = getTreeDepth(root, anchor.new_parent_id);
      if (
        movingNode &&
        nextParentDepth + 1 + getTreeHeight(movingNode) >= MAX_MINDMAP_DEPTH
      ) {
        return i18n.t('mindmap:agent.move_depth_limit', {
          max: MAX_MINDMAP_DEPTH,
          defaultValue: '移动后节点深度会达到或超过 {{max}}',
        });
      }
      return null;
    }
    default:
      return i18n.t('mindmap:agent.unknown_op_kind', {
        kind: op.kind,
        defaultValue: '未知操作 kind={{kind}}',
      });
  }
}

/**
 * 纯函数对账 revealedBlanks（与 mindmapStoreRuntime.reconcileRevealedBlanks 同口径）：
 * 节点已删除、挖空已移除或区间数变少时清理越界揭示状态。
 */
export function reconcileRevealedBlanks(
  root: MindMapNode,
  revealedBlanks: Record<string, Record<number, boolean>>,
): Record<string, Record<number, boolean>> {
  const nodeIds = Object.keys(revealedBlanks);
  if (nodeIds.length === 0) return revealedBlanks;
  const nodeById = buildNodeIndex(root).nodeById;
  const reconciled: Record<string, Record<number, boolean>> = {};
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node?.blankedRanges?.length) continue;
    const rangeCount = mergeRanges(validateRanges(node.blankedRanges, node.text.length)).length;
    const nextForNode: Record<number, boolean> = {};
    for (const [key, value] of Object.entries(revealedBlanks[nodeId] ?? {})) {
      const idx = Number(key);
      if (idx >= 0 && idx < rangeCount) nextForNode[idx] = value;
    }
    if (Object.keys(nextForNode).length > 0) {
      reconciled[nodeId] = nextForNode;
    }
  }
  return reconciled;
}

export interface ReconciledFilteredInteractionPatch {
  searchResults: string[];
  currentSearchIndex: number;
  selection: string[];
  focusedNodeId: string | null;
  editingNodeId: string | null;
  editingNoteNodeId: string | null;
}

/**
 * 纯函数对账搜索/隐藏已完成过滤态下的交互焦点与选区（与 mindmapStoreRuntime.reconcileFilteredInteractionState 同口径）。
 */
export function reconcileFilteredInteractionState(
  state: Pick<
    MindMapStoreState,
    | 'document'
    | 'searchQuery'
    | 'searchOptions'
    | 'searchResults'
    | 'currentSearchIndex'
    | 'searchFilterMode'
    | 'hideCompleted'
    | 'selection'
    | 'focusedNodeId'
    | 'editingNodeId'
    | 'editingNoteNodeId'
  >,
): ReconciledFilteredInteractionPatch {
  const root = state.document.root;
  let searchResults = state.searchResults;
  let currentSearchIndex = state.currentSearchIndex;
  const trimmedQuery = state.searchQuery?.trim() ?? '';
  if (trimmedQuery) {
    const prevCurrentId = searchResults[currentSearchIndex] ?? null;
    searchResults = searchMindMapNodeIds(root, trimmedQuery, state.searchOptions);
    if (searchResults.length === 0) {
      currentSearchIndex = -1;
    } else if (prevCurrentId) {
      const preserved = searchResults.indexOf(prevCurrentId);
      currentSearchIndex = preserved >= 0 ? preserved : 0;
    } else {
      currentSearchIndex = 0;
    }
  }

  let selection = state.selection;
  let focusedNodeId = state.focusedNodeId;
  let editingNodeId = state.editingNodeId;
  let editingNoteNodeId = state.editingNoteNodeId;

  if (state.searchFilterMode && trimmedQuery) {
    const allowedIds = collectSearchPathIds(root, searchResults);
    selection = selection.filter((id) => allowedIds.has(id));
    if (editingNodeId && !allowedIds.has(editingNodeId)) {
      editingNodeId = null;
    }
    if (focusedNodeId && !allowedIds.has(focusedNodeId)) {
      focusedNodeId = searchResults.find((id) => allowedIds.has(id)) ?? null;
    }
    return {
      searchResults,
      currentSearchIndex,
      selection,
      focusedNodeId,
      editingNodeId,
      editingNoteNodeId,
    };
  }

  if (state.hideCompleted) {
    const visibility = buildCompletedVisibilityIndex(root);
    selection = selection.filter((id) => visibility.visibleIds.has(id));
    focusedNodeId = resolveVisibleIdFromIndex(visibility, focusedNodeId, root.id);
    if (editingNodeId && !visibility.visibleIds.has(editingNodeId)) {
      editingNodeId = null;
    }
    if (editingNoteNodeId && !visibility.visibleIds.has(editingNoteNodeId)) {
      editingNoteNodeId = null;
    }
  }

  return {
    searchResults,
    currentSearchIndex,
    selection,
    focusedNodeId,
    editingNodeId,
    editingNoteNodeId,
  };
}
