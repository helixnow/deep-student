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
  ClipboardText,
  BookOpen,
  Translate,
  PenNib,
  ArrowClockwise,
  Pencil,
  Trash,
  ArrowSquareOut,
  Chat,
  FolderOpen,
  Copy,
  ArrowCounterClockwise,
  Warning,
  FlowArrow,
  Star,
  StarHalf,
  Monitor,
  CheckCircle,
  Download,
  ListChecks,
  ArrowBendUpRight,
} from '@phosphor-icons/react';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/lib/utils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLiquidGlassLens } from '@/features/workbench/core/liquidGlassLens';
import '@/features/workbench/styles/workbench.tokens.css';
import '@/features/workbench/components/DesktopContextMenu.css';
import type { ResourceListItem } from '../types';
import type { FolderTreeNode, VfsFolderItem } from '@/dstu/types/folder';
import { useShallow } from 'zustand/react/shallow';
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
  /** VIEW_CAPABILITY：当前视图是否允许新建 */
  canCreate?: boolean;
  /** VIEW_CAPABILITY：当前视图是否允许删除 */
  canDelete?: boolean;
  /** VIEW_CAPABILITY：当前视图是否允许移动 */
  canMove?: boolean;
  /** VIEW_CAPABILITY：当前视图是否允许添加到对话 */
  canAddToChat?: boolean;
  
  // ========== 回调函数 ==========
  /** 新建文件夹 */
  onCreateFolder?: (parentId: string | null) => void;
  /** 新建内容（笔记、题目集识别等） */
  onCreateItem?: (type: 'note' | 'exam' | 'textbook' | 'translation' | 'essay' | 'mindmap', folderId: string | null) => void;
  /** 导入 Markdown 笔记 */
  onImportMarkdownNote?: (folderId: string | null) => void;
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
  /** ★ 2026-06-12（审阅问题 FE-M4）：移动到指定文件夹 */
  onMoveTo?: (target: ContextMenuTarget) => void;
  /** 收藏/取消收藏 */
  onToggleFavorite?: (resource: ResourceListItem) => void;
  /** ★ 2025-12-11: 回收站操作 */
  /** 恢复项目 */
  onRestoreItem?: (id: string, itemType: string) => void;
  /** 永久删除项目 */
  onPermanentDeleteItem?: (id: string, itemType: string) => void;
  /** 清空回收站 */
  onEmptyTrash?: () => void;
  /** 导出资源 */
  onExportResource?: (resource: ResourceListItem) => void;
  /** ★ 2026-07-20：文件夹批量导出为 ZIP */
  onExportFolder?: (folderId: string) => void;
}

// ============================================================================
// 菜单行 / 分隔线（学习桌面 wb-desk-menu 同款样式，见 DesktopContextMenu.css）
// ============================================================================

interface MenuItemProps {
  icon: React.ReactNode;
  disabled?: boolean;
  /** 危险操作（删除 / 清空回收站等）：红字 + 红色 hover 高亮 */
  danger?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, disabled, danger, onClick, children }) => (
  <button
    type="button"
    role="menuitem"
    className={cn('wb-desk-menu-item', danger && 'wb-desk-menu-item--danger')}
    disabled={disabled}
    onClick={onClick}
  >
    <span className="wb-desk-menu-item-icon" aria-hidden="true">
      {icon}
    </span>
    <span className="wb-desk-menu-item-label">{children}</span>
  </button>
);

const MenuSeparator: React.FC = () => <div className="wb-desk-menu-sep" role="separator" />;

