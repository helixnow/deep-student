import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useSessionSidebarContent } from '../SessionSidebarContent';
import type { ChatSession } from '../../types/session';
import type { SessionGroup } from '../../types/group';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/ChatErrorBoundary', () => ({
  ChatErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function SidebarHarness() {
  const groups: SessionGroup[] = [
    {
      id: 'group-1',
      name: '四级备考待办',
      defaultSkillIds: [],
      pinnedResourceIds: [],
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

  const { renderSessionSidebarContent } = useSessionSidebarContent({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    setShowChatControl: vi.fn(),
    setPendingDeleteSessionId: vi.fn(),
    showChatControl: false,
    isInitialLoading: false,
    sessions: [groupedSession, ungroupedSession],
    visibleGroups: groups,
    sessionsByGroup: new Map([[groups[0].id, [groupedSession]]]),
    ungroupedSessions: [ungroupedSession],
    currentSessionId: groupedSession.id,
    totalSessionCount: 2,
    hasMoreSessions: false,
    isLoadingMore: false,
    pendingDeleteSessionId: null,
    t: ((_: string, fallback?: string) => fallback ?? '') as any,
    resetDeleteConfirmation: vi.fn(),
    clearDeleteConfirmTimeout: vi.fn(),
    deleteConfirmTimeoutRef: { current: null },
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: (session: ChatSession) => <div key={session.id}>{session.title}</div>,
  });

  return <>{renderSessionSidebarContent()}</>;
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
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    setShowChatControl: vi.fn(),
    setPendingDeleteSessionId: vi.fn(),
    showChatControl: false,
    isInitialLoading: false,
    sessions: [ungroupedSession],
    visibleGroups: [],
    sessionsByGroup: new Map(),
    ungroupedSessions: [ungroupedSession],
    currentSessionId: ungroupedSession.id,
    totalSessionCount: 1,
    hasMoreSessions: false,
    isLoadingMore: false,
    pendingDeleteSessionId: null,
    t: ((_: string, fallback?: string) => fallback ?? '') as any,
    resetDeleteConfirmation: vi.fn(),
    clearDeleteConfirmTimeout: vi.fn(),
    deleteConfirmTimeoutRef: { current: null },
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: (session: ChatSession) => <div key={session.id}>{session.title}</div>,
  });

  return <>{renderSessionSidebarContent()}</>;
}

describe('useSessionSidebarContent', () => {
  it('separates topic groups from recent ungrouped sessions on mobile', () => {
    render(<SidebarHarness />);

    expect(screen.getByText('课题')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分类')).toBeInTheDocument();
    expect(screen.getAllByText('四级备考待办').length).toBeGreaterThan(0);
    expect(screen.getByText('社会工作简介')).toBeInTheDocument();
  });

  it('keeps the topics section visible even when there are no topic groups yet', () => {
    render(<EmptyTopicsSidebarHarness />);

    expect(screen.getByText('课题')).toBeInTheDocument();
    expect(screen.getByText('暂无课题')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('未分类')).toBeInTheDocument();
  });
});
