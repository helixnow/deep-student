import React from 'react';
import { Plus, MessageSquare, Trash2, X, LayoutGrid, ChevronRight, RefreshCw, Folder, Loader2 } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import {
  DndContext as DndKitContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { SortableGroupItem } from '../components/SortableGroupItem';
import { UnifiedSidebarSection } from '@/components/ui/unified-sidebar/UnifiedSidebarSection';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChatErrorBoundary } from '../components/ChatErrorBoundary';
import { AdvancedPanel } from '../plugins/chat/AdvancedPanel';
import { sessionManager } from '../core/session/sessionManager';
import { getSessionTitleText } from '../utils/sessionTitle';
import type { SessionDragState } from './SessionItemRenderer';
import type { TimeGroup } from './timeGroups';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import type { DropResult } from '@hello-pangea/dnd';
import type { TFunction } from 'i18next';

export interface UseSessionSidebarContentDeps {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  viewMode: 'sidebar' | 'browser';
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShowEmptyTrashConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  showTrash: boolean;
  showChatControl: boolean;
  deletedSessions: ChatSession[];
  isLoadingTrash: boolean;
  isInitialLoading: boolean;
  sessions: ChatSession[];
  groups: SessionGroup[];
  isGroupsLoading: boolean;
  currentSessionId: string | null;
  totalSessionCount: number | null;
  ungroupedSessionCount: number | null;
  ungroupedSessions: ChatSession[];
  hasMoreSessions: boolean;
  isLoadingMore: boolean;
  pendingDeleteSessionId: string | null;
  collapsedMap: Record<string, boolean>;
  sessionsByGroup: Map<string, ChatSession[]>;
  visibleGroups: SessionGroup[];
  groupDragDisabled: boolean;
  groupedSessions: Map<TimeGroup, ChatSession[]>;
  timeGroupLabels: Record<TimeGroup, string>;
  t: TFunction<any, any>;
  toggleTrash: () => void;
  toggleGroupCollapse: (groupId: string) => void;
  resetDeleteConfirmation: () => void;
  clearDeleteConfirmTimeout: () => void;
  deleteConfirmTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  createSession: (groupId?: string) => Promise<void>;
  restoreSession: (sessionId: string) => Promise<void>;
  permanentlyDeleteSession: (sessionId: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  openCreateGroup: () => void;
  openEditGroup: (group: SessionGroup) => void;
  openRenameGroup: (group: SessionGroup) => void;
  requestDeleteGroup: (group: SessionGroup) => void;
  handleGroupReorder: (event: DragEndEvent) => void;
  handleDragEnd: (result: DropResult) => void;
  renderSessionItem: (session: ChatSession, drag?: SessionDragState) => React.ReactNode;
}

export function useSessionSidebarContent(deps: UseSessionSidebarContentDeps) {
  const {
    searchQuery, setSearchQuery, viewMode, setViewMode, setSessionSheetOpen,
    setShowEmptyTrashConfirm, setShowChatControl, setPendingDeleteSessionId,
    showTrash, showChatControl, deletedSessions, isLoadingTrash,
    isInitialLoading, sessions, groups, isGroupsLoading,
    currentSessionId, totalSessionCount, ungroupedSessionCount, ungroupedSessions,
    hasMoreSessions, isLoadingMore, pendingDeleteSessionId,
    collapsedMap, sessionsByGroup, visibleGroups, groupDragDisabled,
    groupedSessions, timeGroupLabels, t,
    toggleTrash, toggleGroupCollapse,
    resetDeleteConfirmation, clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    createSession, restoreSession, permanentlyDeleteSession, loadMoreSessions,
    openCreateGroup, openEditGroup, openRenameGroup, requestDeleteGroup,
    handleGroupReorder, handleDragEnd, renderSessionItem,
  } = deps;

  // @dnd-kit sensors: long-press 300ms to trigger group drag
  const groupDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 300, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // 渲染会话侧边栏内容（复用于移动端推拉布局和桌面端面板）
  const renderSessionSidebarContent = () => (
    <ChatErrorBoundary>
    <>
      {/* 搜索框 */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('page.searchPlaceholder')}
            className="w-full h-[37px] px-3 text-[16px] rounded-2xl border border-[color:var(--sidebar-study-border)] bg-background/70
                       placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* 浏览所有对话入口 + 回收站入口 */}
      <div className="px-3 py-2 shrink-0 space-y-1.5">
        <NotionButton
          variant="ghost"
          size="md"
          onClick={() => {
            setShowChatControl(false);
            setViewMode(viewMode === 'browser' ? 'sidebar' : 'browser');
            setSessionSheetOpen(false);
          }}
          className={cn(
            'w-full justify-between px-3 py-[11px] group rounded-2xl text-foreground/85 hover:text-foreground hover:bg-[var(--sidebar-study-hover)]',
            viewMode === 'browser' && 'bg-[var(--sidebar-study-selected)] text-foreground hover:bg-[var(--sidebar-study-selected)]'
          )}
        >
          <div className="flex items-center gap-2.5">
            <LayoutGrid className="w-[18px] h-[18px] text-muted-foreground group-hover:text-foreground" />
            <span className="text-[16px] font-medium">{t('browser.allSessions')}</span>
            <span className="text-xs text-muted-foreground">{totalSessionCount ?? sessions.length}</span>
          </div>
          <ChevronRight className="w-[18px] h-[18px] text-muted-foreground group-hover:text-foreground" />
        </NotionButton>

        {/* 🔧 P1-29: 回收站入口（移动端）- 与桌面端一致，不关闭侧边栏 */}
        <NotionButton
          variant="ghost"
          size="md"
          onClick={toggleTrash}
          className={cn(
            'w-full justify-between px-3 py-[9px] group rounded-2xl text-foreground/85 hover:text-foreground hover:bg-[var(--sidebar-study-hover)]',
            showTrash && 'bg-[var(--sidebar-study-selected)] text-foreground hover:bg-[var(--sidebar-study-selected)]'
          )}
        >
          <div className="flex items-center gap-2.5">
            <Trash2 className={cn(
              'w-[18px] h-[18px]',
              showTrash ? 'text-destructive' : 'text-muted-foreground group-hover:text-foreground'
            )} />
            <span className="text-[16px] font-medium">
              {t('page.trash')}
            </span>
            {deletedSessions.length > 0 && (
              <span className="text-xs text-muted-foreground">{deletedSessions.length}</span>
            )}
          </div>
          <ChevronRight className={cn(
            'w-[18px] h-[18px] transition-transform',
            showTrash ? 'rotate-90 text-foreground' : 'text-muted-foreground group-hover:text-foreground'
          )} />
        </NotionButton>

      </div>

      {/* 会话列表或回收站或对话控制内容 */}
      <CustomScrollArea className="flex-1">
        {showChatControl ? (
          /* 🆕 对话控制视图（移动端） */
          <div className="px-2 py-2 h-full">
            {currentSessionId && sessionManager.get(currentSessionId) ? (
              <AdvancedPanel
                store={sessionManager.get(currentSessionId)!}
                onClose={() => setShowChatControl(false)}
                sidebarMode
              />
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4">
                {t('page.selectSessionFirst')}
              </div>
            )}
          </div>
        ) : showTrash ? (
          /* 🔧 P1-29: 回收站视图（移动端） */
          <>
            {/* 回收站标题和清空按钮 */}
            <div className="px-3 py-2 flex items-center justify-between border-b border-border/40 mb-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('page.trashTitle')}
              </span>
              {deletedSessions.length > 0 && (
                <NotionButton
                  variant="danger"
                  size="sm"
                  onClick={() => setShowEmptyTrashConfirm(true)}
                  title={t('page.emptyTrash')}
                >
                  {t('page.emptyTrash')}
                </NotionButton>
              )}
            </div>

            {/* 已删除会话列表 */}
            {isLoadingTrash ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : deletedSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Trash2 className="w-10 h-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('page.trashEmpty')}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {deletedSessions.map((session) => (
                  <div
                    key={session.id}
                    className="group flex items-center gap-2.5 px-3 py-2 mx-1 rounded-2xl hover:bg-[var(--sidebar-study-hover)] transition-[background-color,color,box-shadow] duration-150"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground/80 line-clamp-1">
                        {getSessionTitleText(session.title, t('page.untitled'))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* 恢复按钮 */}
                      <NotionButton
                        variant="success"
                        size="icon"
                        iconOnly
                        onClick={() => restoreSession(session.id)}
                        aria-label={t('page.restoreSession')}
                        title={t('page.restoreSession')}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </NotionButton>
                      {/* 永久删除按钮 */}
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={() => {
                          if (pendingDeleteSessionId === session.id) {
                            resetDeleteConfirmation();
                            permanentlyDeleteSession(session.id);
                          } else {
                            setPendingDeleteSessionId(session.id);
                            clearDeleteConfirmTimeout();
                            deleteConfirmTimeoutRef.current = setTimeout(() => {
                              resetDeleteConfirmation();
                            }, 2500);
                          }
                        }}
                        className={cn(
                          'hover:bg-destructive/20 text-muted-foreground hover:text-destructive',
                          pendingDeleteSessionId === session.id && 'text-destructive bg-destructive/10'
                        )}
                        aria-label={
                          pendingDeleteSessionId === session.id
                            ? t('common:confirm_delete')
                            : t('page.permanentDelete')
                        }
                        title={
                          pendingDeleteSessionId === session.id
                            ? t('common:confirm_delete')
                            : t('page.permanentDelete')
                        }
                      >
                        {pendingDeleteSessionId === session.id ? (
                          <Trash2 className="w-4 h-4" />
                        ) : (
                          <X className="w-4 h-4" />
                        )}
                      </NotionButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (!isInitialLoading && sessions.length === 0 && groups.length === 0) ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <MessageSquare className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">
              {t('page.noSessions')}
            </p>
            <NotionButton
              variant="primary"
              size="sm"
              onClick={() => createSession()}
            >
              {t('page.createFirst')}
            </NotionButton>
          </div>
        ) : (
          <div className="py-1 space-y-2">
            {/* 分组区域 */}
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[13px] font-normal text-muted-foreground/60">
                {t('page.groups')}
              </span>
              <NotionButton
                variant="ghost"
                size="sm"
                iconOnly
                onClick={openCreateGroup}
                title={t('page.createGroup')}
              >
                <Plus className="w-4 h-4" />
              </NotionButton>
            </div>

            {isGroupsLoading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('common:loading')}
              </div>
            ) : (
              <DndKitContext
                sensors={groupDragSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleGroupReorder}
              >
                <SortableContext
                  items={visibleGroups.map(g => g.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <div className="space-y-2">
                      {visibleGroups.map((group) => (
                        <SortableGroupItem
                          key={group.id}
                          group={group}
                          groupSessions={sessionsByGroup.get(group.id) || []}
                          isCollapsed={collapsedMap[group.id] ?? false}
                          groupDragDisabled={groupDragDisabled}
                          toggleGroupCollapse={toggleGroupCollapse}
                          openEditGroup={openEditGroup}
                          openRenameGroup={openRenameGroup}
                          requestDeleteGroup={requestDeleteGroup}
                          createSession={createSession}
                          renderSessionItem={renderSessionItem}
                          t={t}
                        />
                      ))}
                    </div>

                {/* 未分组区域 */}
                <Droppable droppableId="session-ungrouped" type="SESSION">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={cn(snapshot.isDraggingOver && 'bg-[var(--sidebar-study-hover)] rounded-2xl')}
                    >
                      <UnifiedSidebarSection
                        id="ungrouped"
                        title={t('page.ungrouped')}
                        icon={Folder}
                        count={ungroupedSessionCount ?? ungroupedSessions.length}
                        open={!(collapsedMap.ungrouped ?? false)}
                        onOpenChange={() => toggleGroupCollapse('ungrouped')}
                        twoLineLayout
                        quickAction={
                          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); createSession(); }} aria-label={t('page.newSession')} title={t('page.newSession')} className="!h-6 !w-6">
                            <Plus className="w-3.5 h-3.5" />
                          </NotionButton>
                        }
                      >
                      {(ungroupedSessionCount ?? ungroupedSessions.length) === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            {t('page.noUngroupedSessions')}
                          </div>
                        ) : (
                          (() => {
                            let ungroupedIndex = 0;
                            return (['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'] as TimeGroup[]).map((timeGroup) => {
                              const groupSessions = groupedSessions.get(timeGroup) || [];
                              if (groupSessions.length === 0) return null;

                              return (
                                <div key={timeGroup} className="mb-1">
                                  <div className="px-3 py-1.5">
                                    <span className="text-[11px] font-normal text-muted-foreground/60">
                                      {timeGroupLabels[timeGroup]}
                                    </span>
                                  </div>
                                  <div className="space-y-0.5">
                                    {groupSessions.map((session) => {
                                      const index = ungroupedIndex;
                                      ungroupedIndex += 1;
                                      return (
                                        <Draggable
                                          key={`session:${session.id}`}
                                          draggableId={`session:${session.id}`}
                                          index={index}
                                        >
                                          {(sessionProvided, sessionSnapshot) =>
                                            renderSessionItem(session, {
                                              provided: sessionProvided,
                                              snapshot: sessionSnapshot,
                                            })
                                          }
                                        </Draggable>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            });
                          })()
                        )}
                      </UnifiedSidebarSection>
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
                  </DragDropContext>
                </SortableContext>
              </DndKitContext>
            )}

            {/* P1-22: 加载更多按钮（移动端 - 列表内滚动） */}
            {hasMoreSessions && sessions.length > 0 && (
              <div className="px-3 py-2">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={loadMoreSessions}
                  disabled={isLoadingMore}
                  className="w-full"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('page.loading')}
                    </>
                  ) : (
                    t('page.loadMore')
                  )}
                </NotionButton>
              </div>
            )}
          </div>
        )}
      </CustomScrollArea>

    </>
    </ChatErrorBoundary>
  );

  return { renderSessionSidebarContent };
}
