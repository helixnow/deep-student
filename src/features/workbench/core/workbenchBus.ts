/**
 * workbenchBus — 三分打开语义（launch / activate / project）+ legacy 降级
 *
 * 主责 P1（可完善内部实现），接口冻结。
 * 业务模块只 import { workbenchBus } from '@/features/workbench'。
 *
 * legacy 降级：workbench 未启用时，launch/activate 转发为现有 CustomEvent
 * 导航（映射表由接线代理 P11 补全 registerLegacyFallback）。
 */
import type {
  ActivateRequest,
  ActivationHandlerResult,
  ActivationResult,
  AgentActRequest,
  AgentAppContext,
  AgentWaitForRequest,
  AgentWindowTarget,
  LaunchRequest,
  ProjectRequest,
} from './types';
import { appRegistry } from './appRegistry';
import {
  actOnAgentWindow,
  getAgentCapabilities,
  observeAgentWindow,
  revertAgentUndo,
  waitForAgentCondition,
  type AgentRuntimeOptions,
} from './agentRuntime';
import { useWindowStore } from './windowStore';
import { confirmWindowClose } from './windowCloseGuard';
import {
  activateWorkspaceResource,
  requestWorkspaceResource,
  type NotesWorkspaceResourceRef,
} from '../apps/notes/workspaceRegistry';
import {
  requestResourceWorkspace,
  type ResourceWorkspaceType,
} from '../apps/content/resourceWorkspaceRegistry';

export type LegacyFallbackHandler = (req: LaunchRequest | ActivateRequest, kind: 'launch' | 'activate') => void;

let enabled = false;
let legacyFallback: LegacyFallbackHandler | null = null;

/** 最近一次 activate 的 onActivation 结构化回执（供 StageManager app_command） */
let lastActivationResult: ActivationResult | null = null;

