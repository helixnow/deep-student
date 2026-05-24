import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGroupManagement } from '@/features/chat/hooks/useGroupManagement';
import type { SessionGroup } from '@/features/chat/types/group';

const { invokeMock, setGroupsCacheMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setGroupsCacheMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/features/chat/core/store/groupCache', () => ({
  setGroupsCache: setGroupsCacheMock,
}));

const activeGroup: SessionGroup = {
  id: 'group-1',
  name: 'Chemistry',
  description: 'Science group',
  icon: 'flask',
  color: undefined,
  systemPrompt: undefined,
  defaultSkillIds: [],
  pinnedResourceIds: [],
  workspaceId: 'workspace-1',
  sortOrder: 0,
  persistStatus: 'active',
  createdAt: '2026-04-06T00:00:00.000Z',
  updatedAt: '2026-04-06T00:00:00.000Z',
};

describe('useGroupManagement', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setGroupsCacheMock.mockReset();
  });

  it('archives groups through update_group instead of deleting or ungrouping sessions', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([activeGroup]);
      }
      if (command === 'chat_v2_update_group') {
        return Promise.resolve({
          ...activeGroup,
          persistStatus: 'archived',
          updatedAt: '2026-04-07T00:00:00.000Z',
        });
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useGroupManagement('workspace-1'));

    await act(async () => {
      await result.current.loadGroups();
    });

    expect(result.current.groups).toEqual([activeGroup]);

    await act(async () => {
      await result.current.archiveGroup('group-1');
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_group', {
      groupId: 'group-1',
      request: {
        persistStatus: 'archived',
        workspaceId: 'workspace-1',
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_delete_group', expect.anything());
    expect(result.current.groups).toEqual([]);
    expect(setGroupsCacheMock).toHaveBeenLastCalledWith([]);
  });
});
