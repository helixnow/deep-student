/**
 * 工作区事件监听
 * 
 * 监听后端发射的工作区相关事件，更新 workspaceStore
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useWorkspaceStore, parseAgentStatus } from './workspaceStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from 'i18next';
import type {
  WorkspaceMessage,
  WorkspaceAgent,
  WorkspaceDocument,
  AgentCompletionEnvelope,
  AgentStatus,
} from './types';
import { isLegacyFrontendWorkerStartEnabled } from './runtimeMode';
// 🆕 P25: 导入子代理事件日志函数
import { addSubagentEventLog } from '../debug/exportSessionDebug';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { adapterManager } from '../adapters/AdapterManager';
import type {
  AdapterEntry,
  AdapterLease,
} from '../adapters/AdapterManager';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__)
  );
}

// ============================================================
// 事件类型
// ============================================================

export const WORKSPACE_EVENTS = {
  MESSAGE_RECEIVED: 'workspace_message_received',
  AGENT_JOINED: 'workspace_agent_joined',
  AGENT_LEFT: 'workspace_agent_left',
  AGENT_STATUS_CHANGED: 'workspace_agent_status_changed',
  DOCUMENT_UPDATED: 'workspace_document_updated',
  WORKSPACE_CLOSED: 'workspace_closed',
  WORKER_READY: 'workspace_worker_ready',
  /** Runtime-owned terminal envelope. This is the authoritative run result. */
  AGENT_COMPLETION: 'workspace_agent_completion',
  /** 🆕 主代理被唤醒事件（睡眠块被唤醒后发射，触发管线恢复） */
  COORDINATOR_AWAKENED: 'workspace_coordinator_awakened',
  /** 🆕 P38: 子代理重试事件（子代理完成但没发消息） */
  SUBAGENT_RETRY: 'workspace_subagent_retry',
  /** 🆕 工作区警告事件（容量溢出、重试耗尽等） */
  WORKSPACE_WARNING: 'workspace_warning',
} as const;

export interface WorkspaceMessageEvent {
  workspace_id: string;
  message: {
    id: string;
    sender_session_id: string;
    target_session_id?: string;
    message_type: string;
    content: string;
    status: string;
    created_at: string;
  };
}

export interface WorkspaceAgentEvent {
  workspace_id: string;
  agent: {
    session_id: string;
    role: string;
    status: string;
    skill_id?: string;
    joined_at: string;
    last_active_at: string;
  };
}

export interface WorkspaceAgentStatusEvent {
  workspace_id: string;
  session_id: string;
  status: string;
}

export interface WorkspaceDocumentEvent {
  workspace_id: string;
  document: {
    id: string;
    doc_type: string;
    title: string;
    version: number;
    updated_by: string;
    updated_at: string;
  };
}

export interface WorkspaceClosedEvent {
  workspace_id: string;
}

export interface WorkspaceWorkerReadyEvent {
  workspace_id: string;
  agent_session_id: string;
  skill_id?: string;
  /** 🆕 P38: 子代理没发消息时的提醒内容 */
  reminder?: string;
  /** False only for an explicitly legacy backend that expects UI startup. */
  runtime_managed?: boolean;
}

export interface WorkspaceAgentCompletionEvent {
  workspace_id: string;
  agent_session_id: string;
  task_id?: string;
  run_id?: string;
  correlation_id?: string;
  status: string;
  final_output?: string;
  error?: string;
  completed_at?: string;
  token_usage?: Record<string, number>;
}

/** 🆕 主代理唤醒事件 payload */
export interface CoordinatorAwakenedEvent {
  workspace_id: string;
  coordinator_session_id: string;
  sleep_id: string;
  awakened_by: string;
  awaken_message?: string;
  wake_reason: string;
}

/** 🆕 P38: 子代理重试事件 payload */
export interface SubagentRetryEvent {
  workspace_id: string;
  agent_session_id: string;
  /** 'no_message_sent'（正在重试）或 'max_retries_exceeded'（终局失败） */
  reason: string;
  message: string;
  retry_count?: number;
}

