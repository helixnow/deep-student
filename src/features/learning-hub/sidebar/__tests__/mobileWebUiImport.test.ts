import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dialogOpenMock, pickWebViewFilesMock, isAndroidMobileShellMock, isWebUiShellMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  pickWebViewFilesMock: vi.fn(),
  isAndroidMobileShellMock: vi.fn(() => false),
  isWebUiShellMock: vi.fn(() => false),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpenMock }));
vi.mock('@/utils/pickWebViewFiles', () => ({ pickWebViewFiles: pickWebViewFilesMock }));
vi.mock('@/utils/platform', () => ({
  isAndroidMobileShell: isAndroidMobileShellMock,
  isWebUiShell: isWebUiShellMock,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { error: vi.fn(), warn: vi.fn(), log: vi.fn() } }));

import { createResourceCreators } from '../resourceCreators';
import { importMarkdownNoteFromDialog } from '../useMarkdownNoteImport';

const t = ((key: string) => key) as never;

describe('WebUI / mobile browser file picker routing', () => {
  beforeEach(() => {
    dialogOpenMock.mockReset();
    pickWebViewFilesMock.mockReset();
    isAndroidMobileShellMock.mockReturnValue(false);
    isWebUiShellMock.mockReturnValue(false);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('routes handleNewTextbook through pickWebViewFiles in WebUI even when __TAURI_INTERNALS__ proxy exists', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    isWebUiShellMock.mockReturnValue(true);
    const file = new File(['pdf'], 'book.pdf', { type: 'application/pdf' });
    pickWebViewFilesMock.mockResolvedValueOnce([file]);
    const importFiles = vi.fn(async () => {});
    const importPaths = vi.fn(async () => {});

    const creators = createResourceCreators({
      ensureCreatableView: () => true,
      currentCreatableFolderId: null,
      isMountedRef: { current: true },
      t,
      handleRefresh: async () => {},
      onOpenApp: undefined,
      setSelectedIds: vi.fn(),
      importProgress: { isImporting: false, current: 0, total: 0, currentFileName: '', phase: 'idle' } as never,
      importPaths,
      importFiles,
    });

    await creators.handleNewTextbook();

    expect(pickWebViewFilesMock).toHaveBeenCalledWith(true);
    expect(importFiles).toHaveBeenCalledWith([file]);
    expect(dialogOpenMock).not.toHaveBeenCalled();
    expect(importPaths).not.toHaveBeenCalled();
  });

  it('routes importMarkdownNoteFromDialog through pickWebViewFiles in non-Tauri browser & WebUI', async () => {
    const file = new File(['# Note'], 'note.md', { type: 'text/markdown' });
    pickWebViewFilesMock.mockResolvedValueOnce([file]);
    const importMarkdownFileObjects = vi.fn(async () => ({
      importedNodes: [{ id: 'note_1' } as never],
      failedCount: 0,
      firstError: null,
      failedFiles: [],
    }));
    const importMarkdownPathNotes = vi.fn();

    await importMarkdownNoteFromDialog({
      ensureCreatableView: () => true,
      t,
      importMarkdownPathNotes,
      importMarkdownFileObjects,
      isMountedRef: { current: true },
      handleRefresh: async () => {},
      openImportedMarkdownNote: vi.fn(),
      notifyMarkdownImportResult: vi.fn(),
    }, 'folder_1');

    expect(pickWebViewFilesMock).toHaveBeenCalledWith(true);
    expect(importMarkdownFileObjects).toHaveBeenCalledWith([file], 'folder_1');
    expect(dialogOpenMock).not.toHaveBeenCalled();
    expect(importMarkdownPathNotes).not.toHaveBeenCalled();
  });

  it('uses native dialogOpen on desktop Tauri runtime', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    dialogOpenMock.mockResolvedValueOnce(['/tmp/sample.pdf']);
    const importPaths = vi.fn(async () => {});

    const creators = createResourceCreators({
      ensureCreatableView: () => true,
      currentCreatableFolderId: null,
      isMountedRef: { current: true },
      t,
      handleRefresh: async () => {},
      onOpenApp: undefined,
      setSelectedIds: vi.fn(),
      importProgress: { isImporting: false, current: 0, total: 0, currentFileName: '', phase: 'idle' } as never,
      importPaths,
      importFiles: vi.fn(async () => {}),
    });

    await creators.handleNewTextbook();

    expect(dialogOpenMock).toHaveBeenCalledTimes(1);
    expect(importPaths).toHaveBeenCalledWith(['/tmp/sample.pdf']);
    expect(pickWebViewFilesMock).not.toHaveBeenCalled();
  });
});
