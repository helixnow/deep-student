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
import i18n from '@/i18n';
import {
  getMindMapVersions,
  restoreMindMapVersion,
  reconcileMindMapProjectedFlashcards,
  getMindMapStoreForResource,
  getMindMapStoreForWindow,
  syncMindMapAnchorEdges,
  reconcileSummariesWithTree,
  type MindMapDocument,
  type MindMapNode,
  type MindMapStoreApi,
  type VfsMindMap,
} from '@/features/mindmap';
import {
  findNodeById,
  findParentNode,
} from '@/shared/mindmap/find';
import { readCssTimeMs } from '@/shared/utils/cssTime';
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
import {
  applyValidatedOptionalNodeFields,
  asRecord,
  collectSubtreeIds,
  collectTargetNodeIds,
  countProposedBatchNodes,
  deepCloneNode,
  nodeLocation,
  normalizeUpdateNodePatch,
  parseAnchor,
  parsePayload,
  reconcileFilteredInteractionState,
  reconcileRevealedBlanks,
  resolveFailureReason,
  snapshotNodeFields,
  stableValue,
  validateMindmapSubtreeInput,
  type MindmapSubtreeValidationCode,
  type MindmapSubtreeValidationResult,
} from './mindmapDriverValidation';
import {
  stashMindmapSuggestion,
  getMindmapSuggestion,
  clearMindmapSuggestion,
  removeMindmapSuggestionBranch,
  setAcceptedMindmapCheckpoint,
  getAcceptedMindmapCheckpoint,
  clearAcceptedMindmapCheckpoint,
  registerMindmapSuggestionActions,
  updateMindmapSuggestionRevision,
  type AcceptedMindmapCheckpoint,
  type MindmapAgentSuggestion,
  type MindmapSuggestionReason,
} from './mindmapSuggestionStore';

export {
  collectSubtreeIds,
  countProposedBatchNodes,
  snapshotNodeFields,
  validateMindmapSubtreeInput,
  type MindmapSubtreeValidationCode,
  type MindmapSubtreeValidationResult,
};

const TYPE_ID = 'mindmap';
/**
 * 演出优化轮：标记 TTL 从「CSS 动画时长（--mm-agent-*-ms 单源）+ 缓冲」推导。
 * 旧值 entering=3000 远大于动画 260ms——3 秒内节点重挂载（虚拟化/布局切换）
 * 会重播入场动画；收敛到动画时长 + 缓冲即可。
 */
const AGENT_ENTERING_TTL_BUFFER_MS = 440;
const AGENT_UPDATED_TTL_BUFFER_MS = 200;

function agentEnteringTtlMs(): number {
  return readCssTimeMs('--mm-agent-enter-ms', 260) + AGENT_ENTERING_TTL_BUFFER_MS;
}

function agentUpdatedTtlMs(): number {
  return readCssTimeMs('--mm-agent-updated-ms', 900) + AGENT_UPDATED_TTL_BUFFER_MS;
}

/** ACR 4.0 A4：delete_node 退场动画时长回退值（CSS --mm-agent-exit-ms 单源） */
export const AGENT_EXITING_MS = 180;

function agentExitingMs(): number {
  return readCssTimeMs('--mm-agent-exit-ms', AGENT_EXITING_MS);
}
/**
 * DESIGN §4.3：setCenter / 焦点跟随每 3–5 op 节流。
 * R3-02：200 节点生长压测取上限 5，降低 ensureNodeVisible/setCenter 频率。
 */
export const VIEWPORT_FOLLOW_EVERY = 5;

/** 干净窗口触发幽灵分支结构审阅的节点阈值（同时含新增与删除/移动） */
export const GHOST_CLEAN_STRUCTURAL_NODE_THRESHOLD = 6;

export type MindmapGhostReviewPreference = 'auto' | 'always';

let ghostReviewPreference: MindmapGhostReviewPreference = 'auto';

export function getMindmapGhostReviewPreference(): MindmapGhostReviewPreference {
  return ghostReviewPreference;
}

export function setMindmapGhostReviewPreference(pref: MindmapGhostReviewPreference): void {
  ghostReviewPreference = pref;
}

/**
 * P2 人机双写：破坏性 ops 暂存为建议，画布确认条（MindmapAgentSuggestionBar）
 * 裁决——接受经 acceptMindmapSuggestion 合成 instant run 应用，拒绝丢弃。
 * 文案必须明确"不要重复提交"：接受会自动应用暂存 ops，若 LLM 同时按旧
 * 拒绝式语义从后端路径重提，同一批改动会双重应用。
 */
export const SUGGESTION_MESSAGE =
  '目标导图存在未保存编辑或正在编辑，破坏性操作已暂存为建议（suggestionPending=true）：'
  + '画布上已弹出确认条，用户会接受或拒绝，接受时暂存操作会自动应用。'
  + '请勿重复提交同一批操作（会导致双重应用），也不要改走后端数据路径重提；'
  + '如需调整，等用户反馈后再行动。';

/**
 * 写入回执时走 i18n（mindmap:agent.*；语言可运行时切换，故用函数而非模块级常量）。
 * 常量本身保留 zh-CN 原文，作为 defaultValue 兜底与既有测试锚点。
 */
function suggestionMessage(): string {
  return i18n.t('mindmap:agent.suggestion_pending', {
    defaultValue: SUGGESTION_MESSAGE,
  });
}

/** 活跃 run 的停止旗标与累计回执（abort 路径） */
interface ActiveRunState {
  aborted: boolean;
  receipt: AcrReceipt;
}

