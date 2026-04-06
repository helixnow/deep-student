import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  Atom,
  BookOpen,
  Bookmark,
  Brain,
  Calculator,
  Camera,
  ChevronRight,
  Code,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  Globe,
  GraduationCap,
  Heart,
  Languages,
  Lightbulb,
  MessageSquare,
  Music,
  Palette,
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
import { getSessionTitleText } from '@/chat-v2/utils/sessionTitle';
import { SessionGroupActions } from '@/chat-v2/pages/SessionGroupActions';
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

export const ModernSidebar: React.FC<ModernSidebarProps> = ({
  currentView,
  onViewChange,
}) => {
  const { t } = useTranslation(['sidebar', 'common', 'chatV2']);
  const [recentSessions, setRecentSessions] = useState<ChatSession[]>([]);
  const [recentGroups, setRecentGroups] = useState<SessionGroup[]>([]);
  const [collapsedRecentGroupIds, setCollapsedRecentGroupIds] = useState<Set<string>>(() => new Set());
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

  const renderRecentSessionRow = useCallback((session: ChatSession, collapsed = false) => {
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
        tabIndex={collapsed ? -1 : undefined}
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

  const recentSessionGroups = useMemo<RecentSessionGroup[]>(() => {
    const sessionsByGroup = new Map<string, ChatSession[]>();
    const groupLookup = new Map(recentGroups.map((group) => [group.id, group]));
    const ungroupedSessions: ChatSession[] = [];

    recentSessions.forEach((session) => {
      if (session.groupId && groupLookup.has(session.groupId)) {
        const groupSessions = sessionsByGroup.get(session.groupId) ?? [];
        groupSessions.push(session);
        sessionsByGroup.set(session.groupId, groupSessions);
        return;
      }
      ungroupedSessions.push(session);
    });

    const groupedSections: RecentSessionGroup[] = recentGroups
      .filter((group) => (sessionsByGroup.get(group.id) ?? []).length > 0)
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
    const hasActiveSession = currentView === 'chat-v2' && group.sessions.some((session) => session.id === activeSessionId);
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
            'space-y-0.5 overflow-hidden pl-4',
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
              <NotionButton
                variant="nav"
                size="md"
                onClick={() => toggleRecentGroup(group.id)}
                onContextMenu={onContextMenu}
                aria-label={group.label}
                aria-expanded={isExpanded}
                className={cn(
                  'group/sidebar-section desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left select-none',
                  hasActiveSession && 'desktop-shell-nav-row--active'
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="flex shrink-0 items-center justify-center text-[color:inherit]">
                    {renderRecentGroupIcon(group)}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="block min-w-0 flex-1 truncate leading-4">
                      {group.label}
                    </span>
                    <span className="shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--shell-navigation-muted)]">
                      {group.sessions.length}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {quickAction}
                  </span>
                </span>
              </NotionButton>
            )}
          </SessionGroupActions>
          {sessionList}
        </section>
      );
    }

    return (
      <section key={group.id} className="space-y-0.5">
        <NotionButton
          variant="nav"
          size="md"
          onClick={() => toggleRecentGroup(group.id)}
          aria-label={group.label}
          aria-expanded={isExpanded}
          className={cn(
            'desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left select-none',
            hasActiveSession && 'desktop-shell-nav-row--active'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex shrink-0 items-center justify-center text-[color:inherit]">
              {renderRecentGroupIcon(group)}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="block min-w-0 flex-1 truncate leading-4">
                {group.label}
              </span>
              <span className="shrink-0 text-[11px] font-normal tabular-nums text-[color:var(--shell-navigation-muted)]">
                {group.sessions.length}
              </span>
            </span>
            <span className="flex shrink-0 items-center justify-center text-[color:var(--shell-navigation-muted)]">
              <ChevronRight
                className={cn(
                  'size-3 transition-transform duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90'
                )}
                strokeWidth={2.25}
              />
            </span>
          </span>
        </NotionButton>
        {sessionList}
      </section>
    );
  }, [activeSessionId, collapsedRecentGroupIds, currentView, handleViewChange, recentGroups, renderRecentGroupIcon, renderRecentSessionRow, t, toggleRecentGroup]);

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

          {recentSessionGroups.length > 0 ? (
            <section className="space-y-0.5 pt-1">
              <div className="px-3">
                <p className="desktop-shell-nav-section-label">
                  {t('sidebar:sections.recent', '最近')}
                </p>
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
