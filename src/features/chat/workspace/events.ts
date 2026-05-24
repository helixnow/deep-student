/**
 * 工作区事件监听
 * 
 * 监听后端发射的工作区相关事件，更新 workspaceStore
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useWorkspaceStore } from './workspaceStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from 'i18next';
import type {
  WorkspaceMessage,
  WorkspaceAgent,
  WorkspaceDocument,
} from './types';
// 🆕 P25: 导入子代理事件日志函数
import { addSubagentEventLog } from '../debug/exportSessionDebug';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

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
  reason: string;
  message: string;
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

// 🔧 P24 修复：跟踪已处理的 WORKER_READY 事件，防止重复启动
const processedWorkerReadyEvents = new Set<string>();

// 🔧 P34 修复：跟踪已处理的 COORDINATOR_AWAKENED 事件，防止重复恢复 pipeline
const processedAwakenedEvents = new Set<string>();

/**
 * 🔧 P39 优化：Worker 启动处理逻辑（独立函数，支持并行调用）
 * 
 * 从事件监听器中提取出来，使得多个 worker_ready 事件可以并行处理，
 * 而不是串行等待每个子代理启动完成。
 */
async function handleWorkerReady(
  payload: WorkspaceWorkerReadyEvent,
  store: ReturnType<typeof useWorkspaceStore.getState>
): Promise<void> {
  const { workspace_id, agent_session_id, skill_id, reminder } = payload;
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
  
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
    console.warn(
      `[Workspace Events] Ignoring worker ready for workspace ${workspace_id} (current ${currentWorkspaceId})`
    );
    return;
  }
  
  try {
    // 🔧 P20 修复：先预热子代理的 Store 和适配器
    // 这确保事件监听器在 runAgent 之前就设置好，解决时序问题
    const startTime = performance.now();
    console.log(`[Workspace Events] [T+0ms] Prewarming adapter for agent: ${agent_session_id}`);
    
    // 动态导入避免循环依赖
    const { sessionManager } = await import('../core/session/sessionManager');
    const { adapterManager } = await import('../adapters/AdapterManager');
    const { addSubagentPreheatLog } = await import('../debug/exportSessionDebug');
    
    // 1. 获取或创建 Store
    const storeCreateStart = performance.now();
    const subagentStore = sessionManager.getOrCreate(agent_session_id);
    const storeCreateMs = performance.now() - storeCreateStart;
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] Store created for agent: ${agent_session_id}`);
    
    // 2. 获取或创建适配器并等待 setup 完成
    const adapterSetupStart = performance.now();
    const adapterEntry = await adapterManager.getOrCreate(agent_session_id, subagentStore);
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
    const listenersWaitMs = performance.now() - listenersWaitStart;
    console.log(`[Workspace Events] [T+${(performance.now() - startTime).toFixed(1)}ms] Listeners ready for agent: ${agent_session_id} (waited ${listenersWaitMs.toFixed(1)}ms)`);
    
    // 3. 适配器就绪后，启动子代理任务
    const runAgentStart = performance.now();
    const { runAgent } = await import('./api');
    // 🆕 P25: 记录 runAgent 调用
    addSubagentEventLog('run_agent', agent_session_id, `Calling runAgent... hasReminder=${!!reminder}`, undefined, workspace_id);
    // 🆕 P38: 传递 reminder 参数（如果有的话，用于子代理没发消息的重试提醒）
    const result = await runAgent(workspace_id, agent_session_id, reminder);
    const runAgentMs = performance.now() - runAgentStart;
    const totalMs = performance.now() - startTime;
    console.log(`[Workspace Events] [T+${totalMs.toFixed(1)}ms] Worker auto-started: ${result.agentSessionId}, status: ${result.status} (runAgent took ${runAgentMs.toFixed(1)}ms)`);
    // 🆕 P25: 记录 runAgent 结果
    addSubagentEventLog('run_agent_result', agent_session_id, `status=${result.status}, took ${runAgentMs.toFixed(1)}ms`);
    
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
    console.error(`[Workspace Events] Failed to auto-start worker: ${agent_session_id}`, error);
    
    // 🔧 修复：Worker 自动启动失败时提供用户反馈
    const errorMsg = error instanceof Error ? error.message : String(error);
    // 🆕 P25: 记录错误
    addSubagentEventLog('error', agent_session_id, 'Worker auto-start failed', errorMsg, workspace_id);
    
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

  const store = useWorkspaceStore.getState();

  // 监听消息接收事件
  const unlistenMessage = await listen<WorkspaceMessageEvent>(
    WORKSPACE_EVENTS.MESSAGE_RECEIVED,
    (event) => {
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
  unlistenFns.push(unlistenMessage);

  // 监听 Agent 加入事件
  const unlistenAgentJoined = await listen<WorkspaceAgentEvent>(
    WORKSPACE_EVENTS.AGENT_JOINED,
    (event) => {
      const { workspace_id, agent } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        const workspaceAgent: WorkspaceAgent = {
          sessionId: agent.session_id,
          workspaceId: workspace_id,
          role: agent.role as WorkspaceAgent['role'],
          skillId: agent.skill_id,
          status: agent.status as WorkspaceAgent['status'],
          joinedAt: agent.joined_at,
          lastActiveAt: agent.last_active_at,
        };
        store.addAgent(workspaceAgent);
      }
    }
  );
  unlistenFns.push(unlistenAgentJoined);

  // 监听 Agent 离开事件
  const unlistenAgentLeft = await listen<WorkspaceAgentEvent>(
    WORKSPACE_EVENTS.AGENT_LEFT,
    (event) => {
      const { workspace_id, agent } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        store.removeAgent(agent.session_id);
      }
    }
  );
  unlistenFns.push(unlistenAgentLeft);

  // 监听 Agent 状态变更事件
  const unlistenAgentStatus = await listen<WorkspaceAgentStatusEvent>(
    WORKSPACE_EVENTS.AGENT_STATUS_CHANGED,
    (event) => {
      const { workspace_id, session_id, status } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        store.updateAgentStatus(session_id, status as WorkspaceAgent['status']);
        if (status !== 'running') {
          processedWorkerReadyEvents.delete(session_id);
        }
      }
    }
  );
  unlistenFns.push(unlistenAgentStatus);

  // 监听文档更新事件
  const unlistenDocument = await listen<WorkspaceDocumentEvent>(
    WORKSPACE_EVENTS.DOCUMENT_UPDATED,
    (event) => {
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
  unlistenFns.push(unlistenDocument);

  // 监听工作区关闭事件
  const unlistenClosed = await listen<WorkspaceClosedEvent>(
    WORKSPACE_EVENTS.WORKSPACE_CLOSED,
    (event) => {
      const { workspace_id } = event.payload;
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      
      if (currentWorkspaceId === workspace_id) {
        store.reset();
      }
    }
  );
  unlistenFns.push(unlistenClosed);

  // 监听 Worker 准备启动事件（自动启动 Worker）
  // 🔧 P20 修复：先预热子代理的适配器（设置事件监听器），再启动任务
  // 🔧 P39 优化：改为并行启动，多个 worker_ready 事件不再串行等待
  const unlistenWorkerReady = await listen<WorkspaceWorkerReadyEvent>(
    WORKSPACE_EVENTS.WORKER_READY,
    (event) => {
      // 🔧 P39: 使用 void 触发异步处理，不阻塞事件循环
      // 这允许多个子代理真正并行启动
      void handleWorkerReady(event.payload, store);
    }
  );
  unlistenFns.push(unlistenWorkerReady);

  // 🆕 监听主代理唤醒事件（触发管线恢复）
  const unlistenCoordinatorAwakened = await listen<CoordinatorAwakenedEvent>(
    WORKSPACE_EVENTS.COORDINATOR_AWAKENED,
    async (event) => {
      const {
        workspace_id,
        coordinator_session_id,
        sleep_id,
        awakened_by,
        awaken_message,
        wake_reason,
      } = event.payload;
      
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
      
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
        console.warn(
          `[Workspace Events] Ignoring coordinator awakened for workspace ${workspace_id} (current ${currentWorkspaceId})`
        );
        return;
      }
      
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
  unlistenFns.push(unlistenCoordinatorAwakened);

  // 🆕 P38: 监听子代理重试事件
  const unlistenSubagentRetry = await listen<SubagentRetryEvent>(
    WORKSPACE_EVENTS.SUBAGENT_RETRY,
    async (event) => {
      const { workspace_id, agent_session_id, reason, message } = event.payload;
      console.log(`[Workspace Events] [SUBAGENT_RETRY] agent=${agent_session_id}, reason=${reason}`);
      addSubagentEventLog('worker_ready_retry', agent_session_id, `reason=${reason}: ${message}`, undefined, workspace_id);
      
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
      if (currentWorkspaceId && currentWorkspaceId !== workspace_id) {
        return;
      }
      
      // 🆕 P38: 直接通过后端持久化 subagent_retry 块
      // 由于前端 Store 访问较复杂，改为通过后端查询最后助手消息并创建块
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // 从 agents 中找到 coordinator 的 session ID
        const agents = useWorkspaceStore.getState().agents;
        const coordinator = agents.find(a => a.role === 'coordinator');
        if (coordinator) {
          const coordinatorSessionId = coordinator.sessionId;
          // 使用 ulid 生成块 ID
          const blockId = `blk_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          
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
              status: 'running',
              toolName: 'subagent_retry',
              toolInputJson: JSON.stringify({ agentSessionId: agent_session_id, reason }),
              toolOutputJson: JSON.stringify({ message, timestamp: new Date().toISOString() }),
            });
            console.log(`[Workspace Events] [SUBAGENT_RETRY] Persisted block ${blockId} to message ${lastAssistantMsg.id}`);
          }
        }
      } catch (e: unknown) {
        console.error('[Workspace Events] Failed to create subagent_retry block:', e);
      }
      
      // 显示通知
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:workspace.subagentRetry', {
          agent: agent_session_id.slice(-8),
          defaultValue: `子代理 ${agent_session_id.slice(-8)} 未发送结果，正在重新触发...`,
        })
      );
    }
  );
  unlistenFns.push(unlistenSubagentRetry);

  // 🆕 工作区警告事件
  const unlistenWorkspaceWarning = await listen<WorkspaceWarningEvent>(
    WORKSPACE_EVENTS.WORKSPACE_WARNING,
    (event) => {
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
  unlistenFns.push(unlistenWorkspaceWarning);

  console.log('[Workspace Events] Event listeners initialized');
}

/**
 * 清理工作区事件监听
 */
export async function cleanupWorkspaceEventListeners(): Promise<void> {
  for (const unlisten of unlistenFns) {
    unlisten();
  }
  unlistenFns = [];
  // 🔧 P24 修复：清空已处理事件 Set，允许新工作区重新处理
  processedWorkerReadyEvents.clear();
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
