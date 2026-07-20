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
import { WorkbenchSidebarLayout } from '../system/SystemWindowShared';
import { useWbSysSize } from '../system/useWbSysSize';
import { useDeferredStreamPreset } from './useDeferredStreamPreset';
import { ChatWindowSkeleton } from './ChatWindowSkeleton';
import './ChatAppWindow.css';
// O16 打磨层：容器查询紧凑边距 / 非焦点输入淡化 / 拖缩暂停，
// 作用域挂在 .wb-chat-surface + [data-wb-chat-session]（ChatV2Page 已设）
import './ChatSessionSurface.css';

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
  isActive,
  isVisible,
  renderThrottleMs = 0,
  isSuspended = false,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();

  // 消费壳层降档信号（与 ChatSessionSurface 同一策略）：不可见持续 800ms
  // 才降 silky（瞬时遮挡不骤停），回可见立即回 balanced 全速补渲；
  // 焦点窗 isVisible=true 且 renderThrottleMs=0 → 恒为 balanced，与原行为一致。
  const streamPreset = useDeferredStreamPreset(isVisible, renderThrottleMs);
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
      <WorkbenchSidebarLayout
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
        <div
          className="wb-chat-surface relative h-full min-h-0 min-w-0 overflow-hidden"
          data-wb-chat-active={isActive ? 'true' : 'false'}
        >
          {/* 复用消息气泡骨架（而非通用 surface 骨架）：与 ChatWindowFrame
              先导骨架同形态，二段加载期间内容区视觉连续无跳变 */}
          <Suspense fallback={<ChatWindowSkeleton />}>
            {/* isSuspended：background 窗壳层已停绘，流式提交暂停（缓冲不丢） */}
            <ChatV2Page streamPreset={streamPreset} isSuspended={isSuspended} />
          </Suspense>
        </div>
      </WorkbenchSidebarLayout>
    </div>
  );
};

export default ChatAppWindow;
