import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { NotebookHostState } from '../NotebookHost';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createInk: vi.fn(),
  createInkBoard: vi.fn(),
  getInk: vi.fn(),
}));

vi.mock('@/dstu', async () => ({
  ...(await vi.importActual('@/dstu/inkFormat')),
  dstu: { list: mocks.list },
  createEmpty: vi.fn(),
}));
vi.mock('../api', () => ({
  createInk: mocks.createInk,
  createInkBoard: mocks.createInkBoard,
  inkApi: { get: mocks.getInk },
}));
vi.mock('../LazyInkEditorEntry', () => ({
  LazyInkEditor: ({ documentId }: { documentId: string }) => <div data-testid="paged-editor" data-document-id={documentId}>
    <section data-testid="ink-editor" data-document-id={documentId}>
      <output data-testid="ink-editor-flush-state">ready</output>
    </section>
  </div>,
}));
vi.mock('../LazyInkBoardEditorEntry', () => ({
  LazyInkBoardEditor: ({ documentId }: { documentId: string }) => <div data-testid="board-editor" data-document-id={documentId}>
    <section data-testid="ink-board-editor" data-document-id={documentId} />
  </div>,
}));
vi.mock('../NotebookTextWorkspace', () => ({ default: () => <div /> }));
vi.mock('@/components/layout', () => ({ useMobileHeader: vi.fn(), MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('react-i18next', async () => {
  const { default: ink } = await import('@/locales/zh-CN/ink.json');
  const translate = (key: string, values?: Record<string, unknown>) => {
    if (key === 'common:back') return '返回';
    if (key === 'common:retry') return '重试';
    let result: unknown = ink;
    for (const part of key.split('.')) result = (result as Record<string, unknown>)?.[part];
    return String(result ?? values?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({ t: translate, i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' } }),
  };
});

import { NotebookPage } from '../NotebookPage';
import { registerInkEditorSession } from '../editorSession';

let savedFile: DstuNode | undefined;
const disposers: Array<() => void> = [];

beforeEach(() => {
  savedFile = undefined;
  mocks.list.mockReset().mockImplementation(async (_path, options) => ({
    ok: true,
    value: options?.typeFilter === 'file' && options?.offset === 0 && savedFile ? [savedFile] : [],
  }));
  const create = async ({ title }: { title: string }) => {
    savedFile = {
      id: 'file_notebook', sourceId: 'file_notebook', path: '/课程/file_notebook',
      type: 'file', name: `${title}.dsink`, createdAt: 1, updatedAt: 2,
    };
    return { document_id: savedFile.id, title };
  };
  mocks.createInk.mockReset().mockImplementation(create);
  mocks.createInkBoard.mockReset().mockImplementation(create);
  mocks.getInk.mockReset();
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.style.overflow = '';
});

describe('NotebookPage with the real InkWorkspace', () => {
  it.each(['paged', 'board'] as const)('creates, probes and opens %s full screen, flushes on return, then reopens the same VFS file', async (mode) => {
    mocks.getInk.mockImplementation(async ({ document_id }) => ({
      document_id, schema_version: mode === 'board' ? 2 : 1, title: '真实工作区',
    }));
    let hostState: NotebookHostState | null = null;
    const view = render(<NotebookPage onHostStateChange={(state) => { hostState = state; }} />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`notebook-create-${mode}`));
    const editor = await screen.findByTestId(`${mode}-editor`);
    expect(editor).toHaveAttribute('data-document-id', 'file_notebook');
    const workspace = screen.getByRole('dialog');
    expect(workspace).toHaveAttribute('data-ink-workspace-page', 'file_notebook');
    expect(workspace.parentElement?.parentElement).toBe(document.body);
    expect(view.container).not.toContainElement(workspace);
    expect(document.body.style.overflow).toBe('hidden');
    expect(mocks.getInk).toHaveBeenCalledWith({ document_id: 'file_notebook' });

    await waitFor(() => expect(hostState?.busy).toBe(false));
    expect(hostState?.writing).toBe(true);
    let dirty = true;
    let finishSave!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finishSave = () => { dirty = false; resolve(); }; }));
    disposers.push(registerInkEditorSession({
      key: { document_id: 'file_notebook', page_id: 'page-1' },
      isDirty: () => dirty, flush, persistDraft: async () => undefined,
    }));
    const writingState = hostState!;
    const saving = writingState.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    await act(async () => { finishSave(); });
    await expect(saving).resolves.toBe(true);
    expect(hostState).toBe(writingState);
    fireEvent.click(screen.getByRole('button', { name: '返回', exact: true }));
    expect(flush).toHaveBeenCalledTimes(2);
    expect(writingState.busy).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('notebook-library')).not.toBeInTheDocument();
    await act(async () => { finishSave(); });
    await screen.findByTestId('notebook-card-file_notebook');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(screen.getByTestId('notebook-card-file_notebook'));
    expect(await screen.findByTestId(`${mode}-editor`)).toHaveAttribute('data-document-id', 'file_notebook');
    expect(mode === 'board' ? mocks.createInkBoard : mocks.createInk).toHaveBeenCalledTimes(1);
    expect(mocks.getInk).toHaveBeenCalledTimes(2);
    disposers.splice(0).forEach((dispose) => dispose());
  });
});
