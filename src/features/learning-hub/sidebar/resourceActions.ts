import type React from 'react';
import { dstu, folderApi, type DstuNode } from '@/dstu';
import { reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { pLimit } from '@/utils/concurrency';
import type { ResourceListItem } from '../types';
import type { SidebarT, SoftDeleteTarget } from './sidebarConstants';

export interface ToggleFavoriteContext {
  items: DstuNode[];
  t: SidebarT;
  isMountedRef: React.MutableRefObject<boolean>;
  handleRefresh: () => Promise<void>;
}

// P1-14: 右键菜单 - 收藏/取消收藏资源
export async function toggleResourceFavorite(
  { items, t, isMountedRef, handleRefresh }: ToggleFavoriteContext,
  resource: ResourceListItem,
): Promise<void> {
  // 获取资源路径
  let resourcePath = resource.path;
  if (!resourcePath) {
    const item = items.find(i => i.id === resource.id);
    resourcePath = item?.path;
  }

  if (!resourcePath) {
    showGlobalNotification('error', t('contextMenu.favoriteError'));
    return;
  }

  // 切换收藏状态
  const newFavoriteState = !resource.isFavorite;
  const result = await dstu.setFavorite(resourcePath, newFavoriteState);

  if (!isMountedRef.current) return;

  if (result.ok) {
    showGlobalNotification('success',
      newFavoriteState
        ? t('contextMenu.favoriteSuccess')
        : t('contextMenu.unfavoriteSuccess')
    );
    handleRefresh();
  } else {
    reportError(result.error, 'toggle favorite');
    showGlobalNotification('error', result.error.toUserMessage());
  }
}

export interface SpecialDropContext {
  items: DstuNode[];
  isMountedRef: React.MutableRefObject<boolean>;
  t: SidebarT;
  handleRefresh: () => Promise<void>;
  clearSelection: () => void;
  canDeleteInCurrentView: boolean;
  setIsBatchProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  showSoftDeleteUndoToast: (targets: SoftDeleteTarget[], opts?: { refCount?: number }) => void;
}

/** 拖拽到快捷目标：收藏（批量收藏资源）/ 回收站（软删除 + Undo） */
export async function dropOnSpecialTarget(
  {
    items,
    isMountedRef,
    t,
    handleRefresh,
    clearSelection,
    canDeleteInCurrentView,
    setIsBatchProcessing,
    showSoftDeleteUndoToast,
  }: SpecialDropContext,
  targetId: 'favorites' | 'trash',
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;

  if (targetId === 'favorites') {
    // 批量收藏：跳过文件夹，仅资源
    const limit = pLimit(3);
    let success = 0;
    let skipped = 0;
    let failed = 0;

    await Promise.all(itemIds.map((id) => limit(async () => {
      const item = items.find(i => i.id === id);
      if (!item || item.type === 'folder') {
        skipped += 1;
        return;
      }
      if (item.metadata?.isFavorite) {
        skipped += 1;
        return;
      }
      const resourcePath = item.path || `/${item.id}`;
      const result = await dstu.setFavorite(resourcePath, true);
      if (result.ok) success += 1;
      else failed += 1;
    })));

    if (!isMountedRef.current) return;
    if (success > 0) {
      showGlobalNotification(
        'success',
        t('finder.dragDrop.favoriteSuccess', { count: success })
      );
      handleRefresh();
      clearSelection();
    } else if (failed > 0) {
      showGlobalNotification('error', t('finder.dragDrop.favoriteFailed'));
    } else if (skipped > 0) {
      showGlobalNotification(
        'info',
        t('finder.dragDrop.favoriteSkipped')
      );
    }
    return;
  }

  // trash: 软删除（拖入回收站直接执行 + Undo）
  if (targetId === 'trash') {
    if (!canDeleteInCurrentView) return;
    setIsBatchProcessing(true);
    try {
      const limit = pLimit(3);
      const succeededTargets: SoftDeleteTarget[] = [];
      const results = await Promise.all(itemIds.map((id) => limit(async () => {
        const item = items.find(i => i.id === id);
        if (!item) return { ok: false as const };
        if (item.type === 'folder') {
          const result = await folderApi.deleteFolder(id);
          if (result.ok) succeededTargets.push({ id, type: 'folder', name: item.name });
          return { ok: result.ok };
        }
        const dstuPath = item.path || `/${item.id}`;
        const result = await dstu.delete(dstuPath);
        if (result.ok) succeededTargets.push({ id, type: item.type, name: item.name });
        return { ok: result.ok };
      })));

      if (!isMountedRef.current) return;
      const success = results.filter(r => r.ok).length;
      const failed = results.length - success;
      if (success > 0) {
        showSoftDeleteUndoToast(succeededTargets);
        if (failed > 0) {
          showGlobalNotification(
            'warning',
            t('finder.batch.deletePartial', { succeeded: success, failed })
          );
        }
        clearSelection();
        handleRefresh();
      } else {
        showGlobalNotification('error', t('finder.batch.deleteFailed'));
      }
    } finally {
      if (isMountedRef.current) setIsBatchProcessing(false);
    }
  }
}
