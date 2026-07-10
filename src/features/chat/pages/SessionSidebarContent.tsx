import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Archive,
  CaretRight,
  ChatCenteredText,
  CircleNotch,
  DotsThree,
  Folder,
  Gear,
  PencilSimple,
  Plus,
  SquaresFour,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
  mobileDrawerThreadRowClassName,
} from '@/components/layout/mobileDrawerStyles';
import { openArchivedSessionsSettings } from '@/utils/pendingSettingsTab';
import { ChatErrorBoundary } from '../components/ChatErrorBoundary';
import { compareSessionsForSidebar, isSessionPinned } from '../utils/sessionPin';
import type { SessionDragState } from './SessionItemRenderer';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import type { CurrentView } from '@/types/navigation';
import type { TFunction } from 'i18next';

const EXPANDED_FOLDERS_STORAGE_KEY = 'chat-v2-sidebar-expanded-folders';

function readPersistedExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((id): id is string => typeof id === 'string'));
      }
    }
  } catch {
    // ignore storage errors
  }
  return new Set();
}

export interface UseSessionSidebarContentDeps {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  viewMode: 'sidebar' | 'browser';
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  /** 可编辑（active）分组 ID 集合：仅这些分组显示重命名/编辑/归档菜单 */
  editableGroupIds: Set<string>;
  onCreateGroup: () => void;
  onRenameGroup: (group: SessionGroup) => void;
  onEditGroup: (group: SessionGroup) => void;
  onArchiveGroup: (group: SessionGroup) => void;
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
    searchQuery, setSearchQuery, viewMode, setViewMode, setSessionSheetOpen,
    setPendingDeleteSessionId,
    editableGroupIds, onCreateGroup, onRenameGroup, onEditGroup, onArchiveGroup,
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
  void setPendingDeleteSessionId;
  void totalSessionCount;
  void pendingDeleteSessionId;
  void resetDeleteConfirmation;
  void clearDeleteConfirmTimeout;
  void deleteConfirmTimeoutRef;

  const prefersReducedMotion = useReducedMotion();

  // 会话行进出场（transitions-dev 观感）：新建 fade+4px 上升，删除/归档 fade+轻缩，
  // 兄弟行经 layout 平滑补位；列表首挂载不动画（AnimatePresence initial={false}）
  const renderAnimatedSessionRow = React.useCallback(
    (session: ChatSession) => (
      <motion.div
        key={session.id}
        layout={prefersReducedMotion ? false : 'position'}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
      >
        {renderSessionItem(session)}
      </motion.div>
    ),
    [prefersReducedMotion, renderSessionItem]
  );

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

  // 展开状态持久化：避免每次进入页面都回到"全部折叠"
  const [expandedGroupIds, setExpandedGroupIds] = React.useState<Set<string>>(readPersistedExpandedFolders);

