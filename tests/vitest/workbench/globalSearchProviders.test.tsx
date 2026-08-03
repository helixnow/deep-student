/**
 * A12 Spotlight 全局搜索 — 行为级测试
 *
 * (a) 防抖后只发一次请求且参数正确
 * (b) 过期响应（先发后至）不覆盖新结果
 * (c) Enter / open() 触发正确的 workbenchBus.launch 载荷
 * (d) legacy openFileFromPalette 路由回归（见 resourceSearchWorkbenchRouting）
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act, waitFor } from '@testing-library/react';
import { fireEvent, screen } from '@testing-library/react';

import type { DstuNode } from '@/dstu/types';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  CONTENT_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_DEBOUNCE_MS,
  createChatProvider,
  createDstuProvider,
  createWorkbenchGlobalSearchProviders,
  openChatInWorkbench,
  openDstuInWorkbench,
  useAbortableDebouncedQuery,
  type WorkbenchSearchHost,
} from '@/features/workbench/search/globalSearchProviders';
import { useResourceSearch } from '@/command-palette/hooks/useResourceSearch';
import { AppsPanel } from '@/features/workbench/components/AppsPanel';
import {
  closeAppsPanel,
  openAppsPanel,
  isAppsPanelOpen,
} from '@/features/workbench/components/appsPanelStore';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import type { AppDefinition, AppWindowProps } from '@/features/workbench/core/types';

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

vi.mock('@/features/workbench/apps/chat/newSession', () => ({
  openChatSession: vi.fn((sessionId: string, reason?: string) => {
    workbenchBus.launch({
      typeId: 'chat',
      instanceKey: sessionId,
      reason: reason ?? 'command',
    });
    return 'chat-window';
  }),
  CHAT_APP_TYPE_ID: 'chat',
  registerChatApp: vi.fn(),
  launchNewChatSession: vi.fn(),
}));

const noteNode: DstuNode = {
  id: 'note_42',
  sourceId: 'note_42',
  path: '/course/note_42',
  name: 'Linear algebra',
  type: 'note',
  createdAt: 1,
  updatedAt: 1,
};

function makeHost(overrides?: Partial<WorkbenchSearchHost>): WorkbenchSearchHost {
  return {
    listLaunchableApps: () => [],
    appName: (app) => app.typeId,
    searchCommands: () => [],
    openApp: vi.fn(),
    openCommand: vi.fn(),
    openDstu: (node) => openDstuInWorkbench(node),
    openChat: (sessionId) => openChatInWorkbench(sessionId),
    untitledSessionTitle: 'Untitled',
    ...overrides,
  };
}

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
  };
}

describe('globalSearchProviders — debounce & abort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    dstuSearchMock.mockReset();
    dstuSearchMock.mockResolvedValue({ ok: true, value: [noteNode] });
    invokeMock.mockResolvedValue([
      {
        sessionId: 'sess_1',
        sessionTitle: 'Study chat',
        messageId: 'm1',
        blockId: 'b1',
        role: 'user',
        snippet: 'about <b>algebra</b>',
        updatedAt: '2026-01-01',
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 防抖后只发一次 dstu / chat 请求且参数正确', async () => {
    const { result, rerender } = renderHook(
      ({ q }) => useResourceSearch(q, true),
      { initialProps: { q: 'al' } },
    );

    // 快速连打：不应在防抖窗口内发请求
    rerender({ q: 'alg' });
    rerender({ q: 'alge' });
    expect(dstuSearchMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(dstuSearchMock).toHaveBeenCalledTimes(1);
    expect(dstuSearchMock).toHaveBeenCalledWith('alge', {
      limit: expect.any(Number),
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_search_content', {
      query: 'alge',
      limit: 30,
    });

    expect(result.current.fileResults).toHaveLength(1);
    expect(result.current.sessionResults[0]?.sessionId).toBe('sess_1');
    expect(result.current.sessionResults[0]?.snippet).toBe('about algebra');
    expect(result.current.loading).toBe(false);
  });

  it('(b) 过期响应（先发后至）不覆盖新结果', async () => {
    let resolveSlow: (value: unknown) => void = () => undefined;
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    dstuSearchMock.mockImplementationOnce(() => slowPromise);
    dstuSearchMock.mockResolvedValue({
      ok: true,
      value: [{ ...noteNode, id: 'note_new', name: 'New note' }],
    });

    const { result, rerender } = renderHook(
      ({ q }) =>
        useAbortableDebouncedQuery(
          q,
          true,
          async (query, signal) => {
            const provider = createDstuProvider(makeHost());
            return provider.search(query, signal);
          },
          {
            debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
            minChars: CONTENT_SEARCH_MIN_CHARS,
            empty: [],
          },
        ),
      { initialProps: { q: 'old' } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
    });

    // 慢请求已发出但未完成；切换到新查询
    rerender({ q: 'new' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.data[0]?.title).toBe('New note');

    // 慢响应迟到：不得覆盖
    await act(async () => {
      resolveSlow({ ok: true, value: [{ ...noteNode, name: 'Stale note' }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data[0]?.title).toBe('New note');
    expect(result.current.data.some((item) => item.title === 'Stale note')).toBe(false);
  });

  it('(c) open() 对资源 / 聊天发出正确 launch 载荷', () => {
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-1');
    try {
      openDstuInWorkbench(noteNode);
      expect(launch).toHaveBeenCalledWith({
        typeId: 'note',
        instanceKey: 'note_42',
        reason: 'command',
      });

      launch.mockClear();
      openChatInWorkbench('sess_99');
      expect(launch).toHaveBeenCalledWith({
        typeId: 'chat',
        instanceKey: 'sess_99',
        reason: 'command',
      });
    } finally {
      launch.mockRestore();
    }
  });

  it('provider 注册表包含 apps / commands / dstu / chat', () => {
    const providers = createWorkbenchGlobalSearchProviders(makeHost());
    expect(providers.map((p) => p.id)).toEqual(['apps', 'commands', 'dstu', 'chat']);
    expect(providers.every((p) => typeof p.search === 'function')).toBe(true);
  });

  it('chat provider 结果 open() 走 workbench launch', async () => {
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-chat');
    const provider = createChatProvider(makeHost());
    const controller = new AbortController();

    const searchPromise = provider.search('algebra', controller.signal);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const items = await searchPromise;

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('chat');
    expect(items[0].title).toBe('Study chat');

    await act(async () => {
      await items[0].open();
    });
    expect(launch).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: 'sess_1',
      reason: 'command',
    });
    launch.mockRestore();
  });
});

describe('AppsPanel — 内容检索 Enter open', () => {
  beforeEach(() => {
    vi.useRealTimers();
    invokeMock.mockReset();
    dstuSearchMock.mockReset();
    dstuSearchMock.mockResolvedValue({ ok: true, value: [noteNode] });
    invokeMock.mockResolvedValue([]);
    closeAppsPanel();
    workbenchBus.setEnabled(true);
    if (!appRegistry.get('notes')) {
      appRegistry.register(makeApp('notes'));
    }
  });

  afterEach(() => {
    closeAppsPanel();
  });

  it('(c) Enter 打开资源结果时 launch 参数正确', async () => {
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue('notes-win');
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.change(screen.getByTestId('wb-apps-search'), {
      target: { value: 'Linear' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('wb-apps-dstu-note_42')).toBeInTheDocument();
    });

    const row = screen.getByTestId('wb-apps-dstu-note_42');
    fireEvent.mouseEnter(row);
    fireEvent.keyDown(screen.getByTestId('wb-apps-panel'), { key: 'Enter' });

    expect(launch).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note_42',
      reason: 'command',
    });
    expect(isAppsPanelOpen()).toBe(false);
    launch.mockRestore();
  });
});
