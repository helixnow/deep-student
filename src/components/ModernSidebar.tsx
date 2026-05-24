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
  CaretDoubleDown,
  CaretDoubleUp,
  CaretRight,
  Code,
  FileText,
  Flask,
  Folder,
  FolderPlus,
  FolderOpen,
  Globe,
  GraduationCap,
  Heart,
  Translate,
  Lightbulb,
  CircleNotch,
  Chat,
  MusicNote,
  Palette,
  PencilSimple,
  PushPin,
  Rocket,
  Sparkle,
  Star,
  Target,
  Trophy,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { createNavItems } from '../config/navigation';
import { useIsUILabEnabled } from '../utils/uiLabToggle';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  NotionDialog,
  NotionDialogBody,
  NotionDialogFooter,
  NotionDialogHeader,
  NotionDialogTitle,
} from '@/components/ui/NotionDialog';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Input } from '@/components/ui/shad/Input';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { ChatSession } from '@/features/chat/types/session';
import type { SessionGroup } from '@/features/chat/types/group';
import { buildPinnedSessionMetadata, isSessionPinned } from '@/features/chat/utils/sessionPin';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import { SessionGroupActions } from '@/features/chat/pages/SessionGroupActions';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { AppUpdaterController } from '@/hooks/useAppUpdater';
import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { StudyComposeIcon, StudySettingsIcon } from './icons/StudySidebarIcons';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { formatShortcut } from '@/command-palette/registry/shortcutUtils';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { showArchiveSessionToast } from '@/features/chat/utils/archiveSessionToast';
import {
  markSessionSidebarIndicatorSeen,
  useSessionSidebarIndicators,
} from '@/features/chat/hooks/useSessionSidebarIndicators';
import { isMacOS, isMobilePlatform } from '@/utils/platform';

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

type SidebarSectionId = 'pinned' | 'topics' | 'conversations';
const SIDEBAR_SESSION_PREVIEW_LIMIT = 5;

interface RecentSessionGroup {
  id: string;
  label: string;
  icon?: string;
  sessions: ChatSession[];
}

const RECENT_GROUP_PRESET_ICONS: Record<string, Icon> = {
  folder: Folder,
  'folder-open': FolderOpen,
  star: Star,
  heart: Heart,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  code: Code,
  calculator: Calculator,
  flask: Flask,
  atom: Atom,
  globe: Globe,
  languages: Translate,
  music: MusicNote,
  palette: Palette,
  camera: Camera,
  lightbulb: Lightbulb,
  target: Target,
  trophy: Trophy,
  rocket: Rocket,
  brain: Brain,
  sparkles: Sparkle,
  'message-square': Chat,
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
    const pinDelta = Number(isSessionGroupPinned(right)) - Number(isSessionGroupPinned(left));
    if (pinDelta !== 0) {
      return pinDelta;
    }
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  });
}

function isSessionGroupPinned(group: Pick<SessionGroup, 'sortOrder'>): boolean {
  return group.sortOrder < 0;
}

function getNextPinnedGroupSortOrder(groups: SessionGroup[], groupId: string): number {
  const pinnedSortOrders = groups
    .filter((group) => group.id !== groupId && isSessionGroupPinned(group))
    .map((group) => group.sortOrder);

  return Math.min(0, ...pinnedSortOrders) - 1;
}

function getNextUnpinnedGroupSortOrder(groups: SessionGroup[], groupId: string): number {
  const unpinnedSortOrders = groups
    .filter((group) => group.id !== groupId && !isSessionGroupPinned(group))
    .map((group) => group.sortOrder);

  return Math.max(0, ...unpinnedSortOrders) + 1;
}

function isChatSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatSession>;
  return typeof candidate.id === 'string' && typeof candidate.mode === 'string';
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
    <span className="desktop-shell-sidebar-row-title block min-w-0 flex-1 truncate leading-4">
      {children}
    </span>
  );
}

