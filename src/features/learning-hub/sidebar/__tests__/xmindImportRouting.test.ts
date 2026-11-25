import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import enLearningHub from '@/locales/en-US/learningHub.json';

const mocks = vi.hoisted(() => ({
  dstuCreate: vi.fn(),
  readFileAsBytes: vi.fn(),
  readTextFile: vi.fn(),
  addTextbooks: vi.fn(),
  createAttachment: vi.fn(),
  createFromStagedUpload: vi.fn(),
  notify: vi.fn(),
  debugWarn: vi.fn(),
  debugError: vi.fn(),
  debugLog: vi.fn(),
}));

function lookupEn(rawKey: string, opts?: Record<string, unknown>): string {
  const key = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : rawKey;
  let cursor: unknown = enLearningHub;
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

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/i18n', () => ({
  default: {
    language: 'en-US',
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : key,
  },
}));

vi.mock('@/dstu', () => ({
  dstu: {
    create: (...args: unknown[]) => mocks.dstuCreate(...args),
  },
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    readFileAsBytes: (...args: unknown[]) => mocks.readFileAsBytes(...args),
  },
}));

vi.mock('@/utils/fileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/fileManager')>();
  return {
    ...actual,
    fileManager: {
      ...actual.fileManager,
      readTextFile: (...args: unknown[]) => mocks.readTextFile(...args),
    },
  };
});

vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({
  textbookDstuAdapter: { addTextbooks: (...args: unknown[]) => mocks.addTextbooks(...args) },
}));

vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({
  attachmentDstuAdapter: {
    create: (...args: unknown[]) => mocks.createAttachment(...args),
    createFromStagedUpload: (...args: unknown[]) => mocks.createFromStagedUpload(...args),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mocks.notify(...args),
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: (...args: unknown[]) => mocks.debugLog(...args),
    warn: (...args: unknown[]) => mocks.debugWarn(...args),
    error: (...args: unknown[]) => mocks.debugError(...args),
  },
}));

vi.mock('@/features/learning-hub/textbookFileImport', () => ({
  canParseAsMobileTextbook: () => true,
  withStagedTextbookFile: async (file: File, run: (source: string) => Promise<unknown>) =>
    run(`dstu-staged:${file.name}`),
}));

import { importDroppedFiles, importPathsIntoLibrary } from '../importActions';

async function buildXmindBytes(contentJson: unknown): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(contentJson));
  return zip.generateAsync({ type: 'uint8array' });
}

