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
  getMindMapStoreForResource,
  getMindMapStoreForWindow,
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

/**
 * R2-02 定稿：维持 v1 拒绝式（不升级 AIDiff 式预览）。
 * 理由见 progress/R2-02.md「设计决策」。
 * ACR 4.0 A4：types.ts 回执状态枚举无 blocked/rejected 可选，维持 completed +
 * suggestionPending，但 message 改为明确指令式文案，避免 LLM 傻等一个
 * 永远不会到来的确认回执。
 */
export const SUGGESTION_MESSAGE =
  '目标导图存在未保存编辑或正在编辑，破坏性操作已被拒绝式挂起：'
  + '用户未确认前这些操作不会发生，且没有确认 UI，不会有后续回执，请勿等待。'
  + 'suggestionPending=true 仅表示该拒绝语义。请改走后端数据路径重新提交，'
  + '或提示用户保存/结束编辑后重试。';

/**
 * 写入回执时走 i18n（mindmap:agent.*；语言可运行时切换，故用函数而非模块级常量）。
 * 常量本身保留 zh-CN 原文，作为 defaultValue 兜底与既有测试锚点。
 */
function suggestionMessage(): string {
  return i18n.t('mindmap:agent.suggestion_pending', {
    defaultValue: SUGGESTION_MESSAGE,
  });
}

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

    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
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
    if (existingIds.has(raw.id)) {
      failure = fail(
        'EXISTING_ID',
        i18n.t('mindmap:agent.validation_existing_id', {
          id: raw.id,
          defaultValue: '子节点 id {{id}} 已存在',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (incomingIds.has(raw.id)) {
      failure = fail(
        'DUPLICATE_ID',
        i18n.t('mindmap:agent.validation_duplicate_id', {
          id: raw.id,
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
          id: raw.id,
          defaultValue: '子节点 {{id}} 的 text 必须是字符串',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }
    if (!Array.isArray(raw.children)) {
      failure = fail(
        'INVALID_CHILDREN',
        i18n.t('mindmap:agent.validation_invalid_children', {
          id: raw.id,
          defaultValue: '子节点 {{id}} 的 children 必须是数组',
        }),
        nodeCount,
        maxRelativeDepth,
      );
      activeObjects.delete(raw);
      return null;
    }

    incomingIds.add(raw.id);
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
  return {
    text: node.text,
    note: node.note,
    collapsed: node.collapsed,
    completed: node.completed,
    style: node.style ? { ...node.style } : undefined,
    blankedRanges: node.blankedRanges?.map((r) => ({ ...r })),
    refs: node.refs?.map((r) => ({ ...r })),
  };
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function nodeLocation(root: MindMapNode, nodeId: string): { parentId: string; index: number } | null {
  const parent = findParentNode(root, nodeId);
  if (!parent) return null;
  const index = parent.children.findIndex((child) => child.id === nodeId);
  return index >= 0 ? { parentId: parent.id, index } : null;
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

function isDestructiveOp(op: AgentOp): boolean {
  return op.destructive === true || op.kind === 'delete_node' || op.kind === 'move_node';
}

/** update_node can overwrite text/note/style currently being edited, so it uses the same barrier. */
function requiresUserEditBarrier(op: AgentOp): boolean {
  return isDestructiveOp(op) || op.kind === 'update_node';
}

function mergeNodeStylePatch(
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
      const validation = validateMindmapSubtreeInput(
        storeApi.getState().document.root,
        parentId,
        data.children,
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
      const patch = payload.patch ?? {};
      const normalizedPatch: UpdateNodeParams = {
        ...patch,
        ...(Object.prototype.hasOwnProperty.call(patch, 'style')
          ? { style: mergeNodeStylePatch(node.style, patch.style) }
          : {}),
      };
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

    // 逐 op 决策屏障：允许建议前的非破坏操作完成，但不得越过首个需要确认的操作。
    // expectedDocumentVersion 用于区分本 run 自己制造的 dirty 与执行期间插入的用户编辑。
    const currentState = storeApi.getState();
    const hasConcurrentUserEdit = currentState._documentVersion !== expectedDocumentVersion;
    if (
      requiresUserEditBarrier(op) &&
      (startedDirty || hasConcurrentUserEdit || isHotForOps(storeApi, [op]))
    ) {
      stoppedAtSuggestion = true;
      receipt.mode = 'suggestion';
      receipt.suggestionPending = true;
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

export function registerMindmapDriver(stage: StageManagerApi): void {
  stage.registerDriver(mindmapDriver);
}
