/**
 * Super 会话常驻控制器（仅 main 窗口运行）
 *
 * 职责：
 * 1. 常驻：Super 会话启用时 sessionManager.getOrCreate + adapterManager.getOrCreate
 *    并一直持有 adapter lease（sessionManager LRU 跳过 refCount>0 的会话，
 *    见 sessionManager.evictLRU），保证用户不在该会话时 store 也活着、流式事件照常落地。
 * 2. 恢复：会话加载后调用 workspace restoreExecutions（同时启动后端 CompletionDispatcher）。
 * 3. 投递（SuperInboxController）：收到 workspace_agent_completion（父为 Super）/
 *    super_session_inbox_changed / store 变为可投递 / 启动恢复完成 时，若
 *      sessionStatus==='idle' && !currentStreamingMessageId && queuedMessages 为空
 *      && 无阻塞交互 && 未暂停
 *    则调用 store.deliverSuperInbox()；Busy/Empty 不重试（等下一个触发信号）。
 * 4. 暂停：用户主动停止（store 进入 aborting）后暂停自动投递，直到下一条用户消息
 *    或用户点击提示条「继续处理」（force=true）；后端返回 Paused（连续自动回合上限）同样暂停。
 * 5. 切换：开关关闭 / super_session_changed 指向新会话时释放旧 lease、接管新会话。
 *
 * 状态机（per attached session）：
 *
 *   detached ──attach──▶ attaching ──loaded+restored──▶ running
 *                                                       │  ▲
 *                     用户停止 / 后端 Paused ────────────▼  │ 用户新消息 / 点「继续处理」
 *                                                     paused
 *   任意状态 ──disable / 切换会话──▶ detached（释放 lease）
 *
 * running 内部的投递子状态：idle-wait → delivering → (started → 回合结束再次 idle-wait)
 *                                               → (empty/busy/disabled → idle-wait，不重试)
 */

import type { StoreApi } from 'zustand';
import type { ChatStore, DeliverOutcome } from '../core/types';
import { readBlockingInteraction } from '../core/types/queue';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  getSuperSessionState,
  onSuperSessionChanged,
  onSuperSessionInboxChanged,
  type SuperSessionChangedPayload,
  type SuperSessionInboxChangedPayload,
  type SuperSessionState,
} from './api';
import {
  INITIAL_SUPER_RESIDENT_STATE,
  superResidentStore,
  type SuperInboxPauseReason,
  type SuperResidentState,
} from './residentState';
import { isInboundUserMessage } from './inboundOrigin';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const LOG_PREFIX = '[SuperSession:Resident]';

/** 等待会话数据加载的上限；超时后仍继续（投递条件依旧由 store 状态把关） */
const DATA_LOAD_TIMEOUT_MS = 15_000;

/** 投递后端错误的退避区间 */
const ERROR_BACKOFF_BASE_MS = 2_000;
const ERROR_BACKOFF_MAX_MS = 60_000;

/** workspace_agent_completion 事件名（与 workspace/events.ts WORKSPACE_EVENTS.AGENT_COMPLETION 一致） */
const AGENT_COMPLETION_EVENT = 'workspace_agent_completion';

// ============================================================================
// 依赖注入（测试替身）
// ============================================================================

type UnlistenFn = () => void;

/** 控制器读取的 ChatStore 最小切面 */
export type ResidentChatState = Pick<
  ChatStore,
  | 'sessionStatus'
  | 'currentStreamingMessageId'
  | 'queuedMessages'
  | 'isDataLoaded'
  | 'messageOrder'
  | 'messageMap'
> & {
  pendingBlockingInteraction?: unknown;
  pendingApprovalRequest?: unknown;
  deliverSuperInbox?: (opts?: { force?: boolean }) => Promise<DeliverOutcome>;
};

export interface ResidentAdapterHandle {
  release(): void;
}

export interface WorkspaceAgentCompletionPayload {
  workspace_id?: string;
  agent_session_id?: string;
  parent_session_id?: string;
}

