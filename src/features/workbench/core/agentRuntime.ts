import type {
  ActivationHandlerResult,
  AgentActReceipt,
  AgentActRequest,
  AgentActionCall,
  AgentActionOutcome,
  AgentActionResult,
  AgentAffordanceNode,
  AgentAffordanceTree,
  AgentAppCapabilities,
  AgentAppContext,
  AgentCapabilitiesResult,
  AgentCapabilityRisk,
  AgentCapability,
  AgentCapabilitySummary,
  AgentConditionFailure,
  AgentEntitySummary,
  AgentJsonSchema,
  AgentJsonValue,
  AgentManifestHandlerResult,
  AgentObservation,
  AgentObservationCondition,
  AgentObservationPatch,
  AgentStableRef,
  AgentUndoResult,
  AgentWaitForRequest,
  AgentWaitForResult,
  AgentWindowTarget,
  AppAgentManifest,
  AppDefinition,
  WorkbenchWindow,
} from './types';
import { appRegistry } from './appRegistry';
import { useWindowStore } from './windowStore';
import {
  consumeAgentUndo,
  getAgentUndo,
  hasAgentUndoFlight,
  recordAgentUndo,
  runAgentUndoExclusive,
  updateAgentUndo,
} from './agentUndoJournal';

export const AGENT_MAX_BATCH_ACTIONS = 20;
export const AGENT_MAX_AFFORDANCE_NODES = 200;
export const AGENT_MAX_AFFORDANCE_DEPTH = 6;
export const AGENT_WAIT_TIMEOUT_MAX_MS = 30_000;
/** 与 LLM 工具 schema（workbench-tools.ts wait_for intervalMs 50–2000）对齐，
 * 避免模型的合法参数被静默改写 */
