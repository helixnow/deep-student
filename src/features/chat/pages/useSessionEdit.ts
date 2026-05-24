import React, { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionManager } from '../core/session/sessionManager';
import { groupCache } from '../core/store/groupCache';
import { getSessionTitleText } from '../utils/sessionTitle';
import { buildPinnedSessionMetadata } from '../utils/sessionPin';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import type { ChatSession } from '../types/session';
import type { DropResult } from '@hello-pangea/dnd';
import type { DragEndEvent } from '@dnd-kit/core';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { showArchiveSessionToast } from '../utils/archiveSessionToast';
import type { TFunction } from 'i18next';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const emitSessionListUpdated = () => {
  window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
};

export interface UseSessionEditDeps {
  resetDeleteConfirmation: () => void;
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setEditingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;
  setRenamingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setGroupEditorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingGroup: React.Dispatch<React.SetStateAction<SessionGroup | null>>;
  setGroupEditorAutoFocusField: React.Dispatch<React.SetStateAction<'name' | null>>;
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingArchiveGroup: React.Dispatch<React.SetStateAction<SessionGroup | null>>;
  setGroupPinnedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setMobileResourcePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingTitle: string;
  editingGroup: SessionGroup | null;
  pendingArchiveGroup: SessionGroup | null;
  sessionsRef: React.MutableRefObject<ChatSession[]>;
  groupPickerAddRef: React.MutableRefObject<((sourceId: string) => 'added' | 'removed' | false) | null>;
  t: TFunction<any, any>;
  updateGroup: (id: string, payload: UpdateGroupRequest) => Promise<SessionGroup | void>;
  createGroup: (payload: CreateGroupRequest) => Promise<SessionGroup | void>;
  archiveGroup: (id: string) => Promise<void>;
  reorderGroups: (ids: string[]) => void;
  loadUngroupedCount: () => Promise<void>;
  groupDragDisabled: boolean;
  visibleGroups: SessionGroup[];
}

