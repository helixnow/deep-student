import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === 'data:governance.archive_session_count') {
          return `${options?.count ?? 0} 个归档会话`;
        }

        const messages: Record<string, string> = {
          'data:governance.archive_title': '归档会话',
          'data:governance.archive_description': '已归档的聊天会话会从主列表收起，但仍可恢复；需要彻底移除时可永久删除。',
          'data:governance.archive_loading': '正在加载归档会话...',
          'data:governance.archive_load_failed': '加载归档会话失败',
          'data:governance.archive_empty_state': '暂无归档会话',
          'data:governance.archive_empty_state_desc': '从侧边栏归档的会话会出现在这里，直到恢复或永久删除。',
          'data:governance.archive_restore': '恢复',
          'data:governance.archive_delete': '永久删除',
          'data:governance.archive_delete_confirm': '确认删除',
          'data:governance.archive_untitled': '未命名会话',
          'data:governance.archive_ungrouped_title': '未分组',
          'data:governance.archive_empty_group_hint': '该分组下暂无归档会话',
          'common:actions.refresh': '刷新',
        };

        return messages[key] ?? key;
      },
    }),
  };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { ChatSessionArchiveTab } from '@/features/settings/components/data-governance/ChatSessionArchiveTab';

describe('ChatSessionArchiveTab group visibility', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('shows archived groups and keeps ungrouped archived sessions visible', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'chat_v2_list_sessions') {
        return Promise.resolve([
          {
            id: 'session-1',
            mode: 'chat',
            title: '二次函数复习',
            persistStatus: 'archived',
            createdAt: '2026-05-21T08:00:00.000Z',
            updatedAt: '2026-05-22T08:00:00.000Z',
            groupId: 'group-1',
          },
          {
            id: 'session-2',
            mode: 'chat',
            title: '错题清单整理',
            persistStatus: 'archived',
            createdAt: '2026-05-20T08:00:00.000Z',
            updatedAt: '2026-05-21T08:00:00.000Z',
          },
        ]);
      }

      if (command === 'chat_v2_list_groups') {
        return Promise.resolve([
          {
            id: 'group-1',
            name: '数学专题',
            defaultSkillIds: [],
            pinnedResourceIds: [],
            sortOrder: 0,
            persistStatus: 'archived',
            createdAt: '2026-05-20T08:00:00.000Z',
            updatedAt: '2026-05-22T08:00:00.000Z',
          },
        ]);
      }

      return Promise.resolve(null);
    });

    render(<ChatSessionArchiveTab />);

    expect(await screen.findByText('数学专题')).toBeInTheDocument();
    expect(screen.getByText('二次函数复习')).toBeInTheDocument();
    expect(screen.getByText('未分组')).toBeInTheDocument();
    expect(screen.getByText('错题清单整理')).toBeInTheDocument();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_list_groups', {
        status: 'archived',
      });
    });
  });
});
