/**
 * 学习资源管理器 - 统一右键菜单组件
 *
 * 功能：
 * - 统一管理所有视图/状态下的右键菜单
 * - 根据上下文（空白区域、文件夹、资源项）显示不同菜单选项
 * - 支持文件夹视图和资源视图
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FolderPlus,
  FileText,
  ClipboardList,
  BookOpen,
  Languages,
  PenTool,
  RefreshCw,
  Pencil,
  Trash2,
  ExternalLink,
  MessageSquare,
  FolderOpen,
  Copy,
  RotateCcw,
  AlertTriangle,
  Workflow,
  Star,
  StarOff,
  Monitor,
  CheckCircle,
} from 'lucide-react';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/lib/utils';
import {
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import type { ResourceListItem } from '../types';
import type { FolderTreeNode, VfsFolderItem } from '@/dstu/types/folder';
import { useDesktopStore } from '../stores/desktopStore';
import type { DstuNodeType } from '@/dstu/types';

// ============================================================================
// 类型定义
// ============================================================================

/** 右键菜单目标类型 */
export type ContextMenuTarget = 
  | { type: 'empty' }  // 空白区域
  | { type: 'folder'; folder: FolderTreeNode }  // 文件夹
  | { type: 'folderItem'; item: VfsFolderItem }  // 文件夹内的内容项
  | { type: 'resource'; resource: ResourceListItem };  // 资源视图中的资源项

export interface LearningHubContextMenuProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 菜单位置 */
  position: { x: number; y: number };
  /** 右键目标 */
  target: ContextMenuTarget;
  /** 当前数据视图 */
  dataView: 'folder' | 'resource';
  /** 当前文件夹 ID（文件夹视图） */
  currentFolderId?: string | null;
  /** 是否在回收站视图 */
  isTrashView?: boolean;
  
  // ========== 回调函数 ==========
  /** 新建文件夹 */
  onCreateFolder?: (parentId: string | null) => void;
  /** 新建内容（笔记、题目集识别等） */
  onCreateItem?: (type: 'note' | 'exam' | 'textbook' | 'translation' | 'essay' | 'mindmap', folderId: string | null) => void;
  /** 刷新 */
  onRefresh?: () => void;
  /** 打开文件夹 */
  onOpenFolder?: (folderId: string) => void;
  /** 重命名文件夹 */
  onRenameFolder?: (folderId: string) => void;
  /** 删除文件夹 */
  onDeleteFolder?: (folderId: string) => void;
  /** 打开资源/内容项 */
  onOpenResource?: (resource: ResourceListItem | VfsFolderItem) => void;
  /** 重命名资源 */
  onRenameResource?: (resource: ResourceListItem) => void;
  /** 删除资源 */
  onDeleteResource?: (resource: ResourceListItem) => void;
  /** 引用到对话 */
  onReferenceToChat?: (target: ContextMenuTarget) => void;
  /** 复制 */
  onCopy?: (target: ContextMenuTarget) => void;
  /** 收藏/取消收藏 */
  onToggleFavorite?: (resource: ResourceListItem) => void;
  /** ★ 2025-12-11: 回收站操作 */
  /** 恢复项目 */
  onRestoreItem?: (id: string, itemType: string) => void;
  /** 永久删除项目 */
  onPermanentDeleteItem?: (id: string, itemType: string) => void;
  /** 清空回收站 */
  onEmptyTrash?: () => void;
}

// ============================================================================
// 右键菜单 Portal 组件
// ============================================================================

