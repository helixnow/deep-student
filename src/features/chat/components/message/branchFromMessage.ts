/**
 * 会话分支的统一执行路径（供 MessageItem / useMessageActions 共用）。
 *
 * 收敛原先「组件内直连 invoke chat_v2_branch_session」的双路径：
 * 统一走 store.branchSession（TauriAdapter 注入回调优先，未注入时 store 内兜底），
 * 成功后补记分支索引（原会话消息下立即出现「已从此处分支」角标）并派发
 * CHAT_V2_BRANCH_SESSION 通知 ChatV2Page 插入新会话并切换。
 */
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import type { BranchSessionResult } from '../../adapters/types';
import { recordSessionBranch } from '../../core/session/sessionBranchIndex';

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

  // 通知 ChatV2Page 插入新会话并切换（既有链路不变）
  window.dispatchEvent(new CustomEvent('CHAT_V2_BRANCH_SESSION', {
    detail: { session: newSession },
  }));

  return newSession;
}
