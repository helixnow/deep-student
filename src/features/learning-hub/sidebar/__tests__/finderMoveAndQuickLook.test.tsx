import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DstuNode } from '@/dstu';

const { getFolderTreeMock, dstuGetMock, dstuGetContentMock, getResourceLocationMock, getBreadcrumbsMock } = vi.hoisted(() => ({
  getFolderTreeMock: vi.fn(),
  dstuGetMock: vi.fn(),
  dstuGetContentMock: vi.fn(),
  getResourceLocationMock: vi.fn(),
  getBreadcrumbsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) => {
      if (typeof opts === 'string') return opts;
      if (key.includes('folder.root')) return '根目录';
      if (key.includes('folderPicker.confirm') || key.includes('moveHere')) return '移动到此处';
      if (key.includes('cancel')) return '取消';
      if (key.includes('selectedTarget')) return '当前目标：';
      return opts?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: dstuGetMock,
    getContent: dstuGetContentMock,
  },
  folderApi: {
    getFolderTree: getFolderTreeMock,
    getBreadcrumbs: getBreadcrumbsMock,
  },
  pathApi: {
    getResourceLocation: getResourceLocationMock,
  },
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DsDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DsDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));

vi.mock('@/hooks/useMotionPresence', () => ({
  readCssDurationMs: () => 0,
  useMotionPresence: (open: boolean) => ({ mounted: open, state: open ? 'entered' : 'exited' }),
}));

vi.mock('@/components/layout', () => ({
  useMobileSubviewChrome: () => false,
}));

import { FinderMoveFolderDialog } from '../FinderMoveFolderDialog';
import { enrichQuickLookNode } from '../quickLookEnricher';

describe('S1-01(b)/(c) FinderMoveFolderDialog and quickLookEnricher', () => {
  beforeEach(() => {
    getFolderTreeMock.mockReset();
    dstuGetMock.mockReset();
    dstuGetContentMock.mockReset();
    getResourceLocationMock.mockReset();
    getBreadcrumbsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders root and folders as selectable buttons with aria-selected and updates selected destination', async () => {
    getFolderTreeMock.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          folder: { id: 'fld_math', title: '高数笔记' },
          children: [{ folder: { id: 'fld_sub', title: '微积分' }, children: [] }],
        },
      ],
    });
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <FinderMoveFolderDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        title="移动到…"
      />,
    );

    const rootBtn = await screen.findByRole('button', { name: '根目录' });
    const mathBtn = screen.getByRole('button', { name: '高数笔记' });
    const subBtn = screen.getByRole('button', { name: '微积分' });

    expect(rootBtn).toHaveAttribute('aria-selected', 'true');
    expect(mathBtn).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('finder-move-selected-destination')).toHaveTextContent('根目录');

    fireEvent.click(subBtn);
    expect(subBtn).toHaveAttribute('aria-selected', 'true');
    expect(rootBtn).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('finder-move-selected-destination')).toHaveTextContent('微积分');

    fireEvent.click(screen.getByRole('button', { name: '移动到此处' }));
    expect(onConfirm).toHaveBeenCalledWith('fld_sub');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('enriches QuickLook note with body preview, UTF-8 byte size, and human-readable folder path', async () => {
    const rawNote: DstuNode = {
      id: 'note_abc',
      sourceId: 'note_abc',
      path: '/note_abc',
      name: '线性代数要点',
      type: 'note',
      createdAt: 1,
      updatedAt: 2,
    };
    dstuGetMock.mockResolvedValueOnce({ ok: true, value: rawNote });
    dstuGetContentMock.mockResolvedValueOnce({ ok: true, value: '特征值与特征向量是矩阵分解的核心。' });
    getResourceLocationMock.mockResolvedValueOnce({ folderId: 'fld_1', folderPath: '/数学' });
    getBreadcrumbsMock.mockResolvedValueOnce({ ok: true, value: [{ id: 'fld_1', name: '数学' }] });

    const enriched = await enrichQuickLookNode(rawNote, {
      currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
      t: ((_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '根目录') as never,
    });

    expect(enriched.path).toBe('/根目录/数学/线性代数要点');
    expect(enriched.size).toBeGreaterThan(0);
    expect(enriched.metadata?.contentPreview).toBe('特征值与特征向量是矩阵分解的核心。');
  });
});
