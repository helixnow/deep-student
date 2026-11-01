import type React from 'react';
import type { DstuNode } from '@/dstu';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { dstuNodeToResourceListItem, mapDstuTypeToFolderItemType } from '../types';
import type { FinderPath } from '../stores/finderStore';
import type { ContextMenuTarget } from '../components/LearningHubContextMenu';
import { isPendingFolderId, type EffectiveFinderPath } from './sidebarConstants';

export interface ContextMenuHandlersContext {
  setContextMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  currentPath: FinderPath;
  setContextMenuTarget: React.Dispatch<React.SetStateAction<ContextMenuTarget>>;
  setContextMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  effectivePath: EffectiveFinderPath;
  handleNewNote: () => Promise<void>;
  handleNewExam: () => Promise<void>;
  handleNewTranslation: () => Promise<void>;
  handleNewEssay: () => Promise<void>;
  handleNewMindMap: () => Promise<void>;
}

/** 项右键 / 空白区域右键 / 空状态「新建」 */
export function createContextMenuHandlers({
  setContextMenuPosition,
  currentPath,
  setContextMenuTarget,
  setContextMenuOpen,
  effectivePath,
  handleNewNote,
  handleNewExam,
  handleNewTranslation,
  handleNewEssay,
  handleNewMindMap,
}: ContextMenuHandlersContext) {
  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, item: DstuNode) => {
    if (isPendingFolderId(item.id)) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到容器，避免触发空白区域菜单
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    
    if (item.type === 'folder') {
      // 构造符合 FolderTreeNode 类型的对象
      const folderNode: FolderTreeNode = {
        folder: {
          id: item.id,
          parentId: currentPath.folderId,
          title: item.name,
          isExpanded: false,
          sortOrder: 0,
          createdAt: item.createdAt || Date.now(),
          updatedAt: item.updatedAt,
        },
        children: [],
        items: [],
      };
      setContextMenuTarget({ 
        type: 'folder', 
        folder: folderNode
      });
    } else {
      // Map to ResourceListItem（共用映射：此前这里漏掉 image/file，导致附件右键动作按 note 处理）
      const resourceItem = dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type));
      setContextMenuTarget({ type: 'resource', resource: resourceItem });
    }
    setContextMenuOpen(true);
  };

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    // 移除 e.target === e.currentTarget 检查，因为虚拟滚动列表内部的空白区域可能不是容器本身
    // 项的右键已通过 handleContextMenu 处理并调用 stopPropagation 阻止冒泡
    e.preventDefault();
    // 键盘触发（Enter/Space）或程序化点击时事件坐标为 (0,0)：按触发元素位置弹出，
    // 否则菜单落在窗口左上角盖住红绿灯
    const anchor = e.clientX === 0 && e.clientY === 0 && e.currentTarget instanceof Element
      ? e.currentTarget.getBoundingClientRect()
      : null;
    setContextMenuPosition(anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: e.clientX, y: e.clientY });
    setContextMenuTarget({ type: 'empty' });
    setContextMenuOpen(true);
  };

  // 空状态「新建」：按类型过滤的视图（全部作文 / 全部笔记…）直接新建该类型，
  // 其余视图弹出与右键相同的新建菜单
  const handleEmptyStateCreate = (e: React.MouseEvent) => {
    const typeFilter = effectivePath.typeFilter;
    const direct: Partial<Record<string, () => Promise<void>>> = {
      note: handleNewNote,
      exam: handleNewExam,
      translation: handleNewTranslation,
      essay: handleNewEssay,
      mindmap: handleNewMindMap,
    };
    const create = typeFilter ? direct[typeFilter] : undefined;
    if (create) {
      void create();
      return;
    }
    handleContainerContextMenu(e);
  };

  return { handleContextMenu, handleContainerContextMenu, handleEmptyStateCreate };
}
