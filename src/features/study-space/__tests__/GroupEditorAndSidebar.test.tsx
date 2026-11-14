import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupEditorPanel } from '@/features/chat/components/groups/GroupEditorDialog';
import { useSessionSidebarContent } from '@/features/chat/pages/SessionSidebarContent';
import type { SessionGroup, UpdateGroupRequest } from '@/features/chat/types/group';
import type { ChatSession } from '@/features/chat/types/session';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import { SpaceMountPickerDialog } from '../components/SpaceMountPickerDialog';
import { LearningHubContextMenu } from '@/features/learning-hub/components/LearningHubContextMenu';
import {
  STUDY_SPACE_DEFAULTS,
  STUDY_SPACE_IPC_COMMANDS,
  type StudySpaceMount,
  type StudySpaceProfile,
} from '../types';
import { useStudySpaceStore } from '../store/studySpaceStore';

const { invokeMock, listAnkiCardsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listAnkiCardsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/chat/components/ChatErrorBoundary', () => ({
  ChatErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/chat/superSession/useSuperSessionEntry', () => ({
  useSuperSessionEntry: () => ({
    enabled: false,
    sessionId: null,
    session: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/features/learning-hub', () => ({
  LearningHubSidebar: () => <div data-testid="mock-learning-hub-sidebar" />,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    list: vi.fn(async () => ({ ok: true, value: [] })),
    get: vi.fn(async () => ({ ok: false })),
  },
  folderApi: {
    getFolder: vi.fn(async (id: string) => ({
      ok: true,
      value: { id, title: 'Folder' },
    })),
  },
}));

vi.mock('@/utils/chatApi', () => ({
  listAnkiLibraryCards: listAnkiCardsMock,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (ns?: string | string[]) => ({
      t: (key: string, params?: Record<string, unknown>) => {
        const primaryNs = Array.isArray(ns) ? ns[0] : ns;
        const explicitNsMatch = /^([a-zA-Z0-9_]+):(.*)$/.exec(key);
        const effectiveNs = explicitNsMatch ? explicitNsMatch[1] : (primaryNs ?? 'chatV2');
        const normalized = explicitNsMatch ? explicitNsMatch[2] : key;
        if (effectiveNs === 'common') {
          if (normalized === 'save') return '保存';
          if (normalized === 'create') return '创建';
          if (normalized === 'cancel') return '取消';
        }
        const dict: Record<string, unknown> =
          effectiveNs === 'learningHub'
            ? (zhLearningHub as Record<string, unknown>)
            : (zhChatV2 as Record<string, unknown>);
        const segments = normalized.split('.');
        let cursor: unknown = dict;
        for (const seg of segments) {
          if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
            cursor = (cursor as Record<string, unknown>)[seg];
          } else {
            cursor = undefined;
            break;
          }
        }
        if (typeof cursor === 'string') {
          return cursor.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
            params && k in params ? String(params[k]) : `{{${k}}}`,
          );
        }
        return normalized;
      },
      i18n: { language: 'zh-CN' },
    }),
  };
});

function lookupZhChatV2(key: string, params?: Record<string, unknown>): string {
  const normalized = key.replace(/^chatV2:/, '');
  const segments = normalized.split('.');
  let cursor: unknown = zhChatV2;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      cursor = undefined;
      break;
    }
  }
  if (typeof cursor === 'string') {
    return cursor.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
      params && k in params ? String(params[k]) : `{{${k}}}`,
    );
  }
  return normalized;
}

