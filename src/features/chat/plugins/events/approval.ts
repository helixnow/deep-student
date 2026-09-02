/**
 * Chat V2 - 工具审批事件处理器
 *
 * 处理后端发送的 tool_approval_request 事件，
 * 更新 Store 中的 pendingApprovalRequest 状态，
 * 触发前端显示审批对话框。
 *
 * 设计文档：src/features/chat/docs/29-ChatV2-Agent能力增强改造方案.md 第 4.6 节
 */

import type { EventHandler } from '../../registry/eventRegistry';
import { eventRegistry } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import type { PermissionPreset, RuntimeApprovalScope } from '../../core/types/store';
import { registerTransientRuntime } from '../../core/store/transientRuntimeRegistry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from 'i18next';
// 🆕 2026-02-17: 工具调用生命周期追踪
import { emitToolCallDebug, trackStart, trackEnd } from '@/debug-panel/plugins/ToolCallLifecycleDebugPlugin';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

/**
 * ACR R2-05 / DESIGN §6：High 审批前聚焦会话所属 chat 窗，
 * 避免审批栏在后台窗不可见（生命周期调研 #12 / SCENARIOS S-CLOSE）。
 */
function focusChatWindowForApproval(store: ChatStore, sensitivity: string | undefined): void {
  if (sensitivity !== 'high') return;
  const sessionId = store.sessionId;
  if (!sessionId) return;
  try {
    void workbenchBus.activate({
      typeId: 'chat',
      instanceKey: sessionId,
      action: 'focus',
      fallbackLaunch: {
        typeId: 'chat',
        instanceKey: sessionId,
        reason: 'api',
      },
    });
  } catch (err) {
    console.warn('[ApprovalEventHandler] Failed to focus chat window for High approval:', err);
  }
}

// ============================================================================
// 审批请求数据类型
// ============================================================================

interface ApprovalRequestPayload {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  sensitivity: 'low' | 'medium' | 'high';
  permissionPreset?: PermissionPreset;
  description: string;
  timeoutSeconds: number;
  resolvedStatus?: ApprovalResolutionStatus;
  status?: string;
  expired?: boolean;
  expiresAt?: number | string;
  // shell / skill_install / skill_workshop / skill_lifecycle 等 scope 联合类型
  runtimeScope?: RuntimeApprovalScope;
}

type ApprovalResolutionStatus = 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';

interface ApprovalResultPayload {
  toolCallId?: string;
  approved?: boolean;
  reason?: string | null;
}

const APPROVAL_RESOLUTION_DISPLAY_MS = 1000;

interface ApprovalRuntimeState {
  queue: ApprovalRequestPayload[];
  resolutionTimer: ReturnType<typeof setTimeout> | null;
  terminalToolCallIds: Set<string>;
}

/**
 * Store state snapshots are replaced after every Zustand update, while action
 * functions remain stable for the lifetime of a store. Keying by the action
 * therefore keeps each chat window's queue and timer isolated without keeping
 * destroyed stores alive.
 */
const approvalRuntimeByStore = new WeakMap<
  ChatStore['setPendingApproval'],
  ApprovalRuntimeState
>();

function getApprovalRuntime(store: ChatStore): ApprovalRuntimeState {
  const storeIdentity = store.setPendingApproval;
  let runtime = approvalRuntimeByStore.get(storeIdentity);
  if (!runtime) {
    runtime = {
      queue: [],
      resolutionTimer: null,
      terminalToolCallIds: new Set(),
    };
    approvalRuntimeByStore.set(storeIdentity, runtime);
    registerTransientRuntime(storeIdentity, 'tool-approval-queue', () => {
      if (runtime?.resolutionTimer) {
        clearTimeout(runtime.resolutionTimer);
      }
      runtime?.queue.splice(0);
      runtime?.terminalToolCallIds.clear();
      approvalRuntimeByStore.delete(storeIdentity);
    });
  }
  return runtime;
}

function getExistingApprovalRuntime(store: ChatStore): ApprovalRuntimeState | null {
  return approvalRuntimeByStore.get(store.setPendingApproval) ?? null;
}

function toStoreApproval(request: ApprovalRequestPayload) {
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    arguments: request.arguments || {},
    sensitivity: request.sensitivity || 'medium',
    permissionPreset: request.permissionPreset ?? 'relaxed',
    description: request.description || '',
    timeoutSeconds: request.timeoutSeconds || 30,
    runtimeScope: request.runtimeScope,
  };
}

function resolvePendingApproval(
  store: ChatStore,
  status: ApprovalResolutionStatus,
  reason?: string
) {
  if (!store.pendingBlockingInteraction) return;
  store.setPendingApproval({
    ...store.pendingBlockingInteraction as Extract<typeof store.pendingBlockingInteraction, { kind: 'tool_approval' }>,
    resolvedStatus: status,
    resolvedReason: reason,
  });
}

