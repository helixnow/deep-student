/**
 * 文件夹选择器对话框
 *
 * 用于批量移动资源时选择目标文件夹
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, CaretRight, CaretDown, CircleNotch } from '@phosphor-icons/react';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import type { FolderTreeNode } from '@/dstu/types/folder';

// ============================================================================
// 对话框焦点管理（共享对话框组件 本身不提供焦点圈定/恢复，这里补齐）
// ============================================================================

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.getClientRects().length > 0);
}

/**
 * 对话框焦点管理 Hook：
 * - 打开时把焦点移入对话框（优先 [data-autofocus]，其次第一个可聚焦元素）
 * - Tab / Shift+Tab 循环圈定在对话框内
 * - 关闭时把焦点还给打开前的触发元素
 *
 * 返回的 ref 挂在对话框内容内任意稳定元素上，通过 closest('[role="dialog"]')
 * 找到实际的对话框容器（共享对话框组件 的内容层带 role="dialog"）。
 */
export function useDialogFocusManagement(open: boolean) {
  const scopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    let dialogEl: HTMLElement | null = null;

    // 等待 portal + 入场动画首帧后再解析容器与初始焦点
    const raf = requestAnimationFrame(() => {
      dialogEl =
        (scopeRef.current?.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement | null) ??
        scopeRef.current;
      if (!dialogEl) return;
      if (!dialogEl.contains(document.activeElement)) {
        const target =
          dialogEl.querySelector<HTMLElement>('[data-autofocus]') ??
          getFocusable(dialogEl)[0] ??
          dialogEl;
        target.focus?.();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialogEl) return;
      const focusables = getFocusable(dialogEl);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? dialogEl.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus?.();
      }
    };
  }, [open]);

  return scopeRef;
}

// ============================================================================
// 树键盘导航（方向键/Home/End，供本对话框的文件夹树使用）
// ============================================================================

const TREE_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

function handleTreeItemKeyNav(
  e: React.KeyboardEvent<HTMLElement>,
  opts: { hasChildren: boolean; isExpanded: boolean; onToggleExpand?: () => void },
) {
  if (!TREE_NAV_KEYS.includes(e.key)) return;
  const current = e.currentTarget as HTMLElement;
  const root = current.closest('[data-selector-tree-root]');
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>('[data-selector-tree-item]'));
  const idx = items.indexOf(current);
  if (idx === -1) return;
  e.preventDefault();
  e.stopPropagation();
  switch (e.key) {
    case 'ArrowDown':
      items[idx + 1]?.focus();
      break;
    case 'ArrowUp':
      items[idx - 1]?.focus();
      break;
    case 'Home':
      items[0]?.focus();
      break;
    case 'End':
      items[items.length - 1]?.focus();
      break;
    case 'ArrowRight':
      if (opts.hasChildren && !opts.isExpanded) opts.onToggleExpand?.();
      else items[idx + 1]?.focus();
      break;
    case 'ArrowLeft':
      if (opts.hasChildren && opts.isExpanded) {
        opts.onToggleExpand?.();
      } else {
        // 折叠态/叶子节点：跳到父级（往上找第一个层级更浅的节点）
        const myDepth = Number(current.dataset.depth ?? 0);
        for (let i = idx - 1; i >= 0; i--) {
          if (Number(items[i].dataset.depth ?? 0) < myDepth) {
            items[i].focus();
            break;
          }
        }
      }
      break;
  }
}

// ============================================================================
// 类型定义
// ============================================================================

export interface FolderSelectorDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
  /** 选择确认回调 */
  onConfirm: (folderId: string | null) => void;
  /** 文件夹树数据 */
  folderTree: FolderTreeNode[];
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 是否正在移动 */
  isMoving?: boolean;
  /** 标题 */
  title?: string;
  /** 描述 */
  description?: string;
}

// ============================================================================
// 文件夹树节点组件
// ============================================================================

interface FolderTreeItemProps {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
}