const activeRuns = new Map<string, ActiveRunState>();

/**
 * 演出优化轮：标记清除合并调度。
 * 旧实现每个 id 各挂一个 setTimeout，到期各自触发一次 store 更新——
 * 画布 enrichedNodes memo 依赖这些瞬态 Set，每次清除都全量重建节点数组。
 * 合并调度把临近到期（CLEAR_SLACK_MS 内）的 id 一次清掉，只触发一次重建。
 */
interface MarkClearScheduler {
  /** id → 到期时刻（重复 mark 顺延） */
  deadlines: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
}

const CLEAR_SLACK_MS = 80;

const enteringSchedulers = new WeakMap<MindMapStoreApi, MarkClearScheduler>();
const updatedSchedulers = new WeakMap<MindMapStoreApi, MarkClearScheduler>();

function pumpScheduler(
  scheduler: MarkClearScheduler,
  clear: (ids: string[]) => void,
): void {
  if (scheduler.timer != null || scheduler.deadlines.size === 0) return;
  let earliest = Infinity;
  scheduler.deadlines.forEach((deadline) => {
    if (deadline < earliest) earliest = deadline;
  });
  const delay = Math.max(0, earliest - Date.now());
  scheduler.timer = setTimeout(() => {
    scheduler.timer = null;
    const cutoff = Date.now() + CLEAR_SLACK_MS;
    const ripe: string[] = [];
    scheduler.deadlines.forEach((deadline, id) => {
      if (deadline <= cutoff) ripe.push(id);
    });
    for (const id of ripe) scheduler.deadlines.delete(id);
    if (ripe.length > 0) clear(ripe);
    pumpScheduler(scheduler, clear);
  }, delay);
}

function markWithTtl(
  schedulers: WeakMap<MindMapStoreApi, MarkClearScheduler>,
  storeApi: MindMapStoreApi,
  ids: string[],
  ttlMs: number,
  mark: (ids: string[]) => void,
  clear: (ids: string[]) => void,
): void {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  mark(unique);
  let scheduler = schedulers.get(storeApi);
  if (!scheduler) {
    scheduler = { deadlines: new Map(), timer: null };
    schedulers.set(storeApi, scheduler);
  }
  const deadline = Date.now() + ttlMs;
  for (const id of unique) scheduler.deadlines.set(id, deadline);
  pumpScheduler(scheduler, clear);
}

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

function markEntering(storeApi: MindMapStoreApi, ids: string[]): void {
  markWithTtl(
    enteringSchedulers,
    storeApi,
    ids,
    agentEnteringTtlMs(),
    (unique) => storeApi.getState().markAgentEntering(unique),
    (ripe) => storeApi.getState().clearAgentEntering(ripe),
  );
}

/** ACR 4.0 A4：update_node 的内容更新高亮（背景 flash，TTL 自动清除） */
function markUpdated(storeApi: MindMapStoreApi, ids: string[]): void {
  markWithTtl(
    updatedSchedulers,
    storeApi,
    ids,
    agentUpdatedTtlMs(),
    (unique) => storeApi.getState().markAgentUpdated(unique),
    (ripe) => storeApi.getState().clearAgentUpdated(ripe),
  );
}

/**
 * ACR 4.0 A4：退场动画等待——分片 setTimeout，片间检查 abort 旗标，
 * 首尾各过一次 checkPaused（pausedByUser 时在此挂起），保证 abort/暂停不悬挂。
 */
