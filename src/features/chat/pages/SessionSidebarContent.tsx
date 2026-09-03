import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import {
  Archive,
  CaretRight,
  ChatCenteredText,
  CircleNotch,
  DotsThree,
  Folder,
  Gear,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SquaresFour,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
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
import { getSessionTitleText } from '../utils/sessionTitle';
import { getSidebarStudyRowClassName } from './sessionSidebarStyles';
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

/** 「最近」扁平列表条数（跨分组、排除置顶，对齐 ChatGPT/Cursor 的最近会话语义） */
const RECENT_FLAT_SESSION_LIMIT = 5;

export interface UseSessionSidebarContentDeps {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  viewMode: 'sidebar' | 'browser';
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** 可编辑（active）分组 ID 集合：仅这些分组显示重命名/编辑/归档菜单 */
  editableGroupIds: Set<string>;
  onCreateGroup: () => void;
  onRenameGroup: (group: SessionGroup) => void;
  onEditGroup: (group: SessionGroup) => void;
  /** 归档分组（本组件先做行内二次确认，确认后才调用） */
  onArchiveGroup: (group: SessionGroup) => void;
  isInitialLoading: boolean;
  sessions: ChatSession[];
  visibleGroups: SessionGroup[];
  sessionsByGroup: Map<string, ChatSession[]>;
  ungroupedSessions: ChatSession[];
  currentSessionId: string | null;
  hasMoreSessions: boolean;
  isLoadingMore: boolean;
  t: TFunction<any, any>;
  resetDeleteConfirmation: () => void;
  createSession: (groupId?: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  renderSessionItem: (session: ChatSession, drag?: SessionDragState) => React.ReactNode;
  /** 会话拖入分组：提供后启用 dnd-kit DnD（droppable id: session-group:<id> / session-ungrouped） */
  onSessionDragEnd?: (event: DragEndEvent) => void;
}

/** 会话行拖拽包装（dnd-kit useDraggable）：仅跨容器移动会话到分组，不做组内排序 */
const DraggableSessionRow: React.FC<{
  session: ChatSession;
  /** 所在容器的 droppable id：拖回原容器时 handleDragEnd 据此忽略 */
  sourceDroppableId: string;
  renderSessionItem: (session: ChatSession, drag?: SessionDragState) => React.ReactNode;
}> = ({ session, sourceDroppableId, renderSessionItem }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session:${session.id}`,
    data: { sourceDroppableId },
  });

  return (
    <>
      {renderSessionItem(session, {
        setNodeRef,
        attributes,
        listeners,
        isDragging,
        // 源行降透明度作占位；拖拽预览由 DragOverlay 渲染
        // （折叠容器 overflow-hidden 会裁剪 transform 位移的源行，故不在源行上做位移）
        style: isDragging ? { opacity: 0.4 } : undefined,
      })}
    </>
  );
};

/** 分组会话列表放置区（dnd-kit useDroppable）：拖入高亮与迁移前 isDraggingOver 一致 */
const SessionDropZone: React.FC<{
  droppableId: string;
  children: React.ReactNode;
}> = ({ droppableId, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'space-y-0.5 rounded-2xl transition-colors duration-150',
        isOver && 'bg-[color:var(--interactive-hover)] ring-1 ring-primary/25'
      )}
    >
      {children}
    </div>
  );
};

export function useSessionSidebarContent(deps: UseSessionSidebarContentDeps) {
  const {
    searchQuery, setSearchQuery, viewMode, setViewMode, setSessionSheetOpen,
    editableGroupIds, onCreateGroup, onRenameGroup, onEditGroup, onArchiveGroup,
    isInitialLoading, sessions, visibleGroups, sessionsByGroup, ungroupedSessions,
    currentSessionId,
    hasMoreSessions, isLoadingMore,
    t,
    resetDeleteConfirmation,
    createSession, loadMoreSessions,
    renderSessionItem,
    onSessionDragEnd,
  } = deps;

  const prefersReducedMotion = useReducedMotion();

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedSearchQuery.length > 0;

  // 分组归档行内确认（替代 DsAlertDialog），6s 无操作自动复位
  const [pendingArchiveGroupId, setPendingArchiveGroupId] = React.useState<string | null>(null);
  const archiveConfirmTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearArchiveConfirm = React.useCallback(() => {
    if (archiveConfirmTimeoutRef.current) {
      clearTimeout(archiveConfirmTimeoutRef.current);
      archiveConfirmTimeoutRef.current = null;
    }
    setPendingArchiveGroupId(null);
  }, []);
  const requestArchiveConfirm = React.useCallback((groupId: string) => {
    if (archiveConfirmTimeoutRef.current) {
      clearTimeout(archiveConfirmTimeoutRef.current);
    }
    setPendingArchiveGroupId(groupId);
    archiveConfirmTimeoutRef.current = setTimeout(() => {
      archiveConfirmTimeoutRef.current = null;
      setPendingArchiveGroupId(null);
    }, 6000);
  }, []);
  React.useEffect(() => () => {
    if (archiveConfirmTimeoutRef.current) {
      clearTimeout(archiveConfirmTimeoutRef.current);
    }
  }, []);

  // ===== 会话拖入分组（dnd-kit）=====
  // DND-1 统一传感器：鼠标 8px 起拖（保留行点击）、触屏长按 250ms、键盘可访问拖放
  const sessionDndSensors = useTouchFriendlyDndSensors();
  const [activeDragSessionId, setActiveDragSessionId] = React.useState<string | null>(null);
  const activeDragSession = React.useMemo(
    () => (activeDragSessionId
      ? sessions.find((session) => session.id === activeDragSessionId) ?? null
      : null),
    [activeDragSessionId, sessions]
  );

  const handleSessionDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveDragSessionId(String(event.active.id).replace(/^session:/, ''));
  }, []);

  const handleSessionDragCancel = React.useCallback(() => {
    setActiveDragSessionId(null);
  }, []);

  const handleSessionDragEnd = React.useCallback((event: DragEndEvent) => {
    setActiveDragSessionId(null);
    clearArchiveConfirm();
    onSessionDragEnd?.(event);
  }, [clearArchiveConfirm, onSessionDragEnd]);

  const handleSearchChange = React.useCallback((value: string) => {
    // 开始输入时复位待确认的删除/归档，避免过滤后确认条挂在错误的行上
    resetDeleteConfirmation();
    clearArchiveConfirm();
    setSearchQuery(value);
  }, [clearArchiveConfirm, resetDeleteConfirmation, setSearchQuery]);

  // 会话行进出场（transitions-dev 观感）：新建 fade+4px 上升，删除/归档 fade+轻缩，
  // 兄弟行经 layout 平滑补位；列表首挂载不动画（AnimatePresence initial={false}）
  // 流式/未读/阻塞指示由 SessionItemRenderer 行尾槽渲染（与桌面 ModernSidebar 同一数据源），此处不再叠加
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

  // 标题匹配（与 ChatV2Page 的 filteredSessions 同一规则；deps.sessions 是未过滤全量列表）
  const matchesSearchQuery = React.useCallback(
    (session: ChatSession) =>
      !normalizedSearchQuery
      || getSessionTitleText(session.title, '').toLowerCase().includes(normalizedSearchQuery),
    [normalizedSearchQuery]
  );

  const pinnedSessions = React.useMemo(
    () => sortedSessions.filter(isSessionPinned).filter(matchesSearchQuery),
    [matchesSearchQuery, sortedSessions]
  );

  // 「最近」= 桌面侧栏跨分组扁平最近会话（排除置顶）。移动端不再按日历桶重复列出。
  const recentFlatSessions = React.useMemo(
    () => sessions
      .filter((session) => !isSessionPinned(session))
      .filter(matchesSearchQuery)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, RECENT_FLAT_SESSION_LIMIT),
    [matchesSearchQuery, sessions]
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
      } else if (!currentGroupId && currentSession) {
        if (!next.has('ungrouped')) {
          next.add('ungrouped');
          changed = true;
        }
      } else if (!currentGroupId && next.size === 0 && visibleGroups[0]) {
        next.add(visibleGroups[0].id);
        changed = true;
      }

      return changed ? next : current;
    });
  }, [currentSession, visibleGroups]);

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
          className={unified ? undefined : 'h-[18px] w-[18px] shrink-0 text-[color:var(--sidebar-foreground)]'}
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
    // 搜索时强制展开，保证命中结果可见（不污染持久化的展开状态）
    const isExpanded = isSearching || expandedGroupIds.has(id);
    const nonPinnedSessions = sessionsForFolder.filter((session) => !isSessionPinned(session));
    const createSessionLabel = id === 'ungrouped'
      ? t('page.newSession')
      : t('page.newSessionInGroup', {groupName: label});
    // 触屏无 hover：常显「…」菜单承载分组的新建会话/重命名/编辑/归档（与桌面 ModernSidebar 分组操作对齐）
    const hasGroupMenu = !!group && editableGroupIds.has(group.id);
    // droppable id 契约与迁移前一致：useSessionEdit.handleDragEnd 据此识别目标分组
    const droppableId = id === 'ungrouped' ? 'session-ungrouped' : `session-group:${id}`;

    return (
      <section key={id} className="space-y-1">
        <div className="relative">
          <DsButton
            variant="ghost"
            size="sm"
            type="button"
            aria-expanded={isExpanded}
            onClick={() => toggleGroup(id)}
            className={
              unified
                ? mobileDrawerThreadRowClassName(
                    active,
                    cn('group gap-2.5', hasGroupMenu ? '!pr-20' : '!pr-12'),
                  )
                : getSidebarStudyRowClassName({
                    variant: 'section',
                    selected: active,
                    className: cn(
                      'appearance-none overflow-hidden whitespace-nowrap text-left text-[16px] font-normal leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring select-none [&_svg]:shrink-0 [&_svg]:text-inherit',
                      hasGroupMenu ? '!pr-20' : '!pr-12',
                    ),
                  })
            }
          >
            <span className={unified ? mobileDrawerRowIconWrapClassName : undefined}>
              <Folder size={18} className={unified ? undefined : 'h-[18px] w-[18px] shrink-0 text-[color:var(--sidebar-foreground)]'} />
            </span>
            <span className={unified ? mobileDrawerRowTitleClassName : 'truncate'}>{label}</span>
            <CaretRight
              size={14}
              className={cn(
                'ml-auto shrink-0 text-[color:var(--sidebar-muted)] transition-transform duration-150 ease-[var(--dropdown-ease)] motion-reduce:transition-none',
                isExpanded && 'rotate-90'
              )}
            />
          </DsButton>
          <div className="absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="lg:!h-10 lg:!w-10 !p-0 text-[color:var(--sidebar-muted)] hover:text-[color:var(--sidebar-foreground)]"
              aria-label={createSessionLabel}
              title={createSessionLabel}
              onClick={() => handleCreateSessionInFolder(id)}
            >
              <Plus size={15} />
            </DsButton>
            {hasGroupMenu && group && (
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="lg:!h-10 lg:!w-10 !p-0 text-[color:var(--sidebar-muted)] hover:text-[color:var(--sidebar-foreground)]"
                    aria-label={t('page.groupActions')}
                    title={t('page.groupActions')}
                  >
                    <DotsThree size={18} className="text-muted-foreground/80" />
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" width={200}>
                  <AppMenuGroup>
                    <AppMenuItem
                      icon={<Plus size={16} />}
                      onClick={() => handleCreateSessionInFolder(group.id)}
                    >
                      {t('page.newSession')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<PencilSimple size={16} />}
                      onClick={() => onRenameGroup(group)}
                    >
                      {t('page.renameGroup')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<Gear size={16} />}
                      onClick={() => onEditGroup(group)}
                    >
                      {t('page.editGroup')}
                    </AppMenuItem>
                    <AppMenuSeparator />
                    <AppMenuItem
                      icon={<Archive size={16} />}
                      onClick={() => requestArchiveConfirm(group.id)}
                    >
                      {t('page.archiveGroup')}
                    </AppMenuItem>
                  </AppMenuGroup>
                </AppMenuContent>
              </AppMenu>
            )}
          </div>
        </div>

        {/* 分组归档行内确认条（替代模态确认框） */}
        {group && pendingArchiveGroupId === group.id && (
          <div
            role="alertdialog"
            aria-label={t('page.archiveGroupTitle')}
            className="mx-1 flex items-center gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2"
          >
            <span className="min-w-0 flex-1 text-ui leading-4 text-foreground/90">
              {t('page.archiveGroupConfirmInline', { name: group.name })}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {/* 破坏性操作确认按钮：移动/平板保持较大触控目标，桌面 lg 起紧凑 */}
              <DsButton
                variant="warning"
                size="sm"
                className="lg:!h-7 !px-2 text-[12px]"
                onClick={() => {
                  clearArchiveConfirm();
                  onArchiveGroup(group);
                }}
              >
                {t('page.archiveGroupConfirm')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="lg:!h-7 lg:!w-7"
                aria-label={t('common:cancel')}
                onClick={clearArchiveConfirm}
              >
                <X size={13} />
              </DsButton>
            </div>
          </div>
        )}

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--panel-ease)]',
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className={cn('space-y-0.5 overflow-hidden pl-4', !isExpanded && 'pointer-events-none')}>
            {onSessionDragEnd ? (
              <SessionDropZone droppableId={droppableId}>
                {nonPinnedSessions.map((session) => (
                  <DraggableSessionRow
                    key={`session:${session.id}`}
                    session={session}
                    sourceDroppableId={droppableId}
                    renderSessionItem={renderSessionItem}
                  />
                ))}
              </SessionDropZone>
            ) : (
              <AnimatePresence initial={false} mode="popLayout">
                {nonPinnedSessions.map(renderAnimatedSessionRow)}
              </AnimatePresence>
            )}
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
    const hasAnySearchResult = pinnedSessions.length > 0
      || visibleGroups.length > 0
      || ungroupedNonPinned.length > 0;

    if (isSearching && !hasAnySearchResult) {
      return (
        <div className="px-3 py-6 text-center text-ui text-muted-foreground">
          {t('browser.noResults')}
        </div>
      );
    }

    const ungroupedFolder = (ungroupedNonPinned.length > 0 || !isSearching) ? (
      renderFolderRow(
        'ungrouped',
        t('page.ungrouped'),
        ungroupedNonPinned,
        activeGroupId === 'ungrouped',
        unified,
        hasMoreSessions ? (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => { void loadMoreSessions(); }}
            disabled={isLoadingMore}
            className="w-full justify-start gap-2 rounded-2xl px-3 text-ui font-normal text-[color:var(--sidebar-muted)] hover:text-[color:var(--sidebar-foreground)]"
          >
            {isLoadingMore && <CircleNotch size={14} className="animate-spin" aria-hidden="true" />}
            <span>{t('page.loadMore')}</span>
          </DsButton>
        ) : undefined,
      )
    ) : null;

    return (
      <div className={cn('space-y-2.5', unified ? 'pb-0' : 'pb-2 pt-1')}>
        {pinnedSessions.length > 0 && (
          <section className="space-y-0.5">
            <div className="space-y-0.5" role="list" aria-label={t('page.pinnedSessions')}>
              <AnimatePresence initial={false} mode="popLayout">
                {pinnedSessions.map(renderAnimatedSessionRow)}
              </AnimatePresence>
            </div>
          </section>
        )}

        <section className="space-y-1" aria-label={t('page.studySessions')}>
          <div className={cn('flex items-center justify-between gap-2', unified ? 'rounded-xl px-1' : 'pr-0.5')}>
            <div className="min-w-0 flex-1">
              {renderSectionLabel(t('page.studySessions'), unified)}
            </div>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onCreateGroup}
              aria-label={t('page.createGroup')}
              title={t('page.createGroup')}
              className="lg:!h-10 lg:!w-10 -my-2 shrink-0 text-muted-foreground/80"
            >
              <Plus size={15} />
            </DsButton>
          </div>
          <div className="space-y-1">
            {visibleGroups.map((group) =>
              renderFolderRow(
                group.id,
                group.name,
                sessionsByGroup.get(group.id) ?? [],
                activeGroupId === group.id,
                unified,
                undefined,
                group,
              )
            )}
            {ungroupedFolder}
            {visibleGroups.length === 0 && !ungroupedFolder && !isSearching ? (
              <div className="px-3 py-2 text-ui text-muted-foreground opacity-80">
                {t('page.studySessionsEmpty')}
              </div>
            ) : null}
          </div>
        </section>

        {/* 桌面：「最近」跨分组扁平列表。移动端会话只走课题夹（含未分组）。 */}
        {!unified && recentFlatSessions.length > 0 && (
          <section className="space-y-0.5" aria-label={t('page.recentSessions')}>
            {renderSectionLabel(t('page.recentSessions'), unified)}
            <div className="space-y-0.5" role="list">
              <AnimatePresence initial={false} mode="popLayout">
                {recentFlatSessions.map(renderAnimatedSessionRow)}
              </AnimatePresence>
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
                : 'group inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-xl border border-transparent bg-transparent px-2.5 py-1.5 text-ui font-normal leading-none text-[color:var(--sidebar-muted)] outline-none transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--sidebar-foreground)] focus-visible:ring-2 focus-visible:ring-ring select-none'
            }
          >
            <span className={unified ? mobileDrawerRowIconWrapClassName : undefined}>
              <Archive size={unified ? 18 : 15} className={unified ? undefined : 'h-[15px] w-[15px] shrink-0'} />
            </span>
            <span className={unified ? mobileDrawerRowTitleClassName : 'min-w-0 flex-1 truncate'}>{t('page.archivedSessionsEntry')}</span>
          </button>
        </section>
      </div>
    );
  };

  // 侧栏内联搜索框（接通 ChatV2Page 的 searchQuery 过滤链路，替代原先被 void 的死状态）
  const renderSearchInput = () => (
    <div className="relative px-3">
      <MagnifyingGlass
        size={18}
        className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-[color:var(--sidebar-muted)]"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={searchQuery}
        onChange={(event) => handleSearchChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && searchQuery) {
            event.stopPropagation();
            handleSearchChange('');
          }
        }}
        placeholder={t('page.searchPlaceholder')}
        aria-label={t('page.searchPlaceholder')}
        className={cn(
          'h-11 min-h-0 w-full rounded-xl border border-border/80 bg-muted/50 pl-11 pr-10 text-[16px] shadow-none',
          // 📱 coarse 指针下 16px 防 iOS 聚焦自动放大
          '[@media(pointer:coarse)]:text-[16px]',
          'text-[color:var(--sidebar-foreground)] placeholder:text-[color:var(--sidebar-muted)]',
          'transition-colors duration-150 focus:border-primary/40 focus:bg-background'
        )}
      />
      {searchQuery && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="absolute right-4 top-1/2 !h-8 !w-8 -translate-y-1/2 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']"
          aria-label={t('page.clearSearch')}
          onClick={() => handleSearchChange('')}
        >
          <X size={12} />
        </DsButton>
      )}
    </div>
  );

  const renderUnifiedMobileSidebarHeader = React.useCallback(() => (
    <p
      data-mobile-sidebar-fixed-region="top"
      className="min-w-0 truncate text-[22px] font-bold leading-none text-foreground"
    >
      DeepStudent
    </p>
  ), []);

  const buildSessionSidebarBody = (unified: boolean, includeUnifiedHeader = true) => {
    const shouldShowSearch = !unified || sessions.length >= 6 || searchQuery.length > 0;
    const shouldRenderUnifiedHeader = unified && includeUnifiedHeader;
    const body = (
      <div className={cn('space-y-2.5 pb-1', unified ? (shouldRenderUnifiedHeader ? 'pt-2' : 'pt-3') : 'pt-1')}>
        {shouldRenderUnifiedHeader ? renderUnifiedMobileSidebarHeader() : null}
        {!unified ? (
          <nav aria-label={t('page.primaryNavigation')} className="space-y-0.5">
            {renderPrimaryItem('new-chat', t('page.newChat'), ChatCenteredText, !currentSessionId, handleCreateSession, false)}
            {renderPrimaryItem('session-browser', t('browser.allSessions'), SquaresFour, viewMode === 'browser', handleOpenBrowser, false)}
          </nav>
        ) : null}
        {!isInitialLoading && shouldShowSearch && renderSearchInput()}
        {renderStudySidebarContent(unified)}
      </div>
    );

    return onSessionDragEnd ? (
      <DndContext
        sensors={sessionDndSensors}
        autoScroll={SHELL_SAFE_AUTO_SCROLL}
        collisionDetection={pointerWithin}
        onDragStart={handleSessionDragStart}
        onDragEnd={handleSessionDragEnd}
        onDragCancel={handleSessionDragCancel}
      >
        {body}
        {/* 拖拽预览渲染到 body：避免移动抽屉 transform 祖先使 fixed 定位错位，
            也不受折叠容器 overflow-hidden / 滚动区裁剪 */}
        {createPortal(
          <DragOverlay
            dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
          >
            {activeDragSession ? (
              <div className="pointer-events-none">
                {renderSessionItem(activeDragSession)}
              </div>
            ) : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>
    ) : body;
  };

  // 渲染会话侧边栏内容（复用于移动端推拉布局和桌面端面板）
  const renderSessionSidebarContent = (options?: {
    unifiedMobileDrawer?: boolean;
    mobileDrawerHeader?: 'inline' | 'fixed';
  }) => {
    const unified = options?.unifiedMobileDrawer ?? false;
    const includeUnifiedHeader = options?.mobileDrawerHeader !== 'fixed';
    return (
    <ChatErrorBoundary>
    <div className={cn(
      'font-sidebar-study-ui flex min-h-0 flex-col',
      unified
        ? 'text-foreground'
        : 'text-[color:var(--sidebar-foreground)]',
    )}>
      {unified ? (
        buildSessionSidebarBody(true, includeUnifiedHeader)
      ) : (
        <div className="flex h-full min-h-0 flex-col bg-[color:var(--shell-navigation-surface)]">
          <CustomScrollArea className="min-h-0 flex-1" viewportClassName="h-full w-full min-h-0">
            {/* OverlayScrollbars 会清零 viewport padding，边距放在内层 */}
            <div className="px-2 py-1">
              {buildSessionSidebarBody(false)}
            </div>
          </CustomScrollArea>
        </div>
      )}
    </div>
    </ChatErrorBoundary>
    );
  };

  return {
    renderSessionSidebarContent,
    renderSessionSidebarHeader: renderUnifiedMobileSidebarHeader,
  };
}
