/**
 * 会话分支的统一执行路径（供 MessageItem 使用）。
 *
 * 收敛原先「组件内直连 invoke chat_v2_branch_session」的双路径：
 * 统一走 store.branchSession（TauriAdapter 注入回调优先，未注入时 store 内兜底），
 * 成功后补记分支索引（原会话消息下立即出现「已从此处分支」角标），再经
 * 统一导航握手切换。标准 navigate-to-session 事件也会让 WorkbenchEventBridge
 * 从 chat-session 独立会话窗打开/聚焦 Chat 主窗，不再依赖仅 ChatV2Page 消费的
 * 私有分支事件。
 */
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import type { BranchSessionResult } from '../../adapters/types';
import { recordSessionBranch } from '../../core/session/sessionBranchIndex';
import { requestChatSessionNavigation } from '../../navigation/pendingChatNavigation';

export async function branchSessionFromMessage(
  store: StoreApi<ChatStore>,
  messageId: string,
): Promise<BranchSessionResult> {
  const state = store.getState();
  const branchSession = state.branchSession;
  if (!branchSession) {
    throw new Error('[branchFromMessage] store.branchSession is unavailable');
  }

  const sourceSessionId = state.sessionId;
  const newSession = await branchSession(messageId);

  if (sourceSessionId) {
    recordSessionBranch(sourceSessionId, messageId, {
      sessionId: newSession.id,
      title: newSession.title ?? null,
      branchedAt: newSession.createdAt ?? null,
    });
  }

  requestChatSessionNavigation(newSession.id);

  return newSession;
}
