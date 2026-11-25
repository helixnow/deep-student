import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { AppsPanel } from '../../components/AppsPanel';
import {
  closeAppsPanel,
  isAppsPanelOpen,
  openAppsPanel,
} from '../../components/appsPanelStore';
import { appRegistry } from '../../core/appRegistry';
import { workbenchBus } from '../../core/workbenchBus';
import { GLOBAL_SEARCH_DEBOUNCE_MS } from '../globalSearchProviders';
import { useResourceSearch } from '@/command-palette';

const { invokeMock, dstuSearchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dstuSearchMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/dstu/api', () => ({
  search: (...args: unknown[]) => dstuSearchMock(...args),
}));

vi.mock('../../apps/chat/newSession', () => ({
  openChatSession: vi.fn((sessionId: string, reason?: string) => {
    workbenchBus.launch({
      typeId: 'chat',
      instanceKey: sessionId,
      reason: reason ?? 'command',
    });
    return 'win-chat-1';
  }),
  CHAT_APP_TYPE_ID: 'chat',
}));

const NullApp = () => null;

describe('S4-12 Launcher & CommandPalette existing chat session search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    closeAppsPanel();
    invokeMock.mockReset();
    dstuSearchMock.mockReset();
    dstuSearchMock.mockResolvedValue({ ok: true, value: [] });
    appRegistry.register({
      typeId: 'chat',
      nameKey: 'workbench:apps.chat.name',
      icon: <span>C</span>,
      instanceMode: 'single',
      memoryWeight: 1,
      defaultFrame: { w: 720, h: 520 },
      minSize: { w: 320, h: 240 },
      render: React.lazy(async () => ({ default: NullApp })),
    });
  });

  afterEach(() => {
    closeAppsPanel();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('finds untitled chat sessions via "未命名会话", "未命名", single-char "会", and "Untitled" in Launcher and opens the session', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'chat_v2_search_content') return [];
      if (cmd === 'chat_v2_search_sessions') return [];
      if (cmd === 'chat_v2_list_sessions') {
        if (args?.groupId === '') {
          return [
            {
              id: 'sess_untitled_1',
              title: null,
              description: null,
              mode: 'normal',
              updatedAt: '2026-11-25T10:00:00Z',
            },
          ];
        }
        return [];
      }
      return [];
    });

    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-chat-1');
    render(<AppsPanel />);
    act(() => openAppsPanel());

    const input = screen.getByTestId('wb-apps-search');

    for (const q of ['未命名会话', '未命名', '会', 'Untitled']) {
      fireEvent.change(input, { target: { value: q } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const chatRow = screen.getByTestId('wb-apps-chat-sess_untitled_1');
      expect(chatRow).toBeInTheDocument();
      expect(chatRow).toHaveTextContent('未命名会话');
    }

    fireEvent.click(screen.getByTestId('wb-apps-chat-sess_untitled_1'));
    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: 'sess_untitled_1',
      reason: 'command',
    });
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('supports 1-char CJK custom session search in useResourceSearch while keeping dstu gated at 2 chars', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'chat_v2_search_content') return [];
      if (cmd === 'chat_v2_search_sessions') {
        return String(args?.query ?? '') === '高'
          ? [{ id: 'sess_calc', title: '高数错题复盘', description: '泰勒展开' }]
          : [];
      }
      return [];
    });

    const { result } = renderHook(() => useResourceSearch('高', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(dstuSearchMock).not.toHaveBeenCalled();
    expect(result.current.sessionResults).toEqual([
      {
        sessionId: 'sess_calc',
        title: '高数错题复盘',
        snippet: '泰勒展开',
      },
    ]);
  });
});
