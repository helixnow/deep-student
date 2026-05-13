import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  UnifiedSidebar,
  UnifiedSidebarContent,
  UnifiedSidebarHeader,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar/UnifiedSidebar';
import { UnifiedSidebarSection } from '@/components/ui/unified-sidebar/UnifiedSidebarSection';
import { useSessionItemRenderer } from '../SessionItemRenderer';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({
    isSmallScreen: false,
    isMobile: false,
  }),
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children, className, viewportClassName }: { children?: React.ReactNode; className?: string; viewportClassName?: string }) => (
    <div data-testid="scroll-area" className={className} data-viewport-class={viewportClassName}>
      {children}
    </div>
  ),
}));

vi.mock('@/components/layout/MacTopSafeDragZone', () => ({
  MacTopSafeDragZone: () => null,
}));

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

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));

function SessionItemHarness({ currentSessionId }: { currentSessionId: string | null }) {
  const { renderSessionItem } = useSessionItemRenderer({
    editingSessionId: null,
    hoveredSessionId: null,
    currentSessionId,
    pendingDeleteSessionId: null,
    pendingArchiveSessionId: null,
    editingTitle: '',
    renamingSessionId: null,
    renameError: null,
    groups: [],
    sessions: [
      { id: 'selected', title: 'Selected session' } as any,
      { id: 'regular', title: 'Regular session' } as any,
    ],
    totalSessionCount: 2,
    t: ((key: string) => key) as any,
    resetDeleteConfirmation: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setHoveredSessionId: vi.fn(),
    setEditingTitle: vi.fn(),
    setPendingDeleteSessionId: vi.fn(),
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

  return (
    <div>
      {renderSessionItem({ id: 'selected', title: 'Selected session' } as any)}
      {renderSessionItem({ id: 'regular', title: 'Regular session' } as any)}
    </div>
  );
}

describe('session sidebar typography alignment', () => {
  it('uses a study-ui-like font scope and lighter unified sidebar text weights', () => {
    const { container } = render(
      <UnifiedSidebar showMacSafeZone={false}>
        <UnifiedSidebarHeader title="Sessions" showSearch={false} />
        <UnifiedSidebarContent>
          <UnifiedSidebarSection id="recent" title="Recent">
            <UnifiedSidebarItem id="regular" title="Regular item" />
            <UnifiedSidebarItem id="selected" title="Selected item" isSelected />
          </UnifiedSidebarSection>
        </UnifiedSidebarContent>
      </UnifiedSidebar>
    );

    expect(container.firstElementChild).toHaveClass('font-sidebar-study-ui');
    expect(container.firstElementChild).toHaveClass('bg-[var(--sidebar-study-surface)]');

    const sectionTitle = screen.getByText('Recent');
    expect(sectionTitle).toHaveClass('font-normal');
    expect(sectionTitle).not.toHaveClass('uppercase');
    expect(sectionTitle).not.toHaveClass('tracking-wider');

    const regularItem = screen.getByText('Regular item');
    const regularItemRow = regularItem.closest('[role="button"]');
    expect(regularItemRow).toHaveClass('rounded-2xl');
    expect(regularItemRow).toHaveClass('hover:bg-[var(--sidebar-study-hover)]');
    expect(regularItem).toHaveClass('font-normal');
    expect(regularItem).toHaveClass('hover:font-normal');
    expect(regularItem).toHaveClass('text-[13px]');
    expect(regularItem).not.toHaveClass('font-semibold');

    const selectedItem = screen.getByText('Selected item');
    const selectedItemRow = selectedItem.closest('[role="button"]');
    expect(selectedItemRow).toHaveClass('rounded-2xl');
    expect(selectedItemRow).toHaveClass('bg-[var(--sidebar-study-selected)]');
    expect(selectedItemRow).toHaveClass('text-foreground');
    expect(selectedItemRow).not.toHaveClass('ring-1');
    expect(selectedItem).toHaveClass('font-normal');
    expect(selectedItem).toHaveClass('hover:font-normal');
    expect(selectedItem).toHaveClass('text-[13px]');
    expect(selectedItem).not.toHaveClass('font-medium');
  });

  it('renders chat session titles with lighter study-ui-style emphasis', () => {
    render(<SessionItemHarness currentSessionId="selected" />);

    const selectedItem = screen.getByText('Selected session');
    const selectedItemRow = selectedItem.closest('.group');
    expect(selectedItemRow).toHaveClass('rounded-2xl');
    expect(selectedItemRow).toHaveClass('bg-[var(--sidebar-study-selected)]');
    expect(selectedItemRow).toHaveClass('hover:bg-[var(--sidebar-study-selected)]');
    expect(selectedItemRow).toHaveClass('text-foreground');
    expect(selectedItemRow).not.toHaveClass('bg-accent');
    expect(selectedItem).toHaveClass('font-normal');
    expect(selectedItem).toHaveClass('hover:font-normal');
    expect(selectedItem).toHaveClass('text-[13px]');
    expect(selectedItem).not.toHaveClass('font-medium');
    expect(screen.queryByLabelText('page.pinSession')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('page.archiveSession')).not.toBeInTheDocument();

    const regularItem = screen.getByText('Regular session');
    const regularItemRow = regularItem.closest('.group');
    expect(regularItemRow).toHaveClass('rounded-2xl');
    expect(regularItemRow).toHaveClass('text-foreground/80');
    expect(regularItemRow).toHaveClass('hover:text-foreground');
    expect(regularItemRow).toHaveClass('hover:bg-[var(--sidebar-study-hover)]');
    expect(regularItem).toHaveClass('font-normal');
    expect(regularItem).toHaveClass('hover:font-normal');
    expect(regularItem).toHaveClass('text-[13px]');
    expect(regularItem).not.toHaveClass('font-semibold');
  });
});
