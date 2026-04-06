import React, { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Edit2, Check, X, Loader2, Trash2, Folder } from 'lucide-react';
import { type DraggableProvided, type DraggableStateSnapshot } from '@hello-pangea/dnd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { PRESET_ICONS } from '../components/groups/GroupEditorDialog';
import { shouldShowSessionActionButtons } from './sessionItemActionVisibility';
import { getSessionTitleText } from '../utils/sessionTitle';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { TFunction } from 'i18next';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export type SessionDragState = {
  provided: DraggableProvided;
  snapshot: DraggableStateSnapshot;
};

export interface UseSessionItemRendererDeps {
  editingSessionId: string | null;
  hoveredSessionId: string | null;
  currentSessionId: string | null;
  pendingDeleteSessionId: string | null;
  editingTitle: string;
  renamingSessionId: string | null;
  renameError: string | null;
  groups: SessionGroup[];
  sessions: ChatSession[];
  totalSessionCount: number | null;
  t: TFunction<any, any>;
  resetDeleteConfirmation: () => void;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setHoveredSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;
  setPendingDeleteSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  clearDeleteConfirmTimeout: () => void;
  deleteConfirmTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  startEditSession: (session: ChatSession, e: React.MouseEvent) => void;
  saveSessionTitle: (sessionId: string) => Promise<void>;
  cancelEditSession: () => void;
  moveSessionToGroup: (sessionId: string, groupId?: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
}

export const resolveDragStyle = (
  style: React.CSSProperties | undefined,
  isDragging: boolean
) => (isDragging && style ? { ...style, left: 'auto', top: 'auto' } : style);

export function useSessionItemRenderer(deps: UseSessionItemRendererDeps) {
  const {
    editingSessionId, hoveredSessionId, currentSessionId, pendingDeleteSessionId,
    editingTitle, renamingSessionId, renameError, groups, sessions, totalSessionCount,
    t, resetDeleteConfirmation, setCurrentSessionId, setHoveredSessionId,
    setEditingTitle, setPendingDeleteSessionId, setSessions, setViewMode,
    clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    startEditSession, saveSessionTitle, cancelEditSession,
    moveSessionToGroup, deleteSession,
  } = deps;

  // 渲染单个会话项 - Notion 风格
  const renderSessionItem = (session: ChatSession, drag?: SessionDragState) => {
    const sessionTitle = getSessionTitleText(session.title, t('page.untitled'));
    const showActionButtons = shouldShowSessionActionButtons({
      isEditing: editingSessionId === session.id,
      isHovered: hoveredSessionId === session.id,
      isSelected: currentSessionId === session.id,
    });

    return (
      <div
      ref={drag?.provided.innerRef}
      {...drag?.provided.draggableProps}
      {...drag?.provided.dragHandleProps}
      style={resolveDragStyle(drag?.provided.draggableProps.style, !!drag?.snapshot.isDragging)}
      onClick={() => {
        if (editingSessionId !== session.id) {
          resetDeleteConfirmation();
          setCurrentSessionId(session.id);
        }
      }}
      onMouseLeave={() => {
        setHoveredSessionId((prev) => (prev === session.id ? null : prev));
        if (pendingDeleteSessionId === session.id) {
          resetDeleteConfirmation();
        }
      }}
      onMouseEnter={() => {
        setHoveredSessionId(session.id);
      }}
      className={cn(
        'group mx-1 flex items-start gap-2.5 rounded-2xl border border-transparent px-3 py-2 cursor-pointer transition-all duration-150',
        drag && 'cursor-grab active:cursor-grabbing',
        currentSessionId === session.id
          ? 'bg-[var(--sidebar-study-selected)] text-foreground'
          : 'hover:bg-[var(--sidebar-study-hover)]',
        editingSessionId === session.id && 'ring-1 ring-primary/60 bg-[var(--sidebar-study-selected)]',
        drag?.snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card z-50'
      )}
    >
      <div className="flex-1 min-w-0 overflow-hidden">
        {editingSessionId === session.id ? (
          <div className="flex flex-col gap-1.5 w-full">
            <input
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renamingSessionId !== session.id) {
                  e.preventDefault();
                  saveSessionTitle(session.id);
                } else if (e.key === 'Escape') {
                  cancelEditSession();
                }
              }}
              autoFocus
              disabled={renamingSessionId === session.id}
              className="w-full bg-transparent text-sm px-2 py-1.5 rounded-md border border-primary/60 bg-card/60 shadow-sm ring-1 ring-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground disabled:opacity-60"
              placeholder={t('page.sessionNamePlaceholder')}
            />
            <div className="flex items-center justify-end gap-1.5">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelEditSession();
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.cancelEdit')}
              >
                <X className="w-3.5 h-3.5" />
                <span>{t('page.cancelEdit')}</span>
              </NotionButton>
              <NotionButton
                variant="primary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  saveSessionTitle(session.id);
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.saveSessionName')}
              >
                {renamingSessionId === session.id ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('page.renameSaving')}</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>{t('page.saveSessionName')}</span>
                  </>
                )}
              </NotionButton>
            </div>
            <div className="flex items-center justify-between text-[11px] leading-none">
              <span className="text-muted-foreground/80">
                {t('page.renameShortcutHint')}
              </span>
              {renameError && editingSessionId === session.id && (
                <span className="text-destructive">
                  {renameError}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className={cn(
            'text-[13px] transition-colors',
            currentSessionId === session.id
              ? 'text-foreground font-normal hover:font-normal line-clamp-2 break-words'
              : 'text-foreground/80 font-normal hover:font-normal truncate'
          )}>
            {sessionTitle}
          </div>
        )}
      </div>
      {editingSessionId !== session.id && (
        <div className={cn(
          "flex gap-1 shrink-0 transition-opacity duration-150",
          showActionButtons ? "opacity-100" : "opacity-0 pointer-events-none"
        )}>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => startEditSession(session, e)}
            aria-label={t('page.renameSession')}
            title={t('page.renameSession')}
            className="!h-6 !w-6"
          >
            <Edit2 className="w-3 h-3" />
          </NotionButton>
          <Popover>
            <PopoverTrigger asChild>
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={(e) => e.stopPropagation()}
                aria-label={t('page.moveToGroup')}
                title={t('page.moveToGroup')}
                className="!h-6 !w-6"
              >
                <Folder className="w-3 h-3" />
              </NotionButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  moveSessionToGroup(session.id, undefined);
                }}
                className={cn(
                  'w-full justify-between',
                  !session.groupId && 'text-primary'
                )}
              >
                <span>{t('page.ungrouped')}</span>
                {!session.groupId && <Check className="w-3 h-3" />}
              </NotionButton>
              <div className="my-1 border-t border-border/40/60" />
              {groups.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('page.noGroups')}
                </div>
              ) : (
                groups.map((group) => {
                  const active = session.groupId === group.id;
                  // 判断 icon 是预设图标名称还是 emoji，只有 emoji 才添加到标签前面
                  const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
                  const label = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
                  return (
                    <NotionButton
                      key={group.id}
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        moveSessionToGroup(session.id, group.id);
                      }}
                      className={cn(
                        'w-full justify-between',
                        active && 'text-primary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {active && <Check className="w-3 h-3" />}
                    </NotionButton>
                  );
                })
              )}
            </PopoverContent>
          </Popover>
          {/* 🔧 全局最后一个会话不允许删除 */}
          {(totalSessionCount ?? sessions.length) > 1 && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              if (pendingDeleteSessionId === session.id) {
                resetDeleteConfirmation();
                deleteSession(session.id);
                return;
              }

              setPendingDeleteSessionId(session.id);
              clearDeleteConfirmTimeout();
              deleteConfirmTimeoutRef.current = setTimeout(() => {
                resetDeleteConfirmation();
              }, 2500);
            }}
            className={cn(
              '!h-6 !w-6 hover:bg-destructive/20 text-muted-foreground hover:text-destructive',
              pendingDeleteSessionId === session.id && 'text-destructive'
            )}
            aria-label={
              pendingDeleteSessionId === session.id
                ? t('common:confirm_delete')
                : t('page.deleteSession')
            }
            title={
              pendingDeleteSessionId === session.id
                ? t('common:confirm_delete')
                : t('page.deleteSession')
            }
          >
            {pendingDeleteSessionId === session.id ? (
              <Trash2 className="w-3 h-3" />
            ) : (
              <X className="w-3 h-3" />
            )}
          </NotionButton>
          )}
        </div>
      )}
    </div>
    );
  };

  // 处理从浏览器视图选择会话
  const handleBrowserSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    setViewMode('sidebar');
  }, []);

  // 处理从浏览器视图重命名会话
  const handleBrowserRenameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: newTitle },
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
    } catch (error) {
      console.error('[ChatV2Page] Failed to rename session:', getErrorMessage(error));
    }
  }, []);

  return {
    renderSessionItem,
    handleBrowserSelectSession,
    handleBrowserRenameSession,
  };
}
