import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

// Capture DndContext handlers to drive deterministic dragStart -> dragOver -> cancel flows
// alongside real MouseSensor tests.
const capturedDndProps: {
  onDragStart?: (event: unknown) => void;
  onDragOver?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void;
  onDragCancel?: (event: unknown) => void;
} = {};

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      capturedDndProps.onDragStart = props.onDragStart as (event: unknown) => void;
      capturedDndProps.onDragOver = props.onDragOver as (event: unknown) => void;
      capturedDndProps.onDragEnd = props.onDragEnd as (event: unknown) => void;
      capturedDndProps.onDragCancel = props.onDragCancel as (event: unknown) => void;
      return <actual.DndContext {...props} />;
    },
  };
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * estimateSize(),
        size: estimateSize(),
      })),
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
    scrollOffset: 0,
  }),
}));

vi.mock('@/i18n', () => ({ default: { language: 'zh-CN' } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; query?: string }) => {
      const map: Record<string, string> = {
        'common:delete_permanently': '彻底删除',
        'common:cancel': '取消',
        'common:close': '关闭',
        'common:back': '返回',
        'common:more': '更多',
        'folder.root': '学习资源',
        'finder.toolbar.new': '新建',
        'finder.toolbar.newFolder': '新建文件夹',
        'finder.toolbar.newTextbook': '导入资料…',
        'finder.toolbar.back': '返回',
        'finder.toolbar.forward': '前进',
        'finder.toolbar.more': '更多',
        'finder.search.placeholder': '搜索',
        'finder.search.placeholderDisabled': '搜索不可用',
        'finder.dragDrop.overlayText': '拖放目标',
        'finder.folderPicker.title': '移动到文件夹',
        'finder.folderPicker.root': '根目录',
        'finder.folderPicker.confirm': '移动到此处',
        'finder.quickLook.title': '快速预览',
        'finder.quickLook.sizeLabel': '大小',
        'finder.quickLook.updatedLabel': '修改时间',
        'finder.quickLook.pathLabel': '路径',
        'finder.quickLook.closeHint': '按 Esc 关闭',
        'finder.quickLook.open': '打开',
        'finder.contextMenu.restore': '恢复',
        'learningHub:finder.contextMenu.restore': '恢复',
        'finder.trash.confirmPermanentDelete': '确认彻底删除此项目？',
        'learningHub:finder.trash.confirmPermanentDelete': '确认彻底删除此项目？',
        'finder.empty.searchNoResults': `未找到「${opts?.query ?? ''}」`,
        'finder.empty.searchHint': '请尝试其他关键词',
      };
      return map[key] ?? opts?.defaultValue ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  useIsMobile: () => false,
}));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));
vi.mock('@/components/layout', () => ({
  useMobileSubviewChrome: () => false,
}));
vi.mock('@/dstu', () => ({
  folderApi: {
    getFolderTree: vi.fn(),
  },
}));

import { folderApi } from '@/dstu';
import { FinderFileList } from '../FinderFileList';
import { FinderFileItem } from '../FinderFileItem';
import { FinderToolbar } from '../FinderToolbar';
import { FolderPickerDialog } from '../FolderPickerDialog';
import { FinderQuickLook } from '../FinderQuickLook';

const ADVERSARIAL_80_TITLE =
  '量子力学笔记<script>window.__finderXss=1</script>[2026/05]#重点?a=1&b=2🚀📚🎉_NoSpaceToken_88.md';

const sampleItems: DstuNode[] = [
  {
    id: 'folder_target',
    sourceId: 'folder_target',
    path: '/folder_target',
    name: '目标文件夹',
    type: 'folder',
    childCount: 2,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 60_000,
  },
  {
    id: 'file_dragged',
    sourceId: 'file_dragged',
    path: '/file_dragged',
    name: 'notes.md',
    type: 'note',
    size: 1024,
    createdAt: Date.now() - 100_000,
    updatedAt: Date.now() - 30_000,
  },
];

