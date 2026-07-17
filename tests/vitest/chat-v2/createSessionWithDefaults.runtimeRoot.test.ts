import { beforeEach, describe, expect, it, vi } from 'vitest';
import { groupCache } from '@/features/chat/core/store/groupCache';

const { invokeMock, setStateMock, getOrCreateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setStateMock: vi.fn(),
  getOrCreateMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    getOrCreate: getOrCreateMock,
  },
}));

vi.mock('@/features/chat/skills/skillDefaults', () => ({
  skillDefaults: {
    getEffective: () => [],
  },
}));

import { createSessionWithDefaults } from '@/features/chat/core/session/createSessionWithDefaults';

describe('createSessionWithDefaults groupDefaultRuntimeRootIdSnapshot', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setStateMock.mockReset();
    getOrCreateMock.mockReset();
    groupCache.clear();

    getOrCreateMock.mockReturnValue({
      setState: setStateMock,
      getState: () => ({
        activateSkill: vi.fn(),
        pendingContextRefs: [],
      }),
    });

    invokeMock.mockResolvedValue({
      id: 'sess_1',
      mode: 'general_chat',
      groupId: 'group-1',
    });
  });

  it('writes groupDefaultRuntimeRootIdSnapshot from group cache when creating a session', async () => {
    groupCache.set('group-1', {
      id: 'group-1',
      name: 'Math',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: 'authorized_math_root',
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    await createSessionWithDefaults({
      mode: 'general_chat',
      groupId: 'group-1',
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_create_session', {
      mode: 'general_chat',
      title: null,
      metadata: {
        groupDefaultRuntimeRootIdSnapshot: 'authorized_math_root',
      },
      groupId: 'group-1',
    });
  });

  it('writes both systemPrompt and runtime root snapshots together', async () => {
    groupCache.set('group-1', {
      id: 'group-1',
      name: 'Math',
      systemPrompt: 'Be precise',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: 'authorized_math_root',
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    await createSessionWithDefaults({
      mode: 'general_chat',
      groupId: 'group-1',
      metadata: { existing: true },
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_create_session', {
      mode: 'general_chat',
      title: null,
      metadata: {
        existing: true,
        groupSystemPromptSnapshot: 'Be precise',
        groupDefaultRuntimeRootIdSnapshot: 'authorized_math_root',
      },
      groupId: 'group-1',
    });
  });

  it('does not overwrite an existing groupDefaultRuntimeRootIdSnapshot', async () => {
    groupCache.set('group-1', {
      id: 'group-1',
      name: 'Math',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: 'authorized_new_root',
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    await createSessionWithDefaults({
      mode: 'general_chat',
      groupId: 'group-1',
      metadata: {
        groupDefaultRuntimeRootIdSnapshot: 'authorized_existing_root',
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_create_session', {
      mode: 'general_chat',
      title: null,
      metadata: {
        groupDefaultRuntimeRootIdSnapshot: 'authorized_existing_root',
      },
      groupId: 'group-1',
    });
  });
});
