import type React from 'react';
import type { DstuNode } from '@/dstu';
import type { FinderPath, FinderStoreApi } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';
import { finderUndoStack } from '../utils/finderUndoStack';
import { isPendingFolderId } from './sidebarConstants';

export interface FinderKeyDownContext {
  containerRef: React.RefObject<HTMLDivElement>;
  handleSelectAll: () => void;
  mode: LearningHubSidebarProps['mode'];
  handleUndoLastOperation: () => Promise<void>;
  selectedIds: Set<string>;
  handleCopySelection: () => void;
  canPasteHere: boolean;
  clipboardCount: number;
  handlePaste: () => void;
  handleDuplicateSelection: () => void;
  currentPath: {
    viewKind: FinderPath['viewKind'];
    folderId: FinderPath['folderId'];
    breadcrumbs: { length: number };
  };
  goUp: () => void;
  quickLookItem: DstuNode | null;
  canvasLastSelectedId: string | null;
  finderStore: FinderStoreApi;
  displayedItems: DstuNode[];
  setQuickLookItem: React.Dispatch<React.SetStateAction<DstuNode | null>>;
  canDeleteInCurrentView: boolean;
  handleBatchDelete: () => void;
  handleClearSelection: () => void;
  isMultiSelectMode: boolean;
  toggleMultiSelect: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

/** 访达键盘快捷键（全选 / 撤销 / 复制粘贴副本 / 上一级 / Quick Look / 删除 / Escape） */
export function handleFinderKeyDown(
  {
    containerRef,
    handleSelectAll,
    mode,
    handleUndoLastOperation,
    selectedIds,
    handleCopySelection,
    canPasteHere,
    clipboardCount,
    handlePaste,
    handleDuplicateSelection,
    currentPath,
    goUp,
    quickLookItem,
    canvasLastSelectedId,
    finderStore,
    displayedItems,
    setQuickLookItem,
    canDeleteInCurrentView,
    handleBatchDelete,
    handleClearSelection,
    isMultiSelectMode,
    toggleMultiSelect,
    searchQuery,
    setSearchQuery,
  }: FinderKeyDownContext,
  e: KeyboardEvent,
): void {
  // 检查焦点是否在 Learning Hub 容器内
  if (!containerRef.current?.contains(document.activeElement) && 
      !containerRef.current?.contains(e.target as Node)) {
    return;
  }
  
  // 只在非输入框中响应
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return;
  }

  const cmdOrCtrl = e.metaKey || e.ctrlKey;

  // Cmd/Ctrl + A：全选
  // ★ code 优先：Caps Lock 开启时 e.key 为 'A'，非拉丁布局下 e.key 可能不是字母
  if (cmdOrCtrl && !e.shiftKey && !e.altKey && (e.code === 'KeyA' || e.key.toLowerCase() === 'a')) {
    e.preventDefault();
    handleSelectAll();
  }

  // Cmd/Ctrl + Z：撤销最近一次移动/重命名（canvas 宿主不产生这类操作）
  if (
    cmdOrCtrl && !e.shiftKey && !e.altKey &&
    (e.code === 'KeyZ' || e.key.toLowerCase() === 'z') &&
    mode !== 'canvas'
  ) {
    if (finderUndoStack.size() > 0) {
      e.preventDefault();
      void handleUndoLastOperation();
    }
    return;
  }

  // ★ Cmd/Ctrl + C：复制选中项到 Finder 剪贴板。
  // 页面上有文本选区时不拦截（用户可能在复制文字）。
  if (
    cmdOrCtrl && !e.shiftKey && !e.altKey &&
    (e.code === 'KeyC' || e.key.toLowerCase() === 'c') &&
    mode !== 'canvas'
  ) {
    if (selectedIds.size > 0 && !window.getSelection()?.toString()) {
      e.preventDefault();
      handleCopySelection();
    }
    return;
  }

  // ★ Cmd/Ctrl + V：粘贴剪贴板内容到当前文件夹
  if (
    cmdOrCtrl && !e.shiftKey && !e.altKey &&
    (e.code === 'KeyV' || e.key.toLowerCase() === 'v') &&
    mode !== 'canvas'
  ) {
    if (canPasteHere && clipboardCount > 0) {
      e.preventDefault();
      handlePaste();
    }
    return;
  }

  // ★ Cmd/Ctrl + D：制造副本（访达 Duplicate 同键位）
  if (
    cmdOrCtrl && !e.shiftKey && !e.altKey &&
    (e.code === 'KeyD' || e.key.toLowerCase() === 'd') &&
    mode !== 'canvas'
  ) {
    if (canPasteHere && selectedIds.size > 0) {
      e.preventDefault();
      handleDuplicateSelection();
    }
    return;
  }

  // Cmd/Ctrl + ↑：返回上一级（访达）
  if (cmdOrCtrl && e.key === 'ArrowUp') {
    if (currentPath.viewKind === 'folder' && (currentPath.folderId || currentPath.breadcrumbs.length > 0)) {
      e.preventDefault();
      goUp();
    }
  }

  // ★ 空格：Quick Look 快速预览（访达）。
  // FinderFileList 的 type-ahead 输入若已消费空格（defaultPrevented）不重复触发；
  // 浮层打开期间的空格由浮层 capture 关闭，不会到达这里。
  if (
    e.key === ' ' && !cmdOrCtrl && !e.altKey &&
    !e.defaultPrevented && !quickLookItem && selectedIds.size > 0
  ) {
    const anchorId = mode === 'canvas' ? canvasLastSelectedId : finderStore.getState().lastSelectedId;
    const anchor =
      (anchorId && selectedIds.has(anchorId)
        ? displayedItems.find((item) => item.id === anchorId)
        : undefined)
      ?? displayedItems.find((item) => selectedIds.has(item.id));
    if (anchor && !isPendingFolderId(anchor.id)) {
      e.preventDefault();
      setQuickLookItem(anchor);
    }
  }
  
  // Delete：删除选中项
  // Backspace：仅 Cmd/Ctrl+Backspace 删除（避免与访达「上一级」心智及输入习惯冲突）
  if (e.key === 'Delete' && selectedIds.size > 0 && canDeleteInCurrentView) {
    e.preventDefault();
    handleBatchDelete();
  }
  if (e.key === 'Backspace' && cmdOrCtrl && selectedIds.size > 0 && canDeleteInCurrentView) {
    e.preventDefault();
    handleBatchDelete();
  }

  // ★ Escape 优先级：Quick Look 关闭（浮层 capture 自行消费，不会到达此处）
  // > 清除选择 > 退出多选模式 > 清空搜索
  if (e.key === 'Escape') {
    if (quickLookItem) return;
    if (selectedIds.size > 0) {
      e.preventDefault();
      handleClearSelection();
    } else if (isMultiSelectMode) {
      e.preventDefault();
      toggleMultiSelect();
    } else if (searchQuery) {
      e.preventDefault();
      setSearchQuery('');
    }
  }
}
