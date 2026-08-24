/**
 * ChatSessionWindow — 单会话 multi 实例窗口
 *
 * instanceKey = sessionId，一会话一窗（workbenchBus 按 instanceKey 去重聚焦）。
 * 渲染面复用 ChatSessionSurface（P7/O16：store 按 sessionId 隔离、
 * adapter 引用计数、流式降频与拖缩暂停都在 surface 内），
 * 因此与 Chat 单例窗口（全局 currentSessionId）互不干扰——
 * 同一会话同时出现在两个窗口时共享同一 store，消息流实时同步。
 *
 * 标题从会话 store 同步；store 未建立（surface 冷启动、ChatContainer
 * 尚未 getOrCreate）时监听 session-created 再绑定。
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import { ChatSessionSurface } from './ChatSessionSurface';

export const ChatSessionWindow: React.FC<AppWindowProps> = ({
  instanceKey,
  isActive,
  isVisible,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const sessionId = instanceKey;

  useEffect(() => {
    if (!sessionId) return;
    const fallback = t('workbench:apps.chat.untitledSession');
    let storeUnsubscribe: (() => void) | null = null;
    let managerUnsubscribe: (() => void) | null = null;

    const bindTitle = (): boolean => {
      const store = sessionManager.get(sessionId);
      if (!store) return false;
      const applyTitle = () => {
        onTitleChange(getSessionTitleText(store.getState().title, fallback));
      };
      applyTitle();
      storeUnsubscribe = store.subscribe((state, previousState) => {
        if (state.title !== previousState.title) applyTitle();
      });
      return true;
    };

    onTitleChange(fallback);
    if (!bindTitle()) {
      managerUnsubscribe = sessionManager.subscribe((event) => {
        if (event.type === 'session-created' && event.sessionId === sessionId) {
          if (bindTitle()) {
            managerUnsubscribe?.();
            managerUnsubscribe = null;
          }
        }
      });
    }
    return () => {
      storeUnsubscribe?.();
      managerUnsubscribe?.();
    };
  }, [sessionId, onTitleChange, t]);

  // multi 应用无 instanceKey 不应发生（showInLauncher: false，入口都带会话）；
  // 防御性兜底给出可读空态而非白屏
  if (!sessionId) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground"
        data-wb-chat-session-window-empty
      >
        {t('workbench:apps.chatSession.missingSession')}
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      data-wb-chat-session-window={sessionId}
    >
      <ChatSessionSurface
        sessionId={sessionId}
        isActive={isActive}
        isVisible={isVisible}
        renderThrottleMs={renderThrottleMs}
        className="h-full"
      />
    </div>
  );
};

export default ChatSessionWindow;