const activationReadiness = new Map<string, boolean>();
interface ActivationWaiter {
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
const activationWaiters = new Map<string, Set<ActivationWaiter>>();
const ACTIVATION_READY_TIMEOUT_MS = 10_000;
const NOTES_WORKSPACE_TYPE_ID = 'notes';
const RESOURCE_WORKSPACE_TYPE_IDS = new Set(['exam', 'essay']);

function toWorkspaceResource(typeId: string, resourceId?: string): NotesWorkspaceResourceRef | null {
  if ((typeId !== 'note' && typeId !== 'mindmap') || !resourceId?.trim()) return null;
  return { type: typeId, id: resourceId.trim() };
}

export interface ActivationDispatchResult {
  /** false 表示目标不存在、未能挂载，或指令未送达处理器。 */
  delivered: boolean;
  result: ActivationResult;
}

function settleActivationWaiters(windowId: string, ready: boolean): void {
  const waiters = activationWaiters.get(windowId);
  if (!waiters) return;
  activationWaiters.delete(windowId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(ready);
  }
}

/** WindowBody 在 Suspense fallback 提交时标记 pending。 */
export function markWindowActivationPending(windowId: string): void {
  activationReadiness.set(windowId, false);
}

/** lazy App 真正提交、其子树 effects 已安装后标记 ready 并冲刷等待请求。 */
export function markWindowActivationReady(windowId: string): void {
  activationReadiness.set(windowId, true);
  settleActivationWaiters(windowId, true);
}

/**
 * WindowBody 宿主卸载（关窗 / 冻结卸载 App 子树）时收口：删除 readiness
 * 条目并以 not-ready 冲刷 waiters，避免留下 stale `false` 让后续
 * waitForActivationTarget 白等 10s 超时。
 */
export function clearWindowActivation(windowId: string): void {
  activationReadiness.delete(windowId);
  settleActivationWaiters(windowId, false);
}

async function waitForActivationTarget(windowId: string): Promise<boolean> {
  // 刚 launch 的窗口尚未经过一次 React commit；先让 WindowBody 有机会登记 pending。
  if (!activationReadiness.has(windowId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!useWindowStore.getState().windows[windowId]) return false;
  const readiness = activationReadiness.get(windowId);
  // unknown 表示无 WindowBody 宿主（core/legacy 场景），保持旧契约直接送达。
  if (readiness !== false) return true;
  return new Promise<boolean>((resolve) => {
    const waiter: ActivationWaiter = {
      resolve,
      timer: setTimeout(() => {
        const set = activationWaiters.get(windowId);
        set?.delete(waiter);
        if (set?.size === 0) activationWaiters.delete(windowId);
        resolve(false);
      }, ACTIVATION_READY_TIMEOUT_MS),
    };
    const set = activationWaiters.get(windowId) ?? new Set<ActivationWaiter>();
    set.add(waiter);
    activationWaiters.set(windowId, set);
    // ready 可能在创建 waiter 前一刻到达，二次确认封住竞态窗口。
    if (activationReadiness.get(windowId) === true) {
      settleActivationWaiters(windowId, true);
    }
  });
}

useWindowStore.subscribe((state, prev) => {
  if (state.windows === prev.windows) return;
  for (const windowId of activationReadiness.keys()) {
    if (state.windows[windowId]) continue;
    activationReadiness.delete(windowId);
    settleActivationWaiters(windowId, false);
  }
});

function normalizeActivationResult(raw: ActivationHandlerResult): ActivationResult {
  if (raw === false) return { handled: false };
  if (raw && typeof raw === 'object' && 'handled' in raw) {
    return {
      handled: Boolean(raw.handled),
      ...('acknowledged' in raw && typeof raw.acknowledged === 'boolean'
        ? { acknowledged: raw.acknowledged }
        : {}),
      code: typeof raw.code === 'string' ? raw.code : undefined,
      hint: typeof raw.hint === 'string' ? raw.hint : undefined,
      message: typeof raw.message === 'string' ? raw.message : undefined,
    };
  }
  return { handled: true };
}

async function executeLegacyAgentAction(
  ctx: AgentAppContext,
  action: { name: string; args?: unknown; targetRef?: string },
): Promise<ActivationHandlerResult> {
  const def = appRegistry.get(ctx.typeId);
  if (!def?.onActivation) return false;
  if (!(await waitForActivationTarget(ctx.windowId))) {
    return {
      handled: false,
      code: 'ACTIVATION_NOT_READY',
      hint: '目标窗口内容未能完成挂载，请稍后重试',
    };
  }
  return def.onActivation({
    windowId: ctx.windowId,
    instanceKey: ctx.instanceKey,
    action: action.name,
    payload: action.args ?? (action.targetRef ? { targetRef: action.targetRef } : undefined),
  });
}

function withLegacyAgentExecutor(options: AgentRuntimeOptions): AgentRuntimeOptions {
  return {
    ...options,
    executeLegacy: options.executeLegacy ?? executeLegacyAgentAction,
  };
}

export const workbenchBus = {
  /** 由设置层（P10）在开关变化时调用 */
  setEnabled(value: boolean): void {
    enabled = value;
  },

  isEnabled(): boolean {
    return enabled;
  },

  /** 由接线代理（P11）注册：开关关闭时把请求翻译回现有 CustomEvent 导航 */
  registerLegacyFallback(handler: LegacyFallbackHandler): void {
    legacyFallback = handler;
  },

  /** 打开应用：multi+同 instanceKey → focus 已有；single → focus 或新建 */
  launch(req: LaunchRequest): string | null {
    if (!enabled) {
      legacyFallback?.(req, 'launch');
      return null;
    }
    const store = useWindowStore.getState();
    const workspaceResource = toWorkspaceResource(req.typeId, req.instanceKey);
    if (workspaceResource && appRegistry.get(NOTES_WORKSPACE_TYPE_ID)) {
      const windowId = store.openWindow({
        typeId: NOTES_WORKSPACE_TYPE_ID,
        instanceKey: null,
        payload: {
          resourceType: workspaceResource.type,
          resourceId: workspaceResource.id,
        },
        dropPoint: req.dropPoint,
      });
      void requestWorkspaceResource(workspaceResource, windowId).catch((error) => {
        console.warn('[workbench:notes] failed to open resource:', error);
      });
      return windowId;
    }
    if (RESOURCE_WORKSPACE_TYPE_IDS.has(req.typeId)) {
      const resourceId = req.instanceKey?.trim() || null;
      const windowId = store.openWindow({
        typeId: req.typeId,
        instanceKey: null,
        payload: resourceId ? { resourceId } : req.payload,
        dropPoint: req.dropPoint,
      });
      if (resourceId) requestResourceWorkspace(req.typeId as ResourceWorkspaceType, resourceId);
      return windowId;
    }
    return store.openWindow({
      typeId: req.typeId,
      instanceKey: req.instanceKey ?? null,
      payload: req.payload,
      dropPoint: req.dropPoint,
    });
  },

  /** 读取并清空最近一次 activate 的结构化回执 */
  consumeLastActivationResult(): ActivationResult | null {
    const r = lastActivationResult;
    lastActivationResult = null;
    return r;
  },

  /** Discover semantic capabilities without opening or focusing a window. */
  getAgentCapabilities(target: AgentWindowTarget = {}) {
    return getAgentCapabilities(target);
  },

  /** Structured, bounded observation of one internal application window. */
  observeAgent(
    target: AgentWindowTarget = {},
    options: AgentRuntimeOptions = {},
  ) {
    return observeAgentWindow(target, options);
  },

  /** Optimistic-concurrency checked semantic action batch. */
  actAgent(
    request: AgentActRequest,
    options: AgentRuntimeOptions = {},
  ) {
    return actOnAgentWindow(request, withLegacyAgentExecutor(options));
  },

  /** Bounded polling wait over structured observation conditions. */
  waitForAgent(
    request: AgentWaitForRequest,
    options: AgentRuntimeOptions = {},
  ) {
    return waitForAgentCondition(request, options);
  },

  /** Replay a serializable inverse descriptor from the bounded undo journal. */
  revertAgentAction(
    undoToken: string,
    options: AgentRuntimeOptions = {},
  ) {
    return revertAgentUndo(undoToken, withLegacyAgentExecutor(options));
  },

  /** 对已存在窗口发一次性指令；不存在且有 fallbackLaunch 则先 launch */
  async activateDetailed(req: ActivateRequest): Promise<ActivationDispatchResult> {
    lastActivationResult = null;
    if (!enabled) {
      legacyFallback?.(req, 'activate');
      lastActivationResult = {
        handled: false,
        code: 'WORKBENCH_DISABLED',
        hint: '桌面模式未开启',
      };
      return { delivered: false, result: lastActivationResult };
    }
    const store = useWindowStore.getState();
    const workspaceResource = toWorkspaceResource(req.typeId, req.instanceKey);
    if (workspaceResource && appRegistry.get(NOTES_WORKSPACE_TYPE_ID)) {
      let workspaceWindow = Object.values(store.windows).find(
        (window) => window.typeId === NOTES_WORKSPACE_TYPE_ID,
      );
      if (!workspaceWindow && req.fallbackLaunch) {
        const windowId = workbenchBus.launch({
          ...req.fallbackLaunch,
          typeId: req.typeId,
          instanceKey: req.instanceKey,
        });
        workspaceWindow = windowId
          ? useWindowStore.getState().windows[windowId]
          : undefined;
      }
      if (!workspaceWindow) {
        lastActivationResult = {
          handled: false,
          code: 'WINDOW_NOT_FOUND',
          hint: '笔记应用未打开；可带 fallbackLaunch 自动打开',
        };
        return { delivered: false, result: lastActivationResult };
      }
      useWindowStore.getState().focusWindow(workspaceWindow.id);
      const activation = await activateWorkspaceResource(
        workspaceResource,
        req.action,
        req.payload,
        workspaceWindow.id,
      );
      lastActivationResult = activation.result;
      return {
        delivered: activation.windowId != null,
        result: activation.result,
      };
    }
    // R2-04：single 按 typeId；multi 精确 instanceKey；空 key 回落焦点窗/同 type 首窗
    const def = appRegistry.get(req.typeId);
    let win: (typeof store.windows)[string] | undefined;
    if (def?.instanceMode === 'single') {
      win = Object.values(store.windows).find((w) => w.typeId === req.typeId);
    } else if (req.instanceKey) {
      win = Object.values(store.windows).find(
        (w) => w.typeId === req.typeId && w.instanceKey === req.instanceKey,
      );
    } else {
      const focusedId = store.focusStack[store.focusStack.length - 1];
      const focused = focusedId ? store.windows[focusedId] : undefined;
      if (focused?.typeId === req.typeId) {
        win = focused;
      } else {
        win = Object.values(store.windows).find((w) => w.typeId === req.typeId);
      }
    }
    if (!win && req.fallbackLaunch) {
      const id = workbenchBus.launch(req.fallbackLaunch);
      win = id ? store.windows[id] ?? useWindowStore.getState().windows[id] : undefined;
    }
    if (!win) {
      lastActivationResult = {
        handled: false,
        code: 'WINDOW_NOT_FOUND',
        hint: '目标窗口未打开；可先 open_app 或带 fallbackLaunch',
      };
      return { delivered: false, result: lastActivationResult };
    }
    useWindowStore.getState().focusWindow(win.id);
    if (def?.onActivation && !(await waitForActivationTarget(win.id))) {
      const result: ActivationResult = {
        handled: false,
        code: 'ACTIVATION_NOT_READY',
        hint: '目标窗口内容未能完成挂载，请稍后重试',
      };
      lastActivationResult = result;
      return { delivered: false, result };
    }
    const raw = await def?.onActivation?.({
      windowId: win.id,
      // Single resource workspaces keep a null window instanceKey. Preserve the
      // caller's exact resource target so activation can switch/validate it.
      instanceKey: req.instanceKey ?? win.instanceKey,
      action: req.action,
      payload: req.payload,
    });
    const detail = normalizeActivationResult(raw);
    lastActivationResult = detail;
    return { delivered: true, result: detail };
  },

  /** 兼容布尔交付语义；需要无竞态结构化回执的调用方使用 activateDetailed。 */
  async activate(req: ActivateRequest): Promise<boolean> {
    try {
      return (await workbenchBus.activateDetailed(req)).delivered;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastActivationResult = {
        handled: false,
        code: 'ACTIVATION_FAILED',
        hint: '目标应用拒绝了激活指令',
        message,
      };
      console.warn('[workbench] activation failed:', error);
      return false;
    }
  },

  /** 长活业务实例投射：实例出现 → 保证有窗；结束由宿主 closeWindow */
  project(req: ProjectRequest): string | null {
    if (!enabled) return null;
    const store = useWindowStore.getState();
    const existing = Object.values(store.windows).find(
      (w) => w.typeId === req.typeId && w.instanceKey === req.instanceKey,
    );
    if (existing) return existing.id;
    return store.openWindow({
      typeId: req.typeId,
      instanceKey: req.instanceKey,
      title: req.title,
      initialFrame: req.initialFrame,
    });
  },

  /** 关闭（走 canClose 拦截） */
  async closeWindow(id: string): Promise<boolean> {
    const store = useWindowStore.getState();
    if (!store.windows[id]) return true;
    if (!(await confirmWindowClose(id))) return false;
    if (!useWindowStore.getState().windows[id]) return true;
    useWindowStore.getState().closeWindow(id);
    return true;
  },
};
