/**
 * ACR 导图建议暂存与幽灵分支拆解（Ghost Branch Proposal Store）
 *
 * suggestion 屏障、显式提案或干净窗口大规模结构重组命中时，driver 把待审阅
 * ops 暂存到这里，并按分支独立拆解为 GhostProposalBranch[]，支持画布与大纲
 * 逐分支采纳/放弃，以及全部采纳后的 5 分钟可逆版本检查点（AcceptedMindmapCheckpoint）。
 */

import type { MindMapDocument } from '@/features/mindmap/types';
import type { AgentOp } from '@/features/workbench/agent/types';

export type GhostBranchKind =
  | 'add_branch'
  | 'modify_node'
  | 'remove_subtree'
  | 'move_branch';

export type MindmapSuggestionReason =
  | 'dirty_or_hot'
  | 'clean_structural'
  | 'explicit_proposal';

export interface GhostProposalBranch {
  /** Deterministic branch ID within a suggestion: e.g. `gbr_${suggestionId}_${index}` */
  branchId: string;
  kind: GhostBranchKind;
  /** Existing node ID in document.root where this proposal anchors (parent_id for add_branch, node_id otherwise) */
  anchorNodeId: string;
  /** Destination parent ID when kind === 'move_branch' */
  targetParentId?: string;
  /** Indices into `suggestion.ops` belonging to this independent branch/unit */
  opIndices: number[];
  ops: AgentOp[];
  /** Concise human summary for Outline/hover badge */
  summaryLabel: string;
  /** Count of nodes added/affected in this branch (including nested data.children) */
  affectedNodeCount: number;
}

export interface MindmapAgentSuggestion {
  id: string;
  /** 原 ACR run id（回执关联用） */
  runId: string;
  mindmapId: string;
  windowId: string | null;
  /** 暂存的待审阅 ops */
  ops: AgentOp[];
  /** Decomposed independent branches for per-branch accept/reject on Canvas & Outline */
  branches: GhostProposalBranch[];
  /** Reason proposal entered Ghost review */
  reason?: MindmapSuggestionReason;
  /** Document revision at proposal creation / last accepted branch. */
  documentVersion?: number;
  createdAt: number;
}

export interface AcceptedMindmapCheckpoint {
  checkpointId: string;
  suggestionId: string;
  mindmapId: string;
  windowId: string | null;
  /** Server `mindmap_versions.versionId` captured right before applying AI ops (null in mock/offline tests) */
  preAcceptVersionId: string | null;
  /** Deep-cloned pre-accept MindMapDocument for instant 0ms UI rollback + fallback save */
  preAcceptDocument: MindMapDocument;
  /** Document `_documentVersion` immediately after accept completed (detects subsequent user edits) */
  postAcceptDocVersion: number;
  appliedCount: number;
  acceptedAt: number;
}

export type StashMindmapSuggestionInput = Omit<
  MindmapAgentSuggestion,
  'id' | 'createdAt' | 'branches'
> & {
  branches?: GhostProposalBranch[];
};

const suggestions = new Map<string, MindmapAgentSuggestion>();
const checkpoints = new Map<string, AcceptedMindmapCheckpoint>();

/** 暂存建议 TTL：30 分钟惰性过期 */
export const SUGGESTION_TTL_MS = 30 * 60 * 1000;

/** 采纳后可逆检查点 TTL：5 分钟惰性过期 */
export const CHECKPOINT_TTL_MS = 5 * 60 * 1000;

type Listener = (mindmapId: string) => void;
const listeners = new Set<Listener>();

