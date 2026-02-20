/**
 * Chat V2 - 资源选择器弹窗
 *
 * 用于在分组编辑器中浏览文件夹、选择资源作为关联来源（pinned resources）。
 *
 * 功能：
 * 1. 文件夹树浏览
 * 2. 展示文件夹内资源列表
 * 3. 支持搜索过滤
 * 4. 多选/单选资源
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Search,
  X,
  Check,
  FileText,
  BookOpen,
  ClipboardList,
  Languages,
  PenTool,
  Image as ImageIcon,
  File,
  Brain,
  Loader2,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { folderApi } from '@/dstu/api/folderApi';
import type { VfsFolder, FolderTreeNode, VfsFolderItem } from '@/dstu/types/folder';
import { getResourceRefsV2 } from '../../context/vfsRefApi';
import type { VfsResourceRef, VfsResourceType } from '../../context/vfsRefTypes';
import { isErr } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

export interface ResourcePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** 已选中的 sourceId 列表（用于显示已选状态） */
  selectedIds: string[];
  /** 选择资源回调 */
  onSelect: (sourceId: string) => void;
  /** 取消选择回调 */
  onDeselect?: (sourceId: string) => void;
}

/** 带名称的文件夹项（解析后） */
interface ResolvedItem {
  sourceId: string;
  itemType: string;
  name: string;
  type: VfsResourceType;
}

// ============================================================================
// 图标映射
// ============================================================================

export function getResourceTypeIcon(type: string): React.ElementType {
  switch (type) {
    case 'note': return FileText;
    case 'textbook': return BookOpen;
    case 'exam': return ClipboardList;
    case 'translation': return Languages;
    case 'essay': return PenTool;
    case 'image': return ImageIcon;
    case 'mindmap': return Brain;
    case 'file':
    default:
      return File;
  }
}

export function getResourceTypeLabel(type: string): string {
  switch (type) {
    case 'note': return '笔记';
    case 'textbook': return '教材';
    case 'exam': return '题目集';
    case 'translation': return '翻译';
    case 'essay': return '作文';
    case 'image': return '图片';
    case 'mindmap': return '导图';
    case 'file': return '文件';
    default: return type;
  }
}

// ============================================================================
// 文件夹树节点
// ============================================================================

