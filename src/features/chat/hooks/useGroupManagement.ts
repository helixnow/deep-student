import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import { setGroupsCache } from '../core/store/groupCache';
import { useSessionListStore } from '../stores/sessionListStore';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
import { inferLegacyRootFolderId } from '@/shared/study-space/types';

const emitGroupListUpdated = () => {
  if (typeof window === 'undefined') return;
  dispatchAppEvent(APP_EVENTS.CHAT_GROUPS_UPDATED);
};

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
    void useStudySpaceStore.getState().hydrateFromGroups(sorted);
    // Loading is a read, not a mutation: broadcasting here causes another
    // session-list request while the initial sidebar/page load is in flight.
  }, []);

  const loadGroups = useCallback(async () => {
    setIsLoading(true);
    try {
      // 会话列表 store 的一次刷新本就包含 chat_v2_list_groups：页面挂载时两边各发一次
      // 等于同一份数据等两个往返（公网 RTT 150–250ms）。无 workspaceId 时直接复用
      // store 的刷新（在途请求共享，不会重复发），并顺带同步分组的最新状态。
      // 指定 workspaceId 的调用仍走原命令（store 的刷新不按 workspace 过滤）。
      if (workspaceId === undefined) {
        // store 刷新失败（例如两个会话分区都挂了）时仍可尝试直接取分组，
        // 保持「分组单独可读」的旧降级行为。
        const refreshed = await useSessionListStore
          .getState()
          .refresh()
          .then(() => true)
          .catch(() => false);
        const storeGroups = useSessionListStore.getState().groups;
        if (refreshed || useSessionListStore.getState().isLoaded || storeGroups.length > 0) {
          applyGroups(storeGroups);
          return;
        }
      }
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
      const spaceStore = useStudySpaceStore.getState();
      spaceStore.upsertGroupInState(group);
      const stagedProfileDraft = spaceStore.consumeStagedCreateProfileDraft();
      if (stagedProfileDraft) {
        const rootFolderId = inferLegacyRootFolderId(group) ?? '';
        await spaceStore.saveSpaceProfile({
          spaceId: group.id,
          rootFolderId,
          ...stagedProfileDraft,
        });
      }
      emitGroupListUpdated();
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
      useStudySpaceStore.getState().upsertGroupInState(group);
      emitGroupListUpdated();
      return group;
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to update group:', getErrorMessage(error));
      throw error;
    }
  }, [workspaceId]);

  const archiveGroup = useCallback(async (groupId: string) => {
    try {
      await invoke<SessionGroup>('chat_v2_update_group', {
        groupId,
        request: {
          persistStatus: 'archived',
          workspaceId,
        },
      });
      setGroups((prev) => {
        const next = sortGroups(prev.filter((g) => g.id !== groupId));
        setGroupsCache(next);
        return next;
      });
      useStudySpaceStore.getState().removeGroupFromState(groupId);
      emitGroupListUpdated();
    } catch (error: unknown) {
      console.error('[useGroupManagement] Failed to archive group:', getErrorMessage(error));
      throw error;
    }
  }, [workspaceId]);

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
      emitGroupListUpdated();
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
    archiveGroup,
    reorderGroups,
  };
}
