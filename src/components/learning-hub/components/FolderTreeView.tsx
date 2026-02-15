/**
 * 文件夹树视图组件
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md
 *
 * Prompt 7: Learning Hub 文件夹视图改造
 *
 * 功能：
 * - 文件夹树渲染
 * - 拖拽排序（使用 @hello-pangea/dnd）
 * - 新建文件夹
 * - 右键菜单
 * - 支持亮暗色模式
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useTranslation } from 'react-i18next';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
  type DraggableProvided,
  type DroppableProvided,
} from '@hello-pangea/dnd';
import {
  FolderPlus,
  AlertCircle,
  Folder,
  FolderOpen,
  RefreshCw,
  FileText,
  ClipboardList,
  BookOpen,
  FileCode,
  Languages,
  PenTool,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Image,
  File,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { FolderTreeItem } from './FolderTreeItem';
import {
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import type { FolderTreeNode, VfsFolderItem, FolderItemType, VfsFolder } from '@/dstu/types/folder';

// ============================================================================
// 右键菜单 Portal 组件
// ============================================================================

interface ContextMenuPortalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: { x: number; y: number };
  children: React.ReactNode;
}

/**
 * 右键菜单 Portal
 */
const ContextMenuPortal: React.FC<ContextMenuPortalProps> = ({
  open,
  onOpenChange,
  position,
  children,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState(position);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onOpenChange]);

  // 计算菜单位置
  useEffect(() => {
    if (!open || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = position.x;
    let y = position.y;

    if (x + rect.width > viewportWidth - 8) {
      x = viewportWidth - rect.width - 8;
    }
    if (y + rect.height > viewportHeight - 8) {
      y = viewportHeight - rect.height - 8;
    }
    x = Math.max(8, x);
    y = Math.max(8, y);

    setMenuPosition({ x, y });
  }, [open, position]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="app-menu-content"
      style={{
        position: 'fixed',
        top: menuPosition.y,
        left: menuPosition.x,
        zIndex: Z_INDEX.contextMenu,
        minWidth: '180px',
      }}
      role="menu"
      onClick={() => onOpenChange(false)}
    >
      {children}
    </div>,
    document.body
  );
};

// ============================================================================
// 类型定义
// ============================================================================

/** 新建内容类型 */
export type CreateItemType = 'note' | 'exam' | 'textbook' | 'document' | 'translation' | 'essay';

export interface FolderTreeViewProps {
  /** 文件夹树数据 */
  folderTree: FolderTreeNode[];
  /** 根级内容项（不在文件夹中的笔记等） */
  rootItems?: VfsFolderItem[];
  /** 当前选中项 ID */
  selectedId: string | null;
  /** 选中类型 */
  selectedType?: 'folder' | 'item' | null;
  /** 加载状态 */
  isLoading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 选中回调 */
  onSelect: (id: string, type: 'folder' | 'item') => void;
  /** 创建文件夹回调 */
  onCreateFolder: (parentId: string | null, title: string) => void;
  /** 重命名文件夹回调 */
  onRenameFolder: (folderId: string, newTitle: string) => void;
  /** 删除文件夹回调 */
  onDeleteFolder: (folderId: string) => void;
  /** 移动文件夹回调 */
  onMoveFolder?: (folderId: string, newParentId: string | null) => void;
  /** 展开/收起回调 */
  onToggleExpand: (folderId: string, isExpanded: boolean) => void;
  /** 移动内容回调 */
  onMoveItem?: (itemType: FolderItemType, itemId: string, targetFolderId: string | null) => void;
  /** 排序回调 */
  onReorder?: (folderIds: string[]) => void;
  /** 渲染内容项 */
  renderItem?: (item: VfsFolderItem, depth: number) => React.ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 最大高度 */
  maxHeight?: string | number;
  /** 新建内容回调（笔记、题目集识别等） */
  onCreateItem?: (type: CreateItemType, folderId: string | null) => void;
  /** 刷新回调 */
  onRefresh?: () => void;
  /** 文件夹引用到对话回调（Prompt 9/10） */
  onFolderReferenceToChat?: (folderId: string) => void;
  /** 视图模式 */
  viewMode?: 'list' | 'grid';
  /** 打开内容项回调 */
  onOpenItem?: (item: VfsFolderItem) => void;
  