  React.useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify([...expandedGroupIds]));
    } catch {
      // ignore storage errors
    }
  }, [expandedGroupIds]);

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

  const handleCreateSession = React.useCallback(() => {
    setViewMode('sidebar');
    setSessionSheetOpen(false);
    void createSession();
  }, [createSession, setSessionSheetOpen, setViewMode]);

  // 移动端进入会话浏览视图（中屏整屏切换，顶栏切为返回箭头）
  const handleOpenBrowser = React.useCallback(() => {
    setViewMode('browser');
    setSessionSheetOpen(false);
  }, [setSessionSheetOpen, setViewMode]);

  const handleCreateSessionInFolder = React.useCallback((folderId: string) => {
    setViewMode('sidebar');
    setSessionSheetOpen(false);
    setExpandedGroupIds((current) => {
      if (current.has(folderId)) return current;
      const next = new Set(current);
      next.add(folderId);
      return next;
    });
    void createSession(folderId === 'ungrouped' ? undefined : folderId);
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
    id: CurrentView | 'new-chat' | 'session-browser',
    label: string,
    Icon: React.ElementType,
    active: boolean,
    onClick: () => void,
    unified = false,
  ) => (
    <button
      key={id}
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={
        unified
          ? mobileDrawerNavRowClassName(active, 'group gap-2.5')
          : cn(
              'group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1.5 text-left text-[16px] font-normal leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit',
              active
                ? 'bg-[color:var(--interactive-selected)] text-[color:var(--sidebar-foreground)]'
                : 'text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)]',
            )
      }
    >
      <span className={unified ? mobileDrawerRowIconWrapClassName : undefined}>
        <Icon
          size={18}
          weight="regular"
          className={unified ? undefined : cn(
            'h-[18px] w-[18px] shrink-0',
            active
              ? 'text-[color:var(--sidebar-foreground)]'
              : 'text-[color:var(--sidebar-muted)] group-hover:text-[color:var(--sidebar-foreground)]',
          )}
        />
      </span>
      <span className={unified ? mobileDrawerRowTitleClassName : 'min-w-0 flex-1 truncate'}>{label}</span>
    </button>
  );

  const renderSectionLabel = (label: string, unified: boolean) =>
    unified ? (
      <span className={mobileDrawerSectionLabelClassName}>{label}</span>
    ) : (
      <div className="px-3">
        <p className="text-[11px] font-normal text-[color:var(--sidebar-muted)]">{label}</p>
      </div>
    );

  const renderFolderRow = (
    id: string,
    label: string,
    sessionsForFolder: ChatSession[],
    active: boolean,
    unified = false,
    trailing?: React.ReactNode,
    group?: SessionGroup,
  ) => {
    const isExpanded = expandedGroupIds.has(id);
    const nonPinnedSessions = sessionsForFolder.filter((session) => !isSessionPinned(session));
    const createSessionLabel = id === 'ungrouped'
      ? t('page.newSession', '新建会话')
      : t('page.newSessionInGroup', { groupName: label, defaultValue: '在 {{groupName}} 中新建会话' });
    // 触屏无 hover：常显「…」菜单承载分组的新建会话/重命名/编辑/归档（与桌面 ModernSidebar 分组操作对齐）
    const hasGroupMenu = !!group && editableGroupIds.has(group.id);

    return (
      <section key={id} className="space-y-0.5">
        <div className="relative">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={() => toggleGroup(id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleGroup(id);
            }
          }}
          className={
            unified
              ? mobileDrawerThreadRowClassName(active, cn('group gap-2.5', hasGroupMenu && '!pr-11'))
              : cn(
                  'group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 cursor-pointer appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1.5 text-left text-[16px] font-normal leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring select-none [&_svg]:shrink-0 [&_svg]:text-inherit',
                  active
                    ? 'bg-[color:var(--interactive-selected)] text-[color:var(--sidebar-foreground)]'
                    : 'text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)]',
                  hasGroupMenu && 'pr-11',
                )
          }
        >
          <span className={unified ? mobileDrawerRowIconWrapClassName : undefined}>
            <Folder size={18} className={unified ? undefined : 'h-[18px] w-[18px] shrink-0 text-[color:var(--sidebar-muted)] group-hover:text-[color:var(--sidebar-foreground)]'} />
          </span>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className={unified ? mobileDrawerRowTitleClassName : 'truncate'}>{label}</span>
            <span className="flex items-center gap-1.5 text-[color:var(--sidebar-muted)]">
              <span className="flex items-center opacity-0 transition-opacity duration-150 ease-out focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!h-5 !w-5 !p-0"
                  aria-label={createSessionLabel}
                  title={createSessionLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCreateSessionInFolder(id);
                  }}
                >
                  <Plus size={12} />
                </NotionButton>
              </span>
              <CaretRight
                size={12}
                className={cn(
                  'pointer-events-none shrink-0 transition-transform duration-150 ease-[var(--dropdown-ease)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90'
                )}
              />
            </span>
          </span>
        </div>
        {hasGroupMenu && group && (
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 flex items-center">
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!h-11 !w-11"
                  aria-label={t('page.groupActions', '分组操作')}
                  title={t('page.groupActions', '分组操作')}
                >
                  <DotsThree size={18} className="text-muted-foreground/80" />
                </NotionButton>
              </AppMenuTrigger>
              <AppMenuContent align="end" width={200}>
                <AppMenuGroup>
                  <AppMenuItem
                    icon={<Plus size={16} />}
                    onClick={() => handleCreateSessionInFolder(group.id)}
                  >
                    {t('page.newSession', '新建会话')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<PencilSimple size={16} />}
                    onClick={() => onRenameGroup(group)}
                  >
                    {t('page.renameGroup', '重命名分组')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<Gear size={16} />}
                    onClick={() => onEditGroup(group)}
                  >
                    {t('page.editGroup', '编辑分组')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                  <AppMenuItem
                    icon={<Archive size={16} />}
                    onClick={() => onArchiveGroup(group)}
                  >
                    {t('page.archiveGroup', '归档分组')}
                  </AppMenuItem>
                </AppMenuGroup>
              </AppMenuContent>
            </AppMenu>
          </div>
        )}
        </div>

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--panel-ease)]',
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className={cn('space-y-0.5 overflow-hidden pl-4', !isExpanded && 'pointer-events-none')}>
            <AnimatePresence initial={false} mode="popLayout">
              {nonPinnedSessions.map(renderAnimatedSessionRow)}
            </AnimatePresence>
            {trailing}
          </div>
        </div>
      </section>
    );
  };

  const renderStudySidebarContent = (unified = false) => {
    if (isInitialLoading) {
      return null;
    }

    const ungroupedNonPinned = ungroupedSessions.filter((session) => !isSessionPinned(session));
    const activeGroupId = currentSession?.groupId && visibleGroups.some((group) => group.id === currentSession.groupId)
      ? currentSession.groupId
      : (!currentSession?.groupId && currentSession ? 'ungrouped' : null);

    return (
      <div className={cn('space-y-3', unified ? 'pb-0' : 'pb-2 pt-1')}>
        {pinnedSessions.length > 0 && (
          <section className="space-y-0.5">
            <div className="space-y-0.5" role="list" aria-label={t('page.pinnedSessions', '置顶会话')}>
              <AnimatePresence initial={false} mode="popLayout">
                {pinnedSessions.map(renderAnimatedSessionRow)}
              </AnimatePresence>
            </div>
          </section>
        )}

        <section className="space-y-0.5" aria-label={t('page.studySessions', '课题')}>
          <div className="flex items-center justify-between gap-2 pr-0.5">
            <div className="min-w-0 flex-1">
              {renderSectionLabel(t('page.studySessions', '课题'), unified)}
            </div>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onCreateGroup}
              aria-label={t('page.createGroup', '新建分组')}
              title={t('page.createGroup', '新建分组')}
              className="!h-11 !w-11 -my-2.5 shrink-0 text-muted-foreground/80"
            >
              <Plus size={15} />
            </NotionButton>
          </div>
          <div className="space-y-0.5">
            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) =>
                renderFolderRow(
                  group.id,
                  group.name,
                  sessionsByGroup.get(group.id) ?? [],
                  activeGroupId === group.id,
                  unified,
                  undefined,
                  group,
                )
              )
            ) : (
              <div className="px-3 py-2 text-[13px] text-muted-foreground opacity-80">
                {t('page.studySessionsEmpty', '暂无课题')}
              </div>
            )}
          </div>
        </section>

        {(visibleGroups.length > 0 || ungroupedNonPinned.length > 0) && (
          <section className="space-y-0.5" aria-label={t('page.recentSessions', '最近')}>
            {renderSectionLabel(t('page.recentSessions', '最近'), unified)}
            <div className="space-y-0.5">
              {ungroupedNonPinned.length > 0 && renderFolderRow(
                'ungrouped',
                t('page.ungrouped', '未分组'),
                ungroupedNonPinned,
                activeGroupId === 'ungrouped',
                unified,
                hasMoreSessions ? (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => { void loadMoreSessions(); }}
                    disabled={isLoadingMore}
                    className="w-full justify-start gap-2 rounded-2xl px-3 text-[13px] font-normal text-[color:var(--sidebar-muted)] hover:text-[color:var(--sidebar-foreground)]"
                  >
                    {isLoadingMore && <CircleNotch size={14} className="animate-spin" aria-hidden="true" />}
                    <span>{t('page.loadMore', '加载更多')}</span>
                  </NotionButton>
                ) : undefined,
              )}
            </div>
          </section>
        )}

        {/* 归档会话入口：低调常驻（替代仅靠归档 toast 才能发现的隐藏路径） */}
        <section className="space-y-0.5">
          <button
            type="button"
            onClick={openArchivedSessionsSettings}
            className={
              unified
                ? mobileDrawerThreadRowClassName(false, 'group gap-2.5 text-muted-foreground')
                : 'group inline-flex min-h-[2rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-2xl border border-transparent bg-transparent px-2.5 py-1 text-left text-[13px] font-normal leading-none text-[color:var(--sidebar-muted)] outline-none transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)] focus-visible:ring-2 focus-visible:ring-ring select-none'
            }
          >
            <span className={unified ? mobileDrawerRowIconWrapClassName : undefined}>
              <Archive size={unified ? 18 : 15} className={unified ? undefined : 'h-[15px] w-[15px] shrink-0'} />
            </span>
            <span className={unified ? mobileDrawerRowTitleClassName : 'min-w-0 flex-1 truncate'}>{t('page.archivedSessionsEntry', '已归档会话')}</span>
          </button>
        </section>
      </div>
    );
  };

  const buildSessionSidebarBody = (unified: boolean) => (
    <div className="space-y-3 pb-1 pt-1">
      {unified && (
        <span className={mobileDrawerSectionLabelClassName}>
          {t('sidebar:mobile_drawer.section_chat', '会话')}
        </span>
      )}
      <nav aria-label={t('page.primaryNavigation', '主入口')} className="space-y-0.5">
        {renderPrimaryItem('new-chat', t('page.newChat', '新对话'), ChatCenteredText, !currentSessionId, handleCreateSession, unified)}
        {renderPrimaryItem('session-browser', t('browser.allSessions', '所有对话'), SquaresFour, viewMode === 'browser', handleOpenBrowser, unified)}
      </nav>
      {renderStudySidebarContent(unified)}
    </div>
  );

  // 渲染会话侧边栏内容（复用于移动端推拉布局和桌面端面板）
  const renderSessionSidebarContent = (options?: { unifiedMobileDrawer?: boolean }) => {
    const unified = options?.unifiedMobileDrawer ?? false;
    return (
    <ChatErrorBoundary>
    <div className={cn(
      'font-sidebar-study-ui flex min-h-0 flex-col',
      unified
        ? 'text-foreground'
        : 'text-[color:var(--sidebar-foreground)]',
    )}>
      {unified ? (
        buildSessionSidebarBody(true)
      ) : (
        <div className="flex h-full min-h-0 flex-col bg-[color:var(--shell-navigation-surface)]">
          <CustomScrollArea className="min-h-0 flex-1" viewportClassName="px-2 py-1">
            {buildSessionSidebarBody(false)}
          </CustomScrollArea>
        </div>
      )}
    </div>
    </ChatErrorBoundary>
    );
  };

  return { renderSessionSidebarContent };
}
