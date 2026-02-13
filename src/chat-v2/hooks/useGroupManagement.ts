import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import { setGroupsCache } from '../core/store/groupCache';

function sortGroups(groups: SessionGroup[]): SessionGroup[] {
  return [...groups].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function useGroupManagement(workspaceId?: string) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const applyGroups = useCallback((next: SessionGroup[]) => {
    const sorted = sortGroups(next);
    setGroups(sorted);
    setGroupsCache(sorted);
  }, []);

  const loadGroups = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await invoke<SessionGroup[]>('chat_v2_list_groups', {
        status: 'active',
        workspaceId,
      });
      applyGroups(result);
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to load groups:', getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [applyGroups, workspaceId]);

  const createGroup = useCallback(async (request: CreateGroupRequest) => {
    try {
      const group = await invoke<SessionGroup>('chat_v2_create_group', {
        request: {
          ...request,
          workspaceId: request.workspaceId ?? workspaceId,
        },
      });
      setGroups((prev) => {
        const next = sortGroups([group, ...prev]);
        setGroupsCache(next);
        return next;
      });
      return group;
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to create group:', getErrorMessage(error));
      throw error;
    }
  }, [workspaceId]);

  const updateGroup = useCallback(async (groupId: string, request: UpdateGroupRequest) => {
    try {
      const group = await invoke<SessionGroup>('chat_v2_update_group', {
        groupId,
        request: {
          ...request,
          workspaceId: request.workspaceId ?? workspaceId,
        },
      });
      setGroups((prev) => {
        const next = sortGroups(prev.map((g) => (g.id === group.id ? group : g)));
        setGroupsCache(next);
        return next;
      });
      return group;
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to update group:', getErrorMessage(error));
      throw error;
    }
  }, [workspaceId]);

  const deleteGroup = useCallback(async (groupId: string) => {
    try {
      await invoke('chat_v2_delete_group', { groupId });
      setGroups((prev) => {
        const next = sortGroups(prev.filter((g) => g.id !== groupId));
        setGroupsCache(next);
        return next;
      });
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to delete group:', getErrorMessage(error));
      throw error;
    }
  }, []);

  const reorderGroups = useCallback(async (groupIds: string[]) => {
    setGroups((prev) => {
      const map = new Map(prev.map((group) => [group.id, group]));
      const used = new Set<string>();
      const reordered = groupIds
        .map((id, index) => {
          const group = map.get(id);
          if (!group) return null;
          used.add(id);
          return { ...group, sortOrder: index };
        })
        .filter((group): group is SessionGroup => group !== null);

      prev.forEach((group) => {
        if (!used.has(group.id)) {
          reordered.push(group);
        }
      });

      setGroupsCache(reordered);
      return reordered;
    });

    try {
      await invoke('chat_v2_reorder_groups', { groupIds });
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to reorder groups:', getErrorMessage(error));
      await loadGroups();
    }
  }, [loadGroups]);

  return {
    groups,
    isLoading,
    loadGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    reorderGroups,
  };
}
