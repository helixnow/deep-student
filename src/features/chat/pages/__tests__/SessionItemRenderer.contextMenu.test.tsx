import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionItemRenderer } from '../SessionItemRenderer';

vi.mock('@/components/ui/NotionButton', () => ({
  NotionButton: ({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/ui/shad/Popover', () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/app-menu/AppMenu', () => {
  const React = require('react');

  const AppMenuContext = React.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  } | null>(null);

  return {
    AppMenu: ({ children, open = false }: { children?: React.ReactNode; open?: boolean }) => {
      const [internalOpen, setInternalOpen] = React.useState(open);
      return (
        <AppMenuContext.Provider value={{ open: internalOpen, setOpen: setInternalOpen }}>
          {children}
        </AppMenuContext.Provider>
      );
    },
    AppMenuTrigger: ({ children }: { children?: React.ReactElement }) => {
      const ctx = React.useContext(AppMenuContext);
      if (!React.isValidElement(children) || !ctx) return <>{children}</>;
      return React.cloneElement(children, {
        onContextMenu: (event: React.MouseEvent) => {
          children.props.onContextMenu?.(event);
          ctx.setOpen(true);
        },
      });
    },
    AppMenuContent: ({ children }: { children?: React.ReactNode }) => {
      const ctx = React.useContext(AppMenuContext);
      if (!ctx?.open) return null;
      return <div data-testid="session-context-menu">{children}</div>;
    },
    AppMenuGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    AppMenuSeparator: () => <div data-testid="session-context-menu-separator" />,
    AppMenuItem: ({
      children,
      icon,
      onClick,
    }: {
      children?: React.ReactNode;
      icon?: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick}>
        {icon}
        <span>{children}</span>
      </button>
    ),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('react-pdf', () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Page: () => <div />,
  Thumbnail: () => <div />,
  pdfjs: {
    GlobalWorkerOptions: {},
  },
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: console,
}));

vi.mock('../components/groups/GroupEditorDialog', () => ({
  PRESET_ICONS: [],
}));

function Harness({
  togglePinSession,
  startEditSession,
  archiveSession = vi.fn(),
  pendingArchiveSessionId = null,
  pinned = false,
  hoveredSessionId = 'session-1',
  currentSessionId = null,
}: {
  togglePinSession: (sessionId: string, pinned: boolean) => Promise<void>;
  startEditSession: (session: any, e: React.MouseEvent) => void;
  archiveSession?: (sessionId: string) => Promise<void>;
  pendingArchiveSessionId?: string | null;
  pinned?: boolean;
  hoveredSessionId?: string | null;
  currentSessionId?: string | null;
}) {
  const { renderSessionItem } = useSessionItemRenderer({
    editingSessionId: null,
    hoveredSessionId,
    currentSessionId,
    pendingDeleteSessionId: null,
    pendingArchiveSessionId,
    editingTitle: '',
    renamingSessionId: null,
    renameError: null,
    groups: [],
    sessions: [
      {
        id: 'session-1',
        title: 'Session 1',
        metadata: pinned ? { pinned: true } : undefined,
      } as any,
    ],
    totalSessionCount: 2,
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
    startEditSession,
    saveSessionTitle: vi.fn(),
    cancelEditSession: vi.fn(),
    moveSessionToGroup: vi.fn(),
    deleteSession: vi.fn(),
    archiveSession,
    togglePinSession,
    formatTime: () => '2h',
  });

  return <div>{renderSessionItem({
    id: 'session-1',
    title: 'Session 1',
    updatedAt: '2026-04-10T00:00:00.000Z',
    metadata: pinned ? { pinned: true } : undefined,
  } as any)}</div>;
}

describe('SessionItemRenderer context menu', () => {
  it('shows rename, pin, and archive actions on session right click', () => {
    render(<Harness togglePinSession={vi.fn()} startEditSession={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText('Session 1').closest('.group')!);

    expect(screen.getByText('page.renameSession')).toBeInTheDocument();
    expect(screen.getByText('page.pinSession')).toBeInTheDocument();
    expect(screen.getByText('page.archiveSession')).toBeInTheDocument();
  });

  it('wires rename and pin actions from the context menu', () => {
    const startEditSession = vi.fn();
    const togglePinSession = vi.fn().mockResolvedValue(undefined);

    render(<Harness togglePinSession={togglePinSession} startEditSession={startEditSession} />);

    fireEvent.contextMenu(screen.getByText('Session 1').closest('.group')!);
    fireEvent.click(screen.getByText('page.renameSession'));
    fireEvent.click(screen.getByText('page.pinSession'));

    expect(startEditSession).toHaveBeenCalledTimes(1);
    expect(togglePinSession).toHaveBeenCalledWith('session-1', true, undefined);
  });

  it('shows unpin for pinned sessions', () => {
    render(<Harness togglePinSession={vi.fn()} startEditSession={vi.fn()} pinned />);

    fireEvent.contextMenu(screen.getByText('Session 1').closest('.group')!);

    expect(screen.getByText('page.unpinSession')).toBeInTheDocument();
  });

  it('does not show direct left-click pin actions for pinned sessions when idle', () => {
    render(
      <Harness
        togglePinSession={vi.fn()}
        startEditSession={vi.fn()}
        pinned
        hoveredSessionId={null}
      />
    );

    expect(screen.queryByLabelText('page.unpinSession')).not.toBeInTheDocument();
  });

  it('does not show direct left-click pin or archive actions while hovered', () => {
    render(<Harness togglePinSession={vi.fn()} startEditSession={vi.fn()} />);

    expect(screen.queryByLabelText('page.pinSession')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('page.archiveSession')).not.toBeInTheDocument();
  });

  it('archives from the context menu', () => {
    const archiveSession = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        togglePinSession={vi.fn()}
        startEditSession={vi.fn()}
        archiveSession={archiveSession}
        pendingArchiveSessionId="session-1"
      />
    );

    fireEvent.contextMenu(screen.getByText('Session 1').closest('.group')!);
    fireEvent.click(screen.getByText('page.archiveSession'));

    expect(archiveSession).toHaveBeenCalledWith('session-1');
  });
});
