import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DstuNode } from '@/dstu';
import enLearningHub from '@/locales/en-US/learningHub.json';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';

const mocks = vi.hoisted(() => ({
  language: 'en-US' as 'en-US' | 'zh-CN',
  addTextbooks: vi.fn(),
  createAttachment: vi.fn(),
  createFromStagedUpload: vi.fn(),
  importMarkdownContent: vi.fn(),
  importMarkdownFiles: vi.fn(),
  stagePathUpload: vi.fn(),
  abortStagedUpload: vi.fn(async () => {}),
  notify: vi.fn(),
  dialogOpen: vi.fn(),
  pickWebViewFiles: vi.fn(),
}));

function lookupLocale(lang: 'en-US' | 'zh-CN', rawKey: string, opts?: Record<string, unknown>): string {
  const key = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : rawKey;
  const root: Record<string, unknown> = lang === 'zh-CN' ? zhLearningHub : enLearningHub;
  let cursor: unknown = root;
  for (const part of key.split('.')) {
    if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      cursor = undefined;
      break;
    }
  }
  let template = typeof cursor === 'string'
    ? cursor
    : (typeof opts?.defaultValue === 'string' ? opts.defaultValue : rawKey);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'defaultValue') continue;
      template = template.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  return template;
}

vi.mock('@/i18n', () => ({
  default: {
    get language() {
      return mocks.language;
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => lookupLocale(mocks.language, key, opts),
    i18n: {
      get language() {
        return mocks.language;
      },
    },
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mocks.dialogOpen(...args),
}));

vi.mock('@/utils/pickWebViewFiles', () => ({
  pickWebViewFiles: (...args: unknown[]) => mocks.pickWebViewFiles(...args),
}));

vi.mock('@/utils/platform', () => ({
  isAndroidMobileShell: () => false,
  isWebUiShell: () => true,
}));

vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({
  textbookDstuAdapter: {
    addTextbooks: (...args: unknown[]) => mocks.addTextbooks(...args),
  },
}));

vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({
  attachmentDstuAdapter: {
    create: (...args: unknown[]) => mocks.createAttachment(...args),
    createFromStagedUpload: (...args: unknown[]) => mocks.createFromStagedUpload(...args),
  },
}));

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: {
    importMarkdownContent: (...args: unknown[]) => mocks.importMarkdownContent(...args),
    importMarkdownFiles: (...args: unknown[]) => mocks.importMarkdownFiles(...args),
  },
}));

