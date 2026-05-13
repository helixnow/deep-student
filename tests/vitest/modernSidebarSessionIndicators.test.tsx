import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModernSidebar } from '@/components/ModernSidebar';
import {
  __resetSessionSidebarIndicatorsForTests,
  useSessionSidebarIndicators,
} from '@/features/chat/hooks/useSessionSidebarIndicators';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const { getCurrentSessionIdMock } = vi.hoisted(() => ({
  getCurrentSessionIdMock: vi.fn(),
}));

const { getSessionStoreMock } = vi.hoisted(() => ({
  getSessionStoreMock: vi.fn(),
}));

vi.mock('@/components/ui/app-menu/AppMenu', () => {
  const React = require('react');

  const AppMenuContext = React.createContext(null);

  return {
    AppMenu: ({ children, open = false, onOpenChange }) => {
      const [internalOpen, setInternalOpen] = React.useState(open);
      const handleOpenChange = (nextOpen) => {
        setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
      };
      return (
        <AppMenuContext.Provider value={{ open: internalOpen, setOpen: handleOpenChange }}>
          {children}
        </AppMenuContext.Provider>
      );
    },
    AppMenuTrigger: ({ children }) => {
      const ctx = React.useContext(AppMenuContext);
      if (!React.isValidElement(children) || !ctx) return <>{children}</>;
      return React.cloneElement(children, {
        onContextMenu: (event) => {
          children.props.onContextMenu?.(event);
          ctx.setOpen(true);
        },
      });
    },
    AppMenuContent: ({ children }) => {
      const ctx = React.useContext(AppMenuContext);
      if (!ctx?.open) return null;
      return <div data-testid="modern-sidebar-context-menu">{children}</div>;
    },
    AppMenuGroup: ({ children }) => <div>{children}</div>,
    AppMenuSeparator: () => <div data-testid="modern-sidebar-context-menu-separator" />,
    AppMenuItem: ({ children, icon, onClick }) => (
      <button type="button" onClick={onClick}>
        {icon}
        <span>{children}</span>
      </button>
    ),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    getCurrentSessionId: getCurrentSessionIdMock,
    get: getSessionStoreMock,
    getActiveStreamingSessions: () => [],
    subscribe: () => () => undefined,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: () => undefined,
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: () => undefined,
}));

describe('ModernSidebar session indicators runtime', () => {
  beforeEach(() => {
    __resetSessionSidebarIndicatorsForTests();
    getCurrentSessionIdMock.mockReturnValue(null);
    getSessionStoreMock.mockReturnValue(undefined);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          {
            id: 'session-1',
            title: '代数复习',
            updatedAt: '2026-04-06T08:00:00Z',
            createdAt: '2026-04-06T08:00:00Z',
            mode: 'chat',
          },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it('renders the streaming ring ahead of unread state and hover actions', async () => {
    useSessionSidebarIndicators.setState({
      streamingSessionIds: ['session-1'],
      unreadSessionIds: ['session-1'],
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const sessionButton = await screen.findByRole('button', { name: '代数复习' });

    expect(within(sessionButton).getByTestId('sidebar-streaming-indicator')).toBeInTheDocument();
    expect(within(sessionButton).queryByTestId('sidebar-unread-indicator')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('归档会话')).not.toBeInTheDocument();
  });

  it('clears the unread dot after the user opens the completed session', async () => {
    const user = userEvent.setup();
    useSessionSidebarIndicators.setState({
      unreadSessionIds: ['session-1'],
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const sessionButton = await screen.findByRole('button', { name: '代数复习' });
    expect(within(sessionButton).getByTestId('sidebar-unread-indicator')).toBeInTheDocument();

    await user.click(sessionButton);

    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-unread-indicator')).not.toBeInTheDocument();
    });
  });
});
