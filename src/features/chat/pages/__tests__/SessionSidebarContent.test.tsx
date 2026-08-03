import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { useSessionSidebarContent } from '../SessionSidebarContent';
import type { ChatSession } from '../../types/session';
import type { SessionGroup } from '../../types/group';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/ChatErrorBoundary', () => ({
  ChatErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function SidebarHarness({
  unifiedMobileDrawer = false,
  fixedHeader = false,
}: {
  unifiedMobileDrawer?: boolean;
  fixedHeader?: boolean;
}) {
  const groups: SessionGroup[] = [
    {
      id: 'group-1',
      name: '四级备考待办',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      defaultRuntimeRootId: undefined,
      preferredProjectRootPath: undefined,
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-05-23T08:00:00Z',
      updatedAt: '2026-05-23T08:00:00Z',
    },
  ];

  const groupedSession = {
    id: 'sess-grouped',
    title: '四级备考待办',
    mode: 'chat',
    groupId: 'group-1',
    createdAt: '2026-05-23T08:00:00Z',
    updatedAt: '2026-05-23T08:00:00Z',
  } as ChatSession;

  const ungroupedSession = {
    id: 'sess-ungrouped',
    title: '社会工作简介',
    mode: 'chat',
    groupId: null,
    createdAt: '2026-05-23T09:00:00Z',
    updatedAt: '2026-05-23T09:00:00Z',
  } as ChatSession;

  const { renderSessionSidebarContent, renderSessionSidebarHeader } = useSessionSidebarContent({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    viewMode: 'sidebar',
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    editableGroupIds: new Set(groups.map((group) => group.id)),
    onCreateGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onEditGroup: vi.fn(),
    onArchiveGroup: vi.fn(),
    isInitialLoading: false,
    sessions: [groupedSession, ungroupedSession],
    visibleGroups: groups,
    sessionsByGroup: new Map([[groups[0].id, [groupedSession]]]),
    ungroupedSessions: [ungroupedSession],
    currentSessionId: groupedSession.id,
    hasMoreSessions: false,
    isLoadingMore: false,
    t: ((key: string, fallback?: string) => {
      if (key === 'page.newChat') return '新对话';
      if (key === 'browser.allSessions') return '所有对话';
      if (key === 'sidebar:mobile_drawer.section_chat') return '会话';
      if (key === 'page.studySessions') return '课题';
      if (key === 'page.recentSessions') return '最近';
      if (key === 'page.ungrouped') return '未分组';
      if (key === 'page.studySessionsEmpty') return '暂无课题';
      if (key === 'page.searchPlaceholder') return '搜索会话...';
      return typeof fallback === 'string' ? fallback : '';
    }) as any,
    resetDeleteConfirmation: vi.fn(),
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: (session: ChatSession) => <div key={session.id}>{session.title}</div>,
  });

  return (
    <>
      {fixedHeader ? renderSessionSidebarHeader() : null}
      {renderSessionSidebarContent({
        unifiedMobileDrawer,
        mobileDrawerHeader: fixedHeader ? 'fixed' : 'inline',
      })}
    </>
  );
}

function EmptyTopicsSidebarHarness() {
  const ungroupedSession = {
    id: 'sess-ungrouped',
    title: '社会工作简介',
    mode: 'chat',
    groupId: null,
    createdAt: '2026-05-23T09:00:00Z',
    updatedAt: '2026-05-23T09:00:00Z',
  } as ChatSession;

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
    sessions: [ungroupedSession],
    visibleGroups: [],
    sessionsByGroup: new Map(),
    ungroupedSessions: [ungroupedSession],
    currentSessionId: ungroupedSession.id,
    hasMoreSessions: false,
    isLoadingMore: false,
    t: ((key: string, fallback?: string) => {
      if (key === 'page.studySessions') return '课题';
      if (key === 'page.recentSessions') return '最近';
      if (key === 'page.ungrouped') return '未分组';
      if (key === 'page.studySessionsEmpty') return '暂无课题';
      if (key === 'page.searchPlaceholder') return '搜索会话...';
      return typeof fallback === 'string' ? fallback : '';
    }) as any,
    resetDeleteConfirmation: vi.fn(),
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: (session: ChatSession) => <div key={session.id}>{session.title}</div>,
  });

  return <>{renderSessionSidebarContent()}</>;
}

describe('useSessionSidebarContent', () => {
  it('keeps the unified mobile drawer header and new-chat action outside the scroll region', () => {
    const { container } = render(<SidebarHarness unifiedMobileDrawer fixedHeader />);
    const fixedRegion = container.querySelector('[data-mobile-sidebar-fixed-region="top"]');

    expect(fixedRegion).toBeInTheDocument();
    expect(fixedRegion).not.toHaveClass('sticky');
    expect(fixedRegion).toContainElement(screen.getByText('DeepStudent'));
    const newChatButton = screen.getByRole('button', { name: '新对话' });
    expect(fixedRegion).toContainElement(newChatButton);
  });

  it('keeps primary chat actions visible in the unified mobile drawer without the legacy section', () => {
    const { rerender } = render(<SidebarHarness />);

    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '所有对话' })).toBeInTheDocument();

    rerender(<SidebarHarness unifiedMobileDrawer fixedHeader />);

    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '所有对话' })).toBeInTheDocument();
    expect(screen.queryByText('会话')).not.toBeInTheDocument();
  });

  it('separates topic groups, flat recents, and the ungrouped folder on mobile', () => {
    render(<SidebarHarness />);

    expect(screen.getByText('课题')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分组')).toBeInTheDocument();
    expect(screen.getAllByText('四级备考待办').length).toBeGreaterThan(0);
    // 「最近」为跨分组扁平列表，未分组会话会同时出现在最近与「未分组」折叠区
    expect(screen.getAllByText('社会工作简介').length).toBeGreaterThan(0);
  });

  it('renders an inline search box wired to the sidebar filter chain', () => {
    render(<SidebarHarness />);

    expect(screen.getByRole('searchbox', { name: '搜索会话...' })).toBeInTheDocument();
  });

  it('keeps folder expansion separate from folder actions', () => {
    render(<SidebarHarness unifiedMobileDrawer />);

    const folderToggle = screen.getByRole('button', { name: '四级备考待办' });
    expect(folderToggle.tagName).toBe('BUTTON');
    expect(within(folderToggle).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the topics section visible even when there are no topic groups yet', () => {
    render(<EmptyTopicsSidebarHarness />);

    expect(screen.getByText('课题')).toBeInTheDocument();
    expect(screen.getByText('暂无课题')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分组')).toBeInTheDocument();
  });
});
