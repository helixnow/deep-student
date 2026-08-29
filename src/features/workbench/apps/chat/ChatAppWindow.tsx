/**
 * Workbench Chat 单例窗口。
 *
 * OS 模式仍复用完整 ChatV2Page，会话管理由裁剪后的原 ModernSidebar 承担；
 * Dock 只负责打开或聚焦这个应用窗口。
 */
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { ModernSidebar } from '@/components/ModernSidebar';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { DsButton } from '@/components/ui/DsButton';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from '@/app/shell/DesktopShellIcons';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { requestChatSessionNavigation } from '@/features/chat/navigation/pendingChatNavigation';
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

export const ChatAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  isActive,
  isVisible,
  renderThrottleMs = 0,
  isSuspended = false,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const compact = sizeClass === 'compact';
  const navigationVisible = compact ? drawerOpen : !sidebarCollapsed;

  useLayoutEffect(() => {
    const escapedWindowId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(windowId) : windowId;
    const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${escapedWindowId}"]`);
    // slot 在窗口壳内时查询范围收窄到壳节点；仅测试等无壳环境回退全文档
    const queryRoot: ParentNode = shell ?? document;
    let currentTarget: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    const findTarget = () => {
      const target = Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      if (!target) return;
      currentTarget = target;
      setTitlebarTarget((current) => current === target ? current : target);
      // titlebar slot 与窗口同生命周期；命中后无需继续观察聊天流中的高频 DOM 变更。
      observer?.disconnect();
      observer = null;
    };
    findTarget();
    if (!currentTarget) {
      observer = new MutationObserver(findTarget);
      observer.observe(shell ?? document.body, { childList: true, subtree: true });
    }
    return () => observer?.disconnect();
  }, [windowId]);

  const toggleNavigation = useCallback(() => {
    if (compact) {
      setDrawerOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  }, [compact]);

  // Workbench 命令面板与标题栏按钮共用同一侧栏状态；ChatV2Page 内部监听器
  // 只管理 legacy 页面状态，无法折叠外层 WorkbenchSidebarLayout。
  useEffect(() => {
    window.addEventListener('CHAT_TOGGLE_SIDEBAR', toggleNavigation);
    return () => window.removeEventListener('CHAT_TOGGLE_SIDEBAR', toggleNavigation);
  }, [toggleNavigation]);

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

  // 首次由历史会话入口打开窗口时：交给导航握手。ChatV2Page 完成冷启动
  // （初始加载结束）后消费该意图；用户提前手动切会话则意图自动作废。
  useEffect(() => {
    if (!instanceKey || sessionManager.getCurrentSessionId()) return;
    requestChatSessionNavigation(instanceKey);
  }, [instanceKey]);

  return (
    <div
      ref={ref}
      className="wb-chat-app-host h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      style={SHELL_VAR_RESET}
      data-wb-chat-app
    >
      <WorkbenchSidebarLayout
        sizeClass={sizeClass}
        navLabel={t('workbench:apps.chat.sessionNav')}
        sidebarCollapsed={sidebarCollapsed}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        sidebar={(
          <ModernSidebar
            currentView="chat-v2"
            onViewChange={() => {}}
            navigationScope="chat"
            sidebarCollapsed={sidebarCollapsed}
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
      {titlebarTarget ? createPortal(
        <div className="wb-chat-titlebar-controls">
          <CommonTooltip content={t('common:navigation.toggle_sidebar', '切换边栏')} position="bottom">
            <DsButton
              variant="ghost"
              size="icon"
              className="wb-chat-titlebar-sidebar-toggle"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={toggleNavigation}
              aria-label={t('common:navigation.toggle_sidebar', '切换边栏')}
              aria-expanded={navigationVisible}
              data-wb-chat-sidebar-toggle
            >
              {navigationVisible ? <SidebarFrameWithLeftRailIcon /> : <SidebarFrameIcon />}
            </DsButton>
          </CommonTooltip>
        </div>,
        titlebarTarget,
      ) : null}
    </div>
  );
};

export default ChatAppWindow;
