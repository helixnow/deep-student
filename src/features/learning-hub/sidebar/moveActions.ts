import type React from 'react';
import { dstu, folderApi, type DstuNode } from '@/dstu';
import { updatePathCacheV2 } from '@/features/chat/context/vfsRefApi';
import { VfsError, VfsErrorCode, err, reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import { mapDstuTypeToFolderItemType } from '../types';
import { finderUndoStack, type FinderMoveUndoEntry } from '../utils/finderUndoStack';
import type { SidebarT } from './sidebarConstants';

type IsMountedRef = React.MutableRefObject<boolean>;

export interface MoveItemContext {
  items: DstuNode[];
  canRecordMoveUndo: boolean;
  moveUndoSourceFolderId: string | null;
  isMountedRef: IsMountedRef;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
}

// 拖拽移动单个项目
export async function moveSingleItem(
  { items, canRecordMoveUndo, moveUndoSourceFolderId, isMountedRef, t, handleRefresh }: MoveItemContext,
  itemId: string,
  targetFolderId: string | null,
): Promise<void> {
  const item = items.find(i => i.id === itemId);
  if (!item) return;

  // 根据类型调用不同的移动 API
  let result;
  if (item.type === 'folder') {
    result = await folderApi.moveFolder(itemId, targetFolderId ?? undefined);
  } else {
    // 非文件夹使用 moveItem（共用映射，P1-13 image/file 支持随之保留）
    result = await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), itemId, targetFolderId ?? undefined);
  }

  if (result.ok && canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
    finderUndoStack.push({
      kind: 'move',
      entries: [{
        id: itemId,
        isFolder: item.type === 'folder',
        itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
        fromFolderId: moveUndoSourceFolderId,
      }],
      toFolderId: targetFolderId,
    });
  }

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  if (result.ok) {
    showGlobalNotification('success', t('finder.batch.moveSuccess'));
    handleRefresh();
  } else {
    reportError(result.error, 'move item');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

// 拖拽移动多个项目（多选拖拽）
export async function moveMultipleItems(
  {
    items,
    t,
    canRecordMoveUndo,
    moveUndoSourceFolderId,
    isMountedRef,
    clearSelection,
    handleRefresh,
  }: MoveItemContext & { clearSelection: () => void },
  itemIds: string[],
  targetFolderId: string | null,
): Promise<void> {
  if (itemIds.length === 0) return;

  // ★ 并发控制：限制同时执行的移动操作为 3 个，避免文件系统操作冲突
  const limit = pLimit(3);
  const moveResults = await Promise.all(itemIds.map((itemId) =>
    limit(async () => {
      const item = items.find(i => i.id === itemId);
      if (!item) {
        const notFoundError = new VfsError(
          VfsErrorCode.NOT_FOUND,
          t('error.itemNotFound'),
          true,
          { itemId }
        );
        return err(notFoundError);
      }

      if (item.type === 'folder') {
        return await folderApi.moveFolder(itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
      } else {
        // 共用映射（P1-13 image/file 支持随之保留）
        return await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
      }
    })
  ));

  // ★ HIGH-002: 批量操作完成后统一刷新目标文件夹缓存
  if (targetFolderId) {
    const cacheResult = await updatePathCacheV2(targetFolderId);
    if (cacheResult.ok) {
      debugLog.log('[LearningHub] 批量移动后统一刷新缓存:', cacheResult.value, '项');
    } else {
      debugLog.warn('[LearningHub] 批量移动后缓存刷新失败:', cacheResult.error.message);
    }
  }

  // ★ Cmd+Z 撤销：仅记录移动成功的项
  if (canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
    const undoEntries: FinderMoveUndoEntry[] = [];
    itemIds.forEach((itemId, index) => {
      if (!moveResults[index]?.ok) return;
      const item = items.find(i => i.id === itemId);
      if (!item) return;
      undoEntries.push({
        id: itemId,
        isFolder: item.type === 'folder',
        itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
        fromFolderId: moveUndoSourceFolderId,
      });
    });
    if (undoEntries.length > 0) {
      finderUndoStack.push({ kind: 'move', entries: undoEntries, toFolderId: targetFolderId });
    }
  }

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  const succeeded = moveResults.filter(r => r.ok).length;
  const failed = moveResults.filter(r => !r.ok).length;

  if (failed === 0) {
    showGlobalNotification('success', t('finder.batch.moveSuccess'));
  } else if (succeeded > 0) {
    showGlobalNotification('warning', t('finder.batch.movePartial', { succeeded, failed }));
  } else {
    const firstError = moveResults.find(r => !r.ok);
    if (firstError && !firstError.ok) {
      reportError(firstError.error, 'batch move items');
      showGlobalNotification('error', firstError.error.toUserMessage());
    }
  }
  clearSelection();
  handleRefresh();
}

export interface ConfirmBatchMoveContext {
  moveTargetIds: Set<string> | null;
  selectedIds: Set<string>;
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  items: DstuNode[];
  t: SidebarT;
  canRecordMoveUndo: boolean;
  moveUndoSourceFolderId: string | null;
  isMountedRef: IsMountedRef;
  clearSelection: () => void;
  setSelectedIds: (ids: Set<string>) => void;
  handleRefresh: () => Promise<void>;
  setMoveTargetIds: React.Dispatch<React.SetStateAction<Set<string> | null>>;
}

// 批量移动确认
export async function confirmBatchMove(
  {
    moveTargetIds,
    selectedIds,
    setIsBatchProcessing,
    items,
    t,
    canRecordMoveUndo,
    moveUndoSourceFolderId,
    isMountedRef,
    clearSelection,
    setSelectedIds,
    handleRefresh,
    setMoveTargetIds,
  }: ConfirmBatchMoveContext,
  targetFolderId: string | null,
): Promise<void> {
  const effectiveIds = moveTargetIds ?? selectedIds;
  if (effectiveIds.size === 0) return;

  setIsBatchProcessing(true);

  try {
    const idsArray = Array.from(effectiveIds);
    // ★ 并发控制：限制同时执行的移动操作为 3 个，避免文件系统操作冲突
    const limit = pLimit(3);

    const moveResults = await Promise.all(idsArray.map((id, index) =>
      limit(async () => {
        const item = items.find(i => i.id === id);
        if (!item) {
          return {
            id,
            ok: false,
            error: t('error.itemNotFound')
          };
        }

        if (item.type === 'folder') {
          const result = await folderApi.moveFolder(id, targetFolderId ?? undefined, { skipCacheRefresh: true });
          return {
            id,
            ok: result.ok,
            error: result.ok ? null : result.error.toUserMessage()
          };
        } else {
          // 共用映射（P1-13 image/file 支持随之保留）
          const result = await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), id, targetFolderId ?? undefined, { skipCacheRefresh: true });
          return {
            id,
            ok: result.ok,
            error: result.ok ? null : result.error.toUserMessage()
          };
        }
      })
    ));


    // ★ HIGH-002: 批量操作完成后统一刷新目标文件夹缓存
    if (targetFolderId) {
      const cacheResult = await updatePathCacheV2(targetFolderId);
      if (cacheResult.ok) {
        debugLog.log('[LearningHub] 批量移动确认后统一刷新缓存:', cacheResult.value, '项');
      } else {
        debugLog.warn('[LearningHub] 批量移动确认后缓存刷新失败:', cacheResult.error.message);
      }
    }

    // ★ Cmd+Z 撤销：仅记录移动成功的项
    if (canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
      const undoEntries: FinderMoveUndoEntry[] = [];
      idsArray.forEach((id, index) => {
        if (!moveResults[index]?.ok) return;
        const item = items.find(i => i.id === id);
        if (!item) return;
        undoEntries.push({
          id,
          isFolder: item.type === 'folder',
          itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
          fromFolderId: moveUndoSourceFolderId,
        });
      });
      if (undoEntries.length > 0) {
        finderUndoStack.push({ kind: 'move', entries: undoEntries, toFolderId: targetFolderId });
      }
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    // ★ 单次遍历统计成功、失败和失败ID
    const failedResults = moveResults.filter(r => !r.ok);
    const succeeded = moveResults.length - failedResults.length;
    const failed = failedResults.length;
    const failedIds = failedResults.map(r => r.id);

    if (failed === 0) {
      // 全部成功（右键移动非选中项时不影响当前多选状态）
      showGlobalNotification('success', t('finder.batch.moveSuccess'));
      if (moveTargetIds === null) {
        clearSelection();
      }
    } else if (succeeded > 0) {
      // 部分成功 - 保留失败项的选择状态
      showGlobalNotification('warning',
        t('finder.batch.movePartial', { succeeded, failed }) +
        ' ' + t('finder.batch.failedItemsSelected')
      );

      // ★ 只保留失败项的选择
      const newSelected = new Set(failedIds);
      setSelectedIds(newSelected);

      debugLog.error('[LearningHub] 批量移动部分失败:', {
        failedIds,
        errors: failedResults.map(r => ({ id: r.id, error: r.error })),
      });
    } else {
      // 全部失败
      const firstError = failedResults[0];
      showGlobalNotification('error', firstError?.error || t('finder.batch.moveFailed'));
    }

    handleRefresh();
  } finally {
    // ★ 使用 finally 确保状态恢复，即使操作失败
    if (isMountedRef.current) {
      setIsBatchProcessing(false);
      setMoveTargetIds(null);
    }
  }
}

// ★ Cmd+Z：撤销最近一次移动/重命名（LIFO 操作栈；非完整事务系统）
export async function undoLastFinderOperation({
  isMountedRef,
  t,
  handleRefresh,
}: {
  isMountedRef: IsMountedRef;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
}): Promise<void> {
  const op = finderUndoStack.pop();
  if (!op) return;

  if (op.kind === 'rename') {
    let result;
    if (op.targetType === 'folder') {
      result = await folderApi.renameFolder(op.id, op.oldName);
    } else {
      // 重命名会改变 path 叶子：按 id 重新解析当前路径再反向 rename
      const nodeResult = await dstu.get(`/${op.id}`);
      const livePath = nodeResult.ok ? nodeResult.value.path : null;
      result = await dstu.rename(livePath || op.path || `/${op.id}`, op.oldName);
    }
    if (!isMountedRef.current) return;
    if (result.ok) {
      showGlobalNotification('success', t('finder.undoRenameSuccess', { name: op.oldName }));
      handleRefresh();
    } else {
      // 失败塞回栈顶：允许用户处理冲突后重试
      finderUndoStack.push(op);
      reportError(result.error, 'undo rename');
      showGlobalNotification('error', t('finder.undoFailed'));
    }
    return;
  }

  // 移动撤销：批量把各项移回原文件夹
  const limit = pLimit(3);
  const results = await Promise.all(op.entries.map((entry) =>
    limit(async () => {
      if (entry.isFolder) {
        return folderApi.moveFolder(entry.id, entry.fromFolderId ?? undefined, { skipCacheRefresh: true });
      }
      return folderApi.moveItem(entry.itemType ?? 'note', entry.id, entry.fromFolderId ?? undefined, { skipCacheRefresh: true });
    })
  ));

  // 统一刷新涉及到的原文件夹缓存
  const sourceFolderIds = new Set(
    op.entries.map((entry) => entry.fromFolderId).filter((id): id is string => id != null)
  );
  for (const folderId of sourceFolderIds) {
    const cacheResult = await updatePathCacheV2(folderId);
    if (!cacheResult.ok) {
      debugLog.warn('[LearningHub] 撤销移动后缓存刷新失败:', cacheResult.error.message);
    }
  }

  if (!isMountedRef.current) return;
  const failed = results.filter((r) => !r.ok).length;
  if (failed === 0) {
    showGlobalNotification('success', t('finder.undoMoveSuccess', { count: op.entries.length }));
  } else if (failed < results.length) {
    showGlobalNotification('warning', t('finder.undoMovePartial', { failed }));
  } else {
    finderUndoStack.push(op);
    showGlobalNotification('error', t('finder.undoFailed'));
  }
  handleRefresh();
}