function extractToolCallId(blockId?: string): string | null {
  if (!blockId) return null;
  if (blockId.startsWith('approval_')) {
    return blockId.slice('approval_'.length);
  }
  return null;
}

function isTerminalApprovalRequest(request: ApprovalRequestPayload): boolean {
  if (request.expired === true || request.resolvedStatus) return true;
  const status = request.status?.toLowerCase();
  if (status && ['approved', 'rejected', 'timeout', 'expired', 'error', 'completed', 'cancelled'].includes(status)) {
    return true;
  }
  if (request.expiresAt !== undefined) {
    const numericExpiresAt = typeof request.expiresAt === 'number'
      ? request.expiresAt
      : Date.parse(request.expiresAt);
    const expiresAt = numericExpiresAt > 0 && numericExpiresAt < 1_000_000_000_000
      ? numericExpiresAt * 1000
      : numericExpiresAt;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
  }
  return false;
}

function isDuplicateApproval(
  store: ChatStore,
  runtime: ApprovalRuntimeState,
  toolCallId: string,
): boolean {
  if (!toolCallId) return false;
  const pending = store.pendingBlockingInteraction;
  return runtime.terminalToolCallIds.has(toolCallId)
    || (pending?.kind === 'tool_approval' && pending.toolCallId === toolCallId)
    || runtime.queue.some((item) => item.toolCallId === toolCallId);
}

function removeQueuedApproval(runtime: ApprovalRuntimeState, toolCallId: string): boolean {
  const index = runtime.queue.findIndex((item) => item.toolCallId === toolCallId);
  if (index < 0) return false;
  runtime.queue.splice(index, 1);
  return true;
}

function shouldResolveApproval(store: ChatStore, toolCallId?: string | null) {
  const pending = store.pendingBlockingInteraction;
  if (!pending) return false;
  if (pending.kind !== 'tool_approval') return false;
  if (pending.resolvedStatus) return false;
  if (toolCallId && pending.toolCallId !== toolCallId) return false;
  return true;
}

function scheduleAdvanceQueue(store: ChatStore) {
  const runtime = getApprovalRuntime(store);
  const expectedToolCallId = store.pendingBlockingInteraction?.kind === 'tool_approval'
    ? store.pendingBlockingInteraction.toolCallId
    : null;
  if (runtime.resolutionTimer) {
    clearTimeout(runtime.resolutionTimer);
  }

  const timer = setTimeout(() => {
    if (runtime.resolutionTimer !== timer) return;
    runtime.resolutionTimer = null;
    const pending = store.pendingBlockingInteraction;
    if (
      expectedToolCallId
      && (
        pending?.kind !== 'tool_approval'
        || pending.toolCallId !== expectedToolCallId
      )
    ) {
      return;
    }
    store.clearPendingApproval();
    let next = runtime.queue.shift();
    while (next && (
      runtime.terminalToolCallIds.has(next.toolCallId)
      || isTerminalApprovalRequest(next)
    )) {
      next = runtime.queue.shift();
    }
    if (next) {
      const normalized = toStoreApproval(next);
      focusChatWindowForApproval(store, normalized.sensitivity);
      store.setPendingApproval(normalized);
    }
  }, APPROVAL_RESOLUTION_DISPLAY_MS);
  runtime.resolutionTimer = timer;
}

function normalizeApprovalError(error: string): 'timeout' | 'expired' | 'error' {
  const normalized = error.toLowerCase();
  if (normalized.includes('expired')) {
    return 'expired';
  }
  if (normalized.includes('timeout')) {
    return 'timeout';
  }
  return 'error';
}

function notifyApprovalError(kind: 'timeout' | 'expired' | 'error') {
  if (kind === 'timeout') {
    showGlobalNotification(
      'warning',
      i18n.t('chatV2:approval.notification.timeoutTitle'),
      i18n.t('chatV2:approval.notification.timeoutDetail')
    );
    return;
  }
  if (kind === 'expired') {
    showGlobalNotification(
      'warning',
      i18n.t('chatV2:approval.notification.expiredTitle'),
      i18n.t('chatV2:approval.notification.expiredDetail')
    );
    return;
  }
  showGlobalNotification(
    'error',
    i18n.t('chatV2:approval.notification.failedTitle'),
    i18n.t('chatV2:approval.notification.failedDetail')
  );
}

// ============================================================================
// 事件处理器
// ============================================================================

/**
 * 工具审批请求事件处理器
 *
 * 当后端需要用户审批敏感工具时，发送 tool_approval_request 事件。
 * 此处理器将请求数据存储到 Store，供 UI 组件渲染审批对话框。
 */
