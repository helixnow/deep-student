import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModernSidebar } from '@/components/ModernSidebar';
import {
  __resetSessionSidebarIndicatorsForTests,
  useSessionSidebarIndicators,
} from '@/features/chat/hooks/useSessionSidebarIndicators';

const { invokeMock, getCurrentSessionId, beginPrefetch, cancelPrefetch, rowRenderCounts } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getCurrentSessionId: vi.fn(() => null as string | null),
  beginPrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  rowRenderCounts: new Map<string, number>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    getCurrentSessionId,
    get: () => undefined,
    getAllSessionIds: () => [],
    getActiveStreamingSessions: () => [],
    subscribe: () => () => undefined,
  },
}));
vi.mock('@/features/chat/core/session/sessionPrefetch', () => ({
  beginSessionHoverPrefetch: beginPrefetch,
  cancelSessionHoverPrefetch: cancelPrefetch,
}));
vi.mock('@/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ openSessionSearch: () => undefined }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: () => undefined }));
vi.mock('@/features/settings/components/workbenchMode', () => ({
  readWorkbenchModeEnabled: async () => false,
  persistWorkbenchModeEnabled: async () => true,
}));
vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { isEnabled: () => false },
}));

// Keep real sidebar state transitions while eliminating IPC refresh timing from render counts.
vi.mock('@/features/chat/hooks/useSessionManagement', () => {
  const React = require('react');
  const groups: never[] = [];
  const refresh = async () => undefined;
  return {
    useSidebarSessionData: () => {
      const [sessions, setSessions] = React.useState(() => ['Alpha', 'Beta', 'Gamma'].map((title) => ({
        id: title.toLowerCase(), title, mode: 'chat',
        createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z',
      })));
      return { sessions, setSessions, groups, setGroups: () => undefined,
        hasMoreUngrouped: false, isLoadingMore: false, isLoaded: true,
        loadMoreUngrouped: refresh, refresh };
    },
  };
});

// Count rendered thread primitives inside the actual memoized SessionRow, not parent JSX creation.
vi.mock('@/features/workbench/components/sidebar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/workbench/components/sidebar')>();
  const React = require('react');
  return {
    ...actual,
    WorkbenchSidebarRow: React.forwardRef((props: any, ref: any) => {
      if (props.rowType === 'thread') {
        const title = props['aria-label'];
        rowRenderCounts.set(title, (rowRenderCounts.get(title) ?? 0) + 1);
      }
      return <actual.WorkbenchSidebarRow {...props} ref={ref} />;
    }),
  };
});

vi.mock('framer-motion', () => {
  const React = require('react');
  const motionElement = (tag: string) => React.forwardRef((props: any, ref: any) => {
    const { initial, animate, exit, transition, layout, ...domProps } = props;
    return React.createElement(tag, { ...domProps, ref });
  });
  return { AnimatePresence: ({ children }: any) => children,
    motion: { div: motionElement('div'), span: motionElement('span') },
    useReducedMotion: () => true };
});
vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: any) => children,
}));
vi.mock('@/components/ui/app-menu/AppMenu', () => {
  const React = require('react');
  const Context = React.createContext(null);
  return {
    AppMenu: ({ children, open, onOpenChange }: any) => {
      const [internalOpen, setInternalOpen] = React.useState(false);
      return <Context.Provider value={{ open: open ?? internalOpen, setOpen: onOpenChange ?? setInternalOpen }}>{children}</Context.Provider>;
    },
    AppMenuTrigger: ({ children }: any) => {
      const context = React.useContext(Context);
      return React.cloneElement(children, { onContextMenu: (event: any) => {
        children.props.onContextMenu?.(event);
        context.setOpen(true);
      } });
    },
    AppMenuContent: ({ children }: any) => {
      const context = React.useContext(Context);
      return context.open ? <div data-testid="session-context-menu">{children}</div> : null;
    },
    AppMenuGroup: ({ children }: any) => children,
    AppMenuSeparator: () => null,
    AppMenuItem: ({ children, onClick }: any) => <button type="button" onClick={onClick}>{children}</button>,
    AppMenuSwitchItem: () => null,
  };
});