export const AGENT_WAIT_INTERVAL_MIN_MS = 50;
export const AGENT_WAIT_INTERVAL_MAX_MS = 2_000;
const AGENT_RISK_RANK = {
  read: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const;

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint: string,
    public readonly retryable = false,
    /** 附加的结构化上下文（如 STALE_OBSERVATION 时的最新 observation），随桥层错误透传给调用方。 */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export function isAgentRuntimeError(error: unknown): error is AgentRuntimeError {
  return error instanceof AgentRuntimeError;
}

export interface AgentRuntimeOptions {
  runId?: string;
  sessionId?: string;
  resolveDirty?: (typeId: string, instanceKey: string | null) => boolean;
  resolveBusy?: (windowId: string) => boolean;
  /** Existing CollabDriver queryState fallback, merged below manifest state. */
  resolveLegacyState?: (
    ctx: AgentAppContext,
  ) => Record<string, unknown> | undefined;
  registerSessionUndo?: (
    invert: () => Promise<void> | void,
    label: string,
    risk?: AgentCapabilityRisk,
  ) => void;
  /** Cooperative cancellation propagated from the Rust bridge correlation. */
  signal?: AbortSignal;
  /** Revert defaults to medium; High inverses require an explicitly elevated tool. */
  approvalRiskCeiling?: AgentCapabilityRisk;
  executeLegacy?: (
    ctx: AgentAppContext,
    action: AgentActionCall,
  ) => AgentManifestHandlerResult | Promise<AgentManifestHandlerResult>;
}

function throwIfAgentOperationAborted(options: AgentRuntimeOptions): void {
  if (!options.signal?.aborted) return;
  runtimeError(
    'CANCELLED',
    'Agent 操作已取消',
    '重新 observe 当前状态；动作可能已部分完成，请依据权威回执决定是否重试',
    true,
  );
}

function normalizeRiskCeiling(
  risk: AgentCapabilityRisk | undefined,
): AgentCapabilityRisk {
  return risk && Object.prototype.hasOwnProperty.call(AGENT_RISK_RANK, risk)
    ? risk
    : 'medium';
}

function maxAgentRisk(risks: Array<AgentCapabilityRisk | undefined>): AgentCapabilityRisk {
  let result: AgentCapabilityRisk = 'read';
  for (const risk of risks) {
    const normalized = risk && Object.prototype.hasOwnProperty.call(AGENT_RISK_RANK, risk)
      ? risk
      : 'high';
    if (AGENT_RISK_RANK[normalized] > AGENT_RISK_RANK[result]) result = normalized;
  }
  return result;
}

interface ResolvedAgentWindow {
  win: WorkbenchWindow;
  /** Absent for virtual targets (e.g. desktop), which have no AppDefinition. */
  def?: AppDefinition;
  manifest?: AppAgentManifest;
  /** True when the target is a windowless virtual singleton (ACR 4.0 desktop). */
  virtual?: boolean;
}

// ---------------------------------------------------------------------------
// ACR 4.0（A2）：虚拟目标——无宿主窗口的单例（当前仅 'desktop'）。
// 不进 appRegistry（避免被 open_app / 启动器打开成假窗），由 apps 层在装配时
// 通过 registerVirtualAgentTarget 注册 manifest；观察/act 用 typeId 兼作
// 稳定伪 windowId（nanoid(10) 不会与之碰撞）。
// ---------------------------------------------------------------------------

const virtualAgentManifests = new Map<string, AppAgentManifest>();

/** 注册无窗虚拟目标的 agentManifest（幂等，同 typeId 覆盖）。 */
export function registerVirtualAgentTarget(
  typeId: string,
  manifest: AppAgentManifest,
): void {
  virtualAgentManifests.set(typeId, manifest);
}

/** 虚拟目标 manifest 查询（probe/queryProviders 复用）。 */
export function getVirtualAgentManifest(
  typeId: string,
): AppAgentManifest | undefined {
  return virtualAgentManifests.get(typeId);
}

function virtualAgentWindow(typeId: string): WorkbenchWindow {
  const { desktopSize } = useWindowStore.getState();
  return {
    id: typeId,
    typeId,
    instanceKey: null,
    title: typeId,
    frame: { x: 0, y: 0, w: desktopSize.w, h: desktopSize.h },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 0,
    createdAt: 0,
    lastFocusedAt: 0,
  };
}

function resolveVirtualAgentTarget(
  target: AgentWindowTarget,
): ResolvedAgentWindow | null {
  const virtualId = target.typeId && virtualAgentManifests.has(target.typeId)
    ? target.typeId
    : !target.typeId && target.windowId && virtualAgentManifests.has(target.windowId)
      ? target.windowId
      : null;
  if (!virtualId) return null;
  if (target.windowId && target.windowId !== virtualId) {
    runtimeError(
      'WINDOW_TARGET_MISMATCH',
      `${virtualId} 是无窗虚拟目标，不接受 windowId ${target.windowId}`,
      `直接用 typeId=${virtualId}（或 windowId=${virtualId}）定位该目标`,
    );
  }
  if (target.instanceKey) {
    runtimeError(
      'WINDOW_TARGET_MISMATCH',
      `${virtualId} 是单例虚拟目标，不接受 instanceKey`,
      '移除 instanceKey 后重试',
    );
  }
  return {
    win: virtualAgentWindow(virtualId),
    manifest: virtualAgentManifests.get(virtualId),
    virtual: true,
  };
}

interface RefDescriptor {
  kind: string;
  actions: Set<string>;
  disabled: boolean;
}

function runtimeError(
  code: string,
  message: string,
  hint: string,
  retryable = false,
  details?: Record<string, unknown>,
): never {
  throw new AgentRuntimeError(code, message, hint, retryable, details);
}

function resolveAgentWindow(target: AgentWindowTarget = {}): ResolvedAgentWindow {
  const virtualResolved = resolveVirtualAgentTarget(target);
  if (virtualResolved) return virtualResolved;
  const state = useWindowStore.getState();
  let win: WorkbenchWindow | undefined;
  if (target.windowId) {
    win = state.windows[target.windowId];
    if (!win) {
      runtimeError(
        'WINDOW_NOT_FOUND',
        `窗口不存在: ${target.windowId}`,
        '窗口可能已关闭；请重新调用 list_windows 或 observe',
      );
    }
    if (target.typeId && win.typeId !== target.typeId) {
      runtimeError(
        'WINDOW_TARGET_MISMATCH',
        `窗口 ${target.windowId} 的类型是 ${win.typeId}，不是 ${target.typeId}`,
        '使用 observe 返回的 windowId/typeId 组合重试',
      );
    }
    if (target.instanceKey && win.instanceKey !== target.instanceKey) {
      runtimeError(
        'WINDOW_TARGET_MISMATCH',
        `窗口 ${target.windowId} 的资源已变化`,
        '重新 observe，使用最新 instanceKey 和 revision',
        true,
      );
    }
  } else if (target.typeId) {
    const def = appRegistry.get(target.typeId);
    const candidates = Object.values(state.windows).filter(
      (candidate) => candidate.typeId === target.typeId,
    );
    if (target.instanceKey) {
      win = candidates.find((candidate) => candidate.instanceKey === target.instanceKey);
    } else if (def?.instanceMode === 'single') {
      win = candidates[0];
    } else {
      const focusedId = state.focusStack.at(-1);
      win = candidates.find((candidate) => candidate.id === focusedId) ?? candidates[0];
    }
  } else {
    const focusedId = state.focusStack.at(-1);
    win = focusedId ? state.windows[focusedId] : undefined;
  }

  if (!win) {
    runtimeError(
      'WINDOW_NOT_FOUND',
      '没有找到可观察的目标窗口',
      '传入 windowId，或先用 open_app 打开目标应用',
    );
  }
  const def = appRegistry.get(win.typeId);
  if (!def) {
    runtimeError(
      'APP_NOT_REGISTERED',
      `应用未注册: ${win.typeId}`,
      '重新打开应用，或检查应用注册状态',
    );
  }
  return { win, def, manifest: def.agentManifest };
}

function cloneCapabilities(manifest: AppAgentManifest): AgentCapability[] {
  const seen = new Set<string>();
  const capabilities: AgentCapability[] = [];
  for (const capability of manifest.capabilities) {
    const name = capability.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    capabilities.push({
      ...capability,
      name,
      inputSchema: jsonClone(capability.inputSchema ?? {}, {}),
      ...(capability.outputSchema
        ? { outputSchema: jsonClone(capability.outputSchema, {}) }
        : {}),
      ...(capability.targetKinds
        ? { targetKinds: [...capability.targetKinds] }
        : {}),
    });
  }
  return capabilities;
}

export function getAgentCapabilities(
  target: AgentWindowTarget = {},
): AgentCapabilitiesResult {
  const apps: AgentAppCapabilities[] = [];
  if (target.windowId) {
    const { win, manifest } = resolveAgentWindow(target);
    if (!manifest) {
      runtimeError(
        'APP_AGENT_UNAVAILABLE',
        `${win.typeId} 尚未声明 Agent 能力`,
        '该应用仍可使用旧 app_command；能力发现需等待 agentManifest 接入',
      );
    }
    apps.push({
      typeId: win.typeId,
      windowId: win.id,
      instanceKey: win.instanceKey,
      manifestVersion: manifest.version,
      description: manifest.description,
      capabilities: cloneCapabilities(manifest),
    });
    return { apps };
  }

  if (target.typeId) {
    const virtualManifest = virtualAgentManifests.get(target.typeId);
    if (virtualManifest) {
      apps.push({
        typeId: target.typeId,
        windowId: target.typeId,
        instanceKey: null,
        manifestVersion: virtualManifest.version,
        description: virtualManifest.description,
        capabilities: cloneCapabilities(virtualManifest),
      });
      return { apps };
    }
    const def = appRegistry.get(target.typeId);
    if (!def) {
      runtimeError(
        'APP_NOT_REGISTERED',
        `应用未注册: ${target.typeId}`,
        '先调用 list_windows 或查看已注册应用',
      );
    }
    if (!def.agentManifest) {
      runtimeError(
        'APP_AGENT_UNAVAILABLE',
        `${target.typeId} 尚未声明 Agent 能力`,
        '该应用仍可使用旧 app_command；能力发现需等待 agentManifest 接入',
      );
    }
    const state = useWindowStore.getState();
    const win = Object.values(state.windows).find(
      (candidate) => candidate.typeId === target.typeId
        && (!target.instanceKey || candidate.instanceKey === target.instanceKey),
    );
    apps.push({
      typeId: target.typeId,
      windowId: win?.id,
      instanceKey: win?.instanceKey,
      manifestVersion: def.agentManifest.version,
      description: def.agentManifest.description,
      capabilities: cloneCapabilities(def.agentManifest),
    });
    return { apps };
  }

  // 广查询（全部应用）返回能力概要：省略每个 capability 的 inputSchema/outputSchema，
  // 避免回执超出工具输出预算被截断，导致模型丢失能力总览后开始盲猜动作名。
  for (const { typeId, manifest } of appRegistry.listAgentManifests()) {
    apps.push({
      typeId,
      manifestVersion: manifest.version,
      description: manifest.description,
      capabilities: summarizeCapabilities(manifest),
    });
  }
  for (const [typeId, manifest] of virtualAgentManifests) {
    if (apps.some((app) => app.typeId === typeId)) continue;
    apps.push({
      typeId,
      manifestVersion: manifest.version,
      description: manifest.description,
      capabilities: summarizeCapabilities(manifest),
    });
  }
  apps.sort((a, b) => a.typeId.localeCompare(b.typeId));
  return {
    apps,
    schemasOmitted: true,
    hint: '广查询仅返回能力概要（无 inputSchema）；执行 act 前请带 typeId 或 windowId 重新调用以获取完整参数 schema',
  };
}

function summarizeCapabilities(manifest: AppAgentManifest): AgentCapabilitySummary[] {
  const seen = new Set<string>();
  const summaries: AgentCapabilitySummary[] = [];
  for (const capability of manifest.capabilities) {
    const name = capability.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    summaries.push({
      name,
      ...(capability.description ? { description: capability.description } : {}),
      risk: capability.risk,
      mutates: capability.mutates,
      ...(capability.requiresFocus ? { requiresFocus: true } : {}),
      ...(capability.targetKinds?.length
        ? { targetKinds: [...capability.targetKinds] }
        : {}),
    });
  }
  return summaries;
}

function jsonClone<T>(value: T, fallback: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return fallback;
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`,
  ).join(',')}}`;
}

function hashRevision(value: unknown): string {
  const text = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `acr:${(hash >>> 0).toString(36)}`;
}

function boundActions(actions: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(actions)) return [];
  return [...new Set(actions.filter(
    (action): action is string => typeof action === 'string' && allowed.has(action),
  ))];
}