describe('Finder drag-cancel ghost drop-indicator cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    capturedDndProps.onDragStart = undefined;
    capturedDndProps.onDragOver = undefined;
    capturedDndProps.onDragEnd = undefined;
    capturedDndProps.onDragCancel = undefined;
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    cleanup();
  });

  it.each(['list', 'grid'] as const)(
    'resets all drop-target borders, spring-load pulse, drop bar and timers on Escape (even without code="Escape"), window blur, and dragend in %s view',
    (viewMode) => {
      const onMoveItem = vi.fn();
      const onOpen = vi.fn();

      const { container } = render(
        <FinderFileList
          items={sampleItems}
          viewMode={viewMode}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          onOpen={onOpen}
          onContextMenu={vi.fn()}
          onMoveItem={onMoveItem}
          parentDropTargets={[{ id: null, label: '学习资源' }]}
          specialDropTargets={[{ id: 'trash', label: '回收站' }]}
          isLoading={false}
          error={null}
        />,
      );

      const getFolderRow = () =>
        container.querySelector<HTMLElement>('[data-item-id="folder_target"] > div');

      const startHoverOverFolder = () => {
        act(() => {
          capturedDndProps.onDragStart?.({ active: { id: 'file_dragged' } });
          capturedDndProps.onDragOver?.({
            active: { id: 'file_dragged' },
            over: { id: 'folder_target', data: { current: { type: 'folder', itemId: 'folder_target' } } },
          });
        });
        expect(getFolderRow()).toHaveAttribute('data-drop-target', 'true');
        expect(getFolderRow()?.className).toContain('outline-primary');
        expect(container.querySelector('[data-finder-drag-drop-bar]')).not.toBeNull();
      };

      // 1. Escape with empty code (remapped/synthetic key='Escape') must clear all ghost drop states
      startHoverOverFolder();
      fireEvent.keyDown(document, { key: 'Escape', code: '' });
      expect(getFolderRow()).not.toHaveAttribute('data-drop-target');
      expect(getFolderRow()).not.toHaveAttribute('data-spring-loading');
      expect(getFolderRow()?.className).not.toContain('outline-primary');
      expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();

      // Advance past SPRING_LOAD_MS (800ms): cancelled drag must NOT spring-open the folder
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onOpen).not.toHaveBeenCalled();
      expect(onMoveItem).not.toHaveBeenCalled();

      // 2. Window blur (Alt-Tab / pointer leaves window and focus lost) clears all drop highlights
      startHoverOverFolder();
      fireEvent.blur(window);
      expect(getFolderRow()).not.toHaveAttribute('data-drop-target');
      expect(getFolderRow()?.className).not.toContain('outline-primary');
      expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onOpen).not.toHaveBeenCalled();

      // 3. Window dragend clears all drop highlights
      startHoverOverFolder();
      act(() => {
        window.dispatchEvent(new Event('dragend'));
      });
      expect(getFolderRow()).not.toHaveAttribute('data-drop-target');
      expect(getFolderRow()?.className).not.toContain('outline-primary');
      expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();

      // 4. pointercancel clears all drop highlights
      startHoverOverFolder();
      act(() => {
        window.dispatchEvent(new Event('pointercancel'));
      });
      expect(getFolderRow()).not.toHaveAttribute('data-drop-target');
      expect(getFolderRow()?.className).not.toContain('outline-primary');
      expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();
    },
  );

  it('cancels real FinderMouseSensor drag session on window blur, Escape, and outside-window mouse release (buttons=0)', () => {
    const onMoveItem = vi.fn();
    const { container } = render(
      <FinderFileList
        items={sampleItems}
        viewMode="list"
        selectedIds={new Set()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
        onMoveItem={onMoveItem}
        parentDropTargets={[{ id: null, label: '学习资源' }]}
        isLoading={false}
        error={null}
      />,
    );

    const draggedEl = container.querySelector<HTMLElement>('[data-item-id="file_dragged"]')!;
    expect(draggedEl).not.toBeNull();

    const activateMouseDrag = () => {
      fireEvent.mouseDown(draggedEl, { button: 0, buttons: 1, clientX: 20, clientY: 20 });
      fireEvent.mouseMove(document, { buttons: 1, clientX: 40, clientY: 40 });
      expect(container.querySelector('[data-finder-drag-drop-bar]')).not.toBeNull();
    };

    // Real sensor cancel via window blur
    activateMouseDrag();
    fireEvent.blur(window);
    expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();

    // Real sensor cancel via synthetic Escape without code='Escape'
    activateMouseDrag();
    fireEvent.keyDown(document, { key: 'Escape', code: '' });
    expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();

    // Real sensor cancel via mouse released outside window (buttons drops from 1 to 0 on re-entry)
    activateMouseDrag();
    fireEvent.mouseMove(document, { buttons: 0, clientX: 50, clientY: 50 });
    expect(container.querySelector('[data-finder-drag-drop-bar]')).toBeNull();

    expect(onMoveItem).not.toHaveBeenCalled();
  });

  it('clears marquee selection box on Escape and window blur', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    try {
      const onSelectionChange = vi.fn();
      const { container } = render(
        <FinderFileList
          items={sampleItems}
          viewMode="list"
          selectedIds={new Set()}
          onSelect={vi.fn()}
          onOpen={vi.fn()}
          onContextMenu={vi.fn()}
          onSelectionChange={onSelectionChange}
          enableBoxSelect
          isLoading={false}
          error={null}
        />,
      );

      const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
      // Start marquee selection on empty container space
      fireEvent.mouseDown(listbox, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 60, clientY: 60 });
      const hasMarqueeOverlay = () =>
        Array.from(document.body.children).some(
          (node) => node instanceof HTMLElement && node.style.zIndex === '9999',
        );
      expect(hasMarqueeOverlay()).toBe(true);

      // Escape immediately dismisses the marquee selection box
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(hasMarqueeOverlay()).toBe(false);

      // Window blur also dismisses an active marquee selection box
      fireEvent.mouseDown(listbox, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 60, clientY: 60 });
      expect(hasMarqueeOverlay()).toBe(true);
      fireEvent.blur(window);
      expect(hasMarqueeOverlay()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('80-char mixed CJK/Latin/Emoji/special-char title resilience in Finder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expect(ADVERSARIAL_80_TITLE.length).toBeGreaterThanOrEqual(80);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps FinderToolbar breadcrumbs truncated with title tooltip and right-side actions protected across modes', () => {
    const { rerender } = render(
      <FinderToolbar
        breadcrumbs={[
          { id: 'b1', name: '第一层<script>1</script>' },
          { id: 'b2', name: '第二层<>[]/#?&🚀' },
          { id: 'b3', name: ADVERSARIAL_80_TITLE },
        ]}
        onBreadcrumbClick={vi.fn()}
        createMenuItems={<div>menu</div>}
        onViewModeChange={vi.fn()}
        onSearchChange={vi.fn()}
        titlebarMode={false}
      />,
    );

    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect((window as unknown as { __finderXss?: number }).__finderXss).toBeUndefined();

    const currentCrumb = screen.getByTitle(ADVERSARIAL_80_TITLE);
    expect(currentCrumb).toHaveTextContent(ADVERSARIAL_80_TITLE);
    expect(currentCrumb.className).toContain('min-w-0');
    expect(currentCrumb.className).toContain('flex-1');
    expect(currentCrumb.className).toContain('truncate');

    // Right-side create menu button stays visible inside a shrink-0 utility group
    const newBtn = screen.getByRole('button', { name: '新建' });
    expect(newBtn).toBeVisible();
    expect(newBtn.closest('.shrink-0')).not.toBeNull();

    // Also verify titlebarMode with empty breadcrumbs + long currentTitle
    rerender(
      <FinderToolbar
        breadcrumbs={[]}
        currentTitle={ADVERSARIAL_80_TITLE}
        onBreadcrumbClick={vi.fn()}
        createMenuItems={<div>menu</div>}
        titlebarMode="window"
      />,
    );
    const rootTitle = screen.getByTitle(ADVERSARIAL_80_TITLE);
    expect(rootTitle).toHaveTextContent(ADVERSARIAL_80_TITLE);
    expect(rootTitle.className).toContain('min-w-0');
    expect(rootTitle.className).toContain('truncate');
    expect(screen.getByRole('button', { name: '新建' })).toBeVisible();
  });

  it.each(['list', 'grid'] as const)(
    'safely renders 80-char adversarial titles in FinderFileItem (%s view) without script execution or hiding right-side actions',
    (viewMode) => {
      const adversarialNode: DstuNode = {
        id: 'adv_1',
        sourceId: 'adv_1',
        path: `/${ADVERSARIAL_80_TITLE}`,
        name: ADVERSARIAL_80_TITLE,
        type: 'note',
        size: 4096,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      };

      const onPermanentDelete = vi.fn();
      const { container } = render(
        <FinderFileItem
          item={adversarialNode}
          viewMode={viewMode}
          isSelected={false}
          onSelect={vi.fn()}
          onOpen={vi.fn()}
          onContextMenu={vi.fn()}
          isTrashView
          onRestore={vi.fn()}
          onPermanentDelete={onPermanentDelete}
        />,
      );

      // Zero <script> elements injected
      expect(document.querySelectorAll('script')).toHaveLength(0);
      expect((window as unknown as { __finderXss?: number }).__finderXss).toBeUndefined();

      // Title attribute exposes the full unescaped string for hover tooltips
      expect(container.querySelector(`[title="${CSS.escape(ADVERSARIAL_80_TITLE)}"]`)).not.toBeNull();
      expect(screen.getByText(ADVERSARIAL_80_TITLE)).toBeInTheDocument();

      if (viewMode === 'list') {
        const nameSpan = screen.getByText(ADVERSARIAL_80_TITLE);
        expect(nameSpan.className).toContain('min-w-0');
        expect(nameSpan.className).toContain('flex-1');
        expect(nameSpan.className).toContain('truncate');
      } else {
        const nameSpan = screen.getByText(ADVERSARIAL_80_TITLE);
        expect(nameSpan.className).toContain('break-words');
        expect(nameSpan.className).toContain('[overflow-wrap:anywhere]');
      }

      // Trash action button + inline confirm remain accessible and functional
      const deleteBtn = screen.getByTestId('finder-trash-permanent-delete');
      expect(deleteBtn).toBeVisible();
      fireEvent.click(deleteBtn);
      expect(screen.getByTestId('finder-trash-permanent-delete-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('finder-trash-permanent-delete-confirm-action'));
      expect(onPermanentDelete).toHaveBeenCalledTimes(1);
    },
  );

  it('safely renders 80-char adversarial titles in FolderPickerDialog and FinderQuickLook', async () => {
    vi.mocked(folderApi.getFolderTree).mockResolvedValue({
      ok: true,
      value: [
        {
          folder: {
            id: 'f_adv',
            title: ADVERSARIAL_80_TITLE,
            parentId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          children: [],
        },
      ],
    } as never);

    render(
      <>
        <FolderPickerDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          title={ADVERSARIAL_80_TITLE}
        />
        <FinderQuickLook
          item={{
            id: 'ql_adv',
            sourceId: 'ql_adv',
            path: `/${ADVERSARIAL_80_TITLE}`,
            name: ADVERSARIAL_80_TITLE,
            type: 'file',
            size: 512,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }}
          onClose={vi.fn()}
        />
      </>,
    );

    const folderLabel = await screen.findByTitle(ADVERSARIAL_80_TITLE, {
      selector: '[role="treeitem"] span',
    });
    expect(folderLabel).toHaveTextContent(ADVERSARIAL_80_TITLE);
    expect(folderLabel.className).toContain('min-w-0');
    expect(folderLabel.className).toContain('flex-1');
    expect(folderLabel.className).toContain('truncate');

    // QuickLook header title + zero injected <script> tags
    const quickLookHeader = document.querySelector('[data-finder-quick-look] [title]');
    expect(quickLookHeader).toHaveAttribute('title', ADVERSARIAL_80_TITLE);
    expect(quickLookHeader?.className).toContain('min-w-0');
    expect(quickLookHeader?.className).toContain('flex-1');
    expect(quickLookHeader?.className).toContain('truncate');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });
});
