import type React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import { dstu, type DstuNode } from '@/dstu';
import { reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { pLimit } from '@/utils/concurrency';
import type { ContextMenuTarget } from '../components/LearningHubContextMenu';
import {
  finderClipboard,
  toClipboardEntries,
  buildCopySrcPath,
  buildPasteDstPath,
  type FinderClipboardEntry,
} from '../utils/finderClipboard';
import { isPendingFolderId, type SidebarT } from './sidebarConstants';

// ==========================================================================
// ★ 复制 / 粘贴 / 制造副本（Finder 内部剪贴板，对标访达 Duplicate）
// ==========================================================================

/** 剪贴板订阅 + 选中项解析 + 复制 */
export function useClipboardSelection({
  displayedItems,
  selectedIds,
  t,
}: {
  displayedItems: DstuNode[];
  selectedIds: Set<string>;
  t: SidebarT;
}) {
  const clipboardState = useSyncExternalStore(
    finderClipboard.subscribe,
    finderClipboard.get,
    finderClipboard.get,
  );
  const clipboardCount = clipboardState?.entries.length ?? 0;

  /** 当前选中的真实节点（排除待创建文件夹草稿） */
  const getSelectedNodes = useCallback(
    () => displayedItems.filter((item) => selectedIds.has(item.id) && !isPendingFolderId(item.id)),
    [displayedItems, selectedIds],
  );

  // 右键目标解析：目标在多选集合内时作用于整组（访达语义），否则只作用于该项
  const resolveContextTargetNodes = useCallback((target: ContextMenuTarget): DstuNode[] => {
    const targetId = target.type === 'folder'
      ? target.folder.folder.id
      : target.type === 'resource'
        ? target.resource.id
        : null;
    if (!targetId || isPendingFolderId(targetId)) return [];
    if (selectedIds.has(targetId) && selectedIds.size > 1) {
      return getSelectedNodes();
    }
    const item = displayedItems.find((i) => i.id === targetId);
    return item ? [item] : [];
  }, [displayedItems, selectedIds, getSelectedNodes]);

  const handleCopyNodes = useCallback((nodes: DstuNode[]) => {
    const entries = toClipboardEntries(nodes);
    if (entries.length === 0) return;
    finderClipboard.copy(entries);
    showGlobalNotification('success', t('finder.clipboard.copied', { count: entries.length }));
  }, [t]);

  const handleCopyFromContextMenu = useCallback((target: ContextMenuTarget) => {
    handleCopyNodes(resolveContextTargetNodes(target));
  }, [handleCopyNodes, resolveContextTargetNodes]);

  const handleCopySelection = useCallback(() => {
    handleCopyNodes(getSelectedNodes());
  }, [getSelectedNodes, handleCopyNodes]);

  return {
    clipboardCount,
    getSelectedNodes,
    resolveContextTargetNodes,
    handleCopyFromContextMenu,
    handleCopySelection,
  };
}

export type CopySuccessKey = 'finder.clipboard.pasteSuccess' | 'finder.clipboard.duplicateSuccess';

export interface CopyEntriesContext {
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  isMountedRef: React.MutableRefObject<boolean>;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
}

// 粘贴与制造副本共用执行体：批量 dstu_copy 到目标文件夹（后端追加「(副本)」）
export async function copyEntriesToFolder(
  { setIsBatchProcessing, isMountedRef, t, handleRefresh }: CopyEntriesContext,
  entries: FinderClipboardEntry[],
  destFolderId: string | null,
  successKey: CopySuccessKey,
): Promise<void> {
  if (entries.length === 0) return;
  setIsBatchProcessing(true);
  try {
    const limit = pLimit(3);
    const results = await Promise.all(entries.map((entry) =>
      limit(() => dstu.copy(buildCopySrcPath(entry), buildPasteDstPath(destFolderId)))
    ));
    if (!isMountedRef.current) return;
    const failedResults = results.filter((r) => !r.ok);
    const succeeded = results.length - failedResults.length;
    if (failedResults.length === 0) {
      showGlobalNotification('success', t(successKey, { count: succeeded }));
    } else if (succeeded > 0) {
      showGlobalNotification('warning', t('finder.clipboard.copyPartial', {
        succeeded,
        failed: failedResults.length,
      }));
    } else {
      const firstError = failedResults[0];
      if (firstError && !firstError.ok) {
        reportError(firstError.error, 'copy items');
        showGlobalNotification('error', firstError.error.toUserMessage());
      }
    }
    if (succeeded > 0) handleRefresh();
  } finally {
    if (isMountedRef.current) setIsBatchProcessing(false);
  }
}

/** 粘贴 / 制造副本（与 copyEntriesToFolder 共用执行体） */
export function useClipboardPasteActions({
  canPasteHere,
  currentCreatableFolderId,
  executeCopyEntries,
  resolveContextTargetNodes,
  getSelectedNodes,
}: {
  canPasteHere: boolean;
  currentCreatableFolderId: string | null;
  executeCopyEntries: (entries: FinderClipboardEntry[], destFolderId: string | null, successKey: CopySuccessKey) => Promise<void>;
  resolveContextTargetNodes: (target: ContextMenuTarget) => DstuNode[];
  getSelectedNodes: () => DstuNode[];
}) {
  const handlePaste = useCallback(() => {
    if (!canPasteHere) return;
    const state = finderClipboard.get();
    if (!state || state.entries.length === 0) return;
    void executeCopyEntries(state.entries, currentCreatableFolderId, 'finder.clipboard.pasteSuccess');
  }, [canPasteHere, currentCreatableFolderId, executeCopyEntries]);

  // 制造副本：不经剪贴板，原地复制（目的地 = 当前文件夹，副本落在原件旁）
  const handleDuplicateNodes = useCallback((nodes: DstuNode[]) => {
    if (!canPasteHere) return;
    const entries = toClipboardEntries(nodes);
    if (entries.length === 0) return;
    void executeCopyEntries(entries, currentCreatableFolderId, 'finder.clipboard.duplicateSuccess');
  }, [canPasteHere, currentCreatableFolderId, executeCopyEntries]);

  const handleDuplicateFromContextMenu = useCallback((target: ContextMenuTarget) => {
    handleDuplicateNodes(resolveContextTargetNodes(target));
  }, [handleDuplicateNodes, resolveContextTargetNodes]);

  const handleDuplicateSelection = useCallback(() => {
    handleDuplicateNodes(getSelectedNodes());
  }, [getSelectedNodes, handleDuplicateNodes]);

  return { handlePaste, handleDuplicateFromContextMenu, handleDuplicateSelection };
}
