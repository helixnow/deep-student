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
  it('keeps the unified mobile drawer brand outside the scroll region', () => {
    const { container } = render(<SidebarHarness unifiedMobileDrawer fixedHeader />);
    const fixedRegion = container.querySelector('[data-mobile-sidebar-fixed-region="top"]');

    expect(fixedRegion).toBeInTheDocument();
    expect(fixedRegion).toHaveTextContent('DeepStudent');
    expect(screen.queryByRole('button', { name: '新对话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();
  });

  it('keeps primary chat actions visible in the unified mobile drawer without the legacy section', () => {
    const { rerender } = render(<SidebarHarness />);

    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '所有对话' })).toBeInTheDocument();

    rerender(<SidebarHarness unifiedMobileDrawer fixedHeader />);

    // 移动端统一抽屉：新对话改到首页右上角，设置由滑动壳顶栏齿轮承担
    expect(screen.queryByRole('button', { name: '新对话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();
    // 移动端统一抽屉不再提供「所有对话」入口（会话浏览由搜索与命令 / 会话搜索承担）
    expect(screen.queryByRole('button', { name: '所有对话' })).not.toBeInTheDocument();
    expect(screen.queryByText('会话')).not.toBeInTheDocument();
  });

  it('nests the ungrouped folder under topics and keeps desktop recents separate', () => {
    render(<SidebarHarness />);

    expect(screen.getByText('课题')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分组')).toBeInTheDocument();
    expect(screen.getAllByText('四级备考待办').length).toBeGreaterThan(0);
    expect(screen.getAllByText('社会工作简介').length).toBeGreaterThan(0);
    const studySection = screen.getByText('课题').closest('section');
    expect(studySection).toHaveTextContent('未分组');
    expect(studySection).toHaveTextContent('社会工作简介');
  });

  it('does not show calendar recents in the unified mobile drawer', () => {
    render(<SidebarHarness unifiedMobileDrawer />);

    expect(screen.queryByText('最近')).not.toBeInTheDocument();
    expect(screen.queryByText('更早')).not.toBeInTheDocument();
    expect(screen.queryByText('今天')).not.toBeInTheDocument();
    const studySection = screen.getByText('课题').closest('section');
    expect(studySection).toHaveTextContent('未分组');
    expect(studySection).toHaveTextContent('社会工作简介');
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
    expect(screen.queryByText('暂无课题')).not.toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分组')).toBeInTheDocument();
    const studySection = screen.getByText('课题').closest('section');
    expect(studySection).toHaveTextContent('社会工作简介');
  });
});