/** 🆕 工作区警告事件 payload */
export interface WorkspaceWarningEvent {
  workspace_id: string;
  code: string;
  message: string;
  agent_session_id?: string | null;
  message_id?: string | null;
  retry_count?: number | null;
  max_retries?: number | null;
}

// ============================================================
// 事件监听器
// ============================================================

let unlistenFns: UnlistenFn[] = [];
let workspaceEventGeneration = 0;

// 🔧 P24 修复：跟踪已处理的 WORKER_READY 事件，防止重复启动
const processedWorkerReadyEvents = new Set<string>();

// 🔧 P34 修复：跟踪已处理的 COORDINATOR_AWAKENED 事件，防止重复恢复 pipeline
const processedAwakenedEvents = new Set<string>();

interface WorkerStartAttempt {
  readonly token: symbol;
  readonly workspaceId: string;
  readonly listenerGeneration: number;
  cancelled: boolean;
}

interface WorkerAdapterLeaseRecord {
  readonly workspaceId: string;
  readonly listenerGeneration: number;
  readonly entry: AdapterEntry;
  readonly lease: AdapterLease;
}

/** WORKER_READY 预热持有的唯一 Adapter lease，终态事件负责释放。 */
const workerAdapterLeases = new Map<string, WorkerAdapterLeaseRecord>();
const workerStartAttempts = new Map<string, WorkerStartAttempt>();

function isWorkerStartAttemptActive(
  sessionId: string,
  attempt: WorkerStartAttempt,
): boolean {
  return !attempt.cancelled
    && attempt.listenerGeneration === workspaceEventGeneration
    && workerStartAttempts.get(sessionId) === attempt;
}

function releaseWorkerAdapterLease(
  sessionId: string,
  listenerGeneration?: number,
  workspaceId?: string,
): void {
  const attempt = workerStartAttempts.get(sessionId);
  if (
    attempt
    && (listenerGeneration === undefined || attempt.listenerGeneration === listenerGeneration)
    && (workspaceId === undefined || attempt.workspaceId === workspaceId)
  ) {
    attempt.cancelled = true;
    workerStartAttempts.delete(sessionId);
  }

  const record = workerAdapterLeases.get(sessionId);
  if (!record) return;
  if (listenerGeneration !== undefined && record.listenerGeneration !== listenerGeneration) return;
  if (workspaceId !== undefined && record.workspaceId !== workspaceId) return;
  workerAdapterLeases.delete(sessionId);
  adapterManager.release(sessionId, record.lease);
}

async function acquireWorkerAdapterLease(
  sessionId: string,
  store: Parameters<typeof adapterManager.getOrCreate>[1],
  attempt: WorkerStartAttempt,
): Promise<AdapterEntry | null> {
  if (!isWorkerStartAttemptActive(sessionId, attempt)) return null;

  const existingRecord = workerAdapterLeases.get(sessionId);
  const existingEntry = adapterManager.get(sessionId);
  if (
    existingRecord
    && existingRecord.listenerGeneration === attempt.listenerGeneration
    && existingRecord.workspaceId === attempt.workspaceId
    && existingEntry === existingRecord.entry
  ) {
    return existingRecord.entry;
  }
  if (existingRecord) {
    workerAdapterLeases.delete(sessionId);
    adapterManager.release(sessionId, existingRecord.lease);
  }

  const acquisition = await adapterManager.getOrCreate(sessionId, store);
  if (!isWorkerStartAttemptActive(sessionId, attempt)) {
    adapterManager.release(sessionId, acquisition.lease);
    return null;
  }
  // Concurrent retry events may both await the same setup. Keep exactly one
  // WORKER_READY lease and release any duplicate acquisition immediately.
  const concurrentRecord = workerAdapterLeases.get(sessionId);
  if (concurrentRecord) {
    adapterManager.release(sessionId, acquisition.lease);
    return concurrentRecord.listenerGeneration === attempt.listenerGeneration
      && concurrentRecord.workspaceId === attempt.workspaceId
      ? concurrentRecord.entry
      : null;
  } else {
    workerAdapterLeases.set(sessionId, {
      workspaceId: attempt.workspaceId,
      listenerGeneration: attempt.listenerGeneration,
      entry: acquisition.entry,
      lease: acquisition.lease,
    });
  }
  return acquisition.entry;
}

