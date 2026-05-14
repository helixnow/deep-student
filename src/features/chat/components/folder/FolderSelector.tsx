/**
 * Chat V2 - FolderSelector 文件夹选择器弹窗
 *
 * 用于选择要注入到对话上下文的文件夹
 *
 * 功能：
 * 1. 打开时自动加载文件夹树
 * 2. 支持搜索过滤
 * 3. 支持键盘导航（上下箭头、Enter、Esc）
 * 4. 支持亮暗色模式
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md Prompt 9
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderOpen,
  CaretRight,
  CaretDown,
  MagnifyingGlass,
  X,
  FolderPlus,
} from '@phosphor-icons/react';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { Input } from '@/components/ui/shad/Input';
import { cn } from '@/utils/cn';
import { Z_INDEX } from '@/config/zIndex';
import { folderApi } from '@/dstu/api/folderApi';
import type { VfsFolder, FolderTreeNode } from '@/dstu/types/folder';
import { getErrorMessage } from '@/utils/errorUtils';
import { isErr } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

export interface FolderSelectorProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 选择文件夹回调 */
  onSelect: (folder: VfsFolder) => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 扁平化文件夹树用于键盘导航
 */
function flattenTree(
  nodes: FolderTreeNode[],
  expandedIds: Set<string>
): VfsFolder[] {
  const result: VfsFolder[] = [];
  for (const node of nodes) {
    result.push(node.folder);
    if (expandedIds.has(node.folder.id) && node.children.length > 0) {
      result.push(...flattenTree(node.children, expandedIds));
    }
  }
  return result;
}

/**
 * 过滤文件夹树
 */
function filterTree(
  nodes: FolderTreeNode[],
  query: string
): FolderTreeNode[] {
  if (!query.trim()) return nodes;

  const lowerQuery = query.toLowerCase();
  const result: FolderTreeNode[] = [];

  for (const node of nodes) {
    const matchesTitle = node.folder.title.toLowerCase().includes(lowerQuery);
    const filteredChildren = filterTree(node.children, query);

    if (matchesTitle || filteredChildren.length > 0) {
      result.push({
        ...node,
        children: filteredChildren,
      });
    }
  }

  return result;
}

// ============================================================================
// FolderTreeItem 组件
// ============================================================================

interface FolderTreeItemProps {
  node: FolderTreeNode;
  depth: number;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (folder: VfsFolder) => void;
  onToggleExpand: (folderId: string) => void;
}

