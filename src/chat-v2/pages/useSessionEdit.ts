import React, { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionManager } from '../core/session/sessionManager';
import { groupCache } from '../core/store/groupCache';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import type { ChatSession } from '../types/session';
import type { DropResult } from '@hello-pangea/dnd';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { TFunction } from 'i18next';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export interface UseSessionEditDeps {
  resetDeleteConfirmation: () => void;
  setEditingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;
  setRenamingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setGroupEditorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingGroup: React.Dispatch<React.SetStateAction<SessionGroup | null>>;
  setShowTrash: React.Dispatch<React.SetStateAction<boolean>>;
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<'sidebar' | 'browser'>>;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteGroup: React.Dispatch<React.SetStateAction<SessionGroup | null>>;
  setGroupPinnedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setMobileResourcePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingTitle: string;
  editingGroup: SessionGroup | null;
  pendingDeleteGroup: SessionGroup | null;
  sessionsRef: React.MutableRefObject<ChatSession[]>;
  groupPickerAddRef: React.MutableRefObject<((sourceId: string) => 'added' | 'removed' | false) | null>;
  t: TFunction<any, any>;
  updateGroup: (id: string, payload: UpdateGroupRequest) => Promise<SessionGroup | void>;
  createGroup: (payload: CreateGroupRequest) => Promise<SessionGroup | void>;
  deleteGroup: (id: string) => Promise<void>;
  reorderGroups: (ids: string[]) => void;
  loadUngroupedCount: () => Promise<void>;
  groupDragDisabled: boolean;
  visibleGroups: SessionGroup[];
}

export function useSessionEdit(deps: UseSessionEditDeps) {
  const {
    resetDeleteConfirmation, setEditingSessionId, setEditingTitle,
    setRenamingSessionId, setRenameError, setSessions,
    setGroupEditorOpen, setEditingGroup, setShowTrash, setShowChatControl,
    setViewMode, setSessionSheetOpen, setPendingDeleteGroup,
    setGroupPinnedIds, setMobileResourcePanelOpen,
    editingTitle, editingGroup, pendingDeleteGroup, sessionsRef,
    groupPickerAddRef, t,
    updateGroup, createGroup, deleteGroup, reorderGroups,
    loadUngroupedCount, groupDragDisabled, visibleGroups,
  } = deps;

  // 开始编辑会话名称
  const startEditSession = useCallback((session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingSessionId(null);
    setRenameError(null);
    setEditingSessionId(session.id);
    setEditingTitle(session.title?.trim() ?? '');
    resetDeleteConfirmation();
  }, [resetDeleteConfirmation]);

  // 保存会话名称
  const saveSessionTitle = useCallback(async (sessionId: string) => {
    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle) {
      setRenameError(t('page.renameEmptyError'));
      return;
    }

    const currentTitle = sessionsRef.current
      .find((s) => s.id === sessionId)
      ?.title?.trim();

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

  // ===== 分组管理 =====
  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setGroupEditorOpen(true);
    setShowTrash(false);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, []);

  const openEditGroup = useCallback((group: SessionGroup) => {
    setEditingGroup(group);
    setGroupEditorOpen(true);
    setShowTrash(false);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, []);

  const closeGroupEditor = useCallback(() => {
    setGroupEditorOpen(false);
    setEditingGroup(null);
    // 清理分组资源选择器状态
    groupPickerAddRef.current = null;
    setGroupPinnedIds(new Set());
    setMobileResourcePanelOpen(false);
  }, []);

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

  const removeGroupFromSessions = useCallback((groupId: string) => {
    // P1 fix: Move side-effects out of setSessions updater
    const affectedSessionIds: string[] = [];
    setSessions((prev) => {
      prev.forEach((s) => {
        if (s.groupId === groupId) {
          affectedSessionIds.push(s.id);
        }
      });
      return prev.map((s) => (s.groupId === groupId ? { ...s, groupId: undefined } : s));
    });
    // Apply store updates outside of setState updater
    for (const sid of affectedSessionIds) {
      const store = sessionManager.get(sid);
      if (store) {
        const meta = store.getState().sessionMetadata;
        const storeUpdate: Record<string, unknown> = { groupId: null };
        if (meta?.groupSystemPromptSnapshot) {
          const { groupSystemPromptSnapshot: _, ...rest } = meta;
          storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
        }
        store.setState(storeUpdate);
      }
    }
  }, []);

  const confirmDeleteGroup = useCallback(async () => {
    if (!pendingDeleteGroup) return;
    try {
      await deleteGroup(pendingDeleteGroup.id);
      removeGroupFromSessions(pendingDeleteGroup.id);
      void loadUngroupedCount();
      setPendingDeleteGroup(null);
    } catch (error) {
      console.error('[ChatV2Page] Failed to delete group:', getErrorMessage(error));
    }
  }, [deleteGroup, loadUngroupedCount, pendingDeleteGroup, removeGroupFromSessions]);

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

  const handleDragEnd = useCallback((result: DropResult) => {
    const { destination, source, draggableId, type } = result;
    if (!destination) return;

    if (type === 'GROUP') {
      if (groupDragDisabled) return;
      if (destination.index === source.index) return;
      const reordered = [...visibleGroups];
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      reorderGroups(reordered.map((group) => group.id));
      return;
    }

    if (type === 'SESSION') {
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
    }
  }, [groupDragDisabled, moveSessionToGroup, reorderGroups, visibleGroups]);

  // 格式化时间
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('common.justNow');
    if (diffMins < 60) return t('common.minutesAgo', { count: diffMins } as any);
    if (diffHours < 24) return t('common.hoursAgo', { count: diffHours } as any);
    if (diffDays < 7) return t('common.daysAgo', { count: diffDays } as any);
    return date.toLocaleDateString();
  };

  return {
    startEditSession,
    saveSessionTitle,
    cancelEditSession,
    openCreateGroup,
    openEditGroup,
    closeGroupEditor,
    handleSubmitGroup,
    applySessionGroupUpdate,
    removeGroupFromSessions,
    confirmDeleteGroup,
    moveSessionToGroup,
    handleDragEnd,
    formatTime,
  };
}