export function useSessionEdit(deps: UseSessionEditDeps) {
  const {
    resetDeleteConfirmation, currentSessionId, setCurrentSessionId, setEditingSessionId, setEditingTitle,
    setRenamingSessionId, setRenameError, setSessions,
    setGroupEditorOpen, setEditingGroup, setGroupEditorAutoFocusField, setShowChatControl,
    setViewMode, setSessionSheetOpen, setPendingArchiveGroup,
    setGroupPinnedIds, setMobileResourcePanelOpen,
    editingTitle, editingGroup, pendingArchiveGroup, sessionsRef,
    groupPickerAddRef, t,
    updateGroup, createGroup, archiveGroup, reorderGroups,
    loadUngroupedCount, groupDragDisabled, visibleGroups,
  } = deps;

  // 开始编辑会话名称
  const startEditSession = useCallback((session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingSessionId(null);
    setRenameError(null);
    setEditingSessionId(session.id);
    setEditingTitle(getSessionTitleText(session.title, ''));
    resetDeleteConfirmation();
  }, [resetDeleteConfirmation]);

  // 保存会话名称
  const saveSessionTitle = useCallback(async (sessionId: string) => {
    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle) {
      setRenameError(t('page.renameEmptyError'));
      return;
    }

    const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
    const currentTitle = getSessionTitleText(currentSession?.title, '');

    if (currentTitle === trimmedTitle) {
      setRenameError(null);
      setEditingSessionId(null);
      return;
    }

    try {
      setRenameError(null);
      setRenamingSessionId(sessionId);
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: trimmedTitle },
      });
      
      // 更新本地状态
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: trimmedTitle } : s
        )
      );
      emitSessionListUpdated();
      setEditingSessionId(null);
      setEditingTitle('');
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('[ChatV2Page] Failed to rename session:', message);
      setRenameError(t('page.renameFailed'));
    } finally {
      setRenamingSessionId(null);
    }
  }, [editingTitle, t]);

  // 取消编辑
  const cancelEditSession = useCallback(() => {
    setRenamingSessionId(null);
    setRenameError(null);
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  const togglePinSession = useCallback(async (sessionId: string, pinned: boolean, metadata?: ChatSession['metadata']) => {
    try {
      const nextMetadata = buildPinnedSessionMetadata(metadata, pinned);
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { metadata: nextMetadata ?? null },
      });

      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? { ...session, metadata: nextMetadata }
            : session
        )
      );
      emitSessionListUpdated();
    } catch (error) {
      console.error('[ChatV2Page] Failed to toggle session pin:', getErrorMessage(error));
    }
  }, [setSessions]);

  const archiveSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_archive_session', { sessionId });

      const nextCurrentSessionId =
        currentSessionId === sessionId
          ? sessionsRef.current.find((session) => session.id !== sessionId)?.id ?? null
          : currentSessionId;

      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      if (currentSessionId === sessionId) {
        setCurrentSessionId(nextCurrentSessionId);
      }
      emitSessionListUpdated();
      showArchiveSessionToast(t);
    } catch (error) {
      console.error('[ChatV2Page] Failed to archive session:', getErrorMessage(error));
    }
  }, [currentSessionId, setCurrentSessionId, setSessions, sessionsRef, t]);

  // ===== 分组管理 =====
  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setGroupEditorAutoFocusField('name');
    setGroupEditorOpen(true);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, [setGroupEditorAutoFocusField]);

  const openEditGroup = useCallback((group: SessionGroup) => {
    setEditingGroup(group);
    setGroupEditorAutoFocusField(null);
    setGroupEditorOpen(true);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, [setGroupEditorAutoFocusField]);

  const openRenameGroup = useCallback((group: SessionGroup) => {
    setEditingGroup(group);
    setGroupEditorAutoFocusField('name');
    setGroupEditorOpen(true);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, [setGroupEditorAutoFocusField]);

  const closeGroupEditor = useCallback(() => {
    setGroupEditorOpen(false);
    setEditingGroup(null);
    setGroupEditorAutoFocusField(null);
    // 清理分组资源选择器状态
    groupPickerAddRef.current = null;
    setGroupPinnedIds(new Set());
    setMobileResourcePanelOpen(false);
  }, [setGroupEditorAutoFocusField]);

  const handleSubmitGroup = useCallback(async (payload: CreateGroupRequest | UpdateGroupRequest) => {
    try {
      if (editingGroup) {
        await updateGroup(editingGroup.id, payload as UpdateGroupRequest);
      } else {
        await createGroup(payload as CreateGroupRequest);
      }
      closeGroupEditor();
    } catch (error) {
      console.error('[ChatV2Page] Failed to save group:', getErrorMessage(error));
    }
  }, [closeGroupEditor, createGroup, editingGroup, updateGroup]);

  const applySessionGroupUpdate = useCallback((sessionId: string, groupId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, groupId: groupId ?? undefined } : s))
    );
    const store = sessionManager.get(sessionId);
    if (store) {
      // Update groupId in store
      const storeUpdate: Record<string, unknown> = { groupId: groupId ?? null };

      // P0-3 fix: Update groupSystemPromptSnapshot in metadata when moving between groups
      const currentMetadata = store.getState().sessionMetadata;
      if (groupId) {
        const group = groupCache.get(groupId);
        if (group?.systemPrompt) {
          storeUpdate.sessionMetadata = {
            ...(currentMetadata ?? {}),
            groupSystemPromptSnapshot: group.systemPrompt,
          };
        } else {
          // New group has no systemPrompt — remove stale snapshot
          if (currentMetadata?.groupSystemPromptSnapshot) {
            const { groupSystemPromptSnapshot: _, ...rest } = currentMetadata;
            storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
          }
        }
      } else {
        // Moved to ungrouped — remove stale snapshot
        if (currentMetadata?.groupSystemPromptSnapshot) {
          const { groupSystemPromptSnapshot: _, ...rest } = currentMetadata;
          storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
        }
      }

      store.setState(storeUpdate);
    }
  }, []);

  const confirmArchiveGroup = useCallback(async () => {
    if (!pendingArchiveGroup) return;
    try {
      await archiveGroup(pendingArchiveGroup.id);
      setPendingArchiveGroup(null);
    } catch (error) {
      console.error('[ChatV2Page] Failed to archive group:', getErrorMessage(error));
    }
  }, [archiveGroup, pendingArchiveGroup, setPendingArchiveGroup]);

  const moveSessionToGroup = useCallback(async (sessionId: string, groupId?: string) => {
    try {
      await invoke('chat_v2_move_session_to_group', {
        sessionId,
        groupId: groupId ?? null,
      });
      applySessionGroupUpdate(sessionId, groupId ?? null);
      void loadUngroupedCount();
    } catch (error) {
      console.error('[ChatV2Page] Failed to move session to group:', getErrorMessage(error));
    }
  }, [applySessionGroupUpdate, loadUngroupedCount]);

  const handleGroupReorder = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (groupDragDisabled) return;

    const oldIndex = visibleGroups.findIndex((g) => g.id === active.id);
    const newIndex = visibleGroups.findIndex((g) => g.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...visibleGroups];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    reorderGroups(reordered.map((group) => group.id));
  }, [groupDragDisabled, reorderGroups, visibleGroups]);

  const handleDragEnd = useCallback((result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination) return;

    // SESSION-level drag only (group drag handled by @dnd-kit)
    if (destination.droppableId === source.droppableId) return;
    const sessionId = draggableId.replace(/^session:/, '');
    if (destination.droppableId === 'session-ungrouped') {
      moveSessionToGroup(sessionId, undefined);
      return;
    }
    if (destination.droppableId.startsWith('session-group:')) {
      const destGroupId = destination.droppableId.replace('session-group:', '');
      moveSessionToGroup(sessionId, destGroupId);
    }
  }, [moveSessionToGroup]);

  // 格式化时间
  const formatTime = (isoString: string): string => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('common.justNow') as string;
    if (diffMins < 60) return t('common.minutesAgo', { count: diffMins } as any) as string;
    if (diffHours < 24) return t('common.hoursAgo', { count: diffHours } as any) as string;
    if (diffDays < 7) return t('common.daysAgo', { count: diffDays } as any) as string;
    return date.toLocaleDateString();
  };

  return {
    startEditSession,
    saveSessionTitle,
    cancelEditSession,
    archiveSession,
    togglePinSession,
    openCreateGroup,
    openEditGroup,
    openRenameGroup,
    closeGroupEditor,
    handleSubmitGroup,
    applySessionGroupUpdate,
    confirmArchiveGroup,
    moveSessionToGroup,
    handleGroupReorder,
    handleDragEnd,
    formatTime,
  };
}
