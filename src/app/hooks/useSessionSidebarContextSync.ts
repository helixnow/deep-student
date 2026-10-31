import { useCallback, useEffect } from 'react';
import type { CurrentView } from '@/types/navigation';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { setSessionSidebarViewContext } from '@/features/chat/hooks/useSessionSidebarIndicators';

/**
 * App 壳层：把当前视图、活跃会话与窗口可见性（focus / blur / visibilitychange）同步给
 * 会话侧栏指示器（流式 / 未读）。从 App.tsx 原样搬出。
 */
export function useSessionSidebarContextSync(currentView: CurrentView) {
  const syncSessionSidebarContext = useCallback(() => {
    setSessionSidebarViewContext({
      currentView,
      activeSessionId: sessionManager.getCurrentSessionId(),
      isDocumentVisible:
        typeof document === 'undefined'
          ? true
          : document.visibilityState === 'visible' && document.hasFocus(),
    });
  }, [currentView]);

  useEffect(() => {
    syncSessionSidebarContext();

    const unsubscribeSessionManager = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed') {
        syncSessionSidebarContext();
      }
    });

    return () => {
      unsubscribeSessionManager();
    };
  }, [syncSessionSidebarContext]);

  useEventRegistry([
    {
      target: 'window',
      type: 'focus',
      listener: syncSessionSidebarContext as EventListener,
    },
    {
      target: 'window',
      type: 'blur',
      listener: syncSessionSidebarContext as EventListener,
    },
    {
      target: 'document',
      type: 'visibilitychange',
      listener: syncSessionSidebarContext as EventListener,
    },
  ], [syncSessionSidebarContext]);
}
