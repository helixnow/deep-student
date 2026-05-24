import React, { useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PencilSimple, Check, X, CircleNotch, PushPin, Archive } from '@phosphor-icons/react';
import { type DraggableProvided, type DraggableStateSnapshot } from '@hello-pangea/dnd';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { getSidebarStudyRowClassName } from './sessionSidebarStyles';
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
  pendingArchiveSessionId: string | null;
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
  setPendingArchiveSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  clearDeleteConfirmTimeout: () => void;
  deleteConfirmTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  startEditSession: (session: ChatSession, e: React.MouseEvent) => void;
  saveSessionTitle: (sessionId: string) => Promise<void>;
  cancelEditSession: () => void;
  moveSessionToGroup: (sessionId: string, groupId?: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  togglePinSession: (sessionId: string, pinned: boolean, metadata?: ChatSession['metadata']) => Promise<void>;
  formatTime: (isoString: string) => string;
}

export const resolveDragStyle = (
  style: React.CSSProperties | undefined,
  isDragging: boolean
) => (isDragging && style ? { ...style, left: 'auto', top: 'auto' } : style);

export function useSessionItemRenderer(deps: UseSessionItemRendererDeps) {
  const {
    editingSessionId, currentSessionId,
    editingTitle, renamingSessionId, renameError, groups,
    t, resetDeleteConfirmation, setCurrentSessionId,
    setEditingTitle, setSessions, setViewMode,
    startEditSession, saveSessionTitle, cancelEditSession,
    archiveSession, togglePinSession, formatTime,
  } = deps;

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach((group) => map.set(group.id, group.name));
    return map;
  }, [groups]);

  // 渲染单个会话项 - Notion 风格
  const renderSessionItem = (session: ChatSession, drag?: SessionDragState) => {
    const sessionTitle = getSessionTitleText(session.title, t('page.untitled'));
    const pinned = !!session.metadata?.pinned;
    const groupLabel = session.groupId
      ? (groupNameById.get(session.groupId) ?? '未分类')
      : '未分类';

    return (
      <AppMenu mode="context">
        <AppMenuTrigger asChild>
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
            className={getSidebarStudyRowClassName({
              variant: 'session',
              selected: currentSessionId === session.id,
              draggable: !!drag,
              dragging: !!drag?.snapshot.isDragging,
              className: cn(
                editingSessionId === session.id && 'ring-1 ring-primary/60 bg-[var(--sidebar-study-selected)]'
              ),
            })}
          >
      <div className="flex-1 min-w-0 overflow-hidden">
        {editingSessionId === session.id ? (
          <div className="flex flex-col gap-1.5 w-full">
            <Input
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
                <X size={14} />
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
                    <CircleNotch size={14} className="animate-spin" />
                    <span>{t('page.renameSaving')}</span>
                  </>
                ) : (
                  <>
                    <Check size={14} />
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
          pinned ? (
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex min-w-0 items-center gap-2 text-[16px] font-normal leading-5 text-foreground/90">
                <PushPin size={12} weight="fill" className="h-3 w-3 shrink-0 text-[color:var(--sidebar-muted)]" />
                <span className="min-w-0 flex-1 truncate">{sessionTitle}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal leading-4 text-muted-foreground">
                <span className="truncate">{groupLabel}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">{formatTime(session.updatedAt)}</span>
              </div>
            </div>
          ) : (
            <div className={cn(
              'min-w-0 flex-1 text-[16px] font-normal leading-5 transition-colors',
              currentSessionId === session.id
                ? 'line-clamp-1 break-words text-foreground'
                : 'truncate text-foreground/88'
            )}>
                {sessionTitle}
            </div>
          )
        )}
      </div>
      {editingSessionId !== session.id && !pinned && (
        <div className="ml-2 flex min-h-6 shrink-0 items-center justify-end gap-1 transition-opacity duration-150 opacity-100">
          <span className="text-[13px] tabular-nums text-muted-foreground/80">
            {formatTime(session.updatedAt)}
          </span>
        </div>
      )}
          </div>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={180}>
          <AppMenuGroup>
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              onClick={() => startEditSession(session, { stopPropagation() {} } as React.MouseEvent)}
            >
              {t('page.renameSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<PushPin size={16} />}
              onClick={() => togglePinSession(session.id, !pinned, session.metadata)}
            >
              {pinned ? t('page.unpinSession') : t('page.pinSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Archive size={16} />}
              onClick={() => archiveSession(session.id)}
            >
              {t('page.archiveSession')}
            </AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>
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
