import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

vi.mock('@/i18n', () => ({ default: { language: 'zh-CN' } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number }) => {
      const map: Record<string, string> = {
        'common:delete_permanently': '彻底删除',
        'common:cancel': '取消',
        'common:close': '关闭',
        'common:more': '更多',
        'common:clear': '清除',
        'folder.root': '学习资源',
        'title': '学习资源',
        'learningHub:title': '学习资源',
        'finder.toolbar.new': '新建',
        'finder.toolbar.newFolder': '新建文件夹',
        'finder.toolbar.newTextbook': '导入资料…',
        'finder.toolbar.back': '返回',
        'finder.toolbar.forward': '前进',
        'finder.toolbar.more': '更多',
        'finder.empty.folder': '此文件夹为空',
        'finder.empty.importFiles': '导入资料…',
        'finder.empty.dropHint': '拖拽文件到此导入',
        'finder.empty.dropHintTouch': '点击下方按钮导入',
        'finder.empty.noCreateHint': '此视图不支持新建',
        'finder.empty.noCreateHintTouch': '此视图不支持新建',
        'finder.empty.rightClick': '右键',
        'finder.empty.contextMenuHint': '查看更多操作',
        'finder.search.placeholder': '搜索',
        'finder.search.placeholderDisabled': '搜索不可用',
        'finder.quickAccess.materials': '资料',
        'finder.quickAccess.aiKnowledge': 'AI 知识库',
        'finder.quickAccess.desktop': '桌面',
        'finder.quickAccess.allFiles': '全部文件',
        'finder.quickAccess.recent': '最近',
        'finder.quickAccess.favorites': '收藏',
        'finder.quickAccess.trash': '回收站',
        'finder.quickAccess.indexStatus': '索引状态',
        'finder.quickAccess.indexStatusDescription': '查看索引进度',
        'memory.navTitle': '记忆库',
        'memory.navDescription': '管理记忆',
        'finder.contextMenu.restore': '恢复',
        'learningHub:finder.contextMenu.restore': '恢复',
        'finder.contextMenu.permanentDelete': '永久删除',
        'learningHub:finder.contextMenu.permanentDelete': '永久删除',
        'finder.multiSelect.delete': '删除',
        'finder.statusBar.itemCount': `${opts?.count ?? 0} 个项目`,
        'finder.statusBar.selectedOfTotal': `已选 ${opts?.count ?? 0}`,
        'finder.trash.confirmPermanentDelete': '确认彻底删除此项目？此操作无法撤销。',
        'learningHub:finder.trash.confirmPermanentDelete': '确认彻底删除此项目？此操作无法撤销。',
        'finder.trash.confirmBatchPermanentDelete': `确认彻底删除选中的 ${opts?.count ?? 0} 个项目？`,
      };
      return map[key] ?? opts?.defaultValue ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 10 },
}));
vi.mock('../IndexStatusMiniBar', () => ({
  IndexStatusMiniBar: () => null,
}));

import { FinderToolbar } from '../FinderToolbar';
import { FinderCreateMenuItems, FinderQuickAccess } from '../FinderQuickAccess';
import { FinderFileList } from '../FinderFileList';
import { FinderFileItem } from '../FinderFileItem';
import { FinderBatchToolbar } from '../FinderBatchToolbar';

const sampleTrashNode: DstuNode = {
  id: 'file_trash_1',
  sourceId: 'file_trash_1',
  path: '/file_trash_1',
  name: 'deleted-guide.docx',
  type: 'file',
  size: 2048,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 30_000,
};