export const LearningHubContextMenu: React.FC<LearningHubContextMenuProps> = ({
  open,
  onOpenChange,
  position,
  target,
  dataView,
  currentFolderId,
  isTrashView = false,
  onCreateFolder,
  onCreateItem,
  onRefresh,
  onOpenFolder,
  onRenameFolder,
  onDeleteFolder,
  onOpenResource,
  onRenameResource,
  onDeleteResource,
  onReferenceToChat,
  onCopy,
  onToggleFavorite,
  onRestoreItem,
  onPermanentDeleteItem,
  onEmptyTrash,
}) => {
  const { t } = useTranslation('learningHub');
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ x: position.x, y: position.y });

  // 边界检测：当菜单向下展示不全时，向上展示
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = position.x;
    let y = position.y;

    // 右边界检测
    if (x + rect.width > viewportWidth - 8) {
      x = viewportWidth - rect.width - 8;
    }

    // 下边界检测：向上展示
    if (y + rect.height > viewportHeight - 8) {
      y = position.y - rect.height;
    }

    // 左边界和上边界
    x = Math.max(8, x);
    y = Math.max(8, y);

    setMenuPosition({ x, y });
  }, [open, position]);

  // 点击外部关闭菜单
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

    // 延迟添加监听器，避免立即触发
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

  // 关闭菜单的辅助函数
  const closeMenu = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // ========== 桌面快捷方式 Store（必须在条件返回之前调用） ==========
  const { addResourceShortcut, addFolderShortcut, hasResourceShortcut, hasFolderShortcut } = useDesktopStore();

  if (!open) return null;

  // ========== 渲染回收站空白区域菜单 ==========
  const renderTrashEmptyMenu = () => (
    <>
      {/* 清空回收站 */}
      {onEmptyTrash && (
        <AppMenuItem
          icon={<AlertTriangle className="w-4 h-4" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => {
              onEmptyTrash();
            }, 50);
          }}
          className="text-destructive hover:text-destructive"
        >
          {t('finder.trash.emptyAction')}
        </AppMenuItem>
      )}
      <AppMenuSeparator />
      
      {/* 刷新 */}
      <AppMenuItem
        icon={<RefreshCw className="w-4 h-4" />}
        onClick={() => {
          onRefresh?.();
          closeMenu();
        }}
      >
        {t('common.refresh')}
      </AppMenuItem>
    </>
  );

  // ========== 渲染回收站项目菜单 ==========
  const renderTrashItemMenu = (id: string, itemType: string) => (
    <>
      {/* 恢复 */}
      {onRestoreItem && (
        <AppMenuItem
          icon={<RotateCcw className="w-4 h-4" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => {
              onRestoreItem(id, itemType);
            }, 50);
          }}
        >
          {t('finder.contextMenu.restore')}
        </AppMenuItem>
      )}
      
      {/* 永久删除 */}
      {onPermanentDeleteItem && (
        <>
          <AppMenuSeparator />
          <AppMenuItem
            icon={<Trash2 className="w-4 h-4" />}
            onClick={() => {
              closeMenu();
              setTimeout(() => {
                onPermanentDeleteItem(id, itemType);
              }, 50);
            }}
            className="text-destructive hover:text-destructive"
          >
            {t('finder.contextMenu.permanentDelete')}
          </AppMenuItem>
        </>
      )}
    </>
  );

  // ========== 渲染空白区域菜单 ==========
  const renderEmptyMenu = () => (
    <>
      {/* 新建文件夹 - 仅在文件夹视图显示 */}
      {dataView === 'folder' && (
        <>
          <AppMenuItem
            icon={<FolderPlus className="w-4 h-4" />}
            onClick={() => {
              onCreateFolder?.(currentFolderId ?? null);
              closeMenu();
            }}
          >
            {t('folder.newFolder')}
          </AppMenuItem>
          <AppMenuSeparator />
        </>
      )}
      
      {/* 新建内容 */}
      <AppMenuItem
        icon={<FileText className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('note', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newNote')}
      </AppMenuItem>
      <AppMenuItem
        icon={<ClipboardList className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('exam', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newExam')}
      </AppMenuItem>
      <AppMenuItem
        icon={<BookOpen className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('textbook', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newTextbook')}
      </AppMenuItem>
      <AppMenuItem
        icon={<Languages className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('translation', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newTranslation')}
      </AppMenuItem>
      <AppMenuItem
        icon={<PenTool className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('essay', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newEssay')}
      </AppMenuItem>
      <AppMenuItem
        icon={<Workflow className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('mindmap', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newMindMap')}
      </AppMenuItem>
      <AppMenuSeparator />
      
      {/* 刷新 */}
      <AppMenuItem
        icon={<RefreshCw className="w-4 h-4" />}
        onClick={() => {
          onRefresh?.();
          closeMenu();
        }}
      >
        {t('common.refresh')}
      </AppMenuItem>
    </>
  );

  // ========== 渲染文件夹菜单 ==========
  const renderFolderMenu = (folder: FolderTreeNode) => (
    <>
      {/* 打开 */}
      <AppMenuItem
        icon={<FolderOpen className="w-4 h-4" />}
        onClick={() => {
          onOpenFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.open')}
        </AppMenuItem>
        <AppMenuSeparator />
      
        {/* 在此文件夹新建 */}
      <AppMenuItem
        icon={<FolderPlus className="w-4 h-4" />}
        onClick={() => {
          onCreateFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.newSubfolder')}
      </AppMenuItem>
      <AppMenuItem
        icon={<FileText className="w-4 h-4" />}
        onClick={() => {
          onCreateItem?.('note', folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.newNoteHere')}
      </AppMenuItem>
      <AppMenuSeparator />
      
      {/* 重命名 */}
      <AppMenuItem
        icon={<Pencil className="w-4 h-4" />}
        onClick={() => {
          onRenameFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.rename')}
        </AppMenuItem>
      
        {/* 删除 */}
      <AppMenuItem
        icon={<Trash2 className="w-4 h-4" />}
        onClick={() => {
          onDeleteFolder?.(folder.folder.id);
          closeMenu();
        }}
        className="text-destructive hover:text-destructive"
      >
        {t('contextMenu.delete')}
        </AppMenuItem>
    </>
  );

  // ========== 渲染资源/内容项菜单 ==========
  const renderResourceMenu = (resource: ResourceListItem | VfsFolderItem) => {
    const isResource = 'type' in resource && typeof resource.type === 'string';
    const resourceItem = isResource ? (resource as ResourceListItem) : null;
    
    // 检查是否已添加到桌面
    const isFolder = (resourceItem?.type as string) === 'folder';
    const isAddedToDesktop = isFolder 
      ? hasFolderShortcut(resourceItem?.id || '')
      : hasResourceShortcut(resourceItem?.id || '');
    
    return (
      <>
        {/* 打开 */}
        <AppMenuItem
          icon={<ExternalLink className="w-4 h-4" />}
          onClick={() => {
            onOpenResource?.(resource);
            closeMenu();
          }}
        >
          {t('contextMenu.open')}
        </AppMenuItem>
        <AppMenuSeparator />
        
        {/* 引用到对话 */}
        {onReferenceToChat && (
          <AppMenuItem
            icon={<MessageSquare className="w-4 h-4" />}
            onClick={() => {
              onReferenceToChat(target);
              closeMenu();
            }}
          >
            {t('contextMenu.referenceToChat')}
          </AppMenuItem>
        )}
        
        {/* 复制 */}
        {onCopy && (
          <AppMenuItem
            icon={<Copy className="w-4 h-4" />}
            onClick={() => {
              onCopy(target);
              closeMenu();
            }}
          >
            {t('contextMenu.copy')}
          </AppMenuItem>
        )}
        
        {/* 重命名 - 仅资源项 */}
        {resourceItem && onRenameResource && (
          <>
            <AppMenuSeparator />
            <AppMenuItem
              icon={<Pencil className="w-4 h-4" />}
              onClick={() => {
                onRenameResource(resourceItem);
                closeMenu();
              }}
            >
              {t('contextMenu.rename')}
            </AppMenuItem>
          </>
        )}
        
        {/* 收藏 - 仅资源项 */}
        {resourceItem && onToggleFavorite && (
          <>
            <AppMenuSeparator />
            <AppMenuItem
              icon={resourceItem.isFavorite 
                ? <StarOff className="w-4 h-4" /> 
                : <Star className="w-4 h-4" />
              }
              onClick={() => {
                onToggleFavorite(resourceItem);
                closeMenu();
              }}
            >
              {resourceItem.isFavorite 
                ? t('contextMenu.unfavorite')
                : t('contextMenu.favorite')
              }
            </AppMenuItem>
          </>
        )}
        
        {/* ★ 2026-01-31: 添加到桌面 - 仅资源项 */}
        {resourceItem && (
          <AppMenuItem
            icon={isAddedToDesktop 
              ? <CheckCircle className="w-4 h-4 text-green-500" /> 
              : <Monitor className="w-4 h-4" />
            }
            onClick={() => {
              if (!isAddedToDesktop) {
                if (isFolder) {
                  addFolderShortcut(resourceItem.id, resourceItem.title, resourceItem.path);
                } else {
                  addResourceShortcut(
                    resourceItem.id, 
                    resourceItem.title, 
                    resourceItem.type as DstuNodeType, 
                    resourceItem.path
                  );
                }
              }
              closeMenu();
            }}
            disabled={isAddedToDesktop}
          >
            {isAddedToDesktop
              ? t('contextMenu.addedToDesktop')
              : t('contextMenu.addToDesktop')
            }
          </AppMenuItem>
        )}
        
        {/* 删除 - 仅资源项 */}
        {resourceItem && onDeleteResource && (
          <>
            <AppMenuSeparator />
            <AppMenuItem
              icon={<Trash2 className="w-4 h-4" />}
              onClick={() => {
                // ★ 先关闭菜单，再执行删除（避免菜单状态影响确认框）
                closeMenu();
                // 使用 setTimeout 确保菜单完全关闭后再显示确认框
                setTimeout(() => {
                  onDeleteResource(resourceItem);
                }, 50);
              }}
              className="text-destructive hover:text-destructive"
            >
              {t('contextMenu.delete')}
            </AppMenuItem>
          </>
        )}
      </>
    );
  };

  // ========== 根据目标类型选择菜单内容 ==========
  const renderMenuContent = () => {
    // ★ 2025-12-11: 回收站视图特殊处理
    if (isTrashView) {
      switch (target.type) {
        case 'empty':
          return renderTrashEmptyMenu();
        case 'folder':
          return renderTrashItemMenu(target.folder.folder.id, 'folder');
        case 'folderItem': {
          let itemType = 'note';
          switch (target.item.itemType) {
            case 'note': itemType = 'note'; break;
            case 'textbook': itemType = 'textbook'; break;
            case 'exam': itemType = 'exam'; break;
            case 'translation': itemType = 'translation'; break;
            case 'essay': itemType = 'essay'; break;
            case 'image': itemType = 'image'; break;
            case 'file': itemType = 'file'; break;
            case 'mindmap': itemType = 'mindmap'; break;
            default: itemType = 'note';
          }
          return renderTrashItemMenu(target.item.itemId, itemType);
        }
        case 'resource': {
          const resource = target.resource;
          return renderTrashItemMenu(resource.id, resource.type);
        }
        default:
          return renderTrashEmptyMenu();
      }
    }
    
    // 普通视图
    switch (target.type) {
      case 'empty':
        return renderEmptyMenu();
      case 'folder':
        return renderFolderMenu(target.folder);
      case 'folderItem':
        return renderResourceMenu(target.item);
      case 'resource':
        return renderResourceMenu(target.resource);
      default:
        return renderEmptyMenu();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'fixed min-w-[180px] overflow-hidden rounded-lg',
        'bg-popover/95 backdrop-blur-md text-popover-foreground',
        'border border-transparent ring-1 ring-border/40 shadow-lg',
        'py-1.5 animate-in fade-in-0 zoom-in-95'
      )}
      style={{
        left: menuPosition.x,
        top: menuPosition.y,
        zIndex: Z_INDEX.contextMenu,
      }}
    >
      {renderMenuContent()}
    </div>,
    document.body
  );
};

export default LearningHubContextMenu;
