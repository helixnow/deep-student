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
 *   - 单例 store：mindmapId≠resourceId → closed / apply failed（双窗防御）
 *
 * 约束：单例 useMindMapStore——若 mindmapId !== target.resourceId 视为 closed
 *（窗口可能在，但 store 加载的是别的图）。
 */
import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapNode, UpdateNodeParams } from '@/features/mindmap/types';
import { findNodeById, findParentNode } from '@/features/mindmap/utils/node/find';
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
  data?: Partial<MindMapNode> & { text?: string; children?: MindMapNode[] };
  index?: number;
}

/** 活跃 run 的停止旗标与累计回执（abort 路径） */
interface ActiveRunState {
  aborted: boolean;
  receipt: AcrReceipt;
}

const activeRuns = new Map<string, ActiveRunState>();
const enteringTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

function markEntering(ids: string[]): void {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  useMindMapStore.getState().markAgentEntering(unique);
  for (const id of unique) {
    const prev = enteringTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      enteringTimers.delete(id);
      useMindMapStore.getState().clearAgentEntering([id]);
    }, AGENT_ENTERING_TTL_MS);
    enteringTimers.set(id, timer);
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
  const state = useMindMapStore.getState();
  if (!target.resourceId || !state.mindmapId || state.mindmapId !== target.resourceId) {
    // 单例 store：窗口可能开着但加载的是别的图 → 对本 target 视为 closed。
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
function isHotForOps(ops: AgentOp[]): boolean {
  const { editingNodeId } = useMindMapStore.getState();
  if (!editingNodeId) return false;
  const targets = collectTargetNodeIds(ops);
  if (targets.size === 0) return true;
  return targets.has(editingNodeId);
}

function resolveFailureReason(op: AgentOp, anchor: MindmapOpAnchor): string | null {
  const root = useMindMapStore.getState().document.root;
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
      return null;
    }
    default:
      return `未知操作 kind=${op.kind}`;
  }
}

function applyOneOp(
  run: AcrRunContext,
  op: AgentOp,
): { entityId: string | null; ok: boolean; reason?: string } {
  const store = useMindMapStore.getState();
  const anchor = parseAnchor(op);
  const payload = parsePayload(op);
  const fail = resolveFailureReason(op, anchor);
  if (fail) {
    return { entityId: null, ok: false, reason: fail };
  }

  const skipOpts = { skipHistory: true } as const;

  switch (op.kind) {
    case 'add_node': {
      const parentId = anchor.parent_id!;
      const index = payload.index;
      const data = payload.data ?? {};
      const newId = store.agentAddNode(parentId, index);
      if (!newId) {
        return { entityId: null, ok: false, reason: '添加节点失败（深度/数量限制）' };
      }

      const patch: UpdateNodeParams = {};
      if (typeof data.text === 'string') patch.text = data.text;
      if (typeof data.note === 'string') patch.note = data.note;
      if (typeof data.completed === 'boolean') patch.completed = data.completed;
      if (data.style) patch.style = data.style;
      if (data.blankedRanges) patch.blankedRanges = data.blankedRanges;
      if (data.refs) patch.refs = data.refs;
      if (Object.keys(patch).length > 0) {
        useMindMapStore.getState().updateNode(newId, patch, skipOpts);
      }

      // 可选嵌套 children：整棵插入（后端 op_add_node 支持 data.children）
      if (Array.isArray(data.children) && data.children.length > 0) {
        for (const child of data.children) {
          const cloned = deepCloneNode(child as MindMapNode);
          useMindMapStore.getState().agentInsertSubtree(newId, cloned);
        }
      }

      run.ledger.record(
        run.runId,
        () => {
          useMindMapStore.getState().agentDeleteNode(newId);
        },
        op.label,
      );
      return { entityId: newId, ok: true };
    }

    case 'update_node': {
      const nodeId = anchor.node_id!;
      const node = findNodeById(store.document.root, nodeId)!;
      const before = snapshotNodeFields(node);
      const patch = payload.patch ?? {};
      useMindMapStore.getState().updateNode(nodeId, patch, skipOpts);
      run.ledger.record(
        run.runId,
        () => {
          useMindMapStore.getState().updateNode(nodeId, before, skipOpts);
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    case 'delete_node': {
      const nodeId = anchor.node_id!;
      const node = findNodeById(store.document.root, nodeId)!;
      const parent = findParentNode(store.document.root, nodeId);
      if (!parent) {
        return { entityId: null, ok: false, reason: '找不到父节点' };
      }
      const index = parent.children.findIndex((c) => c.id === nodeId);
      const snapshot = deepCloneNode(node);
      const parentId = parent.id;
      useMindMapStore.getState().agentDeleteNode(nodeId);
      run.ledger.record(
        run.runId,
        () => {
          useMindMapStore.getState().agentInsertSubtree(parentId, snapshot, index);
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    case 'move_node': {
      const nodeId = anchor.node_id!;
      const newParentId = anchor.new_parent_id!;
      const parent = findParentNode(store.document.root, nodeId);
      if (!parent) {
        return { entityId: null, ok: false, reason: '找不到原父节点' };
      }
      const oldParentId = parent.id;
      const oldIndex = parent.children.findIndex((c) => c.id === nodeId);
      const nextParent = findNodeById(store.document.root, newParentId);
      const targetIndex =
        typeof payload.index === 'number'
          ? payload.index
          : (nextParent?.children.length ?? 0);

      useMindMapStore.getState().agentMoveNode(nodeId, newParentId, targetIndex);
      run.ledger.record(
        run.runId,
        () => {
          useMindMapStore.getState().agentMoveNode(nodeId, oldParentId, oldIndex);
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

  const store = useMindMapStore.getState();
  if (
    !run.target.resourceId ||
    !store.mindmapId ||
    store.mindmapId !== run.target.resourceId
  ) {
    receipt.status = 'failed';
    receipt.mode = 'frontend';
    receipt.undone = ops.map((op) => op.label);
    receipt.message =
      '导图 store 未加载目标资源（mindmapId≠resourceId 或未打开），无法前端演出；请回落后端路径';
    activeRuns.delete(run.runId);
    return receipt;
  }

  // destructive + dirty/hot → v1 拒绝式 suggestion（DESIGN §5.1 / §4.1；R2-02 否决升级预览）
  const probeState = store.isDirty
    ? 'dirty'
    : isHotForOps(ops)
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

    const op = ops[i];
    const step = i + 1;
    run.reportProgress(step, totalOps, op.label);

    const result = applyOneOp(run, op);
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
    markEntering([entityId]);
    useMindMapStore.getState().expandToNode(entityId, { silent: true });

    if (shouldFollowViewport(receipt.applied, instant)) {
      useMindMapStore.getState().setFocusedNodeId(entityId);
      lastFollowedEntityId = entityId;
    }

    run.reportProgress(step, totalOps, op.label, entityId);
    await run.pacing.tick();
  }

  // 收尾：保证焦点落在最后成功实体；非 instant 再请求一次 fitView（DESIGN §4.3）
  if (receipt.applied > 0) {
    const lastEntity = receipt.entityIds[receipt.entityIds.length - 1];
    if (lastEntity && lastEntity !== lastFollowedEntityId) {
      useMindMapStore.getState().setFocusedNodeId(lastEntity);
    }
    if (!instant) {
      useMindMapStore.getState().requestAgentFitView();
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
