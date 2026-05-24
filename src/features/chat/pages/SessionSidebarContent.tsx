import React from 'react';
import {
  Books,
  CaretRight,
  ChatCenteredText,
  CheckSquare,
  Folder,
  GearSix,
  Plus,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChatErrorBoundary } from '../components/ChatErrorBoundary';
import { compareSessionsForSidebar, isSessionPinned } from '../utils/sessionPin';
import { MOBILE_APP_NAVIGATE_EVENT } from '@/components/layout';
import type { SessionDragState } from './SessionItemRenderer';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import type { CurrentView } from '@/types/navigation';
import type { TFunction } from 'i18next';

export interface UseSessionSidebarContentDeps {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  showChatControl: boolean;
  isInitialLoading: boolean;
  sessions: ChatSession[];
  visibleGroups: SessionGroup[];
  sessionsByGroup: Map<string, ChatSession[]>;
  ungroupedSessions: ChatSession[];
  currentSessionId: string | null;
  totalSessionCount: number | null;
  hasMoreSessions: boolean;
  isLoadingMore: boolean;
  pendingDeleteSessionId: string | null;
  t: TFunction<any, any>;
  resetDeleteConfirmation: () => void;
  clearDeleteConfirmTimeout: () => void;
  deleteConfirmTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  createSession: (groupId?: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  renderSessionItem: (session: ChatSession, drag?: SessionDragState) => React.ReactNode;
}

export function useSessionSidebarContent(deps: UseSessionSidebarContentDeps) {
  const {
    searchQuery, setSearchQuery, setViewMode, setSessionSheetOpen,
    setShowChatControl, setPendingDeleteSessionId,
    showChatControl,
    isInitialLoading, sessions, visibleGroups, sessionsByGroup, ungroupedSessions,
    currentSessionId, totalSessionCount,
    hasMoreSessions, isLoadingMore, pendingDeleteSessionId,
    t,
    resetDeleteConfirmation, clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    createSession, loadMoreSessions,
    renderSessionItem,
  } = deps;
  void searchQuery;
  void setSearchQuery;
  void setShowChatControl;
  void setPendingDeleteSessionId;
  void showChatControl;
  void totalSessionCount;
  void hasMoreSessions;
  void isLoadingMore;
  void pendingDeleteSessionId;
  void resetDeleteConfirmation;
  void clearDeleteConfirmTimeout;
  void deleteConfirmTimeoutRef;
  void loadMoreSessions;

  const sortedSessions = React.useMemo(
    () => [...sessions].sort(compareSessionsForSidebar),
    [sessions]
  );

  const pinnedSessions = React.useMemo(
    () => sortedSessions.filter(isSessionPinned),
    [sortedSessions]
  );

  const currentSession = React.useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [currentSessionId, sessions]
  );

  const [expandedGroupIds, setExpandedGroupIds] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      let changed = false;
      const currentGroupId = currentSession?.groupId;

      if (currentGroupId && !next.has(currentGroupId)) {
        next.add(currentGroupId);
        changed = true;
      } else if (!currentGroupId && next.size === 0 && visibleGroups[0]) {
        next.add(visibleGroups[0].id);
        changed = true;
      }

