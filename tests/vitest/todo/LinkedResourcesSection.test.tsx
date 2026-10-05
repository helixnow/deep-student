import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TodoItem } from '@/features/todo/types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  search: vi.fn(),
  updateItem: vi.fn(async () => undefined),
  recent: [] as Array<{ id: string; path: string; name: string; type: string; accessedAt: number }>,
}));

vi.mock('@/dstu/api', () => ({ get: mocks.get, search: mocks.search }));
vi.mock('@/features/learning-hub/stores/recentStore', () => ({
  useRecentStore: (selector: (state: { items: typeof mocks.recent }) => unknown) => selector({ items: mocks.recent }),
}));
vi.mock('@/features/todo/stores/useTodoStore', () => ({
  useTodoStore: (selector: (state: { updateItem: typeof mocks.updateItem }) => unknown) =>
    selector({ updateItem: mocks.updateItem }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => ({
      'todo:links.title': '关联资料',
      'todo:links.add': '添加',
      'todo:links.empty': '把要用的笔记挂在这里',
      'todo:links.open': `打开「${options?.name}」`,
      'todo:links.remove': `取消关联「${options?.name}」`,
      'todo:links.missing': '这份资料已删除或找不到了',
      'todo:links.searchPlaceholder': '搜索资料',
      'todo:links.recent': '最近打开',
      'todo:links.searchResults': '搜索结果',
      'todo:links.linked': '已关联',
      'common:actions.cancel': '取消',
    }[key] ?? key),
  }),
}));

import { LinkedResourcesSection } from '@/features/todo/components/main/detail/LinkedResourcesSection';

function todo(attachments: string[]): TodoItem {
  return {
    id: 'todo-1',
    todoListId: 'list-1',
    title: '复习第三章',
    status: 'pending',
    priority: 'none',
    tagsJson: '[]',
    sortOrder: 0,
    attachmentsJson: JSON.stringify(attachments),
    createdAt: '',
    updatedAt: '',
  } as TodoItem;
}

describe('LinkedResourcesSection', () => {
  let dispatched: CustomEvent[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recent = [];
    dispatched = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      dispatched.push(event as CustomEvent);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows linked materials by name, opens them and unlinks', async () => {
    mocks.get.mockImplementation(async (path: string) => (path === '/note_1'
      ? { ok: true, value: { id: 'note_1', name: '第三章笔记', type: 'note' } }
      : { ok: false, error: new Error('gone') }));
    const onSaved = vi.fn();
    render(<LinkedResourcesSection item={todo(['/note_1', '/exam_gone'])} onSaved={onSaved} />);

    fireEvent.click(await screen.findByRole('button', { name: '第三章笔记' }));
    expect(dispatched.find((event) => event.type === 'NAVIGATE_TO_VIEW')?.detail).toEqual({
      view: 'learning-hub',
      openResource: '/note_1',
    });

    const missing = await screen.findByTitle('这份资料已删除或找不到了');
    expect(missing).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '取消关联「exam_gone」' }));
    expect(mocks.updateItem).toHaveBeenCalledWith({ id: 'todo-1', attachments: ['/note_1'] });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('links a recently opened material or a search hit', async () => {
    mocks.recent = [
      { id: 'tb_1', path: '/tb_1', name: '高数教材', type: 'textbook', accessedAt: 2 },
      { id: 'folder_1', path: '/f', name: '文件夹', type: 'folder', accessedAt: 1 },
    ];
    mocks.search.mockResolvedValue({ ok: true, value: [{ id: 'exam_9', name: '期中题目集', type: 'exam' }] });
    const { rerender } = render(<LinkedResourcesSection item={todo([])} onSaved={vi.fn()} />);

    expect(screen.getByText('把要用的笔记挂在这里')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByText('最近打开')).toBeInTheDocument();
    expect(screen.queryByText('文件夹')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /高数教材/ }));
    expect(mocks.updateItem).toHaveBeenLastCalledWith({ id: 'todo-1', attachments: ['/tb_1'] });

    rerender(<LinkedResourcesSection item={todo(['/tb_1'])} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('搜索资料'), { target: { value: '期中' } });
    fireEvent.click(await screen.findByRole('button', { name: /期中题目集/ }));
    expect(mocks.search).toHaveBeenCalledWith('期中');
    expect(mocks.updateItem).toHaveBeenLastCalledWith({ id: 'todo-1', attachments: ['/tb_1', '/exam_9'] });
  });
});
