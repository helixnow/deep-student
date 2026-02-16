/**
 * Chat V2 - 工具审批事件处理器
 *
 * 处理后端发送的 tool_approval_request 事件，
 * 更新 Store 中的 pendingApprovalRequest 状态，
 * 触发前端显示审批对话框。
 *
 * 设计文档：src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md 第 4.6 节
 */

import type { EventHandler } from '../../registry/eventRegistry';
import { eventRegistry } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import i18n from 'i18next';
// 🆕 2026-02-17: 工具调用生命周期追踪
import { emitToolCallDebug, trackStart, trackEnd } from '../../../debug-panel/plugins/ToolCallLifecycleDebugPlugin';

// ============================================================================
// 审批请求数据类型
// ============================================================================

interface ApprovalRequestPayload {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  sensitivity: 'low' | 'medium' | 'high';
  description: string;
  timeoutSeconds: number;
}

type ApprovalResolutionStatus = 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';

interface ApprovalResultPayload {
  toolCallId?: string;
  approved?: boolean;
  reason?: string | null;
}

const APPROVAL_RESOLUTION_DISPLAY_MS = 1000;

// 简单队列：避免并发审批请求互相覆盖
const approvalQueue: ApprovalRequestPayload[] = [];
let resolutionTimer: ReturnType<typeof setTimeout> | null = null;

function toStoreApproval(request: ApprovalRequestPayload) {
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    arguments: request.arguments || {},
    sensitivity: request.sensitivity || 'medium',
    description: request.description || '',
    timeoutSeconds: request.timeoutSeconds || 30,
  };
}

function resolvePendingApproval(
  store: ChatStore,
  status: ApprovalResolutionStatus,
  reason?: string
) {
  if (!store.pendingApprovalRequest) return;
  store.setPendingApproval({
    ...store.pendingApprovalRequest,
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

function shouldResolveApproval(store: ChatStore, toolCallId?: string | null) {
  const pending = store.pendingApprovalRequest;
  if (!pending) return false;
  if (pending.resolvedStatus) return false;
  if (toolCallId && pending.toolCallId !== toolCallId) return false;
  return true;
}

function scheduleAdvanceQueue(store: ChatStore) {
  if (resolutionTimer) {
    clearTimeout(resolutionTimer);
  }
  resolutionTimer = setTimeout(() => {
    resolutionTimer = null;
    store.clearPendingApproval();
    const next = approvalQueue.shift();
    if (next) {
      store.setPendingApproval(toStoreApproval(next));
    }
  }, APPROVAL_RESOLUTION_DISPLAY_MS);
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

    // 已有待审批请求时进入队列，避免覆盖
    if (store.pendingApprovalRequest) {
      approvalQueue.push(request);
      console.log('[ApprovalEventHandler] Queued approval request:', request.toolCallId, 'queueSize=', approvalQueue.length);
    } else {
      store.setPendingApproval(normalized);
    }

    // 返回一个虚拟的 blockId（审批事件不创建块）
    return `approval_${request.toolCallId}`;
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
