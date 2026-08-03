/**
 * ensureActiveChatSession - 「引用到对话 / 添加到聊天」无活动会话时的闭环入口
 *
 * 背景（2026-07-20 移动端审计 r3 转交）：learning-hub / notes / workbench 的
 * 「引用到对话」链路在 sessionManager 没有当前会话时（典型场景：应用启动后
 * 从未进入过聊天页）只弹 toast 警告，资源添加动作被静默丢弃，没有任何闭环。
 *
 * 本模块提供 chat 域侧的最小闭环能力：
 * 1. 已有活动会话 → 直接返回其 sessionId（零副作用）。
 * 2. 无活动会话 → 复用聊天页启动时的「隐藏 draft 会话」机制
 *    （见 useSessionLifecycle.getOrCreateHiddenDraftSession / draftSession.ts）：
 *    - 优先复用 localStorage 中记录的同 scope draft（chat:ungrouped）；
 *    - 否则创建一个带 hidden-draft 元数据的新会话并记录。
 *    选择 draft 机制而非普通会话的关键原因：ChatV2Page 挂载时 loadSessions
 *    总是切到同 scope 的 draft 会话——只有把资源附加到这个 draft 上，
 *    用户随后进入聊天页时才能看到刚添加的引用（天然闭环，无需额外跳转）。
 * 3. 把该会话注册进 sessionManager 并设为 current；若是复用已持久化的
 *    会话，先等待历史恢复完成再返回，避免调用方 addContextRef 与
 *    loadSession 的恢复写入产生竞态互相覆盖。
 * 4. 派发 navigate-to-session 事件：聊天页已挂载时同步其 React 状态；
 *    未挂载时无监听者、无副作用。
 *
 * 调用方约定（转 R9 / learning-hub 侧接入）：
 *   const sessionId = await ensureActiveChatSession();
 *   if (!sessionId) { 保留原「无会话」toast 兜底 }
 *   const store = sessionManager.get(sessionId)!;
 */

import { invoke } from '@tauri-apps/api/core';
import type { ChatSession } from '../types/session';
import { sessionManager } from '../core/session/sessionManager';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  buildHiddenDraftSessionMetadata,
  getDraftSessionScope,
  getHiddenDraftSessionScope,
  getStoredDraftSessionId,
  persistHiddenDraftSessionId,
  clearHiddenDraftSessionId,
} from './draftSession';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error'>;

const LOG_PREFIX = '[ensureActiveChatSession]';

/** 并发调用共享同一个 Promise，避免连点创建出多个孤儿 draft */
let inFlight: Promise<string | null> | null = null;

async function resolveDraftSession(): Promise<ChatSession> {
  const scope = getDraftSessionScope('chat', null);

  // 1. 优先复用 localStorage 记录的同 scope 隐藏 draft
  const storedDraftId = getStoredDraftSessionId(scope);
  if (storedDraftId) {
    try {
      const storedDraft = await invoke<ChatSession | null>('chat_v2_get_session', {
        sessionId: storedDraftId,
      });
      if (storedDraft && getHiddenDraftSessionScope(storedDraft.metadata) === scope) {
        return storedDraft;
      }
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to reuse hidden draft session:', getErrorMessage(error));
    }
    clearHiddenDraftSessionId(scope);
  }

  // 2. 创建新的隐藏 draft（与 useSessionLifecycle.createHiddenDraftSession 同构）
  const session = await createSessionWithDefaults({
    mode: 'chat',
    title: null,
    metadata: buildHiddenDraftSessionMetadata(null, scope),
    groupId: null,
  });
  persistHiddenDraftSessionId(scope, session.id);
  return session;
}

/**
 * 确保存在一个可注入上下文的活动会话，返回其 sessionId。
 * 创建/恢复失败时返回 null（调用方保留原「无会话」提示兜底）。
 */
export async function ensureActiveChatSession(): Promise<string | null> {
  // 快路径：已有活动会话
  const currentId = sessionManager.getCurrentSessionId();
  if (currentId && sessionManager.has(currentId)) {
    return currentId;
  }

  if (inFlight) return inFlight;

  inFlight = (async (): Promise<string | null> => {
    try {
      const session = await resolveDraftSession();

      const alreadyCached = sessionManager.has(session.id);
      const store = sessionManager.getOrCreate(session.id, { mode: session.mode ?? 'chat' });

      // 复用已持久化的会话时，先完成历史恢复再返回；
      // 否则调用方随后的 addContextRef 可能被 loadSession 的恢复写入覆盖
      if (!alreadyCached) {
        try {
          await store.getState().loadSession(session.id);
        } catch (error) {
          console.warn(LOG_PREFIX, 'loadSession failed (continuing with empty state):', getErrorMessage(error));
        }
      }

      sessionManager.setCurrentSessionId(session.id);

      // 聊天页已挂载时同步其 React 状态（会话列表 + 当前会话）；未挂载时无监听者
      window.dispatchEvent(new CustomEvent('navigate-to-session', {
        detail: { sessionId: session.id },
      }));

      console.log(LOG_PREFIX, 'Activated session for external reference:', session.id);
      return session.id;
    } catch (error) {
      console.error(LOG_PREFIX, 'Failed to ensure active session:', getErrorMessage(error));
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export default ensureActiveChatSession;
