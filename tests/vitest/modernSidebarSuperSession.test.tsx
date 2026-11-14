import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhCNSuperAgent from '@/locales/zh-CN/superAgent.json';
import enUSSuperAgent from '@/locales/en-US/superAgent.json';
import { ModernSidebar } from '@/components/ModernSidebar';
import {
  __resetSessionSidebarIndicatorsForTests,
  useSessionSidebarIndicators,
} from '@/features/chat/hooks/useSessionSidebarIndicators';
import { useSuperAgentEnabledStore } from '@/stores/superAgentEnabledStore';
import { officialUiRender } from '@/ui-plugins/testing/render';

const render = officialUiRender();

const { invokeMock, getCurrentSessionIdMock, superEntryMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getCurrentSessionIdMock: vi.fn(),
  superEntryMock: vi.fn(),
}));

const SUPER_SESSION = {
  id: 'sess_super',
  title: 'Super-agent',
  mode: 'chat',
  titleLocked: true,
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt: '2026-10-01T08:00:00Z',
  metadata: { pinned: true, super_agent: { active: true, version: 1, workspace_id: 'ws_1', hidden: false } },
};

vi.mock('@/features/chat/superSession/useSuperSessionEntry', () => ({
  useSuperSessionEntry: superEntryMock,
}));

vi.mock('@/components/ui/app-menu/AppMenu', () => {
  const React = require('react');
  const AppMenuContext = React.createContext(null);
  return {
    AppMenu: ({ children, open = false, onOpenChange }: any) => {
      const [internalOpen, setInternalOpen] = React.useState(open);
      const handleOpenChange = (nextOpen: boolean) => {
        setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
      };
      return (
        <AppMenuContext.Provider value={{ open: internalOpen, setOpen: handleOpenChange }}>
          {children}
        </AppMenuContext.Provider>
      );
    },
    AppMenuTrigger: ({ children }: any) => {
      const ctx: any = React.useContext(AppMenuContext);
      if (!React.isValidElement(children) || !ctx) return <>{children}</>;
      return React.cloneElement(children as any, {
        onContextMenu: (event: any) => {
          (children as any).props.onContextMenu?.(event);
          ctx.setOpen(true);
        },
      });
    },
    AppMenuContent: ({ children }: any) => {
      const ctx: any = React.useContext(AppMenuContext);
      if (!ctx?.open) return null;
      return <div data-testid="modern-sidebar-context-menu">{children}</div>;
    },
    AppMenuGroup: ({ children }: any) => <div>{children}</div>,
    AppMenuSeparator: () => <div />,
    AppMenuItem: ({ children, icon, onClick }: any) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {icon}
        <span>{children}</span>
      </button>
    ),
    AppMenuSwitchItem: ({ children, checked, onCheckedChange }: any) => (
      <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)}>
        <span>{children}</span>
      </button>
    ),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('@/command-palette/CommandPaletteProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/command-palette/CommandPaletteProvider')>();
  return { ...actual, useCommandPalette: () => ({ openSessionSearch: () => undefined }) };
});

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    getCurrentSessionId: getCurrentSessionIdMock,
    get: () => undefined,
    getActiveStreamingSessions: () => [],
    subscribe: () => () => undefined,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: () => undefined }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: () => undefined }));

function renderSidebar() {
  return render(<ModernSidebar currentView="chat-v2" onViewChange={() => undefined} />);
}

function threadRowNames(): string[] {
  return screen
    .getAllByRole('button')
    .filter((el) => el.getAttribute('data-workbench-sidebar-row') === 'thread')
    .map((el) => el.getAttribute('aria-label') ?? '');
}