/**
 * 🔧 识别后端"已有活跃流"语义的错误。
 *
 * 后端实际错误文案（workspace_handlers.rs / send_message.rs）：
 * - "Agent has an active stream. Please wait for completion."
 * - "Agent {id} has an active stream, and {n} drained message(s) failed to restore. ..."
 * - "Session has an active stream. Please wait for completion or cancel first."
 *
 * 这类错误说明子代理正在健康运行，不应标记 failed 或弹错误通知。
 */
export function isActiveStreamError(message: string): boolean {
  return /active stream/i.test(message);
}

const COMPLETION_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'closed',
]);

function isCompletionStatus(status: AgentStatus): status is AgentCompletionEnvelope['status'] {
  return COMPLETION_STATUSES.has(status);
}

/**
 * 🔧 P39 优化：Worker 启动处理逻辑（独立函数，支持并行调用）
 * 
 * 从事件监听器中提取出来，使得多个 worker_ready 事件可以并行处理，
 * 而不是串行等待每个子代理启动完成。
 */
async function handleWorkerReady(
  payload: WorkspaceWorkerReadyEvent,
  store: ReturnType<typeof useWorkspaceStore.getState>,
  listenerGeneration: number,
): Promise<void> {
  const { workspace_id, agent_session_id, skill_id, reminder, runtime_managed } = payload;
  if (listenerGeneration !== workspaceEventGeneration) return;
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
    console.warn(
      `[Workspace Events] Ignoring worker ready for workspace ${workspace_id} (current ${currentWorkspaceId})`
    );
    return;
  }
  console.log(`[Workspace Events] [WORKER_READY] Received event for agent: ${agent_session_id}, skill: ${skill_id}, hasReminder: ${!!reminder}`);
  // 🆕 P25: 记录到调试日志
  addSubagentEventLog('worker_ready', agent_session_id, `skill=${skill_id}`, undefined, workspace_id);
  
  // 🔧 P24 修复：防止重复处理同一个 agent 的 WORKER_READY 事件
  // 🆕 P38 修复：但如果有 reminder，说明是子代理没发消息的重试，允许重新处理
  if (processedWorkerReadyEvents.has(agent_session_id) && !reminder) {
    console.warn(
      `[Workspace Events] [WORKER_READY_DUP] Ignoring duplicate worker ready for agent ${agent_session_id}, already processed`
    );
    // 🆕 P25: 记录重复事件
    addSubagentEventLog('worker_ready_dup', agent_session_id, 'Duplicate event ignored');
    return;
  }
  if (reminder) {
    console.log(`[Workspace Events] [WORKER_READY] P38: Allowing retry for agent ${agent_session_id} due to reminder`);
    addSubagentEventLog('worker_ready_retry', agent_session_id, 'Retrying due to no message sent');
  }
  processedWorkerReadyEvents.add(agent_session_id);
  console.log(`[Workspace Events] [WORKER_READY] Added ${agent_session_id} to processedWorkerReadyEvents, size: ${processedWorkerReadyEvents.size}`);
  
  const previousAttempt = workerStartAttempts.get(agent_session_id);
  if (previousAttempt) previousAttempt.cancelled = true;
  const startAttempt: WorkerStartAttempt = {
    token: Symbol(agent_session_id),
    workspaceId: workspace_id,
    listenerGeneration,
    cancelled: false,
  };
  workerStartAttempts.set(agent_session_id, startAttempt);
  
  try {
    // 🔧 P20 修复：先预热子代理的 Store 和适配器
    // 这确保事件监听器在 runAgent 之前就设置好，解决时序问题
    const startTime = performance.now();
    console.log(`[Workspace Events] [T+0ms] Prewarming adapter for agent: ${agent_session_id}`);
    
    // 动态导入避免循环依赖
    const { sessionManager } = await import('../core/session/sessionManager');
    const { addSubagentPreheatLog } = await import('../debug/exportSessionDebug');
    
    // 1. 获取或创建 Store
    const storeCreateStart = performance.now();
    const subagentStore = sessionManager.getOrCreate(agent_session_id);
    const storeCreateMs = performance.now() - storeCreateStart;
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] Store created for agent: ${agent_session_id}`);
    
    // 2. 获取或创建适配器并等待 setup 完成
    const adapterSetupStart = performance.now();
    const adapterEntry = await acquireWorkerAdapterLease(
      agent_session_id,
      subagentStore,
      startAttempt,
    );
    if (!adapterEntry || !isWorkerStartAttemptActive(agent_session_id, startAttempt)) {
      return;
    }
    const adapterSetupMs = performance.now() - adapterSetupStart;
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] Adapter setup done for agent: ${agent_session_id}, isReady: ${adapterEntry.isReady}`);
    
    if (!adapterEntry.isReady) {
      throw new Error(i18n.t('chatV2:workspace.adapterSetupFailed', { agent: agent_session_id, defaultValue: `Adapter setup failed for agent: ${agent_session_id}` }));
    }
    
    // 🔧 P20 补充修复：串行等待事件监听器就绪
    // TauriAdapter.setup() 为性能优化不等待 listenPromise，但子代理必须等待
    // 这确保监听器在 runAgent 之前绑定好，不会丢失流式事件
    const listenersWaitStart = performance.now();
    await adapterManager.waitForListenersReady(agent_session_id);
    if (!isWorkerStartAttemptActive(agent_session_id, startAttempt)) {
      return;
    }
    const listenersWaitMs = performance.now() - listenersWaitStart;
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] Listeners ready for agent: ${agent_session_id} (waited ${listenersWaitMs.toFixed(1)}ms)`);
    
    // Runtime-managed workers are already running or queued. The frontend only
    // observes their stream. Keep an explicit escape hatch during migration.
    let runAgentMs = 0;
    if (isLegacyFrontendWorkerStartEnabled(runtime_managed)) {
      const runAgentStart = performance.now();
      const { runAgent } = await import('./api');
      if (!isWorkerStartAttemptActive(agent_session_id, startAttempt)) return;
      addSubagentEventLog('run_agent', agent_session_id, `Legacy runAgent fallback; hasReminder=${!!reminder}`, undefined, workspace_id);
      const result = await runAgent(workspace_id, agent_session_id, reminder);
      runAgentMs = performance.now() - runAgentStart;
      console.log(`[Workspace Events] Legacy worker start returned: ${result.agentSessionId}, status: ${result.status}`);
      addSubagentEventLog('run_agent_result', agent_session_id, `status=${result.status}, took ${runAgentMs.toFixed(1)}ms`);
    } else {
      addSubagentEventLog('runtime_observer_ready', agent_session_id, 'Adapter ready; backend owns execution', undefined, workspace_id);
    }
    const totalMs = performance.now() - startTime;
    console.log(`[Workspace Events] [T+${totalMs.toFixed(1)}ms] Worker observer ready: ${agent_session_id}`);
    
    // 🔧 P30 修复：移除 P28 的 reload
    // P29 在 stream_start 时会创建助手消息占位，reload 会覆盖它导致流式失败
    // 用户消息会在流式完成后通过 stream_complete 的 save 逻辑同步
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] P30: Skipping reload to preserve P29 placeholder: ${agent_session_id}`);
    
    // 🆕 P20: 记录到调试信息
    addSubagentPreheatLog({
      agentSessionId: agent_session_id,
      skillId: skill_id,
      timestamp: new Date().toISOString(),
      timing: {
        storeCreateMs: Math.round(storeCreateMs * 10) / 10,
        adapterSetupMs: Math.round(adapterSetupMs * 10) / 10,
        listenersWaitMs: Math.round(listenersWaitMs * 10) / 10,
        runAgentMs: Math.round(runAgentMs * 10) / 10,
        totalMs: Math.round(totalMs * 10) / 10,
      },
      success: true,
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (!isWorkerStartAttemptActive(agent_session_id, startAttempt)) {
      return;
    }

    // 🔧 P1 修复：后端返回"已有活跃流"说明子代理正在健康运行，
    // 不是启动失败——静默返回，不改状态也不弹错误通知
    if (isActiveStreamError(errorMsg)) {
      console.warn(
        `[Workspace Events] [WORKER_READY] Agent ${agent_session_id} already has an active stream, treating as healthy running (no status change)`
      );
      addSubagentEventLog(
        'worker_ready_dup',
        agent_session_id,
        'Active stream conflict, agent already running',
        errorMsg,
        workspace_id
      );
      return;
    }

    releaseWorkerAdapterLease(agent_session_id, listenerGeneration, workspace_id);

    console.error(`[Workspace Events] Failed to auto-start worker: ${agent_session_id}`, error);

    // 🆕 P25: 记录错误
    addSubagentEventLog('error', agent_session_id, 'Worker auto-start failed', errorMsg, workspace_id);

    // 🔧 真正失败时清除去重条目，后端在重试额度内补发的 worker_ready 才能被处理
    processedWorkerReadyEvents.delete(agent_session_id);

    const skillName = skill_id || agent_session_id.slice(-8);
    showGlobalNotification(
      'error',
      i18n.t('chatV2:workspace.workerStartFailed', {
        name: skillName,
        error: errorMsg,
        defaultValue: `Worker "${skillName}" 启动失败: ${errorMsg}`,
      })
    );
    
    // 更新 Agent 状态为 failed
    store.updateAgentStatus(agent_session_id, 'failed');
  }
}

