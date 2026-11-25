import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import enLearningHub from '@/locales/en-US/learningHub.json';

const mocks = vi.hoisted(() => ({
  permanentlyDelete: vi.fn(),
  emptyTrash: vi.fn(),
  exportFormats: vi.fn(),
  exportResource: vi.fn(),
  saveTextFile: vi.fn(),
  saveFromSource: vi.fn(),
  pruneShortcuts: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/dstu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dstu')>();
  return {
    ...actual,
    dstu: {
      ...actual.dstu,
      exportFormats: (...args: unknown[]) => mocks.exportFormats(...args),
      exportResource: (...args: unknown[]) => mocks.exportResource(...args),
    },
    trashApi: {
      ...actual.trashApi,
      permanentlyDelete: (...args: unknown[]) => mocks.permanentlyDelete(...args),
      emptyTrash: (...args: unknown[]) => mocks.emptyTrash(...args),
    },
  };
});

vi.mock('@/utils/fileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/fileManager')>();
  return {
    ...actual,
    fileManager: {
      ...actual.fileManager,
      saveTextFile: (...args: unknown[]) => mocks.saveTextFile(...args),
      saveFromSource: (...args: unknown[]) => mocks.saveFromSource(...args),
    },
  };
});

vi.mock('@/features/workbench/agent/drivers/noteDriver', () => ({
  getNoteEditor: () => undefined,
}));

vi.mock('../../stores/desktopStore', () => {
  const state = {
    pruneShortcutsForTargets: (...args: unknown[]) => mocks.pruneShortcuts(...args),
    addResourceShortcut: vi.fn(),
    addFolderShortcut: vi.fn(),
    hasResourceShortcut: () => false,
    hasFolderShortcut: () => false,
  };
  const hook = <T,>(selector?: (s: typeof state) => T) => (selector ? selector(state) : state);
  hook.getState = () => state;
  return { useDesktopStore: hook };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mocks.notify(...args),
}));

import '@/i18n';
import { FinderBatchToolbar } from '../../components/finder/FinderBatchToolbar';
import { InlineEditText } from '../../components/InlineEditText';
import { LearningHubContextMenu } from '../../components/LearningHubContextMenu';
import { permanentlyDeleteTrashItem, emptyTrashBin } from '../trashActions';
import { exportResourceById } from '../../utils/exportResource';