/** 离场编排：与学习桌面菜单一致，播完 wb-kf-window-close(90ms) 再卸载 + 余量 */
const MENU_EXIT_MS = 180;

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
  canCreate = true,
  canDelete = true,
  canMove = true,
  canAddToChat = true,
  onCreateFolder,
  onCreateItem,
  onImportMarkdownNote,
  onRefresh,
  onOpenFolder,
  onRenameFolder,
  onDeleteFolder,
  onOpenResource,
  onRenameResource,
  onDeleteResource,
  onReferenceToChat,
  onCopy,
  onMoveTo,
  onToggleFavorite,
  onRestoreItem,
  onPermanentDeleteItem,
  onEmptyTrash,
  onExportResource,
  onExportFolder,
}) => {
  const { t } = useTranslation('learningHub');
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ x: position.x, y: position.y });
  // 触屏设备（长按/更多按钮打开）：改用贴底动作面板并提供标准 44px 触控目标。
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  // ---- 离场编排（与学习桌面菜单一致）：open=false 后保留面板播退场动画，播完再卸载 ----
  const [renderedOpen, setRenderedOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  const renderedOpenRef = useRef(renderedOpen);
  const exitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    renderedOpenRef.current = renderedOpen;
  }, [renderedOpen]);
  useEffect(() => {
    if (open) {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRenderedOpen(true);
      setClosing(false);
      return;
    }
    if (!renderedOpenRef.current) return;
    setClosing(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setRenderedOpen(false);
      setClosing(false);
    }, MENU_EXIT_MS);
  }, [open]);
  // 卸载兜底：清掉进行中的离场计时器
  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    },
    [],
  );

  // 液态玻璃透镜（学习桌面菜单同款材质）
  useLiquidGlassLens(menuRef, renderedOpen);

  // 边界检测：当菜单向下展示不全时，向上展示
  // ★ target 变化会改变菜单项数量/高度，需一并重新测量
  useLayoutEffect(() => {
    if (!open || !menuRef.current || isTouchPrimary) return;

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
  }, [isTouchPrimary, open, position, target]);

  // 点击外部关闭菜单；触屏补充：菜单外 touchstart（capture）或背景滚动时关闭，
  // 避免触摸滚动穿透时菜单悬空在错误位置
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };

    const handleTouchOutside = (e: TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };

    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };

    // 延迟添加监听器，避免立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleTouchOutside, { capture: true, passive: true });
      window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleTouchOutside, { capture: true });
      window.removeEventListener('scroll', handleScroll, { capture: true });
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onOpenChange]);

  // 📱 Android 返回键：自绘浮层菜单打开时先关闭菜单（契约第 4 条）。
  // 该菜单不带 data-state="open"，androidBackCoordinator 的 Radix 兜底匹配不到，必须显式注册。
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onOpenChange(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open, onOpenChange]);

  // 关闭菜单的辅助函数
  const closeMenu = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // ========== 桌面快捷方式 Store（必须在条件返回之前调用） ==========
  const { addResourceShortcut, addFolderShortcut, hasResourceShortcut, hasFolderShortcut } = useDesktopStore(
    useShallow((state) => ({
      addResourceShortcut: state.addResourceShortcut,
      addFolderShortcut: state.addFolderShortcut,
      hasResourceShortcut: state.hasResourceShortcut,
      hasFolderShortcut: state.hasFolderShortcut,
    }))
  );

  if (!renderedOpen) return null;

  // ========== 渲染回收站空白区域菜单 ==========
  const renderTrashEmptyMenu = () => (
    <>
      {/* 清空回收站 */}
      {onEmptyTrash && (
        <MenuItem
          icon={<Warning size={15} weight="duotone" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => {
              onEmptyTrash();
            }, 50);
          }}
          danger
        >
          {t('finder.trash.emptyAction')}
        </MenuItem>
      )}
      <MenuSeparator />
      
      {/* 刷新 */}
      <MenuItem
        icon={<ArrowClockwise size={15} weight="duotone" />}
        onClick={() => {
          onRefresh?.();
          closeMenu();
        }}
      >
        {t('common.refresh')}
      </MenuItem>
    </>
  );

  // ========== 渲染回收站项目菜单 ==========
  const renderTrashItemMenu = (id: string, itemType: string) => (
    <>
      {/* 恢复 */}
      {onRestoreItem && (
        <MenuItem
          icon={<ArrowCounterClockwise size={15} weight="duotone" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => {
              onRestoreItem(id, itemType);
            }, 50);
          }}
        >
          {t('finder.contextMenu.restore')}
        </MenuItem>
      )}
      
      {/* 永久删除 */}
      {onPermanentDeleteItem && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Trash size={15} weight="duotone" />}
            onClick={() => {
              closeMenu();
              setTimeout(() => {
                onPermanentDeleteItem(id, itemType);
              }, 50);
            }}
            danger
          >
            {t('finder.contextMenu.permanentDelete')}
          </MenuItem>
        </>
      )}
    </>
  );

  // ========== 渲染空白区域菜单 ==========
  const renderEmptyMenu = () => {
    // 非 creatable 视图（收藏/最近等）：空白菜单只保留刷新
    if (!canCreate) {
      return (
        <MenuItem
          icon={<ArrowClockwise size={15} weight="duotone" />}
          onClick={() => {
            onRefresh?.();
            closeMenu();
          }}
        >
          {t('common.refresh')}
        </MenuItem>
      );
    }

    return (
    <>
      {/* 新建文件夹 - 仅在文件夹视图显示 */}
      {dataView === 'folder' && (
        <>
          <MenuItem
            icon={<FolderPlus size={15} weight="duotone" />}
            onClick={() => {
              onCreateFolder?.(currentFolderId ?? null);
              closeMenu();
            }}
          >
            {t('folder.newFolder')}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      
      {/* 新建内容 */}
      <MenuItem
        icon={<FileText size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('note', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newNote')}
      </MenuItem>
      <MenuItem
        icon={<Download size={15} weight="duotone" />}
        onClick={() => {
          onImportMarkdownNote?.(currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.importMarkdown')}
      </MenuItem>
      <MenuItem
        icon={<ClipboardText size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('exam', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newExam')}
      </MenuItem>
      <MenuItem
        icon={<BookOpen size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('textbook', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newTextbook')}
      </MenuItem>
      <MenuItem
        icon={<Translate size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('translation', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newTranslation')}
      </MenuItem>
      <MenuItem
        icon={<PenNib size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('essay', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newEssay')}
      </MenuItem>
      <MenuItem
        icon={<FlowArrow size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('mindmap', currentFolderId ?? null);
          closeMenu();
        }}
      >
        {t('contextMenu.newMindMap')}
      </MenuItem>
      <MenuSeparator />
      
      {/* 刷新 */}
      <MenuItem
        icon={<ArrowClockwise size={15} weight="duotone" />}
        onClick={() => {
          onRefresh?.();
          closeMenu();
        }}
      >
        {t('common.refresh')}
      </MenuItem>
    </>
    );
  };

  // ========== 渲染文件夹菜单 ==========
  const renderFolderMenu = (folder: FolderTreeNode) => (
    <>
      {/* 打开 */}
      <MenuItem
        icon={<FolderOpen size={15} weight="duotone" />}
        onClick={() => {
          onOpenFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.open')}
        </MenuItem>
        <MenuSeparator />
      
        {/* 在此文件夹新建 */}
      {canCreate && (
        <>
      <MenuItem
        icon={<FolderPlus size={15} weight="duotone" />}
        onClick={() => {
          onCreateFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.newSubfolder')}
      </MenuItem>
      <MenuItem
        icon={<FileText size={15} weight="duotone" />}
        onClick={() => {
          onCreateItem?.('note', folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.newNoteHere')}
      </MenuItem>
      <MenuItem
        icon={<Download size={15} weight="duotone" />}
        onClick={() => {
          onImportMarkdownNote?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.importMarkdownHere')}
      </MenuItem>
      <MenuSeparator />
        </>
      )}

      {/* ★ 移动到… */}
      {canMove && onMoveTo && (
        <MenuItem
          icon={<ArrowBendUpRight size={15} weight="duotone" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => onMoveTo(target), 50);
          }}
        >
          {t('contextMenu.moveTo')}
        </MenuItem>
      )}

      {/* 重命名 */}
      <MenuItem
        icon={<Pencil size={15} weight="duotone" />}
        onClick={() => {
          onRenameFolder?.(folder.folder.id);
          closeMenu();
        }}
      >
        {t('contextMenu.rename')}
        </MenuItem>

      {/* ★ 2026-07-20：文件夹批量导出为 ZIP */}
      {onExportFolder && (
        <MenuItem
          icon={<Download size={15} weight="duotone" />}
          onClick={() => {
            closeMenu();
            setTimeout(() => onExportFolder(folder.folder.id), 50);
          }}
        >
          {t('contextMenu.exportFolderZip')}
        </MenuItem>
      )}

        {/* 删除 */}
      {canDelete && onDeleteFolder && (
      <MenuItem
        icon={<Trash size={15} weight="duotone" />}
        onClick={() => {
          onDeleteFolder(folder.folder.id);
          closeMenu();
        }}
        danger
      >
        {t('contextMenu.delete')}
        </MenuItem>
      )}
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
        <MenuItem
          icon={<ArrowSquareOut size={15} weight="duotone" />}
          onClick={() => {
            onOpenResource?.(resource);
            closeMenu();
          }}
        >
          {t('contextMenu.open')}
        </MenuItem>
        <MenuSeparator />
        
        {/* 引用到对话 */}
        {canAddToChat && onReferenceToChat && (
          <MenuItem
            icon={<Chat size={15} weight="duotone" />}
            onClick={() => {
              onReferenceToChat(target);
              closeMenu();
            }}
          >
            {t('contextMenu.referenceToChat')}
          </MenuItem>
        )}
        
        {/* 复制 */}
        {onCopy && (
          <MenuItem
            icon={<Copy size={15} weight="duotone" />}
            onClick={() => {
              onCopy(target);
              closeMenu();
            }}
          >
            {t('contextMenu.copy')}
          </MenuItem>
        )}

        {/* ★ 移动到… */}
        {canMove && onMoveTo && (
          <MenuItem
            icon={<ArrowBendUpRight size={15} weight="duotone" />}
            onClick={() => {
              closeMenu();
              setTimeout(() => onMoveTo(target), 50);
            }}
          >
            {t('contextMenu.moveTo')}
          </MenuItem>
        )}
        
        {/* 重命名 - 仅资源项 */}
        {resourceItem && onRenameResource && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Pencil size={15} weight="duotone" />}
              onClick={() => {
                onRenameResource(resourceItem);
                closeMenu();
              }}
            >
              {t('contextMenu.rename')}
            </MenuItem>
          </>
        )}
        
        {/* 收藏 - 仅资源项 */}
        {resourceItem && onToggleFavorite && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={resourceItem.isFavorite 
                ? <StarHalf size={15} weight="duotone" />
                : <Star size={15} weight="duotone" />
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
            </MenuItem>
          </>
        )}
        
        {/* ★ 2026-01-31: 添加到桌面 - 仅资源项 */}
        {resourceItem && (
          <MenuItem
            icon={isAddedToDesktop 
              ? <CheckCircle size={15} weight="duotone" className="text-success" />
              : <Monitor size={15} weight="duotone" />
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
          </MenuItem>
        )}
        
        {/* 导出 - 仅资源项 */}
        {resourceItem && onExportResource && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Download size={15} weight="duotone" />}
              onClick={() => {
                closeMenu();
                setTimeout(() => {
                  onExportResource(resourceItem);
                }, 50);
              }}
            >
              {t('contextMenu.export')}
            </MenuItem>
          </>
        )}
        
        {/* 删除 - 仅资源项 */}
        {canDelete && resourceItem && onDeleteResource && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Trash size={15} weight="duotone" />}
              onClick={() => {
                // ★ 先关闭菜单，再执行删除（避免菜单状态影响确认框）
                closeMenu();
                // 使用 setTimeout 确保菜单完全关闭后再显示确认框
                setTimeout(() => {
                  onDeleteResource(resourceItem);
                }, 50);
              }}
              danger
            >
              {t('contextMenu.delete')}
            </MenuItem>
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

  // 触屏贴底面板顶部展示完整名称（列表内长文件名被截断时的完整查看入口）
  const targetTitle =
    target.type === 'folder'
      ? target.folder.folder.title
      : target.type === 'resource'
        ? target.resource.title
        : null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-wb-blur-surface
      data-phase={closing ? 'closing' : 'open'}
      className={cn(
        // 学习桌面右键菜单同款玻璃外壳（见 workbench DesktopContextMenu.css）
        'wb-desk-menu wb-glass-lens',
        // ★ 小视口下限制高度并允许内部滚动，避免长菜单被裁剪不可达
        //   （本菜单无飞出子菜单，允许 overflow 裁剪）
        'scroll-area--native max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden',
        // 触屏使用贴底动作面板，入口位置稳定且不依赖长按坐标。
        isTouchPrimary && 'max-w-none rounded-t-2xl [&_[role=menuitem]]:min-h-11'
      )}
      style={isTouchPrimary
        ? {
            position: 'fixed',
            left: 8,
            right: 8,
            bottom: 0,
            top: 'auto',
            width: 'auto',
            maxHeight: 'calc(100dvh - var(--mobile-header-total-height, 56px) - 8px)',
            paddingBottom: 'var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
            zIndex: Z_INDEX.contextMenu,
          }
        : {
            // .wb-desk-menu 默认 absolute（相对桌面根定位）；此处 Portal 到 body，用 fixed
            position: 'fixed',
            left: menuPosition.x,
            top: menuPosition.y,
            zIndex: Z_INDEX.contextMenu,
          }}
    >
      {isTouchPrimary && (
        <div aria-hidden className="mx-auto my-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" />
      )}
      {isTouchPrimary && targetTitle && (
        <div className="mb-1 border-b border-border/40 px-3 pb-2 text-xs font-medium text-muted-foreground break-all">
          {targetTitle}
        </div>
      )}
      {renderMenuContent()}
    </div>,
    document.body
  );
};

export default LearningHubContextMenu;
