import type React from 'react';
import { dstu, folderApi, trashApi, type DstuNode } from '@/dstu';
import { VfsErrorCode, reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import { useDesktopStore } from '../stores/desktopStore';
import type { ResourceListItem } from '../types';
import type { DeleteConfirmTarget, SidebarT, SoftDeleteTarget } from './sidebarConstants';

type IsMountedRef = React.MutableRefObject<boolean>;

export interface SoftDeleteUndoContext {
  softDeleteUndoGenRef: React.MutableRefObject<number>;
  t: SidebarT;
  softDeleteUndoInFlightRef: React.MutableRefObject<boolean>;
  isMountedRef: IsMountedRef;
  handleRefresh: () => Promise<void>;
}

// ★ LH-UNDO：软删成功 toast + Undo → trashApi.restoreItem
export function showSoftDeleteUndo(
  { softDeleteUndoGenRef, t, softDeleteUndoInFlightRef, isMountedRef, handleRefresh }: SoftDeleteUndoContext,
  targets: SoftDeleteTarget[],
  opts?: { refCount?: number },
): void {
  if (targets.length === 0) return;
  const generation = ++softDeleteUndoGenRef.current;

  // ★ 悬挂引用清理：资源/文件夹入回收站即移除对应桌面快捷方式；
  // 快照被移除的快捷方式，Undo 恢复资源时原样放回（不丢用户桌面布局）。
  const prunedShortcuts = useDesktopStore
    .getState()
    .pruneShortcutsForTargets(targets.map((target) => target.id));

  const message = opts?.refCount && opts.refCount > 0
    ? t('finder.movedToTrashWithRefs', { count: opts.refCount })
    : targets.length === 1
      ? t('finder.movedToTrash')
      : t('finder.batchMovedToTrash', { count: targets.length });

  showGlobalNotification('success', message, undefined, {
    action: {
      label: t('finder.undo'),
      onClick: () => {
        void (async () => {
          if (generation !== softDeleteUndoGenRef.current || softDeleteUndoInFlightRef.current) {
            return;
          }
          softDeleteUndoInFlightRef.current = true;
          const limit = pLimit(3);
          try {
            const results = await Promise.all(
              targets.map((target) =>
                limit(async () => trashApi.restoreItem(target.id, target.type))
              )
            );
            // 恢复成功的目标：放回其桌面快捷方式
            if (prunedShortcuts.length > 0) {
              const restoredIds = new Set(
                targets.filter((_, index) => results[index]?.ok).map((target) => target.id)
              );
              useDesktopStore.getState().restoreShortcuts(
                prunedShortcuts.filter((shortcut) => {
                  const targetId = shortcut.target.resourceId ?? shortcut.target.folderId;
                  return targetId != null && restoredIds.has(targetId);
                })
              );
            }
            if (!isMountedRef.current) return;
            const failed = results.filter((r) => !r.ok).length;
            if (failed === 0) {
              showGlobalNotification('success', t('finder.restored'));
            } else if (failed < results.length) {
              showGlobalNotification('warning', t('finder.trash.restoreSuccess'));
            } else {
              const firstErr = results.find((r) => !r.ok);
              showGlobalNotification(
                'error',
                firstErr && !firstErr.ok
                  ? firstErr.error.toUserMessage()
                  : t('finder.trash.restoreSuccess')
              );
            }
            await handleRefresh();
          } finally {
            softDeleteUndoInFlightRef.current = false;
          }
        })();
      },
    },
  });
}

export interface DeleteToTrashContext {
  canDeleteInCurrentView: boolean;
  items: DstuNode[];
  isMountedRef: IsMountedRef;
  showSoftDeleteUndoToast: (targets: SoftDeleteTarget[], opts?: { refCount?: number }) => void;
  handleRefresh: () => Promise<void>;
}

// 右键菜单 - 删除文件夹（软删除到回收站，无需确认 + Undo）
export async function deleteFolderToTrash(
  { canDeleteInCurrentView, items, isMountedRef, showSoftDeleteUndoToast, handleRefresh }: DeleteToTrashContext,
  folderId: string,
): Promise<void> {
  if (!canDeleteInCurrentView) return;
  const folder = items.find((i) => i.id === folderId);
  const result = await folderApi.deleteFolder(folderId);

  if (!isMountedRef.current) return;

  if (result.ok) {
    showSoftDeleteUndoToast([{
      id: folderId,
      type: 'folder',
      name: folder?.name || folderId,
    }]);
    handleRefresh();
  } else {
    reportError(result.error, 'delete folder');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

// 右键菜单 - 删除资源（软删除，无确认；有引用时仅警告文案 + Undo）
export async function deleteResourceToTrash(
  { canDeleteInCurrentView, items, t, isMountedRef, showSoftDeleteUndoToast, handleRefresh }: DeleteToTrashContext & { t: SidebarT },
  resource: ResourceListItem,
): Promise<void> {
  if (!canDeleteInCurrentView) return;

  const { getResourceRefCountV2 } = await import('@/features/chat/context/vfsRefApi');
  const refCountResult = await getResourceRefCountV2(resource.id);
  const refCount = refCountResult.ok ? refCountResult.value : 0;

  let deletePath = resource.path;
  if (!deletePath) {
    const item = items.find(i => i.id === resource.id);
    deletePath = item?.path;
  }
  if (!deletePath) {
    deletePath = `/${resource.id}`;
  }
  if (!deletePath) {
    showGlobalNotification('error', t('contextMenu.deleteError'));
    return;
  }

  const deleteResult = await dstu.delete(deletePath);
  if (!isMountedRef.current) return;

  if (deleteResult.ok) {
    showSoftDeleteUndoToast(
      [{ id: resource.id, type: resource.type, name: resource.title }],
      { refCount }
    );
    handleRefresh();
  } else {
    reportError(deleteResult.error, 'delete resource');
    showGlobalNotification('error', deleteResult.error.toUserMessage());
  }
}

export interface BatchSoftDeleteContext {
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  items: DstuNode[];
  t: SidebarT;
  isMountedRef: IsMountedRef;
  showSoftDeleteUndoToast: (targets: SoftDeleteTarget[], opts?: { refCount?: number }) => void;
  clearSelection: () => void;
  setSelectedIds: (ids: Set<string>) => void;
  handleRefresh: () => Promise<void>;
}

// ★ 执行批量软删除（非 trash；带 Undo toast）
export async function executeBatchSoftDelete(
  {
    setIsBatchProcessing,
    items,
    t,
    isMountedRef,
    showSoftDeleteUndoToast,
    clearSelection,
    setSelectedIds,
    handleRefresh,
  }: BatchSoftDeleteContext,
  idsToDelete: Set<string>,
): Promise<void> {
  setIsBatchProcessing(true);

  try {
    const idsArray = Array.from(idsToDelete);
    // ★ 并发控制：限制同时执行的删除操作为 3 个，避免数据库锁竞争
    const limit = pLimit(3);

    const missingResults: Array<{ id: string; ok: boolean; error: string | null }> = [];
    const folderIds: string[] = [];
    const resourceEntries: Array<{ id: string; path: string }> = [];

    for (const id of idsArray) {
      const item = items.find(i => i.id === id);
      if (!item) {
        missingResults.push({
          id,
          ok: false,
          error: t('error.itemNotFound'),
        });
        continue;
      }

      if (item.type === 'folder') {
        folderIds.push(id);
        continue;
      }

      const dstuPath = item.path || `/${item.id}`;
      resourceEntries.push({ id, path: dstuPath });
    }

    const folderResults = await Promise.all(folderIds.map((id) =>
      limit(async () => {
        const result = await folderApi.deleteFolder(id);
        return {
          id,
          ok: result.ok,
          error: result.ok ? null : result.error.toUserMessage(),
        };
      })
    ));

    let resourceResults: Array<{ id: string; ok: boolean; error: string | null }> = [];
    if (resourceEntries.length > 0) {
      const paths = resourceEntries.map(entry => entry.path);
      const batchResult = await dstu.deleteMany(paths);

      if (!batchResult.ok) {
        resourceResults = resourceEntries.map(entry => ({
          id: entry.id,
          ok: false,
          error: batchResult.error.toUserMessage(),
        }));
      } else if (batchResult.value === resourceEntries.length) {
        resourceResults = resourceEntries.map(entry => ({
          id: entry.id,
          ok: true,
          error: null,
        }));
      } else {
        // 部分成功：逐个验证剩余资源，确认失败项
        resourceResults = await Promise.all(resourceEntries.map(entry =>
          limit(async () => {
            const check = await dstu.get(entry.path);
            if (!check.ok) {
              if (check.error?.code === VfsErrorCode.NOT_FOUND) {
                return { id: entry.id, ok: true, error: null };
              }
              return { id: entry.id, ok: false, error: check.error.toUserMessage() };
            }
            return { id: entry.id, ok: false, error: t('finder.batch.deleteFailed') };
          })
        ));
      }
    }

    const deleteResults = [
      ...missingResults,
      ...folderResults,
      ...resourceResults,
    ];

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    // ★ 单次遍历统计成功、失败和失败ID
    const failedResults = deleteResults.filter(r => !r.ok);
    const succeeded = deleteResults.length - failedResults.length;
    const failed = failedResults.length;
    const failedIds = failedResults.map(r => r.id);
    const succeededTargets: SoftDeleteTarget[] = deleteResults
      .filter((r) => r.ok)
      .map((r) => {
        const item = items.find((i) => i.id === r.id);
        return {
          id: r.id,
          type: item?.type === 'folder' ? 'folder' : (item?.type || 'note'),
          name: item?.name || r.id,
        };
      });

    if (failed === 0) {
      showSoftDeleteUndoToast(succeededTargets);
      clearSelection();
    } else if (succeeded > 0) {
      showSoftDeleteUndoToast(succeededTargets);
      showGlobalNotification('warning',
        t('finder.batch.deletePartial', { succeeded, failed }) +
        ' ' + t('finder.batch.failedItemsSelected')
      );

      // ★ 只保留失败项的选择
      const newSelected = new Set(failedIds);
      setSelectedIds(newSelected);

      debugLog.error('[LearningHub] 批量删除部分失败:', {
        failedIds,
        errors: failedResults.map(r => ({ id: r.id, error: r.error })),
      });
    } else {
      // 全部失败
      const firstError = failedResults[0];
      showGlobalNotification('error', firstError?.error || t('finder.batch.deleteFailed'));
    }

    handleRefresh();
  } finally {
    // ★ 使用 finally 确保状态恢复，即使操作失败
    if (isMountedRef.current) {
      setIsBatchProcessing(false);
    }
  }
}

export interface TrashItemContext {
  isMountedRef: IsMountedRef;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
}

// ★ 2025-12-11: 回收站相关操作
// 恢复项目
export async function restoreTrashItem(
  { isMountedRef, t, handleRefresh }: TrashItemContext,
  id: string,
  itemType: string,
): Promise<void> {
  const result = await trashApi.restoreItem(id, itemType);

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  if (result.ok) {
    showGlobalNotification('success', t('finder.trash.restoreSuccessWithReindex'));
    handleRefresh();
  } else {
    reportError(result.error, 'restore item');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

// ★ 执行永久删除操作（AlertDialog 确认后调用）
export async function permanentlyDeleteTrashItem(
  { isMountedRef, t, handleRefresh }: TrashItemContext,
  id: string,
  itemType: string,
): Promise<void> {
  const result = await trashApi.permanentlyDelete(id, itemType);

  // ★ 悬挂引用清理：永久删除后移除对应桌面快捷方式（不可恢复，无需快照）
  if (result.ok) {
    useDesktopStore.getState().pruneShortcutsForTargets([id]);
  }

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  if (result.ok) {
    showGlobalNotification('success', t('finder.trash.deleteSuccess'));
    handleRefresh();
  } else {
    reportError(result.error, 'permanent delete');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

export interface EmptyTrashContext extends TrashItemContext {
  softDeleteUndoGenRef: React.MutableRefObject<number>;
  isTrashView: boolean;
  items: DstuNode[];
}

// ★ 执行清空回收站操作（AlertDialog 确认后调用）
export async function emptyTrashBin({
  isMountedRef,
  softDeleteUndoGenRef,
  isTrashView,
  items,
  t,
  handleRefresh,
}: EmptyTrashContext): Promise<void> {
  const result = await trashApi.emptyTrash();

  // ★ MEDIUM-005: 检查组件是否已卸载
  if (!isMountedRef.current) return;

  if (result.ok) {
    softDeleteUndoGenRef.current += 1;
    // ★ 悬挂引用清理：清空回收站后按当前回收站列表移除桌面快捷方式
    //（列表可能被分页截断，属尽力清理；残余悬挂项打开时仍有 resourceNotFound 提示）
    if (isTrashView && items.length > 0) {
      useDesktopStore.getState().pruneShortcutsForTargets(items.map((item) => item.id));
    }
    showGlobalNotification('success', t('finder.trash.emptySuccess') + ` (${result.value})`);
    handleRefresh();
  } else {
    reportError(result.error, 'empty trash');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

export interface ConfirmPendingDeleteContext {
  deleteTarget: DeleteConfirmTarget | null;
  setIsDeleting: React.Dispatch<React.SetStateAction<boolean>>;
  items: DstuNode[];
  isMountedRef: IsMountedRef;
  t: SidebarT;
  clearSelection: () => void;
  handleRefresh: () => Promise<void>;
  executePermanentDelete: (id: string, itemType: string) => Promise<void>;
  executeEmptyTrash: () => Promise<void>;
  setDeleteConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDeleteTarget: React.Dispatch<React.SetStateAction<DeleteConfirmTarget | null>>;
}

// ★ AlertDialog 确认删除处理
export async function confirmPendingDelete({
  deleteTarget,
  setIsDeleting,
  items,
  isMountedRef,
  t,
  clearSelection,
  handleRefresh,
  executePermanentDelete,
  executeEmptyTrash,
  setDeleteConfirmOpen,
  setDeleteTarget,
}: ConfirmPendingDeleteContext): Promise<void> {
  if (!deleteTarget) return;

  setIsDeleting(true);
  try {
    switch (deleteTarget.type) {
      case 'batch':
        // 仅回收站批永久删走确认框
        if (deleteTarget.batchIds) {
          const idsArray = Array.from(deleteTarget.batchIds);
          let succeeded = 0;
          let failed = 0;
          const succeededIds: string[] = [];
          for (const id of idsArray) {
            const item = items.find(i => i.id === id);
            if (!item) { failed++; continue; }
            const result = await trashApi.permanentlyDelete(id, item.type);
            if (result.ok) { succeeded++; succeededIds.push(id); } else { failed++; }
          }
          // ★ 悬挂引用清理：批量永久删除后移除对应桌面快捷方式
          if (succeededIds.length > 0) {
            useDesktopStore.getState().pruneShortcutsForTargets(succeededIds);
          }
          if (!isMountedRef.current) break;
          if (failed === 0) {
            showGlobalNotification('success', t('finder.trash.batchDeleteSuccess', { count: succeeded }));
          } else if (succeeded > 0) {
            showGlobalNotification('warning', t('finder.trash.batchDeletePartial', { succeeded, failed }));
          } else {
            showGlobalNotification('error', t('finder.trash.batchDeleteFailed'));
          }
          clearSelection();
          handleRefresh();
        }
        break;
      case 'permanent':
        if (deleteTarget.permanentDeleteInfo) {
          await executePermanentDelete(
            deleteTarget.permanentDeleteInfo.id,
            deleteTarget.permanentDeleteInfo.itemType
          );
        }
        break;
      case 'emptyTrash':
        await executeEmptyTrash();
        break;
    }
  } finally {
    setIsDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }
}