const row = (title: string) => screen.getByRole('button', { name: title }).parentElement!;
const renderedTitles = () => [...rowRenderCounts.keys()].sort();

async function mountSidebar() {
  const result = render(<ModernSidebar currentView="chat-v2" onViewChange={() => undefined} />);
  await screen.findByRole('button', { name: 'Alpha' });
  // Flush the asynchronous workbench preference before counting interaction work.
  await act(async () => {});
  rowRenderCounts.clear();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionSidebarIndicatorsForTests();
  getCurrentSessionId.mockReturnValue(null);
  invokeMock.mockResolvedValue(null);
  rowRenderCounts.clear();
  localStorage.removeItem('chat-v2-last-session-id');
});

describe('memoized sidebar session rows', () => {
  it('renders only affected rows for active selection, menus, and stream indicators', async () => {
    await mountSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(renderedTitles()).toEqual(['Alpha']);
    expect(rowRenderCounts.get('Alpha')).toBe(1);

    rowRenderCounts.clear();
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(renderedTitles()).toEqual(['Alpha', 'Beta']);

    rowRenderCounts.clear();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Gamma' }));
    expect(renderedTitles()).toEqual(['Gamma']);

    rowRenderCounts.clear();
    act(() => useSessionSidebarIndicators.setState({ streamingSessionIds: ['alpha'] }));
    expect(renderedTitles()).toEqual(['Alpha']);
    expect(within(row('Alpha')).getByTestId('sidebar-streaming-indicator')).toBeInTheDocument();
    expect(within(row('Alpha')).queryByRole('button', { name: '归档会话' })).not.toBeInTheDocument();

    rowRenderCounts.clear();
    act(() => useSessionSidebarIndicators.setState({ unreadSessionIds: ['gamma'] }));
    expect(renderedTitles()).toEqual(['Gamma']);
  });

  it('keeps latest navigation callbacks without rendering unchanged rows', async () => {
    const view = await mountSidebar();
    const onViewChange = vi.fn();
    view.rerender(<ModernSidebar currentView="settings" onViewChange={onViewChange} />);
    expect(renderedTitles()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onViewChange).toHaveBeenCalledWith('chat-v2');
  });

  it('keeps rename drafts current while leaving sibling rows untouched and respecting IME', async () => {
    await mountSidebar();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名会话' }));
    const input = screen.getByRole('textbox');
    rowRenderCounts.clear();
    fireEvent.change(input, { target: { value: '新标题' } });
    expect(renderedTitles()).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_session_settings', {
      sessionId: 'alpha', settings: { title: '新标题' },
    }));
    await screen.findByRole('button', { name: '新标题' });
    expect(renderedTitles()).toEqual(['新标题']);
  });

  it('preserves hover prefetch, drag payloads, and archive confirmation for the current selection', async () => {
    await mountSidebar();
    const betaButton = screen.getByRole('button', { name: 'Beta' });
    fireEvent.mouseEnter(betaButton);
    expect(beginPrefetch).toHaveBeenCalledWith('beta');
    fireEvent.mouseLeave(betaButton);
    expect(cancelPrefetch).toHaveBeenCalledWith('beta');
    const dataTransfer = { effectAllowed: 'all', setData: vi.fn() };
    fireEvent.dragStart(betaButton, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-modern-sidebar-session-id', 'beta');
    fireEvent.dragEnd(betaButton);

    fireEvent.click(betaButton);
    fireEvent.click(within(row('Beta')).getByRole('button', { name: '归档会话' }));
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_archive_session', expect.anything());
    fireEvent.click(within(row('Beta')).getByRole('button', { name: '确认归档会话' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('chat_v2_archive_session', { sessionId: 'beta' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'page');
  });

  it('retains inline delete confirmation and pin persistence', async () => {
    await mountSidebar();
    fireEvent.click(within(row('Alpha')).getByRole('button', { name: '置顶会话' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_session_settings', {
      sessionId: 'alpha', settings: { metadata: { pinned: true } },
    }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Beta' }));
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_delete_session', expect.anything());
    expect(screen.getByText('永久删除？不可恢复')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('chat_v2_delete_session', { sessionId: 'beta' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument());
  });
});
