import React, { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Edit2, Check, X, Loader2, Pin, Archive } from 'lucide-react';
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
import { PRESET_ICONS } from '../components/groups/GroupEditorDialog';
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
    editingTitle, renamingSessionId, renameError, groups, sessions, totalSessionCount,
    t, resetDeleteConfirmation, setCurrentSessionId,
    setEditingTitle, setSessions, setViewMode,
    startEditSession, saveSessionTitle, cancelEditSession,
    archiveSession, togglePinSession, formatTime,
  } = deps;

  // 渲染单个会话项 - Notion 风格
  const renderSessionItem = (session: ChatSession, drag?: SessionDragState) => {
    const sessionTitle = getSessionTitleText(session.title, t('page.untitled'));
    const pinned = !!session.metadata?.pinned;

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
              'min-w-0 flex-1 text-[13px] transition-colors',
              currentSessionId === session.id
                ? 'text-foreground font-normal hover:font-normal line-clamp-2 break-words'
                : 'text-foreground/80 font-normal hover:font-normal truncate'
            )}>
              {sessionTitle}
          </div>
        )}
      </div>
      {editingSessionId !== session.id && (
        <div className="ml-2 flex min-h-6 shrink-0 items-center justify-end gap-1 transition-opacity duration-150 opacity-100">
          <span className="text-[11px] tabular-nums text-muted-foreground/80">
            {formatTime(session.updatedAt)}
          </span>
        </div>
      )}
          </div>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={180}>
          <AppMenuGroup>
            <AppMenuItem
              icon={<Edit2 className="w-4 h-4" />}
              onClick={() => startEditSession(session, { stopPropagation() {} } as React.MouseEvent)}
            >
              {t('page.renameSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Pin className="w-4 h-4" />}
              onClick={() => togglePinSession(session.id, !pinned, session.metadata)}
            >
              {pinned ? t('page.unpinSession') : t('page.pinSession')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Archive className="w-4 h-4" />}
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
