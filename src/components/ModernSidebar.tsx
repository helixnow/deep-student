import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  Atom,
  Archive,
  BookOpen,
  Bookmark,
  Brain,
  Calculator,
  Camera,
  Check,
  ChevronsDown,
  ChevronsUp,
  ChevronRight,
  Code,
  FileText,
  FlaskConical,
  Folder,
  FolderPlus,
  FolderOpen,
  Globe,
  GraduationCap,
  Heart,
  Languages,
  Lightbulb,
  MessageSquare,
  Music,
  Palette,
  Edit2,
  Pin,
  Rocket,
  Sparkles,
  Star,
  Target,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import { createNavItems } from '../config/navigation';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { sessionManager } from '@/chat-v2/core/session/sessionManager';
import type { ChatSession } from '@/chat-v2/types/session';
import type { SessionGroup } from '@/chat-v2/types/group';
import { buildPinnedSessionMetadata, isSessionPinned } from '@/chat-v2/utils/sessionPin';
import { getSessionTitleText } from '@/chat-v2/utils/sessionTitle';
import { SessionGroupActions } from '@/chat-v2/pages/SessionGroupActions';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { AppUpdaterController } from '@/hooks/useAppUpdater';
import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { StudySettingsIcon } from './icons/StudySidebarIcons';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';

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
  updater?: Pick<AppUpdaterController, 'checking' | 'available' | 'info' | 'downloading' | 'performUpdateAction'>;
}

const UNGROUPED_RECENT_GROUP_ID = '__ungrouped__';

interface RecentSessionGroup {
  id: string;
  label: string;
  icon?: string;
  sessions: ChatSession[];
  isUngrouped?: boolean;
}

const RECENT_GROUP_PRESET_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  'folder-open': FolderOpen,
  star: Star,
  heart: Heart,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  code: Code,
  calculator: Calculator,
  flask: FlaskConical,
  atom: Atom,
  globe: Globe,
  languages: Languages,
  music: Music,
  palette: Palette,
  camera: Camera,
  lightbulb: Lightbulb,
  target: Target,
  trophy: Trophy,
  rocket: Rocket,
  brain: Brain,
  sparkles: Sparkles,
  'message-square': MessageSquare,
  'file-text': FileText,
  bookmark: Bookmark,
};

function isSessionGroup(value: unknown): value is SessionGroup {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionGroup>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.sortOrder === 'number';
}

function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => {
    const pinDelta = Number(isSessionPinned(right)) - Number(isSessionPinned(left));
    if (pinDelta !== 0) return pinDelta;

    const leftTimestamp = left.updatedAt ?? left.createdAt ?? '';
    const rightTimestamp = right.updatedAt ?? right.createdAt ?? '';
    return rightTimestamp.localeCompare(leftTimestamp);
  });
}

function sortGroups(groups: SessionGroup[]): SessionGroup[] {
  return [...groups].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  });
}

function getSidebarRowClassName({
  rowType,
  isActive,
  className,
}: {
  rowType: 'nav' | 'thread';
  isActive: boolean;
  className?: string;
}) {
  return cn(
    'desktop-shell-sidebar-row',
    rowType === 'thread' ? 'desktop-shell-thread-row' : 'desktop-shell-nav-row',
    '!w-full !justify-start !px-2.5 !py-1.5 text-left',
    isActive
      ? rowType === 'thread' ? 'desktop-shell-thread-row--active' : 'desktop-shell-nav-row--active'
      : null,
    className
  );
}

function SidebarRowLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block min-w-0 flex-1 truncate leading-4">
      {children}
    </span>
  );
}

function SidebarRow({
  rowType,
  isActive,
  className,
  leftSlot,
  rightSlot,
  children,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  rowType: 'nav' | 'thread';
  isActive: boolean;
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
}) {
  return (
    <NotionButton
      variant="nav"
      size="md"
      className={getSidebarRowClassName({ rowType, isActive, className })}
      {...buttonProps}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex w-4 shrink-0 items-center justify-center text-[color:inherit]">
          {leftSlot}
        </span>
        <span className="min-w-0 flex-1">
          {children}
        </span>
        <span className="flex min-w-[24px] shrink-0 items-center justify-end gap-0.5">
          {rightSlot}
        </span>
      </span>
    </NotionButton>
  );
}