function makeMindmapNode(id: string, name: string): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/${id}`,
    name,
    type: 'mindmap',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const t = ((key: string, opts?: Record<string, unknown>) => lookupEn(key, opts)) as never;

describe('G24 .xmind / .mmap / .opml / .mm Resource Library import routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports .xmind directly via importDroppedFiles, persists as VFS mindmap, and opens it without guidance rejection', async () => {
    const bytes = await buildXmindBytes([
      {
        rootTopic: {
          id: 'r1',
          title: 'Organic Chemistry',
          notes: { plain: { content: 'Midterm outline' } },
          children: {
            attached: [
              { id: 'c1', title: 'Alkanes', markers: [{ markerId: 'task-done' }] },
              { id: 'c2', title: 'Alkenes', markers: [{ markerId: 'priority-1' }] },
            ],
          },
        },
      },
    ]);

    mocks.dstuCreate.mockResolvedValueOnce({
      ok: true,
      value: makeMindmapNode('mm_org_1', 'Organic Chemistry'),
    });

    const handleRefresh = vi.fn(async () => {});
    const onOpenApp = vi.fn();
    const xmindFile = new File([bytes as BlobPart], 'organic-chem.xmind', { type: '' });

    await importDroppedFiles(
      {
        pathsDropHandledRef: { current: false },
        currentPath: { viewKind: 'folder', folderId: 'fld_chem', breadcrumbs: [], typeFilter: null } as never,
        t,
        importMarkdownFileObjects: vi.fn(),
        currentCreatableFolderId: 'fld_chem',
        isMountedRef: { current: true },
        setAttachImportProgress: vi.fn(),
        handleRefresh,
        openImportedMarkdownNote: vi.fn(),
        onOpenApp,
      },
      [xmindFile],
      true,
    );

    expect(mocks.dstuCreate).toHaveBeenCalledTimes(1);
    const [pathArg, optionsArg] = mocks.dstuCreate.mock.calls[0] as [
      string,
      { type: string; name: string; content: string; metadata: Record<string, unknown> },
    ];
    expect(pathArg).toBe('/');
    expect(optionsArg.type).toBe('mindmap');
    expect(optionsArg.name).toBe('Organic Chemistry');
    expect(optionsArg.metadata).toEqual({ folderId: 'fld_chem', defaultView: 'mindmap' });

    const parsedDoc = JSON.parse(optionsArg.content) as {
      version: string;
      root: { id: string; text: string; note?: string; children: Array<{ text: string; completed?: boolean; priority?: number }> };
    };
    expect(parsedDoc.version).toBe('1.0');
    expect(parsedDoc.root.id).toBe('root');
    expect(parsedDoc.root.text).toBe('Organic Chemistry');
    expect(parsedDoc.root.note).toBe('Midterm outline');
    expect(parsedDoc.root.children).toMatchObject([
      { text: 'Alkanes', completed: true },
      { text: 'Alkenes', priority: 1 },
    ]);

    // Must NOT emit guidanceMindmap info rejection
    expect(mocks.notify).not.toHaveBeenCalledWith('info', expect.stringContaining('Mind Map module'));
    expect(mocks.notify).toHaveBeenCalledWith('success', 'Imported 1 files');
    expect(handleRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mm_org_1',
        title: 'Organic Chemistry',
        type: 'mindmap',
        previewType: 'mindmap',
      }),
    );
  });

  it('imports .xmind and .opml directly via importPathsIntoLibrary and opens the imported mindmap', async () => {
    const xmindBytes = await buildXmindBytes([
      {
        rootTopic: {
          id: 'xroot',
          title: 'Linear Algebra',
          children: { attached: [{ id: 'ev', title: 'Eigenvalues' }] },
        },
      },
    ]);
    const opmlText = `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0">
        <head><title>Calculus</title></head>
        <body><outline text="Derivatives"><outline text="Chain Rule" /></outline></body>
      </opml>`;

    mocks.readFileAsBytes.mockResolvedValueOnce(xmindBytes);
    mocks.readTextFile.mockResolvedValueOnce(opmlText);
    mocks.dstuCreate.mockImplementation(async (_parentPath: string, opts: { name: string }) => {
      const id = opts.name === 'Linear Algebra' ? 'mm_la' : 'mm_calc';
      return { ok: true, value: makeMindmapNode(id, opts.name) };
    });

    const handleRefresh = vi.fn(async () => {});
    const onOpenApp = vi.fn();

    await importPathsIntoLibrary(
      {
        importProgress: { isImporting: false },
        currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
        t,
        currentCreatableFolderId: null,
        importMarkdownPathNotes: vi.fn(),
        isMountedRef: { current: true },
        setImportProgress: vi.fn(),
        setAttachImportProgress: vi.fn(),
        handleRefresh,
        openImportedMarkdownNote: vi.fn(),
        onOpenApp,
      },
      ['/tmp/linear-algebra.xmind', '/tmp/calculus.opml'],
    );

    expect(mocks.dstuCreate).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledWith('success', 'Imported 2 files', undefined);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mm_la', type: 'mindmap', previewType: 'mindmap' }),
    );
  });

  it('reports localized error gracefully for truncated/corrupt .xmind without console.error', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const corruptFile = new File([truncated], 'broken.xmind', { type: '' });

    await importDroppedFiles(
      {
        pathsDropHandledRef: { current: false },
        currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
        t,
        importMarkdownFileObjects: vi.fn(),
        currentCreatableFolderId: null,
        isMountedRef: { current: true },
        setAttachImportProgress: vi.fn(),
        handleRefresh: vi.fn(async () => {}),
        openImportedMarkdownNote: vi.fn(),
        onOpenApp: vi.fn(),
      },
      [corruptFile],
      true,
    );

    expect(mocks.dstuCreate).not.toHaveBeenCalled();
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      'error',
      'File import failed',
      'Failed files: broken.xmind (Invalid or corrupted mind map file)',
    );
    consoleErrSpy.mockRestore();
  });
});