describe('ModernSidebar Super-agent session row', () => {
  let superState: { enabled: boolean; sessionId: string | null; deleted: boolean };

  beforeEach(() => {
    __resetSessionSidebarIndicatorsForTests();
    getCurrentSessionIdMock.mockReturnValue(null);
    superState = { enabled: true, sessionId: SUPER_SESSION.id, deleted: false };
    useSuperAgentEnabledStore.setState({ enabled: true, sessionId: SUPER_SESSION.id, synced: true });
    superEntryMock.mockImplementation(() => ({
      enabled: superState.enabled,
      sessionId: superState.sessionId,
      session: superState.enabled ? SUPER_SESSION : null,
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          // 普通列表也带回了 Super 会话（metadata.pinned=true）：侧栏必须按 id 去重
          SUPER_SESSION,
          {
            id: 'pinned-normal', title: '置顶的普通会话', mode: 'chat',
            createdAt: '2026-10-05T08:00:00Z', updatedAt: '2026-10-05T08:00:00Z',
            metadata: { pinned: true },
          },
          {
            id: 'loose', title: '普通会话', mode: 'chat',
            createdAt: '2026-10-06T08:00:00Z', updatedAt: '2026-10-06T08:00:00Z',
          },
        ]);
      }
      if (command === 'chat_v2_delete_session') {
        superState.deleted = true;
        return Promise.resolve(null);
      }
      if (command === 'super_session_get_state') {
        return Promise.resolve({ enabled: true, sessionId: 'sess_super_new', workspaceId: 'ws_2', pendingInbox: 0 });
      }
      return Promise.resolve([]);
    });
  });

  it('pins the Super-agent row above every other pinned row, exactly once', async () => {
    renderSidebar();
    await screen.findByRole('button', { name: '置顶的普通会话' });

    const names = threadRowNames();
    expect(names.filter((name) => name === 'Super-agent')).toHaveLength(1);
    expect(names[0]).toBe('Super-agent');
    expect(names.indexOf('置顶的普通会话')).toBeGreaterThan(0);
    expect(within(screen.getByRole('button', { name: 'Super-agent' })).getByTestId('sidebar-super-session-badge')).toBeInTheDocument();
  });

  it('hides the pin and archive actions but keeps rename and delete', async () => {
    renderSidebar();
    const superRow = await screen.findByRole('button', { name: 'Super-agent' });
    const rowContainer = superRow.closest('[data-session-variant="super"]') as HTMLElement;
    expect(rowContainer).not.toBeNull();
    expect(within(rowContainer).queryByTestId('recent-session-pin-icon')).toBeNull();
    expect(within(rowContainer).queryByLabelText('归档会话')).toBeNull();

    // 普通置顶行仍保留置顶按钮
    const normalRow = screen.getByRole('button', { name: '置顶的普通会话' }).closest('.group\\/thread-row') as HTMLElement;
    expect(within(normalRow).getByTestId('recent-session-pin-icon')).toBeInTheDocument();

    fireEvent.contextMenu(superRow);
    const menu = await within(rowContainer).findByTestId('modern-sidebar-context-menu');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toContain('重命名会话');
    expect(items).toContain('删除会话');
    expect(items).not.toContain('取消置顶');
    expect(items).not.toContain('置顶线程');
    expect(items).not.toContain('归档线程');
  });

  it('explains in the delete confirmation that a fresh Super-agent session replaces it', async () => {
    renderSidebar();
    const superRow = await screen.findByRole('button', { name: 'Super-agent' });
    const rowContainer = superRow.closest('[data-session-variant="super"]') as HTMLElement;
    fireEvent.contextMenu(superRow);
    const menu = await within(rowContainer).findByTestId('modern-sidebar-context-menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /删除会话/ }));

    // 测试环境的 react-i18next 桩不含 superAgent 命名空间，渲染的是键名；文案本身在下面单独断言
    expect(await within(rowContainer).findByText('superAgent:sidebar.deleteConfirm')).toBeInTheDocument();
    expect(within(rowContainer).queryByText('永久删除？不可恢复')).toBeNull();
    expect(zhCNSuperAgent.sidebar.deleteConfirm).toContain('新建一个空的 Super-agent 会话');
    expect(zhCNSuperAgent.sidebar.deleteConfirm).toContain('后台任务会停止');
    expect(enUSSuperAgent.sidebar.deleteConfirm).toMatch(/new empty Super-agent session/);
  });

  it('switches to the replacement Super-agent session after deleting the active one', async () => {
    getCurrentSessionIdMock.mockReturnValue(SUPER_SESSION.id);
    const navigated: string[] = [];
    const onNavigate = (event: Event) => navigated.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    window.addEventListener('navigate-to-session', onNavigate);
    try {
      renderSidebar();
      const superRow = await screen.findByRole('button', { name: 'Super-agent' });
      const rowContainer = superRow.closest('[data-session-variant="super"]') as HTMLElement;
      fireEvent.contextMenu(superRow);
      const menu = await within(rowContainer).findByTestId('modern-sidebar-context-menu');
      fireEvent.click(within(menu).getByRole('menuitem', { name: /删除会话/ }));
      fireEvent.click(await within(rowContainer).findByRole('button', { name: /删除|Delete/ }));

      await waitFor(() => expect(navigated).toContain('sess_super_new'));
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_delete_session', { sessionId: SUPER_SESSION.id });
      expect(useSuperAgentEnabledStore.getState().sessionId).toBe('sess_super_new');
    } finally {
      window.removeEventListener('navigate-to-session', onNavigate);
    }
  });

  it('shows the same streaming / unread indicators as regular rows', async () => {
    useSessionSidebarIndicators.setState({ streamingSessionIds: [SUPER_SESSION.id] });
    const { rerender } = renderSidebar();
    const superRow = await screen.findByRole('button', { name: 'Super-agent' });
    expect(within(superRow).getByTestId('sidebar-streaming-indicator')).toBeInTheDocument();

    useSessionSidebarIndicators.setState({ streamingSessionIds: [], unreadSessionIds: [SUPER_SESSION.id] });
    rerender(<ModernSidebar currentView="chat-v2" onViewChange={() => undefined} />);
    await waitFor(() => {
      expect(within(screen.getByRole('button', { name: 'Super-agent' })).getByTestId('sidebar-unread-indicator')).toBeInTheDocument();
    });
  });

  it('renders no Super-agent row when the feature is disabled', async () => {
    superState.enabled = false;
    superState.sessionId = null;
    renderSidebar();
    await screen.findByRole('button', { name: '置顶的普通会话' });
    expect(screen.queryByRole('button', { name: 'Super-agent' })).toBeNull();
  });
});
