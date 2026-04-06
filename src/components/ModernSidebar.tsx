import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { createNavItems } from '../config/navigation';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { sessionManager } from '@/chat-v2/core/session/sessionManager';
import type { ChatSession } from '@/chat-v2/types/session';
import { getSessionTitleText } from '@/chat-v2/utils/sessionTitle';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { StudySettingsIcon } from './icons/StudySidebarIcons';

interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

interface ModernSidebarProps {
  currentView: CurrentView;
  onViewChange: (view: CurrentView) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  startDragging?: (e: React.MouseEvent) => void;
  navigationHistory?: NavigationHistory;
  topbarTopMargin?: number;
}

export const ModernSidebar: React.FC<ModernSidebarProps> = ({
  currentView,
  onViewChange,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const [recentSessions, setRecentSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return sessionManager.getCurrentSessionId() || localStorage.getItem('chat-v2-last-session-id');
    } catch {
      return sessionManager.getCurrentSessionId();
    }
  });

  const navItems = useMemo(() => createNavItems(t), [t]);
  const primaryItems = useMemo(
    () =>
      navItems.filter((item) =>
        ['chat-v2', 'learning-hub', 'todo', 'skills-management', 'task-dashboard', 'template-management'].includes(item.view)
      ),
    [navItems]
  );
  const chatNavLabel = t('sidebar:navigation.chat_v2', '智能会话');
  // 包装 onViewChange，添加点击追踪
  const handleViewChange = useCallback((view: CurrentView) => {
    if (view !== currentView) {
      pageLifecycleTracker.log(
        'sidebar',
        'ModernSidebar',
        'sidebar_click',
        `${currentView} → ${view}`
      );
    }
    onViewChange(view);
  }, [currentView, onViewChange]);

  const loadRecentSessions = useCallback(async () => {
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        limit: 8,
        offset: 0,
      });
      setRecentSessions(result);
    } catch (error) {
      console.warn('[ModernSidebar] Failed to load recent sessions:', error);
      setRecentSessions([]);
    }
  }, []);

  useEffect(() => {
    void loadRecentSessions();
  }, [loadRecentSessions]);

  useEffect(() => {
    if (currentView === 'chat-v2') {
      setActiveSessionId(sessionManager.getCurrentSessionId());
    }
  }, [currentView]);

  const syncActiveSession = useCallback((event?: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }> | undefined)?.detail;
    setActiveSessionId(detail?.sessionId ?? sessionManager.getCurrentSessionId());
  }, []);

  const refreshSessions = useCallback(() => {
    void loadRecentSessions();
    syncActiveSession();
  }, [loadRecentSessions, syncActiveSession]);

  useEventRegistry([
    {
      target: 'window',
      type: 'navigate-to-session',
      listener: syncActiveSession as EventListener,
    },
    {
      target: 'window',
      type: 'chat-v2:sessions-updated',
      listener: refreshSessions,
    },
    {
      target: 'window',
      type: 'focus',
      listener: refreshSessions,
    },
  ], [refreshSessions, syncActiveSession]);

  const handleRecentSessionOpen = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    if (currentView !== 'chat-v2') {
      handleViewChange('chat-v2');
    }
    window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId } }));
  }, [currentView, handleViewChange]);

  const renderNavRow = useCallback((view: CurrentView, label: string, Icon: React.ComponentType<any>) => {
    const isActive = currentView === view;

    return (
      <NotionButton
        key={view}
        variant="nav"
        size="md"
        onClick={() => handleViewChange(view)}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
            'desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left',
            isActive && 'desktop-shell-nav-row--active'
        )}
        data-tour-id={`nav-${view}`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex shrink-0 items-center justify-center text-[color:inherit]">
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{label}</span>
            </span>
          </span>
      </NotionButton>
    );
  }, [currentView, handleViewChange]);

  const renderRecentSessionRow = useCallback((session: ChatSession) => {
    const isActive = currentView === 'chat-v2' && activeSessionId === session.id;
    const sessionTitle = getSessionTitleText(session.title, t('chatV2:page.untitled', '未命名对话'));

    return (
      <NotionButton
        key={session.id}
        variant="nav"
        size="md"
        onClick={() => handleRecentSessionOpen(session.id)}
        aria-label={sessionTitle}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'desktop-shell-thread-row !w-full !justify-start !px-3 !py-1.5 text-left',
          isActive && 'desktop-shell-thread-row--active'
        )}
      >
        <span className="block min-w-0 flex-1 truncate leading-4">
          {sessionTitle}
        </span>
      </NotionButton>
    );
  }, [activeSessionId, currentView, handleRecentSessionOpen, t]);

  return (
    <aside
      role="navigation"
      aria-label={t('sidebar:aria.sidebar_navigation', '主导航')}
      data-shell-layer="navigation"
      data-shell-surface="navigation"
      className="font-sidebar-study-ui relative z-20 flex h-full w-[var(--shell-navigation-width)] shrink-0 flex-col bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)] transition-colors duration-500"
      style={{ paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' }}
    >
      <div className="px-2 pb-1 pt-1" data-no-drag />

      <CustomScrollArea className="flex-1 w-full" viewportClassName="h-full w-full">
        <div className="flex flex-col gap-3 px-2 pb-3 pt-1" data-no-drag>
          <div className="space-y-1">
            <nav aria-label={t('sidebar:aria.workspace_primary_entry', '工作区主入口')}>
              <div className="space-y-0.5" role="list">
                {primaryItems.map((item) =>
                  renderNavRow(
                    item.view as CurrentView,
                    item.view === 'chat-v2' ? chatNavLabel : item.name,
                    item.icon
                  )
                )}
              </div>
            </nav>
          </div>

          {recentSessions.length > 0 ? (
            <section className="space-y-0.5 pt-1">
              <div className="px-3">
                <p className="desktop-shell-nav-section-label">
                  {t('sidebar:sections.recent', '最近')}
                </p>
              </div>
              <nav aria-label={t('sidebar:aria.recent_sessions', '最近会话')}>
                <div className="space-y-0.5" role="list">
                  {recentSessions.map((session) => renderRecentSessionRow(session))}
                </div>
              </nav>
            </section>
          ) : null}
        </div>
      </CustomScrollArea>

      <div className="mt-auto px-2 pb-3 pt-1" data-no-drag>
        <div className="flex justify-start">
          <NotionButton
            variant="nav"
            size="md"
            onClick={() => handleViewChange('settings')}
            aria-label={t('sidebar:navigation.settings', '设置')}
            aria-current={currentView === 'settings' ? 'page' : undefined}
            className={cn(
              'desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left',
              currentView === 'settings' && 'desktop-shell-nav-row--active'
            )}
            data-tour-id="nav-settings"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="flex shrink-0 items-center justify-center text-[color:inherit]">
                <StudySettingsIcon className="size-[18px]" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t('sidebar:navigation.settings', '设置')}</span>
              </span>
            </span>
          </NotionButton>
        </div>
      </div>
    </aside>
  );
};