vi.mock('@/utils/stagedUpload', () => ({
  stagePathUpload: (...args: unknown[]) => mocks.stagePathUpload(...args),
  stageBlobUpload: vi.fn(async () => 'staged_blob_1'),
  abortStagedUpload: (...args: unknown[]) => mocks.abortStagedUpload(...args),
  createByteBudgetLimiter: () => <T,>(_size: number, task: () => Promise<T>) => task(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  mimeTypeFromFileName: (name: string) => {
    if (name.endsWith('.csv')) return 'text/csv';
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    return undefined;
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mocks.notify(...args),
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

vi.mock('@/features/learning-hub/textbookFileImport', () => ({
  canParseAsMobileTextbook: (ext: string) => !new Set(['xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'rtf']).has(ext),
  withStagedTextbookFile: async (file: File, run: (source: string) => Promise<unknown>) =>
    run(`dstu-staged:${file.name}`),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));
vi.mock('@/hooks/useMotionPresence', () => ({
  readCssDurationMs: () => 0,
  useMotionPresence: (open: boolean) => ({ mounted: open, shown: open, exiting: false }),
}));

import { importDroppedFiles, importPathsIntoLibrary } from '../importActions';
import { createResourceCreators } from '../resourceCreators';
import { useMarkdownNoteImport } from '../useMarkdownNoteImport';
import { FinderFileItem } from '../../components/finder/FinderFileItem';
import { FinderCreateMenuItems } from '../../components/finder/FinderQuickAccess';
import { AppMenu, AppMenuContent, AppMenuTrigger } from '@/components/ui/app-menu';

function makeNode(id: string, name: string, type: DstuNode['type']): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/${id}`,
    name,
    type,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeT() {
  return ((key: string, opts?: Record<string, unknown>) =>
    lookupLocale(mocks.language, key, opts)) as never;
}

describe('Wave-2C OOD fix: unified generic import, locale-clean errors, and Finder i18n key', () => {
  beforeEach(() => {
    mocks.language = 'en-US';
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

  it('mounts only a single unified file input in LearningHubSidebar (no permanent duplicate markdown input)', () => {
    const sidebarSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/learning-hub/LearningHubSidebar.tsx'),
      'utf8',
    );
    expect(sidebarSource).toContain('data-testid="finder-import-files-input"');
    expect(sidebarSource).not.toContain('finder-import-markdown-input');
    expect(sidebarSource).not.toContain('finderMarkdownInputRef');
  });

  it('routes mixed .pdf, .csv, .docx, .mp3, and .md files cleanly through unified importDroppedFiles', async () => {
    mocks.importMarkdownContent.mockResolvedValueOnce({
      ok: true,
      value: makeNode('note_md_1', 'lecture-notes', 'note'),
    });
    mocks.addTextbooks.mockResolvedValueOnce({
      ok: true,
      value: [makeNode('tb_pdf_1', 'syllabus.pdf', 'textbook')],
    });
    mocks.createAttachment
      .mockResolvedValueOnce({ ok: true, value: makeNode('file_csv_1', 'scores.csv', 'file') })
      .mockResolvedValueOnce({ ok: true, value: makeNode('file_docx_1', 'guide.docx', 'file') })
      .mockResolvedValueOnce({ ok: true, value: makeNode('file_mp3_1', 'lecture.mp3', 'file') });

    const t = makeT();
    const onOpenApp = vi.fn();
    const handleRefresh = vi.fn(async () => {});
    const { result: mdHook } = renderHook(() =>
      useMarkdownNoteImport({
        currentCreatableFolderId: 'fld_study',
        t,
        onOpenApp,
      }),
    );

    const pdf = new File([`%PDF-1.7\n${'0'.repeat(120)}\n%%EOF`], 'syllabus.pdf', { type: 'application/pdf' });
    const csv = new File(['student,score\nAda,99\n'], 'scores.csv', { type: 'text/csv' });
    const docx = new File(['PK\x03\x04docx-body'], 'guide.docx', { type: '' });
    const mp3 = new File(['ID3audio-bytes'], 'lecture.mp3', { type: '' });
    const md = new File(['# Week 1\n\nSummary'], 'lecture-notes.md', { type: 'text/markdown' });

    await importDroppedFiles(
      {
        pathsDropHandledRef: { current: false },
        currentPath: { viewKind: 'folder', folderId: 'fld_study', breadcrumbs: [], typeFilter: null } as never,
        t,
        importMarkdownFileObjects: mdHook.current.importMarkdownFileObjects,
        currentCreatableFolderId: 'fld_study',
        isMountedRef: { current: true },
        setAttachImportProgress: vi.fn(),
        handleRefresh,
        openImportedMarkdownNote: mdHook.current.openImportedMarkdownNote,
        onOpenApp,
      },
      [pdf, csv, docx, mp3, md],
      true,
    );

    expect(mocks.importMarkdownContent).toHaveBeenCalledWith('lecture-notes.md', '# Week 1\n\nSummary', 'fld_study');
    expect(mocks.addTextbooks).toHaveBeenCalledWith(['dstu-staged:syllabus.pdf'], 'fld_study');
    expect(mocks.createAttachment).toHaveBeenCalledTimes(3);
    expect(mocks.createAttachment).toHaveBeenNthCalledWith(1, csv, 'file', {
      folderId: 'fld_study',
      mimeType: 'text/csv',
    });
    expect(mocks.createAttachment).toHaveBeenNthCalledWith(2, docx, 'file', {
      folderId: 'fld_study',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(mocks.createAttachment).toHaveBeenNthCalledWith(3, mp3, 'file', {
      folderId: 'fld_study',
      mimeType: 'audio/mpeg',
    });
    expect(mocks.notify).toHaveBeenCalledWith('success', 'Imported 5 files');
    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });

  it('triggers unified web file input synchronously from New -> Import files… menu item without silently dropping selected .pdf/.csv files', async () => {
    const clickOrder: string[] = [];
    const importedBatches: File[][] = [];

    function Harness() {
      const inputRef = React.useRef<HTMLInputElement>(null);
      const [menuOpen, setMenuOpen] = React.useState(true);
      const isMountedRef = React.useRef(true);
      const creators = createResourceCreators({
        ensureCreatableView: () => true,
        currentCreatableFolderId: null,
        isMountedRef,
        t: makeT(),
        handleRefresh: async () => {},
        onOpenApp: undefined,
        setSelectedIds: vi.fn(),
        importProgress: { isImporting: false, fileName: '', stage: 'hashing', progress: 0 },
        importPaths: async () => {},
        importFiles: async () => {},
        openWebFileInput: () => {
          const input = inputRef.current;
          if (!input || !input.isConnected) return false;
          input.value = '';
          input.click();
          return true;
        },
      });

      return (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            data-testid="finder-import-files-input"
            onClick={(e) => {
              e.stopPropagation();
              clickOrder.push('input.click');
            }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              importedBatches.push(files);
            }}
          />
          <AppMenu
            open={menuOpen}
            onOpenChange={(next) => {
              if (!next) clickOrder.push('menu.close');
              setMenuOpen(next);
            }}
          >
            <AppMenuTrigger asChild>
              <button type="button">New</button>
            </AppMenuTrigger>
            <AppMenuContent>
              <FinderCreateMenuItems onNewTextbook={creators.handleNewTextbook} />
            </AppMenuContent>
          </AppMenu>
        </div>
      );
    }

    render(<Harness />);
    const menuItem = screen.getByRole('menuitem', { name: 'Import files…' });
    fireEvent.click(menuItem);

    // Input click must fire synchronously BEFORE AppMenu closes to preserve browser user activation
    expect(clickOrder).toEqual(['input.click', 'menu.close']);

    const input = screen.getByTestId('finder-import-files-input') as HTMLInputElement;
    const pdf = new File([`%PDF-1.7\n${'0'.repeat(120)}`], 'notes.pdf', { type: 'application/pdf' });
    const csv = new File(['k,v\n1,2\n'], 'metrics.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [pdf, csv] } });

    expect(importedBatches).toHaveLength(1);
    expect(importedBatches[0].map((f) => f.name)).toEqual(['notes.pdf', 'metrics.csv']);
  });

  it('reports descriptive localized unsupported-format errors without "Markdown 文件" or Chinese punctuation in en-US', async () => {
    mocks.language = 'en-US';
    const tEn = makeT();
    const { result: enHook } = renderHook(() =>
      useMarkdownNoteImport({
        currentCreatableFolderId: null,
        t: tEn,
        onOpenApp: undefined,
      }),
    );

    const pdf = new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' });
    const csv = new File(['a,b\n1,2'], 'table.csv', { type: 'text/csv' });

    const rejectedEn = await act(() => enHook.current.importMarkdownFileObjects([pdf, csv], null));
    expect(rejectedEn.importedNodes).toHaveLength(0);
    expect(rejectedEn.failedCount).toBe(2);
    expect(rejectedEn.firstError).toContain('Only Markdown (.md, .markdown)');
    expect(rejectedEn.firstError).not.toContain('Markdown 文件');
    expect(rejectedEn.firstError).not.toBe('Markdown Files');

    enHook.current.notifyMarkdownImportResult(
      rejectedEn.importedNodes.length,
      rejectedEn.failedCount,
      rejectedEn.failedFiles,
      rejectedEn.firstError,
    );
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const [enLevel, enMessage] = mocks.notify.mock.calls[0] as [string, string];
    expect(enLevel).toBe('error');
    expect(enMessage).toContain('; Failed files: paper.pdf, table.csv');
    expect(enMessage).not.toMatch(/[；、（）]/);

    // Also verify importDroppedFiles and importPathsIntoLibrary failure & guidance notifications are Chinese-free in en-US
    mocks.notify.mockReset();
    const emptyPdf = new File([], 'empty.pdf', { type: 'application/pdf' });
    const badPdf = new File(['not a pdf '.repeat(12)], 'broken.pdf', { type: 'application/pdf' });
    await importDroppedFiles(
      {
        pathsDropHandledRef: { current: false },
        currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
        t: tEn,
        importMarkdownFileObjects: enHook.current.importMarkdownFileObjects,
        currentCreatableFolderId: null,
        isMountedRef: { current: true },
        setAttachImportProgress: vi.fn(),
        handleRefresh: vi.fn(async () => {}),
        openImportedMarkdownNote: vi.fn(),
        onOpenApp: vi.fn(),
      },
      [emptyPdf, badPdf],
      true,
    );
    const [, dropTitle, dropDetail] = mocks.notify.mock.calls[0] as [string, string, string];
    expect(dropTitle).toBe('File import failed');
    expect(dropDetail).toBe(
      'Failed files: empty.pdf (Empty file (0 bytes)); broken.pdf (Corrupted or invalid PDF file)',
    );
    expect(dropDetail).not.toMatch(/[；、（）]/);

    mocks.notify.mockReset();
    await importPathsIntoLibrary(
      {
        importProgress: { isImporting: false },
        currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
        t: tEn,
        currentCreatableFolderId: null,
        importMarkdownPathNotes: vi.fn(),
        isMountedRef: { current: true },
        setImportProgress: vi.fn(),
        setAttachImportProgress: vi.fn(),
        handleRefresh: vi.fn(async () => {}),
        openImportedMarkdownNote: vi.fn(),
        onOpenApp: vi.fn(),
      },
      ['/tmp/deck-a.apkg', '/tmp/deck-b.apkg'],
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      'info',
      'deck-a.apkg, deck-b.apkg: import Anki deck packages in the Flashcards module',
    );
    expect((mocks.notify.mock.calls[0]?.[1] as string)).not.toMatch(/[；、（）]/);

    // Verify zh-CN retains proper Chinese punctuation
    mocks.notify.mockReset();
    mocks.language = 'zh-CN';
    const tZh = makeT();
    const { result: zhHook } = renderHook(() =>
      useMarkdownNoteImport({
        currentCreatableFolderId: null,
        t: tZh,
        onOpenApp: undefined,
      }),
    );
    const rejectedZh = await act(() => zhHook.current.importMarkdownFileObjects([pdf, csv], null));
    zhHook.current.notifyMarkdownImportResult(0, rejectedZh.failedCount, rejectedZh.failedFiles, rejectedZh.firstError);
    const [, zhMessage] = mocks.notify.mock.calls[0] as [string, string];
    expect(zhMessage).toContain('；失败文件：paper.pdf、table.csv');
  });

  it.each([
    ['en-US', 'list', 'New Folder'],
    ['en-US', 'grid', 'New Folder'],
    ['zh-CN', 'list', '新建文件夹'],
    ['zh-CN', 'grid', '新建文件夹'],
  ] as const)(
    'resolves FinderFileItem inline folder label without raw finder.create.newFolder key (%s, %s view)',
    (lang, viewMode, expectedLabel) => {
      mocks.language = lang;
      expect(enLearningHub.finder.create.newFolder).toBe('New Folder');
      expect(zhLearningHub.finder.create.newFolder).toBe('新建文件夹');

      const draftFolder: DstuNode = {
        id: '__pending_new_folder__1',
        sourceId: '__pending_new_folder__1',
        path: '',
        name: '',
        type: 'folder',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        childCount: 0,
      };

      render(
        <FinderFileItem
          item={draftFolder}
          viewMode={viewMode}
          isSelected={false}
          isEditing
          onSelect={vi.fn()}
          onOpen={vi.fn()}
          onContextMenu={vi.fn()}
          onEditConfirm={vi.fn()}
          onEditCancel={vi.fn()}
        />,
      );

      const input = screen.getByRole('textbox', { name: expectedLabel }) as HTMLInputElement;
      expect(input).toHaveAttribute('aria-label', expectedLabel);
      expect(input).toHaveAttribute('placeholder', expectedLabel);
      expect(input.getAttribute('aria-label')).not.toContain('finder.create.newFolder');
      expect(input.getAttribute('placeholder')).not.toContain('finder.create.newFolder');
    },
  );
});
