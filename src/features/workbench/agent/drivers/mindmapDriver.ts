/**
 * ACR mindmap Driver — R1-11 标杆 + R2-02 链路补齐
 *
 * 契约：docs/dev/acr/DESIGN.md §5.1 / types.ts CollabDriver
 * AgentOp 形状对齐 R1-05 `mindmap_operation_to_agent_op`：
 *   kind = update_node|add_node|delete_node|move_node
 *   anchor = { node_id?, parent_id?, new_parent_id? }
 *   payload = { patch?, data?, index? }
 *
 * R2-02：
 *   - 视口跟随节流：每 VIEWPORT_FOLLOW_EVERY op 才 setFocusedNodeId；结束一次 fitView
 *   - destructive+dirty/hot：书面否决升级预览，维持 v1 拒绝式 suggestionPending
 *   - 按 resourceId 捕获独立 store，整个 run 与 ledger 回滚保持实例绑定
 *
 * 约束：store 未注册或尚未加载 target.resourceId 时视为 closed。
 */
import {
  getMindMapStoreForResource,
  MAX_MINDMAP_DEPTH,
  MAX_MINDMAP_NODES,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import type {
  BlankRange,
  MindMapNode,
  MindMapNodeRef,
  NodeStyle,
  UpdateNodeParams,
} from '@/features/mindmap/types';
import {
  findNodeById,
  findParentNode,
  isDescendantOf,
} from '@/features/mindmap/utils/node/find';
import type {
  AcrProbeState,
  AcrReceipt,
  AcrRunContext,
  AgentOp,
  AcrTarget,
  CollabDriver,
  StageManagerApi,
} from '../types';
import { withUserPatch } from '../userPatch';

const TYPE_ID = 'mindmap';
const AGENT_ENTERING_TTL_MS = 3000;
/**
 * DESIGN §4.3：setCenter / 焦点跟随每 3–5 op 节流。
 * R3-02：200 节点生长压测取上限 5，降低 ensureNodeVisible/setCenter 频率。
 */
export const VIEWPORT_FOLLOW_EVERY = 5;

/**
 * R2-02 定稿：维持 v1 拒绝式（不升级 AIDiff 式预览）。
 * 理由见 progress/R2-02.md「设计决策」。
 */
const SUGGESTION_MESSAGE =
  '存在未保存编辑，建议改用后端路径或等待用户空闲（v1 拒绝式，无 diff 预览；R2-02 书面否决升级）';

/** R1-05 对齐的 anchor / payload 形状 */
interface MindmapOpAnchor {
  node_id?: string;
  parent_id?: string;
  new_parent_id?: string;
}

interface MindmapOpPayload {
  patch?: UpdateNodeParams;
  data?: Record<string, unknown>;
  index?: number;
}

/** 活跃 run 的停止旗标与累计回执（abort 路径） */
interface ActiveRunState {
  aborted: boolean;
  receipt: AcrReceipt;
}

const activeRuns = new Map<string, ActiveRunState>();
const enteringTimers = new WeakMap<
  MindMapStoreApi,
  Map<string, ReturnType<typeof setTimeout>>
>();

function emptyReceipt(totalOps: number, mode: AcrReceipt['mode'] = 'frontend'): AcrReceipt {
  return {
    status: 'completed',
    mode,
    applied: 0,
    totalOps,
    entityIds: [],
    done: [],
    undone: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseAnchor(op: AgentOp): MindmapOpAnchor {
  const raw = asRecord(op.anchor) ?? {};
  return {
    node_id: typeof raw.node_id === 'string' ? raw.node_id : undefined,
    parent_id: typeof raw.parent_id === 'string' ? raw.parent_id : undefined,
    new_parent_id: typeof raw.new_parent_id === 'string' ? raw.new_parent_id : undefined,
  };
}

function parsePayload(op: AgentOp): MindmapOpPayload {
  const raw = asRecord(op.payload) ?? {};
  const index = typeof raw.index === 'number' && Number.isFinite(raw.index) ? raw.index : undefined;
  return {
    patch: asRecord(raw.patch) as UpdateNodeParams | undefined,
    data: asRecord(raw.data) as MindmapOpPayload['data'],
    index,
  };
}

function deepCloneNode(node: MindMapNode): MindMapNode {
  return JSON.parse(JSON.stringify(node)) as MindMapNode;
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

function cloneNodeStyle(value: unknown): NodeStyle | undefined {
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
  return Object.keys(style).length > 0 ? style : undefined;
}

function cloneBlankedRanges(value: unknown): BlankRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ranges = value.flatMap((item) => {
    const raw = asRecord(item);
    return raw && Number.isInteger(raw.start) && Number.isInteger(raw.end)
      ? [{ start: raw.start as number, end: raw.end as number }]
      : [];
  });
  return ranges.length > 0 ? ranges : undefined;
}

function cloneNodeRefs(value: unknown): MindMapNodeRef[] | undefined {
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

/** 在任何文档 mutation 前验证并克隆 Agent 提供的 children forest。 */
export function validateMindmapSubtreeInput(
  root: MindMapNode,
  parentId: string,
  input: unknown,
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
    return fail('INVALID_CHILDREN', 'data.children 必须是数组');
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
  if (parentDepth < 0) return fail('INVALID_NODE', `父节点 ${parentId} 不存在`);
  if (existingCount + 1 > MAX_MINDMAP_NODES) {
    return fail('NODE_LIMIT', `节点总数不能超过 ${MAX_MINDMAP_NODES}`);
  }
  if (parentDepth + 1 >= MAX_MINDMAP_DEPTH) {
    return fail('DEPTH_LIMIT', `节点深度不能达到或超过 ${MAX_MINDMAP_DEPTH}`);
  }

  const incomingIds = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const activeObjects = new WeakSet<object>();
  let nodeCount = 0;
  let maxRelativeDepth = 0;
  let failure: MindmapSubtreeValidationResult | null = null;

  const visit = (value: unknown, relativeDepth: number): MindMapNode | null => {
    if (failure) return null;
    const raw = asRecord(value);
    if (!raw) {
      failure = fail('INVALID_NODE', 'children 中每一项都必须是节点对象', nodeCount, maxRelativeDepth);
      return null;
    }
    if (activeObjects.has(raw)) {
      failure = fail('CYCLE', 'children 中存在循环引用', nodeCount, maxRelativeDepth);
      return null;
    }
    if (seenObjects.has(raw)) {
      failure = fail('SHARED_NODE', '同一节点对象不能属于多个父节点', nodeCount, maxRelativeDepth);
      return null;
    }
    activeObjects.add(raw);
    seenObjects.add(raw);

    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
      failure = fail('INVALID_ID', '子节点 id 必须是非空字符串', nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }
    if (existingIds.has(raw.id)) {
      failure = fail('EXISTING_ID', `子节点 id ${raw.id} 已存在`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }
    if (incomingIds.has(raw.id)) {
      failure = fail('DUPLICATE_ID', `children 中存在重复 id ${raw.id}`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }
    if (typeof raw.text !== 'string') {
      failure = fail('INVALID_TEXT', `子节点 ${raw.id} 的 text 必须是字符串`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }
    if (!Array.isArray(raw.children)) {
      failure = fail('INVALID_CHILDREN', `子节点 ${raw.id} 的 children 必须是数组`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }

    incomingIds.add(raw.id);
    nodeCount += 1;
    maxRelativeDepth = Math.max(maxRelativeDepth, relativeDepth);
    if (existingCount + 1 + nodeCount > MAX_MINDMAP_NODES) {
      failure = fail('NODE_LIMIT', `节点总数不能超过 ${MAX_MINDMAP_NODES}`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }
    if (parentDepth + 1 + relativeDepth >= MAX_MINDMAP_DEPTH) {
      failure = fail('DEPTH_LIMIT', `节点深度不能达到或超过 ${MAX_MINDMAP_DEPTH}`, nodeCount, maxRelativeDepth);
      activeObjects.delete(raw);
      return null;
    }

    const children: MindMapNode[] = [];
    for (const child of raw.children) {
      const cloned = visit(child, relativeDepth + 1);
      if (!cloned) {
        activeObjects.delete(raw);
        return null;
      }
      children.push(cloned);
    }
    activeObjects.delete(raw);

    const node: MindMapNode = { id: raw.id, text: raw.text, children };
    if (typeof raw.note === 'string') node.note = raw.note;
    if (typeof raw.collapsed === 'boolean') node.collapsed = raw.collapsed;
    if (typeof raw.completed === 'boolean') node.completed = raw.completed;
    const style = cloneNodeStyle(raw.style);
    if (style) node.style = style;
    const blankedRanges = cloneBlankedRanges(raw.blankedRanges);
    if (blankedRanges) node.blankedRanges = blankedRanges;
    const refs = cloneNodeRefs(raw.refs);
    if (refs) node.refs = refs;
    if (typeof raw.branchColor === 'string') node.branchColor = raw.branchColor;
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

function snapshotNodeFields(node: MindMapNode): UpdateNodeParams {
  const snap: UpdateNodeParams = { text: node.text };
  if (node.note !== undefined) snap.note = node.note;
  if (node.collapsed !== undefined) snap.collapsed = node.collapsed;
  if (node.completed !== undefined) snap.completed = node.completed;
  if (node.style !== undefined) snap.style = node.style ? { ...node.style } : undefined;
  if (node.blankedRanges !== undefined) {
    snap.blankedRanges = node.blankedRanges.map((r) => ({ ...r }));
  }
  if (node.refs !== undefined) {
    snap.refs = node.refs.map((r) => ({ ...r }));
  }
  return snap;
}

function markEntering(storeApi: MindMapStoreApi, ids: string[]): void {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  storeApi.getState().markAgentEntering(unique);
  let storeTimers = enteringTimers.get(storeApi);
  if (!storeTimers) {
    storeTimers = new Map();
    enteringTimers.set(storeApi, storeTimers);
  }
  for (const id of unique) {
    const prev = storeTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      storeTimers?.delete(id);
      storeApi.getState().clearAgentEntering([id]);
    }, AGENT_ENTERING_TTL_MS);
    storeTimers.set(id, timer);
  }
}

function collectTargetNodeIds(ops: AgentOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    const anchor = parseAnchor(op);
    if (anchor.node_id) ids.add(anchor.node_id);
    if (anchor.parent_id) ids.add(anchor.parent_id);
    if (anchor.new_parent_id) ids.add(anchor.new_parent_id);
  }
  return ids;
}

function batchHasDestructive(ops: AgentOp[]): boolean {
  return ops.some(
    (op) =>
      op.destructive === true ||
      op.kind === 'delete_node' ||
      op.kind === 'move_node',
  );
}

/**
 * 是否应对本成功 op 做视口跟随（setFocusedNodeId → canvas ensureNodeVisible）。
 * fast/instant：循环内不跟随，收尾统一一次；normal/demo：第 1 次 + 每 VIEWPORT_FOLLOW_EVERY 次。
 * 最后一次成功实体由 apply 收尾保证焦点（避免漏跟）。
 */
function shouldFollowViewport(appliedCount: number, instant: boolean): boolean {
  if (appliedCount <= 0 || instant) return false;
  return appliedCount === 1 || appliedCount % VIEWPORT_FOLLOW_EVERY === 0;
}

function probeMindmap(target: AcrTarget): AcrProbeState {
  if (!target.resourceId) return 'closed';
  const storeApi = getMindMapStoreForResource(target.resourceId);
  const state = storeApi?.getState();
  if (!state || state.mindmapId !== target.resourceId) {
    // R1-07 probeTarget 目前仅采纳 driver 的 dirty/hot；closed 会被忽略（见进度报告）。
    return 'closed';
  }

  // probe 无 ops：editingNodeId 非空即报 hot（保守）。
  // apply 内再按「是否属于本批锚点集合」收紧 suggestion 判定。
  if (state.editingNodeId) {
    return 'hot';
  }
  if (state.isDirty) {
    return 'dirty';
  }
  return 'clean';
}

/**
 * apply 入口的 hot 判定：editingNodeId 非空且属于本批操作锚点集合。
 * probe() 无 ops 时若 editingNodeId 非空即 hot（保守，避免破坏性写入撞编辑中节点）。
 */
function isHotForOps(storeApi: MindMapStoreApi, ops: AgentOp[]): boolean {
  const { editingNodeId } = storeApi.getState();
  if (!editingNodeId) return false;
  const targets = collectTargetNodeIds(ops);
  if (targets.size === 0) return true;
  return targets.has(editingNodeId);
}

function getTreeDepth(root: MindMapNode, targetId: string, depth = 0): number {
  if (root.id === targetId) return depth;
  for (const child of root.children) {
    const found = getTreeDepth(child, targetId, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

function getTreeHeight(root: MindMapNode): number {
  let height = 0;
  for (const child of root.children) {
    height = Math.max(height, 1 + getTreeHeight(child));
  }
  return height;
}

function resolveFailureReason(
  storeApi: MindMapStoreApi,
  op: AgentOp,
  anchor: MindmapOpAnchor,
): string | null {
  const root = storeApi.getState().document.root;
  switch (op.kind) {
    case 'add_node': {
      if (!anchor.parent_id) return '缺少 parent_id';
      if (!findNodeById(root, anchor.parent_id)) {
        return `父节点 ${anchor.parent_id} 不存在`;
      }
      return null;
    }
    case 'update_node':
    case 'delete_node': {
      if (!anchor.node_id) return '缺少 node_id';
      if (!findNodeById(root, anchor.node_id)) {
        return `节点 ${anchor.node_id} 不存在`;
      }
      if (op.kind === 'delete_node' && root.id === anchor.node_id) {
        return '不能删除根节点';
      }
      return null;
    }
    case 'move_node': {
      if (!anchor.node_id) return '缺少 node_id';
      if (!anchor.new_parent_id) return '缺少 new_parent_id';
      if (!findNodeById(root, anchor.node_id)) {
        return `节点 ${anchor.node_id} 不存在`;
      }
      if (!findNodeById(root, anchor.new_parent_id)) {
        return `新父节点 ${anchor.new_parent_id} 不存在`;
      }
      if (root.id === anchor.node_id) return '不能移动根节点';
      if (anchor.node_id === anchor.new_parent_id) return '不能把节点移动到自身';
      if (isDescendantOf(root, anchor.node_id, anchor.new_parent_id)) {
        return '不能把节点移动到自己的后代';
      }
      const movingNode = findNodeById(root, anchor.node_id);
      const nextParentDepth = getTreeDepth(root, anchor.new_parent_id);
      if (
        movingNode &&
        nextParentDepth + 1 + getTreeHeight(movingNode) >= MAX_MINDMAP_DEPTH
      ) {
        return `移动后节点深度会达到或超过 ${MAX_MINDMAP_DEPTH}`;
      }
      return null;
    }
    default:
      return `未知操作 kind=${op.kind}`;
  }
}

function applyOneOp(
  run: AcrRunContext,
  storeApi: MindMapStoreApi,
  resourceId: string,
  op: AgentOp,
): { entityId: string | null; ok: boolean; reason?: string } {
  const anchor = parseAnchor(op);
  const payload = parsePayload(op);
  const fail = resolveFailureReason(storeApi, op, anchor);
  if (fail) {
    return { entityId: null, ok: false, reason: fail };
  }

  const skipOpts = { skipHistory: true } as const;
  const assertResource = () => {
    if (storeApi.getState().mindmapId !== resourceId) {
      throw new Error(`导图 ${resourceId} 已不再由原 store 持有`);
    }
  };

  switch (op.kind) {
    case 'add_node': {
      const parentId = anchor.parent_id!;
      const index = payload.index;
      const data = payload.data ?? {};
      const validation = validateMindmapSubtreeInput(
        storeApi.getState().document.root,
        parentId,
        data.children,
      );
      if (!validation.ok) {
        return {
          entityId: null,
          ok: false,
          reason: validation.reason ?? '嵌套 children 校验失败',
        };
      }

      const nodeData: Omit<MindMapNode, 'id'> = {
        text: typeof data.text === 'string' ? data.text : '',
        children: validation.forest,
      };
      if (typeof data.note === 'string') nodeData.note = data.note;
      if (typeof data.collapsed === 'boolean') nodeData.collapsed = data.collapsed;
      if (typeof data.completed === 'boolean') nodeData.completed = data.completed;
      const style = cloneNodeStyle(data.style);
      if (style) nodeData.style = style;
      const blankedRanges = cloneBlankedRanges(data.blankedRanges);
      if (blankedRanges) nodeData.blankedRanges = blankedRanges;
      const refs = cloneNodeRefs(data.refs);
      if (refs) nodeData.refs = refs;

      const newId = storeApi.getState().agentAddSubtree(parentId, nodeData, index);
      if (!newId) {
        return { entityId: null, ok: false, reason: '添加节点失败（深度/数量限制）' };
      }

      run.ledger.record(
        run.runId,
        () => {
          assertResource();
          storeApi.getState().agentDeleteNode(newId);
        },
        op.label,
      );
      return { entityId: newId, ok: true };
    }

    case 'update_node': {
      const nodeId = anchor.node_id!;
      const node = findNodeById(storeApi.getState().document.root, nodeId)!;
      const before = snapshotNodeFields(node);
      const patch = payload.patch ?? {};
      storeApi.getState().updateNode(nodeId, patch, skipOpts);
      run.ledger.record(
        run.runId,
        () => {
          assertResource();
          if (!findNodeById(storeApi.getState().document.root, nodeId)) {
            throw new Error(`撤销更新失败：节点 ${nodeId} 不存在`);
          }
          storeApi.getState().updateNode(nodeId, before, skipOpts);
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    case 'delete_node': {
      const nodeId = anchor.node_id!;
      const root = storeApi.getState().document.root;
      const node = findNodeById(root, nodeId)!;
      const parent = findParentNode(root, nodeId);
      if (!parent) {
        return { entityId: null, ok: false, reason: '找不到父节点' };
      }
      const index = parent.children.findIndex((c) => c.id === nodeId);
      const snapshot = deepCloneNode(node);
      const parentId = parent.id;
      storeApi.getState().agentDeleteNode(nodeId);
      run.ledger.record(
        run.runId,
        () => {
          assertResource();
          if (!findNodeById(storeApi.getState().document.root, parentId)) {
            throw new Error(`撤销删除失败：父节点 ${parentId} 不存在`);
          }
          storeApi.getState().agentInsertSubtree(parentId, snapshot, index);
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    case 'move_node': {
      const nodeId = anchor.node_id!;
      const newParentId = anchor.new_parent_id!;
      const root = storeApi.getState().document.root;
      const parent = findParentNode(root, nodeId);
      if (!parent) {
        return { entityId: null, ok: false, reason: '找不到原父节点' };
      }
      const oldParentId = parent.id;
      const oldIndex = parent.children.findIndex((c) => c.id === nodeId);
      const nextParent = findNodeById(root, newParentId);
      const targetIndex =
        typeof payload.index === 'number'
          ? payload.index
          : (nextParent?.children.length ?? 0);

      if (!storeApi.getState().agentMoveNode(nodeId, newParentId, targetIndex)) {
        return { entityId: null, ok: false, reason: '移动节点失败' };
      }
      run.ledger.record(
        run.runId,
        () => {
          assertResource();
          if (!storeApi.getState().agentMoveNode(nodeId, oldParentId, oldIndex)) {
            throw new Error(`撤销移动失败：节点 ${nodeId} 无法返回原位置`);
          }
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    default:
      return { entityId: null, ok: false, reason: `未知操作 kind=${op.kind}` };
  }
}

async function applyMindmap(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
  const totalOps = ops.length;
  const receipt = emptyReceipt(totalOps, 'frontend');
  const runState: ActiveRunState = { aborted: false, receipt };
  activeRuns.set(run.runId, runState);

  const resourceId = run.target.resourceId;
  const storeApi = resourceId ? getMindMapStoreForResource(resourceId) : null;
  const initialState = storeApi?.getState();
  if (!resourceId || !storeApi || initialState?.mindmapId !== resourceId) {
    receipt.status = 'failed';
    receipt.mode = 'frontend';
    receipt.undone = ops.map((op) => op.label);
    receipt.message =
      '导图 store 未加载目标资源（mindmapId≠resourceId 或未打开），无法前端演出；请回落后端路径';
    activeRuns.delete(run.runId);
    return receipt;
  }

  // destructive + dirty/hot → v1 拒绝式 suggestion（DESIGN §5.1 / §4.1；R2-02 否决升级预览）
  const probeState = initialState.isDirty
    ? 'dirty'
    : isHotForOps(storeApi, ops)
      ? 'hot'
      : 'clean';
  if (batchHasDestructive(ops) && (probeState === 'dirty' || probeState === 'hot')) {
    receipt.status = 'completed';
    receipt.mode = 'suggestion';
    receipt.suggestionPending = true;
    receipt.undone = ops.map((op) => op.label);
    receipt.message = SUGGESTION_MESSAGE;
    activeRuns.delete(run.runId);
    return receipt;
  }

  const instant = run.pacing.profile.instant === true;
  let lastFollowedEntityId: string | null = null;

  for (let i = 0; i < ops.length; i++) {
    if (runState.aborted) {
      receipt.status = 'cancelled';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(ops[j].label);
      }
      receipt.message = '已中止（abort）';
      break;
    }

    const pause = await run.checkPaused();
    if (pause === 'abort' || runState.aborted) {
      receipt.status = 'cancelled';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(ops[j].label);
      }
      receipt.message = '已中止（用户停止或取消）';
      break;
    }

    if (storeApi.getState().mindmapId !== resourceId) {
      receipt.status = receipt.applied > 0 ? 'partial' : 'failed';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(`${ops[j].label}（目标资源已切换）`);
      }
      receipt.message = '目标导图在执行期间已切换，剩余操作未应用';
      break;
    }

    const op = ops[i];
    const step = i + 1;
    run.reportProgress(step, totalOps, op.label);

    const result = applyOneOp(run, storeApi, resourceId, op);
    if (!result.ok) {
      const reason = result.reason ?? '锚点解析失败';
      receipt.undone.push(`${op.label}（${reason}）`);
      run.reportProgress(step, totalOps, `跳过：${op.label} — ${reason}`);
      await run.pacing.tick();
      continue;
    }

    const entityId = result.entityId!;
    receipt.applied += 1;
    receipt.done.push(op.label);
    if (!receipt.entityIds.includes(entityId)) {
      receipt.entityIds.push(entityId);
    }

    // 每 op 入场动画 + 展开路径；视口跟随节流（禁每 op fitView）
    markEntering(storeApi, [entityId]);
    storeApi.getState().expandToNode(entityId, { silent: true });

    if (shouldFollowViewport(receipt.applied, instant)) {
      storeApi.getState().setFocusedNodeId(entityId);
      lastFollowedEntityId = entityId;
    }

    run.reportProgress(step, totalOps, op.label, entityId);
    await run.pacing.tick();
  }

  // 收尾：保证焦点落在最后成功实体；非 instant 再请求一次 fitView（DESIGN §4.3）
  if (receipt.applied > 0 && storeApi.getState().mindmapId === resourceId) {
    const lastEntity = receipt.entityIds[receipt.entityIds.length - 1];
    if (lastEntity && lastEntity !== lastFollowedEntityId) {
      storeApi.getState().setFocusedNodeId(lastEntity);
    }
    if (!instant) {
      storeApi.getState().requestAgentFitView();
    }
  }

  if (receipt.status === 'completed') {
    if (receipt.applied === 0 && receipt.undone.length > 0) {
      receipt.status = 'failed';
      receipt.message = '全部操作未能应用（锚点缺失或限制）';
    } else if (receipt.undone.length > 0) {
      receipt.status = 'partial';
      receipt.message = '部分操作已应用（自动保存）；未执行项见 undone';
    } else {
      receipt.message = '已应用（自动保存）';
    }
  } else if (receipt.status === 'cancelled' && receipt.applied > 0) {
    // partial 语义：已做 + 未做
    receipt.status = 'partial';
  }

  runState.receipt = { ...receipt };
  activeRuns.delete(run.runId);
  return withUserPatch(receipt, TYPE_ID);
}

function abortMindmap(runId: string): AcrReceipt {
  const state = activeRuns.get(runId);
  if (state) {
    state.aborted = true;
    const receipt: AcrReceipt = {
      ...state.receipt,
      status: 'partial',
      message: state.receipt.message ?? '已中止（abort）',
    };
    // 未执行的 ops 由 apply 循环退出时补 undone；此处返回当前累计
    return withUserPatch(receipt, TYPE_ID);
  }
  return withUserPatch(
    {
      status: 'cancelled',
      mode: 'frontend',
      applied: 0,
      totalOps: 0,
      entityIds: [],
      done: [],
      undone: [],
      message: '无活跃 run',
    },
    TYPE_ID,
  );
}

export const mindmapDriver: CollabDriver = {
  typeId: TYPE_ID,
  probe: probeMindmap,
  apply: applyMindmap,
  abort: abortMindmap,
};

export function registerMindmapDriver(stage: StageManagerApi): void {
  stage.registerDriver(mindmapDriver);
}
