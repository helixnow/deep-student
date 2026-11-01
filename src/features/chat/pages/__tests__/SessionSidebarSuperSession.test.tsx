import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionSidebarContent } from '../SessionSidebarContent';
import { useSessionItemRenderer, type SessionItemRenderOptions } from '../SessionItemRenderer';
import type { ChatSession } from '../../types/session';

const { superEntryMock } = vi.hoisted(() => ({ superEntryMock: vi.fn() }));

const SUPER_SESSION = {
  id: 'sess_super',
  title: 'Super-agent',
  mode: 'chat',
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt: '2026-10-01T08:00:00Z',
  metadata: { pinned: true, super_agent: { active: true, version: 1, workspace_id: 'ws_1', hidden: false } },
} as ChatSession;

vi.mock('../../superSession/useSuperSessionEntry', () => ({ useSuperSessionEntry: superEntryMock }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../components/ChatErrorBoundary', () => ({
  ChatErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/DsButton', () => ({
  DsButton: ({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button className={className} {...props}>{children}</button>
  ),
}));
vi.mock('@/components/ui/app-menu/AppMenu', () => {
  const React = require('react');
  const Ctx = React.createContext(null);
  return {
    AppMenu: ({ children }: any) => {
      const [open, setOpen] = React.useState(false);
      return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
    },
    AppMenuTrigger: ({ children }: any) => {
      const ctx: any = React.useContext(Ctx);
      return React.cloneElement(children, {
        onContextMenu: (event: any) => {
          children.props.onContextMenu?.(event);
          ctx.setOpen(true);
        },
      });
    },
    AppMenuContent: ({ children }: any) => {
      const ctx: any = React.useContext(Ctx);
      return ctx?.open ? <div data-testid="session-context-menu">{children}</div> : null;
    },
    AppMenuGroup: ({ children }: any) => <div>{children}</div>,
    AppMenuSeparator: () => <div />,
    AppMenuSub: ({ children }: any) => <div>{children}</div>,
    AppMenuSubTrigger: ({ children }: any) => <div>{children}</div>,
    AppMenuSubContent: ({ children }: any) => <div>{children}</div>,
    AppMenuItem: ({ children, onClick }: any) => (
      <button type="button" role="menuitem" onClick={onClick}>{children}</button>
    ),
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: console }));
vi.mock('@/features/chat/core/session/sessionPrefetch', () => ({
  beginSessionHoverPrefetch: vi.fn(),
  cancelSessionHoverPrefetch: vi.fn(),
}));
vi.mock('@/features/chat/hooks/useSessionSidebarIndicators', () => {
  const state = { streamingSessionIds: ['sess_super'], blockingSessionIds: [], unreadSessionIds: [] };
  return {
    useSessionSidebarIndicators: (selector: (value: typeof state) => unknown) => selector(state),
    markSessionSidebarIndicatorSeen: vi.fn(),
  };
});
vi.mock('../components/groups/GroupEditorDialog', () => ({ PRESET_ICONS: [] }));

const t = ((key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key)) as any;

function ListHarness({ renderSessionItem }: { renderSessionItem: (s: ChatSession, d?: unknown, o?: SessionItemRenderOptions) => React.ReactNode }) {
  const pinnedNormal = {
    id: 'sess_pinned', title: '置顶的普通会话', mode: 'chat',
    createdAt: '2026-10-05T08:00:00Z', updatedAt: '2026-10-05T08:00:00Z', metadata: { pinned: true },
  } as ChatSession;
  const loose = {
    id: 'sess_loose', title: '普通会话', mode: 'chat',
    createdAt: '2026-10-06T08:00:00Z', updatedAt: '2026-10-06T08:00:00Z',
  } as ChatSession;
  const sessions = [SUPER_SESSION, pinnedNormal, loose];
  const { renderSessionSidebarContent } = useSessionSidebarContent({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    viewMode: 'sidebar',
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    editableGroupIds: new Set<string>(),
    onCreateGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onEditGroup: vi.fn(),
    onArchiveGroup: vi.fn(),
    isInitialLoading: false,
    sessions,
    visibleGroups: [],
    sessionsByGroup: new Map(),
    ungroupedSessions: sessions,
    currentSessionId: null,
    hasMoreSessions: false,
    isLoadingMore: false,
    t,
    resetDeleteConfirmation: vi.fn(),
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: renderSessionItem as any,
  });
  return <>{renderSessionSidebarContent({ unifiedMobileDrawer: true, mobileDrawerHeader: 'inline' })}</>;
}

