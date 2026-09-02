/**
 * Web 演示壳 - 已播放会话快照
 *
 * 行为契约（2026-09）：同一次页面访问内，剧本会话播放完成后，切走再切回
 * 不重新播放，直接显示完成时的状态——与真实客户端"历史持久化、不重放"一致。
 *
 * 实现：剧本流播完后（或离开会话时兜底），从真实 store 把 消息+块 按
 * BackendMessage/BackendBlock 形状快照到本模块的内存 Map；mockIpc 的
 * chat_v2_load_session 优先返回快照。页面刷新（新一次访问）Map 随模块
 * 重建，首轮播放照旧。
 */

import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type {
  BackendBlock,
  BackendMessage,
} from '@/features/chat/adapters/types';

export interface PlayedHistory {
  messages: BackendMessage[];
  blocks: BackendBlock[];
}

const playedHistory = new Map<string, PlayedHistory>();

/**
 * 把会话当前 store 内容快照为后端形状。无内容 / store 已销毁时静默跳过。
 * 幂等：后一次快照整体覆盖前一次（同一 store 的全量状态）。
 */
export function capturePlayedSnapshot(sessionId: string): void {
  const store = sessionManager.peek(sessionId);
  if (!store) return;
  const state = store.getState();
  if (!state.messageOrder || state.messageOrder.length === 0) return;

  const messages: BackendMessage[] = [];
  const blocks: BackendBlock[] = [];

  for (const messageId of state.messageOrder) {
    const m = state.messageMap.get(messageId);
    if (!m) continue;
    messages.push({
      id: m.id,
      sessionId,
      role: m.role,
      blockIds: [...m.blockIds],
      timestamp: m.timestamp ?? Date.now(),
      ...(m.persistentStableId ? { persistentStableId: m.persistentStableId } : {}),
      ...(m._meta ? { _meta: m._meta } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
    });
    for (const blockId of m.blockIds) {
      const b = state.blocks.get(blockId);
      if (!b) continue;
      blocks.push({
        id: b.id,
        messageId: b.messageId,
        type: b.type,
        status: b.status,
        content: b.content,
        toolName: b.toolName,
        toolInput: b.toolInput,
        toolOutput: b.toolOutput,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        firstChunkAt: b.firstChunkAt,
      });
    }
  }

  if (messages.length === 0) return;
  playedHistory.set(sessionId, { messages, blocks });
}

/** 读取已播放快照；未播放过返回 null */
export function getPlayedHistory(sessionId: string): PlayedHistory | null {
  return playedHistory.get(sessionId) ?? null;
}