function notify(mindmapId: string): void {
  for (const fn of listeners) fn(mindmapId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function collectProposedDataSubtree(data: Record<string, unknown> | null): {
  ids: string[];
  count: number;
} {
  if (!data) return { ids: [], count: 1 };
  const ids: string[] = [];
  if (typeof data.id === 'string' && data.id.trim().length > 0) {
    ids.push(data.id);
  }
  let count = 1;
  const seen = new WeakSet<object>();
  seen.add(data);

  const visitChildren = (childrenRaw: unknown): void => {
    if (!Array.isArray(childrenRaw)) return;
    for (const item of childrenRaw) {
      const rec = asRecord(item);
      if (!rec || seen.has(rec)) continue;
      seen.add(rec);
      count += 1;
      if (typeof rec.id === 'string' && rec.id.trim().length > 0) {
        ids.push(rec.id);
      }
      visitChildren(rec.children);
    }
  };

  visitChildren(data.children);
  return { ids, count };
}

/**
 * 将一批 AgentOp 拆解为彼此独立可采纳/放弃的 GhostProposalBranch[]：
 * 1. 挂载在既有节点上的 add_node 各自成为独立 add_branch；后续引用其新增子树节点 ID 的 op 归并至同一分支。
 * 2. 针对同一既有 node_id 的多条 update_node 合并为一个 modify_node 分支。
 * 3. delete_node 形成 remove_subtree 分支。
 * 4. move_node 形成 move_branch 分支。
 */
export function decomposeSuggestionBranches(
  ops: AgentOp[],
  suggestionId = 'mms',
): GhostProposalBranch[] {
  const branches: GhostProposalBranch[] = [];
  const proposedIdToBranchIdx = new Map<string, number>();
  const modifyBranchByNodeId = new Map<string, number>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const anchor = asRecord(op.anchor) ?? {};
    const payload = asRecord(op.payload) ?? {};
    const nodeId = typeof anchor.node_id === 'string' ? anchor.node_id : '';
    const parentId = typeof anchor.parent_id === 'string' ? anchor.parent_id : '';
    const newParentId = typeof anchor.new_parent_id === 'string' ? anchor.new_parent_id : undefined;

    if (op.kind === 'add_node') {
      const data = asRecord(payload.data);
      const { ids, count } = collectProposedDataSubtree(data);
      const ownerBranchIdx = parentId ? proposedIdToBranchIdx.get(parentId) : undefined;

      if (ownerBranchIdx !== undefined) {
        const owner = branches[ownerBranchIdx];
        owner.opIndices.push(i);
        owner.ops.push(op);
        owner.affectedNodeCount += count;
        for (const id of ids) proposedIdToBranchIdx.set(id, ownerBranchIdx);
        continue;
      }

      const branchIdx = branches.length;
      const text = typeof data?.text === 'string' && data.text.trim().length > 0
        ? data.text.trim()
        : op.label;
      branches.push({
        branchId: `gbr_${suggestionId}_${branchIdx}`,
        kind: 'add_branch',
        anchorNodeId: parentId,
        opIndices: [i],
        ops: [op],
        summaryLabel: text,
        affectedNodeCount: count,
      });
      for (const id of ids) proposedIdToBranchIdx.set(id, branchIdx);
      continue;
    }

    const referencedProposedIdx =
      (nodeId ? proposedIdToBranchIdx.get(nodeId) : undefined) ??
      (newParentId ? proposedIdToBranchIdx.get(newParentId) : undefined);

    if (referencedProposedIdx !== undefined) {
      const owner = branches[referencedProposedIdx];
      owner.opIndices.push(i);
      owner.ops.push(op);
      continue;
    }

    if (op.kind === 'delete_node') {
      const branchIdx = branches.length;
      branches.push({
        branchId: `gbr_${suggestionId}_${branchIdx}`,
        kind: 'remove_subtree',
        anchorNodeId: nodeId,
        opIndices: [i],
        ops: [op],
        summaryLabel: op.label || nodeId,
        affectedNodeCount: 1,
      });
      continue;
    }

    if (op.kind === 'move_node') {
      const branchIdx = branches.length;
      branches.push({
        branchId: `gbr_${suggestionId}_${branchIdx}`,
        kind: 'move_branch',
        anchorNodeId: nodeId,
        targetParentId: newParentId,
        opIndices: [i],
        ops: [op],
        summaryLabel: op.label || nodeId,
        affectedNodeCount: 1,
      });
      continue;
    }

    // update_node 及其他单节点补丁：同 node_id 合并为一个 modify_node 分支
    const patch = asRecord(payload.patch);
    const patchText =
      typeof patch?.text === 'string' && patch.text.trim().length > 0
        ? patch.text.trim()
        : undefined;

    if (nodeId && modifyBranchByNodeId.has(nodeId)) {
      const existingIdx = modifyBranchByNodeId.get(nodeId)!;
      const existing = branches[existingIdx];
      existing.opIndices.push(i);
      existing.ops.push(op);
      if (patchText) {
        existing.summaryLabel = patchText;
      }
      continue;
    }

    const branchIdx = branches.length;
    branches.push({
      branchId: `gbr_${suggestionId}_${branchIdx}`,
      kind: 'modify_node',
      anchorNodeId: nodeId,
      opIndices: [i],
      ops: [op],
      summaryLabel: patchText ?? (op.label || nodeId),
      affectedNodeCount: 1,
    });
    if (nodeId) {
      modifyBranchByNodeId.set(nodeId, branchIdx);
    }
  }

  return branches;
}

export function subscribeMindmapSuggestions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function stashMindmapSuggestion(
  entry: StashMindmapSuggestionInput,
): MindmapAgentSuggestion {
  const id = `mms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const suggestion: MindmapAgentSuggestion = {
    ...entry,
    id,
    branches: entry.branches ?? decomposeSuggestionBranches(entry.ops, id),
    createdAt: Date.now(),
  };
  checkpoints.delete(entry.mindmapId);
  suggestions.set(entry.mindmapId, suggestion);
  notify(entry.mindmapId);
  return suggestion;
}

export function getMindmapSuggestion(mindmapId: string): MindmapAgentSuggestion | null {
  const entry = suggestions.get(mindmapId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SUGGESTION_TTL_MS) {
    suggestions.delete(mindmapId);
    notify(mindmapId);
    return null;
  }
  return entry;
}

export function clearMindmapSuggestion(mindmapId: string): void {
  if (suggestions.delete(mindmapId)) notify(mindmapId);
}

export function updateMindmapSuggestionRevision(mindmapId: string, suggestionId: string, version: number): void {
  const current = suggestions.get(mindmapId);
  if (current?.id === suggestionId) {
    suggestions.set(mindmapId, { ...current, documentVersion: version });
    notify(mindmapId);
  }
}

export function removeMindmapSuggestionBranch(
  mindmapId: string,
  suggestionId: string,
  branchId: string,
): MindmapAgentSuggestion | null {
  const current = getMindmapSuggestion(mindmapId);
  if (!current || current.id !== suggestionId) return null;
  const targetBranch = current.branches.find((b) => b.branchId === branchId);
  if (!targetBranch) return current;

  const removedIndices = new Set(targetBranch.opIndices);
  const remainingOps = current.ops.filter((_, idx) => !removedIndices.has(idx));
  if (remainingOps.length === 0) {
    suggestions.delete(mindmapId);
    notify(mindmapId);
    return null;
  }

  const indexMap = new Map<number, number>();
  current.ops.forEach((_, index) => {
    if (!removedIndices.has(index)) indexMap.set(index, indexMap.size);
  });
  const nextSuggestion: MindmapAgentSuggestion = {
    ...current,
    ops: remainingOps,
    // Keep stable branch IDs: renumbering makes an outstanding click target a different branch.
    branches: current.branches.filter((branch) => branch.branchId !== branchId).map((branch) => ({
      ...branch,
      opIndices: branch.opIndices.map((index) => indexMap.get(index)!),
    })),
  };
  suggestions.set(mindmapId, nextSuggestion);
  notify(mindmapId);
  return nextSuggestion;
}

export function setAcceptedMindmapCheckpoint(entry: AcceptedMindmapCheckpoint): void {
  checkpoints.set(entry.mindmapId, entry);
  notify(entry.mindmapId);
}

export function getAcceptedMindmapCheckpoint(mindmapId: string): AcceptedMindmapCheckpoint | null {
  const entry = checkpoints.get(mindmapId);
  if (!entry) return null;
  if (Date.now() - entry.acceptedAt > CHECKPOINT_TTL_MS) {
    checkpoints.delete(mindmapId);
    notify(mindmapId);
    return null;
  }
  return entry;
}

export function clearAcceptedMindmapCheckpoint(mindmapId: string): void {
  if (checkpoints.delete(mindmapId)) notify(mindmapId);
}

/** 测试用 */
export function __clearAllMindmapSuggestions(): void {
  const ids = new Set<string>([...suggestions.keys(), ...checkpoints.keys()]);
  suggestions.clear();
  checkpoints.clear();
  for (const id of ids) notify(id);
}

/** op 列表 -> diff 摘要计数（确认条人读用；直接按 kind 统计） */
export function summarizeSuggestionOps(ops: AgentOp[]): {
  added: number;
  removed: number;
  updated: number;
  moved: number;
} {
  let added = 0;
  let removed = 0;
  let updated = 0;
  let moved = 0;
  for (const op of ops) {
    switch (op.kind) {
      case 'add_node':
        added += 1;
        break;
      case 'delete_node':
        removed += 1;
        break;
      case 'move_node':
        moved += 1;
        break;
      default:
        // update_node 及其余（样式/备注等）归入「修改」
        updated += 1;
    }
  }
  return { added, removed, updated, moved };
}

export interface MindmapSuggestionApplyResult { applied: number; failed: string[]; saved: boolean }
interface SuggestionActions {
  acceptMindmapSuggestion(id: string, mapId: string): Promise<MindmapSuggestionApplyResult | null>;
  acceptMindmapSuggestionBranch(id: string, mapId: string, branchId: string): Promise<MindmapSuggestionApplyResult | null>;
  rejectMindmapSuggestionBranch(id: string, mapId: string, branchId: string): boolean;
  dismissMindmapSuggestion(mapId: string): void;
  revertLastAcceptedMindmapSuggestion(mapId: string): Promise<boolean>;
}
let actions: SuggestionActions | null = null;
export function registerMindmapSuggestionActions(value: SuggestionActions): void { actions = value; }
export const acceptMindmapSuggestion: SuggestionActions['acceptMindmapSuggestion'] = (...args) =>
  actions?.acceptMindmapSuggestion(...args) ?? Promise.resolve(null);
export const acceptMindmapSuggestionBranch: SuggestionActions['acceptMindmapSuggestionBranch'] = (...args) =>
  actions?.acceptMindmapSuggestionBranch(...args) ?? Promise.resolve(null);
export const rejectMindmapSuggestionBranch: SuggestionActions['rejectMindmapSuggestionBranch'] = (...args) =>
  actions?.rejectMindmapSuggestionBranch(...args) ?? false;
export const dismissMindmapSuggestion: SuggestionActions['dismissMindmapSuggestion'] = (...args) =>
  actions?.dismissMindmapSuggestion(...args);
export const revertLastAcceptedMindmapSuggestion: SuggestionActions['revertLastAcceptedMindmapSuggestion'] = (...args) =>
  actions?.revertLastAcceptedMindmapSuggestion(...args) ?? Promise.resolve(false);
