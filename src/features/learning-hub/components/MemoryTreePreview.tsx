/**
 * MemoryTreePreview - 记忆文件夹树状图预览
 *
 * ★ 记忆系统改造：以可视化树状图形式展示记忆文件夹结构，
 * 显示每个文件夹的记忆数量和类型分布。
 * 点击节点可导航到对应文件夹。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  Folder,
  FileText,
  CaretRight,
  CircleNotch,
  ArrowClockwise,
  GitBranch,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { getMemoryTree, type FolderTreeNode } from '@/api/memoryApi';

interface MemoryTreePreviewProps {
  onNavigateToFolder?: (folderId: string) => void;
  className?: string;
}

function isSystemFolder(node: FolderTreeNode): boolean {
  return node.folder.title.startsWith('__') && node.folder.title.endsWith('__');
}

// 与可见子树保持一致：__system__ 文件夹在树中被隐藏，其内容不计入数量
function countRecursive(node: FolderTreeNode): number {
  let count = node.items.filter(i => i.itemType === 'note').length;
  for (const child of node.children) {
    if (isSystemFolder(child)) continue;
    count += countRecursive(child);
  }
  return count;
}

/** 树行键盘导航：上下箭头/Home/End 移动焦点，左右箭头收起/展开，Enter/Space 切换 */
const PREVIEW_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

const TreeNode: React.FC<{
  node: FolderTreeNode;
  depth: number;
  isRoot?: boolean;
  onNavigate?: (folderId: string) => void;
}> = React.memo(({ node, depth, isRoot, onNavigate }) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const directCount = node.items.filter(i => i.itemType === 'note').length;
  const totalCount = countRecursive(node);
  const indent = depth * 20;

  // Filter out __system__ folders
  const visibleChildren = node.children.filter(c => !isSystemFolder(c));
  const hasChildren = visibleChildren.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (hasChildren) setExpanded(v => !v);
      else onNavigate?.(node.folder.id);
      return;
    }
    if (!PREVIEW_NAV_KEYS.includes(e.key)) return;
    const current = e.currentTarget;
    const root = current.closest('[data-memory-tree-root]');
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-memory-tree-item]'));
    const idx = rows.indexOf(current);
    if (idx === -1) return;
    e.preventDefault();
    switch (e.key) {
      case 'ArrowDown': rows[idx + 1]?.focus(); break;
      case 'ArrowUp': rows[idx - 1]?.focus(); break;
      case 'Home': rows[0]?.focus(); break;
      case 'End': rows[rows.length - 1]?.focus(); break;
      case 'ArrowRight':
        if (hasChildren && !expanded) setExpanded(true);
        else rows[idx + 1]?.focus();
        break;
      case 'ArrowLeft':
        if (hasChildren && expanded) {
          setExpanded(false);
        } else {
          const myDepth = Number(current.dataset.depth ?? 0);
          for (let i = idx - 1; i >= 0; i--) {
            if (Number(rows[i].dataset.depth ?? 0) < myDepth) { rows[i].focus(); break; }
          }
        }
        break;
    }
  };

  return (
    <div>
      {/* Node row */}
      <div
        className={cn(
          'group flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer transition-colors',
          'hover:bg-[var(--interactive-hover)]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
          isRoot && 'font-medium',
        )}
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => {
          if (hasChildren) setExpanded(!expanded);
        }}
        onDoubleClick={() => onNavigate?.(node.folder.id)}
        tabIndex={0}
        role="treeitem"
        aria-expanded={hasChildren ? expanded : undefined}
        aria-level={depth + 1}
        data-memory-tree-item
        data-depth={depth}
        onKeyDown={handleKeyDown}
      >
        {/* Expand/collapse */}
        {visibleChildren.length > 0 ? (
          <CaretRight className={cn(
            'text-muted-foreground/60 transition-transform duration-150 shrink-0',
            expanded && 'rotate-90',
          )} size={12} />
        ) : (
          <div className="w-3 shrink-0" />
        )}

        {/* Icon */}
        <Folder size={14} className="text-amber-500 shrink-0" />

        {/* Title */}
        <span className="text-[12px] truncate flex-1">{node.folder.title}</span>

        {/* Stats bar */}
        <div className="flex items-center gap-1.5 shrink-0">
          {directCount > 0 && (
            <div className="flex items-center gap-0.5">
              <FileText size={10} className="text-muted-foreground/40" />
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{directCount}</span>
            </div>
          )}
          {totalCount > directCount && (
            <span className="text-[9px] text-muted-foreground/40 tabular-nums">({totalCount})</span>
          )}

          {/* Navigate button */}
          <NotionButton
            variant="ghost" size="icon" iconOnly
            className="!h-5 !w-5 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-70 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onNavigate?.(node.folder.id); }}
            title="打开文件夹"
          >
            <CaretRight size={12} />
          </NotionButton>
        </div>
      </div>

      {/* Children */}
      {expanded && visibleChildren.length > 0 && (
        <div className="relative">
          {/* Connector line */}
          <div
            className="absolute top-0 bottom-0 border-l border-border/30"
            style={{ left: `${indent + 18}px` }}
          />
          {visibleChildren.map(child => (
            <TreeNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
});

TreeNode.displayName = 'TreeNode';

export const MemoryTreePreview: React.FC<MemoryTreePreviewProps> = React.memo(({
  onNavigateToFolder,
  className,
}) => {
  const { t } = useTranslation('learningHub');
  const [treeData, setTreeData] = useState<FolderTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getMemoryTree();
      setTreeData(data);
    } catch (e) {
      setError(t('memory.tree_load_error'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // 仅首次加载显示整屏 spinner；刷新时保留已有树内容，避免内容跳动
  if (isLoading && !treeData) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <CircleNotch size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 刷新失败但已有数据时保留原树（避免可用内容被错误页替换），仅在无数据时显示错误态
  if (error && !treeData) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 gap-2', className)}>
        <span className="text-sm text-muted-foreground">{error}</span>
        <NotionButton variant="ghost" size="sm" onClick={loadTree}>
          <ArrowClockwise size={14} />
          {t('common:retry')}
        </NotionButton>
      </div>
    );
  }

  if (!treeData) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 text-muted-foreground', className)}>
        <GitBranch size={32} className="mb-2 opacity-40" />
        <span className="text-sm">{t('memory.tree_empty')}</span>
      </div>
    );
  }

  const totalMemories = countRecursive(treeData);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
        <GitBranch size={14} className="text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('memory.tree_title')}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {totalMemories} {t('memory.items')}
        </span>
        <div className="flex-1" />
        <NotionButton variant="ghost" size="icon" iconOnly onClick={loadTree} disabled={isLoading} className="!h-5 !w-5" aria-label="refresh">
          <ArrowClockwise size={12} className={cn(isLoading && 'animate-spin')} />
        </NotionButton>
      </div>

      {/* Tree */}
      <CustomScrollArea className="flex-1">
        <div className="py-1" data-memory-tree-root role="tree">
          <TreeNode
            node={treeData}
            depth={0}
            isRoot
            onNavigate={onNavigateToFolder}
          />
        </div>
      </CustomScrollArea>
    </div>
  );
});

MemoryTreePreview.displayName = 'MemoryTreePreview';

export default MemoryTreePreview;
