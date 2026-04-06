import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModernSidebar } from '@/components/ModernSidebar';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const { getCurrentSessionIdMock } = vi.hoisted(() => ({
  getCurrentSessionIdMock: vi.fn(),
}));

const { getSessionStoreMock } = vi.hoisted(() => ({
  getSessionStoreMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/chat-v2/core/session/sessionManager', () => ({
  sessionManager: {
    getCurrentSessionId: getCurrentSessionIdMock,
    get: getSessionStoreMock,
  },
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: () => undefined,
}));

describe('ModernSidebar shell navigation', () => {
  beforeEach(() => {
    getCurrentSessionIdMock.mockReturnValue(null);
    getSessionStoreMock.mockReturnValue(undefined);
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

    expect(await screen.findByRole('button', { name: '智能会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '学习资源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '待办' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '技能管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
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
    expect(chatNavButton).toHaveAttribute('aria-label', '智能会话');
    expect(screen.getByRole('button', { name: '智能会话' })).toBeInTheDocument();
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
    expect(chatNavButton).toHaveAttribute('aria-label', '智能会话');
    expect(screen.getByRole('button', { name: '最近列表标题' })).toBeInTheDocument();
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

    expect(await screen.findByRole('button', { name: '智能会话' })).toBeInTheDocument();
  });

  it('renders recent sessions in collapsible groups when session groups exist', async () => {
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
    expect(screen.getByRole('button', { name: /^未分组$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '代数复习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '几何证明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '未分组会话' })).toBeInTheDocument();
  });

  it('collapses grouped recent sessions when the group header is toggled', async () => {
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

    const groupButton = await screen.findByRole('button', { name: /数学/ });
    expect(screen.getByRole('button', { name: '代数复习' })).toBeInTheDocument();

    await user.click(groupButton);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '代数复习' })).not.toBeInTheDocument();
    });
  });
});
