import type { DstuNode } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { dstuNodeToResourceListItem, mapDstuTypeToFolderItemType } from '../types';
import type { LearningHubSidebarProps } from '../types';
import { resolveQuickAccessType } from '../learningHubContracts';
import type { FinderPath, QuickAccessType } from '../stores/finderStore';
import type { RecentItem } from '../stores/recentStore';
import type { SidebarT } from './sidebarConstants';

export interface OpenHandlersContext {
  currentPath: FinderPath;
  addRecent: (item: Omit<RecentItem, 'accessedAt'>) => void;
  handleQuickAccessNavigate: (type: QuickAccessType) => Promise<void>;
  enterFolder: (folderId: string, folderName?: string, folderPath?: string) => Promise<void>;
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
  onOpenPreview: LearningHubSidebarProps['onOpenPreview'];
  setQuickLookItem: (item: DstuNode | null) => void;
  t: SidebarT;
}

/** 打开项 / Quick Look 打开 / 多选打开（访达语义） */
export function createOpenHandlers({
  currentPath,
  addRecent,
  handleQuickAccessNavigate,
  enterFolder,
  onOpenApp,
  onOpenPreview,
  setQuickLookItem,
  t,
}: OpenHandlersContext) {
  // Handle open item
  const handleOpen = (item: DstuNode) => {
    // ★ Bug Fix: 回收站中的资源不应记录为最近访问
    if (item.type !== 'folder' && currentPath.viewKind !== 'trash') {
      addRecent({
        id: item.id,
        path: item.path,
        name: item.name,
        type: item.type,
      });
    }

    if (item.type === 'folder') {
      // 检测虚拟类型文件夹
      // 虚拟类型文件夹的 ID 格式为 type_{type}，如 type_notes
      if (item.id.startsWith('type_')) {
        // 解析类型：type_化学_notes -> notes
        const parts = item.id.split('_');
        const typeSegment = parts[parts.length - 1]; // 最后一段是类型
        const quickAccessType = resolveQuickAccessType(typeSegment);
        if (quickAccessType) {
          handleQuickAccessNavigate(quickAccessType);
          return;
        }
      }
      // 真实文件夹：使用 folderId 导航，传递后端返回的 path
      enterFolder(item.id, item.name, item.path);
    } else {
      if (onOpenApp) {
        const resourceItem = dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type));
        onOpenApp(resourceItem);
      }
    }
  };

  // ★ Quick Look「打开」：非文件夹优先走 onOpenPreview（全屏预览契约），
  // 未提供时回退 handleOpen（onOpenApp）；文件夹直接导航。
  const handleQuickLookOpen = (item: DstuNode) => {
    setQuickLookItem(null);
    if (item.type !== 'folder' && onOpenPreview) {
      if (currentPath.viewKind !== 'trash') {
        addRecent({ id: item.id, path: item.path, name: item.name, type: item.type });
      }
      onOpenPreview(dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type)));
      return;
    }
    handleOpen(item);
  };

  // ★ 多选 + Enter：打开全部选中项（访达语义）。
  // 文件夹无法并行导航：仅当选中项全是文件夹时进入第一个；
  // 资源打开数量设上限，避免一次 Enter 炸出几十个窗口。
  const OPEN_ALL_LIMIT = 12;
  const handleOpenMany = (itemsToOpen: DstuNode[]) => {
    const resources = itemsToOpen.filter((item) => item.type !== 'folder');
    if (resources.length === 0) {
      const firstFolder = itemsToOpen.find((item) => item.type === 'folder');
      if (firstFolder) handleOpen(firstFolder);
      return;
    }
    const toOpen = resources.slice(0, OPEN_ALL_LIMIT);
    toOpen.forEach((item) => handleOpen(item));
    if (resources.length > toOpen.length) {
      showGlobalNotification(
        'info',
        t('finder.multiSelect.openAllLimited', { count: toOpen.length, total: resources.length })
      );
    }
  };

  return { handleOpen, handleQuickLookOpen, handleOpenMany };
}

export type OpenHandlers = ReturnType<typeof createOpenHandlers>;