export interface ResidentControllerDeps {
  isMainWindow(): boolean;
  waitUntilReady(): Promise<void>;
  getState(): Promise<SuperSessionState>;
  onChanged(handler: (payload: SuperSessionChangedPayload) => void): Promise<UnlistenFn>;
  onInboxChanged(handler: (payload: SuperSessionInboxChangedPayload) => void): Promise<UnlistenFn>;
  onAgentCompletion(handler: (payload: WorkspaceAgentCompletionPayload) => void): Promise<UnlistenFn>;
  getOrCreateStore(sessionId: string): StoreApi<ResidentChatState>;
  /** 获取并持有 adapter lease（adapter setup 内部会 loadSession） */
  acquireAdapter(sessionId: string, store: StoreApi<ResidentChatState>): Promise<ResidentAdapterHandle>;
  restoreExecutions(workspaceId: string, sessionId: string): Promise<unknown>;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 投递前置条件（不含暂停判断） */
export function isReadyForDelivery(state: ResidentChatState): boolean {
  return (
    state.sessionStatus === 'idle'
    && !state.currentStreamingMessageId
    && (state.queuedMessages?.length ?? 0) === 0
    && readBlockingInteraction(state) == null
  );
}

/** 最新一条「人类」用户消息（不带 inboundOrigin）的 ID */
function lastHumanMessageId(state: ResidentChatState): string | null {
  const order = state.messageOrder ?? [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const message = state.messageMap?.get(order[i]);
    if (message?.role === 'user' && !isInboundUserMessage(message)) return message.id;
  }
  return null;
}

function waitForDataLoaded(store: StoreApi<ResidentChatState>, timeoutMs: number): Promise<void> {
  if (store.getState().isDataLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = store.subscribe((state) => {
      if (state.isDataLoaded) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

// ============================================================================
// 控制器
// ============================================================================

interface AttachedSession {
  readonly sessionId: string;
  readonly token: number;
  workspaceId: string | null;
  store: StoreApi<ResidentChatState> | null;
  adapter: ResidentAdapterHandle | null;
  unsubscribeStore: (() => void) | null;
  /** 恢复完成前不投递 */
  ready: boolean;
  delivering: boolean;
  /** 投递进行中收到的新信号，完成后（非 started）再试一次 */
  rerunRequested: boolean;
  /** 暂停时记录的最后一条人类消息；变化即视为「下一条用户消息」 */
  pauseAnchorMessageId: string | null;
  /** 后端错误退避 */
  consecutiveErrors: number;
  errorBackoffUntil: number;
  backoffTimer: ReturnType<typeof setTimeout> | null;
}

export class SuperResidentController {
  private readonly deps: ResidentControllerDeps;
  private unlisteners: UnlistenFn[] = [];
  private started = false;
  private stopped = false;
  private attached: AttachedSession | null = null;
  private tokenSeq = 0;
  /** 串行化 apply，避免 changed 事件与初始 get_state 交错 */
  private applyChain: Promise<void> = Promise.resolve();

  constructor(deps: ResidentControllerDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async start(): Promise<boolean> {
    if (this.started) return true;
    if (!this.deps.isMainWindow()) {
      console.log(LOG_PREFIX, 'Not the main window; resident controller disabled');
      return false;
    }
    this.started = true;
    await this.deps.waitUntilReady();
    if (this.stopped) return false;

    const register = async (subscribe: Promise<UnlistenFn>) => {
      const unlisten = await subscribe;
      if (this.stopped) {
        unlisten();
        return;
      }
      this.unlisteners.push(unlisten);
    };

    await Promise.all([
      register(this.deps.onChanged((payload) => this.handleChanged(payload))),
      register(this.deps.onInboxChanged((payload) => this.handleInboxChanged(payload))),
      register(this.deps.onAgentCompletion((payload) => this.handleAgentCompletion(payload))),
    ]);
    if (this.stopped) return false;

    await this.refreshFromBackend();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unlisten of this.unlisteners.splice(0)) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
    await this.enqueueApply(async () => this.detach());
  }

  /** 当前常驻会话 ID（测试/诊断用） */
  getAttachedSessionId(): string | null {
    return this.attached?.sessionId ?? null;
  }

  // ---------------------------------------------------------------------------
  // 用户操作
  // ---------------------------------------------------------------------------

  /** 提示条「继续处理 N 条待处理事件」：解除暂停并强制投递一次 */
  async resume(): Promise<DeliverOutcome | null> {
    const attached = this.attached;
    if (!attached) return null;
    attached.pauseAnchorMessageId = null;
    this.patchState({ resuming: true });
    try {
      const outcome = await this.tryDeliver('resume', { force: true });
      if (outcome === null || outcome.status === 'busy') {
        // 条件不满足 / 后端忙：解除暂停，等下一次空闲自动投递
        this.patchState({ pausedReason: null, autoTurns: 0 });
      }
      return outcome;
    } finally {
      this.patchState({ resuming: false });
    }
  }

  // ---------------------------------------------------------------------------
  // 事件处理
  // ---------------------------------------------------------------------------

  private handleChanged(payload: SuperSessionChangedPayload): void {
    if (!payload.enabled || !payload.sessionId) {
      void this.enqueueApply(async () => this.detach());
      return;
    }
    if (this.attached?.sessionId === payload.sessionId) return;
    void this.refreshFromBackend();
  }

  private handleInboxChanged(payload: SuperSessionInboxChangedPayload): void {
    const attached = this.attached;
    if (!attached || attached.sessionId !== payload.sessionId) return;
    this.patchState({ pendingInbox: payload.pendingInbox });
    if (payload.pendingInbox > 0) void this.tryDeliver('inbox_changed');
  }

  private handleAgentCompletion(payload: WorkspaceAgentCompletionPayload): void {
    const attached = this.attached;
    if (!attached) return;
    const isOurs =
      payload.parent_session_id === attached.sessionId
      || (!!attached.workspaceId && payload.workspace_id === attached.workspaceId);
    if (!isOurs) return;
    void this.refreshPendingCount(attached);
    void this.tryDeliver('agent_completion');
  }

  // ---------------------------------------------------------------------------
  // 常驻：attach / detach
  // ---------------------------------------------------------------------------

  private enqueueApply(task: () => Promise<void>): Promise<void> {
    const next = this.applyChain.then(task, task);
    this.applyChain = next.catch((error: unknown) => {
      console.error(LOG_PREFIX, 'apply failed:', error);
    });
    return this.applyChain;
  }

  private async refreshFromBackend(): Promise<void> {
    let state: SuperSessionState;
    try {
      state = await this.deps.getState();
    } catch (error: unknown) {
      console.warn(LOG_PREFIX, 'super_session_get_state failed:', error);
      return;
    }
    await this.enqueueApply(async () => this.applyState(state));
  }

  private async applyState(state: SuperSessionState): Promise<void> {
    if (this.stopped) return;
    if (!state.enabled || !state.sessionId) {
      this.detach();
      return;
    }
    if (this.attached?.sessionId === state.sessionId) {
      this.attached.workspaceId = state.workspaceId ?? this.attached.workspaceId;
      this.patchState({ workspaceId: this.attached.workspaceId, pendingInbox: state.pendingInbox });
      return;
    }
    this.detach();
    await this.attach(state);
  }

  private async attach(state: SuperSessionState): Promise<void> {
    const sessionId = state.sessionId!;
    const attached: AttachedSession = {
      sessionId,
      token: ++this.tokenSeq,
      workspaceId: state.workspaceId,
      store: null,
      adapter: null,
      unsubscribeStore: null,
      ready: false,
      delivering: false,
      rerunRequested: false,
      pauseAnchorMessageId: null,
      consecutiveErrors: 0,
      errorBackoffUntil: 0,
      backoffTimer: null,
    };
    this.attached = attached;
    superResidentStore.setState({
      ...INITIAL_SUPER_RESIDENT_STATE,
      sessionId,
      workspaceId: state.workspaceId,
      pendingInbox: state.pendingInbox,
    });
    const isCurrent = () => this.attached === attached && !this.stopped;

    try {
      const store = this.deps.getOrCreateStore(sessionId);
      attached.store = store;
      const adapter = await this.deps.acquireAdapter(sessionId, store);
      if (!isCurrent()) {
        adapter.release();
        return;
      }
      attached.adapter = adapter;
      console.log(LOG_PREFIX, `Holding resident lease for Super session ${sessionId}`);

      await waitForDataLoaded(store, DATA_LOAD_TIMEOUT_MS);
      if (!isCurrent()) return;

      attached.unsubscribeStore = store.subscribe((next, prev) => {
        if (this.attached !== attached) return;
        this.handleStoreChange(attached, next, prev);
      });

      if (attached.workspaceId) {
        try {
          await this.deps.restoreExecutions(attached.workspaceId, sessionId);
        } catch (error: unknown) {
          console.warn(LOG_PREFIX, 'restoreExecutions failed (continuing):', error);
        }
        if (!isCurrent()) return;
      }

      attached.ready = true;
      void this.tryDeliver('restore');
    } catch (error: unknown) {
      console.error(LOG_PREFIX, `Failed to attach Super session ${sessionId}:`, error);
      if (this.attached === attached) this.detach();
    }
  }

  private detach(): void {
    const attached = this.attached;
    if (!attached) return;
    this.attached = null;
    attached.unsubscribeStore?.();
    attached.unsubscribeStore = null;
    if (attached.backoffTimer) clearTimeout(attached.backoffTimer);
    attached.backoffTimer = null;
    if (attached.adapter) {
      try {
        attached.adapter.release();
      } catch (error: unknown) {
        console.warn(LOG_PREFIX, 'Failed to release resident lease:', error);
      }
      attached.adapter = null;
    }
    superResidentStore.setState({ ...INITIAL_SUPER_RESIDENT_STATE });
    console.log(LOG_PREFIX, `Released resident lease for Super session ${attached.sessionId}`);
  }

  // ---------------------------------------------------------------------------
  // store 观察：停止→暂停、用户新消息→恢复、变为可投递→投递
  // ---------------------------------------------------------------------------

  private handleStoreChange(
    attached: AttachedSession,
    next: ResidentChatState,
    prev: ResidentChatState,
  ): void {
    // 1) 用户主动停止：store 进入 aborting（只有 abortStream 会设置该状态）
    if (next.sessionStatus === 'aborting' && prev.sessionStatus !== 'aborting') {
      this.pause(attached, 'user_stop', 0);
    }

    // 2) 暂停中出现新的人类消息 → 恢复自动投递（该回合结束后的空闲会触发投递）
    if (
      superResidentStore.getState().pausedReason !== null
      && next.messageOrder !== prev.messageOrder
    ) {
      const latestHuman = lastHumanMessageId(next);
      if (latestHuman && latestHuman !== attached.pauseAnchorMessageId) {
        attached.pauseAnchorMessageId = null;
        this.patchState({ pausedReason: null, autoTurns: 0 });
      }
    }

    // 3) 变为可投递（回合结束 / 队列清空 / 审批解除）。
    //    投递进行中的状态抖动（deliverSuperInbox 先建占位进入 streaming，
    //    empty/busy/paused 时回滚为 idle）不是新信号，忽略，否则 Empty 会自激循环。
    if (!attached.delivering && isReadyForDelivery(next) && !isReadyForDelivery(prev)) {
      void this.tryDeliver('idle');
    }
  }

  private pause(attached: AttachedSession, reason: SuperInboxPauseReason, autoTurns: number): void {
    if (this.attached !== attached) return;
    attached.pauseAnchorMessageId = attached.store ? lastHumanMessageId(attached.store.getState()) : null;
    this.patchState({ pausedReason: reason, autoTurns });
    console.log(LOG_PREFIX, `Auto delivery paused (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // 投递
  // ---------------------------------------------------------------------------

  private async tryDeliver(
    trigger: string,
    opts: { force?: boolean } = {},
  ): Promise<DeliverOutcome | null> {
    const attached = this.attached;
    if (!attached || !attached.ready || !attached.store) return null;
    if (attached.delivering) {
      attached.rerunRequested = true;
      return null;
    }
    const force = opts.force === true;
    if (!force && superResidentStore.getState().pausedReason !== null) return null;
    // 后端错误退避期内只接受用户强制投递（退避到期由定时器补一次）
    if (!force && Date.now() < attached.errorBackoffUntil) return null;

    const state = attached.store.getState();
    if (!isReadyForDelivery(state)) return null;
    if (typeof state.deliverSuperInbox !== 'function') {
      console.warn(LOG_PREFIX, 'store.deliverSuperInbox is not available');
      return null;
    }

    attached.delivering = true;
    attached.rerunRequested = false;
    let outcome: DeliverOutcome | null = null;
    try {
      outcome = await state.deliverSuperInbox({ force });
      console.log(LOG_PREFIX, `deliver (${trigger}${force ? ', force' : ''}) → ${outcome.status}`);
      attached.consecutiveErrors = 0;
      attached.errorBackoffUntil = 0;
    } catch (error: unknown) {
      this.scheduleErrorBackoff(attached, trigger, error);
    } finally {
      attached.delivering = false;
    }
    if (this.attached !== attached) return outcome;

    if (outcome) this.applyOutcome(attached, outcome, force);

    // 投递进行中又来了新信号，且这次没有开回合：再试一次（仍受全部条件约束）
    // Busy 不重试（回合结束的空闲会再触发）；错误走退避定时器
    if (attached.rerunRequested && outcome?.status === 'empty') {
      attached.rerunRequested = false;
      void this.tryDeliver(`${trigger}:rerun`);
    }
    return outcome;
  }

  /**
   * 后端真实错误：指数退避（2s → 4s → … ≤ 60s）；日志只在退避升级时输出，封顶后静默，
   * 避免刷屏；到期后自动补投一次（仍受全部投递条件约束）。
   */
  private scheduleErrorBackoff(attached: AttachedSession, trigger: string, error: unknown): void {
    attached.consecutiveErrors += 1;
    const delay = Math.min(
      ERROR_BACKOFF_MAX_MS,
      ERROR_BACKOFF_BASE_MS * 2 ** (attached.consecutiveErrors - 1),
    );
    attached.errorBackoffUntil = Date.now() + delay;
    if (attached.consecutiveErrors === 1 || delay < ERROR_BACKOFF_MAX_MS) {
      console.warn(
        LOG_PREFIX,
        `deliver (${trigger}) failed (#${attached.consecutiveErrors}); retry in ${delay}ms:`,
        error,
      );
    }
    if (attached.backoffTimer) clearTimeout(attached.backoffTimer);
    attached.backoffTimer = setTimeout(() => {
      attached.backoffTimer = null;
      if (this.attached === attached) void this.tryDeliver('error_backoff');
    }, delay);
  }

  private applyOutcome(attached: AttachedSession, outcome: DeliverOutcome, force: boolean): void {
    switch (outcome.status) {
      case 'started':
        attached.pauseAnchorMessageId = null;
        this.patchState({ pausedReason: null, autoTurns: 0 });
        void this.refreshPendingCount(attached);
        break;
      case 'paused':
        this.pause(attached, 'auto_limit', outcome.autoTurns);
        void this.refreshPendingCount(attached);
        break;
      case 'empty':
        if (force) this.patchState({ pausedReason: null, autoTurns: 0 });
        this.patchState({ pendingInbox: 0 });
        break;
      case 'disabled':
        void this.refreshFromBackend();
        break;
      case 'busy':
      default:
        break;
    }
  }

  private async refreshPendingCount(attached: AttachedSession): Promise<void> {
    try {
      const state = await this.deps.getState();
      if (this.attached !== attached || state.sessionId !== attached.sessionId) return;
      if (state.workspaceId) attached.workspaceId = state.workspaceId;
      this.patchState({ pendingInbox: state.pendingInbox, workspaceId: attached.workspaceId });
    } catch {
      /* 计数刷新失败不影响投递 */
    }
  }

  private patchState(patch: Partial<SuperResidentState>): void {
    superResidentStore.setState(patch);
  }
}

// ============================================================================
// 生产环境依赖与单例
// ============================================================================

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * 当前 webview 是否为主窗口（label === 'main'）。
 * 轻量窗口（?window=quick-assistant / pomodoro-mini）与会话新窗口一律返回 false。
 */
export function detectMainWindow(): boolean {
  if (!isTauriEnvironment()) return false;
  try {
    if (new URLSearchParams(window.location.search).get('window') !== null) return false;
  } catch {
    /* ignore */
  }
  try {
    const internals = (window as {
      __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } };
    }).__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label;
    return label === 'main';
  } catch {
    return false;
  }
}

function createProductionDeps(): ResidentControllerDeps {
  return {
    isMainWindow: detectMainWindow,
    waitUntilReady: async () => {
      try {
        const tauriApi = (await import('@/utils/tauriApi')) as {
          waitForTauriReady?: () => Promise<void>;
        };
        await tauriApi.waitForTauriReady?.();
      } catch {
        /* 不可用时直接继续 */
      }
    },
    getState: getSuperSessionState,
    onChanged: onSuperSessionChanged,
    onInboxChanged: onSuperSessionInboxChanged,
    onAgentCompletion: async (handler) => {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<WorkspaceAgentCompletionPayload>(AGENT_COMPLETION_EVENT, (event) => {
        if (event.payload) handler(event.payload);
      });
    },
    getOrCreateStore: (sessionId) => {
      // sessionManager / adapterManager 经 loadChatModules 动态加载后缓存（避免 init 期循环依赖）
      if (!chatModules) throw new Error('chat modules not loaded');
      return chatModules.sessionManager.getOrCreate(sessionId) as unknown as StoreApi<ResidentChatState>;
    },
    acquireAdapter: async (sessionId, store) => {
      if (!chatModules) throw new Error('chat modules not loaded');
      const { adapterManager } = chatModules;
      const acquisition = await adapterManager.getOrCreate(
        sessionId,
        store as unknown as StoreApi<ChatStore>,
      );
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          adapterManager.release(sessionId, acquisition.lease);
        },
      };
    },
    restoreExecutions: async (workspaceId, sessionId) => {
      const { restoreExecutions } = await import('../workspace/api');
      return restoreExecutions(workspaceId, sessionId);
    },
  };
}

interface ChatModules {
  sessionManager: typeof import('../core/session/sessionManager')['sessionManager'];
  adapterManager: typeof import('../adapters/AdapterManager')['adapterManager'];
}

let chatModules: ChatModules | null = null;

async function loadChatModules(): Promise<void> {
  if (chatModules) return;
  const [{ sessionManager }, { adapterManager }] = await Promise.all([
    import('../core/session/sessionManager'),
    import('../adapters/AdapterManager'),
  ]);
  chatModules = { sessionManager, adapterManager };
}

let residentController: SuperResidentController | null = null;

/** 在 chat init 中调用；非 main 窗口 / 非 Tauri 环境直接返回 */
export async function startSuperResidentController(): Promise<void> {
  if (!detectMainWindow()) return;
  if (residentController) await residentController.stop();
  await loadChatModules();
  const controller = new SuperResidentController(createProductionDeps());
  residentController = controller;
  await controller.start();
}

export async function stopSuperResidentController(): Promise<void> {
  const controller = residentController;
  residentController = null;
  await controller?.stop();
}

/** 提示条「继续处理」入口 */
export function resumeSuperInboxDelivery(): Promise<DeliverOutcome | null> {
  return residentController?.resume() ?? Promise.resolve(null);
}
