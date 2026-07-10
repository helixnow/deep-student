/**
 * 文件夹树节点组件
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md
 *
 * Prompt 7: Learning Hub 文件夹视图改造
 *
 * 功能：
 * - 文件夹节点渲染
 * - 展开/收起
 * - 右键菜单
 * - 拖拽支持
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useTranslation } from 'react-i18next';
import {
  CaretRight,
  CaretDown,
  Folder,
  FolderOpen,
  DotsThree,
  Pencil,
  Trash,
  FolderOpen as FolderUp,
  Chat,
  ClipboardText,
  Translate,
  PenNib,
  Lock,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import type { FolderTreeNode, VfsFolderItem } from '@/dstu/types/folder';

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
 * 使用 AppMenu 样式，通过 Portal 渲染到 body
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

    // 延迟添加事件，避免立即触发
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

  // 计算菜单位置，确保不超出视口
  useEffect(() => {
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

    // 下边界检测
    if (y + rect.height > viewportHeight - 8) {
      y = viewportHeight - rect.height - 8;
    }

    // 左边界和上边界
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

export interface FolderTreeItemProps {
  /** 文件夹树节点 */
  node: FolderTreeNode;
  /** 嵌套深度 */
  depth: number;
  /** 当前选中的 ID */
  selectedId: string | null;
  /** 选中回调 */
  onSelect: (id: string, type: 'folder' | 'item') => void;
  /** 展开/收起回调 */
  onToggleExpand: (folderId: string, isExpanded: boolean) => void;
  /** 重命名回调 */
  onRename: (folderId: string, newTitle: string) => void;
  /** 删除回调 */
  onDelete: (folderId: string) => void;
  /** 移动回调 */
  onMove?: (folderId: string, newParentId: string | null) => void;
  /** 引用到对话回调 */
  onReferenceToChat?: (folderId: string) => void;
  /** 拖拽开始回调 */
  onDragStart?: (e: React.DragEvent, nodeId: string, type: 'folder' | 'item') => void;
  /** 拖拽放置回调 */
  onDrop?: (e: React.DragEvent, targetFolderId: string | null) => void;
  /** 渲染内容项 */
  renderItem?: (item: VfsFolderItem, depth: number) => React.ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 文件夹树节点组件
 * 
 * 使用 React.memo 优化，避免文件夹树中不必要的重渲染
 * 特别是当树的其他节点发生变化时，未变化的节点不需要重渲染
 */