/**
 * 初始化工作区事件监听
 */
export async function initWorkspaceEventListeners(): Promise<void> {
  if (!isTauriEnvironment()) {
    return;
  }
  // 先清理已有的监听器
  await cleanupWorkspaceEventListeners();
  const listenerGeneration = workspaceEventGeneration;

  const store = useWorkspaceStore.getState();

  try {
  const registerListener = async <T,>(
    eventName: string,
    handler: (event: { payload: T }) => void,
  ): Promise<void> => {
    const unlisten = await listen<T>(eventName, handler);
    if (listenerGeneration !== workspaceEventGeneration) {
      unlisten();
      throw new Error('Workspace listener generation changed during initialization');
    }
    unlistenFns.push(unlisten);
  };

  // 监听消息接收事件
  await registerListener<WorkspaceMessageEvent>(
    WORKSPACE_EVENTS.MESSAGE_RECEIVED,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, message } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        const workspaceMessage: WorkspaceMessage = {
          id: message.id,
          workspaceId: workspace_id,
          senderSessionId: message.sender_session_id,
          targetSessionId: message.target_session_id,
          messageType: message.message_type as WorkspaceMessage['messageType'],
          content: message.content,
          status: message.status as WorkspaceMessage['status'],
          createdAt: message.created_at,
        };
        store.addMessage(workspaceMessage);
      }
    }
  );

  // 监听 Agent 加入事件
  await registerListener<WorkspaceAgentEvent>(
    WORKSPACE_EVENTS.AGENT_JOINED,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, agent } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        const workspaceAgent: WorkspaceAgent = {
          sessionId: agent.session_id,
          workspaceId: workspace_id,
          role: agent.role as WorkspaceAgent['role'],
          skillId: agent.skill_id,
          status: parseAgentStatus(agent.status),
          joinedAt: agent.joined_at,
          lastActiveAt: agent.last_active_at,
        };
        store.addAgent(workspaceAgent);
      }
    }
  );

  // 监听 Agent 离开事件
  await registerListener<WorkspaceAgentEvent>(
    WORKSPACE_EVENTS.AGENT_LEFT,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, agent } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        store.removeAgent(agent.session_id);
      }
      releaseWorkerAdapterLease(agent.session_id, listenerGeneration, workspace_id);
    }
  );

  // 监听 Agent 状态变更事件
  await registerListener<WorkspaceAgentStatusEvent>(
    WORKSPACE_EVENTS.AGENT_STATUS_CHANGED,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, session_id, status } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      const parsedStatus = parseAgentStatus(status);

      // 🔧 P2 修复：去重条目清理不能依赖 currentWorkspaceId 匹配，
      // 否则背景工作区的 agent 完成后条目残留，后续同 agent 的 worker_ready 被永久吞掉。
      // queued/running are active runtime states. Release observer resources
      // only after a terminal/idle transition.
      if (parsedStatus === 'idle' || isCompletionStatus(parsedStatus)) {
        processedWorkerReadyEvents.delete(session_id);
        releaseWorkerAdapterLease(session_id, listenerGeneration, workspace_id);
      }

      if (currentWorkspaceId === workspace_id) {
        store.updateAgentStatus(session_id, parsedStatus);
      }
    }
  );

  await registerListener<WorkspaceAgentCompletionEvent>(
    WORKSPACE_EVENTS.AGENT_COMPLETION,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const payload = event.payload;
      const status = parseAgentStatus(payload.status);
      if (!isCompletionStatus(status)) {
        console.warn(`[Workspace Events] Ignoring non-terminal completion status: ${payload.status}`);
        return;
      }

      const completion: AgentCompletionEnvelope = {
        workspaceId: payload.workspace_id,
        agentSessionId: payload.agent_session_id,
        taskId: payload.task_id,
        runId: payload.run_id,
        correlationId: payload.correlation_id,
        status,
        finalOutput: payload.final_output,
        error: payload.error,
        completedAt: payload.completed_at,
        tokenUsage: payload.token_usage,
      };
      processedWorkerReadyEvents.delete(payload.agent_session_id);
      releaseWorkerAdapterLease(payload.agent_session_id, listenerGeneration, payload.workspace_id);
      if (useWorkspaceStore.getState().currentWorkspaceId === payload.workspace_id) {
        store.applyAgentCompletion(completion);
      }
      addSubagentEventLog(
        'runtime_completion',
        payload.agent_session_id,
        `status=${status}, run=${payload.run_id || 'unknown'}`,
        payload.error,
        payload.workspace_id,
      );
    }
  );

  // 监听文档更新事件
  await registerListener<WorkspaceDocumentEvent>(
    WORKSPACE_EVENTS.DOCUMENT_UPDATED,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, document } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        const workspaceDocument: WorkspaceDocument = {
          id: document.id,
          workspaceId: workspace_id,
          docType: document.doc_type as WorkspaceDocument['docType'],
          title: document.title,
          content: '', // 内容需要单独获取
          version: document.version,
          updatedBy: document.updated_by,
          updatedAt: document.updated_at,
        };
        store.addDocument(workspaceDocument);
      }
    }
  );

  // 监听工作区关闭事件
  await registerListener<WorkspaceClosedEvent>(
    WORKSPACE_EVENTS.WORKSPACE_CLOSED,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        store.reset();
      }
      for (const [sessionId, record] of workerAdapterLeases) {
        if (
          record.workspaceId === workspace_id
          && record.listenerGeneration === listenerGeneration
        ) {
          releaseWorkerAdapterLease(sessionId, listenerGeneration, workspace_id);
        }
      }
    }
  );

  // Worker ready is an observer/preheat signal. Backend runtime owns execution.
  await registerListener<WorkspaceWorkerReadyEvent>(
    WORKSPACE_EVENTS.WORKER_READY,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      // 🔧 P39: 使用 void 触发异步处理，不阻塞事件循环
      // 这允许多个子代理真正并行启动
      void handleWorkerReady(event.payload, store, listenerGeneration);
    }
  );

  // 🆕 监听主代理唤醒事件（触发管线恢复）
  await registerListener<CoordinatorAwakenedEvent>(
    WORKSPACE_EVENTS.COORDINATOR_AWAKENED,
    async (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const {
        workspace_id,
        coordinator_session_id,
        sleep_id,
        awakened_by,
        awaken_message,
        wake_reason,
      } = event.payload;

      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
        console.warn(
          `[Workspace Events] Ignoring coordinator awakened for workspace ${workspace_id} (current ${currentWorkspaceId})`
        );
        return;
      }
      
      console.log(
        `[Workspace Events] Coordinator awakened: coordinator=${coordinator_session_id}, sleep=${sleep_id}, by=${awakened_by}, reason=${wake_reason}`
      );
      // 🆕 P25: 记录到调试日志
      addSubagentEventLog('coord_wake', awakened_by, `coordinator=${coordinator_session_id}, reason=${wake_reason}`, undefined, workspace_id);
      
      // 🔧 P34 修复：防止重复处理同一个 sleep_id 的唤醒事件
      // 当消息自动唤醒和手动唤醒同时触发时，只处理第一次
      if (processedAwakenedEvents.has(sleep_id)) {
        console.warn(
          `[Workspace Events] [COORD_WAKE_DUP] Ignoring duplicate awakened event for sleep ${sleep_id}, already processed`
        );
        return;
      }
      processedAwakenedEvents.add(sleep_id);
      console.log(`[Workspace Events] [COORD_WAKE] Added ${sleep_id} to processedAwakenedEvents, size: ${processedAwakenedEvents.size}`);
      
      // 🔧 P35 修复：不再调用 chat_v2_send_message
      // 后端 Pipeline 通过 oneshot channel 已经自动恢复，不需要前端发送消息
      // 之前的实现会因为 Pipeline 流仍活跃而报 "Session has an active stream" 错误
      // 前端只需显示通知，告知用户主代理已被唤醒
      showGlobalNotification(
        'info',
        i18n.t('chatV2:workspace.coordinatorAwakened', {
          agent: awakened_by.slice(-8),
          defaultValue: `主代理已被子代理 ${awakened_by.slice(-8)} 唤醒，继续执行中...`,
        })
      );
    }
  );

  // 🆕 P38: 监听子代理重试事件
  await registerListener<SubagentRetryEvent>(
    WORKSPACE_EVENTS.SUBAGENT_RETRY,
    async (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, agent_session_id, reason, message, retry_count } = event.payload;
      console.log(`[Workspace Events] [SUBAGENT_RETRY] agent=${agent_session_id}, reason=${reason}, retry_count=${retry_count}`);
      addSubagentEventLog('worker_ready_retry', agent_session_id, `reason=${reason}: ${message}`, undefined, workspace_id);
      
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
        return;
      }

      // 🔧 P1 修复：区分"正在重试"与"多次重试后终局失败"
      const isExhausted = reason === 'max_retries_exceeded';
      
      // 🆕 P38: 直接通过后端持久化 subagent_retry 块
      // 由于前端 Store 访问较复杂，改为通过后端查询最后助手消息并创建块
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // 🔧 复用项目统一的块 ID 生成工具（与 blockActions 的 generateId('blk') 一致）
        const { generateId } = await import('../core/store/createChatStore');
        // 从 agents 中找到 coordinator 的 session ID
        const agents = useWorkspaceStore.getState().agents;
        const coordinator = agents.find(a => a.role === 'coordinator');
        if (coordinator) {
          const coordinatorSessionId = coordinator.sessionId;
          const blockId = generateId('blk_retry');
          
          // 查询最后的助手消息 ID（通过后端）
          const sessionData = await invoke<{ messages: Array<{ id: string; role: string }> }>(
            'chat_v2_load_session',
            { sessionId: coordinatorSessionId }
          );
          const lastAssistantMsg = sessionData.messages
            .filter(m => m.role === 'assistant')
            .pop();
          
          if (lastAssistantMsg) {
            await invoke('chat_v2_upsert_streaming_block', {
              blockId,
              messageId: lastAssistantMsg.id,
              sessionId: coordinatorSessionId,
              blockType: 'subagent_retry',
              content: message,
              // 🔧 终局失败落 error 状态，UI 才能渲染红色终态而非琥珀色"重试中"
              status: isExhausted ? 'error' : 'running',
              toolName: 'subagent_retry',
              // 🔧 P1 修复：toolInput 只放任务上下文；reason/retry_count 属于结果语义，写入 toolOutput
              toolInputJson: JSON.stringify({ agentSessionId: agent_session_id }),
              toolOutputJson: JSON.stringify({
                message,
                reason,
                retry_count,
                timestamp: new Date().toISOString(),
              }),
            });
            console.log(`[Workspace Events] [SUBAGENT_RETRY] Persisted block ${blockId} to message ${lastAssistantMsg.id}`);
          }
        }
      } catch (e: unknown) {
        console.error('[Workspace Events] Failed to create subagent_retry block:', e);
      }
      
      // 显示通知：终局失败用失败语义，而非"正在重新触发"
      if (isExhausted) {
        showGlobalNotification(
          'error',
          i18n.t('chatV2:workspace.subagentRetryExhausted', {
            agent: agent_session_id.slice(-8),
            defaultValue: `子代理 ${agent_session_id.slice(-8)} 多次重试后仍未产出结果`,
          })
        );
      } else {
        showGlobalNotification(
          'warning',
          i18n.t('chatV2:workspace.subagentRetry', {
            agent: agent_session_id.slice(-8),
            defaultValue: `子代理 ${agent_session_id.slice(-8)} 未发送结果，正在重新触发...`,
          })
        );
      }
    }
  );

  // 🆕 工作区警告事件
  await registerListener<WorkspaceWarningEvent>(
    WORKSPACE_EVENTS.WORKSPACE_WARNING,
    (event) => {
      if (listenerGeneration !== workspaceEventGeneration) return;
      const { workspace_id, code, message, agent_session_id, retry_count, max_retries } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
        return;
      }

      const defaultMessage = message || 'Workspace warning';
      const resolvedMessage = i18n.t(`chatV2:workspace.warning.${code}`, {
        agent: agent_session_id ? agent_session_id.slice(-8) : undefined,
        retry: retry_count,
        max: max_retries,
        defaultValue: defaultMessage,
      });

      showGlobalNotification('warning', resolvedMessage);
    }
  );

  console.log('[Workspace Events] Event listeners initialized');
  } catch (error) {
    // Sequential listen registration can fail after earlier listeners have
    // already succeeded. Roll the partial generation back immediately so no
    // stale callbacks or adapter leases survive a rejected init.
    if (listenerGeneration === workspaceEventGeneration) {
      await cleanupWorkspaceEventListeners();
    }
    throw error;
  }
}