export function reorderSidebarSessionGroups(groups: SessionGroup[], sourceGroupId: string, targetGroupId: string): SessionGroup[] {
  const sourceIndex = groups.findIndex((group) => group.id === sourceGroupId);
  const targetIndex = groups.findIndex((group) => group.id === targetGroupId);

  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return groups;
  }

  const next = [...groups];
  const [movedGroup] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, movedGroup);

  return next.map((group, index) => ({
    ...group,
    sortOrder: index,
  }));
}

export const ModernSidebar: React.FC<ModernSidebarProps> = ({
  currentView,
  onViewChange,
  sidebarCollapsed = false,
  updater,
}) => {
  void sidebarCollapsed;
  const { t } = useTranslation(['sidebar', 'common', 'chatV2']);
  const [recentSessions, setRecentSessions] = useState<ChatSession[]>([]);
  const [recentGroups, setRecentGroups] = useState<SessionGroup[]>([]);
  const [collapsedRecentGroupIds, setCollapsedRecentGroupIds] = useState<Set<string>>(() => new Set());
  const [draggedRecentGroupId, setDraggedRecentGroupId] = useState<string | null>(null);
  const [dragOverRecentGroupId, setDragOverRecentGroupId] = useState<string | null>(null);
  const [hoveredRecentSessionId, setHoveredRecentSessionId] = useState<string | null>(null);
  const [openRecentSessionMenuId, setOpenRecentSessionMenuId] = useState<string | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = useState<string | null>(null);
  const draggedRecentGroupIdRef = useRef<string | null>(null);
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
  const shouldShowUpdateBadge = Boolean(updater && !updater.checking && updater.available && updater.info);
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

  const loadSidebarData = useCallback(async () => {
    const [sessionsResult, groupsResult] = await Promise.allSettled([
      invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        limit: 8,
        offset: 0,
      }),
      invoke<SessionGroup[]>('chat_v2_list_groups', {
        status: 'active',
      }),
    ]);

    if (sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value)) {
      setRecentSessions(sortSessionsByUpdatedAt(sessionsResult.value));
    } else {
      console.warn('[ModernSidebar] Failed to load recent sessions:', sessionsResult.status === 'rejected' ? sessionsResult.reason : 'Invalid session payload');
      setRecentSessions([]);
    }

    if (groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value)) {
      setRecentGroups(sortGroups(groupsResult.value.filter(isSessionGroup)));
    } else {
      console.warn('[ModernSidebar] Failed to load recent groups:', groupsResult.status === 'rejected' ? groupsResult.reason : 'Invalid group payload');
      setRecentGroups([]);
    }
  }, []);

  useEffect(() => {
    void loadSidebarData();
  }, [loadSidebarData]);

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
    void loadSidebarData();
    syncActiveSession();
  }, [loadSidebarData, syncActiveSession]);

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
      type: 'chat-v2:groups-updated',
      listener: refreshSessions,
    },
    {
      target: 'window',
      type: 'focus',
      listener: refreshSessions,
    },
  ], [refreshSessions, syncActiveSession]);

  useEffect(() => {
    if (draggedRecentGroupId === null) {
      return undefined;
    }

    const previousBodyCursor = document.body.style.cursor;
    const previousRootCursor = document.documentElement.style.cursor;
    document.body.style.cursor = 'grabbing';
    document.documentElement.style.cursor = 'grabbing';

    return () => {
      document.body.style.cursor = previousBodyCursor;
      document.documentElement.style.cursor = previousRootCursor;
    };
  }, [draggedRecentGroupId]);

  const handleRecentSessionOpen = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    if (currentView !== 'chat-v2') {
      handleViewChange('chat-v2');
    }
    window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId } }));
  }, [currentView, handleViewChange]);

  const handleRecentSessionPinToggle = useCallback(async (session: ChatSession) => {
    const nextMetadata = buildPinnedSessionMetadata(session.metadata, !isSessionPinned(session));

    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId: session.id,
        settings: { metadata: nextMetadata ?? null },
      });

      setRecentSessions((previous) =>
        sortSessionsByUpdatedAt(
          previous.map((item) =>
            item.id === session.id ? { ...item, metadata: nextMetadata } : item
          )
        )
      );
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to toggle recent session pin:', error);
    }
  }, []);

  const dispatchRecentSessionAction = useCallback((action: 'rename-session', session: ChatSession) => {
    const dispatch = () => {
      window.dispatchEvent(new CustomEvent('modern-sidebar:session-action', {
        detail: { action, session, sessionId: session.id },
      }));
    };

    if (currentView !== 'chat-v2') {
      handleViewChange('chat-v2');
      window.setTimeout(dispatch, 0);
      return;
    }

    dispatch();
  }, [currentView, handleViewChange]);

  const handleRecentSessionArchive = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_archive_session', { sessionId });
      setRecentSessions((previous) => previous.filter((item) => item.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
      setConfirmingArchiveSessionId((current) => (current === sessionId ? null : current));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to archive recent session:', error);
      void loadSidebarData();
    }
  }, [activeSessionId, loadSidebarData]);

  const toggleRecentGroup = useCallback((groupId: string) => {
    setCollapsedRecentGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleCreateRecentGroup = useCallback(() => {
    window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
      detail: { action: 'create-group' },
    }));
  }, []);

  const clearRecentGroupDragState = useCallback(() => {
    draggedRecentGroupIdRef.current = null;
    setDraggedRecentGroupId(null);
    setDragOverRecentGroupId(null);
  }, []);

  const handleRecentGroupDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, groupId: string) => {
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-modern-sidebar-group-id', groupId);
      event.dataTransfer.setData('text/plain', groupId);
    }
    draggedRecentGroupIdRef.current = groupId;
    setDraggedRecentGroupId(groupId);
    setDragOverRecentGroupId(groupId);
  }, []);

  const handleRecentGroupDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, groupId: string) => {
    const draggingGroupId = draggedRecentGroupIdRef.current;
    if (draggingGroupId === null || draggingGroupId === groupId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    setDragOverRecentGroupId((current) => (current === groupId ? current : groupId));
  }, []);

  const handleRecentGroupDrop = useCallback(async (event: React.DragEvent<HTMLButtonElement>, targetGroupId: string) => {
    event.preventDefault();
    event.stopPropagation();

    const draggingGroupId =
      draggedRecentGroupIdRef.current
      ?? event.dataTransfer?.getData('application/x-modern-sidebar-group-id')
      ?? event.dataTransfer?.getData('text/plain')
      ?? null;
    if (draggingGroupId === null || draggingGroupId === targetGroupId) {
      clearRecentGroupDragState();
      return;
    }

    let reorderedIds: string[] = [];

    setRecentGroups((previous) => {
      const next = reorderSidebarSessionGroups(previous, draggingGroupId, targetGroupId);
      reorderedIds = next.map((group) => group.id);
      return next;
    });

    clearRecentGroupDragState();

    if (reorderedIds.length === 0) {
      return;
    }

    try {
      await invoke('chat_v2_reorder_groups', { groupIds: reorderedIds });
      window.dispatchEvent(new CustomEvent('chat-v2:groups-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to reorder recent groups:', error);
      void loadSidebarData();
    }
  }, [clearRecentGroupDragState, loadSidebarData]);

  const renderNavRow = useCallback((view: CurrentView, label: string, Icon: React.ComponentType<any>) => {
    const isActive = currentView === view;

    return (
      <SidebarRow
        key={view}
        rowType="nav"
        onClick={() => handleViewChange(view)}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        isActive={isActive}
        data-tour-id={`nav-${view}`}
        leftSlot={<Icon className="size-[18px]" strokeWidth={2} />}
      >
        <SidebarRowLabel>{label}</SidebarRowLabel>
      </SidebarRow>
    );
  }, [currentView, handleViewChange]);

  const renderRecentSessionRow = useCallback((session: ChatSession, collapsed = false) => {
    const isActive = currentView === 'chat-v2' && activeSessionId === session.id;
    const sessionTitle = getSessionTitleText(session.title, t('chatV2:page.untitled', '未命名对话'));
    const pinned = isSessionPinned(session);
    const isHovered = hoveredRecentSessionId === session.id;

    const relativeTime = (() => {
      const ts = new Date(session.updatedAt ?? session.createdAt).getTime();
      const diffMs = Date.now() - ts;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      const diffWeeks = Math.floor(diffDays / 7);
      if (diffMins < 1) return t('common:justNow', '刚刚');
      if (diffMins < 60) return t('common:minutesAgo', '{{count}}分钟', { count: diffMins });
      if (diffHours < 24) return t('common:hoursAgo', '{{count}}小时', { count: diffHours });
      if (diffDays < 7) return t('common:daysAgo', '{{count}}天', { count: diffDays });
      if (diffWeeks < 5) return t('common:weeksAgo', '{{count}}周', { count: diffWeeks });
      return new Date(ts).toLocaleDateString();
    })();

    return (
      <div
        key={session.id}
        className="group/thread-row relative"
        onMouseEnter={() => setHoveredRecentSessionId(session.id)}
        onMouseLeave={() => {
          setHoveredRecentSessionId((current) => (current === session.id ? null : current));
          setConfirmingArchiveSessionId((current) => (current === session.id ? null : current));
        }}
      >
        <AppMenu
          mode="context"
          className="flex w-full"
          open={openRecentSessionMenuId === session.id}
          onOpenChange={(open) => {
            setOpenRecentSessionMenuId((current) => {
              if (open) return session.id;
              return current === session.id ? null : current;
            });
          }}
        >
          <AppMenuTrigger asChild>
            <SidebarRow
              rowType="thread"
              onClick={() => handleRecentSessionOpen(session.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              aria-label={sessionTitle}
              aria-current={isActive ? 'page' : undefined}
              tabIndex={collapsed ? -1 : undefined}
              isActive={isActive}
              leftSlot={isHovered ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={pinned ? '取消置顶会话' : '置顶会话'}
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-sm text-[color:var(--shell-navigation-muted)] transition-colors hover:text-[color:var(--shell-navigation-foreground)]',
                    pinned && 'text-[color:var(--shell-navigation-foreground)]'
                  )}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmingArchiveSessionId(null);
                    void handleRecentSessionPinToggle(session);
                  }}
                >
                  <Pin data-testid="recent-session-pin-icon" className="h-3.5 w-3.5" />
                </span>
              ) : pinned ? (
                <Pin data-testid="recent-session-pin-icon" className="h-3.5 w-3.5 text-[color:var(--shell-navigation-foreground)]" />
              ) : undefined}
              rightSlot={isHovered ? (
                confirmingArchiveSessionId === session.id ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="确认归档会话"
                    className="flex h-5 min-w-[20px] items-center justify-center rounded-md bg-red-500/14 px-1 text-red-600 transition-colors hover:bg-red-500/20"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenRecentSessionMenuId(null);
                      void handleRecentSessionArchive(session.id);
                    }}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="归档会话"
                    className="flex h-4 w-4 items-center justify-center rounded-sm text-[color:var(--shell-navigation-muted)] transition-colors hover:text-red-600"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenRecentSessionMenuId(null);
                      setConfirmingArchiveSessionId(session.id);
                    }}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </span>
                )
              ) : (
                <span className="ml-1 shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--shell-navigation-muted)]">
                  {relativeTime}
                </span>
              )}
            >
              <SidebarRowLabel>{sessionTitle}</SidebarRowLabel>
            </SidebarRow>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={180}>
            <AppMenuGroup>
              <AppMenuItem
                icon={<Edit2 className="h-4 w-4" />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  dispatchRecentSessionAction('rename-session', session);
                }}
              >
                重命名会话
              </AppMenuItem>
              <AppMenuItem
                icon={<Pin className="h-4 w-4" />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  void handleRecentSessionPinToggle(session);
                }}
              >
                {pinned ? t('chatV2:page.unpinSession', '取消置顶') : t('chatV2:page.pinSession', '置顶线程')}
              </AppMenuItem>
              <AppMenuItem
                icon={<Archive className="h-4 w-4" />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  void handleRecentSessionArchive(session.id);
                }}
              >
                {t('chatV2:page.archiveSession', '归档线程')}
              </AppMenuItem>
            </AppMenuGroup>
          </AppMenuContent>
        </AppMenu>

      </div>
    );
  }, [confirmingArchiveSessionId, currentView, dispatchRecentSessionAction, handleRecentSessionArchive, handleRecentSessionOpen, handleRecentSessionPinToggle, hoveredRecentSessionId, openRecentSessionMenuId, t]);

  const pinnedRecentSessions = useMemo(
    () => sortSessionsByUpdatedAt(recentSessions.filter((session) => isSessionPinned(session))),
    [recentSessions]
  );

  const recentSessionGroups = useMemo<RecentSessionGroup[]>(() => {
    const sessionsByGroup = new Map<string, ChatSession[]>();
    const groupLookup = new Map(recentGroups.map((group) => [group.id, group]));
    const ungroupedSessions: ChatSession[] = [];

    recentSessions.forEach((session) => {
      if (isSessionPinned(session)) {
        return;
      }

      if (session.groupId && groupLookup.has(session.groupId)) {
        const groupSessions = sessionsByGroup.get(session.groupId) ?? [];
        groupSessions.push(session);
        sessionsByGroup.set(session.groupId, groupSessions);
        return;
      }
      ungroupedSessions.push(session);
    });

    const groupedSections: RecentSessionGroup[] = recentGroups
      .map((group) => ({
        id: group.id,
        label: group.name,
        icon: group.icon,
        sessions: sortSessionsByUpdatedAt(sessionsByGroup.get(group.id) ?? []),
      }));

    if (ungroupedSessions.length > 0) {
      groupedSections.push({
        id: UNGROUPED_RECENT_GROUP_ID,
        label: t('chatV2:browser.ungrouped', '未分组'),
        sessions: sortSessionsByUpdatedAt(ungroupedSessions),
        isUngrouped: true,
      });
    }

    return groupedSections;
  }, [recentGroups, recentSessions, t]);

  const areAllRecentGroupsExpanded = useMemo(
    () => recentSessionGroups.length > 0 && recentSessionGroups.every((group) => !collapsedRecentGroupIds.has(group.id)),
    [collapsedRecentGroupIds, recentSessionGroups]
  );

  const handleToggleAllRecentGroups = useCallback(() => {
    if (recentSessionGroups.length === 0) {
      return;
    }

    setCollapsedRecentGroupIds(
      areAllRecentGroupsExpanded
        ? new Set(recentSessionGroups.map((group) => group.id))
        : new Set()
    );
  }, [areAllRecentGroupsExpanded, recentSessionGroups]);

  const renderRecentGroupIcon = useCallback((group: RecentSessionGroup) => {
    if (!group.icon || group.isUngrouped) {
      return <Folder className="size-[16px]" strokeWidth={2} />;
    }

    const PresetIcon = RECENT_GROUP_PRESET_ICONS[group.icon];
    if (PresetIcon) {
      const Icon = PresetIcon;
      return <Icon className="size-[16px]" strokeWidth={2} />;
    }

    return (
      <span aria-hidden="true" className="text-sm leading-none">
        {group.icon}
      </span>
    );
  }, []);

  const renderRecentGroup = useCallback((group: RecentSessionGroup) => {
    const isExpanded = !collapsedRecentGroupIds.has(group.id);
    const isActive = false;
    const sessionGroup = !group.isUngrouped ? recentGroups.find(g => g.id === group.id) : null;

    const sessionList = (
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
          isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div
          aria-hidden={!isExpanded}
          className={cn(
            'space-y-0.5 overflow-hidden',
            !isExpanded && 'pointer-events-none'
          )}
          role="list"
        >
          {group.sessions.map((session) => renderRecentSessionRow(session, !isExpanded))}
        </div>
      </div>
    );

    if (sessionGroup) {
      return (
        <section key={group.id} className="space-y-0.5">
          <SessionGroupActions
            group={sessionGroup}
            labels={{
              groupActions: t('chatV2:page.groupActions', 'Group Actions'),
              newSession: t('chatV2:page.newSession', 'New Session'),
              renameGroup: t('chatV2:page.renameGroup', 'Rename Group'),
              editGroup: t('chatV2:page.editGroup', 'Edit Group'),
              deleteGroup: t('chatV2:page.deleteGroup', 'Delete Group'),
            }}
            onCreateSession={(groupId) => {
              window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
                detail: { action: 'create-session', groupId }
              }));
            }}
            onRenameGroup={(g) => {
              handleViewChange('chat-v2');
              requestAnimationFrame(() => {
                window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
                  detail: { action: 'rename-group', group: g }
                }));
              });
            }}
            onEditGroup={(g) => {
              handleViewChange('chat-v2');
              requestAnimationFrame(() => {
                window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
                  detail: { action: 'edit-group', group: g }
                }));
              });
            }}
            onDeleteGroup={(g) => {
              window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
                detail: { action: 'delete-group', group: g }
              }));
            }}
          >
            {({ quickAction, onContextMenu }) => (
              <SidebarRow
                rowType="nav"
                onClick={() => toggleRecentGroup(group.id)}
                onContextMenu={onContextMenu}
                onDragEnd={clearRecentGroupDragState}
                onDragOver={(event) => handleRecentGroupDragOver(event, group.id)}
                onDragStart={(event) => handleRecentGroupDragStart(event, group.id)}
                onDrop={(event) => void handleRecentGroupDrop(event, group.id)}
                aria-label={group.label}
                aria-expanded={isExpanded}
                aria-grabbed={draggedRecentGroupId === group.id}
                draggable
                isActive={isActive}
                className={cn(
                  'group/sidebar-section select-none',
                  draggedRecentGroupId === group.id && 'cursor-grabbing opacity-60',
                  dragOverRecentGroupId === group.id && draggedRecentGroupId !== group.id && 'bg-[color:var(--sidebar-quiet-hover)] ring-1 ring-black/8'
                )}
                leftSlot={renderRecentGroupIcon(group)}
                rightSlot={quickAction}
              >
                <SidebarRowLabel>{group.label}</SidebarRowLabel>
              </SidebarRow>
            )}
          </SessionGroupActions>
          {sessionList}
        </section>
      );
    }

    return (
      <section key={group.id} className="space-y-0.5">
        <SidebarRow
          rowType="nav"
          onClick={() => toggleRecentGroup(group.id)}
          aria-label={group.label}
          aria-expanded={isExpanded}
          isActive={isActive}
          className="select-none"
          leftSlot={renderRecentGroupIcon(group)}
          rightSlot={
            <span className="flex shrink-0 items-center justify-center text-[color:var(--shell-navigation-muted)]">
              <ChevronRight
                className={cn(
                  'size-3 transition-transform duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90'
                )}
                strokeWidth={2.25}
              />
            </span>
          }
        >
          <SidebarRowLabel>{group.label}</SidebarRowLabel>
        </SidebarRow>
        {sessionList}
      </section>
    );
  }, [clearRecentGroupDragState, collapsedRecentGroupIds, dragOverRecentGroupId, draggedRecentGroupId, handleRecentGroupDragOver, handleRecentGroupDragStart, handleRecentGroupDrop, handleViewChange, recentGroups, renderRecentGroupIcon, renderRecentSessionRow, t, toggleRecentGroup]);

  return (
    <aside
      role="navigation"
      aria-label={t('sidebar:aria.sidebar_navigation', '主导航')}
      data-shell-layer="navigation"
      data-shell-surface="navigation"
      className="font-sidebar-study-ui relative z-20 flex h-full w-full min-w-0 flex-col bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)] transition-colors duration-500"
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

          {pinnedRecentSessions.length > 0 ? (
            <section className="space-y-0.5 pt-1">
              <nav aria-label={t('sidebar:aria.pinned_sessions', '置顶会话')}>
                <div className="space-y-0.5" role="list">
                  {pinnedRecentSessions.map((session) => renderRecentSessionRow(session))}
                </div>
              </nav>
            </section>
          ) : null}

          {recentSessionGroups.length > 0 ? (
            <section className="space-y-0.5 pt-1">
              <div className="flex items-center justify-between gap-2 px-3">
                <p className="desktop-shell-nav-section-label">
                  {t('sidebar:sections.recent', '最近')}
                </p>
                <div className="flex items-center gap-1">
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    aria-label={areAllRecentGroupsExpanded
                      ? t('sidebar:actions.collapse_all_recent_sessions', '收起所有会话')
                      : t('sidebar:actions.expand_all_recent_sessions', '展开所有会话')}
                    title={areAllRecentGroupsExpanded
                      ? t('sidebar:actions.collapse_all_recent_sessions', '收起所有会话')
                      : t('sidebar:actions.expand_all_recent_sessions', '展开所有会话')}
                    className="!h-6 !w-6 text-[color:var(--shell-navigation-muted)]"
                    onClick={handleToggleAllRecentGroups}
                  >
                    {areAllRecentGroupsExpanded ? (
                      <ChevronsUp className="size-3.5" strokeWidth={2} />
                    ) : (
                      <ChevronsDown className="size-3.5" strokeWidth={2} />
                    )}
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    aria-label={t('sidebar:actions.create_recent_group', '新建文件夹')}
                    title={t('sidebar:actions.create_recent_group', '新建文件夹')}
                    className="!h-6 !w-6 text-[color:var(--shell-navigation-muted)]"
                    onClick={handleCreateRecentGroup}
                  >
                    <FolderPlus className="size-3.5" strokeWidth={2} />
                  </NotionButton>
                </div>
              </div>
              <nav aria-label={t('sidebar:aria.recent_sessions', '最近会话')}>
                <div className="space-y-0.5" role="list">
                  {recentSessionGroups.map((group) => renderRecentGroup(group))}
                </div>
              </nav>
            </section>
          ) : null}
        </div>
      </CustomScrollArea>

      <div className="mt-auto px-2 pb-3 pt-1" data-no-drag>
        <div className="relative flex justify-start">
          <SidebarRow
            rowType="nav"
            onClick={() => handleViewChange('settings')}
            aria-label={t('sidebar:navigation.settings', '设置')}
            aria-current={currentView === 'settings' ? 'page' : undefined}
            isActive={currentView === 'settings'}
            data-tour-id="nav-settings"
            leftSlot={<StudySettingsIcon className="size-[18px]" strokeWidth={2} />}
          >
            <SidebarRowLabel>{t('sidebar:navigation.settings', '设置')}</SidebarRowLabel>
          </SidebarRow>

          {shouldShowUpdateBadge ? (
            <button
              type="button"
              data-slot="sidebar-update-badge"
              className="desktop-shell-update-badge absolute right-2 top-1 inline-flex h-5 min-w-8 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-medium leading-none text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
              onClick={(event) => {
                event.stopPropagation();
                void updater.performUpdateAction();
              }}
              aria-label={updater?.downloading ? t('sidebar:update.downloading', '下载中...') : t('sidebar:update.available', '点击更新')}
              disabled={updater?.downloading}
            >
              {updater?.downloading ? t('sidebar:update.short_downloading', '下载中') : t('sidebar:update.short', '更新')}
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
};
