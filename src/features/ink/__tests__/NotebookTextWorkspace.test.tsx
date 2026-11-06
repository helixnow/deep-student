import React, { useContext, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { NoteContentViewProps } from '@/features/learning-hub';
import { NotesChromeSlotContext } from '@/features/notes';
import { useMobileSubviewChrome } from '@/components/layout/MobileSubviewChromeContext';

const editorState = vi.hoisted(() => ({
  active: [] as boolean[],
  nodes: [] as DstuNode[],
  chromeSlots: [] as Array<HTMLElement | null>,
  subview: false,
  closeSubview: vi.fn(),
}));
vi.mock('@/features/learning-hub', () => ({
  LazyNoteContentView: function MockNoteContentView({ node, isActive = false, onTitleChange }: NoteContentViewProps) {
    editorState.active.push(isActive);
    editorState.nodes.push(node);
    editorState.chromeSlots.push(useContext(NotesChromeSlotContext));
    useMobileSubviewChrome({ title: '笔记属性', onBack: editorState.closeSubview }, [], editorState.subview && isActive);
    useEffect(() => { onTitleChange?.('编辑后的标题'); }, [onTitleChange]);
    return <div data-testid="existing-text-editor">Existing text editor</div>;
  },
}));

vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@/locales/zh-CN/ink.json');
  const translate = (key: string) => {
    let result: unknown = locale;
    for (const part of key.split('.')) result = (result as Record<string, unknown>)?.[part];
    return String(result ?? key);
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({ t: translate }),
  };
});

import NotebookTextWorkspace from '../NotebookTextWorkspace';
import {
  registerContentDirtyChecker as registerDirtyChecker,
  registerContentSaveHandler as registerSaveHandler,
} from '@/services/contentDirtyRegistry';

const unregisters: Array<() => void> = [];
const registerContentDirtyChecker = (...args: Parameters<typeof registerDirtyChecker>) => {
  unregisters.push(registerDirtyChecker(...args));
};
const registerContentSaveHandler = (...args: Parameters<typeof registerSaveHandler>) => {
  unregisters.push(registerSaveHandler(...args));
};

const node: DstuNode = {
  id: 'note_existing', sourceId: 'note_existing', path: '/课程/note_existing',
  name: '原有笔记', type: 'note', createdAt: 1, updatedAt: 2,
};

beforeEach(() => {
  editorState.active.length = 0;
  editorState.nodes.length = 0;
  editorState.chromeSlots.length = 0;
  editorState.subview = false;
  editorState.closeSubview.mockReset();
});
afterEach(() => { unregisters.splice(0).reverse().forEach((unregister) => unregister()); });

describe('NotebookTextWorkspace existing editor boundary', () => {
  it('opens full-screen in a body portal, forwards the original note, and returns clean notes without recreating them', async () => {
    const onClose = vi.fn();
    const view = render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    const workspace = screen.getByTestId('notebook-text-workspace');
    expect(workspace.parentElement).toBe(document.body);
    expect(workspace).toHaveAttribute('role', 'dialog');
    expect(view.container).not.toContainElement(workspace);
    expect(editorState.nodes.at(-1)).toBe(node);
    expect(editorState.chromeSlots.at(-1)).toBe(workspace.querySelector('.notebook-writing-actions'));
    expect(screen.getByRole('heading', { name: '编辑后的标题' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('waits for the actual registered note save before returning, prevents concurrent closes, and keeps failures open for retry', async () => {
    let dirty = true;
    let finish!: () => void;
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = () => { dirty = false; resolve(); };
    }));
    registerContentDirtyChecker('note', node.id, () => dirty);
    registerContentSaveHandler('note', node.id, save);
    const onClose = vi.fn();
    render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('笔记尚未安全保存');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByRole('button', { name: '返回笔记库' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('does not close dirty notes without a save capability, or when a save resolves but the note is still dirty', async () => {
    registerContentDirtyChecker('note', node.id, () => true);
    const onClose = vi.fn();
    render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    await screen.findByRole('alert');
    const save = vi.fn(async () => undefined);
    registerContentSaveHandler('note', node.id, save);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('forwards inactive state, hides portal interaction, releases mobile toolbar ownership, and does not close in the background', async () => {
    const onClose = vi.fn();
    const view = render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    expect(document.body.dataset.notebookTextEditor).toBeDefined();
    view.rerender(<NotebookTextWorkspace node={node} isActive={false} onClose={onClose} />);
    expect(screen.getByTestId('notebook-text-workspace')).toHaveAttribute('hidden');
    expect(editorState.active.at(-1)).toBe(false);
    expect(document.body.dataset.notebookTextEditor).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库', hidden: true }));
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not navigate away when a close-save finishes after the page becomes inactive', async () => {
    let dirty = true;
    let finish!: () => void;
    registerContentDirtyChecker('note', node.id, () => dirty);
    registerContentSaveHandler('note', node.id, () => new Promise<void>((resolve) => {
      finish = () => { dirty = false; resolve(); };
    }));
    const onClose = vi.fn();
    const view = render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    view.rerender(<NotebookTextWorkspace node={node} isActive={false} onClose={onClose} />);
    await act(async () => { finish(); });
    expect(onClose).not.toHaveBeenCalled();
    view.rerender(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '返回笔记库' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('hosts the existing mobile properties subview in the one writing header and routes its back action before leaving the note', async () => {
    editorState.subview = true;
    const onClose = vi.fn();
    render(<NotebookTextWorkspace node={node} isActive onClose={onClose} />);
    expect(await screen.findByRole('heading', { name: '笔记属性' })).toBeInTheDocument();
    expect(document.querySelectorAll('.notebook-writing-header')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '返回笔记', exact: true }));
    expect(editorState.closeSubview).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