describe('S1-01(b) Finder visible Rename entry & inline rename menu-blur protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps zh-CN and en-US contextMenu.rename keys symmetric and renders visible Rename button in FinderBatchToolbar only for single non-trash selection', () => {
    expect(zhLearningHub.contextMenu.rename).toBe('重命名');
    expect(enLearningHub.contextMenu.rename).toBe('Rename');

    const onRenameSelected = vi.fn();
    const baseProps = {
      totalCount: 3,
      onSelectAll: vi.fn(),
      onClearSelection: vi.fn(),
      onOpenSelected: vi.fn(),
      onQuickLookSelected: vi.fn(),
      onRenameSelected,
      onBatchMove: vi.fn(),
      onBatchDelete: vi.fn(),
    };

    const { rerender } = render(<FinderBatchToolbar {...baseProps} selectedCount={1} />);
    const renameBtn = screen.getByTestId('finder-toolbar-rename');
    expect(renameBtn).toBeVisible();
    expect(renameBtn).toHaveTextContent(/重命名|Rename/);
    fireEvent.click(renameBtn);
    expect(onRenameSelected).toHaveBeenCalledTimes(1);

    // Multi-selection hides single-item Rename button
    rerender(<FinderBatchToolbar {...baseProps} selectedCount={2} />);
    expect(screen.queryByTestId('finder-toolbar-rename')).not.toBeInTheDocument();

    // Trash view hides Rename button
    rerender(<FinderBatchToolbar {...baseProps} selectedCount={1} isTrashView />);
    expect(screen.queryByTestId('finder-toolbar-rename')).not.toBeInTheDocument();
  });

  it('exposes visible Rename item in LearningHubContextMenu for both folders and resources and invokes rename handler', () => {
    const onRenameResource = vi.fn();
    const onRenameFolder = vi.fn();
    const sampleResource = {
      id: 'file_1',
      type: 'file' as const,
      title: '01-study-guide.docx',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const { rerender } = render(
      <LearningHubContextMenu
        open
        onOpenChange={vi.fn()}
        position={{ x: 80, y: 80 }}
        target={{ type: 'resource', resource: sampleResource }}
        dataView="folder"
        onRenameResource={onRenameResource}
      />,
    );

    const resourceRenameItem = screen.getByRole('menuitem', { name: /重命名|Rename/ });
    expect(resourceRenameItem).toBeVisible();
    fireEvent.click(resourceRenameItem);
    expect(onRenameResource).toHaveBeenCalledWith(sampleResource);

    rerender(
      <LearningHubContextMenu
        open
        onOpenChange={vi.fn()}
        position={{ x: 80, y: 80 }}
        target={{
          type: 'folder',
          folder: {
            folder: { id: 'fld_1', title: 'Course Docs', parentId: null, sortOrder: 0, createdAt: '', updatedAt: '' },
            children: [],
            items: [],
            itemCount: 0,
          },
        }}
        dataView="folder"
        onRenameFolder={onRenameFolder}
      />,
    );

    const folderRenameItem = screen.getByRole('menuitem', { name: /重命名|Rename/ });
    expect(folderRenameItem).toBeVisible();
    fireEvent.click(folderRenameItem);
    expect(onRenameFolder).toHaveBeenCalledWith('fld_1');
  });

  it('prevents premature menu-close blur from auto-canceling InlineEditText on existing non-empty filenames', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <InlineEditText
        value="01-study-guide.docx"
        isEditing
        onConfirm={onConfirm}
        onCancel={onCancel}
        ariaLabel="Rename item"
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Rename item' }) as HTMLInputElement;

    // Immediate blur within <250ms before user edits (simulating context menu close focus-return)
    fireEvent.blur(input);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // User types new name and presses Enter
    fireEvent.change(input, { target: { value: '01-renamed-guide.docx' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('01-renamed-guide.docx');
  });
});

describe('S5-14 export & permanent delete verifiable toast receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits explicit success toast receipt on note/resource export even when browser download returns empty path or web-exports staging path', async () => {
    mocks.exportFormats.mockResolvedValue({ ok: true, value: ['markdown'] });
    mocks.exportResource.mockResolvedValue({
      ok: true,
      value: {
        payloadType: 'text',
        content: '# Study Note\n\nBody',
        suggestedFilename: 'Study-Note.md',
      },
    });
    // Browser / SAF download without OS path
    mocks.saveTextFile.mockResolvedValueOnce({ canceled: false, path: '' });

    const t = ((key: string, opts?: { path?: string; defaultValue?: string }) =>
      opts?.defaultValue ?? `${key}:${opts?.path ?? ''}`) as never;

    const ok1 = await exportResourceById('note_abc', t);
    expect(ok1).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith('success', '已导出到: Study-Note.md');

    // WebUI saveFromSource returning internal /web-exports/<uuid>/ path strips to clean filename
    mocks.notify.mockClear();
    mocks.exportFormats.mockResolvedValue({ ok: true, value: ['original'] });
    mocks.exportResource.mockResolvedValue({
      ok: true,
      value: {
        payloadType: 'file',
        tempPath: '/tmp/src.docx',
        suggestedFilename: '01-study-guide.docx',
      },
    });
    mocks.saveFromSource.mockResolvedValueOnce({
      canceled: false,
      path: '/var/data/web-exports/9f8e7d/01-study-guide.docx',
    });

    const ok2 = await exportResourceById('file_doc1', t);
    expect(ok2).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith('success', '已导出到: 01-study-guide.docx');
  });

  it('emits explicit permanent delete and empty trash toast receipts even if trash view unmounts immediately', async () => {
    mocks.permanentlyDelete.mockResolvedValueOnce({ ok: true, value: undefined });
    mocks.emptyTrash.mockResolvedValueOnce({ ok: true, value: 3 });

    const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as never;

    await permanentlyDeleteTrashItem(
      {
        isMountedRef: { current: false },
        t,
        handleRefresh: vi.fn(async () => {}),
      },
      'note_del_1',
      'note',
    );
    expect(mocks.notify).toHaveBeenCalledWith('success', '已永久删除');

    mocks.notify.mockClear();
    await emptyTrashBin({
      isMountedRef: { current: false },
      softDeleteUndoGenRef: { current: 0 },
      isTrashView: true,
      items: [],
      t,
      handleRefresh: vi.fn(async () => {}),
    });
    await waitFor(() => {
      expect(mocks.notify).toHaveBeenCalledWith('success', '回收站已清空 (3)');
    });
  });
});
