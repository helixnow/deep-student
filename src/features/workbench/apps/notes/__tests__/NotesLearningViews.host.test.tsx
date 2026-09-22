import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { data } = vi.hoisted(() => ({ data: {
  nodes: [] as DstuNode[],
  watchers: new Set<(event: { type: string; node: DstuNode; path: string }) => void>(),
  createdContent: '',
} }));
vi.mock('@/dstu', () => ({
  dstu: {
    list: async (_path: string, options: { typeFilter?: string; isFavorite?: boolean }) => ({
      ok: true, value: options?.isFavorite ? [] : data.nodes.filter((node) => !options?.typeFilter || node.type === options.typeFilter),
    }),
    watch: (_path: string, callback: (event: { type: string; node: DstuNode; path: string }) => void) => {
      data.watchers.add(callback); return () => data.watchers.delete(callback);
    },
    getContent: async () => ({ ok: true, value: '' }),
    search: async () => ({ ok: true, value: [] }),
    create: async (_path: string, options: { name: string; content: string }) => {
      data.createdContent = options.content;
      const node = { id: 'note_created', sourceId: 'note_created', path: '/note_created', name: options.name, type: 'note', createdAt: 1000, updatedAt: 1000, metadata: {} } as DstuNode;
      data.nodes.push(node); return { ok: true, value: node };
    },
    get: async (path: string) => ({ ok: true, value: data.nodes.find((node) => node.path === path) }),
    setMetadata: async (path: string, metadata: Record<string, unknown>) => {
      const node = data.nodes.find((node) => node.path === path)!;
      node.metadata = metadata; node.updatedAt += 1000;
      return { ok: true, value: undefined };
    },
  },
  folderApi: {
    listFolders: async () => ({ ok: true, value: [] }),
    getFolderTree: async () => ({ ok: true, value: [] }),
  },
  trashApi: { listTrash: async () => ({ ok: true, value: [] }) },
  createEmpty: vi.fn(),
  updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString(),
}));
vi.mock('@/utils/notesApi', () => ({ NotesAPI: { listTags: async () => [] } }));
vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: ({ resourceId }: { resourceId: string }) => <div data-testid={`opened-${resourceId}`} />,
}));
vi.mock('../NotesBacklinksPanel', () => ({ NotesBacklinksPanel: () => null }));
vi.mock('../wikilinkRenameSync', () => ({ syncWikiLinksAfterNoteRename: vi.fn() }));
import { NotesWorkspaceApp } from '../NotesWorkspaceApp';
import { resetWorkspaceRegistryForTests } from '../workspaceRegistry';

describe('NotesWorkspaceApp learning views', () => {
  beforeEach(() => {
    localStorage.clear(); resetWorkspaceRegistryForTests(); data.watchers.clear();
    data.nodes = [
      { id: 'n1', path: '/n1', name: '微积分', type: 'note', createdAt: 1, updatedAt: 1,
        metadata: { props: { study_mastery: 'learning', study_review_date: '2020-01-01' } } },
      { id: 'n2', path: '/n2', name: '英语', type: 'note', createdAt: 1, updatedAt: 1,
        metadata: { props: { study_mastery: 'mastered' } } },
    ];
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('opens the same notes and reacts to metadata-only updates across status and review views', async () => {
    render(<NotesWorkspaceApp windowId="study-test" instanceKey={null} isActive isVisible onTitleChange={vi.fn()} requestClose={vi.fn()} />);
    await screen.findByText('微积分');
    fireEvent.change(screen.getByLabelText('笔记学习视图'), { target: { value: 'status' } });
    const learningSection = screen.getByRole('heading', { name: '学习中 · 1' }).closest('section')!;
    expect(within(learningSection).getByText('微积分')).toBeInTheDocument();
    fireEvent.click(within(learningSection).getByRole('button'));
    await screen.findByTestId('opened-n1');

    const changed: DstuNode = { ...data.nodes[0], updatedAt: 2,
      metadata: { props: { study_mastery: 'mastered', study_review_date: '2099-01-01' } } };
    act(() => data.watchers.forEach((callback) => callback({ type: 'updated', node: changed, path: changed.path })));
    expect(screen.getByRole('heading', { name: '学习中 · 0' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '已掌握 · 2' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('笔记学习视图'), { target: { value: 'review' } });
    expect(screen.getByRole('heading', { name: /近期复习.* · 0/ })).toBeInTheDocument();
    // Delayed older metadata cannot resurrect an overdue item.
    act(() => data.watchers.forEach((callback) => callback({ type: 'updated', node: data.nodes[0], path: '/n1' })));
    expect(screen.getByRole('heading', { name: /近期复习.* · 0/ })).toBeInTheDocument();
    act(() => data.watchers.forEach((callback) => callback({ type: 'updated', node: { ...data.nodes[0], updatedAt: 3 }, path: '/n1' })));
    expect(screen.getByRole('heading', { name: /近期复习.* · 1/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('笔记学习视图'), { target: { value: 'list' } });
    const list = screen.getByLabelText('学习视图');
    expect(within(list).getAllByRole('button')).toHaveLength(2);
  });
  it('creates a course note through the visible workspace entry and opens the initialized note', async () => {
    render(<NotesWorkspaceApp windowId="study-create" instanceKey={null} isActive isVisible onTitleChange={vi.fn()} requestClose={vi.fn()} />);
    await screen.findByText('微积分');
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建学习笔记' }));
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '积分练习' } });
    fireEvent.change(screen.getByLabelText('所属课程'), { target: { value: '高数' } });
    fireEvent.change(screen.getByLabelText('新建模板'), { target: { value: 'lecture' } });
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }));
    await screen.findByTestId('opened-note_created');
    expect(data.createdContent).toContain('本节目标');
    expect(data.nodes.find((node) => node.id === 'note_created')?.metadata?.props).toEqual({ study_course: '高数' });
  });
});