const FolderNode: React.FC<{
  node: FolderTreeNode;
  depth: number;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  onSelectFolder: (folder: VfsFolder) => void;
  onToggleExpand: (folderId: string) => void;
}> = ({ node, depth, selectedFolderId, expandedIds, onSelectFolder, onToggleExpand }) => {
  const { folder, children } = node;
  const isExpanded = expandedIds.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const hasChildren = children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors rounded-md mx-1 text-sm',
          'hover:bg-muted/80',
          isSelected && 'bg-primary/10 text-primary font-medium'
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelectFolder(folder)}
      >
        {hasChildren ? (
          <button
            className="p-0.5 rounded hover:bg-muted"
            onClick={(e) => { e.stopPropagation(); onToggleExpand(folder.id); }}
          >
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
        ) : (
          <span className="w-[22px]" />
        )}
        {isExpanded ? (
          <FolderOpen className="w-4 h-4 flex-shrink-0 text-amber-500" />
        ) : (
          <Folder className="w-4 h-4 flex-shrink-0 text-amber-500" />
        )}
        <span className="truncate">{folder.title}</span>
      </div>
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <FolderNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              expandedIds={expandedIds}
              onSelectFolder={onSelectFolder}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ResourcePickerDialog: React.FC<ResourcePickerDialogProps> = ({
  open,
  onClose,
  selectedIds,
  onSelect,
  onDeselect,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);

  // 文件夹树
  const [folderTree, setFolderTree] = useState<FolderTreeNode[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // 资源列表
  const [folderItems, setFolderItems] = useState<VfsFolderItem[]>([]);
  const [resolvedItems, setResolvedItems] = useState<ResolvedItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  // 搜索
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // 加载文件夹树
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    const result = await folderApi.getFolderTree();
    if (!isErr(result)) {
      setFolderTree(result.value);
      const firstLevelIds = new Set(result.value.map((n) => n.folder.id));
      setExpandedIds(firstLevelIds);
    }
    setTreeLoading(false);
  }, []);

  // 打开时加载
  useEffect(() => {
    if (open) {
      loadTree();
      setSearchQuery('');
      setSelectedFolderId(null);
      setFolderItems([]);
      setResolvedItems([]);
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [open, loadTree]);

  // 选择文件夹后加载其内容
  useEffect(() => {
    if (!selectedFolderId) {
      setFolderItems([]);
      setResolvedItems([]);
      return;
    }
    let cancelled = false;
    setItemsLoading(true);

    (async () => {
      const itemsResult = await folderApi.getFolderItems(selectedFolderId);
      if (cancelled) return;
      if (isErr(itemsResult)) {
        setItemsLoading(false);
        return;
      }
      const items = itemsResult.value;
      setFolderItems(items);

      // 解析资源名称
      if (items.length === 0) {
        setResolvedItems([]);
        setItemsLoading(false);
        return;
      }

      const sourceIds = items.map((i) => i.itemId);
      const refsResult = await getResourceRefsV2(sourceIds);
      if (cancelled) return;

      if (refsResult.ok) {
        const refMap = new Map<string, VfsResourceRef>();
        for (const ref of refsResult.value.refs) {
          refMap.set(ref.sourceId, ref);
        }
        const resolved: ResolvedItem[] = items.map((item) => {
          const ref = refMap.get(item.itemId);
          return {
            sourceId: item.itemId,
            itemType: item.itemType,
            name: ref?.name ?? item.itemId,
            type: (ref?.type ?? item.itemType) as VfsResourceType,
          };
        });
        setResolvedItems(resolved);
      } else {
        // fallback: use itemId as name
        setResolvedItems(
          items.map((item) => ({
            sourceId: item.itemId,
            itemType: item.itemType,
            name: item.itemId,
            type: item.itemType as VfsResourceType,
          }))
        );
      }
      setItemsLoading(false);
    })();

    return () => { cancelled = true; };
  }, [selectedFolderId]);

  // 搜索过滤
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return resolvedItems;
    const q = searchQuery.toLowerCase();
    return resolvedItems.filter(
      (item) => item.name.toLowerCase().includes(q) || item.sourceId.toLowerCase().includes(q) || item.type.toLowerCase().includes(q)
    );
  }, [resolvedItems, searchQuery]);

  const handleToggleExpand = useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const handleSelectFolder = useCallback((folder: VfsFolder) => {
    setSelectedFolderId(folder.id);
    setSearchQuery('');
  }, []);

  const selectedIdsSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50"
      style={{ zIndex: Z_INDEX.modal + 1 }}
      onClick={onClose}
    >
      <div
        className={cn(
          'w-full max-w-2xl max-h-[75vh] rounded-xl border border-transparent ring-1 ring-border/40 shadow-lg overflow-hidden',
          'bg-card flex flex-col'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <h3 className="text-base font-medium text-foreground">
            {t('page.groupPinnedBrowse')}
          </h3>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.close')}>
            <X className="w-5 h-5 text-muted-foreground" />
          </NotionButton>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* 左侧 — 文件夹树 */}
          <div className="w-[220px] border-r border-border/40 overflow-y-auto py-2 flex-shrink-0">
            {treeLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : folderTree.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('context.noFolders', '暂无文件夹')}
              </div>
            ) : (
              folderTree.map((node) => (
                <FolderNode
                  key={node.folder.id}
                  node={node}
                  depth={0}
                  selectedFolderId={selectedFolderId}
                  expandedIds={expandedIds}
                  onSelectFolder={handleSelectFolder}
                  onToggleExpand={handleToggleExpand}
                />
              ))
            )}
          </div>

          {/* 右侧 — 资源列表 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 搜索 */}
            <div className="px-3 py-2 border-b border-border/40">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('page.groupPinnedSearch')}
                  className={cn(
                    'w-full pl-8 pr-3 py-1.5 text-sm rounded-md',
                    'bg-muted/50 border border-border/40',
                    'focus:outline-none focus:ring-1 focus:ring-primary/50',
                    'placeholder:text-muted-foreground'
                  )}
                />
              </div>
            </div>

            {/* 列表 */}
            <div className="flex-1 overflow-y-auto py-1">
              {!selectedFolderId ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Folder className="w-10 h-10 text-muted-foreground/30" />
                  <span className="text-sm">{t('page.groupPinnedSearchHint')}</span>
                </div>
              ) : itemsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <span className="text-sm">
                    {searchQuery ? t('page.groupPinnedSearchEmpty') : t('page.groupPinnedResourcesEmpty')}
                  </span>
                </div>
              ) : (
                filteredItems.map((item) => {
                  const isSelected = selectedIdsSet.has(item.sourceId);
                  const Icon = getResourceTypeIcon(item.type);
                  return (
                    <div
                      key={item.sourceId}
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2 mx-1 rounded-md cursor-pointer transition-colors',
                        isSelected
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-muted/80'
                      )}
                      onClick={() => {
                        if (isSelected) {
                          onDeselect?.(item.sourceId);
                        } else {
                          onSelect(item.sourceId);
                        }
                      }}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm truncate block">{item.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground/60 flex-shrink-0">
                        {getResourceTypeLabel(item.type)}
                      </span>
                      {isSelected && (
                        <Check className="w-4 h-4 flex-shrink-0 text-primary" />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="px-4 py-2.5 border-t border-border/40 bg-muted/30 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {selectedIds.length > 0
              ? t('page.groupPinnedSelectedCount', { count: selectedIds.length, defaultValue: '已选 {{count}} 项' })
              : t('page.groupPinnedSearchHint')}
          </span>
          <NotionButton variant="ghost" onClick={onClose} className="h-7 px-3 text-sm">
            {t('common:done', '完成')}
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

export default ResourcePickerDialog;