function boundAffordances(
  roots: AgentAffordanceNode[] | undefined,
  allowedActions: Set<string>,
): AgentAffordanceTree {
  let nodeCount = 0;
  let maxDepth = 0;
  let truncated = false;
  const seen = new Set<string>();

  const visit = (node: AgentAffordanceNode, depth: number): AgentAffordanceNode | null => {
    if (nodeCount >= AGENT_MAX_AFFORDANCE_NODES || depth > AGENT_MAX_AFFORDANCE_DEPTH) {
      truncated = true;
      return null;
    }
    const ref = typeof node?.ref === 'string' ? node.ref.trim() : '';
    const kind = typeof node?.kind === 'string' ? node.kind.trim() : '';
    if (!ref || !kind || seen.has(ref)) {
      truncated = true;
      return null;
    }
    seen.add(ref);
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    const children: AgentAffordanceNode[] = [];
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const bounded = visit(child, depth + 1);
        if (bounded) children.push(bounded);
      }
    }
    return {
      ref,
      kind,
      label: typeof node.label === 'string' ? node.label : undefined,
      description: typeof node.description === 'string' ? node.description : undefined,
      actions: boundActions(node.actions, allowedActions),
      disabled: node.disabled === true,
      selected: node.selected === true,
      value: jsonClone(node.value, null),
      ...(children.length ? { children } : {}),
    };
  };

  const boundedRoots: AgentAffordanceNode[] = [];
  for (const root of roots ?? []) {
    const bounded = visit(root, 1);
    if (bounded) boundedRoots.push(bounded);
  }
  return { roots: boundedRoots, nodeCount, maxDepth, truncated };
}

function boundEntities(
  entities: AgentEntitySummary[] | undefined,
  allowedActions: Set<string>,
): AgentEntitySummary[] {
  const result: AgentEntitySummary[] = [];
  const seen = new Set<string>();
  for (const entity of entities ?? []) {
    if (result.length >= AGENT_MAX_AFFORDANCE_NODES) break;
    const ref = typeof entity?.ref === 'string' ? entity.ref.trim() : '';
    const kind = typeof entity?.kind === 'string' ? entity.kind.trim() : '';
    if (!ref || !kind || seen.has(ref)) continue;
    seen.add(ref);
    result.push({
      ref,
      kind,
      label: typeof entity.label === 'string' ? entity.label : undefined,
      description: typeof entity.description === 'string' ? entity.description : undefined,
      actions: boundActions(entity.actions, allowedActions),
      state: jsonClone(entity.state ?? {}, {}),
    });
  }
  return result;
}

function collectRefs(observation: AgentObservation): Map<AgentStableRef, RefDescriptor> {
  const refs = new Map<AgentStableRef, RefDescriptor>();
  const add = (
    ref: string,
    kind: string,
    actions: string[],
    disabled = false,
  ) => {
    const existing = refs.get(ref);
    if (existing) {
      for (const action of actions) existing.actions.add(action);
      existing.disabled ||= disabled;
      return;
    }
    refs.set(ref, { kind, actions: new Set(actions), disabled });
  };
  const visit = (node: AgentAffordanceNode) => {
    add(node.ref, node.kind, node.actions, node.disabled);
    node.children?.forEach(visit);
  };
  observation.affordances.roots.forEach(visit);
  observation.entities.forEach((entity) => add(entity.ref, entity.kind, entity.actions));
  if (observation.pendingDialog) {
    add(
      observation.pendingDialog.ref,
      observation.pendingDialog.kind,
      observation.pendingDialog.actions,
    );
  }
  return refs;
}

export async function observeAgentWindow(
  target: AgentWindowTarget = {},
  options: AgentRuntimeOptions = {},
): Promise<AgentObservation> {
  const { win, manifest, virtual } = resolveAgentWindow(target);
  const state = useWindowStore.getState();
  // 虚拟目标（desktop）始终可交互，视为 focused，避免 requiresFocus 类校验误伤
  const focused = virtual === true
    || (state.focusStack.at(-1) === win.id && !win.minimized);
  const capabilities = manifest ? cloneCapabilities(manifest) : [];
  const declaredActions = new Set(capabilities.map((capability) => capability.name));
  let patch: AgentObservationPatch = {};
  const appContext: AgentAppContext = {
    windowId: win.id,
    typeId: win.typeId,
    instanceKey: win.instanceKey,
    runId: options.runId,
    sessionId: options.sessionId,
    signal: options.signal,
  };
  if (manifest?.observe) {
    try {
      patch = (await manifest.observe(appContext)) ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeError(
        'OBSERVE_FAILED',
        `${win.typeId} 状态观察失败: ${message}`,
        '应用可能正在切换状态；稍后重新 observe',
        true,
      );
    }
  }

  const availableActions = patch.availableActions
    ? boundActions(patch.availableActions, declaredActions)
    : [...declaredActions];
  const affordances = boundAffordances(patch.affordances, declaredActions);
  const entities = boundEntities(patch.entities, declaredActions);
  const pendingDialog = patch.pendingDialog
    ? {
        ref: String(patch.pendingDialog.ref ?? '').trim(),
        kind: String(patch.pendingDialog.kind ?? '').trim(),
        title: patch.pendingDialog.title,
        message: patch.pendingDialog.message,
        actions: boundActions(patch.pendingDialog.actions, declaredActions),
      }
    : undefined;
  const legacyState = jsonClone(options.resolveLegacyState?.(appContext) ?? {}, {});
  const refProbe: AgentObservation = {
    version: 1,
    revision: '',
    observedAt: 0,
    windowId: win.id,
    typeId: win.typeId,
    instanceKey: win.instanceKey,
    title: win.title || win.typeId,
    route: patch.route,
    mode: patch.mode,
    focused,
    dirty: options.resolveDirty?.(win.typeId, win.instanceKey) ?? false,
    busy: patch.busy ?? options.resolveBusy?.(win.id) ?? false,
    selection: [],
    availableActions,
    entities,
    affordances,
    pendingDialog: pendingDialog?.ref && pendingDialog.kind ? pendingDialog : undefined,
    state: {
      ...legacyState,
      ...jsonClone(patch.state ?? {}, {}),
    } as Record<string, AgentJsonValue>,
  };
  const refs = collectRefs(refProbe);
  refProbe.selection = [...new Set((patch.selection ?? []).filter(
    (ref): ref is string => typeof ref === 'string' && refs.has(ref),
  ))];
  const revision = hashRevision({
    ...refProbe,
    revision: undefined,
    observedAt: undefined,
    appRevision: patch.revision,
  });
  return {
    ...refProbe,
    revision,
    observedAt: Date.now(),
  };
}