function NewSessionShortcutHint({ shortcut }: { shortcut: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="hidden shrink-0 items-center rounded-md border border-black/10 bg-white/55 px-1.5 py-0.5 text-[10px] font-medium leading-none text-[color:var(--shell-navigation-muted)] opacity-0 transition-opacity duration-150 ease-out group-hover/new-session-action:opacity-100 group-focus-visible/new-session-action:opacity-100 motion-reduce:transition-none dark:border-white/10 dark:bg-white/5 lg:inline-flex"
    >
      {shortcut}
    </kbd>
  );
}

function isFinePointerDesktopSurface(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  return window.matchMedia('(pointer: fine)').matches;
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

function SidebarSessionOverflowToggle({
  label,
  onClick,
}: {
  label: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    // Explicitly plain text: no icon, no hover visual treatment.
    // eslint-disable-next-line ds-components/no-native-button
    <button
      type="button"
      aria-label={label}
      className="sidebar-session-toggle block w-full cursor-default appearance-none border-0 bg-transparent py-1 pl-9 pr-2.5 text-left text-[12px] font-normal leading-none text-[color:var(--shell-navigation-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const SIDEBAR_STREAMING_RING_RADIUS = 6.75;
const SIDEBAR_STREAMING_RING_CIRCUMFERENCE = 2 * Math.PI * SIDEBAR_STREAMING_RING_RADIUS;
const SIDEBAR_STREAMING_RING_DASH = SIDEBAR_STREAMING_RING_CIRCUMFERENCE * 0.34;
const SIDEBAR_STREAMING_RING_GAP = SIDEBAR_STREAMING_RING_CIRCUMFERENCE - SIDEBAR_STREAMING_RING_DASH;
const SIDEBAR_STREAMING_RING_TRACK = 'color-mix(in oklab, var(--shell-navigation-foreground) 14%, transparent)';
const SIDEBAR_STREAMING_RING_FOREGROUND = 'var(--shell-navigation-foreground)';

function SidebarStreamingIndicator() {
  return (
    <span
      data-testid="sidebar-streaming-indicator"
 className="w-3.5 h-3.5 inline-flex items-center justify-center"
      aria-hidden="true"
    >
      <svg
 className="w-3.5 h-3.5 animate-[spin_1.1s_linear_infinite] rounded-full"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle
          cx="8"
          cy="8"
          r={SIDEBAR_STREAMING_RING_RADIUS}
          stroke={SIDEBAR_STREAMING_RING_TRACK}
          strokeWidth="2.5"
/>
        <circle
          cx="8"
          cy="8"
          r={SIDEBAR_STREAMING_RING_RADIUS}
          stroke={SIDEBAR_STREAMING_RING_FOREGROUND}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${SIDEBAR_STREAMING_RING_DASH} ${SIDEBAR_STREAMING_RING_GAP}`}
          transform="rotate(-90 8 8)"
/>
      </svg>
    </span>
  );
}

function SidebarUnreadReplyDot() {
  return (
    <span
      data-testid="sidebar-unread-indicator"
 className="w-4 h-4 inline-flex items-center justify-center"
      aria-hidden="true"
    >
      <span className="h-2 w-2 rounded-full bg-[hsl(var(--ring))]" />
    </span>
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
  const [expandedRecentGroupSessionIds, setExpandedRecentGroupSessionIds] = useState<Set<string>>(() => new Set());
  const [conversationSessionsExpanded, setConversationSessionsExpanded] = useState(false);
  const [collapsedSidebarSectionIds, setCollapsedSidebarSectionIds] = useState<Set<SidebarSectionId>>(() => new Set());
  const [draggedRecentGroupId, setDraggedRecentGroupId] = useState<string | null>(null);
  const [dragOverRecentGroupId, setDragOverRecentGroupId] = useState<string | null>(null);
  const [hoveredRecentSessionId, setHoveredRecentSessionId] = useState<string | null>(null);
  const [openRecentSessionMenuId, setOpenRecentSessionMenuId] = useState<string | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = useState<string | null>(null);
  const [editingRecentSessionId, setEditingRecentSessionId] = useState<string | null>(null);
  const [editingRecentSessionTitle, setEditingRecentSessionTitle] = useState('');
  const [renamingRecentSessionId, setRenamingRecentSessionId] = useState<string | null>(null);
  const [recentRenameError, setRecentRenameError] = useState<string | null>(null);
  const draggedRecentGroupIdRef = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return sessionManager.getCurrentSessionId() || localStorage.getItem('chat-v2-last-session-id');
    } catch {
      return sessionManager.getCurrentSessionId();
    }
  });
  const streamingSessionIds = useSessionSidebarIndicators((state) => state.streamingSessionIds);
  const unreadSessionIds = useSessionSidebarIndicators((state) => state.unreadSessionIds);
  const streamingSessionIdSet = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  const uiLabEnabled = useIsUILabEnabled();
  const navItems = useMemo(() => createNavItems(t, uiLabEnabled), [t, uiLabEnabled]);
  const primaryItems = useMemo(
    () =>
      navItems.filter((item) =>
        ['chat-v2', 'learning-hub', 'todo', 'skills-management', 'task-dashboard', 'template-management', 'ui-lab'].includes(item.view)
      ),
    [navItems]
  );
  const chatNavLabel = t('sidebar:navigation.chat_v2', '新会话');
  const shouldShowMacDesktopNewSessionShortcut = useMemo(
    () => isMacOS() && !isMobilePlatform() && isFinePointerDesktopSurface(),
    []
  );
  const newSessionShortcutLabel = useMemo(() => formatShortcut('mod+n'), []);
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
    markSessionSidebarIndicatorSeen(sessionId);
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

  const startRecentSessionRename = useCallback((session: ChatSession) => {
    setOpenRecentSessionMenuId(null);
    setConfirmingArchiveSessionId(null);
    setRecentRenameError(null);
    setEditingRecentSessionId(session.id);
    setEditingRecentSessionTitle(getSessionTitleText(session.title, ''));
  }, []);

  const cancelRecentSessionRename = useCallback(() => {
    setRenamingRecentSessionId(null);
    setRecentRenameError(null);
    setEditingRecentSessionId(null);
    setEditingRecentSessionTitle('');
  }, []);

  const handleRecentRenameDialogOpenChange = useCallback((open: boolean) => {
    if (!open && !renamingRecentSessionId) {
      cancelRecentSessionRename();
    }
  }, [cancelRecentSessionRename, renamingRecentSessionId]);

  const saveRecentSessionRename = useCallback(async (sessionId: string) => {
    const trimmedTitle = editingRecentSessionTitle.trim();
    if (!trimmedTitle) {
      setRecentRenameError(t('chatV2:page.renameEmptyError', '会话名称不能为空'));
      return;
    }

    const currentSession = recentSessions.find((session) => session.id === sessionId);
    const currentTitle = getSessionTitleText(currentSession?.title, '');
    if (currentTitle === trimmedTitle) {
      cancelRecentSessionRename();
      return;
    }

    try {
      setRecentRenameError(null);
      setRenamingRecentSessionId(sessionId);
      const updatedSession = await invoke<ChatSession | null>('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: trimmedTitle },
      });

      setRecentSessions((previous) =>
        sortSessionsByUpdatedAt(
          previous.map((item) => {
            if (item.id !== sessionId) return item;
            return isChatSession(updatedSession)
              ? { ...item, ...updatedSession, title: trimmedTitle }
              : { ...item, title: trimmedTitle };
          })
        )
      );

      sessionManager.get(sessionId)?.setState({ title: trimmedTitle });
      cancelRecentSessionRename();
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to rename recent session:', error);
      setRecentRenameError(t('chatV2:page.renameFailed', '重命名失败'));
    } finally {
      setRenamingRecentSessionId(null);
    }
  }, [cancelRecentSessionRename, editingRecentSessionTitle, recentSessions, t]);

  const handleRecentSessionArchive = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_archive_session', { sessionId });
      setRecentSessions((previous) => previous.filter((item) => item.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
      setConfirmingArchiveSessionId((current) => (current === sessionId ? null : current));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      showArchiveSessionToast(t, 'chatV2');
    } catch (error) {
      console.warn('[ModernSidebar] Failed to archive recent session:', error);
      void loadSidebarData();
    }
  }, [activeSessionId, loadSidebarData, t]);

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

  const toggleRecentGroupSessions = useCallback((groupId: string) => {
    setExpandedRecentGroupSessionIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleSidebarSection = useCallback((sectionId: SidebarSectionId) => {
    setCollapsedSidebarSectionIds((previous) => {
      const next = new Set(previous);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const handleCreateRecentGroup = useCallback(() => {
    window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
      detail: { action: 'create-group' },
    }));
  }, []);

  const handleRecentGroupPinToggle = useCallback(async (group: SessionGroup, pinned: boolean) => {
    const nextSortOrder = pinned
      ? getNextPinnedGroupSortOrder(recentGroups, group.id)
      : getNextUnpinnedGroupSortOrder(recentGroups, group.id);

    try {
      const updatedGroup = await invoke<SessionGroup | null>('chat_v2_update_group', {
        groupId: group.id,
        request: { sortOrder: nextSortOrder },
      });

      setRecentGroups((previous) =>
        sortGroups(
          previous.map((item) => {
            if (item.id !== group.id) return item;
            return isSessionGroup(updatedGroup)
              ? updatedGroup
              : { ...item, sortOrder: nextSortOrder };
          })
        )
      );
      window.dispatchEvent(new CustomEvent('chat-v2:groups-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to toggle recent group pin:', error);
      void loadSidebarData();
    }
  }, [loadSidebarData, recentGroups]);

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
    const isNewSessionAction = view === 'chat-v2';
    const isActive = !isNewSessionAction && currentView === view;
    const handleClick = () => {
      if (view === 'chat-v2') {
        if (currentView !== 'chat-v2') {
          handleViewChange('chat-v2');
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));
          });
          return;
        }

        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));
        return;
      }

      handleViewChange(view);
    };

    return (
      <SidebarRow
        key={view}
        rowType="nav"
        onClick={handleClick}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        isActive={isActive}
        className={isNewSessionAction ? 'group/new-session-action' : undefined}
        data-tour-id={`nav-${view}`}
        leftSlot={<Icon className="size-[18px]" strokeWidth={2} />}
        rightSlot={isNewSessionAction && shouldShowMacDesktopNewSessionShortcut ? (
          <NewSessionShortcutHint shortcut={newSessionShortcutLabel} />
        ) : undefined}
      >
        <SidebarRowLabel>{label}</SidebarRowLabel>
      </SidebarRow>
    );
  }, [currentView, handleViewChange, newSessionShortcutLabel, shouldShowMacDesktopNewSessionShortcut]);

  const renderRecentSessionRow = useCallback((session: ChatSession, collapsed = false) => {
    const isActive = currentView === 'chat-v2' && activeSessionId === session.id;
    const sessionTitle = getSessionTitleText(session.title, t('chatV2:page.untitled', '未命名对话'));
    const pinned = isSessionPinned(session);
    const isHovered = hoveredRecentSessionId === session.id;
    const isSessionStreaming = streamingSessionIdSet.has(session.id);
    const hasUnreadAssistantReply = unreadSessionIdSet.has(session.id);
    const isConfirmingArchive = confirmingArchiveSessionId === session.id;

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
                  <PushPin data-testid="recent-session-pin-icon" size={14} />
                </span>
              ) : pinned ? (
                <PushPin data-testid="recent-session-pin-icon" size={14} className="text-[color:var(--shell-navigation-foreground)]" />
              ) : undefined}
              rightSlot={isSessionStreaming ? (
                <SidebarStreamingIndicator />
              ) : hasUnreadAssistantReply ? (
                <SidebarUnreadReplyDot />
              ) : isHovered ? (
                <CommonTooltip content={isConfirmingArchive ? '确认归档会话' : '归档会话'} position="right">
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={isConfirmingArchive ? '确认归档会话' : '归档会话'}
                    className={cn(
                      'flex h-5 min-w-[20px] items-center justify-center rounded-md px-1 transition-colors',
                      isConfirmingArchive
                        ? 'bg-red-500/14 text-red-600 hover:bg-red-500/20'
                        : 'text-[color:var(--shell-navigation-muted)] hover:text-red-600'
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenRecentSessionMenuId(null);
                      if (isConfirmingArchive) {
                        void handleRecentSessionArchive(session.id);
                        return;
                      }

                      setConfirmingArchiveSessionId(session.id);
                    }}
                  >
                    <span className="w-3.5 h-3.5 t-icon-swap" data-state={isConfirmingArchive ? 'b' : 'a'}>
                      <span className="w-3.5 h-3.5 t-icon flex items-center justify-center" data-icon="a">
                        <Archive size={14} />
                      </span>
                      <span className="w-3.5 h-3.5 t-icon flex items-center justify-center" data-icon="b">
                        <Check size={14} />
                      </span>
                    </span>
                  </span>
                </CommonTooltip>
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
                icon={<PencilSimple size={16} />}
                onClick={() => {
                  startRecentSessionRename(session);
                }}
              >
                重命名会话
              </AppMenuItem>
              <AppMenuItem
                icon={<PushPin size={16} />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  void handleRecentSessionPinToggle(session);
                }}
              >
                {pinned ? t('chatV2:page.unpinSession', '取消置顶') : t('chatV2:page.pinSession', '置顶线程')}
              </AppMenuItem>
              <AppMenuItem
                icon={<Archive size={16} />}
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
  }, [activeSessionId, confirmingArchiveSessionId, currentView, handleRecentSessionArchive, handleRecentSessionOpen, handleRecentSessionPinToggle, hoveredRecentSessionId, openRecentSessionMenuId, startRecentSessionRename, streamingSessionIdSet, t, unreadSessionIdSet]);

  const pinnedRecentSessions = useMemo(
    () => sortSessionsByUpdatedAt(recentSessions.filter((session) => isSessionPinned(session))),
    [recentSessions]
  );

  const {
    pinnedRecentGroups,
    topicSessionGroups,
    conversationSessions,
  } = useMemo<{ pinnedRecentGroups: RecentSessionGroup[]; topicSessionGroups: RecentSessionGroup[]; conversationSessions: ChatSession[] }>(() => {
    const sessionsByGroup = new Map<string, ChatSession[]>();
    const groupLookup = new Map(recentGroups.map((group) => [group.id, group]));
    const looseSessions: ChatSession[] = [];

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
      looseSessions.push(session);
    });

    const toRecentGroupSection = (group: SessionGroup): RecentSessionGroup => ({
      id: group.id,
      label: group.name,
      icon: group.icon,
      sessions: sortSessionsByUpdatedAt(sessionsByGroup.get(group.id) ?? []),
    });

    const pinnedGroups = recentGroups
      .filter(isSessionGroupPinned)
      .map(toRecentGroupSection);

    const topicGroups: RecentSessionGroup[] = recentGroups
      .filter((group) => !isSessionGroupPinned(group))
      .map(toRecentGroupSection);

    return {
      pinnedRecentGroups: pinnedGroups,
      topicSessionGroups: topicGroups,
      conversationSessions: sortSessionsByUpdatedAt(looseSessions),
    };
  }, [recentGroups, recentSessions]);

  const areAllTopicGroupsExpanded = useMemo(
    () => topicSessionGroups.length > 0 && topicSessionGroups.every((group) => !collapsedRecentGroupIds.has(group.id)),
    [collapsedRecentGroupIds, topicSessionGroups]
  );

  const handleToggleAllTopicGroups = useCallback(() => {
    if (topicSessionGroups.length === 0) {
      return;
    }

    setCollapsedRecentGroupIds(
      areAllTopicGroupsExpanded
        ? new Set(topicSessionGroups.map((group) => group.id))
        : new Set()
    );
  }, [areAllTopicGroupsExpanded, topicSessionGroups]);

  const renderRecentGroupIcon = useCallback((group: RecentSessionGroup) => {
    if (!group.icon) {
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
    const sessionGroup = recentGroups.find(g => g.id === group.id);
    if (!sessionGroup) {
      return null;
    }
    const isPinnedGroup = isSessionGroupPinned(sessionGroup);
    const isSessionListExpanded = expandedRecentGroupSessionIds.has(group.id);
    const hasSessionOverflow = group.sessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT;
    const visibleSessions = hasSessionOverflow && !isSessionListExpanded
      ? group.sessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT)
      : group.sessions;
    const sessionOverflowLabel = isSessionListExpanded
      ? t('sidebar:actions.collapse_group_sessions', '折叠显示')
      : t('sidebar:actions.expand_group_sessions', '展开显示');

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
            'space-y-0.5 overflow-hidden pl-4',
            !isExpanded && 'pointer-events-none'
          )}
          role="list"
        >
          {group.sessions.length > 0 ? (
            <>
              {visibleSessions.map((session) => renderRecentSessionRow(session, !isExpanded))}
              {hasSessionOverflow ? (
                <SidebarSessionOverflowToggle
                  label={sessionOverflowLabel}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleRecentGroupSessions(group.id);
                  }}
/>
              ) : null}
            </>
          ) : (
            <div className="px-2 py-1.5 text-xs text-[color:var(--shell-navigation-muted)] opacity-70">
              {t('sidebar:sections.emptyGroup', '暂无对话')}
            </div>
          )}
        </div>
      </div>
    );

    return (
      <section key={group.id} className="space-y-0.5">
        <SessionGroupActions
          group={sessionGroup}
          labels={{
            groupActions: t('chatV2:page.groupActions', 'Group Actions'),
            newSession: t('chatV2:page.newSession', 'New Session'),
            newSessionInGroup: t('chatV2:page.newSessionInGroup', {
              groupName: sessionGroup.name,
              defaultValue: '在 {{groupName}} 中新建会话',
            }),
            pinGroup: t('chatV2:page.pinGroup', '置顶分组'),
            unpinGroup: t('chatV2:page.unpinGroup', '取消置顶分组'),
            renameGroup: t('chatV2:page.renameGroup', 'Rename Group'),
            editGroup: t('chatV2:page.editGroup', 'Edit Group'),
            archiveGroup: t('chatV2:page.archiveGroup', 'Archive Group'),
          }}
          isPinned={isPinnedGroup}
          onCreateSession={(groupId) => {
            window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
              detail: { action: 'create-session', groupId }
            }));
          }}
          onTogglePinGroup={(g, pinned) => {
            void handleRecentGroupPinToggle(g, pinned);
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
          onArchiveGroup={(g) => {
            window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
              detail: { action: 'archive-group', group: g }
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
              draggable={!isPinnedGroup}
              isActive={isActive}
              className={cn(
                'group/sidebar-section select-none',
                draggedRecentGroupId === group.id && 'cursor-grabbing opacity-60',
                dragOverRecentGroupId === group.id && draggedRecentGroupId !== group.id && 'bg-[color:var(--sidebar-quiet-hover)] ring-1 ring-black/8'
              )}
              leftSlot={renderRecentGroupIcon(group)}
              rightSlot={
                <span className="flex shrink-0 items-center gap-1.5 text-[color:var(--shell-navigation-muted)]">
                  {quickAction}
                </span>
              }
            >
              <SidebarRowLabel>{group.label}</SidebarRowLabel>
            </SidebarRow>
          )}
        </SessionGroupActions>
        {sessionList}
      </section>
    );
  }, [clearRecentGroupDragState, collapsedRecentGroupIds, dragOverRecentGroupId, draggedRecentGroupId, expandedRecentGroupSessionIds, handleRecentGroupDragOver, handleRecentGroupDragStart, handleRecentGroupDrop, handleRecentGroupPinToggle, handleViewChange, recentGroups, renderRecentGroupIcon, renderRecentSessionRow, t, toggleRecentGroup, toggleRecentGroupSessions]);

  const hasPinnedContent = pinnedRecentGroups.length > 0 || pinnedRecentSessions.length > 0;
  const isPinnedSectionCollapsed = collapsedSidebarSectionIds.has('pinned');
  const isTopicsSectionCollapsed = collapsedSidebarSectionIds.has('topics');
  const isConversationsSectionCollapsed = collapsedSidebarSectionIds.has('conversations');
  const pinnedSectionLabel = t('sidebar:sections.pinned', '置顶');
  const topicsSectionLabel = t('sidebar:sections.topics', '课题');
  const conversationsSectionLabel = t('sidebar:sections.conversations', '对话');
  const newConversationLabel = t('sidebar:actions.create_conversation', t('chatV2:page.newSession', 'New Session'));
  const toggleAllTopicsLabel = areAllTopicGroupsExpanded
    ? t('sidebar:actions.collapse_all_topics', '收起所有课题')
    : t('sidebar:actions.expand_all_topics', '展开所有课题');
  const createTopicLabel = t('sidebar:actions.create_topic', '新建课题');
  const hasConversationSessionOverflow = conversationSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT;
  const visibleConversationSessions = hasConversationSessionOverflow && !conversationSessionsExpanded
    ? conversationSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT)
    : conversationSessions;
  const conversationSessionOverflowLabel = conversationSessionsExpanded
    ? t('sidebar:actions.collapse_group_sessions', '折叠显示')
    : t('sidebar:actions.expand_group_sessions', '展开显示');

  const renderSidebarSectionHeader = ({
    id,
    label,
    action,
  }: {
    id: SidebarSectionId;
    label: string;
    action?: React.ReactNode;
  }) => {
    const isCollapsed = collapsedSidebarSectionIds.has(id);

    return (
      <div className="group/sidebar-top-section flex items-center justify-between gap-2 px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[color:var(--shell-navigation-muted)] outline-none transition-colors hover:text-[color:var(--shell-navigation-foreground)] focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
          aria-label={label}
          aria-expanded={!isCollapsed}
          onClick={() => toggleSidebarSection(id)}
        >
          <span className="desktop-shell-nav-section-label min-w-0 truncate">
            {label}
          </span>
          <CaretRight
            className={cn(
              'size-3 shrink-0 text-[color:var(--shell-navigation-section-label)] opacity-0 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] group-hover/sidebar-top-section:opacity-100 group-focus-within/sidebar-top-section:opacity-100 motion-reduce:transition-none',
              !isCollapsed && 'rotate-90'
            )}
            strokeWidth={2.25}
/>
        </button>
        {action}
      </div>
    );
  };

  const conversationHeaderAction = (
    <span className="flex shrink-0 items-center gap-1">
      <CommonTooltip content={newConversationLabel} position="right">
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={newConversationLabel}
          className="!h-6 !w-6 text-[color:var(--shell-navigation-muted)]"
          onClick={(event) => {
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
              detail: { action: 'create-session', groupId: null },
            }));
          }}
        >
          <StudyComposeIcon className="w-3.5 h-3.5" />
        </NotionButton>
      </CommonTooltip>
    </span>
  );

  return (
    <>
    <aside
      role="navigation"
      aria-label={t('sidebar:aria.sidebar_navigation', '主导航')}
      data-shell-layer="navigation"
      data-shell-surface="navigation"
      className="font-sidebar-study-ui relative z-20 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)]"
      style={{ paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' }}
    >
      <div
        className="shrink-0 px-2 pb-2 pt-0.5"
        data-no-drag
        data-sidebar-fixed-region="primary-navigation"
      >
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

      <div className="desktop-shell-sidebar-session-scroll-shell min-h-0 flex-1 w-full">
        <CustomScrollArea
          className="desktop-shell-sidebar-session-scroll min-h-0 flex-1 w-full"
          viewportClassName="desktop-shell-sidebar-session-scroll-viewport h-full w-full"
          viewportProps={{
            'data-sidebar-scroll-region': 'sessions',
          } as React.HTMLAttributes<HTMLDivElement>}
        >
          <div
            className="flex flex-col gap-3 px-2 pb-6 pt-4"
            data-no-drag
          >
            {hasPinnedContent ? (
              <section className="space-y-0.5 pt-1">
                {renderSidebarSectionHeader({ id: 'pinned', label: pinnedSectionLabel })}
                {!isPinnedSectionCollapsed ? (
                  <nav aria-label={t('sidebar:aria.pinned_sessions', '置顶会话')}>
                    <div className="space-y-0.5" role="list">
                      {pinnedRecentGroups.map((group) => renderRecentGroup(group))}
                      {pinnedRecentSessions.map((session) => renderRecentSessionRow(session))}
                    </div>
                  </nav>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-0.5 pt-1">
              {renderSidebarSectionHeader({
                id: 'topics',
                label: topicsSectionLabel,
                action: (
                  <div className="flex items-center gap-1">
                    <CommonTooltip content={toggleAllTopicsLabel} position="right">
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        aria-label={toggleAllTopicsLabel}
                        className="!h-6 !w-6 text-[color:var(--shell-navigation-muted)]"
                        onClick={handleToggleAllTopicGroups}
                      >
                        {areAllTopicGroupsExpanded ? (
                          <CaretDoubleUp className="size-3.5" strokeWidth={2} />
                        ) : (
                          <CaretDoubleDown className="size-3.5" strokeWidth={2} />
                        )}
                      </NotionButton>
                    </CommonTooltip>
                    <CommonTooltip content={createTopicLabel} position="right">
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        aria-label={createTopicLabel}
                        className="!h-6 !w-6 text-[color:var(--shell-navigation-muted)]"
                        onClick={handleCreateRecentGroup}
                      >
                        <FolderPlus className="size-3.5" strokeWidth={2} />
                      </NotionButton>
                    </CommonTooltip>
                  </div>
                ),
              })}
              {!isTopicsSectionCollapsed ? (
                <nav aria-label={t('sidebar:aria.topic_sessions', '课题')}>
                  <div className="space-y-0.5" role="list">
                    {topicSessionGroups.map((group) => renderRecentGroup(group))}
                  </div>
                </nav>
              ) : null}
            </section>

            <section className="space-y-0.5 pt-1">
              {renderSidebarSectionHeader({
                id: 'conversations',
                label: conversationsSectionLabel,
                action: conversationHeaderAction,
              })}
            {!isConversationsSectionCollapsed ? (
              <nav aria-label={t('sidebar:aria.conversation_sessions', '对话')}>
                <div className="space-y-0.5" role="list">
                  {visibleConversationSessions.map((session) => renderRecentSessionRow(session))}
                  {hasConversationSessionOverflow ? (
                    <SidebarSessionOverflowToggle
                      label={conversationSessionOverflowLabel}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setConversationSessionsExpanded((expanded) => !expanded);
                      }}
/>
                  ) : null}
                </div>
              </nav>
            ) : null}
            </section>
          </div>
        </CustomScrollArea>
      </div>

      <div className="mt-auto shrink-0 px-2 pb-3 pt-1" data-no-drag>
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

    <NotionDialog
      open={editingRecentSessionId !== null}
      onOpenChange={handleRecentRenameDialogOpenChange}
      closeOnOverlay={false}
      showClose={false}
      maxWidth="max-w-sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (editingRecentSessionId && renamingRecentSessionId !== editingRecentSessionId) {
            void saveRecentSessionRename(editingRecentSessionId);
          }
        }}
      >
        <NotionDialogHeader>
          <NotionDialogTitle>重命名对话</NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody className="py-4">
          <label className="block text-sm font-medium text-foreground" htmlFor="modern-sidebar-rename-session-input">
            对话名称
          </label>
          <Input
            id="modern-sidebar-rename-session-input"
            type="text"
            placeholder={t('chatV2:page.untitled', '未命名对话')}
            value={editingRecentSessionTitle}
            onChange={(event) => {
              setEditingRecentSessionTitle(event.target.value);
              if (recentRenameError) setRecentRenameError(null);
            }}
            autoFocus
            disabled={renamingRecentSessionId !== null}
            className="mt-2 h-9 w-full"
/>
          {recentRenameError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {recentRenameError}
            </p>
          ) : null}
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelRecentSessionRename}
            disabled={renamingRecentSessionId !== null}
          >
            取消
          </NotionButton>
          <NotionButton
            type="submit"
            variant="primary"
            size="sm"
            disabled={renamingRecentSessionId !== null || !editingRecentSessionTitle.trim()}
          >
            {renamingRecentSessionId !== null ? <CircleNotch size={16} className="animate-spin" /> : null}
            确认
          </NotionButton>
        </NotionDialogFooter>
      </form>
    </NotionDialog>
    </>
  );
};
