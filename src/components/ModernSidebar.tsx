import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowSquareOut,
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
  Code,
  Desktop,
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
  MagnifyingGlass,
  MusicNote,
  Palette,
  PencilSimple,
  PushPin,
  Rocket,
  Sparkle,
  Star,
  Target,
  Trash,
  Trophy,
  X,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { createNavItems } from '../config/navigation';
import { useIsUILabEnabled } from '../utils/uiLabToggle';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Input } from '@/components/ui/shad/Input';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { beginSessionHoverPrefetch, cancelSessionHoverPrefetch } from '@/features/chat/core/session/sessionPrefetch';
import type { ChatSession } from '@/features/chat/types/session';
import type { SessionGroup } from '@/features/chat/types/group';
import { buildPinnedSessionMetadata, isSessionPinned } from '@/features/chat/utils/sessionPin';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import { useSidebarSessionData } from '@/features/chat/hooks/useSessionManagement';
import { SessionGroupActions } from '@/features/chat/pages/SessionGroupActions';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { AppUpdaterController } from '@/hooks/useAppUpdater';
import type { CurrentView } from '@/types/navigation';
import { useCommandPalette } from '@/command-palette/CommandPaletteProvider';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { StudyComposeIcon, StudySettingsIcon } from './icons/StudySidebarIcons';
import {
  persistWorkbenchModeEnabled,
  readWorkbenchModeEnabled,
} from '@/features/settings/components/workbenchMode';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { formatShortcut } from '@/command-palette/registry/shortcutUtils';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { showArchiveSessionToast } from '@/features/chat/utils/archiveSessionToast';
import {
  markSessionSidebarIndicatorSeen,
  useSessionSidebarIndicators,
} from '@/features/chat/hooks/useSessionSidebarIndicators';
import { isMacOS, isMobilePlatform } from '@/utils/platform';
import {
  WorkbenchSidebarRow as SidebarRow,
  WorkbenchSidebarRowLabel as SidebarRowLabel,
  WorkbenchSidebarSectionHeader,
  WorkbenchSidebarSurface,
  WorkbenchSidebarFixed,
  WorkbenchSidebarScroll,
} from '@/features/workbench/components/sidebar';

interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

