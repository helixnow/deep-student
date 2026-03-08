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
  ChevronRight,
  Loader2,
  RefreshCw,
  GitBranch,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { getMemoryTree, type FolderTreeNode } from '@/api/memoryApi';

interface MemoryTreePreviewProps {
  onNavigateToFolder?: (folderId: string) => void;
  className?: string;
}

function countRecursive(node: FolderTreeNode): number {
  let count = node.items.filter(i => i.itemType === 'note').length;
  for (const child of node.children) {
    count += countRecursive(child);
  }
  return count;
}

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
  const visibleChildren = node.children.filter(
    c => !(c.folder.title.startsWith('__') && c.folder.title.endsWith('__'))
  );
  const hasChildren = visibleChildren.length > 0;

  return (
    <div>
      {/* Node row */}
      <div
        className={cn(
          'group flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer transition-colors',
          'hover:bg-accent/50',
          isRoot && 'font-medium',
        )}
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => {
          if (hasChildren) setExpanded(!expanded);
        }}
        onDoubleClick={() => onNavigate?.(node.folder.id)}
      >
        {/* Expand/collapse */}
        {visibleChildren.length > 0 ? (
          <ChevronRight className={cn(
            'w-3 h-3 text-muted-foreground/60 transition-transform duration-150 shrink-0',
            expanded && 'rotate-90',
          )} />
        ) : (
          <div className="w-3 shrink-0" />
        )}

        {/* Icon */}
        <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />

        {/* Title */}
        <span className="text-[12px] truncate flex-1">{node.folder.title}</span>

        {/* Stats bar */}
        <div className="flex items-center gap-1.5 shrink-0">
          {directCount > 0 && (
            <div className="flex items-center gap-0.5">
              <FileText className="w-2.5 h-2.5 text-muted-foreground/40" />
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{directCount}</span>
            </div>
          )}
          {totalCount > directCount && (
            <span className="text-[9px] text-muted-foreground/40 tabular-nums">({totalCount})</span>
          )}

          {/* Navigate button */}
          <NotionButton
            variant="ghost" size="icon" iconOnly
            className="!h-5 !w-5 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onNavigate?.(node.folder.id); }}
            title="打开文件夹"
          >
            <ChevronRight className="w-3 h-3" />
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
      setError(t('memory.tree_load_error', '加载记忆树失败'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { loadTree(); }, [loadTree]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 gap-2', className)}>
        <span className="text-sm text-muted-foreground">{error}</span>
        <NotionButton variant="ghost" size="sm" onClick={loadTree}>
          <RefreshCw className="w-3.5 h-3.5" />
          {t('common:retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  if (!treeData) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 text-muted-foreground', className)}>
        <GitBranch className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">{t('memory.tree_empty', '暂无记忆树数据')}</span>
      </div>
    );
  }

  const totalMemories = countRecursive(treeData);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
        <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('memory.tree_title', '记忆树')}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {totalMemories} {t('memory.items', '条')}
        </span>
        <div className="flex-1" />
        <NotionButton variant="ghost" size="icon" iconOnly onClick={loadTree} className="!h-5 !w-5">
          <RefreshCw className="w-3 h-3" />
        </NotionButton>
      </div>

      {/* Tree */}
      <CustomScrollArea className="flex-1">
        <div className="py-1">
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
