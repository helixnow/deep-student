import { useMemo } from 'react';
import type { LearningHubSidebarProps } from '../types';
import type { EffectiveFinderPath, SidebarT } from './sidebarConstants';
import type { useMemoryFolderDisplay } from './useMemoryFolderDisplay';

/** 拖拽时的面包屑祖先目标与收藏 / 回收站快捷目标 */
export function useDropTargets({
  canDragDropInCurrentView,
  mode,
  effectivePath,
  displayBreadcrumbs,
  t,
}: {
  canDragDropInCurrentView: boolean;
  mode: LearningHubSidebarProps['mode'];
  effectivePath: EffectiveFinderPath;
  displayBreadcrumbs: ReturnType<typeof useMemoryFolderDisplay>['displayBreadcrumbs'];
  t: SidebarT;
}) {
  // 拖拽时可放置的面包屑祖先（含根目录）——对齐访达「拖到路径栏」
  const parentDropTargets = useMemo(() => {
    if (!canDragDropInCurrentView || mode === 'canvas') return undefined;
    if (effectivePath.viewKind !== 'folder') return undefined;
    // 仅在子目录时显示（根目录无更上级）
    if (!effectivePath.folderId && effectivePath.breadcrumbs.length === 0) return undefined;

    const targets: Array<{ id: string | null; label: string }> = [
      { id: null, label: t('learningHub:title') },
    ];
    // 不含当前目录自身（最后一个 breadcrumb）
    const ancestors = displayBreadcrumbs.slice(0, -1);
    for (const crumb of ancestors) {
      targets.push({ id: crumb.id, label: crumb.name });
    }
    return targets;
  }, [canDragDropInCurrentView, mode, effectivePath.viewKind, effectivePath.folderId, effectivePath.breadcrumbs.length, displayBreadcrumbs, t]);

  // 拖拽快捷目标：收藏 / 回收站（拖拽时出现在列表顶栏）
  const specialDropTargets = useMemo(() => {
    if (!canDragDropInCurrentView || mode === 'canvas') return undefined;
    return [
      { id: 'favorites' as const, label: t('finder.quickAccess.favorites') },
      { id: 'trash' as const, label: t('finder.quickAccess.trash') },
    ];
  }, [canDragDropInCurrentView, mode, t]);

  return { parentDropTargets, specialDropTargets };
}