const FolderTreeItem: React.FC<FolderTreeItemProps> = React.memo(({
  node,
  depth,
  selectedId,
  onSelect,
  expandedIds,
  onToggleExpand,
}) => {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.folder.id);
  const isSelected = selectedId === node.folder.id;

  return (
    <>
      <NotionButton
        variant="ghost" size="sm"
        className={cn(
          // 📱 触屏：树行高 ≥44px（契约第 6 条），桌面不受影响
          'w-full !justify-start !px-2 !py-1.5 [@media(pointer:coarse)]:min-h-[44px]',
          isSelected
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-[var(--interactive-hover)] text-foreground',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node.folder.id)}
        data-selector-tree-item
        data-depth={depth + 1}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-level={depth + 2}
        onKeyDown={(e) => handleTreeItemKeyNav(e, {
          hasChildren: !!hasChildren,
          isExpanded,
          onToggleExpand: () => onToggleExpand(node.folder.id),
        })}
      >
        {/* 展开/折叠按钮 — 不能在 button 内嵌套 button（无效 HTML），改用 span */}
        {hasChildren ? (
          <span
            role="button"
            aria-label="toggle"
            aria-expanded={isExpanded}
            className="shrink-0 h-5 w-5 p-0.5 mr-1 inline-flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.folder.id);
            }}
          >
            {isExpanded ? (
              <CaretDown size={14} />
            ) : (
              <CaretRight size={14} />
            )}
          </span>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* 文件夹图标 */}
        {isExpanded ? (
          <FolderOpen size={16} className="mr-2 shrink-0 text-amber-500" />
        ) : (
          <Folder size={16} className="mr-2 shrink-0 text-amber-500" />
        )}

        {/* 标题 */}
        <span className="truncate">{node.folder.title}</span>
      </NotionButton>

      {/* 子节点 */}
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <FolderTreeItem
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </>
  );
});

FolderTreeItem.displayName = 'FolderSelectorTreeItem';

// ============================================================================
// 主组件
// ============================================================================

export function FolderSelectorDialog({
  open,
  onOpenChange,
  onConfirm,
  folderTree,
  isLoading = false,
  isMoving = false,
  title,
  description,
}: FolderSelectorDialogProps) {
  const { t } = useTranslation('learningHub');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // 焦点圈定 + 关闭时还焦到触发元素
  const focusScopeRef = useDialogFocusManagement(open);

  // 每次打开时重置选择，避免沿用上一次移动操作的目标文件夹
  useEffect(() => {
    if (open) {
      setSelectedId(null);
    }
  }, [open]);

  // 展开/折叠文件夹（稳定引用，配合子节点 React.memo）
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 确认选择
  const handleConfirm = () => {
    onConfirm(selectedId);
  };

  // 过滤掉内置文件夹（只保留用户创建的文件夹）
  const userFolders = useMemo(() => {
    return folderTree.filter((node) => !node.folder.isBuiltin);
  }, [folderTree]);

  return (
    <NotionDialog
      open={open}
      // 移动过程中禁止通过 Esc/遮罩/关闭按钮中途关闭，与禁用的取消按钮保持一致
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isMoving) return;
        onOpenChange(nextOpen);
      }}
      closeOnOverlay={!isMoving}
      showClose={!isMoving}
      maxWidth="max-w-[400px]"
    >
        <NotionDialogHeader>
          <NotionDialogTitle>
            {title || t('multiSelect.moveDialogTitle')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {description || t('multiSelect.moveDialogDesc')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody>

        {/* 文件夹列表 */}
        <div ref={focusScopeRef} className="min-h-[200px] max-h-[300px] border rounded-md">
          <CustomScrollArea className="h-[300px]">
            <div className="p-2" data-selector-tree-root role="tree">
              {isLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <CircleNotch size={20} className="animate-spin mr-2" />
                  <span className="text-sm">{t('loading.resources')}</span>
                </div>
              ) : userFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Folder size={32} className="mb-2 opacity-50" />
                  <span className="text-sm">{t('folder.noFolders')}</span>
                  <span className="text-xs mt-1 opacity-70">
                    {t('folder.createFirst')}
                  </span>
                </div>
              ) : (
                <>
                  {/* 根目录选项 */}
                  <NotionButton
                    variant="ghost" size="sm"
                    className={cn('w-full !justify-start !px-2 !py-1.5 mb-1 [@media(pointer:coarse)]:min-h-[44px]', selectedId === null ? 'bg-primary text-primary-foreground' : 'hover:bg-[var(--interactive-hover)] text-foreground')}
                    onClick={() => setSelectedId(null)}
                    data-selector-tree-item
                    data-depth={0}
                    data-autofocus
                    role="treeitem"
                    aria-selected={selectedId === null}
                    aria-level={1}
                    onKeyDown={(e) => handleTreeItemKeyNav(e, { hasChildren: false, isExpanded: false })}
                  >
                    <span className="w-5 shrink-0" />
                    <Folder size={16} className="mr-2 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t('folder.root')}</span>
                  </NotionButton>

                  {/* 文件夹树 */}
                  {userFolders.map((node) => (
                    <FolderTreeItem
                      key={node.folder.id}
                      node={node}
                      depth={0}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      expandedIds={expandedIds}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                </>
              )}
            </div>
          </CustomScrollArea>
        </div>

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            {t('common.cancel')}
          </NotionButton>
          <NotionButton
            onClick={handleConfirm}
            disabled={isMoving || isLoading}
          >
            {isMoving ? (
              <>
                <CircleNotch size={16} className="mr-2 animate-spin" />
                {t('multiSelect.moving')}
              </>
            ) : (
              t('multiSelect.moveConfirm')
            )}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
}
