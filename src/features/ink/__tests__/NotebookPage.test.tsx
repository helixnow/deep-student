import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuListOptions, DstuNode } from '@/dstu';
import type { Result } from '@/shared/result';

const mocks = vi.hoisted(() => ({
  list: vi.fn<(path: string, options?: DstuListOptions) => Promise<Result<DstuNode[]>>>(),
  rename: vi.fn<(path: string, name: string) => Promise<Result<DstuNode>>>(),
  delete: vi.fn<(path: string) => Promise<Result<void>>>(),
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
  dstu: { list: mocks.list, rename: mocks.rename, delete: mocks.delete },
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
  mocks.rename.mockReset();
  mocks.delete.mockReset();
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


describe('NotebookPage card actions', () => {
  it.each(['text', 'ink'] as const)('renames a %s notebook directly and refreshes without opening it', async (kind) => {
    const existing = node('notebook_rename', { type: kind === 'ink' ? 'file' : 'note', name: kind === 'ink' ? '旧标题.dsink' : '旧标题' });
    installLists(kind === 'text' ? [existing] : [], kind === 'ink' ? [existing] : []);
    mocks.rename.mockImplementation(async (_path, name) => {
      existing.name = name;
      return { ok: true, value: { ...existing } };
    });
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId(`notebook-rename-${existing.id}`));
    const dialog = await screen.findByRole('alertdialog', { name: '重命名笔记' });
    const input = within(dialog).getByRole('textbox', { name: '笔记名称' });
    expect(input).toHaveValue('旧标题');
    fireEvent.change(input, { target: { value: kind === 'ink' ? ' 新标题.dsink.dsink ' : ' 新标题 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重命名', exact: true }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitForLoaded();
    expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(`/${existing.id}`, kind === 'ink' ? '新标题.dsink' : '新标题');
    expect(screen.getByTestId(`notebook-card-${existing.id}`)).toHaveTextContent('新标题');
    expect(mocks.inkProps).toHaveLength(0);
    expect(mocks.textProps).toHaveLength(0);
  });

  it.each(['', '   ', '.dsink', 'invalid/name', 'invalid\\name', 'invalid:name', 'bad?name'])(
    'rejects an invalid handwritten title %j without invoking rename', async (value) => {
      installLists([], [node('ink_invalid', { type: 'file', name: '旧标题.dsink' })]);
      render(<NotebookPage />);
      await waitForLoaded();
      fireEvent.click(screen.getByTestId('notebook-rename-ink_invalid'));
      const dialog = await screen.findByRole('alertdialog');
      const input = within(dialog).getByRole('textbox');
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      const confirm = within(dialog).getByRole('button', { name: '重命名', exact: true });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );

  it('cancels either action without invoking the API or opening a workspace', async () => {
    installLists([node('note_cancel')], []);
    render(<NotebookPage />);
    await waitForLoaded();
    for (const action of ['rename', 'delete']) {
      fireEvent.click(screen.getByTestId(`notebook-${action}-note_cancel`));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    }
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByTestId('notebook-card-note_cancel')).toBeInTheDocument();
    expect(mocks.textProps).toHaveLength(0);
  });

  it('keeps a failed rename editable for retry and suppresses duplicate Enter/click submissions', async () => {
    const existing = node('rename_retry');
    installLists([existing], []);
    mocks.rename.mockRejectedValueOnce(new Error('temporary rename failure'));
    let finish!: (value: Result<DstuNode>) => void;
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-rename-rename_retry'));
    const dialog = await screen.findByRole('alertdialog');
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: '重试成功' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(mocks.rename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('temporary rename failure');
    expect(input).toHaveValue('重试成功');
    mocks.rename.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const confirm = within(dialog).getByRole('button', { name: '重命名', exact: true });
    fireEvent.click(confirm);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(confirm);
    expect(mocks.rename).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    existing.name = '重试成功';
    await act(async () => finish({ ok: true, value: existing }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitForLoaded();
    expect(screen.getByTestId('notebook-card-rename_retry')).toHaveTextContent('重试成功');
  });

  it.each(['text', 'ink'] as const)('deletes a %s notebook through the trash API after confirmation', async (kind) => {
    const existing = node('delete_notebook', { type: kind === 'ink' ? 'file' : 'note', name: kind === 'ink' ? '删除.dsink' : '删除' });
    installLists(kind === 'text' ? [existing] : [], kind === 'ink' ? [existing] : []);
    mocks.delete.mockImplementation(async () => {
      installLists([], []);
      return { ok: true, value: undefined };
    });
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-delete-delete_notebook'));
    const dialog = await screen.findByRole('alertdialog', { name: '删除笔记' });
    expect(dialog).toHaveTextContent('资源库回收站恢复');
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitForLoaded();
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('/delete_notebook');
    expect(screen.queryByTestId('notebook-card-delete_notebook')).not.toBeInTheDocument();
    expect(mocks.inkProps).toHaveLength(0);
    expect(mocks.textProps).toHaveLength(0);
  });

  it('retains a failed deletion and allows retry without losing the card', async () => {
    installLists([node('delete_retry')], []);
    mocks.delete.mockResolvedValueOnce({ ok: false, error: { toUserMessage: () => '回收站暂不可用' } } as unknown as Result<void>);
    mocks.delete.mockImplementationOnce(async () => {
      installLists([], []);
      return { ok: true, value: undefined };
    });
    render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-delete-delete_retry'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('回收站暂不可用');
    expect(screen.getByTestId('notebook-card-delete_retry')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitForLoaded();
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('notebook-card-delete_retry')).not.toBeInTheDocument();
  });

  it('does not allow a pending dialog to submit when the page becomes inactive', async () => {
    installLists([node('inactive_action')], []);
    const view = render(<NotebookPage />);
    await waitForLoaded();
    fireEvent.click(screen.getByTestId('notebook-rename-inactive_action'));
    const dialog = await screen.findByRole('alertdialog');
    view.rerender(<NotebookPage isActive={false} />);
    fireEvent.click(within(dialog).getByRole('button', { name: '重命名', exact: true }));
    fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Enter' });
    expect(mocks.rename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('notebook-delete-inactive_action')).toBeDisabled();
  });
});
