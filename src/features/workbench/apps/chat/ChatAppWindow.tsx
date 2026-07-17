/**
 * Workbench Chat 单例窗口。
 *
 * OS 模式仍复用完整 ChatV2Page，会话管理由裁剪后的原 ModernSidebar 承担；
 * Dock 只负责打开或聚焦这个应用窗口。
 */
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { ModernSidebar } from '@/components/ModernSidebar';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import { WbSysSidebarLayout } from '../system/SystemWindowShared';
import { useWbSysSize } from '../system/useWbSysSize';
import { ChatWindowSkeleton } from './ChatWindowSkeleton';
import './ChatAppWindow.css';

const ChatV2Page = React.lazy(() =>
  import('@/features/chat/pages').then((module) => ({ default: module.ChatV2Page })),
);

const SHELL_VAR_RESET = {
  '--shell-titlebar-height': '0px',
  '--shell-layout-gap': '0px',
} as React.CSSProperties;

function dispatchSessionNavigation(sessionId: string): () => void {
  const timers = [0, 400, 1200].map((delay) => window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId } }));
  }, delay));
  return () => timers.forEach((timer) => window.clearTimeout(timer));
}

export const ChatAppWindow: React.FC<AppWindowProps> = ({
  instanceKey,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    () => sessionManager.getCurrentSessionId() ?? instanceKey,
  );
  const storeUnsubscribeRef = useRef<(() => void) | null>(null);

  const syncWindowTitle = useCallback((sessionId: string | null) => {
    storeUnsubscribeRef.current?.();
    storeUnsubscribeRef.current = null;

    const fallback = t('workbench:apps.chat.untitledSession');
    if (!sessionId) {
      onTitleChange(fallback);
      return;
    }

    const store = sessionManager.get(sessionId);
    if (!store) {
      onTitleChange(fallback);
      return;
    }

    const applyTitle = () => {
      onTitleChange(getSessionTitleText(store.getState().title, fallback));
    };
    applyTitle();
    storeUnsubscribeRef.current = store.subscribe((state, previousState) => {
      if (state.title !== previousState.title) applyTitle();
    });
  }, [onTitleChange, t]);

  useEffect(() => {
    syncWindowTitle(activeSessionId);
    return () => {
      storeUnsubscribeRef.current?.();
      storeUnsubscribeRef.current = null;
    };
  }, [activeSessionId, syncWindowTitle]);

  useEffect(() => sessionManager.subscribe((event) => {
    if (event.type === 'current-session-changed') {
      setActiveSessionId(event.sessionId || null);
    } else if (event.type === 'session-created' && event.sessionId === activeSessionId) {
      syncWindowTitle(activeSessionId);
    }
  }), [activeSessionId, syncWindowTitle]);

  // 首次由历史会话入口打开窗口时，在 ChatV2Page 完成冷启动后切到目标会话。
  useEffect(() => {
    if (!instanceKey || sessionManager.getCurrentSessionId()) return;
    return dispatchSessionNavigation(instanceKey);
  }, [instanceKey]);

  return (
    <div
      ref={ref}
      className="wb-chat-app-host h-full w-full min-w-0 overflow-hidden bg-background"
      style={SHELL_VAR_RESET}
      data-wb-chat-app
    >
      <WbSysSidebarLayout
        sizeClass={sizeClass}
        navLabel={t('workbench:apps.chat.sessionNav')}
        sidebar={(
          <ModernSidebar
            currentView="chat-v2"
            onViewChange={() => {}}
            navigationScope="chat"
            sidebarCollapsed={false}
          />
        )}
      >
        <div className="relative h-full min-h-0 min-w-0 overflow-hidden">
          {/* 复用消息气泡骨架（而非通用 surface 骨架）：与 ChatWindowFrame
              先导骨架同形态，二段加载期间内容区视觉连续无跳变 */}
          <Suspense fallback={<ChatWindowSkeleton />}>
            <ChatV2Page />
          </Suspense>
        </div>
      </WbSysSidebarLayout>
    </div>
  );
};

export default ChatAppWindow;
