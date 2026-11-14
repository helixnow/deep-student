import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import { APP_EVENTS, dispatchTypedEvent, useAppEvent } from '@/events';
/** chat-v2 会话列表变更（与会话页共用的事件名）。 */
const CHAT_SESSIONS_UPDATED_EVENT = 'chat-v2:sessions-updated';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { groupCache } from '@/features/chat/core/store/groupCache';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import type { ChatStore } from '@/features/chat/core/types';
import { getHiddenDraftSessionScope } from '@/features/chat/pages/draftSession';

/**
 * 壳层标题的会话来源：当前会话的标题/分组，以及桌面标题栏改名。
 *
 * 订阅当前会话 store，并在 sessionManager 的「当前会话变化 / 新建 / 销毁 / 淘汰」上重绑；
 * 空标题保持为空（未命名会话不误显示成新会话标题）。
 * W38：从 App.tsx 原样搬出，回调与 effect 依赖不变。
 */
export function useChatHeaderSession(t: TFunction) {
  const [currentChatHeaderTitle, setCurrentChatHeaderTitle] = useState('');
  const [currentChatHeaderGroupName, setCurrentChatHeaderGroupName] = useState('');
  const [currentChatHeaderSessionId, setCurrentChatHeaderSessionId] = useState<string | null>(null);
  const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);
  const currentChatHeaderSubscribedSessionIdRef = useRef<string | null>(null);

  const clearCurrentChatHeaderStoreSubscription = useCallback(() => {
    currentChatHeaderStoreUnsubscribeRef.current?.();
    currentChatHeaderStoreUnsubscribeRef.current = null;
    currentChatHeaderSubscribedSessionIdRef.current = null;
  }, []);

  const getChatHeaderTitleFromStoreState = useCallback((state?: ChatStore | null) => {
    if (!state) {
      return '';
    }

    if (getHiddenDraftSessionScope(state?.sessionMetadata)) {
      return '';
    }

    // 空标题代表尚未命名的当前会话；壳层保持标题区域为空，避免把
    // “未命名会话”误呈现为新会话的真实标题。
    return getSessionTitleText(state.title, '');
  }, [t]);

  const getChatHeaderGroupNameFromStoreState = useCallback((state?: ChatStore | null) => {
    if (!state?.groupId) {
      return '';
    }

    return groupCache.get(state.groupId)?.name ?? '';
  }, []);

  const syncCurrentChatHeaderTitle = useCallback((sessionId?: string | null) => {
    const chatHeaderSessionId = sessionId ?? sessionManager.getCurrentSessionId();
    if (!chatHeaderSessionId) {
      setCurrentChatHeaderSessionId(null);
      setCurrentChatHeaderTitle('');
      setCurrentChatHeaderGroupName('');
      return;
    }

    const chatHeaderStore = sessionManager.get(chatHeaderSessionId);
    setCurrentChatHeaderSessionId(chatHeaderSessionId);
    setCurrentChatHeaderTitle(getChatHeaderTitleFromStoreState(chatHeaderStore?.getState()));
    setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(chatHeaderStore?.getState()));
  }, [getChatHeaderGroupNameFromStoreState, getChatHeaderTitleFromStoreState, t]);

  const saveCurrentChatHeaderTitle = useCallback(async (sessionId: string, title: string) => {
    await invoke('chat_v2_update_session_settings', {
      sessionId,
      settings: { title },
    });

    sessionManager.get(sessionId)?.setState({ title });
    dispatchTypedEvent(CHAT_SESSIONS_UPDATED_EVENT);
  }, []);

  useEffect(() => {
    const bindCurrentChatHeaderStore = (sessionId: string | null) => {
      if (!sessionId) {
        clearCurrentChatHeaderStoreSubscription();
        return;
      }

      if (currentChatHeaderSubscribedSessionIdRef.current === sessionId) {
        return;
      }

      clearCurrentChatHeaderStoreSubscription();

      const activeChatHeaderStore = sessionManager.get(sessionId);
      if (!activeChatHeaderStore) {
        return;
      }

      currentChatHeaderSubscribedSessionIdRef.current = sessionId;
      currentChatHeaderStoreUnsubscribeRef.current = activeChatHeaderStore.subscribe(
        (state, prevState) => {
          if (
            state.title !== prevState.title ||
            state.sessionMetadata !== prevState.sessionMetadata ||
            state.groupId !== prevState.groupId
          ) {
            setCurrentChatHeaderTitle(getChatHeaderTitleFromStoreState(state));
            setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(state));
          }
        }
      );
    };

    const syncAndBindCurrentChatHeader = (sessionId: string | null = sessionManager.getCurrentSessionId()) => {
      bindCurrentChatHeaderStore(sessionId);
      syncCurrentChatHeaderTitle(sessionId);
    };

    syncAndBindCurrentChatHeader();

    const unsubscribeSessionManager = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed') {
        syncAndBindCurrentChatHeader(sessionManager.getCurrentSessionId());
        return;
      }

      const activeSessionId = sessionManager.getCurrentSessionId();
      if (!activeSessionId) {
        syncAndBindCurrentChatHeader(null);
        return;
      }

      if (event.sessionId === activeSessionId && event.type === 'session-created') {
        syncAndBindCurrentChatHeader(activeSessionId);
        return;
      }

      if (event.sessionId === activeSessionId && (event.type === 'session-destroyed' || event.type === 'session-evicted')) {
        syncAndBindCurrentChatHeader(activeSessionId);
      }
    });

    return () => {
      unsubscribeSessionManager();
      clearCurrentChatHeaderStoreSubscription();
    };
  }, [
    clearCurrentChatHeaderStoreSubscription,
    getChatHeaderGroupNameFromStoreState,
    getChatHeaderTitleFromStoreState,
    syncCurrentChatHeaderTitle,
    t,
  ]);

  const syncCurrentChatHeaderGroupName = useCallback(() => {
    const chatHeaderSessionId = sessionManager.getCurrentSessionId();
    if (!chatHeaderSessionId) {
      setCurrentChatHeaderGroupName('');
      return;
    }

    const chatHeaderStore = sessionManager.get(chatHeaderSessionId);
    setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(chatHeaderStore?.getState()));
  }, [getChatHeaderGroupNameFromStoreState]);

  useAppEvent(APP_EVENTS.CHAT_GROUPS_UPDATED, () => {
    syncCurrentChatHeaderGroupName();
  }, [syncCurrentChatHeaderGroupName]);

  return {
    currentChatHeaderTitle,
    currentChatHeaderGroupName,
    currentChatHeaderSessionId,
    saveCurrentChatHeaderTitle,
  };
}