function isType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function validateSchema(value: unknown, schema: AgentJsonSchema, path = 'args'): string[] {
  const errors: string[] = [];
  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter((candidate) => validateSchema(value, candidate, path).length === 0);
    if (matches.length !== 1) errors.push(`${path} 必须匹配 oneOf 中恰好一个 schema`);
  }
  if (schema.anyOf?.length
    && !schema.anyOf.some((candidate) => validateSchema(value, candidate, path).length === 0)) {
    errors.push(`${path} 不匹配 anyOf 中的任何 schema`);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => isType(value, type))) {
    errors.push(`${path} 类型应为 ${types.join('|')}`);
    return errors;
  }
  if (schema.const !== undefined && stableSerialize(value) !== stableSerialize(schema.const)) {
    errors.push(`${path} 必须等于声明的 const`);
  }
  if (schema.enum?.length
    && !schema.enum.some((candidate) => stableSerialize(value) === stableSerialize(candidate))) {
    errors.push(`${path} 不在允许的 enum 中`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 256) {
      errors.push(`${path} 的 schema pattern 无效或过长`);
    } else {
      try {
        const pattern = new RegExp(schema.pattern);
        if (typeof value === 'string' && !pattern.test(value)) {
          errors.push(`${path} 不匹配 pattern ${schema.pattern}`);
        }
      } catch {
        errors.push(`${path} 的 schema pattern 无法编译`);
      }
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path} 长度不能小于 ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path} 长度不能大于 ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path} 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path} 不能大于 ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path} 至少需要 ${schema.minItems} 项`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path} 最多允许 ${schema.maxItems} 项`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, schema.items!, `${path}[${index}]`));
      });
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} 为必填项`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...validateSchema(record[key], child, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowedProperties = schema.properties ?? {};
      for (const key of Object.keys(record)) {
        if (!(key in allowedProperties)) errors.push(`${path}.${key} 不是允许字段`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, item] of Object.entries(record)) {
        if (!schema.properties || !(key in schema.properties)) {
          errors.push(...validateSchema(item, schema.additionalProperties, `${path}.${key}`));
        }
      }
    }
  }
  return errors;
}

function normalizeActionResult(raw: AgentManifestHandlerResult): AgentActionResult {
  if (raw === false) return { handled: false };
  if (!raw || raw === true) return { handled: true };
  return {
    handled: Boolean(raw.handled),
    code: typeof raw.code === 'string' ? raw.code : undefined,
    hint: typeof raw.hint === 'string' ? raw.hint : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    ...('changed' in raw && typeof raw.changed === 'boolean'
      ? { changed: raw.changed }
      : {}),
    ...('acknowledged' in raw && typeof raw.acknowledged === 'boolean'
      ? { acknowledged: raw.acknowledged }
      : {}),
    ...('entityRefs' in raw && Array.isArray(raw.entityRefs)
      ? { entityRefs: raw.entityRefs.filter((ref): ref is string => typeof ref === 'string') }
      : {}),
    ...('details' in raw && raw.details && typeof raw.details === 'object'
      ? { details: jsonClone(raw.details, {}) }
      : {}),
    ...('postconditions' in raw && Array.isArray(raw.postconditions)
      ? { postconditions: jsonClone(raw.postconditions, []) }
      : {}),
    ...('undo' in raw && raw.undo && typeof raw.undo === 'object'
      ? { undo: raw.undo }
      : {}),
  };
}

function readStatePath(observation: AgentObservation, path: string): unknown {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  let value: unknown = parts[0] === 'state' ? observation : observation.state;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function validateAgentConditions(
  input: unknown,
  label = 'conditions',
): AgentObservationCondition[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    runtimeError(
      'INVALID_CONDITION',
      `${label} 必须是数组`,
      '使用 get_capabilities/observe 契约支持的 condition kind 和字段',
    );
  }
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      runtimeError(
        'INVALID_CONDITION',
        `${label}[${index}] 必须是对象`,
        '检查 condition 的 kind 与必填字段',
      );
    }
    const condition = raw as Record<string, unknown>;
    const kind = condition.kind;
    if (kind === 'revision_changed') {
      if (condition.from !== undefined && typeof condition.from !== 'string') {
        runtimeError('INVALID_CONDITION', `${label}[${index}].from 必须是字符串`, '修正 revision_changed 条件');
      }
      return {
        kind,
        ...(typeof condition.from === 'string' ? { from: condition.from } : {}),
      };
    }
    if (kind === 'ref_exists' || kind === 'ref_absent' || kind === 'selection_includes') {
      if (typeof condition.ref !== 'string' || !condition.ref.trim()) {
        runtimeError('INVALID_CONDITION', `${label}[${index}].ref 不能为空`, `为 ${kind} 提供稳定 ref`);
      }
      return { kind, ref: condition.ref };
    }
    if (kind === 'action_available') {
      if (typeof condition.action !== 'string' || !condition.action.trim()) {
        runtimeError('INVALID_CONDITION', `${label}[${index}].action 不能为空`, '提供 capability action 名');
      }
      if (condition.ref !== undefined && typeof condition.ref !== 'string') {
        runtimeError('INVALID_CONDITION', `${label}[${index}].ref 必须是字符串`, '移除 ref 或提供稳定 ref');
      }
      return {
        kind,
        action: condition.action,
        ...(typeof condition.ref === 'string' ? { ref: condition.ref } : {}),
      };
    }
    if (kind === 'state_equals') {
      if (typeof condition.path !== 'string' || !condition.path.trim()) {
        runtimeError('INVALID_CONDITION', `${label}[${index}].path 不能为空`, '提供 observation.state 内的点路径');
      }
      if (!Object.prototype.hasOwnProperty.call(condition, 'value')) {
        runtimeError('INVALID_CONDITION', `${label}[${index}].value 缺失`, 'state_equals 必须声明预期 value');
      }
      return {
        kind,
        path: condition.path,
        value: jsonClone(condition.value, null) as AgentJsonValue,
      };
    }
    runtimeError(
      'INVALID_CONDITION',
      `${label}[${index}] 使用未知 kind: ${String(kind)}`,
      '仅使用 revision_changed/ref_exists/ref_absent/selection_includes/action_available/state_equals',
    );
  });
}

export function evaluateAgentConditions(
  observation: AgentObservation,
  conditions: AgentObservationCondition[] = [],
  baselineRevision?: string,
): AgentConditionFailure[] {
  const validatedConditions = validateAgentConditions(conditions);
  const refs = collectRefs(observation);
  const failures: AgentConditionFailure[] = [];
  for (const condition of validatedConditions) {
    let matched = false;
    let message = '';
    switch (condition.kind) {
      case 'revision_changed': {
        const from = condition.from ?? baselineRevision;
        matched = Boolean(from) && observation.revision !== from;
        message = from
          ? `revision 仍为 ${from}`
          : 'revision_changed 缺少 from 或基准 revision';
        break;
      }
      case 'ref_exists':
        matched = refs.has(condition.ref);
        message = `引用不存在: ${condition.ref}`;
        break;
      case 'ref_absent':
        matched = !refs.has(condition.ref);
        message = `引用仍存在: ${condition.ref}`;
        break;
      case 'selection_includes':
        matched = observation.selection.includes(condition.ref);
        message = `当前选择不包含: ${condition.ref}`;
        break;
      case 'action_available': {
        matched = condition.ref
          ? Boolean(refs.get(condition.ref)?.actions.has(condition.action))
          : observation.availableActions.includes(condition.action);
        message = condition.ref
          ? `${condition.ref} 当前不可执行 ${condition.action}`
          : `当前不可执行 ${condition.action}`;
        break;
      }
      case 'state_equals':
        matched = stableSerialize(readStatePath(observation, condition.path))
          === stableSerialize(condition.value);
        message = `状态 ${condition.path} 未达到预期值`;
        break;
      default:
        message = '未知观察条件';
    }
    if (!matched) failures.push({ condition, message });
  }
  return failures;
}

function validateActionAgainstObservation(
  action: AgentActionCall,
  capability: AgentCapability,
  observation: AgentObservation,
): AgentRuntimeError | null {
  if (!observation.availableActions.includes(action.name)) {
    return new AgentRuntimeError(
      'ACTION_UNAVAILABLE',
      `动作 ${action.name} 当前不可用`,
      '重新 observe，并只使用 availableActions 中的动作',
      true,
    );
  }
  if (capability.requiresFocus && !observation.focused) {
    return new AgentRuntimeError(
      'FOCUS_REQUIRED',
      `动作 ${action.name} 要求目标窗口处于焦点`,
      '先聚焦窗口，重新 observe 后再执行',
      true,
    );
  }
  if (capability.targetKinds?.length
    && !capability.targetOptional
    && !action.targetRef) {
    return new AgentRuntimeError(
      'INVALID_AGENT_REF',
      `${action.name} 必须提供 targetRef`,
      '从最新 observe.affordances/entities 中选择匹配 targetKinds 的 ref',
    );
  }
  if (!action.targetRef) return null;
  const descriptor = collectRefs(observation).get(action.targetRef);
  if (!descriptor) {
    return new AgentRuntimeError(
      'INVALID_AGENT_REF',
      `引用不存在或已过期: ${action.targetRef}`,
      '重新 observe，并使用最新 affordances/entities 中的 ref',
      true,
    );
  }
  if (descriptor.disabled || !descriptor.actions.has(action.name)) {
    return new AgentRuntimeError(
      'ACTION_UNAVAILABLE',
      `${action.targetRef} 当前不可执行 ${action.name}`,
      '检查该 ref 的 actions/disabled 状态后重试',
      true,
    );
  }
  if (capability.targetKinds?.length
    && !capability.targetKinds.includes(descriptor.kind)) {
    return new AgentRuntimeError(
      'INVALID_AGENT_REF',
      `${action.name} 不接受 kind=${descriptor.kind} 的引用`,
      `使用以下类型之一: ${capability.targetKinds.join(', ')}`,
    );
  }
  const readArgPath = (path: string): unknown => {
    const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
    let value: unknown = action.args;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !(part in value)) return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
  const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args)
    ? action.args as Record<string, unknown>
    : {};
  const conventionalRef = ['targetRef', 'entityRef', 'ref']
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && value.includes(':'));
  const declaredRef = capability.targetRefPath
    ? readArgPath(capability.targetRefPath)
    : conventionalRef;
  if (declaredRef !== undefined && declaredRef !== action.targetRef) {
    return new AgentRuntimeError(
      'TARGET_REF_MISMATCH',
      `${action.name} 的 targetRef 与 args 中的实体引用不一致`,
      '使用同一次 observe 返回的 ref，并让 targetRef 与实体参数保持一致',
    );
  }
  if (capability.targetIdPath) {
    const declaredId = readArgPath(capability.targetIdPath);
    const encodedRefId = action.targetRef.split(':').at(-1) ?? '';
    let refId = encodedRefId;
    try {
      refId = decodeURIComponent(encodedRefId);
    } catch {
      // Malformed external refs remain comparable as opaque strings.
    }
    if (declaredId === undefined || String(declaredId) !== refId) {
      return new AgentRuntimeError(
        'TARGET_REF_MISMATCH',
        `${action.name} 的 targetRef 与 ${capability.targetIdPath} 不一致`,
        '重新 observe，并使用 ref 最后一段对应的实体 id',
      );
    }
  }
  return null;
}

function verifyExecutedAction(
  action: AgentActionCall,
  capability: AgentCapability,
  result: AgentActionResult,
  before: AgentObservation,
  after: AgentObservation,
): {
  verified: boolean;
  verificationSource: AgentActionOutcome['verificationSource'];
  failedConditions: AgentConditionFailure[];
} {
  let verificationSource: AgentActionOutcome['verificationSource'];
  let postconditions: AgentObservationCondition[];
  if (action.expect?.length) {
    verificationSource = 'caller-postcondition';
    postconditions = action.expect;
  } else if (result.postconditions?.length) {
    verificationSource = 'result-postcondition';
    postconditions = result.postconditions;
  } else if (capability.mutates && result.acknowledged === true) {
    verificationSource = 'handler-ack';
    postconditions = [];
  } else if (!capability.mutates) {
    verificationSource = 'read-only-observation';
    postconditions = [];
  } else {
    verificationSource = 'unverified';
    postconditions = [];
  }
  const failedConditions = evaluateAgentConditions(
    after,
    postconditions,
    before.revision,
  );
  if (result.handled && verificationSource === 'unverified') {
    failedConditions.push({
      condition: { kind: 'revision_changed', from: before.revision },
      message: 'mutating action 未提供 caller/result postcondition，且未返回 authoritative acknowledged=true',
    });
  }
  return {
    verified: result.handled && failedConditions.length === 0,
    verificationSource,
    failedConditions,
  };
}

async function executeManifestAction(
  manifest: AppAgentManifest,
  ctx: AgentAppContext,
  action: AgentActionCall,
  options: AgentRuntimeOptions,
): Promise<AgentActionResult> {
  if (manifest.execute) {
    return normalizeActionResult(await manifest.execute(ctx, action));
  }
  if (options.executeLegacy) {
    return normalizeActionResult(await options.executeLegacy(ctx, action));
  }
  runtimeError(
    'APP_AGENT_UNAVAILABLE',
    `${ctx.typeId} 声明了动作但没有 execute/onActivation 执行入口`,
    '为 agentManifest 实现 execute，或保留兼容 onActivation',
  );
}

function failedOutcome(
  action: AgentActionCall,
  index: number,
  error: AgentRuntimeError,
): AgentActionOutcome {
  return {
    id: action.id,
    index,
    name: action.name,
    targetRef: action.targetRef,
    handled: false,
    code: error.code,
    hint: error.hint,
    message: error.message,
    verified: false,
    verificationSource: 'unverified',
    failedConditions: [],
  };
}

export async function actOnAgentWindow(
  request: AgentActRequest,
  options: AgentRuntimeOptions = {},
): Promise<AgentActReceipt> {
  throwIfAgentOperationAborted(options);
  if (!request.observationRevision?.trim()) {
    runtimeError(
      'INVALID_ARGS',
      'act 缺少 observationRevision',
      '先调用 observe，并把返回的 revision 原样传给 act',
    );
  }
  if (!Array.isArray(request.actions) || request.actions.length === 0) {
    runtimeError('INVALID_ARGS', 'act 没有 actions', '至少传入一个语义动作');
  }
  if (request.actions.length > AGENT_MAX_BATCH_ACTIONS) {
    runtimeError(
      'INVALID_ARGS',
      `单批最多允许 ${AGENT_MAX_BATCH_ACTIONS} 个动作`,
      '拆分为多个 act 批次，并在批次间重新 observe',
    );
  }
  validateAgentConditions(request.expect, 'act.expect');
  request.actions.forEach((action, index) => {
    if (!action || typeof action !== 'object' || typeof action.name !== 'string' || !action.name.trim()) {
      runtimeError(
        'INVALID_ARGS',
        `act.actions[${index}] 缺少有效 name`,
        '每个 action 必须是带 capability name 的对象',
      );
    }
    if (action.targetRef !== undefined && typeof action.targetRef !== 'string') {
      runtimeError(
        'INVALID_AGENT_REF',
        `act.actions[${index}].targetRef 必须是字符串`,
        '使用 observe 返回的稳定 ref',
      );
    }
    validateAgentConditions(action?.expect, `act.actions[${index}].expect`);
  });

  const resolved = resolveAgentWindow(request);
  const manifest = resolved.manifest;
  if (!manifest) {
    runtimeError(
      'APP_AGENT_UNAVAILABLE',
      `${resolved.win.typeId} 尚未声明 Agent 能力`,
      '使用旧 app_command，或为应用注册 agentManifest',
    );
  }
  const capabilities = new Map(
    cloneCapabilities(manifest).map((capability) => [capability.name, capability]),
  );
  const approvalRiskCeiling = normalizeRiskCeiling(request.approvalRiskCeiling);
  for (const action of request.actions) {
    const capability = capabilities.get(action.name);
    if (!capability) {
      runtimeError(
        'CAPABILITY_NOT_FOUND',
        `${resolved.win.typeId} 未声明动作 ${action.name}`,
        '调用 get_capabilities 获取准确动作名',
      );
    }
    const capabilityRiskRank = AGENT_RISK_RANK[capability.risk]
      ?? AGENT_RISK_RANK.high;
    if (capabilityRiskRank > AGENT_RISK_RANK[approvalRiskCeiling]) {
      runtimeError(
        'RISK_APPROVAL_REQUIRED',
        `${action.name} 风险等级 ${capability.risk} 超过授权上限 ${approvalRiskCeiling}`,
        '使用经过高风险确认的 act 工具，或移除该动作后重试',
      );
    }
    const args = action.args ?? (capability.inputSchema.type === 'object' ? {} : undefined);
    const schemaErrors = validateSchema(args, capability.inputSchema);
    if (schemaErrors.length) {
      runtimeError(
        'INVALID_ACTION_ARGS',
        `${action.name} 参数不符合 schema: ${schemaErrors.join('; ')}`,
        '按 get_capabilities 返回的 inputSchema 修正 args',
      );
    }
  }

  let current = await observeAgentWindow(request, options);
  throwIfAgentOperationAborted(options);
  const before = current;
  let rebasedFromRevision: string | undefined;
  if (current.revision !== request.observationRevision) {
    // 软重基：桌面聚焦/最小化等操作会异步刷新 revision，严格相等会让紧接着的
    // act 频繁 STALE。若整批动作风险 ≤ medium 且每个动作（含 targetRef/可用性）
    // 都能通过最新 observation 校验，则直接在新 observation 上执行并在回执中
    // 标注 rebasedFromRevision；High 风险批次的审批绑定当时状态，保持严格失败。
    const batchRisk = maxAgentRisk(
      request.actions.map((action) => capabilities.get(action.name)?.risk),
    );
    const rebasable = AGENT_RISK_RANK[batchRisk] <= AGENT_RISK_RANK.medium
      && request.actions.every((action) => validateActionAgainstObservation(
        action,
        capabilities.get(action.name)!,
        current,
      ) === null);
    if (rebasable) {
      rebasedFromRevision = request.observationRevision;
    } else {
      runtimeError(
        'STALE_OBSERVATION',
        `观察已过期（期望 ${request.observationRevision}，当前 ${current.revision}）`,
        '错误已附带最新 observation（error.observation）；直接基于它重新规划动作，无需再次 observe',
        true,
        { observation: current },
      );
    }
  }

  const outcomes: AgentActionOutcome[] = [];
  const persistentUndos: Array<{
    inverse: AgentActionCall[];
    label?: string;
    sourceRisk: AgentCapabilityRisk;
  }> = [];
  let sessionUndoRegistrations = 0;
  let currentActionRisk: AgentCapabilityRisk = 'read';
  const registerUndo = options.registerSessionUndo
    ? (invert: () => Promise<void> | void, label: string) => {
        sessionUndoRegistrations += 1;
        options.registerSessionUndo!(invert, label, currentActionRisk);
      }
    : undefined;
  const stopOnFailure = request.stopOnFailure !== false;

  for (let index = 0; index < request.actions.length; index += 1) {
    const action = request.actions[index];
    const capability = capabilities.get(action.name)!;
    currentActionRisk = capability.risk;
    const validationError = validateActionAgainstObservation(action, capability, current);
    if (validationError) {
      outcomes.push(failedOutcome(action, index, validationError));
      if (stopOnFailure) break;
      continue;
    }

    const actionBefore = current;
    const sessionUndoBeforeAction = sessionUndoRegistrations;
    try {
      throwIfAgentOperationAborted(options);
      const result = await executeManifestAction(
        manifest,
        {
          windowId: resolved.win.id,
          typeId: resolved.win.typeId,
          instanceKey: resolved.win.instanceKey,
          runId: options.runId,
          sessionId: options.sessionId,
          signal: options.signal,
          registerUndo,
          observation: current,
        },
        action,
        options,
      );
      if (result.handled
        && result.undo?.inverse
        && sessionUndoRegistrations === sessionUndoBeforeAction) {
        const inverse = Array.isArray(result.undo.inverse)
          ? result.undo.inverse
          : [result.undo.inverse];
        persistentUndos.push({
          inverse,
          label: result.undo.label,
          sourceRisk: capability.risk,
        });
      }
      current = await observeAgentWindow(request, options);
      const verification = verifyExecutedAction(
        action,
        capability,
        result,
        actionBefore,
        current,
      );
      outcomes.push({
        id: action.id,
        index,
        name: action.name,
        targetRef: action.targetRef,
        handled: result.handled,
        changed: result.changed,
        code: result.code,
        hint: result.hint,
        message: result.message,
        entityRefs: result.entityRefs,
        details: result.details,
        verified: verification.verified,
        verificationSource: verification.verificationSource,
        failedConditions: verification.failedConditions,
      });
      // A non-cooperative handler can finish after cancellation and still mutate.
      // Record that authoritative outcome, then stop before another action begins.
      if (options.signal?.aborted) break;
      if ((!result.handled || verification.failedConditions.length > 0) && stopOnFailure) break;
    } catch (error) {
      const failure = isAgentRuntimeError(error)
        ? error
        : new AgentRuntimeError(
            'ACTION_FAILED',
            error instanceof Error ? error.message : String(error),
            '重新 observe 当前状态，再决定重试或降级',
            true,
          );
      outcomes.push(failedOutcome(action, index, failure));
      if (stopOnFailure) break;
    }
  }

  const failedConditions = evaluateAgentConditions(
    current,
    request.expect,
    before.revision,
  );
  const complete = outcomes.length === request.actions.length
    && outcomes.every((outcome) => outcome.handled && outcome.verified)
    && failedConditions.length === 0;
  const handledCount = outcomes.filter((outcome) => outcome.handled).length;
  const receipt: AgentActReceipt = {
    status: complete ? 'completed' : handledCount > 0 ? 'partial' : 'failed',
    windowId: resolved.win.id,
    typeId: resolved.win.typeId,
    beforeRevision: before.revision,
    afterRevision: current.revision,
    results: outcomes,
    verified: complete,
    failedConditions,
    observation: current,
    ...(rebasedFromRevision ? { rebasedFromRevision } : {}),
  };

  const inverse: AgentActionCall[] = [];
  for (let i = persistentUndos.length - 1; i >= 0; i -= 1) {
    inverse.push(...persistentUndos[i].inverse);
  }
  const inverseCapabilities = inverse.map((action) => capabilities.get(action.name));
  const validInverse = inverse.length > 0
    && inverseCapabilities.every(Boolean)
    && inverse.every((action, index) => {
      const capability = inverseCapabilities[index]!;
      const args = action.args ?? (capability.inputSchema.type === 'object' ? {} : undefined);
      return validateSchema(args, capability.inputSchema).length === 0;
    });
  const undoLabel = persistentUndos
    .map((entry) => entry.label)
    .filter(Boolean)
    .join(' / ') || 'Revert semantic actions';
  const requiredUndoRisk = maxAgentRisk([
    ...persistentUndos.map((entry) => entry.sourceRisk),
    ...inverseCapabilities.map((capability) => capability?.risk),
  ]);

  // Closure inverses are process-local. Descriptor-only actions in a mixed batch are
  // attached to that same run ledger so one session token reverts the complete batch.
  if (sessionUndoRegistrations > 0 && options.runId) {
    if (validInverse && options.registerSessionUndo) {
      const descriptorUndo = recordAgentUndo({
        sessionId: options.sessionId ?? '',
        typeId: resolved.win.typeId,
        windowId: resolved.win.id,
        instanceKey: resolved.win.instanceKey,
        inverse,
        expectedRevision: current.revision,
        expectedState: current.state,
        requiredRisk: requiredUndoRisk,
        label: undoLabel,
        persist: false,
      });
      if (descriptorUndo) {
        options.registerSessionUndo(async () => {
          const result = await revertAgentUndo(descriptorUndo.token, {
            ...options,
            registerSessionUndo: undefined,
            signal: undefined,
            approvalRiskCeiling: requiredUndoRisk,
          });
          if (!result.reverted) throw new Error(result.message ?? 'descriptor undo failed');
        }, undoLabel, requiredUndoRisk);
      }
    }
    receipt.undoToken = `acr-run:${options.runId}`;
    receipt.undoDurability = 'session';
  } else if (validInverse) {
    const recorded = recordAgentUndo({
      sessionId: options.sessionId ?? '',
      typeId: resolved.win.typeId,
      windowId: resolved.win.id,
      instanceKey: resolved.win.instanceKey,
      inverse,
      expectedRevision: current.revision,
      expectedState: current.state,
      requiredRisk: requiredUndoRisk,
      label: undoLabel,
      persist: inverseCapabilities.every((capability) => capability?.idempotent === true),
    });
    if (recorded) {
      receipt.undoToken = recorded.token;
      receipt.undoDurability = recorded.durability;
    }
  }
  return receipt;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new AgentRuntimeError(
    'CANCELLED',
    'Agent 等待已取消',
    '重新 observe 后再决定是否等待',
    true,
  ));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new AgentRuntimeError(
        'CANCELLED',
        'Agent 等待已取消',
        '重新 observe 后再决定是否等待',
        true,
      ));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForAgentCondition(
  request: AgentWaitForRequest,
  options: AgentRuntimeOptions = {},
): Promise<AgentWaitForResult> {
  throwIfAgentOperationAborted(options);
  const conditions = [
    ...validateAgentConditions(
      request.condition === undefined ? [] : [request.condition],
      'wait_for.condition',
    ),
    ...validateAgentConditions(request.conditions, 'wait_for.conditions'),
  ];
  if (!conditions.length) {
    runtimeError(
      'INVALID_CONDITION',
      'wait_for 至少需要一个 condition',
      '传入 condition 或 conditions 数组',
    );
  }
  const timeoutMs = Math.min(
    AGENT_WAIT_TIMEOUT_MAX_MS,
    Math.max(0, Number.isFinite(request.timeoutMs) ? Number(request.timeoutMs) : 5_000),
  );
  const intervalMs = Math.min(
    AGENT_WAIT_INTERVAL_MAX_MS,
    Math.max(
      AGENT_WAIT_INTERVAL_MIN_MS,
      Number.isFinite(request.intervalMs) ? Number(request.intervalMs) : 100,
    ),
  );
  const startedAt = Date.now();
  let observation = await observeAgentWindow(request, options);
  const baselineRevision = observation.revision;
  let previousRevision = observation.revision;
  let currentIntervalMs = intervalMs;
  let failures = evaluateAgentConditions(observation, conditions, baselineRevision);
  while (failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    await delay(Math.min(currentIntervalMs, Math.max(0, remaining)), options.signal);
    throwIfAgentOperationAborted(options);
    observation = await observeAgentWindow(request, options);
    failures = evaluateAgentConditions(observation, conditions, baselineRevision);
    if (observation.revision === previousRevision) {
      // Expensive manifests (notably large notes) should not repeatedly hash the
      // complete document at 25/100ms when no state transition is occurring.
      currentIntervalMs = Math.min(
        AGENT_WAIT_INTERVAL_MAX_MS,
        Math.max(intervalMs, Math.ceil(currentIntervalMs * 1.5)),
      );
    } else {
      currentIntervalMs = intervalMs;
      previousRevision = observation.revision;
    }
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  return {
    matched: failures.length === 0,
    timedOut: failures.length > 0,
    elapsedMs,
    failedConditions: failures,
    observation,
  };
}

async function revertAgentUndoLocked(
  undoToken: string,
  options: AgentRuntimeOptions = {},
): Promise<AgentUndoResult> {
  throwIfAgentOperationAborted(options);
  const entry = getAgentUndo(undoToken);
  if (!entry) {
    runtimeError(
      'UNDO_NOT_FOUND',
      `撤销令牌不存在或已使用: ${undoToken}`,
      'session 令牌仅在当前运行期间有效；persistent 令牌也可能已被 LRU 淘汰',
    );
  }
  if (entry.sessionId && entry.sessionId !== options.sessionId) {
    return {
      reverted: false,
      undoToken,
      durability: entry.durability,
      message: '撤销令牌不属于当前会话；令牌已保留',
    };
  }
  const storedWindow = entry.windowId
    ? useWindowStore.getState().windows[entry.windowId]
    : undefined;
  const storedWindowStillMatches = storedWindow?.typeId === entry.typeId
    && storedWindow.instanceKey === entry.instanceKey;
  const resolved = resolveAgentWindow({
    windowId: storedWindowStillMatches ? entry.windowId : undefined,
    typeId: entry.typeId,
    instanceKey: entry.instanceKey ?? undefined,
  });
  if (!resolved.manifest) {
    runtimeError(
      'APP_AGENT_UNAVAILABLE',
      `${entry.typeId} 不再提供 Agent manifest，无法重放 inverse`,
      '恢复该应用的 manifest/execute 后重试，令牌仍会保留',
    );
  }
  const approvalRiskCeiling = normalizeRiskCeiling(options.approvalRiskCeiling);
  if (AGENT_RISK_RANK[entry.requiredRisk] > AGENT_RISK_RANK[approvalRiskCeiling]) {
    return {
      reverted: false,
      undoToken,
      durability: entry.durability,
      message: `撤销需要 ${entry.requiredRisk} 风险授权，当前上限为 ${approvalRiskCeiling}；令牌已保留`,
    };
  }
  const remaining = [...entry.inverse];
  let durability = entry.durability;
  let observation = await observeAgentWindow({ windowId: resolved.win.id }, options);
  const revisionMismatch = storedWindowStillMatches
    && observation.revision !== entry.expectedRevision;
  if (
    revisionMismatch
    || stableSerialize(observation.state) !== stableSerialize(entry.expectedState)
  ) {
    return {
      reverted: false,
      undoToken,
      durability,
      code: 'UNDO_CONFLICT',
      retryable: false,
      observation,
      message: `撤销前状态已变化（期望 revision ${entry.expectedRevision}，当前 ${observation.revision}）；为避免覆盖用户新编辑，令牌已保留`,
    };
  }
  while (remaining.length > 0) {
    throwIfAgentOperationAborted(options);
    const action = remaining[0];
    const capability = resolved.manifest.capabilities.find(
      (candidate) => candidate.name === action.name,
    );
    if (!capability) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: `inverse 动作已不存在: ${action.name}；恢复兼容 capability 后可用同一令牌重试`,
      };
    }
    if (AGENT_RISK_RANK[capability.risk] > AGENT_RISK_RANK[approvalRiskCeiling]) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: `inverse ${action.name} 需要 ${capability.risk} 风险授权；令牌已保留`,
      };
    }
    const args = action.args ?? (capability.inputSchema.type === 'object' ? {} : undefined);
    const schemaErrors = validateSchema(args, capability.inputSchema);
    if (schemaErrors.length) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: `inverse ${action.name} 参数已不兼容: ${schemaErrors.join('; ')}`,
      };
    }
    const validationError = validateActionAgainstObservation(
      action,
      capability,
      observation,
    );
    if (validationError) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: `${validationError.message}；令牌已保留，可在状态恢复后重试`,
      };
    }
    const before = observation;
    let result: AgentActionResult;
    try {
      result = await executeManifestAction(
        resolved.manifest,
        {
          windowId: resolved.win.id,
          typeId: resolved.win.typeId,
          instanceKey: resolved.win.instanceKey,
          runId: options.runId,
          sessionId: options.sessionId,
          signal: options.signal,
          observation: before,
        },
        action,
        options,
      );
      observation = await observeAgentWindow({ windowId: resolved.win.id }, options);
    } catch (error) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: `inverse ${action.name} 执行失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const verification = verifyExecutedAction(
      action,
      capability,
      result,
      before,
      observation,
    );
    if (!verification.verified) {
      return {
        reverted: false,
        undoToken,
        durability,
        observation,
        message: result.message
          ?? result.hint
          ?? verification.failedConditions.map((failure) => failure.message).join('; ')
          ?? `inverse ${action.name} 未通过验证`,
      };
    }
    remaining.shift();
    const updated = updateAgentUndo(undoToken, remaining, {
      revision: observation.revision,
      state: observation.state,
    });
    if (!updated) {
      return {
        reverted: false,
        undoToken,
        durability: 'session',
        observation,
        message: 'inverse 已执行，但撤销进度日志更新失败；请先重新 observe 再决定是否重试',
      };
    }
    durability = updated.durability;
  }
  consumeAgentUndo(undoToken);
  return {
    reverted: true,
    undoToken,
    durability,
    observation,
  };
}

