import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuListOptions, DstuNode } from '@/dstu';
import type { Result } from '@/shared/result';

const mocks = vi.hoisted(() => ({
  list: vi.fn<(path: string, options?: DstuListOptions) => Promise<Result<DstuNode[]>>>(),
  createEmpty: vi.fn(),
  createInk: vi.fn(),
  createInkBoard: vi.fn(),
  useMobileHeader: vi.fn(),
  smallScreen: { value: false },
  inkProps: [] as Array<{ documentId: string; title?: string; isActive?: boolean; onClose?: () => void }>,
  textProps: [] as Array<{ node: DstuNode; isActive: boolean; onClose: () => void }>,
}));

vi.mock('@/dstu', async () => ({
  ...(await vi.importActual('@/dstu/inkFormat')),
  dstu: { list: mocks.list },
  createEmpty: mocks.createEmpty,
}));

vi.mock('@/features/ink', () => ({
  createInk: mocks.createInk,
  createInkBoard: mocks.createInkBoard,
  InkWorkspace: (props: typeof mocks.inkProps[number]) => {
    mocks.inkProps.push(props);
    return <section data-testid="ink-workspace-boundary" hidden={!props.isActive}>
      <span>{props.documentId}</span>
      <button onClick={props.onClose}>Return to library</button>
    </section>;
  },
}));

vi.mock('../NotebookTextWorkspace', () => ({
  default: (props: typeof mocks.textProps[number]) => {
    mocks.textProps.push(props);
    return <section data-testid="text-workspace-boundary" hidden={!props.isActive}>
      <span>{props.node.id}</span>
      <button onClick={props.onClose}>Return to library</button>
    </section>;
  },
}));

vi.mock('@/components/layout', () => ({
  useMobileHeader: mocks.useMobileHeader,
  MobileSlidingLayout: ({ sidebar, sidebarOpen, children }: { sidebar: React.ReactNode; sidebarOpen: boolean; children: React.ReactNode }) => (
    <div data-testid="mobile-layout"><div hidden={!sidebarOpen}>{sidebar}</div><header data-testid="notebook-sliding-layout-mock-header">Mock sliding layout header</header>{children}</div>
  ),
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: mocks.smallScreen.value }) }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@/locales/zh-CN/ink.json');
  const translate = (key: string, values?: Record<string, unknown>) => {
    let result: unknown = locale;
    for (const part of key.split('.')) result = (result as Record<string, unknown>)?.[part];
    return String(result ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({ t: translate, i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' } }),
  };
});

import { NotebookPage } from '../NotebookPage';
import { NOTEBOOK_LIST_PAGE_SIZE } from '../NotebookLibrary';

function node(id: string, options: Partial<DstuNode> = {}): DstuNode {
  return {
    id, sourceId: id, path: `/课程/${id}`, name: id, type: 'note',
    createdAt: 1, updatedAt: 1, ...options,
  };
}

function installLists(notes: DstuNode[], files: DstuNode[]) {
  mocks.list.mockImplementation(async (_path, options) => ({
    ok: true,
    value: (options?.typeFilter === 'note' ? notes : files)
      .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? NOTEBOOK_LIST_PAGE_SIZE)),
  }));
}

async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
}

beforeEach(() => {
  mocks.list.mockReset();
  installLists([], []);
  mocks.createEmpty.mockReset();
  mocks.createInk.mockReset().mockResolvedValue({ document_id: 'file_new_paged', title: '新分页' });
  mocks.createInkBoard.mockReset().mockResolvedValue({ document_id: 'file_new_board', title: '新画布' });
  mocks.useMobileHeader.mockClear();
  mocks.smallScreen.value = false;
  mocks.inkProps.length = 0;
  mocks.textProps.length = 0;
});

