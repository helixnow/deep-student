/**
 * R1-13 — noteBinding：焦点切到 note 窗时写入当前会话 modeState.canvasNoteId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { registerTestApp } from '@/features/workbench/core/__tests__/testUtils';

const updateModeState = vi.fn();
const getCurrentSessionId = vi.fn(() => 'sess-test');
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
  },
}));

registerTestApp('note', { instanceMode: 'multi' });
registerTestApp('todo', { instanceMode: 'single' });

describe('setupNoteBinding', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    updateModeState.mockClear();
    getCurrentSessionId.mockClear();
    getCurrentSessionId.mockReturnValue('sess-test');
    getSession.mockClear();
    getSession.mockReturnValue({
      getState: () => ({
        modeState: {} as Record<string, unknown> | null,
        updateModeState,
      }),
    });
  });

  afterEach(() => {
    resetWindowStoreForTests();
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
});