interface ModernSidebarProps {
  currentView: CurrentView;
  onViewChange: (view: CurrentView) => void;
  /** Workbench Chat 窗口只保留会话管理，不显示全局应用入口。 */
  navigationScope?: 'full' | 'chat';
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  startDragging?: (e: React.MouseEvent) => void;
  navigationHistory?: NavigationHistory;
  topbarTopMargin?: number;
  updater?: Pick<AppUpdaterController, 'checking' | 'available' | 'info' | 'downloading' | 'readyToRelaunch' | 'performUpdateAction'>;
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

function HoverScrollSidebarLabel({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    const textElement = textRef.current;
    if (!container || !textElement) return;

    const measureOverflow = () => {
      setOverflowDistance(Math.max(0, textElement.scrollWidth - container.clientWidth));
    };

    measureOverflow();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(container);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [text]);

  const shouldScroll = overflowDistance > 0;
  const scrollDuration = Math.min(10, Math.max(3, overflowDistance / 32 + 2));
  const isScrolling = shouldScroll && isHovered && !prefersReducedMotion;
  const edgeFadeStyle = shouldScroll
    ? {
      maskMode: 'alpha' as const,
      maskImage: isScrolling
        ? 'linear-gradient(to right, transparent 0%, #fff 10px, #fff calc(100% - 10px), transparent 100%)'
        : 'linear-gradient(to right, #fff 0%, #fff 90%, transparent 100%)',
      WebkitMaskImage: isScrolling
        ? 'linear-gradient(to right, transparent 0%, #fff 10px, #fff calc(100% - 10px), transparent 100%)'
        : 'linear-gradient(to right, #fff 0%, #fff 90%, transparent 100%)',
    }
    : undefined;

  return (
    <span
      ref={containerRef}
      className="desktop-shell-sidebar-row-title block min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      style={edgeFadeStyle}
      title={text}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <motion.span
        ref={textRef}
        className="inline-block w-max min-w-full whitespace-nowrap"
        animate={{ x: isScrolling ? -overflowDistance : 0 }}
        transition={isScrolling
          ? {
            duration: scrollDuration,
            ease: 'linear',
            repeat: Infinity,
            repeatType: 'reverse',
            repeatDelay: 0.6,
          }
          : { duration: 0.15, ease: 'easeOut' }}
      >
        {text}
      </motion.span>
    </span>
  );
}

function isFinePointerDesktopSurface(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  return window.matchMedia('(pointer: fine)').matches;
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
      className="sidebar-session-toggle block w-full cursor-default appearance-none border-0 bg-transparent py-1 pl-9 pr-2.5 text-left text-[12px] font-normal leading-none text-[color:var(--shell-navigation-muted)] outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
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
      className="inline-flex h-3.5 w-3.5 items-center justify-center"
      aria-hidden="true"
    >
      <svg
        className="h-3.5 w-3.5 animate-[spin_1.1s_linear_infinite] rounded-full"
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

function SidebarBlockingContinueBadge({ label }: { label: string }) {
  return (
    <span
      data-testid="sidebar-blocking-indicator"
      className="inline-flex min-h-5 items-center rounded-full border border-[color:color-mix(in_oklab,var(--shell-navigation-foreground)_16%,transparent)] bg-[color:color-mix(in_oklab,var(--shell-navigation-foreground)_8%,transparent)] px-1.5 text-[10px] font-medium leading-none text-[color:var(--shell-navigation-foreground)]"
      aria-hidden="true"
    >
      {label}
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
  navigationScope = 'full',
  sidebarCollapsed = false,
  updater,
}) => {
  const { t } = useTranslation(['sidebar', 'common', 'chatV2', 'command_palette']);
  const { openSessionSearch } = useCommandPalette();
  // 统一数据源：与 ChatV2 移动侧栏相同的「分组全量 + 未分组分页」策略（替代旧 limit:8 孤立拉取）
  const {
    sessions: rawRecentSessions,
    groups: rawRecentGroups,
    hasMoreUngrouped: hasMoreUngroupedSessions,
    isLoadingMore: isLoadingMoreSessions,
    loadMoreUngrouped: loadMoreUngroupedSessions,
    refresh: refreshSidebarData,
    setSessions: setRecentSessions,
    setGroups: setRecentGroups,
  } = useSidebarSessionData();
  const recentSessions = useMemo(
    () => sortSessionsByUpdatedAt(rawRecentSessions),
    [rawRecentSessions]
  );
  const recentGroups = useMemo(
    () => sortGroups(rawRecentGroups.filter(isSessionGroup)),
    [rawRecentGroups]
  );
  const [collapsedRecentGroupIds, setCollapsedRecentGroupIds] = useState<Set<string>>(() => new Set());
  const [expandedRecentGroupSessionIds, setExpandedRecentGroupSessionIds] = useState<Set<string>>(() => new Set());
  const [conversationSessionsExpanded, setConversationSessionsExpanded] = useState(false);
  const [collapsedSidebarSectionIds, setCollapsedSidebarSectionIds] = useState<Set<SidebarSectionId>>(() => new Set());
  const [draggedRecentGroupId, setDraggedRecentGroupId] = useState<string | null>(null);
  const [dragOverRecentGroupId, setDragOverRecentGroupId] = useState<string | null>(null);
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragOverUngroupedZone, setDragOverUngroupedZone] = useState(false);
  const [openRecentSessionMenuId, setOpenRecentSessionMenuId] = useState<string | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = useState<string | null>(null);
  const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = useState<string | null>(null);
  const [editingRecentSessionId, setEditingRecentSessionId] = useState<string | null>(null);
  const [editingRecentSessionTitle, setEditingRecentSessionTitle] = useState('');
  const [renamingRecentSessionId, setRenamingRecentSessionId] = useState<string | null>(null);
  const [recentRenameError, setRecentRenameError] = useState<string | null>(null);
  const [workbenchModeEnabled, setWorkbenchModeEnabled] = useState(true);
  const draggedRecentGroupIdRef = useRef<string | null>(null);
  const draggedSessionIdRef = useRef<string | null>(null);
  const deleteConfirmResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return sessionManager.getCurrentSessionId() || localStorage.getItem('chat-v2-last-session-id');
    } catch {
      return sessionManager.getCurrentSessionId();
    }
  });
  const streamingSessionIds = useSessionSidebarIndicators((state) => state.streamingSessionIds);
  const blockingSessionIds = useSessionSidebarIndicators((state) => state.blockingSessionIds);
  const unreadSessionIds = useSessionSidebarIndicators((state) => state.unreadSessionIds);
  const streamingSessionIdSet = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);
  const blockingSessionIdSet = useMemo(() => new Set(blockingSessionIds), [blockingSessionIds]);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const blockingContinueLabel = t('chatV2:tool_limit.continue');

  const uiLabEnabled = useIsUILabEnabled();
  const navItems = useMemo(() => createNavItems(t, uiLabEnabled), [t, uiLabEnabled]);
  const primaryItems = useMemo(
    () => navItems.filter((item) => {
      if (navigationScope === 'chat') {
        return item.view === 'chat-v2';
      }
      return ['chat-v2', 'learning-hub', 'todo', 'skills-management', 'task-dashboard', 'template-management', 'ui-lab'].includes(item.view);
    }),
    [navItems, navigationScope]
  );
  const chatNavLabel = t('sidebar:navigation.chat_v2');
  const shouldShowMacDesktopNewSessionShortcut = useMemo(
    () => isMacOS() && !isMobilePlatform() && isFinePointerDesktopSurface(),
    []
  );
  const newSessionShortcutLabel = useMemo(() => formatShortcut('mod+n'), []);
  const shouldShowUpdateBadge = Boolean(
    !sidebarCollapsed && updater && !updater.checking && updater.available && updater.info
  );
  // 包装 onViewChange，添加点击追踪
  const handleViewChange = useCallback((view: CurrentView) => {
    if (view !== currentView) {
      pageLifecycleTracker.log(
        'sidebar',
        'ModernSidebar',
        'sidebar_click',
        `${currentView} -> ${view}`
      );
    }
    onViewChange(view);
  }, [currentView, onViewChange]);

  useEffect(() => {
    let cancelled = false;
    void readWorkbenchModeEnabled().then((enabled) => {
      if (!cancelled) setWorkbenchModeEnabled(enabled);
    });
    const onModeChanged = (event: Event) => {
      const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
      if (typeof enabled === 'boolean') setWorkbenchModeEnabled(enabled);
    };
    window.addEventListener('workbench:mode-changed', onModeChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('workbench:mode-changed', onModeChanged);
    };
  }, []);

  const handleWorkbenchModeAction = useCallback(() => {
    const nextEnabled = !workbenchModeEnabled;
    setWorkbenchModeEnabled(nextEnabled);
    void persistWorkbenchModeEnabled(nextEnabled).then((saved) => {
      if (!saved) setWorkbenchModeEnabled(!nextEnabled);
    });
  }, [workbenchModeEnabled]);

  useEffect(() => {
    if (currentView === 'chat-v2') {
      setActiveSessionId(sessionManager.getCurrentSessionId());
    }
  }, [currentView]);

  const syncActiveSession = useCallback((event?: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }> | undefined)?.detail;
    setActiveSessionId(detail?.sessionId ?? sessionManager.getCurrentSessionId());
  }, []);

  // 数据刷新由 useSidebarSessionData 内部订阅 sessions/groups 更新事件完成，
  // 这里只需要同步高亮的当前会话。
  useEventRegistry([
    {
      target: 'window',
      type: 'navigate-to-session',
      listener: syncActiveSession as EventListener,
    },
    {
      target: 'window',
      type: 'chat-v2:sessions-updated',
      listener: syncActiveSession as EventListener,
    },
  ], [syncActiveSession]);

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

  const clearDeleteConfirmResetTimer = useCallback(() => {
    if (deleteConfirmResetTimerRef.current) {
      clearTimeout(deleteConfirmResetTimerRef.current);
      deleteConfirmResetTimerRef.current = null;
    }
  }, []);

  const resetDeleteConfirmation = useCallback(() => {
    clearDeleteConfirmResetTimer();
    setConfirmingDeleteSessionId(null);
  }, [clearDeleteConfirmResetTimer]);

  // 删除是危险操作：菜单点击后进入行内二次确认，5s 无操作自动收回
  const beginDeleteConfirmation = useCallback((sessionId: string) => {
    setOpenRecentSessionMenuId(null);
    setConfirmingArchiveSessionId(null);
    clearDeleteConfirmResetTimer();
    setConfirmingDeleteSessionId(sessionId);
    deleteConfirmResetTimerRef.current = setTimeout(() => {
      deleteConfirmResetTimerRef.current = null;
      setConfirmingDeleteSessionId(null);
    }, 5000);
  }, [clearDeleteConfirmResetTimer]);

  useEffect(() => clearDeleteConfirmResetTimer, [clearDeleteConfirmResetTimer]);

  const startRecentSessionRename = useCallback((session: ChatSession) => {
    setOpenRecentSessionMenuId(null);
    setConfirmingArchiveSessionId(null);
    resetDeleteConfirmation();
    setRecentRenameError(null);
    setEditingRecentSessionId(session.id);
    setEditingRecentSessionTitle(getSessionTitleText(session.title, ''));
  }, [resetDeleteConfirmation]);

  const cancelRecentSessionRename = useCallback(() => {
    setRenamingRecentSessionId(null);
    setRecentRenameError(null);
    setEditingRecentSessionId(null);
    setEditingRecentSessionTitle('');
  }, []);

  const saveRecentSessionRename = useCallback(async (sessionId: string) => {
    const trimmedTitle = editingRecentSessionTitle.trim();
    if (!trimmedTitle) {
      setRecentRenameError(t('chatV2:page.renameEmptyError'));
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
      setRecentRenameError(t('chatV2:page.renameFailed'));
    } finally {
      setRenamingRecentSessionId(null);
    }
  }, [cancelRecentSessionRename, editingRecentSessionTitle, recentSessions, t]);

  const handleRecentSessionArchive = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_archive_session', { sessionId });
      const remainingSessions = recentSessions.filter((item) => item.id !== sessionId);
      setRecentSessions((previous) => previous.filter((item) => item.id !== sessionId));

      if (activeSessionId === sessionId) {
        const nextSession = remainingSessions[0] ?? null;
        if (nextSession) {
          handleRecentSessionOpen(nextSession.id);
        } else {
          setActiveSessionId(null);
          window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
            detail: { action: 'create-session', groupId: null },
          }));
        }
      }

      setConfirmingArchiveSessionId((current) => (current === sessionId ? null : current));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      showArchiveSessionToast(t, 'chatV2');
    } catch (error) {
      console.warn('[ModernSidebar] Failed to archive recent session:', error);
      void refreshSidebarData();
    }
  }, [activeSessionId, handleRecentSessionOpen, refreshSidebarData, recentSessions, t]);

  // 永久删除（区别于归档；行内二次确认后才会走到这里）
  const handleRecentSessionDelete = useCallback(async (sessionId: string) => {
    resetDeleteConfirmation();
    try {
      await invoke('chat_v2_delete_session', { sessionId });
      const remainingSessions = recentSessions.filter((item) => item.id !== sessionId);
      setRecentSessions((previous) => previous.filter((item) => item.id !== sessionId));

      if (activeSessionId === sessionId) {
        const nextSession = remainingSessions[0] ?? null;
        if (nextSession) {
          handleRecentSessionOpen(nextSession.id);
        } else {
          setActiveSessionId(null);
          window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
            detail: { action: 'create-session', groupId: null },
          }));
        }
      }

      // 通知 ChatV2Page 同步其本地 sessions 状态（Browser/移动列表即时移除）
      window.dispatchEvent(new CustomEvent('modern-sidebar:session-action', {
        detail: { action: 'session-deleted', sessionId },
      }));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to delete recent session:', error);
      void refreshSidebarData();
    }
  }, [activeSessionId, handleRecentSessionOpen, recentSessions, refreshSidebarData, resetDeleteConfirmation, setRecentSessions]);

  // 拖拽会话到分组行 / 「对话」区（未分组）
  const moveRecentSessionToGroup = useCallback(async (sessionId: string, groupId: string | null) => {
    const session = recentSessions.find((item) => item.id === sessionId);
    if (!session || (session.groupId ?? null) === groupId) return;

    setRecentSessions((previous) =>
      previous.map((item) =>
        item.id === sessionId ? { ...item, groupId: groupId ?? undefined } : item
      )
    );

    try {
      await invoke('chat_v2_move_session_to_group', { sessionId, groupId });
      sessionManager.get(sessionId)?.setState({ groupId });
      // 通知 ChatV2Page 走 applySessionGroupUpdate（含分组 snapshot 元数据同步）
      window.dispatchEvent(new CustomEvent('modern-sidebar:session-action', {
        detail: { action: 'session-moved', sessionId, groupId },
      }));
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ModernSidebar] Failed to move session to group:', error);
      void refreshSidebarData();
    }
  }, [recentSessions, refreshSidebarData, setRecentSessions]);

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
      void refreshSidebarData();
    }
  }, [refreshSidebarData, recentGroups]);

  const clearRecentGroupDragState = useCallback(() => {
    draggedRecentGroupIdRef.current = null;
    draggedSessionIdRef.current = null;
    setDraggedRecentGroupId(null);
    setDraggedSessionId(null);
    setDragOverRecentGroupId(null);
    setDragOverUngroupedZone(false);
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

  const handleRecentSessionDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, sessionId: string) => {
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-modern-sidebar-session-id', sessionId);
      event.dataTransfer.setData('text/plain', sessionId);
    }
    draggedSessionIdRef.current = sessionId;
    setDraggedSessionId(sessionId);
  }, []);

  // 分组行同时承接两种拖拽：分组重排 + 会话移入分组
  const handleRecentGroupDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, groupId: string) => {
    const draggingGroupId = draggedRecentGroupIdRef.current;
    const draggingSessionId = draggedSessionIdRef.current;
    if (draggingSessionId !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      setDragOverRecentGroupId((current) => (current === groupId ? current : groupId));
      return;
    }

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

    const draggingSessionId =
      draggedSessionIdRef.current
      ?? event.dataTransfer?.getData('application/x-modern-sidebar-session-id')
      ?? null;
    if (draggingSessionId) {
      clearRecentGroupDragState();
      await moveRecentSessionToGroup(draggingSessionId, targetGroupId);
      return;
    }

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
      void refreshSidebarData();
    }
  }, [clearRecentGroupDragState, moveRecentSessionToGroup, refreshSidebarData, setRecentGroups]);

  // 「对话」区作为未分组落点：把分组内会话拖回未分组
  const handleUngroupedZoneDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (draggedSessionIdRef.current === null) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    setDragOverUngroupedZone(true);
  }, []);

  const handleUngroupedZoneDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOverUngroupedZone(false);
  }, []);

  const handleUngroupedZoneDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    const draggingSessionId =
      draggedSessionIdRef.current
      ?? event.dataTransfer?.getData('application/x-modern-sidebar-session-id')
      ?? null;
    if (!draggingSessionId) return;
    event.preventDefault();
    clearRecentGroupDragState();
    await moveRecentSessionToGroup(draggingSessionId, null);
  }, [clearRecentGroupDragState, moveRecentSessionToGroup]);

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

  const prefersReducedMotion = useReducedMotion();

  const renderRecentSessionRow = useCallback((session: ChatSession, collapsed = false) => {
    const isActive = currentView === 'chat-v2' && activeSessionId === session.id;
    const sessionTitle = getSessionTitleText(session.title, t('chatV2:page.untitled'));
    const pinned = isSessionPinned(session);
    const isSessionStreaming = streamingSessionIdSet.has(session.id);
    const hasBlockingInteraction = blockingSessionIdSet.has(session.id);
    const hasUnreadAssistantReply = unreadSessionIdSet.has(session.id);
    const isConfirmingArchive = confirmingArchiveSessionId === session.id;
    const isConfirmingDelete = confirmingDeleteSessionId === session.id;

    const relativeTime = (() => {
      const ts = new Date(session.updatedAt ?? session.createdAt).getTime();
      const diffMs = Date.now() - ts;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      const diffWeeks = Math.floor(diffDays / 7);
      if (diffMins < 1) return t('common:time.now');
      if (diffMins < 60) return t('common:time.minutes_ago', { count: diffMins });
      if (diffHours < 24) return t('common:time.hours_ago', { count: diffHours });
      if (diffDays < 7) return t('common:time.days_ago', { count: diffDays });
      if (diffWeeks < 5) return t('common:time.relative.weeks_ago', { count: diffWeeks });
      return new Date(ts).toLocaleDateString();
    })();

    // 行内重命名（替代原 DsDialog 模态）：Enter 保存 / Esc 取消 / 失焦保存
    if (!collapsed && editingRecentSessionId === session.id) {
      const isRenaming = renamingRecentSessionId === session.id;
      return (
        <motion.div
          key={session.id}
          layout={prefersReducedMotion ? false : 'position'}
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          className="relative px-0.5 py-0.5"
        >
          <Input
            type="text"
            value={editingRecentSessionTitle}
            placeholder={t('chatV2:page.untitled')}
            aria-label={t('sidebar:rename.label')}
            autoFocus
            disabled={isRenaming}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setEditingRecentSessionTitle(event.target.value);
              if (recentRenameError) setRecentRenameError(null);
            }}
            onKeyDown={(event) => {
              // IME 安全：中文输入法组合期间的 Enter/Escape 只作用于候选词
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!isRenaming) void saveRecentSessionRename(session.id);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRecentSessionRename();
              }
            }}
            onBlur={() => {
              if (!isRenaming) void saveRecentSessionRename(session.id);
            }}
            className="h-7 w-full rounded-[10px] border-[color:var(--ring)]/45 bg-[color:var(--surface-elevated)] px-2 text-[13px] leading-none focus-visible:ring-1 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
          />
          {recentRenameError ? (
            <p className="mt-1 px-1 text-[11px] leading-tight text-destructive" role="alert">
              {recentRenameError}
            </p>
          ) : null}
        </motion.div>
      );
    }

    return (
      // 进出场（transitions-dev 观感）：新建 fade+4px 上升，归档/删除 fade+轻缩放；
      // 兄弟行经 layout 平滑补位；hover 后 20ms 触发会话预取（见 sessionPrefetch.ts）
      <motion.div
        key={session.id}
        layout={prefersReducedMotion ? false : 'position'}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'group/thread-row relative',
          draggedSessionId === session.id && 'opacity-55'
        )}
        onMouseEnter={() => {
          beginSessionHoverPrefetch(session.id);
        }}
        onMouseLeave={() => {
          cancelSessionHoverPrefetch(session.id);
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
              draggable={!collapsed}
              onDragStart={(event) => handleRecentSessionDragStart(event, session.id)}
              onDragEnd={clearRecentGroupDragState}
              aria-label={sessionTitle}
              aria-current={isActive ? 'page' : undefined}
              tabIndex={collapsed ? -1 : undefined}
              isActive={isActive}
              hideLeadingSlot={pinned}
              className={cn(
                // coarse 下行高容纳 44px 操作钮；右侧为 44+4+44px 操作簇留位，
                // 避免常显按钮跨行命中或盖住会话标题。
                '[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!pr-[4.25rem]',
                pinned && '!pl-3',
              )}
              rightSlot={isSessionStreaming ? (
                <SidebarStreamingIndicator />
              ) : hasBlockingInteraction ? (
                <SidebarBlockingContinueBadge label={blockingContinueLabel} />
              ) : hasUnreadAssistantReply ? (
                <SidebarUnreadReplyDot />
              ) : (
                <span className="ml-1 shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--shell-navigation-muted)] group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0">
                  {/* 触屏（coarse pointer）没有 hover：操作簇在所有行常显，时间戳同步让位 */}
                  <span className={cn(pinned && 'mr-12 inline-block', '[@media(pointer:coarse)]:opacity-0')}>{relativeTime}</span>
                </span>
              )}
            >
              <HoverScrollSidebarLabel text={sessionTitle} />
            </SidebarRow>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={180}>
            <AppMenuGroup>
              {/* 在新窗口打开：chat-session multi 实例（仅 workbench 模式；legacy 隐藏） */}
              {workbenchBus.isEnabled() && (
                <AppMenuItem
                  icon={<ArrowSquareOut size={16} />}
                  onClick={() => {
                    setOpenRecentSessionMenuId(null);
                    // 动态引入，避免把 workbench chat 注册链拽进 legacy 首包
                    void import('@/features/workbench/apps/chat/newSession')
                      .then(({ openChatSessionInNewWindow }) => {
                        openChatSessionInNewWindow(session.id);
                      })
                      .catch((error) => {
                        console.warn('[ModernSidebar] open session in new window failed:', error);
                      });
                  }}
                >
                  {t('chatV2:page.openInNewWindow')}
                </AppMenuItem>
              )}
              <AppMenuItem
                icon={<PencilSimple size={16} />}
                onClick={() => {
                  startRecentSessionRename(session);
                }}
              >
                {t('sidebar:actions.rename_session')}
              </AppMenuItem>
              <AppMenuItem
                icon={<PushPin size={16} />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  void handleRecentSessionPinToggle(session);
                }}
              >
                {pinned ? t('chatV2:page.unpinSession') : t('chatV2:page.pinSession')}
              </AppMenuItem>
              <AppMenuItem
                icon={<Archive size={16} />}
                onClick={() => {
                  setOpenRecentSessionMenuId(null);
                  void handleRecentSessionArchive(session.id);
                }}
              >
                {t('chatV2:page.archiveSession')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem
                icon={<Trash size={16} />}
                destructive
                onClick={() => beginDeleteConfirmation(session.id)}
              >
                {t('sidebar:actions.delete_session')}
              </AppMenuItem>
            </AppMenuGroup>
          </AppMenuContent>
        </AppMenu>

        {/* 永久删除的行内二次确认（无模态；5s 未操作自动收回） */}
        {!collapsed && isConfirmingDelete && (
          <div className="mt-0.5 flex items-center justify-between gap-2 rounded-[10px] border border-destructive/25 bg-destructive/10 py-1.5 pl-2 pr-1">
            <span className="min-w-0 truncate text-[11px] leading-none text-destructive">
              {t('sidebar:delete.confirm_hint')}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 !px-2 text-[11px] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                onClick={resetDeleteConfirmation}
              >
                {t('common:cancel')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                className="!h-6 !px-2 text-[11px] text-destructive hover:bg-destructive/15 hover:text-destructive [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                onClick={() => void handleRecentSessionDelete(session.id)}
              >
                {t('common:delete')}
              </DsButton>
            </span>
          </div>
        )}

        {/* 行内快捷操作：置顶与归档组成右侧操作簇，细指针 hover 或 focus 时渐显；
            触屏（coarse pointer）没有 hover，所有行常显保证可达——
            仅活动行常显会让非活动会话在 iPad 上无法置顶/归档。 */}
        {!collapsed && (
          <div
            className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
          >
            {/* eslint-disable-next-line ds-components/no-native-button */}
            <button
              type="button"
              data-testid="recent-session-pin-icon"
              aria-label={pinned ? t('sidebar:aria.unpin_session') : t('sidebar:aria.pin_session')}
              className={cn(
                'flex size-5 shrink-0 appearance-none items-center justify-center rounded-md border-0 !p-0 text-[color:var(--shell-navigation-muted)] transition-colors hover:text-[color:var(--shell-navigation-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                pinned && 'text-[color:var(--shell-navigation-foreground)]'
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setConfirmingArchiveSessionId(null);
                void handleRecentSessionPinToggle(session);
              }}
            >
              <PushPin size={14} weight={pinned ? 'fill' : 'regular'} />
            </button>
            {!collapsed && !isSessionStreaming && !hasBlockingInteraction && !hasUnreadAssistantReply && (
              <CommonTooltip content={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')} position="right">
                {/* eslint-disable-next-line ds-components/no-native-button */}
                <button
                  type="button"
                  aria-label={isConfirmingArchive ? t('sidebar:aria.confirm_archive_session') : t('sidebar:aria.archive_session')}
                  className={cn(
                    'flex size-5 shrink-0 appearance-none items-center justify-center rounded-md border-0 !p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                    isConfirmingArchive
                      ? 'bg-destructive/15 text-destructive hover:bg-destructive/20'
                      : 'bg-transparent text-[color:var(--shell-navigation-muted)] hover:text-destructive'
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
                  onBlur={() => {
                    setConfirmingArchiveSessionId((current) => (current === session.id ? null : current));
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
                </button>
              </CommonTooltip>
            )}
          </div>
        )}
      </motion.div>
    );
  }, [activeSessionId, beginDeleteConfirmation, blockingContinueLabel, blockingSessionIdSet, cancelRecentSessionRename, clearRecentGroupDragState, confirmingArchiveSessionId, confirmingDeleteSessionId, currentView, draggedSessionId, editingRecentSessionId, editingRecentSessionTitle, handleRecentSessionArchive, handleRecentSessionDelete, handleRecentSessionDragStart, handleRecentSessionOpen, handleRecentSessionPinToggle, openRecentSessionMenuId, prefersReducedMotion, recentRenameError, renamingRecentSessionId, resetDeleteConfirmation, saveRecentSessionRename, startRecentSessionRename, streamingSessionIdSet, t, unreadSessionIdSet]);

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
    const iconColorClass = '!text-[color:var(--shell-navigation-foreground)]';

    if (!group.icon) {
      return <Folder className={`size-[16px] ${iconColorClass}`} strokeWidth={2} />;
    }

    const PresetIcon = RECENT_GROUP_PRESET_ICONS[group.icon];
    if (PresetIcon) {
      const Icon = PresetIcon;
      return <Icon className={`size-[16px] ${iconColorClass}`} strokeWidth={2} />;
    }

    return (
      <span aria-hidden="true" className={`text-sm leading-none ${iconColorClass}`}>
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
      ? t('sidebar:actions.collapse_group_sessions')
      : t('sidebar:actions.expand_group_sessions');

    const sessionList = (
      <div className="t-acc-panel">
        <div
          aria-hidden={!isExpanded}
          className={cn(
            'space-y-0.5 overflow-hidden',
            't-acc-panel-inner',
            !isExpanded && 'pointer-events-none'
          )}
          role="list"
        >
          {group.sessions.length > 0 ? (
            <>
              <AnimatePresence initial={false} mode="popLayout">
                {visibleSessions.map((session) => renderRecentSessionRow(session, !isExpanded))}
              </AnimatePresence>
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
              {t('sidebar:sections.emptyGroup')}
            </div>
          )}
        </div>
      </div>
    );

    return (
      <section key={group.id} className="t-acc space-y-0.5" data-open={String(isExpanded)}>
        <SessionGroupActions
          group={sessionGroup}
          labels={{
            groupActions: t('chatV2:page.groupActions', 'Group Actions'),
            newSession: t('chatV2:page.newSession', 'New Session'),
            newSessionInGroup: t('chatV2:page.newSessionInGroup', {
              groupName: sessionGroup.name,
            }),
            pinGroup: t('chatV2:page.pinGroup'),
            unpinGroup: t('chatV2:page.unpinGroup'),
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
                // 分组 icon 与「课题」分区标题共用左侧基准线，标题和操作区保持原有布局。
                't-acc-head group/sidebar-section !pl-3 !pr-1 select-none',
                draggedRecentGroupId === group.id && 'cursor-grabbing opacity-60',
                dragOverRecentGroupId === group.id && draggedRecentGroupId !== group.id && 'bg-[color:var(--sidebar-quiet-hover)] ring-1 ring-black/8 dark:ring-white/10'
              )}
              leftSlot={renderRecentGroupIcon(group)}
              rightSlot={
                <span data-sidebar-row-actions className="flex shrink-0 items-center gap-1.5 text-[color:var(--shell-navigation-muted)]">
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
  const pinnedSectionLabel = t('sidebar:sections.pinned');
  const topicsSectionLabel = t('sidebar:sections.topics');
  const conversationsSectionLabel = t('sidebar:sections.conversations');
  const newConversationLabel = t('sidebar:actions.create_conversation');
  const toggleAllTopicsLabel = areAllTopicGroupsExpanded
    ? t('sidebar:actions.collapse_all_topics')
    : t('sidebar:actions.expand_all_topics');
  const createTopicLabel = t('sidebar:actions.create_topic');
  const hasConversationSessionOverflow = conversationSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT;
  const visibleConversationSessions = hasConversationSessionOverflow && !conversationSessionsExpanded
    ? conversationSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT)
    : conversationSessions;
  const conversationSessionOverflowLabel = conversationSessionsExpanded
    ? t('sidebar:actions.collapse_group_sessions')
    : t('sidebar:actions.expand_group_sessions');

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

    return <WorkbenchSidebarSectionHeader label={label} collapsed={isCollapsed} onToggle={() => toggleSidebarSection(id)} action={action} />;
  };

  const conversationHeaderAction = (
    <span
      data-sidebar-section-action="create-conversation"
      className="relative z-10 ml-auto flex shrink-0 items-center gap-1 text-[color:var(--shell-navigation-foreground)] opacity-0 transition-opacity duration-150 group-hover/sidebar-top-section:opacity-100 group-focus-within/sidebar-top-section:opacity-100 [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none"
    >
      <CommonTooltip content={newConversationLabel} position="right" shortcut={formatShortcut('mod+n')}>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={newConversationLabel}
          className="!h-6 !w-6 !rounded-none text-[color:var(--shell-navigation-muted)] hover:bg-transparent hover:text-[color:var(--shell-navigation-foreground)] active:bg-transparent active:text-[color:var(--shell-navigation-foreground)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          onClick={(event) => {
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent('modern-sidebar:group-action', {
              detail: { action: 'create-session', groupId: null },
            }));
          }}
        >
          <StudyComposeIcon className="w-3.5 h-3.5" />
        </DsButton>
      </CommonTooltip>
    </span>
  );

  return (
    <WorkbenchSidebarSurface
      ariaLabel={t('sidebar:aria.sidebar_navigation')}
      className="z-20"
      style={{ paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' }}
    >
      <WorkbenchSidebarFixed
        data-no-drag
        data-sidebar-fixed-region="sidebar-brand"
      >
        <div className="flex h-8 items-center justify-between gap-2 px-2">
          <span className="min-w-0 truncate font-[var(--font-family-display,var(--font-family))] text-[18px] font-semibold leading-none text-[color:var(--shell-navigation-foreground)]">
            DeepStudent
          </span>
          <CommonTooltip content={t('command_palette:session_search_placeholder', '搜索会话...')} position="right">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('command_palette:session_search_placeholder', '搜索会话...')}
              className="!h-8 !w-8 shrink-0 text-[color:var(--shell-navigation-muted)] hover:text-[color:var(--shell-navigation-foreground)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={openSessionSearch}
            >
              <MagnifyingGlass size={16} weight="bold" />
            </DsButton>
          </CommonTooltip>
        </div>
      </WorkbenchSidebarFixed>

      <WorkbenchSidebarFixed
        data-no-drag
        data-sidebar-fixed-region="primary-navigation"
      >
        <nav aria-label={t('sidebar:aria.workspace_primary_entry')}>
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
      </WorkbenchSidebarFixed>

      <WorkbenchSidebarScroll>
          {/* pt-5：让静止时首个分区标题避开 viewport 顶部 28px 渐隐 mask */}
          <div
            className="flex flex-col gap-3 px-2 pb-6 pt-5"
            data-no-drag
          >
            {hasPinnedContent ? (
              <section className="space-y-0.5 pt-1">
                {renderSidebarSectionHeader({ id: 'pinned', label: pinnedSectionLabel })}
                {!isPinnedSectionCollapsed ? (
                  <nav aria-label={t('sidebar:aria.pinned_sessions')}>
                    <div className="space-y-0.5" role="list">
                      {pinnedRecentGroups.map((group) => renderRecentGroup(group))}
                      <AnimatePresence initial={false} mode="popLayout">
                        {pinnedRecentSessions.map((session) => renderRecentSessionRow(session))}
                      </AnimatePresence>
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
                      <DsButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        aria-label={toggleAllTopicsLabel}
                        className="!h-6 !w-6 !rounded-none text-[color:var(--shell-navigation-muted)] hover:bg-transparent hover:text-[color:var(--shell-navigation-foreground)] active:bg-transparent active:text-[color:var(--shell-navigation-foreground)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={handleToggleAllTopicGroups}
                      >
                        {areAllTopicGroupsExpanded ? (
                          <CaretDoubleUp className="size-3.5" strokeWidth={2} />
                        ) : (
                          <CaretDoubleDown className="size-3.5" strokeWidth={2} />
                        )}
                      </DsButton>
                    </CommonTooltip>
                    <CommonTooltip content={createTopicLabel} position="right">
                      <DsButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        aria-label={createTopicLabel}
                        className="!h-6 !w-6 !rounded-none text-[color:var(--shell-navigation-muted)] hover:bg-transparent hover:text-[color:var(--shell-navigation-foreground)] active:bg-transparent active:text-[color:var(--shell-navigation-foreground)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                        onClick={handleCreateRecentGroup}
                      >
                        <FolderPlus className="size-3.5" strokeWidth={2} />
                      </DsButton>
                    </CommonTooltip>
                  </div>
                ),
              })}
              {!isTopicsSectionCollapsed ? (
                <nav aria-label={t('sidebar:aria.topic_sessions')}>
                  <div className="space-y-0.5" role="list">
                    {topicSessionGroups.map((group) => renderRecentGroup(group))}
                  </div>
                </nav>
              ) : null}
            </section>

            {/* 「对话」区同时是未分组落点：从分组把会话拖回这里即可取消分组 */}
            <section
              className={cn(
                'space-y-0.5 rounded-[10px] pt-1 transition-colors',
                dragOverUngroupedZone && draggedSessionId !== null
                  && 'bg-[color:var(--sidebar-quiet-hover)] ring-1 ring-black/8 dark:ring-white/10'
              )}
              onDragOver={handleUngroupedZoneDragOver}
              onDragLeave={handleUngroupedZoneDragLeave}
              onDrop={(event) => void handleUngroupedZoneDrop(event)}
            >
              {renderSidebarSectionHeader({
                id: 'conversations',
                label: conversationsSectionLabel,
                action: conversationHeaderAction,
              })}
            {!isConversationsSectionCollapsed ? (
              <nav aria-label={t('sidebar:aria.conversation_sessions')}>
                <div className="space-y-0.5" role="list">
                  <AnimatePresence initial={false} mode="popLayout">
                    {visibleConversationSessions.map((session) => renderRecentSessionRow(session))}
                  </AnimatePresence>
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
                  {/* 展开后如未分组会话仍有分页余量，可继续加载（与移动侧栏同一策略） */}
                  {conversationSessionsExpanded && hasMoreUngroupedSessions ? (
                    <SidebarSessionOverflowToggle
                      label={isLoadingMoreSessions ? t('chatV2:page.loading') : t('chatV2:page.loadMore')}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void loadMoreUngroupedSessions();
                      }}
                    />
                  ) : null}
                </div>
              </nav>
            ) : null}
            </section>
          </div>
      </WorkbenchSidebarScroll>

      {navigationScope === 'full' ? (
      <div className="mt-auto shrink-0 px-2 pb-3 pt-1" data-no-drag>
        <div className="relative flex justify-start">
          <AppMenu className="flex w-full">
            <AppMenuTrigger asChild>
              <SidebarRow
                rowType="nav"
                aria-label={t('sidebar:navigation.settings')}
                aria-current={currentView === 'settings' ? 'page' : undefined}
                isActive={currentView === 'settings'}
                data-tour-id="nav-settings"
                leftSlot={<StudySettingsIcon className="size-[18px]" strokeWidth={2} />}
              >
                <SidebarRowLabel>{t('sidebar:navigation.settings')}</SidebarRowLabel>
              </SidebarRow>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={224}>
              <AppMenuGroup>
                <AppMenuItem
                  icon={<StudySettingsIcon className="size-4" strokeWidth={2} />}
                  onClick={() => handleViewChange('settings')}
                >
                  {t('sidebar:navigation.settings')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<Desktop size={16} />}
                  onClick={handleWorkbenchModeAction}
                >
                  {workbenchModeEnabled
                    ? t('sidebar:navigation.hide_workbench_mode', { defaultValue: 'Hide Learning Desktop' })
                    : t('sidebar:navigation.show_workbench_mode', { defaultValue: 'Show Learning Desktop' })}
                </AppMenuItem>
              </AppMenuGroup>
            </AppMenuContent>
          </AppMenu>

          {shouldShowUpdateBadge ? (
            <button
              type="button"
              data-slot="sidebar-update-badge"
              className="desktop-shell-update-badge absolute right-2 top-1 inline-flex h-5 min-w-8 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-medium leading-none text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-['']"
              onClick={(event) => {
                event.stopPropagation();
                void updater.performUpdateAction();
              }}
              aria-label={
                updater?.downloading
                  ? t('sidebar:update.downloading')
                  : updater?.readyToRelaunch
                    ? t('sidebar:update.restart')
                    : t('sidebar:update.available')
              }
              disabled={updater?.downloading}
            >
              {updater?.downloading ? (
                <CircleNotch size={10} className="animate-spin" aria-hidden="true" />
              ) : updater?.readyToRelaunch ? (
                t('sidebar:update.restart')
              ) : t('sidebar:update.short')}
            </button>
          ) : null}
        </div>
      </div>
      ) : null}
    </WorkbenchSidebarSurface>
  );
};