const FolderTreeItem: React.FC<FolderTreeItemProps> = ({
  node,
  depth,
  selectedId,
  expandedIds,
  onSelect,
  onToggleExpand,
}) => {
  const { folder, children } = node;
  const isExpanded = expandedIds.has(folder.id);
  const isSelected = selectedId === folder.id;
  const hasChildren = children.length > 0;

  return (
    <div>
      <div
        role="option"
        aria-selected={isSelected}
        className={cn(
          'flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors rounded-md mx-1',
          !isSelected && 'hover:bg-[var(--interactive-hover)]',
          isSelected && 'bg-primary/10 text-primary'
        )}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => onSelect(folder)}
        onDoubleClick={() => {
          if (hasChildren) {
            onToggleExpand(folder.id);
          }
        }}
      >
        {/* 展开/收起按钮 */}
        {hasChildren ? (
          <NotionButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5" onClick={(e) => { e.stopPropagation(); onToggleExpand(folder.id); }} aria-label="toggle">
            {isExpanded ? <CaretDown size={16} className="text-muted-foreground" /> : <CaretRight size={16} className="text-muted-foreground" />}
          </NotionButton>
        ) : (
          <span className="w-5" />
        )}

        {/* 文件夹图标 */}
        {isExpanded ? (
          <FolderOpen
            className={cn(
              'flex-shrink-0',
              folder.color ? `text-${folder.color}-500` : 'text-amber-500'
            )}
            size={16}
          />
        ) : (
          <Folder
            className={cn(
              'flex-shrink-0',
              folder.color ? `text-${folder.color}-500` : 'text-amber-500'
            )}
            size={16}
          />
        )}

        {/* 文件夹标题 */}
        <span className="truncate text-sm">{folder.title}</span>
      </div>

      {/* 子文件夹 */}
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <FolderTreeItem
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// FolderSelector 主组件
// ============================================================================

export const FolderSelector: React.FC<FolderSelectorProps> = ({
  open,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);

  // 状态
  const [folderTree, setFolderTree] = useState<FolderTreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 过滤后的树
  const filteredTree = useMemo(
    () => filterTree(folderTree, searchQuery),
    [folderTree, searchQuery]
  );

  // 扁平化用于键盘导航
  const flatFolders = useMemo(
    () => flattenTree(filteredTree, expandedIds),
    [filteredTree, expandedIds]
  );

  // 加载文件夹树
  // 📝 文档 28 改造：getFolderTree 不再需要 subject 参数
  const loadFolderTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const treeResult = await folderApi.getFolderTree();
    if (!isErr(treeResult)) {
      setFolderTree(treeResult.value);

      // 默认展开第一层
      const firstLevelIds = new Set(treeResult.value.map((node) => node.folder.id));
      setExpandedIds(firstLevelIds);
    } else {
      console.error('[FolderSelector] Load failed:', treeResult.error.toUserMessage());
      setError(treeResult.error.toUserMessage());
    }
    setIsLoading(false);
  }, []); // 📝 文档 28 改造：移除 subject 依赖

  // 打开时加载数据
  useEffect(() => {
    if (open) {
      loadFolderTree();
      setSearchQuery('');
      setSelectedIndex(0);

      // 聚焦搜索框
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [open, loadFolderTree]);

  // 切换展开状态
  const handleToggleExpand = useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // 选择文件夹
  const handleSelect = useCallback(
    (folder: VfsFolder) => {
      onSelect(folder);
      onClose();
    },
    [onSelect, onClose]
  );

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatFolders.length === 0) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(flatFolders.length - 1, prev + 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatFolders[selectedIndex]) {
            handleSelect(flatFolders[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowRight': {
          e.preventDefault();
          const currentFolder = flatFolders[selectedIndex];
          if (currentFolder && !expandedIds.has(currentFolder.id)) {
            handleToggleExpand(currentFolder.id);
          }
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          const currentFolder = flatFolders[selectedIndex];
          if (currentFolder && expandedIds.has(currentFolder.id)) {
            handleToggleExpand(currentFolder.id);
          }
          break;
        }
      }
    },
    [flatFolders, selectedIndex, expandedIds, handleSelect, handleToggleExpand, onClose]
  );

  // 搜索变化时重置选中
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  if (!open) return null;

  const selectedFolderId = flatFolders[selectedIndex]?.id ?? null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50"
      style={{ zIndex: Z_INDEX.modal }}
      onClick={onClose}
    >
      <div
        ref={containerRef}
        className={cn(
        'w-full max-w-md max-h-[70vh] rounded-xl border border-transparent ring-1 ring-border/40 shadow-lg overflow-hidden',
          'bg-card border border-border/40',
          'flex flex-col'
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <h3 className="text-base font-medium text-foreground">
            {t('context.selectFolder', '选择文件夹')}
          </h3>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.close')}>
            <X size={20} className="text-muted-foreground" />
          </NotionButton>
        </div>

        {/* 搜索框 */}
        <div className="px-4 py-3 border-b border-border/40">
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('context.searchFolder', '搜索文件夹...')}
              className="w-full pl-9 pr-4"
            />
          </div>
        </div>

        {/* 文件夹列表 */}
        <div
          className="flex-1 overflow-y-auto py-2"
          role="listbox"
          aria-label={t('context.selectFolder', '选择文件夹')}
        >
          {isLoading ? (
            // 加载状态 - 使用 Skeleton
            <div className="flex flex-col gap-2 px-3 py-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <Skeleton className="w-5 h-5 rounded" />
                  <Skeleton className="w-4 h-4 rounded" />
                  <Skeleton className="flex-1 h-5 rounded" />
                </div>
              ))}
            </div>
          ) : error ? (
            // 错误状态
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-destructive">
              <span className="text-sm">{error}</span>
              <NotionButton variant="ghost" size="sm" onClick={loadFolderTree} className="text-primary hover:underline">
                {t('common:actions.retry', '重试')}
              </NotionButton>
            </div>
          ) : filteredTree.length === 0 ? (
            // 空状态
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <FolderPlus size={40} className="text-muted-foreground/50" />
              <span className="text-sm text-muted-foreground">
                {searchQuery
                  ? t('context.noFoldersMatch', '未找到匹配的文件夹')
                  : t('context.noFolders', '暂无文件夹，请先在学习中心创建')}
              </span>
            </div>
          ) : (
            // 文件夹树
            filteredTree.map((node) => (
              <FolderTreeItem
                key={node.folder.id}
                node={node}
                depth={0}
                selectedId={selectedFolderId}
                expandedIds={expandedIds}
                onSelect={handleSelect}
                onToggleExpand={handleToggleExpand}
              />
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-border/40 bg-muted/30">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>↑↓ {t('chatV2:context.navigate', '导航')}</span>
            <span>Enter {t('chatV2:context.confirm', '确认')}</span>
            <span>Esc {t('common:actions.close', '关闭')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FolderSelector;