  // ========== 面包屑导航（提升到父组件管理） ==========
  /** 当前文件夹 ID */
  currentFolderId?: string | null;
  /** 导航到文件夹回调 */
  onFolderNavigate?: (folderId: string | null) => void;
  
  // ========== 统一右键菜单（由父组件管理） ==========
  /** 右键菜单回调 - 如果提供，则使用父组件的统一菜单 */
  onContextMenu?: (e: React.MouseEvent, target: { type: 'empty' } | { type: 'folder'; folder: FolderTreeNode } | { type: 'folderItem'; item: VfsFolderItem }) => void;
  
  // ========== 外部触发新建文件夹 ==========
  /** 外部请求新建文件夹的父 ID，'ROOT' 表示根目录 */
  pendingCreateParentId?: string | null;
  /** 消费触发后的回调 */
  onPendingCreateConsumed?: () => void;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 文件夹树视图组件
 */
export const FolderTreeView: React.FC<FolderTreeViewProps> = ({
  folderTree,
  rootItems = [],
  selectedId,
  selectedType,
  isLoading = false,
  error = null,
  onSelect,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
  onToggleExpand,
  onMoveItem,
  onReorder,
  renderItem,
  disabled = false,
  className,
  maxHeight = '100%',
  onCreateItem,
  onRefresh,
  onFolderReferenceToChat,
  viewMode = 'list',
  onOpenItem,
  currentFolderId: externalCurrentFolderId,
  onFolderNavigate,
  onContextMenu: externalContextMenu,
  pendingCreateParentId,
  onPendingCreateConsumed,
}) => {
  const { t } = useTranslation('learningHub');

  // 当前路径状态（优先使用外部传入，否则使用内部状态）
  const [internalFolderId, setInternalFolderId] = useState<string | null>(null);
  
  // 实际使用的 currentFolderId
  const currentFolderId = externalCurrentFolderId !== undefined ? externalCurrentFolderId : internalFolderId;

  // 新建文件夹状态
  const [isCreating, setIsCreating] = useState(false);
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [createParentId, setCreateParentId] = useState<string | null>(null);

  // 拖拽状态
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggedType, setDraggedType] = useState<'folder' | 'item' | null>(null);

  // 右键菜单状态
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  // ==========================================================================
  // 显示内容计算
  // ==========================================================================

  // 获取当前显示的文件夹列表
  const displayFolders = useMemo(() => {
    if (!currentFolderId) return folderTree;
    const currentNode = findNodeById(folderTree, currentFolderId);
    return currentNode?.children || [];
  }, [folderTree, currentFolderId]);

  // 获取当前显示的内容项列表
  const displayItems = useMemo(() => {
    // 根目录时显示 rootItems
    if (!currentFolderId) return rootItems;
    const currentNode = findNodeById(folderTree, currentFolderId);
    return currentNode?.items || [];
  }, [folderTree, currentFolderId, rootItems]);

  // 导航到文件夹
  const navigateToFolder = useCallback((folderId: string | null) => {
    if (onFolderNavigate) {
      onFolderNavigate(folderId);
    } else {
      setInternalFolderId(folderId);
    }
  }, [onFolderNavigate]);

  // 双击进入文件夹
  const handleDoubleClickFolder = useCallback((folderId: string) => {
    navigateToFolder(folderId);
  }, [navigateToFolder]);

  // 双击打开内容项
  const handleDoubleClickItem = useCallback((item: VfsFolderItem) => {
    onOpenItem?.(item);
  }, [onOpenItem]);

  // ==========================================================================
  // 右键菜单
  // ==========================================================================

  // 空白区域右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      
      // 如果提供了外部回调，使用统一菜单
      if (externalContextMenu) {
        externalContextMenu(e, { type: 'empty' });
        return;
      }
      