function RowHarness({ pendingDeleteSessionId = null }: { pendingDeleteSessionId?: string | null }) {
  const { renderSessionItem } = useSessionItemRenderer({
    editingSessionId: null,
    hoveredSessionId: null,
    currentSessionId: null,
    pendingDeleteSessionId,
    pendingArchiveSessionId: null,
    editingTitle: '',
    renamingSessionId: null,
    renameError: null,
    groups: [{ id: 'g1', name: '分组', persistStatus: 'active' } as any],
    sessions: [SUPER_SESSION],
    totalSessionCount: 1,
    t: ((key: string) => key) as any,
    resetDeleteConfirmation: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setHoveredSessionId: vi.fn(),
    setEditingTitle: vi.fn(),
    setPendingDeleteSessionId: vi.fn(),
    setPendingArchiveSessionId: vi.fn(),
    setSessions: vi.fn(),
    setViewMode: vi.fn(),
    clearDeleteConfirmTimeout: vi.fn(),
    deleteConfirmTimeoutRef: { current: null },
    startEditSession: vi.fn(),
    saveSessionTitle: vi.fn(),
    cancelEditSession: vi.fn(),
    moveSessionToGroup: vi.fn(),
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
    togglePinSession: vi.fn(),
    formatTime: () => '2h',
  });
  return <div>{renderSessionItem(SUPER_SESSION, undefined, { variant: 'super' })}</div>;
}

describe('mobile session list: Super-agent row', () => {
  it('renders the Super-agent row first in the pinned section, exactly once', () => {
    superEntryMock.mockReturnValue({ enabled: true, sessionId: 'sess_super', session: SUPER_SESSION, refresh: vi.fn() });
    const calls: Array<{ id: string; variant?: string }> = [];
    render(
      <ListHarness
        renderSessionItem={(session, _drag, options) => {
          calls.push({ id: session.id, variant: options?.variant });
          return <div data-testid="row">{session.title}{options?.variant ? `#${options.variant}` : ''}</div>;
        }}
      />,
    );
    const rows = screen.getAllByTestId('row').map((el) => el.textContent);
    expect(rows.filter((text) => text?.startsWith('Super-agent'))).toEqual(['Super-agent#super']);
    expect(rows[0]).toBe('Super-agent#super');
    expect(rows).toContain('置顶的普通会话');
    expect(calls.filter((c) => c.id === 'sess_super').every((c) => c.variant === 'super')).toBe(true);
  });

  it('omits the row when Super-agent is disabled', () => {
    superEntryMock.mockReturnValue({ enabled: false, sessionId: null, session: null, refresh: vi.fn() });
    render(<ListHarness renderSessionItem={(session) => <div data-testid="row">{session.title}</div>} />);
    const rows = screen.getAllByTestId('row').map((el) => el.textContent);
    expect(rows).not.toContain('Super-agent');
  });

  it('hides pin / archive / move-to-group but keeps rename and delete; shows the shared streaming indicator', () => {
    render(<RowHarness />);
    const row = screen.getByText('Super-agent').closest('[data-session-variant="super"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByTestId('mobile-sidebar-super-session-badge')).toBeInTheDocument();
    expect(within(row).getByTestId('mobile-sidebar-streaming-indicator')).toBeInTheDocument();

    fireEvent.contextMenu(row);
    const items = within(screen.getByTestId('session-context-menu')).getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toContain('page.renameSession');
    expect(items).toContain('page.deleteSession');
    expect(items).not.toContain('page.pinSession');
    expect(items).not.toContain('page.unpinSession');
    expect(items).not.toContain('page.archiveSession');
    expect(screen.queryByText('page.moveToGroup')).toBeNull();
  });

  it('uses the Super-agent delete confirmation copy', () => {
    render(<RowHarness pendingDeleteSessionId="sess_super" />);
    expect(screen.getByRole('alertdialog', { name: 'superAgent:sidebar.deleteConfirm' })).toBeInTheDocument();
    expect(screen.queryByText('page.deleteSessionConfirm')).toBeNull();
  });
});
