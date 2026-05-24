import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModernSidebar, reorderSidebarSessionGroups } from '@/components/ModernSidebar';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const { getCurrentSessionIdMock } = vi.hoisted(() => ({
  getCurrentSessionIdMock: vi.fn(),
}));

const { getSessionStoreMock } = vi.hoisted(() => ({
  getSessionStoreMock: vi.fn(),
}));

const { showGlobalNotificationMock } = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
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
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: () => undefined,
}));

describe('ModernSidebar shell navigation', () => {
  beforeEach(() => {
    getCurrentSessionIdMock.mockReturnValue(null);
    getSessionStoreMock.mockReturnValue(undefined);
    showGlobalNotificationMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it('keeps shared shell destinations in the global left sidebar', async () => {
    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '新会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '学习资源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '待办' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '技能管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('shows a quiet empty hint inside expanded groups with no conversations', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          {
            id: 'group-114',
            name: '114514',
            icon: null,
            status: 'active',
            sortOrder: 0,
            createdAt: '2026-04-27T00:00:00.000Z',
            updatedAt: '2026-04-27T00:00:00.000Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '114514' })).toBeInTheDocument();
    expect(screen.getByText('暂无对话')).toBeInTheDocument();
  });

  it('does not render the update badge before an update is available', async () => {
    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
        updater={{
          checking: false,
          available: false,
          info: null,
          downloading: false,
          performUpdateAction: vi.fn(async () => {}),
        }}
      />
    );

    expect(await screen.findByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByText('更新')).not.toBeInTheDocument();
  });

  it('renders the update badge and triggers update action when clicked', async () => {
    const performUpdateAction = vi.fn(async () => {});

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
        updater={{
          checking: false,
          available: true,
          info: { version: '1.2.3' },
          downloading: false,
          performUpdateAction,
        }}
      />
    );

    const badge = await screen.findByText('更新');
    fireEvent.click(badge);

    expect(performUpdateAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the global chat entry label fixed even when the current session has a title', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-2');
    getSessionStoreMock.mockReturnValue({
      getState: () => ({
        title: '当前会话标题',
      }),
    });
    invokeMock.mockResolvedValue([
      { id: 'session-1', title: '旧会话' },
      { id: 'session-2', title: '当前会话标题' },
    ]);

    const { container } = render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const chatNavButton = await waitFor(() => container.querySelector('[data-tour-id="nav-chat-v2"]'));
    expect(chatNavButton).toHaveAttribute('aria-label', '新会话');
    expect(screen.getByRole('button', { name: '新会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '当前会话标题' })).toBeInTheDocument();
  });

  it('keeps the global chat entry label fixed when the current store is unavailable', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-2');
    invokeMock.mockResolvedValue([
      { id: 'session-1', title: '旧会话' },
      { id: 'session-2', title: '最近列表标题' },
    ]);

    const { container } = render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const chatNavButton = await waitFor(() => container.querySelector('[data-tour-id="nav-chat-v2"]'));
    expect(chatNavButton).toHaveAttribute('aria-label', '新会话');
    expect(screen.getByRole('button', { name: '最近列表标题' })).toBeInTheDocument();
  });

  it('treats the primary chat nav entry as a new-session action', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <ModernSidebar
        currentView="learning-hub"
        onViewChange={onViewChange}
      />
    );

    await user.click(await screen.findByRole('button', { name: '新会话' }));

    expect(onViewChange).toHaveBeenCalledWith('chat-v2');
    await waitFor(() => {
      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: COMMAND_EVENTS.CHAT_NEW_SESSION,
      }));
    });
  });

  it('does not mark the new-session action as the current page', async () => {
    const { container } = render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const chatNavButton = await waitFor(() => container.querySelector('[data-tour-id="nav-chat-v2"]'));

    expect(chatNavButton).not.toHaveAttribute('aria-current');
    expect(chatNavButton).not.toHaveClass('desktop-shell-nav-row--active');
  });

  it('keeps the new-session shortcut hint scoped to macOS desktop hover', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(sidebarSource).toContain("import { formatShortcut } from '@/command-palette/registry/shortcutUtils';");
    expect(sidebarSource).toContain("import { isMacOS, isMobilePlatform } from '@/utils/platform';");
    expect(sidebarSource).toContain('function NewSessionShortcutHint({ shortcut }: { shortcut: string })');
    expect(sidebarSource).toContain('function isFinePointerDesktopSurface(): boolean');
    expect(sidebarSource).toContain("window.matchMedia('(pointer: fine)').matches");
    expect(sidebarSource).toContain('() => isMacOS() && !isMobilePlatform() && isFinePointerDesktopSurface()');
    expect(sidebarSource).toContain("formatShortcut('mod+n')");
    expect(sidebarSource).toContain("className={isNewSessionAction ? 'group/new-session-action' : undefined}");
    expect(sidebarSource).toContain('group-hover/new-session-action:opacity-100');
    expect(sidebarSource).toContain('group-focus-visible/new-session-action:opacity-100');
    expect(sidebarSource).toContain('lg:inline-flex');
    expect(sidebarSource).toContain('rightSlot={isNewSessionAction && shouldShowMacDesktopNewSessionShortcut ? (');
  });

  it('falls back to the default chat label when the current session title is unavailable', async () => {
    getCurrentSessionIdMock.mockReturnValue('missing-session');
    invokeMock.mockResolvedValue([
      { id: 'session-1', title: '别的会话' },
    ]);

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '新会话' })).toBeInTheDocument();
  });

  it('renders topics and loose conversations as separate collapsible sidebar sections', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-2');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '几何证明', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-3', title: '未分组会话', updatedAt: '2026-04-06T07:00:00Z', createdAt: '2026-04-06T07:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: /^数学$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^课题$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^对话$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^未分组$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '代数复习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '几何证明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '未分组会话' })).toBeInTheDocument();

    const conversationNav = screen.getByRole('navigation', { name: '对话' });
    expect(within(conversationNav).getByRole('button', { name: '未分组会话' })).toBeInTheDocument();
    expect(conversationNav.querySelector('.lucide-folder')).toBeNull();
  });

  it('keeps primary navigation outside the recent sessions scroll viewport', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    const { container } = render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '数学' })).toBeInTheDocument();

    const fixedRegion = container.querySelector('[data-sidebar-fixed-region="primary-navigation"]');
    const scrollRegion = container.querySelector('[data-sidebar-scroll-region="sessions"]');

    expect(fixedRegion).not.toBeNull();
    expect(scrollRegion).not.toBeNull();
    expect(within(fixedRegion as HTMLElement).getByRole('button', { name: '新会话' })).toBeInTheDocument();
    expect(within(scrollRegion as HTMLElement).queryByRole('button', { name: '新会话' })).not.toBeInTheDocument();
    expect(within(scrollRegion as HTMLElement).getByRole('button', { name: '数学' })).toBeInTheDocument();
    expect(within(scrollRegion as HTMLElement).getByRole('button', { name: '代数复习' })).toBeInTheDocument();
  });

  it('keeps empty topics visible before they contain sessions', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '未分组会话', updatedAt: '2026-04-06T07:00:00Z', createdAt: '2026-04-06T07:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-empty', name: '空分组', icon: '📁', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: /^空分组$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^课题$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^对话$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^未分组$/ })).not.toBeInTheDocument();
  });

  it('keeps the conversation section visible when hidden drafts leave no visible sessions', async () => {
    const user = userEvent.setup();
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const conversationButton = await screen.findByRole('button', { name: /^对话$/ });
    expect(conversationButton).toBeInTheDocument();
    expect(screen.queryByText('最近')).not.toBeInTheDocument();

    await user.hover(conversationButton);
    await user.click(screen.getByRole('button', { name: 'New Session' }));

    expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'modern-sidebar:group-action',
      detail: { action: 'create-session', groupId: null },
    }));
  });

  it('collapses pinned topics and loose conversation sections from their section headers', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-pinned', title: '优先会话', updatedAt: '2026-04-06T10:00:00Z', createdAt: '2026-04-06T10:00:00Z', mode: 'chat', metadata: { pinned: true } },
          { id: 'session-topic', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-loose', title: '随手问答', updatedAt: '2026-04-06T07:00:00Z', createdAt: '2026-04-06T07:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '优先会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数学' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '随手问答' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^置顶$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '优先会话' })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^课题$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '数学' })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^对话$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '随手问答' })).not.toBeInTheDocument();
    });
  });

  it('collapses grouped topic sessions when the group header is toggled', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const groupButton = await screen.findByRole('button', { name: /^数学$/ });
    expect(screen.getByRole('button', { name: '代数复习' })).toBeInTheDocument();

    await user.click(groupButton);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '代数复习' })).not.toBeInTheDocument();
    });
  });

  it('limits topic group sessions to five and toggles overflow from the bottom control', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve(
          Array.from({ length: 7 }, (_, index) => {
            const sessionNumber = index + 1;
            return {
              id: `session-${sessionNumber}`,
              title: `数学会话 ${sessionNumber}`,
              updatedAt: `2026-04-06T0${sessionNumber}:00:00Z`,
              createdAt: `2026-04-06T0${sessionNumber}:00:00Z`,
              mode: 'chat',
              groupId: 'group-math',
            };
          })
        );
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const groupButton = await screen.findByRole('button', { name: '数学' });
    const groupSection = groupButton.closest('section') as HTMLElement;

    expect(within(groupSection).getByRole('button', { name: '数学会话 7' })).toBeInTheDocument();
    expect(within(groupSection).getByRole('button', { name: '数学会话 3' })).toBeInTheDocument();
    expect(within(groupSection).queryByRole('button', { name: '数学会话 2' })).not.toBeInTheDocument();
    expect(within(groupSection).queryByRole('button', { name: '数学会话 1' })).not.toBeInTheDocument();

    const expandButton = within(groupSection).getByRole('button', { name: '展开显示' });
    expect(within(groupSection).getAllByRole('button').at(-1)).toBe(expandButton);
    expect(expandButton.querySelector('svg')).toBeNull();
    expect(expandButton.className).not.toContain('hover:');
    expect(expandButton).toHaveClass('text-left');
    expect(expandButton).toHaveClass('pl-9');
    expect(expandButton).toHaveClass('cursor-default');
    expect(expandButton).not.toHaveClass('px-2.5');
    expect(expandButton).not.toHaveClass('text-center');
    expect(expandButton).not.toHaveClass('cursor-pointer');

    await user.click(expandButton);

    expect(await within(groupSection).findByRole('button', { name: '数学会话 2' })).toBeInTheDocument();
    expect(within(groupSection).getByRole('button', { name: '数学会话 1' })).toBeInTheDocument();
    const collapseButton = within(groupSection).getByRole('button', { name: '折叠显示' });
    expect(within(groupSection).getAllByRole('button').at(-1)).toBe(collapseButton);
    expect(collapseButton.querySelector('svg')).toBeNull();
    expect(collapseButton.className).not.toContain('hover:');
    expect(collapseButton).toHaveClass('text-left');
    expect(collapseButton).toHaveClass('pl-9');
    expect(collapseButton).toHaveClass('cursor-default');
    expect(collapseButton).not.toHaveClass('px-2.5');
    expect(collapseButton).not.toHaveClass('text-center');
    expect(collapseButton).not.toHaveClass('cursor-pointer');

    await user.click(collapseButton);

    await waitFor(() => {
      expect(within(groupSection).queryByRole('button', { name: '数学会话 2' })).not.toBeInTheDocument();
    });
    expect(within(groupSection).queryByRole('button', { name: '数学会话 1' })).not.toBeInTheDocument();
    expect(within(groupSection).getByRole('button', { name: '展开显示' })).toBeInTheDocument();
  });

  it('limits loose conversation sessions to five and toggles overflow from the bottom control', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve(
          Array.from({ length: 8 }, (_, index) => {
            const sessionNumber = index + 1;
            return {
              id: `conversation-${sessionNumber}`,
              title: `对话会话 ${sessionNumber}`,
              updatedAt: `2026-04-06T0${sessionNumber}:00:00Z`,
              createdAt: `2026-04-06T0${sessionNumber}:00:00Z`,
              mode: 'chat',
            };
          })
        );
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const conversationNav = await screen.findByRole('navigation', { name: '对话' });

    expect(within(conversationNav).getByRole('button', { name: '对话会话 8' })).toBeInTheDocument();
    expect(within(conversationNav).getByRole('button', { name: '对话会话 4' })).toBeInTheDocument();
    expect(within(conversationNav).queryByRole('button', { name: '对话会话 3' })).not.toBeInTheDocument();
    expect(within(conversationNav).queryByRole('button', { name: '对话会话 1' })).not.toBeInTheDocument();

    const expandButton = within(conversationNav).getByRole('button', { name: '展开显示' });
    expect(within(conversationNav).getAllByRole('button').at(-1)).toBe(expandButton);
    expect(expandButton.querySelector('svg')).toBeNull();
    expect(expandButton.className).not.toContain('hover:');
    expect(expandButton).toHaveClass('text-left');
    expect(expandButton).toHaveClass('pl-9');
    expect(expandButton).toHaveClass('cursor-default');
    expect(expandButton).not.toHaveClass('px-2.5');
    expect(expandButton).not.toHaveClass('text-center');
    expect(expandButton).not.toHaveClass('cursor-pointer');

    await user.click(expandButton);

    expect(await within(conversationNav).findByRole('button', { name: '对话会话 3' })).toBeInTheDocument();
    expect(within(conversationNav).getByRole('button', { name: '对话会话 1' })).toBeInTheDocument();
    const collapseButton = within(conversationNav).getByRole('button', { name: '折叠显示' });
    expect(within(conversationNav).getAllByRole('button').at(-1)).toBe(collapseButton);
    expect(collapseButton.querySelector('svg')).toBeNull();
    expect(collapseButton.className).not.toContain('hover:');
    expect(collapseButton).toHaveClass('text-left');
    expect(collapseButton).toHaveClass('pl-9');
    expect(collapseButton).toHaveClass('cursor-default');
    expect(collapseButton).not.toHaveClass('px-2.5');
    expect(collapseButton).not.toHaveClass('text-center');
    expect(collapseButton).not.toHaveClass('cursor-pointer');

    await user.click(collapseButton);

    await waitFor(() => {
      expect(within(conversationNav).queryByRole('button', { name: '对话会话 3' })).not.toBeInTheDocument();
    });
    expect(within(conversationNav).queryByRole('button', { name: '对话会话 1' })).not.toBeInTheDocument();
    expect(within(conversationNav).getByRole('button', { name: '展开显示' })).toBeInTheDocument();
  });

  it('does not render a trailing chevron after grouped session actions', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const groupButton = await screen.findByRole('button', { name: /^数学$/ });

    expect(within(groupButton).getByRole('button', { name: 'Group Actions' })).toBeInTheDocument();
    expect(within(groupButton).getByRole('button', { name: '在 数学 中新建会话' })).toBeInTheDocument();
    expect(groupButton.querySelector('.lucide-chevron-right')).toBeNull();
  });

  it('toggles all topic groups from the topic section header action', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '力学推导', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-physics' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
          { id: 'group-physics', name: '物理', icon: '🚀', sortOrder: 1, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    expect(await screen.findByRole('button', { name: '代数复习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '力学推导' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起所有课题' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '代数复习' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '力学推导' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '展开所有课题' }));

    expect(await screen.findByRole('button', { name: '代数复习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '力学推导' })).toBeInTheDocument();
  });

  it('dispatches create-group action from the topic section header folder button', async () => {
    const user = userEvent.setup();
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    await screen.findByRole('button', { name: '数学' });
    await user.click(screen.getByRole('button', { name: '新建课题' }));

    expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
    expect(dispatchEventSpy.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent);
    expect((dispatchEventSpy.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      action: 'create-group',
    });
  });

  it('keeps only the current session active instead of also highlighting its parent group', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-2');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '几何证明', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-math' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const groupButton = await screen.findByRole('button', { name: '数学' });
    const activeSessionButton = screen.getByRole('button', { name: '几何证明' });

    expect(groupButton).not.toHaveClass('desktop-shell-nav-row--active');
    expect(activeSessionButton).toHaveClass('desktop-shell-thread-row--active');
  });

  it('does not mark any expanded groups as active when a specific session is selected', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-2');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '几何证明', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-3', title: '力学推导', updatedAt: '2026-04-06T10:00:00Z', createdAt: '2026-04-06T10:00:00Z', mode: 'chat', groupId: 'group-physics' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
          { id: 'group-physics', name: '物理', icon: '🚀', sortOrder: 1, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const firstGroupButton = await screen.findByRole('button', { name: '数学' });
    const secondGroupButton = screen.getByRole('button', { name: '物理' });

    expect(firstGroupButton).not.toHaveClass('desktop-shell-nav-row--active');
    expect(secondGroupButton).not.toHaveClass('desktop-shell-nav-row--active');
  });

  it('aligns recent session titles with recent group titles on the same left text baseline', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '114514', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '未命名会话', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const groupButton = await screen.findByRole('button', { name: '未命名会话' });
    const titledSessionButton = screen.getByRole('button', { name: '114514' });
    const untitledSessionButton = screen.getByRole('button', { name: '未命名对话' });

    const groupRow = groupButton.querySelector('span.flex.min-w-0.flex-1.items-center.gap-2\\.5');
    const titledSessionLabel = titledSessionButton.querySelector('span.block.min-w-0.flex-1.truncate.leading-4');
    const untitledSessionLabel = untitledSessionButton.querySelector('span.block.min-w-0.flex-1.truncate.leading-4');
    const titledSessionOffsetRow = titledSessionButton.querySelector('span.flex.min-w-0.flex-1.items-center.gap-2\\.5');

    expect(groupRow).not.toBeNull();
    expect(titledSessionLabel).not.toBeNull();
    expect(untitledSessionLabel).not.toBeNull();
    expect(titledSessionOffsetRow).not.toBeNull();
  });

  it('marks topic session groups as draggable and exposes grabbed state during drag start', async () => {
    invokeMock.mockImplementation((command: string, payload?: unknown) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '力学推导', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-physics' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
          { id: 'group-physics', name: '物理', icon: '🚀', sortOrder: 1, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
        ]);
      }
      if (command === 'chat_v2_reorder_groups') {
        return Promise.resolve(payload ?? null);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const mathButton = await screen.findByRole('button', { name: '数学' });
    const physicsButton = screen.getByRole('button', { name: '物理' });
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'move',
      setData: vi.fn(),
      getData: vi.fn(() => 'group-physics'),
    };

    fireEvent.dragStart(physicsButton, { dataTransfer });
    await waitFor(() => {
      expect(physicsButton).toHaveAttribute('aria-grabbed', 'true');
    });

    expect(physicsButton).toHaveAttribute('draggable', 'true');
    expect(mathButton).toHaveAttribute('draggable', 'true');
  });

  it('reorders sidebar session groups by source and target ids', () => {
    const reordered = reorderSidebarSessionGroups([
      { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
      { id: 'group-physics', name: '物理', icon: '🚀', sortOrder: 1, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
      { id: 'group-chemistry', name: '化学', icon: '🧪', sortOrder: 2, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
    ], 'group-physics', 'group-math');

    expect(reordered.map((group) => group.id)).toEqual(['group-physics', 'group-math', 'group-chemistry']);
    expect(reordered.map((group) => group.sortOrder)).toEqual([0, 1, 2]);
  });

  it('wires topic group drop handlers to persist reordered group ids through the sidebar source', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(sidebarSource).toContain("await invoke('chat_v2_reorder_groups', { groupIds: reorderedIds });");
    expect(sidebarSource).toContain("onDrop={(event) => void handleRecentGroupDrop(event, group.id)}");
    expect(sidebarSource).toContain('draggable');
  });

  it('shows direct pin and archive quick actions on hover and requires a second click to confirm archive', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '会话 A', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
          { id: 'session-2', title: '会话 B', updatedAt: '2026-04-10T00:10:00Z', createdAt: '2026-04-10T00:10:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_update_session_settings' || command === 'chat_v2_archive_session') {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const pinThreadButton = await screen.findByRole('button', { name: '会话 A' });
    await user.hover(pinThreadButton);

    expect(screen.getByRole('button', { name: '置顶会话' })).toBeInTheDocument();
    const archiveQuickAction = screen.getByRole('button', { name: '归档会话' });
    expect(archiveQuickAction).toBeInTheDocument();
    expect(archiveQuickAction.querySelector('.t-icon-swap')).toHaveAttribute('data-state', 'a');
    expect(screen.queryByRole('button', { name: '归档线程' })).not.toBeInTheDocument();
    expect(screen.queryByText('刚刚')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '置顶会话' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_session_settings', {
        sessionId: 'session-1',
        settings: { metadata: { pinned: true } },
      });
    });

    const archiveThreadButton = await screen.findByRole('button', { name: '会话 B' });
    await user.hover(archiveThreadButton);
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }));

    const confirmArchiveQuickAction = screen.getByRole('button', { name: '确认归档会话' });
    expect(confirmArchiveQuickAction).toBeInTheDocument();
    expect(confirmArchiveQuickAction.querySelector('.t-icon-swap')).toHaveAttribute('data-state', 'b');
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_archive_session', { sessionId: 'session-2' });

    fireEvent.click(screen.getByRole('button', { name: '确认归档会话' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_archive_session', { sessionId: 'session-2' });
    });
    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'success',
      '已归档。查看已归档的会话：',
      undefined,
      {
        action: {
          label: '设置',
          onClick: expect.any(Function),
        },
        borderTone: 'neutral',
      }
    );
  });

  it('uses context-mode app menus for recent session rows so left click does not open the menu', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(sidebarSource).toContain('<AppMenu');
    expect(sidebarSource).toContain('mode="context"');
  });

  it('does not expose direct pin actions on the selected thread row', async () => {
    getCurrentSessionIdMock.mockReturnValue('session-1');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '当前会话', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    await screen.findByRole('button', { name: '当前会话' });
    expect(screen.queryByRole('button', { name: '置顶线程' })).not.toBeInTheDocument();
  });

  it('keeps thread text padding unchanged without left or right quick action buttons', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(sidebarSource).toContain('function SidebarRow(');
    expect(sidebarSource).toContain('function getSidebarRowClassName(');
    expect(sidebarSource).toContain("rowType === 'thread' ? 'desktop-shell-thread-row' : 'desktop-shell-nav-row'");
    expect(sidebarSource).toContain("rowType === 'thread' ? 'desktop-shell-thread-row--active' : 'desktop-shell-nav-row--active'");
    expect(sidebarSource).toContain("'!w-full !justify-start !px-2.5 !py-1.5 text-left'");
    expect(sidebarSource).toContain('<SidebarRow');
    expect(sidebarSource).toContain('rowType="thread"');
    expect(sidebarSource).toContain('rowType="nav"');
    expect(sidebarSource).toContain('flex min-w-0 flex-1 items-center gap-2.5');
    expect(sidebarSource).toContain('w-4 shrink-0');
    expect(sidebarSource).toContain('min-w-0 flex-1');
    expect(sidebarSource).toContain('min-w-[24px] shrink-0');
    expect(sidebarSource).not.toContain('{leftSlot ? (');
    expect(sidebarSource).not.toContain("showPinAction ? '!pl-10 !pr-3' : '!px-2.5'");
    expect(sidebarSource).not.toContain("'absolute left-3 top-1/2 z-10 -translate-x-full -translate-y-1/2 !h-6 !w-6'");
  });

  it('keeps grouped session rows full width instead of shrinking them with an outer indent', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(sidebarSource).toContain("'space-y-0.5 overflow-hidden pl-4'");
    expect(sidebarSource).not.toContain("pl-[26px]");
  });

  it('moves pinned sessions into a dedicated section above recent and unpins from the context menu', async () => {
    const user = userEvent.setup();
    let sessions = [
      { id: 'session-1', title: '会话 A', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
      { id: 'session-2', title: '会话 B', updatedAt: '2026-04-10T00:10:00Z', createdAt: '2026-04-10T00:10:00Z', mode: 'chat' },
    ];

    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve(sessions);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_update_session_settings') {
        sessions = sessions.map((session) =>
          session.id === payload.sessionId
            ? { ...session, metadata: payload.settings.metadata ?? undefined }
            : session
        );
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const sessionAButton = await screen.findByRole('button', { name: '会话 A' });
    await user.hover(sessionAButton);
    fireEvent.contextMenu(sessionAButton);
    fireEvent.click(await screen.findByText('置顶线程'));

    const pinnedNav = await screen.findByRole('navigation', { name: '置顶会话' });
    const pinnedLabel = screen.getByText('置顶');
    const recentLabel = screen.getByText('课题');

    expect(pinnedLabel).toHaveClass('desktop-shell-nav-section-label');
    expect(recentLabel).toHaveClass('desktop-shell-nav-section-label');
    expect(within(pinnedNav).getByRole('button', { name: '会话 A' })).toBeInTheDocument();
    expect(within(pinnedNav).getByTestId('recent-session-pin-icon')).toBeInTheDocument();
    expect(screen.queryByText('已置顶')).not.toBeInTheDocument();

    const pinnedSessionButton = within(pinnedNav).getByRole('button', { name: '会话 A' });
    await user.hover(pinnedSessionButton);
    fireEvent.contextMenu(pinnedSessionButton);
    fireEvent.click(await screen.findByText('取消置顶'));

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: '置顶会话' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText('置顶')).not.toBeInTheDocument();
  });

  it('pins topic groups into the pinned section from the group action menu', async () => {
    let groups = [
      { id: 'group-math', name: '数学', icon: '📘', sortOrder: 0, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
      { id: 'group-physics', name: '物理', icon: '🚀', sortOrder: 1, defaultSkillIds: [], pinnedResourceIds: [], persistStatus: 'active', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-05T00:00:00Z' },
    ];

    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '代数复习', updatedAt: '2026-04-06T08:00:00Z', createdAt: '2026-04-06T08:00:00Z', mode: 'chat', groupId: 'group-math' },
          { id: 'session-2', title: '力学推导', updatedAt: '2026-04-06T09:00:00Z', createdAt: '2026-04-06T09:00:00Z', mode: 'chat', groupId: 'group-physics' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve(groups);
      }
      if (command === 'chat_v2_update_group') {
        groups = groups.map((group) =>
          group.id === payload.groupId
            ? { ...group, ...payload.request, updatedAt: '2026-04-06T10:00:00Z' }
            : group
        );
        return Promise.resolve(groups.find((group) => group.id === payload.groupId));
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    const recentNav = await screen.findByRole('navigation', { name: '课题' });
    const mathGroup = within(recentNav).getByRole('button', { name: '数学' });

    fireEvent.contextMenu(within(mathGroup).getByRole('button', { name: 'Group Actions' }));
    fireEvent.click(await screen.findByText('置顶分组'));

    const updateCall = invokeMock.mock.calls.find(([command]) => command === 'chat_v2_update_group');
    expect(updateCall?.[1]).toMatchObject({
      groupId: 'group-math',
      request: { sortOrder: expect.any(Number) },
    });
    expect(updateCall?.[1].request.sortOrder).toBeLessThan(0);

    const pinnedNav = await screen.findByRole('navigation', { name: '置顶会话' });
    expect(screen.getByText('置顶')).toHaveClass('desktop-shell-nav-section-label');
    const pinnedMathGroup = within(pinnedNav).getByRole('button', { name: '数学' });
    expect(pinnedMathGroup).toBeInTheDocument();
    if (pinnedMathGroup.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(pinnedMathGroup);
    }
    expect(within(pinnedNav).getByRole('button', { name: '代数复习' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '课题' })).queryByRole('button', { name: '数学' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '课题' })).getByRole('button', { name: '物理' })).toBeInTheDocument();

    invokeMock.mockClear();
    fireEvent.contextMenu(within(pinnedMathGroup).getByRole('button', { name: 'Group Actions' }));
    fireEvent.click(await screen.findByText('取消置顶分组'));

    const unpinCall = invokeMock.mock.calls.find(([command]) => command === 'chat_v2_update_group');
    expect(unpinCall?.[1]).toMatchObject({
      groupId: 'group-math',
      request: { sortOrder: expect.any(Number) },
    });
    expect(unpinCall?.[1].request.sortOrder).toBeGreaterThanOrEqual(0);
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: '置顶会话' })).not.toBeInTheDocument();
    });
    expect(within(screen.getByRole('navigation', { name: '课题' })).getByRole('button', { name: '数学' })).toBeInTheDocument();
  });

  it('shows pin rename and archive actions from the recent session context menu', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '右键会话', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_update_session_settings' || command === 'chat_v2_archive_session') {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    fireEvent.contextMenu(await screen.findByRole('button', { name: '右键会话' }));

    expect(screen.getByText('重命名会话')).toBeInTheDocument();
    expect(screen.getByText('置顶线程')).toBeInTheDocument();
    expect(screen.getByText('归档线程')).toBeInTheDocument();

    fireEvent.click(screen.getByText('重命名会话'));
    const renameDialog = await screen.findByRole('dialog');
    expect(within(renameDialog).getByText('重命名对话')).toBeInTheDocument();
    expect(within(renameDialog).getByRole('textbox', { name: '对话名称' })).toHaveValue('右键会话');
    fireEvent.click(within(renameDialog).getByRole('button', { name: '取消' }));

    fireEvent.contextMenu(await screen.findByRole('button', { name: '右键会话' }));
    fireEvent.click(screen.getByText('置顶线程'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_session_settings', {
        sessionId: 'session-1',
        settings: { metadata: { pinned: true } },
      });
    });

    fireEvent.contextMenu(screen.getByRole('button', { name: '右键会话' }));
    fireEvent.click(screen.getByText('归档线程'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_archive_session', { sessionId: 'session-1' });
    });
  });

  it('renames recent sessions from a simple dialog opened by the left sidebar context menu', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', title: '旧标题', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      if (command === 'chat_v2_update_session_settings') {
        return Promise.resolve({
          id: 'session-1',
          title: '新标题',
          updatedAt: '2026-04-10T00:01:00Z',
          createdAt: '2026-04-10T00:00:00Z',
          mode: 'chat',
        });
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    fireEvent.contextMenu(await screen.findByRole('button', { name: '旧标题' }));
    fireEvent.click(screen.getByText('重命名会话'));

    const renameDialog = await screen.findByRole('dialog');
    expect(within(renameDialog).getByText('重命名对话')).toBeInTheDocument();
    expect(within(renameDialog).getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(within(renameDialog).getByRole('button', { name: '确认' })).toBeInTheDocument();

    const input = within(renameDialog).getByRole('textbox', { name: '对话名称' });
    expect(input).toHaveValue('旧标题');

    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.click(within(renameDialog).getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_session_settings', {
        sessionId: 'session-1',
        settings: { title: '新标题' },
      });
    });
    expect(await screen.findByRole('button', { name: '新标题' })).toBeInTheDocument();
  });

  it('shows unnamed recent sessions as a placeholder in the rename dialog', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          { id: 'session-1', updatedAt: '2026-04-10T00:00:00Z', createdAt: '2026-04-10T00:00:00Z', mode: 'chat' },
        ]);
      }
      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    );

    fireEvent.contextMenu(await screen.findByRole('button', { name: '未命名对话' }));
    fireEvent.click(screen.getByText('重命名会话'));

    const renameDialog = await screen.findByRole('dialog');
    const input = within(renameDialog).getByRole('textbox', { name: '对话名称' });
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', '未命名对话');
    expect(within(renameDialog).getByRole('button', { name: '确认' })).toBeDisabled();
  });
});