      // 否则使用内部菜单
      setContextMenuPosition({ x: e.clientX, y: e.clientY });
      setContextMenuOpen(true);
    },
    [disabled, externalContextMenu]
  );
  
  // 文件夹项右键菜单
  const handleFolderContextMenu = useCallback(
    (e: React.MouseEvent, folder: FolderTreeNode) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      
      // 如果提供了外部回调，使用统一菜单
      if (externalContextMenu) {
        externalContextMenu(e, { type: 'folder', folder });
        return;
      }
      
      // 否则使用内部菜单（选中该文件夹后显示菜单）
      onSelect(folder.folder.id, 'folder');
      setContextMenuPosition({ x: e.clientX, y: e.clientY });
      setContextMenuOpen(true);
    },
    [disabled, externalContextMenu, onSelect]
  );
  
  // 内容项右键菜单
  const handleItemContextMenu = useCallback(
    (e: React.MouseEvent, item: VfsFolderItem) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      
      // 如果提供了外部回调，使用统一菜单
      if (externalContextMenu) {
        externalContextMenu(e, { type: 'folderItem', item });
        return;
      }
      
      // 否则使用内部菜单
      onSelect(item.id, 'item');
      setContextMenuPosition({ x: e.clientX, y: e.clientY });
      setContextMenuOpen(true);
    },
    [disabled, externalContextMenu, onSelect]
  );

  // ==========================================================================
  // 新建文件夹
  // ==========================================================================

  // 默认文件夹名称
  const defaultFolderName = t('folder.newFolder', '新建文件夹');

  const handleStartCreate = useCallback((parentId: string | null = null) => {
    setIsCreating(true);
    setNewFolderTitle(defaultFolderName);
    setCreateParentId(parentId);
  }, [defaultFolderName]);

  const handleFinishCreate = useCallback(() => {
    const title = newFolderTitle.trim() || defaultFolderName;
    onCreateFolder(createParentId, title);
    setIsCreating(false);
    setNewFolderTitle('');
    setCreateParentId(null);
  }, [newFolderTitle, createParentId, onCreateFolder, defaultFolderName]);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewFolderTitle('');
    setCreateParentId(null);
  }, []);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleFinishCreate();
      } else if (e.key === 'Escape') {
        handleCancelCreate();
      }
    },
    [handleFinishCreate, handleCancelCreate]
  );

  // 监听外部触发新建文件夹
  useEffect(() => {
    if (pendingCreateParentId !== undefined) {
      handleStartCreate(pendingCreateParentId);
      onPendingCreateConsumed?.();
    }
  }, [pendingCreateParentId, handleStartCreate, onPendingCreateConsumed]);

  // ==========================================================================
  // 拖拽处理
  // ==========================================================================

  const handleDragStart = useCallback(
    (e: React.DragEvent, nodeId: string, type: 'folder' | 'item') => {
      setDraggedId(nodeId);
      setDraggedType(type);
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: nodeId, type }));
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, targetFolderId: string | null) => {
      e.preventDefault();
      
      if (!draggedId || !draggedType) return;
      
      // 不能拖到自己
      if (draggedType === 'folder' && draggedId === targetFolderId) {
        return;
      }

      if (draggedType === 'folder' && onMoveFolder) {
        onMoveFolder(draggedId, targetFolderId);
      } else if (draggedType === 'item' && onMoveItem) {
        // 需要从 draggedId 解析 itemType 和 itemId
        // 这里假设格式是 `${itemType}:${itemId}`
        const [itemType, itemId] = draggedId.split(':');
        if (itemType && itemId) {
          onMoveItem(itemType as FolderItemType, itemId, targetFolderId);
        }
      }

      setDraggedId(null);
      setDraggedType(null);
    },
    [draggedId, draggedType, onMoveFolder, onMoveItem]
  );

  // @hello-pangea/dnd 拖拽结束
  const handleDragEnd = useCallback(
    (result: DropResult) => {
      const { destination, source, draggableId } = result;

      // 没有目标位置
      if (!destination) return;

      // 位置没变
      if (
        destination.droppableId === source.droppableId &&
        destination.index === source.index
      ) {
        return;
      }

      // 重新排序
      if (onReorder && destination.droppableId === source.droppableId) {
        // 获取同级文件夹列表
        const parentId = source.droppableId === 'root' ? null : source.droppableId;
        const siblings = parentId === null
          ? folderTree.map((n) => n.folder.id)
          : (findNodeById(folderTree, parentId)?.children || []).map((n) => n.folder.id);

        // 重新排序
        const newOrder = [...siblings];
        const [removed] = newOrder.splice(source.index, 1);
        newOrder.splice(destination.index, 0, removed);

        onReorder(newOrder);
      }
    },
    [folderTree, onReorder]
  );

  // ==========================================================================
  // 辅助函数
  // ==========================================================================

  // 扁平化文件夹列表（用于拖拽排序）
  const flatFolders = useMemo(() => {
    const result: { node: FolderTreeNode; parentId: string | null }[] = [];
    const traverse = (nodes: FolderTreeNode[], parentId: string | null) => {
      nodes.forEach((node) => {
        result.push({ node, parentId });
        if (node.children.length > 0) {
          traverse(node.children, node.folder.id);
        }
      });
    };
    traverse(folderTree, null);
    return result;
  }, [folderTree]);

  // ==========================================================================
  // 渲染
  // ==========================================================================

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('p-4 space-y-2', className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="w-4 h-4" />
            <Skeleton className="w-4 h-4" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('p-4 flex flex-col items-center gap-2 text-muted-foreground', className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-sm text-center">{error}</p>
      </div>
    );
  }

  // 空状态
  if (folderTree.length === 0 && !isCreating) {
    return (
      <div 
        className={cn('p-4 flex flex-col items-center gap-3 h-full', className)}
        onContextMenu={handleContextMenu}
      >
        <FolderOpen className="w-12 h-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground text-center">
          {t('folderView.emptyFolder')}
        </p>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => handleStartCreate(null)}
          disabled={disabled}
        >
          <FolderPlus className="w-4 h-4 mr-2" />
          {t('folder.newFolder')}
        </NotionButton>

        {/* 右键菜单 - 仅在未提供外部菜单时使用内部菜单 */}
        {!externalContextMenu && (
          <ContextMenuPortal
            open={contextMenuOpen}
            onOpenChange={setContextMenuOpen}
            position={contextMenuPosition}
          >
            {/* 新建文件夹 */}
            <AppMenuItem 
              icon={<FolderPlus className="w-4 h-4" />} 
              onClick={() => handleStartCreate(null)}
            >
              {t('folder.newFolder')}
            </AppMenuItem>
            <AppMenuSeparator />
            {/* 新建各种内容 */}
            <AppMenuItem 
              icon={<FileText className="w-4 h-4" />} 
              onClick={() => {
                onCreateItem?.('note', null);
                setContextMenuOpen(false);
              }}
            >
              {t('contextMenu.newNote', '新建笔记')}
            </AppMenuItem>
            <AppMenuItem 
              icon={<ClipboardList className="w-4 h-4" />} 
              onClick={() => {
                onCreateItem?.('exam', null);
                setContextMenuOpen(false);
              }}
            >
              {t('contextMenu.newExam', '新建题目集识别')}
            </AppMenuItem>
            <AppMenuItem 
              icon={<BookOpen className="w-4 h-4" />} 
              onClick={() => {
                onCreateItem?.('textbook', null);
                setContextMenuOpen(false);
              }}
            >
              {t('contextMenu.newTextbook', '导入教材')}
            </AppMenuItem>
            <AppMenuItem 
              icon={<Languages className="w-4 h-4" />} 
              onClick={() => {
                onCreateItem?.('translation', null);
                setContextMenuOpen(false);
              }}
            >
              {t('contextMenu.newTranslation', '新建翻译')}
            </AppMenuItem>
            <AppMenuItem 
              icon={<PenTool className="w-4 h-4" />} 
              onClick={() => {
                onCreateItem?.('essay', null);
                setContextMenuOpen(false);
              }}
            >
              {t('contextMenu.newEssay', '新建作文')}
            </AppMenuItem>
            <AppMenuSeparator />
            {/* 刷新 */}
            <AppMenuItem 
              icon={<RefreshCw className="w-4 h-4" />} 
              onClick={() => {
                onRefresh?.();
                setContextMenuOpen(false);
              }}
            >
              {t('common.refresh', '刷新')}
            </AppMenuItem>
          </ContextMenuPortal>
        )}
      </div>
    );
  }

  return (
    <div 
      className={cn('flex flex-col h-full', className)} 
      style={{ maxHeight }}
      onContextMenu={handleContextMenu}
    >
      {/* 文件夹视图内容 */}
      <CustomScrollArea 
        className="flex-1" 
        viewportClassName="h-full"
        viewportProps={{ onContextMenu: handleContextMenu }}
      >
        <div className="min-h-full">
          {viewMode === 'grid' ? (
            // ================= Grid View =================
            // 使用 auto-fill + minmax 让网格自适应容器宽度，避免窄宽度时挤压
            <>
              {/* Grid 模式新建文件夹输入框 */}
              {isCreating && createParentId === null && (
                <div className="flex items-center gap-1 px-3 py-1 m-2 bg-muted/30 rounded-md border border-border/50">
                  <FolderPlus className="w-4 h-4 text-amber-500" />
                  <Input
                    autoFocus
                    value={newFolderTitle}
                    onChange={(e) => setNewFolderTitle(e.target.value)}
                    onBlur={handleFinishCreate}
                    onKeyDown={handleCreateKeyDown}
                    placeholder={t('folder.folderNamePlaceholder')}
                    className="h-6 text-sm flex-1 bg-transparent border-none focus-visible:ring-0"
                  />
                </div>
              )}
              <div
                className="grid gap-2 p-3 pb-20 select-none"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))' }}
                onClick={() => onSelect?.(null!, 'folder')} // 点击空白处取消选择
              >
              {/* 渲染文件夹 */}
              {displayFolders.map((node) => {
                const isSelected = selectedId === node.folder.id;
                return (
                  <div
                    key={node.folder.id}
                    className="flex justify-center h-[68px] overflow-hidden"
                  >
                    <NotionButton
                      variant="ghost" size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(node.folder.id, 'folder');
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleDoubleClickFolder(node.folder.id);
                      }}
                      onContextMenu={(e) => handleFolderContextMenu(e, node)}
                      className="group relative !h-full !p-0 flex-col items-center w-full max-w-[60px]"
                    >
                      {/* 图标 */}
                      <div className="relative w-8 h-8 shrink-0 flex items-center justify-center transition-transform duration-200 group-hover:scale-105">
                        <div className="w-7 h-7 flex items-center justify-center text-amber-500 dark:text-amber-400">
                          <Folder className="w-6 h-6 stroke-[1.5] fill-amber-500/20" />
                        </div>
                      </div>
                      {/* 标题 - 固定高度，最多2行 */}
                      <div className={cn(
                        "mt-0.5 px-0.5 py-0.5 rounded-[2px] w-full overflow-hidden",
                        isSelected
                          ? "bg-primary"
                          : "group-hover:bg-muted/30"
                      )}>
                        <span className={cn(
                          "text-[9px] leading-[1.2] text-center block line-clamp-2 break-all",
                          isSelected ? "text-white font-medium" : "text-foreground"
                        )}>
                          {node.folder.title}
                        </span>
                      </div>
                    </NotionButton>
                  </div>
                );
              })}

              {/* 渲染内容项 */}
              {displayItems.map((item) => {
                const isSelected = selectedId === item.id;
                
                // ★ P2 改造：支持混合类型显示（27-DSTU统一虚拟路径架构改造设计.md）
                // 获取图标和颜色
                let Icon = FileText;
                let colorClass = "text-blue-500";
                
                switch (item.itemType) {
                  case 'note': Icon = FileText; colorClass = "text-blue-500"; break;
                  case 'textbook': Icon = BookOpen; colorClass = "text-emerald-500"; break;
                  case 'exam': Icon = ClipboardList; colorClass = "text-purple-500"; break;
                  case 'translation': Icon = Languages; colorClass = "text-indigo-500"; break;
                  case 'essay': Icon = PenTool; colorClass = "text-orange-500"; break;
                  case 'image': Icon = Image; colorClass = "text-pink-500"; break;
                  case 'file': Icon = File; colorClass = "text-gray-500"; break;
                }

                const displayTitle = (item as any).title || item.itemId;

                return (
                  <div
                    key={item.id}
                    className="flex justify-center h-[68px] overflow-hidden"
                  >
                    <NotionButton
                      variant="ghost" size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(item.id, 'item');
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleDoubleClickItem(item);
                      }}
                      onContextMenu={(e) => handleItemContextMenu(e, item)}
                      className="group relative !h-full !p-0 flex-col items-center w-full max-w-[60px]"
                    >
                      {/* 图标 */}
                      <div className="relative w-8 h-8 shrink-0 flex items-center justify-center transition-transform duration-200 group-hover:scale-105">
                        <div className={cn("w-7 h-7 flex items-center justify-center", colorClass)}>
                          <Icon className="w-6 h-6 stroke-[1.5]" />
                        </div>
                      </div>
                      {/* 标题 - 固定高度，最多2行 */}
                      <div className={cn(
                        "mt-0.5 px-0.5 py-0.5 rounded-[2px] w-full overflow-hidden",
                        isSelected
                          ? "bg-primary"
                          : "group-hover:bg-muted/30"
                      )}>
                        <span className={cn(
                          "text-[9px] leading-[1.2] text-center block line-clamp-2 break-all",
                          isSelected ? "text-white font-medium" : "text-foreground"
                        )}>
                          {displayTitle}
                        </span>
                      </div>
                    </NotionButton>
                  </div>
                );
              })}
              </div>
            </>
          ) : (
            // ================= List View (Finder Style) =================
            <div className="flex flex-col">
              {/* 表头 - Finder 风格 */}
              <div className="flex items-center px-4 h-8 border-b border-border/60 bg-background/95 backdrop-blur-sm text-[11px] text-muted-foreground font-medium sticky top-0 z-20">
                {/* 名称列 */}
                <div className="flex-1 min-w-[200px] flex items-center gap-1 text-left">
                  {t('listHeader.name', '名称')}
                </div>
                
                {/* 分隔线 */}
                <div className="w-px h-3 bg-border/40 mx-2" />

                {/* 修改日期列 */}
                <div className="w-32 shrink-0 text-left">
                  {t('listHeader.modifiedAt', '修改日期')}
                </div>
                <div className="w-px h-3 bg-border/40 mx-2" />

                {/* 类型列 */}
                <div className="w-16 shrink-0 text-left">
                  {t('listHeader.type', '类型')}
                </div>
              </div>

              {/* List 模式新建文件夹输入框 - 显示为列表中的第一行 */}
              {isCreating && createParentId === null && (
                <div className="flex items-center px-4 h-[34px] bg-primary/5 border-b border-primary/20">
                  <ChevronRight className="w-3 h-3 mr-1 text-muted-foreground invisible" />
                  <div className="flex-1 min-w-[200px] flex items-center gap-2">
                    <FolderPlus className="w-4 h-4 text-amber-500 shrink-0" />
                    <Input
                      autoFocus
                      value={newFolderTitle}
                      onChange={(e) => setNewFolderTitle(e.target.value)}
                      onBlur={handleFinishCreate}
                      onKeyDown={handleCreateKeyDown}
                      placeholder={t('folder.folderNamePlaceholder')}
                      className="h-6 text-sm flex-1 bg-transparent border-none focus-visible:ring-0 px-0"
                    />
                  </div>
                  <div className="w-32 shrink-0" />
                  <div className="w-px h-3 bg-transparent mx-2" />
                  <div className="w-16 shrink-0 text-xs text-muted-foreground">
                    {t('folder.label', '文件夹')}
                  </div>
                </div>
              )}

              {/* 列表内容 */}
              <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId={currentFolderId || 'root'} type="FOLDER">
                {(provided: DroppableProvided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(e) => handleDrop(e, currentFolderId)}
                  >
                    {/* 渲染文件夹 */}
                    {displayFolders.map((node, index) => {
                      const isSelected = selectedId === node.folder.id;
                      const isEven = index % 2 === 0;
                      const isBuiltin = node.folder.isBuiltin;
                      const isExpanded = node.folder.isExpanded;
                      
                      // 格式化日期
                      const formatDate = (timestamp: number) => {
                        const date = new Date(timestamp);
                        return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                      };
                      
                      return (
                        <React.Fragment key={node.folder.id}>
                          <Draggable
                            draggableId={node.folder.id}
                            index={index}
                            isDragDisabled={disabled || isBuiltin}
                          >
                            {(dragProvided: DraggableProvided) => (
                              <div
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                              >
                                <NotionButton
                                  variant="ghost" size="sm"
                                  onClick={() => {
                                    onSelect(node.folder.id, 'folder');
                                    onToggleExpand(node.folder.id, !isExpanded);
                                  }}
                                  onDoubleClick={() => handleDoubleClickFolder(node.folder.id)}
                                  onContextMenu={(e) => handleFolderContextMenu(e, node)}
                                  className={cn(
                                    'group !justify-start !px-4 !h-[34px] w-full',
                                    isSelected 
                                      ? 'bg-primary/10' 
                                      : isEven ? 'bg-transparent' : 'bg-muted/20',
                                    !isSelected && 'hover:bg-accent/50'
                                  )}
                                >
                                  {/* 展开箭头 */}
                                  <ChevronRight 
                                    className={cn(
                                      "w-3 h-3 mr-1 text-muted-foreground transition-transform",
                                      isExpanded && "rotate-90",
                                      node.items.length === 0 && node.children.length === 0 && "invisible"
                                    )}
                                  />
                                  
                                  {/* 名称列 */}
                                  <div className="flex-1 min-w-[200px] flex items-center gap-2 overflow-hidden">
                                    {isBuiltin ? (
                                      // 内置文件夹使用对应的图标
                                      node.folder.builtinType === 'exam' ? (
                                        <ClipboardList className="w-4 h-4 shrink-0 text-blue-500" />
                                      ) : node.folder.builtinType === 'translation' ? (
                                        <Languages className="w-4 h-4 shrink-0 text-blue-500" />
                                      ) : node.folder.builtinType === 'essay' ? (
                                        <PenTool className="w-4 h-4 shrink-0 text-blue-500" />
                                      ) : (
                                        <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                                      )
                                    ) : isExpanded ? (
                                      <FolderOpen className="w-4 h-4 shrink-0 text-amber-500" />
                                    ) : (
                                      <Folder className="w-4 h-4 shrink-0 text-amber-500" />
                                    )}
                                    <span className={cn(
                                      "text-sm truncate",
                                      isSelected && "text-primary font-medium"
                                    )}>
                                      {node.folder.title}
                                    </span>
                                  </div>
                                  
                                  {/* 修改日期列 */}
                                  <div className="w-32 shrink-0 text-xs text-muted-foreground">
                                    {formatDate(node.folder.updatedAt)}
                                  </div>
                                  <div className="w-px h-3 bg-transparent mx-2" />
                                  
                                  {/* 类型列 */}
                                  <div className="w-16 shrink-0 text-xs text-muted-foreground">
                                    {t('folder.label', '文件夹')}
                                  </div>
                                </NotionButton>
                              </div>
                            )}
                          </Draggable>
                          
                          {/* 展开时显示内容项 */}
                          {isExpanded && node.items.map((item, itemIndex) => {
                            const itemSelected = selectedId === item.id;
                            const itemIsEven = (index + itemIndex + 1) % 2 === 0;
                            const displayTitle = (item as any).title || item.itemId;
                            
                            // 获取图标和颜色
                            let ItemIcon = FileText;
                            let iconColorClass = "text-blue-500";
                            let typeLabel = t('resourceType.note', '笔记');
                            
                            switch (item.itemType) {
                              case 'note': ItemIcon = FileText; iconColorClass = "text-blue-500"; typeLabel = t('resourceType.note', '笔记'); break;
                              case 'textbook': ItemIcon = BookOpen; iconColorClass = "text-emerald-500"; typeLabel = t('resourceType.textbook', '教材'); break;
                              case 'exam': ItemIcon = ClipboardList; iconColorClass = "text-purple-500"; typeLabel = t('resourceType.exam', '题目集'); break;
                              case 'translation': ItemIcon = Languages; iconColorClass = "text-indigo-500"; typeLabel = t('resourceType.translation', '翻译'); break;
                              case 'essay': ItemIcon = PenTool; iconColorClass = "text-orange-500"; typeLabel = t('resourceType.essay', '作文'); break;
                            }
                            
                            return (
                              <NotionButton
                                key={item.id}
                                variant="ghost" size="sm"
                                onClick={() => onSelect(item.id, 'item')}
                                onDoubleClick={() => handleDoubleClickItem(item)}
                                onContextMenu={(e) => handleItemContextMenu(e, item)}
                                className={cn(
                                  'group !justify-start !px-4 !pl-9 !h-[34px] w-full',
                                    itemSelected 
                                    ? 'bg-primary/10' 
                                    : itemIsEven ? 'bg-transparent' : 'bg-muted/20',
                                  !itemSelected && 'hover:bg-accent/50'
                                )}
                              >
                                {/* 占位（对齐箭头） */}
                                <div className="w-4 mr-1" />
                                
                                {/* 名称列 */}
                                <div className="flex-1 min-w-[200px] flex items-center gap-2 overflow-hidden">
                                  <ItemIcon className={cn("w-4 h-4 shrink-0", iconColorClass)} />
                                  <span className={cn(
                                    "text-sm truncate",
                                    itemSelected && "text-primary font-medium"
                                  )}>
                                    {displayTitle}
                                  </span>
                                </div>
                                
                                {/* 修改日期列 */}
                                <div className="w-32 shrink-0 text-xs text-muted-foreground">
                                  {formatDate(item.createdAt)}
                                </div>
                                <div className="w-px h-3 bg-transparent mx-2" />
                                
                                {/* 类型列 */}
                                <div className="w-16 shrink-0 text-xs text-muted-foreground">
                                  {typeLabel}
                                </div>
                              </NotionButton>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
            </div>
          )}
        </div>
      </CustomScrollArea>

      {/* 右键菜单 - 仅在未提供外部菜单时使用内部菜单 */}
      {!externalContextMenu && (
        <ContextMenuPortal
          open={contextMenuOpen}
          onOpenChange={setContextMenuOpen}
          position={contextMenuPosition}
        >
        {/* 新建文件夹 */}
        <AppMenuItem 
          icon={<FolderPlus className="w-4 h-4" />} 
          onClick={() => handleStartCreate(currentFolderId)}
        >
          {t('folder.newFolder')}
        </AppMenuItem>
        <AppMenuSeparator />
        {/* 新建各种内容 - 始终显示 */}
        <AppMenuItem 
          icon={<FileText className="w-4 h-4" />} 
          onClick={() => {
            onCreateItem?.('note', currentFolderId);
            setContextMenuOpen(false);
          }}
        >
          {t('contextMenu.newNote', '新建笔记')}
        </AppMenuItem>
        <AppMenuItem 
          icon={<ClipboardList className="w-4 h-4" />} 
          onClick={() => {
            onCreateItem?.('exam', currentFolderId);
            setContextMenuOpen(false);
          }}
        >
          {t('contextMenu.newExam', '新建题目集识别')}
        </AppMenuItem>
        <AppMenuItem 
          icon={<BookOpen className="w-4 h-4" />} 
          onClick={() => {
            onCreateItem?.('textbook', currentFolderId);
            setContextMenuOpen(false);
          }}
        >
          {t('contextMenu.newTextbook', '导入教材')}
        </AppMenuItem>
        <AppMenuItem 
          icon={<Languages className="w-4 h-4" />} 
          onClick={() => {
            onCreateItem?.('translation', currentFolderId);
            setContextMenuOpen(false);
          }}
        >
          {t('contextMenu.newTranslation', '新建翻译')}
        </AppMenuItem>
        <AppMenuItem 
          icon={<PenTool className="w-4 h-4" />} 
          onClick={() => {
            onCreateItem?.('essay', currentFolderId);
            setContextMenuOpen(false);
          }}
        >
          {t('contextMenu.newEssay', '新建作文')}
        </AppMenuItem>
        <AppMenuSeparator />
        {/* 刷新 */}
        <AppMenuItem 
          icon={<RefreshCw className="w-4 h-4" />} 
          onClick={() => {
            onRefresh?.();
            setContextMenuOpen(false);
          }}
        >
          {t('common.refresh', '刷新')}
        </AppMenuItem>
      </ContextMenuPortal>
      )}
    </div>
  );
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在树中查找节点
 */
function findNodeById(
  tree: FolderTreeNode[],
  id: string
): FolderTreeNode | null {
  for (const node of tree) {
    if (node.folder.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

export default FolderTreeView;