describe('NotebookPage library and workspace boundary', () => {
  it('loads nested notes across raw pages, excludes PDFs/other resources, and searches older notebooks beyond the visible card page', async () => {
    const notes = Array.from({ length: 30 }, (_, index) => node(`note_${index}`, { name: `Note ${index}`, updatedAt: 1000 - index }));
    const pdfs = Array.from({ length: 100 }, (_, index) => node(`tb_${index}`, { type: 'textbook', name: `Document ${index}.pdf` }));
    const target = node('file_old_board', { type: 'file', name: 'Algebra ideas.dsink', path: '/学期/深层代数/file_old_board', updatedAt: 2 });
    installLists(notes, [...pdfs, target]);
    render(<NotebookPage />);
    await waitForLoaded();
    expect(screen.getAllByTestId(/^notebook-card-/)).toHaveLength(24);
    expect(screen.queryByText('Document 0.pdf')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith('/', expect.objectContaining({ typeFilter: 'file', offset: 100 }));
    expect(mocks.list.mock.calls.every(([, options]) => !options?.recursive && !options?.types && !options?.folderId && !options?.search)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '显示更多笔记' }));
    expect(screen.getAllByTestId(/^notebook-card-/)).toHaveLength(31);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索笔记' }), { target: { value: ' algebra 深层代数 ' } });
    expect(screen.getAllByTestId(/^notebook-card-/)).toHaveLength(1);
    expect(screen.getByTestId('notebook-card-file_old_board')).toHaveTextContent('Algebra ideas');
    fireEvent.click(screen.getByRole('button', { name: '文字', exact: true }));
    expect(screen.getByTestId('notebook-empty')).toHaveTextContent('没有找到匹配的笔记');
    fireEvent.click(screen.getByRole('button', { name: '清除搜索与筛选' }));
    expect(screen.getAllByTestId(/^notebook-card-/)).toHaveLength(24);
  });

  it('opens a real existing document id in InkWorkspace and returns to the same library search before reopening', async () => {
    installLists([node('note_text', { name: '其他文字' })], [node('file_existing', { type: 'file', name: '我的手写.dsink' })]);
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.change(screen.getByTestId('notebook-search'), { target: { value: '我的手写' } });
    fireEvent.click(screen.getByTestId('notebook-card-file_existing'));
    expect(screen.queryByTestId('notebook-library')).not.toBeInTheDocument();
    expect(mocks.inkProps.at(-1)).toMatchObject({ documentId: 'file_existing', title: '我的手写', isActive: true });
    fireEvent.click(screen.getByRole('button', { name: 'Return to library' }));
    await waitForLoaded();
    expect(screen.getByTestId('notebook-search')).toHaveValue('我的手写');
    expect(screen.queryByTestId('notebook-card-note_text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notebook-card-file_existing'));
    expect(mocks.inkProps.at(-1)?.documentId).toBe('file_existing');
    expect(mocks.createInk).not.toHaveBeenCalled();
    expect(mocks.createInkBoard).not.toHaveBeenCalled();
  });

  it.each(['paged', 'board'] as const)('creates a %s notebook and immediately opens the returned document, not a placeholder', async (mode) => {
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId(`notebook-create-${mode}`));
    await screen.findByTestId('ink-workspace-boundary');
    const create = mode === 'paged' ? mocks.createInk : mocks.createInkBoard;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: mode === 'paged' ? '未命名手写笔记' : '未命名自由画布',
      ruling: 'blank', operation_id: expect.any(String), folder_id: null,
      ...(mode === 'paged' ? { width: 794, height: 1123 } : {}),
    }));
    expect(mocks.inkProps.at(-1)).toMatchObject({ documentId: `file_new_${mode}`, isActive: true });
    expect(mode === 'paged' ? mocks.createInkBoard : mocks.createInk).not.toHaveBeenCalled();
  });

  it('creates text notes through createEmpty and reuses the existing note node without migration', async () => {
    const created = node('note_created', { name: '新的文字', path: '/note_created' });
    mocks.createEmpty.mockResolvedValue({ ok: true, value: created });
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-create-text'));
    await screen.findByTestId('text-workspace-boundary');
    expect(mocks.createEmpty).toHaveBeenCalledWith({ type: 'note', name: '未命名文字笔记', folderId: null });
    expect(mocks.textProps.at(-1)).toMatchObject({ node: created, isActive: true });
    installLists([created], []);
    fireEvent.click(screen.getByRole('button', { name: 'Return to library' }));
    await screen.findByTestId('notebook-card-note_created');
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-card-note_created'));
    await screen.findByTestId('text-workspace-boundary');
    expect(mocks.createEmpty).toHaveBeenCalledTimes(1);
  });

  it('shows partial list failures explicitly, keeps successful cards, and retries instead of presenting an empty result', async () => {
    const retained = node('file_retained', { type: 'file', name: '可用手写.dsink' });
    mocks.list.mockImplementation(async (_path, options) => options?.typeFilter === 'note'
      ? { ok: false, error: { toUserMessage: () => '笔记数据库暂时不可用' } } as unknown as Result<DstuNode[]>
      : { ok: true, value: options?.offset === 0 ? [retained] : [] });
    render(<NotebookPage />);
    await waitForLoaded();
    expect(screen.getByRole('alert')).toHaveTextContent('笔记数据库暂时不可用');
    expect(screen.getByTestId('notebook-card-file_retained')).toBeInTheDocument();
    expect(screen.queryByTestId('notebook-empty')).not.toBeInTheDocument();
    installLists([node('note_recovered', { name: '已恢复' })], [retained]);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }));
    await screen.findByTestId('notebook-card-note_recovered');
    await waitForLoaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports later-page search failures without a false no-results message and can recover on retry', async () => {
    installLists([], []);
    mocks.list.mockImplementation(async (_path, options) => {
      if (options?.typeFilter === 'note') return { ok: true, value: [] };
      if (options?.offset === 0) return { ok: true, value: [node('tb_pdf', { type: 'textbook', name: 'Only.pdf' })] };
      throw new Error('later file page failed');
    });
    render(<NotebookPage />);
    fireEvent.change(screen.getByTestId('notebook-search'), { target: { value: '旧手写' } });
    await waitForLoaded();
    expect(screen.getByRole('alert')).toHaveTextContent('later file page failed');
    expect(screen.queryByTestId('notebook-empty')).not.toBeInTheDocument();
    installLists([], [node('file_found', { type: 'file', name: '旧手写.dsink' })]);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }));
    await screen.findByTestId('notebook-card-file_found');
    await waitForLoaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries creation errors explicitly, keeping the library open until a real document is created', async () => {
    mocks.createInkBoard.mockRejectedValueOnce(new Error('board storage unavailable'));
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-create-board'));
    expect(await screen.findByRole('alert')).toHaveTextContent('board storage unavailable');
    expect(screen.getByTestId('notebook-library')).toBeInTheDocument();
    expect(screen.queryByTestId('ink-workspace-boundary')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }));
    await screen.findByTestId('ink-workspace-boundary');
    expect(mocks.createInkBoard).toHaveBeenCalledTimes(2);
  });

  it('does not load or create when inactive and passes inactive state to an already open workspace', async () => {
    const view = render(<NotebookPage isActive={false} />);
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('notebook-create-board'));
    expect(mocks.createInkBoard).not.toHaveBeenCalled();
    view.rerender(<NotebookPage isActive />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-create-board'));
    await screen.findByTestId('ink-workspace-boundary');
    const requestCount = mocks.list.mock.calls.length;
    view.rerender(<NotebookPage isActive={false} />);
    expect(mocks.inkProps.at(-1)?.isActive).toBe(false);
    expect(mocks.list).toHaveBeenCalledTimes(requestCount);
    expect(mocks.useMobileHeader.mock.calls.at(-1)?.[3]).toBe(false);
  });

  it('ignores a late page after deactivation and starts a fresh scan without publishing stale results', async () => {
    let finish!: (value: Result<DstuNode[]>) => void;
    mocks.list.mockImplementation((_path, options) => options?.typeFilter === 'file'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, value: [] }));
    const view = render(<NotebookPage />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载笔记');
    view.rerender(<NotebookPage isActive={false} />);
    await act(async () => { finish({ ok: true, value: [node('file_stale', { type: 'file', name: '过期.dsink' })] }); });
    expect(screen.queryByTestId('notebook-card-file_stale')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    installLists([], [node('file_current', { type: 'file', name: '当前.dsink' })]);
    view.rerender(<NotebookPage isActive />);
    await screen.findByTestId('notebook-card-file_current');
    await waitForLoaded();
    expect(screen.queryByTestId('notebook-card-file_stale')).not.toBeInTheDocument();
  });

  it('defers a creation finishing in the background until the notes page becomes active again', async () => {
    let finish!: (value: { document_id: string; title: string }) => void;
    mocks.createInkBoard.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-create-board'));
    view.rerender(<NotebookPage isActive={false} />);
    const requestCount = mocks.list.mock.calls.length;
    await act(async () => { finish({ document_id: 'file_background', title: '后台新画布' }); });
    expect(screen.queryByTestId('ink-workspace-boundary')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(requestCount);
    view.rerender(<NotebookPage isActive />);
    await screen.findByTestId('ink-workspace-boundary');
    expect(mocks.inkProps.at(-1)?.documentId).toBe('file_background');
  });

  it('configures the notes mobile header and mounts one mock sliding-layout header only in the library state', async () => {
    mocks.smallScreen.value = true;
    installLists([], [node('file_mobile', { type: 'file', name: '手机手写.dsink' })]);
    render(<NotebookPage />);
    await waitForLoaded();
    expect(screen.getByTestId('mobile-layout')).toBeInTheDocument();
    expect(screen.getAllByTestId('notebook-sliding-layout-mock-header')).toHaveLength(1);
    expect(mocks.useMobileHeader.mock.calls.at(-1)?.[0]).toBe('notes');
    expect(mocks.useMobileHeader.mock.calls.at(-1)?.[1]).toMatchObject({ title: '笔记库', hidden: false, showMenu: true });
    fireEvent.click(screen.getByTestId('notebook-card-file_mobile'));
    expect(screen.queryByTestId('mobile-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notebook-sliding-layout-mock-header')).not.toBeInTheDocument();
    expect(mocks.useMobileHeader.mock.calls.at(-1)?.[1]).toMatchObject({ hidden: true, showMenu: false });
    fireEvent.click(screen.getByRole('button', { name: 'Return to library' }));
    await waitForLoaded();
    expect(screen.getAllByTestId('notebook-sliding-layout-mock-header')).toHaveLength(1);
    expect(mocks.useMobileHeader.mock.calls.at(-1)?.[1]).toMatchObject({ hidden: false, showMenu: true });
  });
});
