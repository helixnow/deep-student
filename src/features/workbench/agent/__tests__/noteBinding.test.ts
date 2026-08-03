/**
 * R1-13 — noteBinding：焦点切到 note 窗时写入当前会话 modeState.canvasNoteId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { registerTestApp } from '@/features/workbench/core/__tests__/testUtils';
import {
  registerWorkspaceHost,
  resetWorkspaceRegistryForTests,
  setWorkspaceActiveResource,
} from '@/features/workbench/apps/notes/workspaceRegistry';

const updateModeState = vi.fn();
const getCurrentSessionId = vi.fn(() => 'sess-test');
let sessionListener: ((event: { type: string; sessionId: string }) => void) | null = null;
const getSession = vi.fn(() => ({
  getState: () => ({
    modeState: {} as Record<string, unknown> | null,
    updateModeState,
  }),
}));

vi.mock('@/features/chat/core/session', () => ({
  sessionManager: {
    getCurrentSessionId: () => getCurrentSessionId(),
    get: (id: string) => getSession(id),
    subscribe: (listener: (event: { type: string; sessionId: string }) => void) => {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) sessionListener = null;
      };
    },
  },
}));

registerTestApp('note', { instanceMode: 'multi' });
registerTestApp('todo', { instanceMode: 'single' });
registerTestApp('notes', { instanceMode: 'single' });

describe('setupNoteBinding', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    resetWorkspaceRegistryForTests();
    updateModeState.mockClear();
    getCurrentSessionId.mockClear();
    getCurrentSessionId.mockReturnValue('sess-test');
    getSession.mockClear();
    sessionListener = null;
    getSession.mockReturnValue({
      getState: () => ({
        modeState: {} as Record<string, unknown> | null,
        updateModeState,
      }),
    });
  });

  afterEach(() => {
    resetWindowStoreForTests();
    resetWorkspaceRegistryForTests();
  });

  it('焦点切到 note 窗时把 instanceKey 写入 canvasNoteId', async () => {
    const { setupNoteBinding } = await import('../noteBinding');
    const unbind = setupNoteBinding();

    const noteWinId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'note-abc',
      title: 'Test Note',
    });
    useWindowStore.getState().focusWindow(noteWinId);

    expect(updateModeState).toHaveBeenCalledWith({ canvasNoteId: 'note-abc' });

    unbind();
  });

  it('焦点离开 note 窗时清空 canvasNoteId', async () => {
    const { setupNoteBinding } = await import('../noteBinding');
    const unbind = setupNoteBinding();

    const noteWinId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'note-xyz',
    });
    useWindowStore.getState().focusWindow(noteWinId);
    updateModeState.mockClear();

    // 模拟会话已持有该 noteId，避免 bind 短路
    getSession.mockReturnValue({
      getState: () => ({
        modeState: { canvasNoteId: 'note-xyz' },
        updateModeState,
      }),
    });

    const todoWinId = useWindowStore.getState().openWindow({
      typeId: 'todo',
      title: 'Todo',
    });
    useWindowStore.getState().focusWindow(todoWinId);

    expect(updateModeState).toHaveBeenCalledWith({ canvasNoteId: null });

    unbind();
  });

  it('无当前会话时不抛错、不写 store', async () => {
    getCurrentSessionId.mockReturnValue(null);
    const { setupNoteBinding } = await import('../noteBinding');
    const unbind = setupNoteBinding();

    const noteWinId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'note-orphan',
    });
    useWindowStore.getState().focusWindow(noteWinId);

    expect(updateModeState).not.toHaveBeenCalled();
    unbind();
  });

  it('统一 notes 窗切换活动资源时只绑定活动 note', async () => {
    const { setupNoteBinding } = await import('../noteBinding');
    const notesWindowId = useWindowStore.getState().openWindow({ typeId: 'notes' });
    let active: { type: 'note' | 'mindmap'; id: string } | null = null;
    const unregister = registerWorkspaceHost(notesWindowId, {
      openResource: (resource) => { active = resource; },
      getActiveResource: () => active,
    });
    const unbind = setupNoteBinding();

    active = { type: 'note', id: 'note-unified' };
    setWorkspaceActiveResource(notesWindowId, active);
    expect(updateModeState).toHaveBeenLastCalledWith({ canvasNoteId: 'note-unified' });

    getSession.mockReturnValue({
      getState: () => ({
        modeState: { canvasNoteId: 'note-unified' },
        updateModeState,
      }),
    });
    active = { type: 'mindmap', id: 'map-unified' };
    setWorkspaceActiveResource(notesWindowId, active);
    expect(updateModeState).toHaveBeenLastCalledWith({ canvasNoteId: null });

    unbind();
    unregister();
  });

  it('焦点笔记不变时把新 current session 绑定到同一 note', async () => {
    const firstUpdate = vi.fn();
    const secondUpdate = vi.fn();
    let currentSession = 'sess-one';
    getCurrentSessionId.mockImplementation(() => currentSession);
    getSession.mockImplementation((id: string) => ({
      getState: () => ({
        modeState: {},
        updateModeState: id === 'sess-one' ? firstUpdate : secondUpdate,
      }),
    }));

    const { setupNoteBinding } = await import('../noteBinding');
    const noteWinId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'note-stable',
    });
    useWindowStore.getState().focusWindow(noteWinId);
    const unbind = setupNoteBinding();
    expect(firstUpdate).toHaveBeenCalledWith({ canvasNoteId: 'note-stable' });

    currentSession = 'sess-two';
    sessionListener?.({ type: 'current-session-changed', sessionId: currentSession });
    expect(secondUpdate).toHaveBeenCalledWith({ canvasNoteId: 'note-stable' });
    unbind();
  });
});