export function revertAgentUndo(
  undoToken: string,
  options: AgentRuntimeOptions = {},
): Promise<AgentUndoResult> {
  const entry = getAgentUndo(undoToken);
  if (entry?.sessionId && entry.sessionId !== options.sessionId) {
    return Promise.resolve({
      reverted: false,
      undoToken,
      durability: entry.durability,
      message: '撤销令牌不属于当前会话；令牌已保留',
    });
  }
  if (entry && hasAgentUndoFlight(undoToken)) {
    return Promise.resolve({
      reverted: false,
      undoToken,
      durability: entry.durability,
      code: 'UNDO_IN_PROGRESS',
      retryable: true,
      message: '同一撤销令牌正在执行；请等待当前 attempt 结束',
    });
  }
  return runAgentUndoExclusive(
    undoToken,
    () => revertAgentUndoLocked(undoToken, options),
  );
}

/** Returns false only when a declared action is mutating; unknown actions stay fail-closed. */
export function isAgentActRequestReadOnly(request: unknown): boolean {
  if (!request || typeof request !== 'object') return false;
  const input = request as Partial<AgentActRequest>;
  if (!Array.isArray(input.actions) || input.actions.length === 0) return false;
  let manifest: AppAgentManifest | undefined;
  try {
    manifest = resolveAgentWindow(input).manifest;
  } catch {
    if (input.typeId) {
      manifest = appRegistry.getAgentManifest(input.typeId)
        ?? virtualAgentManifests.get(input.typeId);
    }
  }
  if (!manifest) return false;
  return input.actions.every((action) => {
    const capability = manifest!.capabilities.find(
      (candidate) => candidate.name === action.name,
    );
    return capability?.mutates === false;
  });
}