describe('S1-14(a) Resource Library visible upload entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders visible upload/import button in FinderToolbar from explicit onImportFiles or createMenuItems', () => {
    const onImportExplicit = vi.fn();
    const { rerender } = render(
      <FinderToolbar
        breadcrumbs={[]}
        onBreadcrumbClick={vi.fn()}
        onImportFiles={onImportExplicit}
      />,
    );

    const toolbarBtn = screen.getByTestId('finder-toolbar-import');
    expect(toolbarBtn).toBeVisible();
    expect(toolbarBtn).toHaveTextContent('导入资料…');
    fireEvent.click(toolbarBtn);
    expect(onImportExplicit).toHaveBeenCalledTimes(1);

    const onNewTextbook = vi.fn();
    rerender(
      <FinderToolbar
        breadcrumbs={[]}
        onBreadcrumbClick={vi.fn()}
        createMenuItems={<FinderCreateMenuItems onNewTextbook={onNewTextbook} />}
      />,
    );

    const derivedBtn = screen.getByTestId('finder-toolbar-import');
    expect(derivedBtn).toBeVisible();
    fireEvent.click(derivedBtn);
    expect(onNewTextbook).toHaveBeenCalledTimes(1);
  });

  it('renders visible import button in FinderFileList empty state and wires it to handler or hidden file input', () => {
    const onImportFiles = vi.fn();
    const { rerender } = render(
      <FinderFileList
        items={[]}
        viewMode="grid"
        selectedIds={new Set()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
        onContainerContextMenu={vi.fn()}
        onImportFiles={onImportFiles}
        isLoading={false}
        error={null}
        canCreate
      />,
    );

    const emptyImportBtn = screen.getByTestId('finder-empty-import');
    expect(emptyImportBtn).toBeVisible();
    expect(emptyImportBtn).toHaveTextContent('导入资料…');
    fireEvent.click(emptyImportBtn);
    expect(onImportFiles).toHaveBeenCalledTimes(1);

    // Fallback when onImportFiles is omitted: triggers mounted finder-import-files-input
    const inputClickSpy = vi.fn();
    rerender(
      <div tabIndex={-1}>
        <input
          type="file"
          data-testid="finder-import-files-input"
          onClick={inputClickSpy}
        />
        <FinderFileList
          items={[]}
          viewMode="grid"
          selectedIds={new Set()}
          onSelect={vi.fn()}
          onOpen={vi.fn()}
          onContextMenu={vi.fn()}
          onContainerContextMenu={vi.fn()}
          isLoading={false}
          error={null}
          canCreate
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId('finder-empty-import'));
    expect(inputClickSpy).toHaveBeenCalledTimes(1);

    // Non-creatable views (e.g. Trash/Favorites) hide the empty-state upload button
    rerender(
      <FinderFileList
        items={[]}
        viewMode="grid"
        selectedIds={new Set()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
        onContainerContextMenu={vi.fn()}
        onImportFiles={onImportFiles}
        isLoading={false}
        error={null}
        canCreate={false}
      />,
    );
    expect(screen.queryByTestId('finder-empty-import')).not.toBeInTheDocument();
  });

  it('renders visible import button in FinderQuickAccess when expanded in standalone sidebar mode', () => {
    const onNewTextbook = vi.fn();
    render(
      <FinderQuickAccess
        collapsed={false}
        activeType="allFiles"
        onNavigate={vi.fn()}
        onNewTextbook={onNewTextbook}
      />,
    );

    const quickImportBtn = screen.getByTestId('finder-quickaccess-import');
    expect(quickImportBtn).toBeVisible();
    expect(quickImportBtn).toHaveTextContent('导入资料…');
    fireEvent.click(quickImportBtn);
    expect(onNewTextbook).toHaveBeenCalledTimes(1);
  });
});