function formatDaysFromTodayIso(daysAhead: number): string {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function StudySpaceSidebarTestHarness({ examDate, sessionLoaded = true }: { examDate: string; sessionLoaded?: boolean }) {
  const group: SessionGroup = {
    id: 'grp_cet6',
    name: '大学英语六级冲刺',
    color: '#10b981',
    rootFolderId: 'fld_cet6_root',
    defaultSkillIds: [],
    pinnedResourceIds: ['fld_cet6_root'],
    sortOrder: 0,
    persistStatus: 'active',
    createdAt: '2026-11-01T08:00:00Z',
    updatedAt: '2026-11-01T08:00:00Z',
  };

  const spaceSession: ChatSession = {
    id: 'sess_cet6_1',
    title: '听力真题精析',
    mode: 'chat',
    groupId: 'grp_cet6',
    createdAt: '2026-11-10T08:00:00Z',
    updatedAt: '2026-11-10T08:00:00Z',
  } as ChatSession;

  const inboxSessionA: ChatSession = {
    id: 'sess_inbox_1',
    title: '临时物理公式推导',
    mode: 'chat',
    groupId: null,
    createdAt: '2026-11-10T09:00:00Z',
    updatedAt: '2026-11-10T09:00:00Z',
  } as ChatSession;

  const inboxSessionB: ChatSession = {
    id: 'sess_inbox_2',
    title: '阅读长难句速记',
    mode: 'chat',
    groupId: null,
    createdAt: '2026-11-10T10:00:00Z',
    updatedAt: '2026-11-10T10:00:00Z',
  } as ChatSession;

  React.useLayoutEffect(() => {
    useStudySpaceStore.setState({
      activeSpaceId: 'grp_cet6',
      groupsById: { grp_cet6: group },
      profilesBySpaceId: {
        grp_cet6: {
          spaceId: 'grp_cet6',
          rootFolderId: 'fld_cet6_root',
          examDate,
          dailyBudgetMinutes: 60,
          targetRetention: 0.92,
          workbenchLayoutPreset: 'split_reader_chat',
          defaultDeckId: 'English::CET6',
          memoryScope: 'space_and_global',
          createdAt: '2026-11-01T08:00:00Z',
          updatedAt: '2026-11-01T08:00:00Z',
        },
      },
      mountsBySpaceId: { grp_cet6: [] },
    });
  }, [examDate]);

  const { renderSessionSidebarContent } = useSessionSidebarContent({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    viewMode: 'sidebar',
    setViewMode: vi.fn(),
    setSessionSheetOpen: vi.fn(),
    editableGroupIds: new Set(['grp_cet6']),
    onCreateGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onEditGroup: vi.fn(),
    onArchiveGroup: vi.fn(),
    isInitialLoading: false,
    sessions: sessionLoaded ? [spaceSession, inboxSessionA, inboxSessionB] : [],
    visibleGroups: [group],
    sessionsByGroup: new Map([['grp_cet6', [spaceSession]]]),
    ungroupedSessions: [inboxSessionA, inboxSessionB],
    currentSessionId: spaceSession.id,
    hasMoreSessions: false,
    isLoadingMore: false,
    t: ((key: string, opts?: Record<string, unknown>) => lookupZhChatV2(key, opts)) as any,
    resetDeleteConfirmation: vi.fn(),
    createSession: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    renderSessionItem: (session: ChatSession) => (
      <div key={session.id} data-testid={`session-item-${session.id}`}>
        {session.title}
      </div>
    ),
  });

  return <>{renderSessionSidebarContent()}</>;
}

describe('GroupEditorPanel & SessionSidebarContent Study Space UX', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listAnkiCardsMock.mockReset();
    localStorage.clear();
    useStudySpaceStore.getState().resetForTests();

    listAnkiCardsMock.mockResolvedValue({
      cards: [],
      total: 0,
      decks: [
        { name: 'Physics::Mechanics', all: 42, due: 8, new: 5, notEnqueued: 0 },
        { name: 'English::CET6', all: 120, due: 15, new: 10, notEnqueued: 0 },
      ],
    });
  });

  it('waits for asynchronously loaded current-session metadata before recording the sidebar selection', async () => {
    invokeMock.mockResolvedValue([]);
    const examDate = '2026-11-26';
    const { rerender } = render(<StudySpaceSidebarTestHarness examDate={examDate} sessionLoaded={false} />);
    act(() => useStudySpaceStore.getState().setActiveSpace(null));
    rerender(<StudySpaceSidebarTestHarness examDate={examDate} />);
    await waitFor(() => expect(useStudySpaceStore.getState().activeSpaceId).toBe('grp_cet6'));
  });

  it('renders GroupEditorPanel with 3 segmented tabs, edits Study Space fields across tabs, and persists via vfs_study_space_upsert_profile', async () => {
    const initialGroup: SessionGroup = {
      id: 'grp_physics',
      name: '大学物理空间',
      description: '力学与电磁学',
      color: '#3b82f6',
      systemPrompt: 'Focus on derivations.',
      defaultSkillIds: [],
      pinnedResourceIds: ['fld_physics_root'],
      rootFolderId: 'fld_physics_root',
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-01T08:00:00Z',
    };

    const existingProfile: StudySpaceProfile = {
      spaceId: 'grp_physics',
      rootFolderId: 'fld_physics_root',
      examDate: null,
      dailyBudgetMinutes: STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
      targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
      workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
      defaultDeckId: null,
      memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-01T08:00:00Z',
    };

    let savedProfilePayload: Record<string, unknown> | null = null;

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.getProfile) {
        return existingProfile;
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) {
        return [];
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.upsertProfile) {
        const input = args?.input as Record<string, unknown>;
        savedProfilePayload = input;
        return {
          ...existingProfile,
          ...input,
          updatedAt: '2026-11-11T12:00:00Z',
        };
      }
      if (cmd === 'chat_v2_list_runtime_roots') {
        return [];
      }
      return null;
    });

    const onSubmitMock = vi.fn(async (payload: UpdateGroupRequest) => ({
      ...initialGroup,
      ...payload,
    }));

    const { container } = render(
      <GroupEditorPanel
        mode="edit"
        initial={initialGroup}
        onSubmit={onSubmitMock}
        onClose={vi.fn()}
        embeddedInDialog
      />,
    );

    // Verify all 3 segmented tabs render
    const generalTab = screen.getByRole('radio', { name: '基础与提示词' });
    const goalsTab = screen.getByRole('radio', { name: '目标与记忆调度' });
    const workspaceTab = screen.getByRole('radio', { name: '挂载与工作台' });
    expect(generalTab).toBeInTheDocument();
    expect(goalsTab).toBeInTheDocument();
    expect(workspaceTab).toBeInTheDocument();

    // Switch to Tab 2: Goals & FSRS
    fireEvent.click(goalsTab);

    const targetExamDate = formatDaysFromTodayIso(20);
    const examInput = screen.getByLabelText('目标考试日期') as HTMLInputElement;
    fireEvent.change(examInput, { target: { value: targetExamDate } });
    expect(screen.getByText('D-20')).toBeInTheDocument();

    // Daily budget preset 90m
    fireEvent.click(screen.getByRole('button', { name: '90m' }));

    // Target retention 93% (0.93)
    fireEvent.click(screen.getByRole('radio', { name: '93%' }));
    expect(screen.getByText('0.93')).toBeInTheDocument();

    // Default deck select
    await waitFor(() => {
      expect(listAnkiCardsMock).toHaveBeenCalled();
    });
    const deckSelect = screen.getByLabelText('默认闪卡牌组') as HTMLSelectElement;
    fireEvent.change(deckSelect, { target: { value: 'Physics::Mechanics' } });

    // Switch to Tab 3: Mounts & Workbench
    fireEvent.click(workspaceTab);

    // Memory Scope -> space_isolated
    fireEvent.click(screen.getByRole('radio', { name: '仅限本空间隔离' }));

    // Workbench Layout Preset -> practice_review
    fireEvent.click(screen.getByRole('radio', { name: /刷题与闪卡复习/ }));

    // Save
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
      expect(savedProfilePayload).not.toBeNull();
    });

    expect(savedProfilePayload).toMatchObject({
      spaceId: 'grp_physics',
      rootFolderId: 'fld_physics_root',
      examDate: targetExamDate,
      dailyBudgetMinutes: 90,
      targetRetention: 0.93,
      defaultDeckId: 'Physics::Mechanics',
      memoryScope: 'space_isolated',
      workbenchLayoutPreset: 'practice_review',
    });

    // Zero emojis in rendered GroupEditorPanel DOM
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('renders SessionSidebarContent with pinned Inbox row, tabular-nums ungrouped count, D-15 Space countdown badge, and zero emojis', async () => {
    const examDate15DaysAhead = formatDaysFromTodayIso(15);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) {
        return [
          {
            spaceId: 'grp_cet6',
            rootFolderId: 'fld_cet6_root',
            examDate: examDate15DaysAhead,
            dailyBudgetMinutes: 60,
            targetRetention: 0.92,
            workbenchLayoutPreset: 'split_reader_chat',
            defaultDeckId: 'English::CET6',
            memoryScope: 'space_and_global',
            createdAt: '2026-11-01T08:00:00Z',
            updatedAt: '2026-11-01T08:00:00Z',
          } satisfies StudySpaceProfile,
        ];
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) {
        return [];
      }
      return null;
    });

    const { container } = render(
      <StudySpaceSidebarTestHarness examDate={examDate15DaysAhead} />,
    );

    // Pinned Inbox row at top with 1px border-b border-border/35 divider and tabular-nums count = 2
    const pinnedInbox = screen.getByTestId('sidebar-inbox-pinned');
    expect(pinnedInbox).toBeInTheDocument();
    expect(pinnedInbox.className).toContain('border-b');
    expect(pinnedInbox.className).toContain('border-border/35');
    expect(within(pinnedInbox).getByRole('button', { name: '收件箱' })).toBeInTheDocument();

    const inboxCount = screen.getByTestId('sidebar-inbox-count');
    expect(inboxCount).toHaveTextContent('2');
    expect(inboxCount.className).toContain('font-mono');
    expect(inboxCount.className).toContain('tabular-nums');

    // Space header row shows D-15 countdown badge and session count = 1
    const spaceCountdown = await screen.findByTestId('space-countdown-grp_cet6');
    expect(spaceCountdown).toHaveTextContent('D-15');
    expect(spaceCountdown.className).toContain('font-mono');
    expect(spaceCountdown.className).toContain('tabular-nums');

    const spaceCount = screen.getByTestId('space-session-count-grp_cet6');
    expect(spaceCount).toHaveTextContent('1');
    expect(spaceCount.className).toContain('font-mono');
    expect(spaceCount.className).toContain('tabular-nums');

    // StudySpaceBadgeStrip rendered for active space
    const badgeStrip = screen.getByTestId('study-space-badge-strip');
    expect(badgeStrip).toHaveTextContent('大学英语六级冲刺');
    expect(badgeStrip).toHaveTextContent('D-15');
    expect(badgeStrip).toHaveTextContent('60m/日');
    expect(badgeStrip).toHaveTextContent('92%');

    // Zero emojis anywhere in rendered sidebar DOM
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('exposes cross-space mount and unmount actions in LearningHubContextMenu and mounts via SpaceMountPickerDialog excluding canonical owner space', async () => {
    const mathGroup: SessionGroup = {
      id: 'grp_math',
      name: '高等数学空间',
      color: '#6366f1',
      rootFolderId: 'fld_math_home',
      defaultSkillIds: [],
      pinnedResourceIds: ['fld_math_home'],
      sortOrder: 0,
      persistStatus: 'active',
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-01T08:00:00Z',
    };
    const physicsGroup: SessionGroup = {
      id: 'grp_physics',
      name: '普通物理空间',
      color: '#10b981',
      rootFolderId: 'fld_physics_target',
      defaultSkillIds: [],
      pinnedResourceIds: ['fld_physics_target'],
      sortOrder: 1,
      persistStatus: 'active',
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-01T08:00:00Z',
    };

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.addMount) {
        const input = args?.input as {
          spaceId: string;
          targetFolderId: string;
          itemType: 'file';
          itemId: string;
        };
        return {
          id: 'mnt_cross_1',
          spaceId: input.spaceId,
          targetFolderId: input.targetFolderId,
          itemType: input.itemType,
          itemId: input.itemId,
          createdAt: '2026-11-11T12:00:00Z',
        } satisfies StudySpaceMount;
      }
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([mathGroup, physicsGroup]);

    const onMountToSpace = vi.fn();
    const onUnmountFromCurrentFolder = vi.fn();

    render(
      <LearningHubContextMenu
        open
        onOpenChange={vi.fn()}
        position={{ x: 40, y: 40 }}
        dataView="folder"
        currentFolderId="fld_physics_target"
        target={{
          type: 'resource',
          resource: {
            id: 'file_calc_book',
            title: '微积分核心讲义.pdf',
            type: 'textbook',
            folderId: 'fld_math_home',
            createdAt: '2026-11-01T08:00:00Z',
            updatedAt: '2026-11-01T08:00:00Z',
            metadata: {
              isMounted: true,
              mountId: 'mnt_existing_99',
            },
          } as any,
        }}
        activeMountId="mnt_existing_99"
        onMountToSpace={onMountToSpace}
        onUnmountFromCurrentFolder={onUnmountFromCurrentFolder}
      />,
    );

    const mountBtn = screen.getByRole('menuitem', { name: '挂载到学习空间...' });
    const unmountBtn = screen.getByRole('menuitem', { name: '解除当前空间挂载' });
    expect(mountBtn).toBeInTheDocument();
    expect(unmountBtn).toBeInTheDocument();

    fireEvent.click(unmountBtn);
    expect(onUnmountFromCurrentFolder).toHaveBeenCalledWith('mnt_existing_99');

    // Render SpaceMountPickerDialog for canonical item owned by fld_math_home
    const onMounted = vi.fn();
    render(
      <SpaceMountPickerDialog
        open
        onOpenChange={vi.fn()}
        item={{
          itemId: 'file_calc_book',
          itemType: 'textbook',
          title: '微积分核心讲义.pdf',
          canonicalFolderId: 'fld_math_home',
        }}
        onMounted={onMounted}
      />,
    );

    // Home space (高等数学空间) is excluded; target space (普通物理空间) is listed
    expect(screen.queryByText('高等数学空间')).not.toBeInTheDocument();
    expect(screen.getByText('普通物理空间')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加挂载资料' }));

    await waitFor(() => {
      expect(onMounted).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mnt_cross_1',
          spaceId: 'grp_physics',
          targetFolderId: 'fld_physics_target',
          itemType: 'file',
          itemId: 'file_calc_book',
        }),
      );
    });
  });
});