export const approvalEventHandler: EventHandler = {
  /**
   * 事件开始时调用
   * 
   * 将审批请求数据存储到 Store 的 pendingApprovalRequest
   */
  onStart: (store: ChatStore, _messageId: string, payload: Record<string, unknown>): string => {
    const request = payload as unknown as ApprovalRequestPayload;
    const blockId = `approval_${request.toolCallId}`;
    const runtime = getApprovalRuntime(store);

    if (isTerminalApprovalRequest(request)) {
      if (request.toolCallId) runtime.terminalToolCallIds.add(request.toolCallId);
      console.log('[ApprovalEventHandler] Ignored terminal approval request:', request.toolCallId);
      return blockId;
    }
    if (isDuplicateApproval(store, runtime, request.toolCallId)) {
      console.log('[ApprovalEventHandler] Ignored duplicate approval request:', request.toolCallId);
      return blockId;
    }
    
    console.log('[ApprovalEventHandler] Received approval request:', {
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      sensitivity: request.sensitivity,
    });

    // 🆕 2026-02-17: 生命周期追踪
    emitToolCallDebug('info', 'backend:start', `审批请求: ${request.toolName}`, {
      toolName: request.toolName, toolCallId: request.toolCallId,
      detail: { sensitivity: request.sensitivity, timeoutSeconds: request.timeoutSeconds },
    });
    if (request.toolCallId) trackStart(request.toolCallId, undefined, `approval:${request.toolName}`);

    const normalized = toStoreApproval(request);

    // ACR R2-05：High 审批到达时先 focus 本会话 chat 窗（队列中的请求在出队时再 focus）
    if (!store.pendingBlockingInteraction) {
      focusChatWindowForApproval(store, normalized.sensitivity);
    }

    // 已有待审批请求时进入队列，避免覆盖
    if (store.pendingBlockingInteraction) {
      runtime.queue.push(request);
      console.log('[ApprovalEventHandler] Queued approval request:', request.toolCallId, 'queueSize=', runtime.queue.length);
    } else {
      store.setPendingApproval(normalized);
    }

    // 返回一个虚拟的 blockId（审批事件不创建块）
    return blockId;
  },

  /**
   * 事件结束时调用（审批完成）
   * 
   * 清除 pendingApprovalRequest
   */
  onEnd: (store: ChatStore, _blockId: string, _result?: unknown): void => {
    console.log('[ApprovalEventHandler] Approval completed, processing next request if exists');
    const result = _result as ApprovalResultPayload | undefined;
    const toolCallId = result?.toolCallId ?? extractToolCallId(_blockId);
    const runtime = getExistingApprovalRuntime(store);
    if (!runtime) return;
    if (toolCallId) {
      runtime.terminalToolCallIds.add(toolCallId);
      removeQueuedApproval(runtime, toolCallId);
    }
    // 🆕 2026-02-17: 生命周期追踪
    if (toolCallId) trackEnd(toolCallId, true);
    if (!shouldResolveApproval(store, toolCallId)) {
      return;
    }
    const approved = result?.approved === true;
    const reason = typeof result?.reason === 'string' ? result?.reason : undefined;
    const resolvedStatus: ApprovalResolutionStatus = approved
      ? 'approved'
      : reason === 'timeout'
        ? 'timeout'
        : 'rejected';
    resolvePendingApproval(store, resolvedStatus, reason);
    if (resolvedStatus === 'timeout') {
      notifyApprovalError('timeout');
    }
    scheduleAdvanceQueue(store);
  },

  /**
   * 事件错误时调用（审批超时或失败）
   * 
   * 清除 pendingApprovalRequest
   */
  onError: (store: ChatStore, _blockId: string, error: string): void => {
    console.log('[ApprovalEventHandler] Approval error:', error);
    const toolCallId = extractToolCallId(_blockId);
    const runtime = getExistingApprovalRuntime(store);
    if (!runtime) return;
    if (toolCallId) {
      runtime.terminalToolCallIds.add(toolCallId);
      removeQueuedApproval(runtime, toolCallId);
    }
    // 🆕 2026-02-17: 生命周期追踪
    if (toolCallId) trackEnd(toolCallId, false);
    if (!shouldResolveApproval(store, toolCallId)) {
      return;
    }
    const kind = normalizeApprovalError(error);
    const resolvedStatus: ApprovalResolutionStatus =
      kind === 'timeout' ? 'timeout' : kind === 'expired' ? 'expired' : 'error';
    resolvePendingApproval(store, resolvedStatus, error);
    notifyApprovalError(kind);
    scheduleAdvanceQueue(store);
  },
};

// ============================================================================
// 注册事件处理器
// ============================================================================

// 注册到 eventRegistry（导入即注册）
eventRegistry.register('tool_approval_request', approvalEventHandler);

// 导出 handler 供测试使用
export { approvalEventHandler as toolApprovalEventHandler };