      return changed ? next : current;
    });
  }, [currentSession?.groupId, visibleGroups]);

  const navigateToView = React.useCallback((view: CurrentView) => {
    window.dispatchEvent(new CustomEvent(MOBILE_APP_NAVIGATE_EVENT, { detail: { view } }));
    setSessionSheetOpen(false);
  }, [setSessionSheetOpen]);

  const handleCreateSession = React.useCallback(() => {
    setViewMode('sidebar');
    setSessionSheetOpen(false);
    void createSession();
  }, [createSession, setSessionSheetOpen, setViewMode]);

  const toggleGroup = React.useCallback((groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const renderPrimaryItem = (
    id: CurrentView | 'new-chat',
    label: string,
    Icon: React.ElementType,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      key={id}
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1.5 text-left text-[16px] font-normal leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit',
        active
          ? 'bg-[color:var(--interactive-selected)] text-[color:var(--sidebar-foreground)]'
          : 'text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)]'
      )}
    >
      <Icon
        size={18}
        weight="regular"
        className={cn(
          'h-[18px] w-[18px] shrink-0',
          active
            ? 'text-[color:var(--sidebar-foreground)]'
            : 'text-[color:var(--sidebar-muted)] group-hover:text-[color:var(--sidebar-foreground)]'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  const renderFolderRow = (
    id: string,
    label: string,
    sessionsForFolder: ChatSession[],
    active: boolean,
  ) => {
    const isExpanded = expandedGroupIds.has(id);
    const nonPinnedSessions = sessionsForFolder.filter((session) => !isSessionPinned(session));

    return (
      <section key={id} className="space-y-0.5">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => toggleGroup(id)}
          className={cn(
            'group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1.5 text-left text-[16px] font-normal leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit',
            active
              ? 'bg-[color:var(--interactive-selected)] text-[color:var(--sidebar-foreground)]'
              : 'text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)]'
          )}
        >
          <Folder size={18} className="h-[18px] w-[18px] shrink-0 text-[color:var(--sidebar-muted)] group-hover:text-[color:var(--sidebar-foreground)]" />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate">{label}</span>
            <span className="flex items-center gap-1.5 text-[color:var(--sidebar-muted)]">
              <span
                aria-hidden="true"
                className="flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
              >
                <Plus size={12} />
              </span>
              <CaretRight
                size={12}
                className={cn(
                  'shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90'
                )}
              />
            </span>
          </span>
        </button>

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className={cn('space-y-0.5 overflow-hidden pl-4', !isExpanded && 'pointer-events-none')}>
            {nonPinnedSessions.map((session) => renderSessionItem(session))}
          </div>
        </div>
      </section>
    );
  };

  const renderStudySidebarContent = () => {
    if (isInitialLoading) {
      return null;
    }

    const ungroupedNonPinned = ungroupedSessions.filter((session) => !isSessionPinned(session));
    const activeGroupId = currentSession?.groupId && visibleGroups.some((group) => group.id === currentSession.groupId)
      ? currentSession.groupId
      : (!currentSession?.groupId && currentSession ? 'ungrouped' : null);

    return (
      <div className="space-y-3 pb-2 pt-1">
        {pinnedSessions.length > 0 && (
          <section className="space-y-0.5">
            <div className="space-y-0.5" role="list" aria-label={t('page.pinnedSessions', '置顶会话')}>
              {pinnedSessions.map((session) => renderSessionItem(session))}
            </div>
          </section>
        )}

        <section className="space-y-0.5" aria-label={t('page.studySessions', '课题')}>
          <div className="px-3">
            <p className="text-[11px] font-normal text-[color:var(--sidebar-muted)]">{t('page.studySessions', '课题')}</p>
          </div>
          <div className="space-y-0.5">
            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) =>
                renderFolderRow(
                  group.id,
                  group.name,
                  sessionsByGroup.get(group.id) ?? [],
                  activeGroupId === group.id
                )
              )
            ) : (
              <div className="px-3 py-2 text-[13px] text-[color:var(--sidebar-muted)] opacity-80">
                {t('page.studySessionsEmpty', '暂无课题')}
              </div>
            )}
          </div>
        </section>

        {(visibleGroups.length > 0 || ungroupedNonPinned.length > 0) && (
          <section className="space-y-0.5" aria-label={t('page.recentSessions', '最近')}>
            <div className="px-3">
              <p className="text-[11px] font-normal text-[color:var(--sidebar-muted)]">最近</p>
            </div>
            <div className="space-y-0.5">
              {ungroupedNonPinned.length > 0 && renderFolderRow(
                'ungrouped',
                '未分类',
                ungroupedNonPinned,
                activeGroupId === 'ungrouped'
              )}
            </div>
          </section>
        )}
      </div>
    );
  };

  // 渲染会话侧边栏内容（复用于移动端推拉布局和桌面端面板）
  const renderSessionSidebarContent = () => (
    <ChatErrorBoundary>
    <div className="font-sidebar-study-ui flex h-full min-h-0 flex-col bg-[color:var(--shell-navigation-surface)] text-[color:var(--sidebar-foreground)]">
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="px-2 py-1">
        <div className="space-y-3 pb-2 pt-1">
          <nav aria-label={t('page.primaryNavigation', '主入口')} className="space-y-0.5">
            {renderPrimaryItem('new-chat', '新对话', ChatCenteredText, !currentSessionId, handleCreateSession)}
            {renderPrimaryItem('learning-hub', '学习资源', Books, false, () => navigateToView('learning-hub'))}
            {renderPrimaryItem('todo', '待办', CheckSquare, false, () => navigateToView('todo'))}
          </nav>
          {renderStudySidebarContent()}
        </div>
      </CustomScrollArea>

      <div aria-label={t('page.sidebarFooter', '侧边栏底部')} className="mt-auto px-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))] pt-1.5">
        <button
          type="button"
          onClick={() => navigateToView('settings')}
          className="group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1.5 text-left text-[16px] font-normal leading-none text-[color:var(--sidebar-muted)] outline-none transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)] focus-visible:ring-2 focus-visible:ring-ring select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit"
        >
          <GearSix size={18} className="h-[18px] w-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">设置</span>
        </button>
      </div>
    </div>
    </ChatErrorBoundary>
  );

  return { renderSessionSidebarContent };
}
