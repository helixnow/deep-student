import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DstuNode } from '@/dstu';
import { getMemoryConfig } from '@/api/memoryApi';
import {
  getMemoryFolderLabelKey,
  isPathInMemoryRoot,
  localizeMemoryBreadcrumbs,
  localizeMemoryFolderTitle,
  type MemoryRootRef,
} from '../memoryFolderLabels';
import type { QuickAccessType } from '../stores/finderStore';
import type { EffectiveFinderPath, SidebarT } from './sidebarConstants';

/** 记忆根文件夹跟踪 + 记忆系统文件夹的显示层本地化 */
export function useMemoryFolderDisplay({
  effectivePath,
  baseQuickAccessType,
  t,
}: {
  effectivePath: EffectiveFinderPath;
  baseQuickAccessType: QuickAccessType | null;
  t: SidebarT;
}) {
  // ★ 记忆系统改造：跟踪记忆根文件夹 ID，用于高亮侧边栏
  // 在组件挂载和 viewKind 变化时刷新（用户可能通过 MemoryView 设置了根文件夹后返回）
  const [memoryRootFolderId, setMemoryRootFolderId] = useState<string | null>(null);
  const refreshMemoryRootFolderId = useCallback(() => {
    getMemoryConfig().then(c => setMemoryRootFolderId(c.memoryRootFolderId)).catch(() => {});
  }, []);
  useEffect(() => { refreshMemoryRootFolderId(); }, [refreshMemoryRootFolderId, effectivePath.viewKind]);

  // 判断当前是否在记忆文件夹内（检查面包屑中是否包含记忆根文件夹）
  const isInMemoryFolder = memoryRootFolderId != null && (
    effectivePath.folderId === memoryRootFolderId ||
    effectivePath.breadcrumbs?.some(b => b.id === memoryRootFolderId)
  );
  const currentQuickAccessType = isInMemoryFolder ? 'memory' as QuickAccessType : baseQuickAccessType;

  // 记忆系统文件夹（记忆/经历/学科状态…）存储名为中文且被智能体工具按路径寻址，
  // 仅在显示层按界面语言本地化；重命名仍编辑存储名
  const memoryRoot = useMemo<MemoryRootRef | null>(
    () => (memoryRootFolderId ? { id: memoryRootFolderId } : null),
    [memoryRootFolderId],
  );
  const displayBreadcrumbs = useMemo(
    () => localizeMemoryBreadcrumbs(effectivePath.breadcrumbs, memoryRoot, t),
    [effectivePath.breadcrumbs, memoryRoot, t],
  );
  const getItemDisplayName = useCallback((item: DstuNode): string | undefined => {
    if (item.type !== 'folder' || !getMemoryFolderLabelKey(item.name)) return undefined;
    const inMemory = isInMemoryFolder
      || (memoryRootFolderId != null && item.id === memoryRootFolderId)
      || isPathInMemoryRoot(item.path, memoryRoot);
    return inMemory ? localizeMemoryFolderTitle(item.name, t) : undefined;
  }, [isInMemoryFolder, memoryRoot, memoryRootFolderId, t]);
  return { isInMemoryFolder, currentQuickAccessType, displayBreadcrumbs, getItemDisplayName };
}