export const FolderTreeItem: React.FC<FolderTreeItemProps> = React.memo(({
  node,
  depth,
  selectedId,
  onSelect,
  onToggleExpand,
  onRename,
  onDelete,
  onMove,
  onReferenceToChat,
  onDragStart,
  onDrop,
  renderItem,
  disabled = false,
}) => {
  const { t } = useTranslation('learningHub');
  const { folder, children, items } = node;

  // 状态
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(folder.title);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // 防止 Enter/Escape 处理后 onBlur 再次触发提交（Enter 会导致重复 onRename，
  // Escape 会导致取消后仍然提交）
  const editHandledRef = useRef(false);
  // 中文输入法组合期间不响应 Enter/Escape
  const isComposingRef = useRef(false);

  // 是否选中
  const isSelected = selectedId === folder.id;
  const isExpanded = folder.isExpanded;

  // ★ 内置文件夹检测
  const isBuiltin = folder.isBuiltin === true;
  const builtinType = folder.builtinType;

  // 获取内置文件夹图标
  const getBuiltinIcon = () => {
    switch (builtinType) {
      case 'exam':
        return <ClipboardText size={16} />;
      case 'translation':
        return <Translate size={16} />;
      case 'essay':
        return <PenNib size={16} />;
      default:
        return isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />;
    }
  };

  // 缩进样式
  const paddingLeft = 12 + depth * 16;

  // ==========================================================================
  // 事件处理
  // ==========================================================================

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled && !isEditing) {
        onSelect(folder.id, 'folder');
      }
    },
    [disabled, isEditing, folder.id, onSelect]
  );

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled) {
        onToggleExpand(folder.id, !isExpanded);
      }
    },
    [disabled, folder.id, isExpanded, onToggleExpand]
  );

  const handleStartEdit = useCallback(() => {
    setIsEditing(true);
    setEditTitle(folder.title);
    editHandledRef.current = false;
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [folder.title]);

  const handleFinishEdit = useCallback(() => {
    if (editHandledRef.current) return;
    editHandledRef.current = true;
    const newTitle = editTitle.trim();
    if (newTitle && newTitle !== folder.title) {
      onRename(folder.id, newTitle);
    }
    setIsEditing(false);
    // 编辑结束后把焦点还给行，保持键盘导航的连续性
    requestAnimationFrame(() => rowRef.current?.focus());
  }, [editTitle, folder.id, folder.title, onRename]);

  const handleCancelEdit = useCallback(() => {
    if (editHandledRef.current) return;
    editHandledRef.current = true;
    setIsEditing(false);
    setEditTitle(folder.title);
    requestAnimationFrame(() => rowRef.current?.focus());
  }, [folder.title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isComposingRef.current) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFinishEdit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        handleCancelEdit();
      }
    },
    [handleFinishEdit, handleCancelEdit]
  );

  const handleDelete = useCallback(() => {
    onDelete(folder.id);
  }, [folder.id, onDelete]);

  const handleMoveToRoot = useCallback(() => {
    if (onMove) {
      onMove(folder.id, null);
    }
  }, [folder.id, onMove]);

  const handleReferenceToChat = useCallback(() => {
    if (onReferenceToChat) {
      onReferenceToChat(folder.id);
    }
  }, [folder.id, onReferenceToChat]);

  // 右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || isEditing) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenuPosition({ x: e.clientX, y: e.clientY });
      setContextMenuOpen(true);
    },
    [disabled, isEditing]
  );

  // ==========================================================================
  // 键盘导航（treeview 模式：方向键 / Home / End / Enter / F2）
  // ==========================================================================

  const hasExpandableContent = children.length > 0 || items.length > 0;

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || isEditing) return;
      // 只处理行自身获得焦点时的按键，忽略行内菜单按钮等子元素冒泡
      if (e.target !== e.currentTarget) return;

      const key = e.key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onSelect(folder.id, 'folder');
        return;
      }
      if (key === 'F2' && !isBuiltin) {
        e.preventDefault();
        e.stopPropagation();
        handleStartEdit();
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;

      const current = e.currentTarget;
      const scope = (current.closest('[role="tree"]') as HTMLElement | null) ?? document;
      const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-folder-tree-item]'))
        .filter((el) => el.getClientRects().length > 0);
      const idx = rows.indexOf(current);
      if (idx === -1) return;
      e.preventDefault();
      e.stopPropagation();

      switch (key) {
        case 'ArrowDown':
          rows[idx + 1]?.focus();
          break;
        case 'ArrowUp':
          rows[idx - 1]?.focus();
          break;
        case 'Home':
          rows[0]?.focus();
          break;
        case 'End':
          rows[rows.length - 1]?.focus();
          break;
        case 'ArrowRight':
          if (hasExpandableContent && !isExpanded) {
            onToggleExpand(folder.id, true);
          } else {
            rows[idx + 1]?.focus();
          }
          break;
        case 'ArrowLeft':
          if (hasExpandableContent && isExpanded) {
            onToggleExpand(folder.id, false);
          } else {
            // 叶子/已折叠节点：焦点跳到父级（往上找第一个层级更浅的行）
            const myDepth = Number(current.dataset.depth ?? 0);
            for (let i = idx - 1; i >= 0; i--) {
              if (Number(rows[i].dataset.depth ?? 0) < myDepth) {
                rows[i].focus();
                break;
              }
            }
          }
          break;
      }
    },
    [disabled, isEditing, folder.id, onSelect, isBuiltin, handleStartEdit, hasExpandableContent, isExpanded, onToggleExpand]
  );

  // ==========================================================================
  // 拖拽处理
  // ==========================================================================

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (onDragStart) {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(e, folder.id, 'folder');
      }
    },
    [folder.id, onDragStart]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setIsDragOver(true);
    },
    []
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDropOnFolder = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (onDrop) {
        onDrop(e, folder.id);
      }
    },
    [folder.id, onDrop]
  );

  // ==========================================================================
  // 渲染
  // ==========================================================================

  return (
    <div className="select-none">
      {/* 文件夹节点 */}
      <div
        ref={rowRef}
        className={cn(
          'group flex items-center h-7 cursor-pointer rounded-md',
          !isSelected && 'hover:bg-[var(--interactive-hover)]',
          'transition-colors',
          isSelected && 'bg-accent',
          isDragOver && 'bg-primary/10 ring-1 ring-primary/30',
          disabled && 'opacity-50 cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40'
        )}
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={!disabled && !isEditing}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropOnFolder}
        tabIndex={disabled ? -1 : 0}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasExpandableContent ? !!isExpanded : undefined}
        aria-level={depth + 1}
        data-folder-tree-item
        data-depth={depth}
        onKeyDown={handleRowKeyDown}
      >
        {/* 展开/收起按钮 */}
        <NotionButton
          variant="ghost" size="icon" iconOnly
          className={cn(
            '!h-4 !w-4 !p-0',
            (children.length === 0 && items.length === 0) && 'invisible'
          )}
          onClick={handleToggle}
          tabIndex={-1}
          aria-label="toggle"
        >
          {isExpanded ? (
            <CaretDown size={14} />
          ) : (
            <CaretRight size={14} />
          )}
        </NotionButton>

        {/* 文件夹图标 */}
        <span className={cn(
          "flex-shrink-0 mx-1.5",
          isBuiltin
            ? "text-blue-500 dark:text-blue-400"
            : "text-amber-500 dark:text-amber-400"
        )}>
          {isBuiltin ? getBuiltinIcon() : (
            isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />
          )}
        </span>

        {/* 标题 */}
        {isEditing ? (
          <Input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            className="h-5 px-1 py-0 text-sm flex-1 min-w-0"
            placeholder={t('folder.folderNamePlaceholder')}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 min-w-0 text-sm truncate">
            {folder.title}
          </span>
        )}

        {/* 三点按钮菜单 */}
        {!isEditing && !disabled && (
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton
                variant="ghost"
                size="sm"
                className={cn(
                  'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                  'transition-opacity'
                )}
                onClick={(e) => e.stopPropagation()}
              >
                {isBuiltin ? (
                  <Lock size={14} className="text-muted-foreground" />
                ) : (
                  <DotsThree size={14} />
                )}
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" className="w-48">
              {onReferenceToChat && (
                <>
                  <AppMenuItem icon={<Chat size={16} />} onClick={handleReferenceToChat}>
                    {t('contextMenu.referenceToChat')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                </>
              )}
              {/* 内置文件夹不可重命名 */}
              {!isBuiltin && (
                <AppMenuItem icon={<Pencil size={16} />} onClick={handleStartEdit}>
                  {t('folder.rename')}
                </AppMenuItem>
              )}
              {folder.parentId && onMove && !isBuiltin && (
                <AppMenuItem icon={<FolderUp size={16} />} onClick={handleMoveToRoot}>
                  {t('folder.moveToRoot')}
                </AppMenuItem>
              )}
              {/* 内置文件夹不可删除 */}
              {!isBuiltin ? (
                <>
                  <AppMenuSeparator />
                  <AppMenuItem
                    icon={<Trash size={16} />}
                    onClick={handleDelete}
                    destructive
                  >
                    {t('folder.delete')}
                  </AppMenuItem>
                </>
              ) : (
                <>
                  <AppMenuSeparator />
                  <AppMenuItem icon={<Lock size={16} />} disabled>
                    {t('folder.builtinCannotDelete')}
                  </AppMenuItem>
                </>
              )}
            </AppMenuContent>
          </AppMenu>
        )}
      </div>

      {/* 右键菜单（Context Menu） */}
      {contextMenuOpen && !disabled && (
        <ContextMenuPortal
          open={contextMenuOpen}
          onOpenChange={setContextMenuOpen}
          position={contextMenuPosition}
        >
          {onReferenceToChat && (
            <>
              <AppMenuItem icon={<Chat size={16} />} onClick={handleReferenceToChat}>
                {t('contextMenu.referenceToChat')}
              </AppMenuItem>
              <AppMenuSeparator />
            </>
          )}
          {/* 内置文件夹不可重命名 */}
          {!isBuiltin && (
            <AppMenuItem icon={<Pencil size={16} />} onClick={handleStartEdit}>
              {t('folder.rename')}
            </AppMenuItem>
          )}
          {folder.parentId && onMove && !isBuiltin && (
            <AppMenuItem icon={<FolderUp size={16} />} onClick={handleMoveToRoot}>
              {t('folder.moveToRoot')}
            </AppMenuItem>
          )}
          {/* 内置文件夹不可删除 */}
          {!isBuiltin ? (
            <>
              <AppMenuSeparator />
              <AppMenuItem
                icon={<Trash size={16} />}
                onClick={handleDelete}
                destructive
              >
                {t('folder.delete')}
              </AppMenuItem>
            </>
          ) : (
            <>
              <AppMenuSeparator />
              <AppMenuItem icon={<Lock size={16} />} disabled>
                {t('folder.builtinCannotDelete')}
              </AppMenuItem>
            </>
          )}
        </ContextMenuPortal>
      )}

      {/* 子内容 */}
      {isExpanded && (
        <div>
          {/* 子文件夹 */}
          {children.map((child) => (
            <FolderTreeItem
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onReferenceToChat={onReferenceToChat}
              onDragStart={onDragStart}
              onDrop={onDrop}
              renderItem={renderItem}
              disabled={disabled}
            />
          ))}

          {/* 内容项 */}
          {renderItem && items.map((item) => renderItem(item, depth + 1))}
        </div>
      )}
    </div>
  );
});

export default FolderTreeItem;