describe('S1-14(b) Resource Library Trash red permanent delete label + inline confirmation', () => {
  afterEach(() => {
    cleanup();
  });

  it.each(['list', 'grid'] as const)(
    'shows red 彻底删除 button with inline confirmation (Cancel / Escape / Confirm) on Trash %s item card',
    (viewMode) => {
      const onPermanentDelete = vi.fn();
      const onRestore = vi.fn();
      const onSelect = vi.fn();

      render(
        <FinderFileItem
          item={sampleTrashNode}
          viewMode={viewMode}
          isSelected={false}
          onSelect={onSelect}
          onOpen={vi.fn()}
          onContextMenu={vi.fn()}
          isTrashView
          onRestore={onRestore}
          onPermanentDelete={onPermanentDelete}
        />,
      );

      // Step 1: clear red labeled button
      const deleteBtn = screen.getByTestId('finder-trash-permanent-delete');
      expect(deleteBtn).toBeVisible();
      expect(deleteBtn).toHaveTextContent('彻底删除');
      expect(deleteBtn.className).toContain('text-destructive');

      // Step 2: first click reveals inline confirmation without deleting
      fireEvent.click(deleteBtn);
      expect(onPermanentDelete).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId('finder-trash-permanent-delete-confirm')).toBeVisible();

      // Cancel aborts
      fireEvent.click(screen.getByTestId('finder-trash-permanent-delete-cancel'));
      expect(screen.queryByTestId('finder-trash-permanent-delete-confirm')).not.toBeInTheDocument();
      expect(onPermanentDelete).not.toHaveBeenCalled();

      // Escape aborts
      fireEvent.click(screen.getByTestId('finder-trash-permanent-delete'));
      expect(screen.getByTestId('finder-trash-permanent-delete-confirm')).toBeVisible();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('finder-trash-permanent-delete-confirm')).not.toBeInTheDocument();
      expect(onPermanentDelete).not.toHaveBeenCalled();

      // Second click on inline confirm invokes onPermanentDelete
      fireEvent.click(screen.getByTestId('finder-trash-permanent-delete'));
      const confirmBtn = screen.getByTestId('finder-trash-permanent-delete-confirm-action');
      expect(confirmBtn).toHaveTextContent('彻底删除');
      expect(confirmBtn.className).toContain('bg-destructive');
      fireEvent.click(confirmBtn);
      expect(onPermanentDelete).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps red destructive styling on selected Trash list item row', () => {
    render(
      <FinderFileItem
        item={sampleTrashNode}
        viewMode="list"
        isSelected
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
        isTrashView
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );

    const deleteBtn = screen.getByTestId('finder-trash-permanent-delete');
    expect(deleteBtn).toHaveTextContent('彻底删除');
    expect(deleteBtn.className).toContain('bg-destructive');
  });

  it('shows red 彻底删除 button with inline confirmation on Trash FinderBatchToolbar', () => {
    const onBatchDelete = vi.fn();
    const { rerender } = render(
      <FinderBatchToolbar
        selectedCount={2}
        totalCount={5}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        onBatchDelete={onBatchDelete}
        onBatchRestore={vi.fn()}
        isTrashView
      />,
    );

    const batchDeleteBtn = screen.getByTestId('finder-batch-permanent-delete');
    expect(batchDeleteBtn).toBeVisible();
    expect(batchDeleteBtn).toHaveTextContent('彻底删除');
    expect(batchDeleteBtn.className).toContain('text-destructive');

    // First click reveals inline confirmation without calling onBatchDelete
    fireEvent.click(batchDeleteBtn);
    expect(onBatchDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('finder-batch-permanent-delete-confirm')).toBeVisible();

    // Cancel aborts
    fireEvent.click(screen.getByTestId('finder-batch-permanent-delete-cancel'));
    expect(screen.queryByTestId('finder-batch-permanent-delete-confirm')).not.toBeInTheDocument();
    expect(onBatchDelete).not.toHaveBeenCalled();

    // Escape aborts
    fireEvent.click(screen.getByTestId('finder-batch-permanent-delete'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('finder-batch-permanent-delete-confirm')).not.toBeInTheDocument();
    expect(onBatchDelete).not.toHaveBeenCalled();

    // Confirm triggers callback
    fireEvent.click(screen.getByTestId('finder-batch-permanent-delete'));
    const confirmAction = screen.getByTestId('finder-batch-permanent-delete-confirm-action');
    expect(confirmAction).toHaveTextContent('彻底删除');
    expect(confirmAction.className).toContain('bg-destructive');
    fireEvent.click(confirmAction);
    expect(onBatchDelete).toHaveBeenCalledTimes(1);

    // Non-trash view still invokes soft-delete directly without inline confirmation
    onBatchDelete.mockClear();
    rerender(
      <FinderBatchToolbar
        selectedCount={1}
        totalCount={5}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        onBatchDelete={onBatchDelete}
        isTrashView={false}
      />,
    );
    expect(screen.queryByTestId('finder-batch-permanent-delete')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onBatchDelete).toHaveBeenCalledTimes(1);
  });
});
