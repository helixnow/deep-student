import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionEdit } from '@/features/chat/pages/useSessionEdit';
import { groupCache } from '@/features/chat/core/store/groupCache';
import type { UseSessionEditDeps } from '@/features/chat/pages/useSessionEdit';

const { setStateMock, getMock, getStateMock } = vi.hoisted(() => ({
  setStateMock: vi.fn(),
  getMock: vi.fn(),
  getStateMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: getMock,
  },
}));

function createDeps(overrides: Partial<UseSessionEditDeps> = {}): UseSessionEditDeps {
  return {
    resetDeleteConfirmation: vi.fn(),
    currentSessionId: null,
    setCurrentSessionId: vi.fn(),
    setEditingSessionId: vi.fn(),
    setEditingTitle: vi.fn(),
    setRenamingSessionId: vi.fn(),
    setRenameError: vi.fn(),
    setSessions: vi.fn(),
    setGroupEditorOpen: vi.fn(),
    setEditingGroup: vi.fn(),
    setGroupEditorAutoFocusField: vi.fn(),
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    setPendingArchiveGroup: vi.fn(),
    setGroupPinnedIds: vi.fn(),
    setMobileResourcePanelOpen: vi.fn(),
    editingTitle: '',
    editingGroup: null,
    pendingArchiveGroup: null,
    sessionsRef: { current: [] },
    groupPickerAddRef: { current: null },
    t: ((key: string) => key) as UseSessionEditDeps['t'],
    updateGroup: vi.fn(),
    createGroup: vi.fn(),
    archiveGroup: vi.fn(),
    reorderGroups: vi.fn(),
    loadUngroupedCount: vi.fn(),
    getOrCreateHiddenDraftSession: vi.fn(),
    visibleGroups: [],
    groupDragDisabled: false,
    ...overrides,
  };
}

describe('useSessionEdit groupDefaultRuntimeRootIdSnapshot', () => {
  beforeEach(() => {
    setStateMock.mockReset();
    getMock.mockReset();
    getStateMock.mockReset();
    groupCache.clear();

    getStateMock.mockReturnValue({
      sessionMetadata: {
        groupSystemPromptSnapshot: 'old prompt',
        groupDefaultRuntimeRootIdSnapshot: 'authorized_old_root',
        keep: true,
      },
    });
    getMock.mockReturnValue({
      getState: getStateMock,
      setState: setStateMock,
    });
  });

  it('updates runtime root snapshot when moving to a group with defaultRuntimeRootId', () => {
    groupCache.set('group-new', {
      id: 'group-new',
      name: 'New',
      systemPrompt: 'new prompt',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: 'authorized_new_root',
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const { result } = renderHook(() => useSessionEdit(createDeps()));

    act(() => {
      result.current.applySessionGroupUpdate('sess_1', 'group-new');
    });

    expect(setStateMock).toHaveBeenCalledWith({
      groupId: 'group-new',
      sessionMetadata: {
        keep: true,
        groupSystemPromptSnapshot: 'new prompt',
        groupDefaultRuntimeRootIdSnapshot: 'authorized_new_root',
      },
    });
  });

  it('clears stale runtime root snapshot when target group has no binding', () => {
    groupCache.set('group-plain', {
      id: 'group-plain',
      name: 'Plain',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: null,
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const { result } = renderHook(() => useSessionEdit(createDeps()));

    act(() => {
      result.current.applySessionGroupUpdate('sess_1', 'group-plain');
    });

    expect(setStateMock).toHaveBeenCalledWith({
      groupId: 'group-plain',
      sessionMetadata: {
        keep: true,
      },
    });
  });

  it('clears both snapshots when moving to ungrouped', () => {
    const { result } = renderHook(() => useSessionEdit(createDeps()));

    act(() => {
      result.current.applySessionGroupUpdate('sess_1', null);
    });

    expect(setStateMock).toHaveBeenCalledWith({
      groupId: null,
      sessionMetadata: {
        keep: true,
      },
    });
  });
});