/**
 * 清理工作区事件监听
 */
export async function cleanupWorkspaceEventListeners(): Promise<void> {
  workspaceEventGeneration++;
  for (const unlisten of unlistenFns) {
    unlisten();
  }
  unlistenFns = [];
  // 🔧 P24 修复：清空已处理事件 Set，允许新工作区重新处理
  processedWorkerReadyEvents.clear();
  for (const [sessionId, record] of [...workerAdapterLeases.entries()]) {
    releaseWorkerAdapterLease(
      sessionId,
      record.listenerGeneration,
      record.workspaceId,
    );
  }
  for (const attempt of workerStartAttempts.values()) {
    attempt.cancelled = true;
  }
  workerStartAttempts.clear();
  // 🔧 P34 修复：清空已处理唤醒事件 Set
  processedAwakenedEvents.clear();
  console.log('[Workspace Events] Event listeners cleaned up');
}

/**
 * React Hook: 在组件挂载时初始化事件监听
 */
export function useWorkspaceEvents(): void {
  // 使用 useEffect 在组件挂载时初始化
  // 注意：这个 hook 需要在 React 组件中使用
  // 由于 events.ts 是纯工具文件，这里只提供初始化函数
  // 实际使用时在 WorkspacePanel 或 App 组件中调用 initWorkspaceEventListeners
}

export default {
  initWorkspaceEventListeners,
  cleanupWorkspaceEventListeners,
  WORKSPACE_EVENTS,
};