async function waitExitAnimation(
  run: AcrRunContext,
  runState: ActiveRunState,
  ms: number,
): Promise<'ok' | 'abort'> {
  const pre = await run.checkPaused();
  if (pre === 'abort' || runState.aborted) return 'abort';

  let remaining = ms;
  while (remaining > 0) {
    if (runState.aborted) return 'abort';
    const slice = Math.min(60, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }

  const post = await run.checkPaused();
  if (post === 'abort' || runState.aborted) return 'abort';
  return 'ok';
}

function isDestructiveOp(op: AgentOp): boolean {
  return op.destructive === true || op.kind === 'delete_node' || op.kind === 'move_node';
}

/** update_node can overwrite text/note/style currently being edited, so it uses the same barrier. */
function requiresUserEditBarrier(op: AgentOp): boolean {
  return isDestructiveOp(op) || op.kind === 'update_node';
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
      throw new Error(
        i18n.t('mindmap:agent.resource_not_held', {
          resourceId,
          defaultValue: '导图 {{resourceId}} 已不再由原 store 持有',
        }),
      );
    }
  };

  switch (op.kind) {
    case 'add_node': {
      const parentId = anchor.parent_id!;
      const index = payload.index;
      const data = payload.data ?? {};
      const explicitId =
        typeof data.id === 'string' && data.id.trim().length > 0 ? data.id.trim() : null;
      const validation = validateMindmapSubtreeInput(
        storeApi.getState().document.root,
        parentId,
        data.children,
        explicitId ? [explicitId] : undefined,
      );
      if (!validation.ok) {
        return {
          entityId: null,
          ok: false,
          reason:
            validation.reason ??
            i18n.t('mindmap:agent.nested_children_validation_failed', {
              defaultValue: '嵌套 children 校验失败',
            }),
        };
      }

      const nodeData: Omit<MindMapNode, 'id'> = {
        text: typeof data.text === 'string' ? data.text : '',
        children: validation.forest,
      };
      applyValidatedOptionalNodeFields(nodeData, data);

      let newId = '';
      if (explicitId && !findNodeById(storeApi.getState().document.root, explicitId)) {
        const prevFocused = storeApi.getState().focusedNodeId;
        const explicitNode: MindMapNode = { ...nodeData, id: explicitId };
        storeApi.getState().agentInsertSubtree(parentId, explicitNode, index);
        if (findNodeById(storeApi.getState().document.root, explicitId)) {
          if (storeApi.getState().focusedNodeId !== prevFocused) {
            storeApi.getState().setFocusedNodeId(prevFocused);
          }
          newId = explicitId;
        }
      } else {
        newId = storeApi.getState().agentAddSubtree(parentId, nodeData, index);
      }
      if (!newId) {
        return {
          entityId: null,
          ok: false,
          reason: i18n.t('mindmap:agent.add_node_failed', {
            defaultValue: '添加节点失败（深度/数量限制）',
          }),
        };
      }
      const expectedAdded = deepCloneNode(
        findNodeById(storeApi.getState().document.root, newId)!,
      );

      run.ledger.record(
        run.runId,
        async () => {
          assertResource();
          const current = findNodeById(storeApi.getState().document.root, newId);
          if (current) {
            if (stableValue(current) !== stableValue(expectedAdded)) {
              throw new Error(
                i18n.t('mindmap:agent.undo_add_conflict', {
                  id: newId,
                  defaultValue: '撤销添加冲突：节点 {{id}} 已被继续编辑',
                }),
              );
            }
            storeApi.getState().agentDeleteNode(newId);
          }
          if (!(await storeApi.getState().save())) {
            throw new Error(
              i18n.t('mindmap:agent.undo_add_save_failed', {
                defaultValue: '撤销添加失败：更改未能保存',
              }),
            );
          }
        },
        op.label,
      );
      return { entityId: newId, ok: true };
    }

    case 'update_node': {
      const nodeId = anchor.node_id!;
      const node = findNodeById(storeApi.getState().document.root, nodeId)!;
      const before = snapshotNodeFields(node);
      const normalizedPatch = normalizeUpdateNodePatch(node, payload.patch ?? {});
      storeApi.getState().updateNode(nodeId, normalizedPatch, skipOpts);
      const after = snapshotNodeFields(
        findNodeById(storeApi.getState().document.root, nodeId)!,
      );
      run.ledger.record(
        run.runId,
        async () => {
          assertResource();
          const currentNode = findNodeById(storeApi.getState().document.root, nodeId);
          if (!currentNode) {
            throw new Error(
              i18n.t('mindmap:agent.undo_update_missing', {
                id: nodeId,
                defaultValue: '撤销更新失败：节点 {{id}} 不存在',
              }),
            );
          }
          const current = snapshotNodeFields(currentNode);
          if (stableValue(current) === stableValue(before)) {
            if (!(await storeApi.getState().save())) {
              throw new Error(
                i18n.t('mindmap:agent.undo_update_save_failed', {
                  defaultValue: '撤销更新失败：更改未能保存',
                }),
              );
            }
            return;
          }
          if (stableValue(current) !== stableValue(after)) {
            throw new Error(
              i18n.t('mindmap:agent.undo_update_conflict', {
                id: nodeId,
                defaultValue: '撤销更新冲突：节点 {{id}} 已被继续编辑',
              }),
            );
          }
          storeApi.getState().updateNode(nodeId, before, skipOpts);
          if (!(await storeApi.getState().save())) {
            throw new Error(
              i18n.t('mindmap:agent.undo_update_save_failed', {
                defaultValue: '撤销更新失败：更改未能保存',
              }),
            );
          }
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
        return {
          entityId: null,
          ok: false,
          reason: i18n.t('mindmap:agent.parent_missing', {
            defaultValue: '找不到父节点',
          }),
        };
      }
      const index = parent.children.findIndex((c) => c.id === nodeId);
      const snapshot = deepCloneNode(node);
      const parentId = parent.id;
      storeApi.getState().agentDeleteNode(nodeId);
      run.ledger.record(
        run.runId,
        async () => {
          assertResource();
          if (!findNodeById(storeApi.getState().document.root, parentId)) {
            throw new Error(
              i18n.t('mindmap:agent.undo_delete_parent_missing', {
                id: parentId,
                defaultValue: '撤销删除失败：父节点 {{id}} 不存在',
              }),
            );
          }
          const existing = findNodeById(storeApi.getState().document.root, nodeId);
          if (!existing) {
            storeApi.getState().agentInsertSubtree(parentId, snapshot, index);
          } else if (stableValue(existing) !== stableValue(snapshot)) {
            throw new Error(
              i18n.t('mindmap:agent.undo_delete_conflict', {
                id: nodeId,
                defaultValue: '撤销删除冲突：节点 id {{id}} 已被其他内容占用',
              }),
            );
          }
          if (!(await storeApi.getState().save())) {
            throw new Error(
              i18n.t('mindmap:agent.undo_delete_save_failed', {
                defaultValue: '撤销删除失败：更改未能保存',
              }),
            );
          }
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
        return {
          entityId: null,
          ok: false,
          reason: i18n.t('mindmap:agent.old_parent_missing', {
            defaultValue: '找不到原父节点',
          }),
        };
      }
      const oldParentId = parent.id;
      const oldIndex = parent.children.findIndex((c) => c.id === nodeId);
      const nextParent = findNodeById(root, newParentId);
      const targetIndex =
        typeof payload.index === 'number'
          ? payload.index
          : (nextParent?.children.length ?? 0);

      if (!storeApi.getState().agentMoveNode(nodeId, newParentId, targetIndex)) {
        return {
          entityId: null,
          ok: false,
          reason: i18n.t('mindmap:agent.move_node_failed', {
            defaultValue: '移动节点失败',
          }),
        };
      }
      const movedLocation = nodeLocation(storeApi.getState().document.root, nodeId);
      if (!movedLocation) {
        return {
          entityId: null,
          ok: false,
          reason: i18n.t('mindmap:agent.move_location_unconfirmed', {
            defaultValue: '移动后无法确认节点位置',
          }),
        };
      }
      run.ledger.record(
        run.runId,
        async () => {
          assertResource();
          const currentRoot = storeApi.getState().document.root;
          const currentLocation = nodeLocation(currentRoot, nodeId);
          if (!currentLocation) {
            throw new Error(
              i18n.t('mindmap:agent.undo_move_missing', {
                id: nodeId,
                defaultValue: '撤销移动失败：节点 {{id}} 不存在',
              }),
            );
          }
          if (currentLocation.parentId === oldParentId && currentLocation.index === oldIndex) {
            if (!(await storeApi.getState().save())) {
              throw new Error(
                i18n.t('mindmap:agent.undo_move_save_failed', {
                  defaultValue: '撤销移动失败：更改未能保存',
                }),
              );
            }
            return;
          }
          if (
            currentLocation.parentId !== movedLocation.parentId
            || currentLocation.index !== movedLocation.index
          ) {
            throw new Error(
              i18n.t('mindmap:agent.undo_move_conflict', {
                id: nodeId,
                defaultValue: '撤销移动冲突：节点 {{id}} 已被再次移动',
              }),
            );
          }
          if (currentLocation.parentId !== oldParentId || currentLocation.index !== oldIndex) {
            if (!storeApi.getState().agentMoveNode(nodeId, oldParentId, oldIndex)) {
              throw new Error(
                i18n.t('mindmap:agent.undo_move_restore_failed', {
                  id: nodeId,
                  defaultValue: '撤销移动失败：节点 {{id}} 无法返回原位置',
                }),
              );
            }
          }
          if (!(await storeApi.getState().save())) {
            throw new Error(
              i18n.t('mindmap:agent.undo_move_save_failed', {
                defaultValue: '撤销移动失败：更改未能保存',
              }),
            );
          }
        },
        op.label,
      );
      return { entityId: nodeId, ok: true };
    }

    default:
      return {
        entityId: null,
        ok: false,
        reason: i18n.t('mindmap:agent.unknown_op_kind', {
          kind: op.kind,
          defaultValue: '未知操作 kind={{kind}}',
        }),
      };
  }
}

async function applyMindmap(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
  const totalOps = ops.length;
  const receipt = emptyReceipt(totalOps, 'frontend');
  const runState: ActiveRunState = { aborted: false, receipt };
  activeRuns.set(run.runId, runState);

  const resourceId = run.target.resourceId;
  const storeApi = resourceId
    ? run.windowId
      ? getMindMapStoreForWindow(run.windowId, resourceId)
      : getMindMapStoreForResource(resourceId)
    : null;
  const initialState = storeApi?.getState();
  if (!resourceId || !storeApi || initialState?.mindmapId !== resourceId) {
    receipt.status = 'failed';
    receipt.mode = 'frontend';
    receipt.undone = ops.map((op) => op.label);
    receipt.message = i18n.t('mindmap:agent.store_not_loaded', {
      defaultValue:
        '导图 store 未加载目标资源（mindmapId≠resourceId 或未打开），无法前端演出；请回落后端路径',
    });
    activeRuns.delete(run.runId);
    return receipt;
  }

  const instant = run.pacing.profile.instant === true;
  let lastFollowedEntityId: string | null = null;
  const startedDirty = initialState.isDirty;
  let expectedDocumentVersion = initialState._documentVersion;
  let stoppedAtSuggestion = false;
  let savePending = false;
  // 演出优化轮：instant（fast/慢帧降级/reduced-motion）不逐 op 打标记——
  // 大批量时逐 op 标记会触发 N 次瞬态 Set 更新 + 画布全量节点重建；
  // 收集后收尾统一一次标记，即 DESIGN §4.3「fast = 直落终态 + flash」
  const instantEnteredIds: string[] = [];
  const instantUpdatedIds: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    if (runState.aborted) {
      receipt.status = 'cancelled';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(ops[j].label);
      }
      receipt.message = i18n.t('mindmap:agent.aborted', {
        defaultValue: '已中止（abort）',
      });
      break;
    }

    const pause = await run.checkPaused();
    if (pause === 'abort' || runState.aborted) {
      receipt.status = 'cancelled';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(ops[j].label);
      }
      receipt.message = i18n.t('mindmap:agent.aborted_by_user', {
        defaultValue: '已中止（用户停止或取消）',
      });
      break;
    }

    if (storeApi.getState().mindmapId !== resourceId) {
      receipt.status = receipt.applied > 0 ? 'partial' : 'failed';
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(
          i18n.t('mindmap:agent.op_undone_target_switched', {
            label: ops[j].label,
            defaultValue: '{{label}}（目标资源已切换）',
          }),
        );
      }
      receipt.message = i18n.t('mindmap:agent.target_switched', {
        defaultValue: '目标导图在执行期间已切换，剩余操作未应用',
      });
      break;
    }

    const op = ops[i];
    const step = i + 1;

    // 逐 op 决策屏障：
    // 1) 显式幽灵审阅（propose=true 或全局偏好 always）
    // 2) 干净窗口大规模结构重组（首步 i===0、节点数 >= 6 且同时含新增与删除/移动）
    // 3) 用户未保存编辑 / 并发编辑 / 正在编辑目标节点屏障
    const currentState = storeApi.getState();
    const hasConcurrentUserEdit = currentState._documentVersion !== expectedDocumentVersion;
    const explicitProposal =
      (run as { propose?: boolean }).propose === true ||
      getMindmapGhostReviewPreference() === 'always' ||
      asRecord(op.payload)?.propose === true;
    const cleanStructuralProposal =
      i === 0 &&
      !startedDirty &&
      !hasConcurrentUserEdit &&
      !isHotForOps(storeApi, ops) &&
      countProposedBatchNodes(ops) >= GHOST_CLEAN_STRUCTURAL_NODE_THRESHOLD &&
      ops.some((o) => o.kind === 'delete_node' || o.kind === 'move_node') &&
      ops.some((o) => o.kind === 'add_node');
    const dirtyOrHotBarrier =
      requiresUserEditBarrier(op) &&
      (startedDirty || hasConcurrentUserEdit || isHotForOps(storeApi, [op]));

    if (explicitProposal || cleanStructuralProposal || dirtyOrHotBarrier) {
      const reason: MindmapSuggestionReason = explicitProposal
        ? 'explicit_proposal'
        : cleanStructuralProposal
          ? 'clean_structural'
          : 'dirty_or_hot';
      stoppedAtSuggestion = true;
      receipt.mode = 'suggestion';
      receipt.suggestionPending = true;
      stashMindmapSuggestion({
        runId: run.runId,
        mindmapId: resourceId,
        windowId: run.windowId,
        ops: ops.slice(i),
        reason,
        documentVersion: currentState._documentVersion,
      });
      for (let j = i; j < ops.length; j++) {
        receipt.undone.push(ops[j].label);
      }
      receipt.message = suggestionMessage();
      break;
    }

    run.reportProgress(step, totalOps, op.label);

    // ACR 4.0 A4：delete_node 先对整棵子树播退场动画，再真正从 store 删除。
    // instant（fast / reduced-motion 强制 fast）直接删；等待接入 checkPaused/abort。
    if (op.kind === 'delete_node' && !instant) {
      const anchor = parseAnchor(op);
      const rootNow = storeApi.getState().document.root;
      const exitIds =
        anchor.node_id && rootNow.id !== anchor.node_id
          ? collectSubtreeIds(rootNow, anchor.node_id)
          : [];
      if (exitIds.length > 0) {
        storeApi.getState().expandToNode(anchor.node_id!, { silent: true });
        storeApi.getState().markAgentExiting(exitIds);
        const wait = await waitExitAnimation(run, runState, agentExitingMs());
        storeApi.getState().clearAgentExiting(exitIds);
        if (wait === 'abort') {
          runState.aborted = true;
          receipt.status = 'cancelled';
          for (let j = i; j < ops.length; j++) {
            receipt.undone.push(ops[j].label);
          }
          receipt.message = i18n.t('mindmap:agent.aborted_by_user', {
            defaultValue: '已中止（用户停止或取消）',
          });
          break;
        }
        // 动画期间目标导图可能被切换：与循环顶部同语义防御
        if (storeApi.getState().mindmapId !== resourceId) {
          receipt.status = receipt.applied > 0 ? 'partial' : 'failed';
          for (let j = i; j < ops.length; j++) {
            receipt.undone.push(
              i18n.t('mindmap:agent.op_undone_target_switched', {
                label: ops[j].label,
                defaultValue: '{{label}}（目标资源已切换）',
              }),
            );
          }
          receipt.message = i18n.t('mindmap:agent.target_switched', {
            defaultValue: '目标导图在执行期间已切换，剩余操作未应用',
          });
          break;
        }
      }
    }

    const result = applyOneOp(run, storeApi, resourceId, op);
    if (!result.ok) {
      const reason =
        result.reason ??
        i18n.t('mindmap:agent.anchor_resolve_failed', {
          defaultValue: '锚点解析失败',
        });
      receipt.undone.push(
        i18n.t('mindmap:agent.op_undone_with_reason', {
          label: op.label,
          reason,
          defaultValue: '{{label}}（{{reason}}）',
        }),
      );
      run.reportProgress(
        step,
        totalOps,
        i18n.t('mindmap:agent.op_skipped_progress', {
          label: op.label,
          reason,
          defaultValue: '跳过：{{label}} — {{reason}}',
        }),
      );
      await run.pacing.tick();
      continue;
    }

    const entityId = result.entityId!;
    expectedDocumentVersion = storeApi.getState()._documentVersion;
    receipt.applied += 1;
    receipt.done.push(op.label);
    if (!receipt.entityIds.includes(entityId)) {
      receipt.entityIds.push(entityId);
    }

    // 每 op 演出（区分语义）：新增/移动=滑入，更新=背景 flash 高亮，删除已播退场；
    // 展开路径 + 视口跟随节流（禁每 op fitView）；instant 收集待批量标记
    if (op.kind === 'update_node') {
      if (instant) instantUpdatedIds.push(entityId);
      else markUpdated(storeApi, [entityId]);
    } else if (op.kind !== 'delete_node') {
      if (instant) instantEnteredIds.push(entityId);
      else markEntering(storeApi, [entityId]);
    }
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
    // instant 批量标记（一次 store 更新 = 一次画布重建；语义即「直落 + flash」）
    if (instantEnteredIds.length > 0) markEntering(storeApi, instantEnteredIds);
    if (instantUpdatedIds.length > 0) markUpdated(storeApi, instantUpdatedIds);
    const lastEntity = receipt.entityIds[receipt.entityIds.length - 1];
    if (lastEntity && lastEntity !== lastFollowedEntityId) {
      storeApi.getState().setFocusedNodeId(lastEntity);
    }
    if (!instant) {
      storeApi.getState().requestAgentFitView();
    }

    const afterRun = storeApi.getState();
    syncMindMapAnchorEdges(afterRun.mindmapId, afterRun.document.root, { styleId: afterRun.styleId });
    reconcileMindMapProjectedFlashcards(afterRun.mindmapId, afterRun.document.root);

    const saved = await storeApi.getState().save();
    if (!saved) {
      savePending = true;
    } else {
      // 后续成功保存已覆盖此前的当前文档版本，清除临时失败标记。
      savePending = false;
    }
  }

  if (stoppedAtSuggestion) {
    receipt.status = savePending ? 'partial' : 'completed';
    receipt.mode = 'suggestion';
    receipt.suggestionPending = true;
    if (savePending) {
      receipt.message = i18n.t('mindmap:agent.suggestion_save_failed', {
        defaultValue:
          '前序操作已写入当前导图，但保存失败；建议仍等待用户确认，请先重试保存或撤销',
      });
    } else {
      receipt.message = suggestionMessage();
    }
  } else if (receipt.status === 'completed') {
    if (savePending) {
      receipt.status = 'partial';
      receipt.message = i18n.t('mindmap:agent.save_failed', {
        defaultValue: '操作已写入当前导图，但保存失败；请重试保存或撤销',
      });
    } else if (receipt.applied === 0 && receipt.undone.length > 0) {
      receipt.status = 'failed';
      receipt.message = i18n.t('mindmap:agent.all_ops_failed', {
        defaultValue: '全部操作未能应用（锚点缺失或限制）',
      });
    } else if (receipt.undone.length > 0) {
      receipt.status = 'partial';
      receipt.message = i18n.t('mindmap:agent.partially_applied', {
        defaultValue: '部分操作已应用（自动保存）；未执行项见 undone',
      });
    } else {
      receipt.message = i18n.t('mindmap:agent.applied', {
        defaultValue: '已应用（自动保存）',
      });
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
      message:
        state.receipt.message ??
        i18n.t('mindmap:agent.aborted', { defaultValue: '已中止（abort）' }),
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
      message: i18n.t('mindmap:agent.no_active_run', { defaultValue: '无活跃 run' }),
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

// ============================================================================
// P2 人机双写 MVP：暂存建议的裁决（确认条接受/拒绝）
// ============================================================================

export interface MindmapSuggestionApplyResult {
  applied: number;
  /** 应用失败的 op 人读列表（label + reason） */
  failed: string[];
  /** save 是否成功（失败时内容在内存/草稿，不丢） */
  saved: boolean;
  documentVersion?: number;
}

function resolveSuggestionStore(
  mindmapId: string,
  windowId: string | null,
): MindMapStoreApi | null {
  return (
    (windowId ? getMindMapStoreForWindow(windowId, mindmapId) : null) ??
    getMindMapStoreForResource(mindmapId)
  );
}

function createSyntheticAcceptRun(
  runId: string,
  mindmapId: string,
  windowId: string | null,
): AcrRunContext {
  return {
    runId: `${runId}:accept`,
    sessionId: '',
    target: { typeId: TYPE_ID, resourceId: mindmapId },
    windowId,
    pacing: {
      profile: {
        name: 'fast',
        opIntervalMs: 0,
        typeBatchMin: 0,
        typeBatchMax: 0,
        typeIntervalMs: 0,
        instant: true,
      },
      tick: async () => {},
      dispose: () => {},
    },
    reportProgress: () => {},
    checkPaused: async () => 'resume',
    ledger: {
      record: () => {},
      revertRun: async () => true,
      hasRun: () => false,
      sealRun: () => {},
    },
  };
}

async function capturePreAcceptCheckpoint(
  storeApi: MindMapStoreApi,
  suggestion: MindmapAgentSuggestion,
): Promise<AcceptedMindmapCheckpoint> {
  const existing = getAcceptedMindmapCheckpoint(suggestion.mindmapId);
  if (existing && existing.suggestionId === suggestion.id) {
    return existing;
  }

  const preAcceptDocument = JSON.parse(
    JSON.stringify(storeApi.getState().document),
  ) as MindMapDocument;
  let preAcceptVersionId: string | null = null;

  try {
    if (storeApi.getState().isDirty) {
      await storeApi.getState().save();
    }
    const versions = await getMindMapVersions(suggestion.mindmapId);
    if (Array.isArray(versions) && versions.length > 0) {
      preAcceptVersionId = versions[0]?.versionId ?? null;
    }
  } catch {
    // 非 Tauri 环境或单测未 mock 版本接口时不阻塞采纳
  }

  return {
    checkpointId: `mmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    suggestionId: suggestion.id,
    mindmapId: suggestion.mindmapId,
    windowId: suggestion.windowId,
    preAcceptVersionId,
    preAcceptDocument,
    postAcceptDocVersion: storeApi.getState()._documentVersion,
    appliedCount: 0,
    acceptedAt: Date.now(),
  };
}

async function applySuggestionOpsBatch(
  storeApi: MindMapStoreApi,
  mindmapId: string,
  runId: string,
  windowId: string | null,
  opsToApply: AgentOp[],
): Promise<MindmapSuggestionApplyResult> {
  const syntheticRun = createSyntheticAcceptRun(runId, mindmapId, windowId);
  const enteredIds: string[] = [];
  const updatedIds: string[] = [];
  const failed: string[] = [];
  let applied = 0;

  const before = storeApi.getState();

  for (const op of opsToApply) {
    if (storeApi.getState().mindmapId !== mindmapId) {
      for (const rest of opsToApply.slice(applied + failed.length)) {
        failed.push(rest.label);
      }
      break;
    }
    const result = applyOneOp(syntheticRun, storeApi, mindmapId, op);
    if (!result.ok) {
      failed.push(
        i18n.t('mindmap:agent.op_undone_with_reason', {
          label: op.label,
          reason: result.reason ?? '',
          defaultValue: '{{label}}（{{reason}}）',
        }),
      );
      continue;
    }
    applied += 1;
    if (result.entityId) {
      if (op.kind === 'update_node') {
        updatedIds.push(result.entityId);
      } else if (op.kind === 'add_node') {
        const subtreeIds = collectSubtreeIds(storeApi.getState().document.root, result.entityId);
        enteredIds.push(...(subtreeIds.length > 0 ? subtreeIds : [result.entityId]));
      } else if (op.kind !== 'delete_node') {
        enteredIds.push(result.entityId);
      }
    }
  }

  if (enteredIds.length > 0) markEntering(storeApi, enteredIds);
  if (updatedIds.length > 0) markUpdated(storeApi, updatedIds);

  if (applied > 0) {
    storeApi.setState((state) => {
      const nextDoc = state.document.summaries
        ? (() => {
            const docCopy: MindMapDocument = {
              ...state.document,
              summaries: [...state.document.summaries],
            };
            reconcileSummariesWithTree(docCopy);
            return docCopy;
          })()
        : state.document;
      const reconciledBlanks = reconcileRevealedBlanks(nextDoc.root, state.revealedBlanks);
      const filteredPatch = reconcileFilteredInteractionState({
        ...state,
        document: nextDoc,
      });
      return {
        ...(nextDoc !== state.document ? { document: nextDoc } : {}),
        revealedBlanks: reconciledBlanks,
        ...filteredPatch,
        history: {
          past: [...state.history.past, {
            document: before.document,
            ui: { focusedNodeId: before.focusedNodeId, selection: before.selection, viewRootId: before.viewRootId },
          }].slice(-50),
          future: [],
        },
      };
    });
    const afterAccept = storeApi.getState();
    syncMindMapAnchorEdges(afterAccept.mindmapId, afterAccept.document.root, {
      styleId: afterAccept.styleId,
    });
    reconcileMindMapProjectedFlashcards(afterAccept.mindmapId, afterAccept.document.root);
  }

  const documentVersion = storeApi.getState()._documentVersion;
  let saved = true;
  if (applied > 0 && storeApi.getState().mindmapId === mindmapId) {
    saved = await storeApi.getState().save();
  }

  return { applied, failed, saved, documentVersion };
}

/**
 * 直接为指定导图生成幽灵分支提案（供 Chat / Agent 工具显式调用，干净或脏窗口均可）。
 */
export function proposeMindmapOps(params: {
  mindmapId: string;
  windowId?: string | null;
  runId?: string;
  ops: AgentOp[];
}): MindmapAgentSuggestion {
  return stashMindmapSuggestion({
    runId: params.runId ?? `propose_${Date.now()}`,
    mindmapId: params.mindmapId,
    windowId: params.windowId ?? null,
    ops: params.ops,
    reason: 'explicit_proposal',
    documentVersion: resolveSuggestionStore(params.mindmapId, params.windowId ?? null)?.getState()._documentVersion,
  });
}

/**
 * 逐分支采纳幽灵建议：仅应用指定 branch.ops，其余待审阅分支保持挂起。
 */
const acceptingSuggestions = new Set<string>();

export async function acceptMindmapSuggestionBranch(
  suggestionId: string,
  mindmapId: string,
  branchId: string,
): Promise<MindmapSuggestionApplyResult | null> {
  return acceptSuggestion(suggestionId, mindmapId, branchId);
}

async function acceptSuggestion(
  suggestionId: string,
  mindmapId: string,
  branchId?: string,
): Promise<MindmapSuggestionApplyResult | null> {
  if (acceptingSuggestions.has(mindmapId)) return null;
  const suggestion = getMindmapSuggestion(mindmapId);
  if (!suggestion || suggestion.id !== suggestionId) return null;
  const branch = branchId ? suggestion.branches.find((b) => b.branchId === branchId) : undefined;
  if (branchId && !branch) return null;

  const storeApi = resolveSuggestionStore(mindmapId, suggestion.windowId);
  if (!storeApi || storeApi.getState().mindmapId !== mindmapId) {
    clearMindmapSuggestion(mindmapId);
    return null;
  }

  const before = storeApi.getState();
  if (before.editingNodeId || before.editingNoteNodeId ||
    (suggestion.documentVersion !== undefined && suggestion.documentVersion !== before._documentVersion)) {
    return { applied: 0, failed: ['导图已修改，请重新生成建议'], saved: false };
  }
  acceptingSuggestions.add(mindmapId);
  try {
    const checkpoint = await capturePreAcceptCheckpoint(storeApi, suggestion);
    const current = getMindmapSuggestion(mindmapId);
    if (storeApi.getState().mindmapId !== mindmapId ||
      storeApi.getState()._documentVersion !== before._documentVersion ||
      current?.id !== suggestionId ||
      (branchId && !current.branches.some((item) => item.branchId === branchId))) {
      return null;
    }
    const result = await applySuggestionOpsBatch(
    storeApi,
    mindmapId,
    suggestion.runId,
    suggestion.windowId,
    branch?.ops ?? current.ops,
  );

  if (getMindmapSuggestion(mindmapId)?.id === suggestionId) {
    if (branchId) {
      removeMindmapSuggestionBranch(mindmapId, suggestionId, branchId);
      updateMindmapSuggestionRevision(mindmapId, suggestionId, result.documentVersion!);
    } else clearMindmapSuggestion(mindmapId);
  }

  const totalApplied = checkpoint.appliedCount + result.applied;
  if (totalApplied > 0) {
    setAcceptedMindmapCheckpoint({
      ...checkpoint,
      appliedCount: totalApplied,
      postAcceptDocVersion: result.documentVersion!,
      acceptedAt: Date.now(),
    });
  }

  return result;
  } finally {
    acceptingSuggestions.delete(mindmapId);
  }
}

/**
 * 逐分支放弃幽灵建议：仅移除指定 branch，不修改导图文档。
 */
export function rejectMindmapSuggestionBranch(
  suggestionId: string,
  mindmapId: string,
  branchId: string,
): boolean {
  const suggestion = getMindmapSuggestion(mindmapId);
  if (!suggestion || suggestion.id !== suggestionId) return false;
  if (!suggestion.branches.some((b) => b.branchId === branchId)) return false;
  removeMindmapSuggestionBranch(mindmapId, suggestionId, branchId);
  return true;
}

/**
 * 接受全部暂存建议：捕获修改前版本检查点 -> 逐 op 应用 -> 批量 flash 标记 -> save。
 */
export async function acceptMindmapSuggestion(
  suggestionId: string,
  mindmapId: string,
): Promise<MindmapSuggestionApplyResult | null> {
  return acceptSuggestion(suggestionId, mindmapId);
}

/**
 * 一键撤回最近一次已采纳的 AI 修改，恢复至采纳前版本快照（mindmap_versions + 内存文档回滚）。
 */
export async function revertLastAcceptedMindmapSuggestion(
  mindmapId: string,
): Promise<boolean> {
  const checkpoint = getAcceptedMindmapCheckpoint(mindmapId);
  if (!checkpoint) return false;

  const storeApi = resolveSuggestionStore(mindmapId, checkpoint.windowId);
  if (storeApi && storeApi.getState()._documentVersion !== checkpoint.postAcceptDocVersion) return false;
  let backendRestored = false;
  let restoredMetadata: VfsMindMap | null = null;

  if (checkpoint.preAcceptVersionId) {
    try {
      restoredMetadata = await restoreMindMapVersion(checkpoint.preAcceptVersionId);
      backendRestored = true;
    } catch {
      backendRestored = false;
    }
  }

  const hasLiveStore = Boolean(storeApi && storeApi.getState().mindmapId === mindmapId);
  if (!hasLiveStore && !backendRestored) {
    return false;
  }

  if (storeApi && storeApi.getState().mindmapId === mindmapId) {
    const restoredDoc = JSON.parse(
      JSON.stringify(checkpoint.preAcceptDocument),
    ) as MindMapDocument;
    reconcileSummariesWithTree(restoredDoc);
    storeApi.setState((state) => {
      const baseFocusedNodeId =
        state.focusedNodeId && findNodeById(restoredDoc.root, state.focusedNodeId)
          ? state.focusedNodeId
          : restoredDoc.root.id;
      const reconciledBlanks = reconcileRevealedBlanks(restoredDoc.root, state.revealedBlanks);
      const filteredPatch = reconcileFilteredInteractionState({
        ...state,
        document: restoredDoc,
        selection: [],
        editingNodeId: null,
        editingNoteNodeId: null,
        focusedNodeId: baseFocusedNodeId,
      });
      return {
        document: restoredDoc,
        ...(restoredMetadata ? { metadata: restoredMetadata } : {}),
        _documentVersion: state._documentVersion + 1,
        selectionAnchorId: null,
        revealedBlanks: reconciledBlanks,
        ...filteredPatch,
        isDirty: !backendRestored,
      };
    });

    const afterRevert = storeApi.getState();
    syncMindMapAnchorEdges(afterRevert.mindmapId, afterRevert.document.root, {
      styleId: afterRevert.styleId,
    });
    reconcileMindMapProjectedFlashcards(afterRevert.mindmapId, afterRevert.document.root);

    if (!backendRestored) {
      try {
        await storeApi.getState().save();
      } catch {
        // 单测或离线降级路径忽略异常
      }
    }
  }

  if (getMindmapSuggestion(mindmapId)?.id === checkpoint.suggestionId) {
    clearMindmapSuggestion(mindmapId);
  }
  clearAcceptedMindmapCheckpoint(mindmapId);
  return true;
}

/** 拒绝暂存建议：丢弃暂存 ops（从未应用，无需回滚） */
export function dismissMindmapSuggestion(mindmapId: string): void {
  clearMindmapSuggestion(mindmapId);
}

export function registerMindmapDriver(stage: StageManagerApi): void {
  stage.registerDriver(mindmapDriver);
}

registerMindmapSuggestionActions({
  acceptMindmapSuggestion,
  acceptMindmapSuggestionBranch,
  rejectMindmapSuggestionBranch,
  dismissMindmapSuggestion,
  revertLastAcceptedMindmapSuggestion,
});
